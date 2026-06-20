/**
 * sheet.js - 型D：記入式シート型エンジン
 *
 * 使い方:
 *   const engine = new SheetEngine(containerEl, config);
 *   engine.init();
 *
 * config は frameworks.json の1エントリ（type: "sheet"）を渡す。
 * layout で2形態を1エンジンが賄う:
 *   "row"   … 表形式（ラベル左｜記入欄右の2カラム。狭い画面では縦に折り返す）
 *   "stack" … カード形式（ラベル上／記入欄下の縦積み）
 *
 * ■ 型Dの本質
 *   フォーム＝項目の並び。SVG・座標計算・接続線は使わない、いちばん素直な型。
 *   配列順がそのまま表示順（自由座標は持たない）。
 *
 * ■ value（記入欄）の扱い（他エンジンとの違い）
 *   label はダブルクリックで編集する（他エンジンと同作法）が、
 *   value は“常時編集できる”記入欄。クリックしてそのまま複数行入力できる。
 *   入力のたびに input イベントで field.value へ同期する（blur待ちにしない）。
 *
 * ■ 将来拡張（今回はスコープ外。コメント言及のみ）
 *   - テキスト以外の入力欄（チェックボックス/プルダウン/日付）
 *   - セクション分け/グルーピング
 *   - 必須チェック等のバリデーション
 *   - ラベル|記入欄を超える多列グリッド
 *   - ドラッグによる並べ替え
 */
class SheetEngine {
  /**
   * @param {HTMLElement} containerEl - シートを描画するコンテナ要素
   * @param {object} config - フレームワーク定義（frameworks.json の1エントリ）
   */
  constructor(containerEl, config) {
    this.container = containerEl;
    this.config = JSON.parse(JSON.stringify(config)); // ディープコピー（編集対象）
    // リセット用に初期configをインスタンスに保持（グローバル定数に依存しない）
    this._defaultConfig = JSON.parse(JSON.stringify(config));

    this.selectedFieldId = null;

    this._deleteBtn = null; // ツールバーの削除ボタン参照
    this._listEl = null;    // 項目行のコンテナ

    // IME変換中フラグ（変換中は確定系処理を走らせない）
    this._composing = false;
  }

  /** 初期化：保存データがあれば復元、なければ config のまま描画 */
  init() {
    const saved = loadFramework(this.config.id);
    if (saved) {
      this.config = saved;
    }
    this.render();
    this._bindGlobalEvents();
  }

  // ─────────────────────────────────────────
  // 描画
  // ─────────────────────────────────────────

  /** シート全体を再描画する（構造変更時のみ呼ぶ。value入力では呼ばない） */
  render() {
    this.container.innerHTML = '';
    this.container.appendChild(this._buildToolbar());

    const sheet = document.createElement('div');
    sheet.className = 'sheet';
    sheet.dataset.layout = this.config.layout === 'stack' ? 'stack' : 'row';

    const list = document.createElement('div');
    list.className = 'sheet-list';
    this.config.fields.forEach(field => {
      list.appendChild(this._buildField(field));
    });

    sheet.appendChild(list);
    this.container.appendChild(sheet);
    this._listEl = list;

    // 選択状態の見た目を復元（render で作り直されるため）
    if (this.selectedFieldId) {
      const el = this._getFieldEl(this.selectedFieldId);
      if (el) el.classList.add('is-selected');
    }
    this._updateDeleteBtnState();
  }

  /** ツールバー（ボタン群）を生成する */
  _buildToolbar() {
    const bar = document.createElement('div');
    bar.className = 'lf-toolbar';

    const title = document.createElement('h2');
    title.className = 'lf-title';
    title.textContent = this.config.title;

    const btnSave = this._createButton('保存', 'btn-primary', () => this.save());
    const btnAdd = this._createButton('項目を追加', 'btn-secondary', () => this.addField(null));
    const btnDelete = this._createButton('削除', 'btn-danger', () => this._deleteSelected());
    const btnExport = this._createButton('JSONエクスポート', 'btn-secondary', () => this.exportJSON());
    const btnReset = this._createButton('リセット', 'btn-danger', () => this.reset());

    this._deleteBtn = btnDelete;
    this._updateDeleteBtnState();

    bar.appendChild(title);
    bar.appendChild(btnSave);
    bar.appendChild(btnAdd);
    bar.appendChild(btnDelete);
    bar.appendChild(btnExport);
    bar.appendChild(btnReset);
    return bar;
  }

