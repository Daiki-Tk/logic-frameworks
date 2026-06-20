/**
 * matrix.js - 型A：マトリクス型エンジン
 *
 * 使い方:
 *   const engine = new MatrixEngine(containerEl, config);
 *   engine.init();
 *
 * config は frameworks.json の1エントリ（type: "matrix"）を渡す。
 * 将来的に2×2以外のマトリクス（3×3など）へ拡張する場合は
 * config.grid に { rows: 3, cols: 3 } 等を追加することで対応可能。
 */
class MatrixEngine {
  /**
   * @param {HTMLElement} containerEl - マトリクスを描画するコンテナ要素
   * @param {object} config - フレームワーク定義（frameworks.json の1エントリ）
   */
  constructor(containerEl, config) {
    this.container = containerEl;
    this.config = JSON.parse(JSON.stringify(config)); // ディープコピー（編集対象）
    // リセット用に初期configをインスタンスに保持しておく。
    // これによりグローバル定数に依存せず、複数マトリクス配置時も
    // それぞれ正しい初期値へ戻せる（frameworks.json流し込み対応）。
    this._defaultConfig = JSON.parse(JSON.stringify(config));
    this.selectedItemId = null; // 現在選択中の付箋ID
    this.dragState = null;      // ドラッグ中の状態 { id, pointerId, layerRect, offsetX, offsetY }

    // ツールバーの「削除」ボタン参照（選択状態に応じて活性/非活性を切り替える）
    this._deleteBtn = null;
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

  /** マトリクス全体を再描画する */
  render() {
    this.container.innerHTML = '';
    this.container.appendChild(this._buildToolbar());
    this.container.appendChild(this._buildMatrixArea());
  }

  /** ツールバー（ボタン群）を生成する */
  _buildToolbar() {
    const bar = document.createElement('div');
    bar.className = 'lf-toolbar';

    const title = document.createElement('h2');
    title.className = 'lf-title';
    title.textContent = this.config.title;

    const btnSave = this._createButton('保存', 'btn-primary', () => this.save());
    const btnDelete = this._createButton('削除', 'btn-danger', () => this._deleteSelected());
    const btnExport = this._createButton('JSONエクスポート', 'btn-secondary', () => this.exportJSON());
    const btnReset = this._createButton('リセット', 'btn-danger', () => this.reset());

    // 削除ボタンは付箋が選択されているときのみ有効。
    // render() で作り直されるため、参照を保持して状態を反映し直す。
    this._deleteBtn = btnDelete;
    this._updateDeleteBtnState();

    bar.appendChild(title);
    bar.appendChild(btnSave);
    bar.appendChild(btnDelete);
    bar.appendChild(btnExport);
    bar.appendChild(btnReset);
    return bar;
  }

  /** 選択中の付箋を削除する（ツールバーの削除ボタンから呼ばれる） */
  _deleteSelected() {
    if (!this.selectedItemId) {
      this._showToast('削除する付箋を選択してください');
      return;
    }
    this.deleteItem(this.selectedItemId);
  }

  /** 削除ボタンの活性/非活性を選択状態に合わせて更新する */
  _updateDeleteBtnState() {
    if (this._deleteBtn) {
      this._deleteBtn.disabled = !this.selectedItemId;
    }
  }

  /** マトリクス本体（軸ラベル＋4象限）を生成する */
  _buildMatrixArea() {
    const wrapper = document.createElement('div');
    wrapper.className = 'matrix-wrapper';

    // 上軸ラベル
    const topLabel = this._buildAxisLabel('top', this.config.axes.y.top);
    // 下軸ラベル
    const bottomLabel = this._buildAxisLabel('bottom', this.config.axes.y.bottom);
    // 左軸ラベル
    const leftLabel = this._buildAxisLabel('left', this.config.axes.x.left);
    // 右軸ラベル
    const rightLabel = this._buildAxisLabel('right', this.config.axes.x.right);

    // マトリクス本体（4象限 + 付箋レイヤー）
    const matrix = document.createElement('div');
    matrix.className = 'matrix-grid';

    // 4象限の背景セルを生成
    const quadrantKeys = ['topLeft', 'topRight', 'bottomLeft', 'bottomRight'];
    quadrantKeys.forEach(key => {
      const cell = document.createElement('div');
      cell.className = 'matrix-quadrant matrix-quadrant--' + key;
      cell.dataset.quadrant = key;

      const label = document.createElement('span');
      label.className = 'quadrant-label';
      label.textContent = this.config.quadrants[key] || '';
      cell.appendChild(label);

      matrix.appendChild(cell);
    });

    // 付箋レイヤー（絶対配置で4象限の上に重ねる）
    const itemLayer = document.createElement('div');
    itemLayer.className = 'matrix-item-layer';

    // マトリクスのクリックで付箋追加
    itemLayer.addEventListener('click', (e) => {
      // 付箋自身のクリックは無視（付箋のイベントが先に処理される）
      if (e.target.closest('.matrix-item')) return;
      const rect = itemLayer.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;
      this.addItem(x, y);
    });

    // 既存の付箋を描画
    this.config.items.forEach(item => {
      itemLayer.appendChild(this._buildItemEl(item));
    });

    matrix.appendChild(itemLayer);

    // 軸の矢印（中央十字線）
    const axisH = document.createElement('div');
    axisH.className = 'matrix-axis matrix-axis--h';
    const axisV = document.createElement('div');
    axisV.className = 'matrix-axis matrix-axis--v';
    matrix.appendChild(axisH);
    matrix.appendChild(axisV);

    wrapper.appendChild(topLabel);
    wrapper.appendChild(leftLabel);
    wrapper.appendChild(matrix);
    wrapper.appendChild(rightLabel);
    wrapper.appendChild(bottomLabel);

    // ※ ドラッグ中の move/up はポインタキャプチャで付箋自身が受け取るため、
    //    ここで document へリスナーを登録しない（render毎の重複登録を回避）。

    this._matrixEl = matrix;
    this._itemLayerEl = itemLayer;

    return wrapper;
  }

  /** 軸ラベル要素を生成する（クリックで編集可能） */
  _buildAxisLabel(pos, text) {
    const el = document.createElement('div');
    el.className = 'matrix-axis-label matrix-axis-label--' + pos;
    el.textContent = text;
    el.title = 'クリックして編集';

    el.addEventListener('click', () => this.editAxisLabel(pos, el));
    return el;
  }

  /** 付箋要素を生成する */
  _buildItemEl(item) {
    const el = document.createElement('div');
    el.className = 'matrix-item';
    el.dataset.id = item.id;
    el.style.left = (item.x * 100) + '%';
    el.style.top = (item.y * 100) + '%';

    const text = document.createElement('span');
    text.className = 'matrix-item-text';
    text.textContent = item.text;
    el.appendChild(text);

    // クリックで選択
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      this._selectItem(item.id);
    });