  /**
   * 1項目（ラベル＋記入欄＋操作ボタン）を生成する
   * @param {object} field - { id, label, value }
   */
  _buildField(field) {
    const row = document.createElement('div');
    row.className = 'sheet-field';
    row.dataset.id = field.id;

    // ── ラベル（ダブルクリックで編集）
    const labelEl = document.createElement('div');
    labelEl.className = 'sheet-label';
    labelEl.textContent = field.label; // textContent のみ（XSS対策）
    labelEl.title = 'ダブルクリックで項目名を編集';
    labelEl.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      this.editLabel(field.id);
    });
    row.appendChild(labelEl);

    // ── 記入欄（常時編集）
    const valueEl = document.createElement('div');
    valueEl.className = 'sheet-value';
    valueEl.contentEditable = 'true';
    valueEl.dataset.placeholder = 'ここに記入';
    valueEl.textContent = field.value || ''; // textContent のみ
    this._applyEmptyState(valueEl); // 空ならプレースホルダ表示用クラスを付与

    // 入力のたびに field.value へ同期（blur待ちにしない＝消える事故を防ぐ）。
    // ここでは render() を呼ばず field.value 更新のみ（フォーカス/カーソル維持）。
    valueEl.addEventListener('input', () => {
      field.value = valueEl.textContent; // 読み取りは textContent のみ
      this._applyEmptyState(valueEl);
    });

    // IME変換中は確定系処理を走らせないためのフラグ管理
    valueEl.addEventListener('compositionstart', () => { this._composing = true; });
    valueEl.addEventListener('compositionend', () => {
      this._composing = false;
      // 変換確定時にも同期（input が先行する環境/しない環境の両対応）
      field.value = valueEl.textContent;
      this._applyEmptyState(valueEl);
    });

    // 記入欄は複数行可：Enter は改行として通す（確定/blur はしない）。
    // クリック/フォーカスでこの項目を選択する。
    valueEl.addEventListener('focus', () => this._selectField(field.id));
    row.appendChild(valueEl);

    // ── 操作ボタン（ホバー/選択時に表示）
    const controls = document.createElement('div');
    controls.className = 'sheet-controls';
    controls.appendChild(this._miniBtn('◀', '前へ移動', (e) => { e.stopPropagation(); this.moveField(field.id, -1); }));
    controls.appendChild(this._miniBtn('＋', 'この項目の直後に追加', (e) => { e.stopPropagation(); this.addField(field.id); }));
    controls.appendChild(this._miniBtn('▶', '次へ移動', (e) => { e.stopPropagation(); this.moveField(field.id, +1); }));
    controls.appendChild(this._miniBtn('✕', 'この項目を削除', (e) => { e.stopPropagation(); this.deleteField(field.id); }));
    row.appendChild(controls);

    // 行クリックで選択（記入欄/ボタンのクリックは各自で処理）
    row.addEventListener('click', (e) => {
      if (e.target.closest('.sheet-controls')) return;
      this._selectField(field.id);
    });

    return row;
  }

  /** 記入欄が空かどうかで is-empty クラスを付け外しする（プレースホルダ表示用） */
  _applyEmptyState(valueEl) {
    // contenteditable は <br> や空divが残り :empty が外れるため、
    // textContent.trim() で実体が空かを判定してクラス制御する
    if (valueEl.textContent.trim() === '') {
      valueEl.classList.add('is-empty');
    } else {
      valueEl.classList.remove('is-empty');
    }
  }

  // ─────────────────────────────────────────
  // ラベル編集
  // ─────────────────────────────────────────

  /**
   * ラベルをインライン編集する（他エンジンと同じ作法：Enter確定・blur終了）
   * @param {string} fieldId
   */
  editLabel(fieldId) {
    const field = this._getField(fieldId);
    const row = this._getFieldEl(fieldId);
    if (!field || !row) return;
    const labelEl = row.querySelector('.sheet-label');

    labelEl.contentEditable = 'true';
    row.classList.add('is-editing-label');
    labelEl.focus();

    const range = document.createRange();
    range.selectNodeContents(labelEl);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    const finish = () => {
      labelEl.contentEditable = 'false';
      row.classList.remove('is-editing-label');
      field.label = labelEl.textContent.trim() || '（項目名）';
      labelEl.textContent = field.label;
    };

    labelEl.addEventListener('blur', finish, { once: true });
    labelEl.addEventListener('keydown', (e) => {
      // ラベルは1行。Enter で確定（IME変換中は無視）
      if (e.key === 'Enter' && !this._composing) {
        e.preventDefault();
        labelEl.blur();
      }
    });
  }

  // ─────────────────────────────────────────
  // 項目操作
  // ─────────────────────────────────────────

  /**
   * 項目を追加する。afterId があればその直後、なければ末尾に追加。
   * 追加直後にラベル編集へ入る。
   * @param {string|null} afterId
   */
  addField(afterId) {
    const field = { id: this._genId(), label: '新しい項目', value: '' };
    if (afterId) {
      const idx = this._indexOf(afterId);
      this.config.fields.splice(idx + 1, 0, field);
    } else {
      this.config.fields.push(field);
    }
    this.render(); // 構造変更なので再描画
    this.editLabel(field.id);
  }

  /**
   * 項目を削除する（確認付き）
   * @param {string} fieldId
   */
  deleteField(fieldId) {
    const idx = this._indexOf(fieldId);
    if (idx < 0) return;
    const field = this.config.fields[idx];
    if (!confirm(`項目「${field.label}」を削除します。よろしいですか？`)) return;
    this.config.fields.splice(idx, 1);
    this.selectedFieldId = null;
    this._updateDeleteBtnState();
    this.render();
  }

  /**
   * 項目を前後へ並べ替える（配列の順序変更。端では止める）
   * @param {string} fieldId
   * @param {number} dir - -1（前へ）/ +1（後へ）
   */
  moveField(fieldId, dir) {
    const idx = this._indexOf(fieldId);
    if (idx < 0) return;
    const j = idx + dir;
    if (j < 0 || j >= this.config.fields.length) return; // 端ではそれ以上動かさない
    const fields = this.config.fields;
    [fields[idx], fields[j]] = [fields[j], fields[idx]];
    this.render(); // selectedFieldId は維持され、render で選択枠も復元される
  }

  /** ツールバーの削除ボタンから呼ばれる（選択項目を削除） */
  _deleteSelected() {
    if (!this.selectedFieldId) {
      this._showToast('削除する項目を選択してください');
      return;
    }
    this.deleteField(this.selectedFieldId);
  }

  // ─────────────────────────────────────────
  // 選択
  // ─────────────────────────────────────────

  _selectField(id) {
    if (this.selectedFieldId === id) return;
    if (this.selectedFieldId) {
      const prev = this._getFieldEl(this.selectedFieldId);
      if (prev) prev.classList.remove('is-selected');
    }
    this.selectedFieldId = id;
    const el = this._getFieldEl(id);
    if (el) el.classList.add('is-selected');
    this._updateDeleteBtnState();
  }

  _deselectField() {
    if (!this.selectedFieldId) return;
    const el = this._getFieldEl(this.selectedFieldId);
    if (el) el.classList.remove('is-selected');
    this.selectedFieldId = null;
    this._updateDeleteBtnState();
  }

  _updateDeleteBtnState() {
    if (this._deleteBtn) {
      this._deleteBtn.disabled = !this.selectedFieldId;
    }
  }

  // ─────────────────────────────────────────
  // グローバルイベント（init で1回だけ登録）
  // ─────────────────────────────────────────

  _bindGlobalEvents() {
    document.addEventListener('keydown', (e) => {
      // 削除トリガーは Delete キーのみ（Backspace は誤削除防止のため除外）
      if (e.key === 'Delete' && this.selectedFieldId) {
        // 編集中（記入欄・ラベル・input）は削除しない
        const active = document.activeElement;
        if (active && (active.contentEditable === 'true' || active.tagName === 'INPUT')) return;
        this.deleteField(this.selectedFieldId);
      }
      if (e.key === 'Escape') {
        this._deselectField();
      }
    });

    // シート外クリックで選択解除
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.sheet-field')) {
        this._deselectField();
      }
    });
  }

  // ─────────────────────────────────────────
  // 保存・読み込み・リセット・エクスポート
  // ─────────────────────────────────────────

  save() {
    saveFramework(this.config.id, this.config);
    this._showToast('保存しました');
  }

  load() {
    const saved = loadFramework(this.config.id);
    if (saved) {
      this.config = saved;
      this.render();
    }
  }

  reset() {
    if (!confirm('リセットすると保存内容が消えます。よろしいですか？')) return;
    clearFramework(this.config.id);
    this.config = JSON.parse(JSON.stringify(this._defaultConfig));
    this.selectedFieldId = null;
    this.render();
  }

  exportJSON() {
    exportAsJSON(this.config.id, this.config);
  }

  // ─────────────────────────────────────────
  // ユーティリティ
  // ─────────────────────────────────────────

  _getFieldEl(id) {
    return this._listEl
      ? this._listEl.querySelector('.sheet-field[data-id="' + id + '"]')
      : null;
  }

  _getField(id) {
    return this.config.fields.find(f => f.id === id) || null;
  }

  _indexOf(id) {
    return this.config.fields.findIndex(f => f.id === id);
  }

  _genId() {
    return 'f_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
  }

  _createButton(label, className, onClick) {
    const btn = document.createElement('button');
    btn.className = 'btn ' + className;
    btn.textContent = label;
    btn.addEventListener('click', onClick);
    return btn;
  }

  _miniBtn(label, title, onClick) {
    const btn = document.createElement('button');
    btn.className = 'sheet-mini-btn';
    btn.textContent = label;
    btn.title = title;
    btn.addEventListener('click', onClick);
    return btn;
  }

  _showToast(message) {
    const existing = document.querySelector('.lf-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'lf-toast'; // トーストのスタイルは全エンジン共通
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => toast.classList.add('is-visible'), 10);
    setTimeout(() => {
      toast.classList.remove('is-visible');
      setTimeout(() => toast.remove(), 300);
    }, 2000);
  }
}