    // ダブルクリックで編集
    el.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      this.editItem(item.id);
    });

    // ポインタダウンでドラッグ開始（マウス・タッチ・ペン共通）
    el.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this._onDragStart(e, item.id);
    });
    // ドラッグ中の移動・終了はキャプチャした付箋自身が受け取る
    el.addEventListener('pointermove', (e) => this._onDragMove(e));
    el.addEventListener('pointerup', (e) => this._onDragEnd(e));
    el.addEventListener('pointercancel', (e) => this._onDragEnd(e));

    return el;
  }

  // ─────────────────────────────────────────
  // 付箋操作
  // ─────────────────────────────────────────

  /**
   * 指定座標に新しい付箋を追加する
   * @param {number} x - 0〜1 の相対X座標
   * @param {number} y - 0〜1 の相対Y座標
   */
  addItem(x, y) {
    const id = 'item_' + Date.now();
    const newItem = { id, text: '新しい項目', x, y };
    this.config.items.push(newItem);

    const el = this._buildItemEl(newItem);
    this._itemLayerEl.appendChild(el);

    // 追加直後に編集モードへ
    this.editItem(id);
  }

  /**
   * 付箋をインライン編集モードにする
   * @param {string} id - 付箋ID
   */
  editItem(id) {
    const el = this._getItemEl(id);
    if (!el) return;

    const textEl = el.querySelector('.matrix-item-text');
    const item = this._getItemData(id);

    // contenteditable で編集
    textEl.contentEditable = 'true';
    textEl.focus();

    // テキストを全選択
    const range = document.createRange();
    range.selectNodeContents(textEl);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);

    el.classList.add('is-editing');

    const finish = () => {
      textEl.contentEditable = 'false';
      el.classList.remove('is-editing');
      item.text = textEl.textContent.trim() || '（空）';
      textEl.textContent = item.text;
    };

    textEl.addEventListener('blur', finish, { once: true });
    textEl.addEventListener('keydown', (e) => {
      // Enter で確定（Shift+Enter は改行を許可しない）
      if (e.key === 'Enter') {
        e.preventDefault();
        textEl.blur();
      }
    });
  }

  /**
   * 付箋の座標を更新する（ドラッグ終了時に呼ばれる）
   * @param {string} id - 付箋ID
   * @param {number} x - 0〜1 の相対X座標
   * @param {number} y - 0〜1 の相対Y座標
   */
  moveItem(id, x, y) {
    const item = this._getItemData(id);
    if (!item) return;

    // 0〜1 の範囲にクランプ
    item.x = Math.max(0, Math.min(1, x));
    item.y = Math.max(0, Math.min(1, y));

    const el = this._getItemEl(id);
    if (el) {
      el.style.left = (item.x * 100) + '%';
      el.style.top = (item.y * 100) + '%';
    }
  }

  /**
   * 付箋を削除する
   * @param {string} id - 付箋ID
   */
  deleteItem(id) {
    this.config.items = this.config.items.filter(i => i.id !== id);
    const el = this._getItemEl(id);
    if (el) el.remove();
    this.selectedItemId = null;
    this._updateDeleteBtnState();
  }

  /** 付箋を選択状態にする */
  _selectItem(id) {
    // 前の選択を解除
    if (this.selectedItemId) {
      const prev = this._getItemEl(this.selectedItemId);
      if (prev) prev.classList.remove('is-selected');
    }
    this.selectedItemId = id;
    const el = this._getItemEl(id);
    if (el) el.classList.add('is-selected');
    this._updateDeleteBtnState();
  }

  /** 付箋の選択を解除する */
  _deselectItem() {
    if (!this.selectedItemId) return;
    const el = this._getItemEl(this.selectedItemId);
    if (el) el.classList.remove('is-selected');
    this.selectedItemId = null;
    this._updateDeleteBtnState();
  }

  // ─────────────────────────────────────────
  // 軸ラベル編集
  // ─────────────────────────────────────────

  /**
   * 軸ラベルをインライン編集モードにする
   * @param {string} pos - "top" | "bottom" | "left" | "right"
   * @param {HTMLElement} el - 軸ラベル要素
   */
  editAxisLabel(pos, el) {
    if (el.contentEditable === 'true') return;

    el.contentEditable = 'true';
    el.classList.add('is-editing');
    el.focus();

    const range = document.createRange();
    range.selectNodeContents(el);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);

    const finish = () => {
      el.contentEditable = 'false';
      el.classList.remove('is-editing');
      const text = el.textContent.trim() || '（未設定）';
      el.textContent = text;

      // config に反映
      if (pos === 'top')    this.config.axes.y.top    = text;
      if (pos === 'bottom') this.config.axes.y.bottom = text;
      if (pos === 'left')   this.config.axes.x.left   = text;
      if (pos === 'right')  this.config.axes.x.right  = text;
    };

    el.addEventListener('blur', finish, { once: true });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        el.blur();
      }
    });
  }

  // ─────────────────────────────────────────
  // ドラッグ処理
  // ─────────────────────────────────────────

  _onDragStart(e, id) {
    e.preventDefault();
    this._selectItem(id);

    const el = this._getItemEl(id);
    el.classList.add('is-dragging');

    // ポインタをこの付箋にキャプチャし、指やカーソルが要素外へ出ても
    // move/up を付箋自身が受け取れるようにする（document登録が不要になる）。
    el.setPointerCapture(e.pointerId);

    const rect = this._itemLayerEl.getBoundingClientRect();
    this.dragState = {
      id,
      pointerId: e.pointerId,
      layerRect: rect,
      offsetX: e.clientX - el.getBoundingClientRect().left,
      offsetY: e.clientY - el.getBoundingClientRect().top,
    };
  }

  _onDragMove(e) {
    if (!this.dragState || e.pointerId !== this.dragState.pointerId) return;
    const { id, layerRect, offsetX, offsetY } = this.dragState;
    const el = this._getItemEl(id);
    if (!el) return;

    // 付箋の中心ではなく左上基準で計算し、中心を目標位置にする
    const elW = el.offsetWidth;
    const elH = el.offsetHeight;
    const rawX = (e.clientX - layerRect.left - offsetX + elW / 2) / layerRect.width;
    const rawY = (e.clientY - layerRect.top  - offsetY + elH / 2) / layerRect.height;

    this.moveItem(id, rawX, rawY);
  }

  _onDragEnd(e) {
    if (!this.dragState || e.pointerId !== this.dragState.pointerId) return;
    const el = this._getItemEl(this.dragState.id);
    if (el) {
      el.classList.remove('is-dragging');
      // キャプチャを解放（capture済みでない場合の例外は無視）
      try { el.releasePointerCapture(e.pointerId); } catch (_) {}
    }
    this.dragState = null;
  }

  // ─────────────────────────────────────────
  // グローバルイベント（Deleteキーで削除など）
  // ─────────────────────────────────────────

  _bindGlobalEvents() {
    // 削除トリガーは Delete キーのみに限定する。
    // Backspace は文字入力の感覚で押されやすく誤削除を招くため対象外。
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Delete' && this.selectedItemId) {
        // テキスト編集中は削除しない
        const active = document.activeElement;
        if (active && (active.contentEditable === 'true' || active.tagName === 'INPUT')) return;
        this.deleteItem(this.selectedItemId);
      }
      // Escape で選択解除
      if (e.key === 'Escape') {
        this._deselectItem();
      }
    });

    // マトリクス外クリックで選択解除
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.matrix-item')) {
        this._deselectItem();
      }
    });
  }

  // ─────────────────────────────────────────
  // 保存・読み込み・リセット・エクスポート
  // ─────────────────────────────────────────

  /** 現在の状態を localStorage に保存する */
  save() {
    saveFramework(this.config.id, this.config);
    this._showToast('保存しました');
  }

  /** ページリロード時の状態を localStorage から復元する */
  load() {
    const saved = loadFramework(this.config.id);
    if (saved) {
      this.config = saved;
      this.render();
    }
  }

  /** 初期状態にリセットする */
  reset() {
    if (!confirm('リセットすると保存内容が消えます。よろしいですか？')) return;
    clearFramework(this.config.id);
    // グローバル定数ではなく、インスタンス保持の初期configへ戻す。
    // これにより複数マトリクス配置時も各自の初期値へ正しく戻せる。
    this.config = JSON.parse(JSON.stringify(this._defaultConfig));
    this.selectedItemId = null;
    this.render();
  }

  /** 現在の状態を JSON ファイルとしてダウンロードする */
  exportJSON() {
    exportAsJSON(this.config.id, this.config);
  }

  // ─────────────────────────────────────────
  // ユーティリティ
  // ─────────────────────────────────────────

  _getItemEl(id) {
    return this._itemLayerEl
      ? this._itemLayerEl.querySelector('[data-id="' + id + '"]')
      : null;
  }

  _getItemData(id) {
    return this.config.items.find(i => i.id === id) || null;
  }

  _createButton(label, className, onClick) {
    const btn = document.createElement('button');
    btn.className = 'btn ' + className;
    btn.textContent = label;
    btn.addEventListener('click', onClick);
    return btn;
  }

  /** 一時的なトースト通知を表示する */
  _showToast(message) {
    const existing = document.querySelector('.lf-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'lf-toast';
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => toast.classList.add('is-visible'), 10);
    setTimeout(() => {
      toast.classList.remove('is-visible');
      setTimeout(() => toast.remove(), 300);
    }, 2000);
  }
}
