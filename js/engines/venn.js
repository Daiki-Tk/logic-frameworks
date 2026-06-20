/**
 * venn.js - 型E：円/集合図型エンジン
 *
 * 使い方:
 *   const engine = new VennEngine(containerEl, config);
 *   engine.init();
 *
 * config は frameworks.json の1エントリ（type: "venn"）を渡す。
 *
 * ■ 設計の要
 *   型Eは「型A(matrix)のアイテム配置モデルを、背景を2×2グリッド→重なり円に
 *   差し替えたもの」。アイテムの 0〜1 相対座標・ポインタドラッグ・クリック追加・
 *   ダブルクリック編集・選択削除のロジックは matrix と完全に揃える。
 *   変わるのは背景の見た目だけ（2×2象限 → 重なり合う円）。
 *
 *   どの領域（A / B / 重なり）かは位置から見て取れるもので、構造としては保持しない
 *   （matrix が象限を座標から読むのと同じ思想）。
 *
 * ■ 将来拡張（今回はスコープ外。コメント言及のみ）
 *   - 4集合以上、面積比例ベン図、楕円ベン図
 *   - 名前付き領域への自動スナップ／領域ごとの自動整列
 *   - 領域ごとの個別色指定
 */
class VennEngine {
  /**
   * @param {HTMLElement} containerEl - ベン図を描画するコンテナ要素
   * @param {object} config - フレームワーク定義（frameworks.json の1エントリ）
   */
  constructor(containerEl, config) {
    this.container = containerEl;
    this.config = JSON.parse(JSON.stringify(config)); // ディープコピー（編集対象）
    // リセット用に初期configをインスタンスに保持（グローバル定数に依存しない）
    this._defaultConfig = JSON.parse(JSON.stringify(config));

    this.selectedItemId = null;
    this.dragState = null; // { id, pointerId, layerRect, offsetX, offsetY }

    this._deleteBtn = null;
    this._boardEl = null;     // 正方形の盤面
    this._svgEl = null;       // 円レイヤー（アイテムの背面）
    this._itemLayerEl = null; // アイテムレイヤー（クリック/ドラッグを受ける）

    // 円の再レイアウト用の固定参照（init で1回だけ登録）
    this._boundRelayout = () => this._scheduleRelayout();
    this._relayoutScheduled = false;
  }

  /** 初期化：保存データがあれば復元、なければ config のまま描画 */
  init() {
    const saved = loadFramework(this.config.id);
    if (saved) {
      this.config = saved;
    }
    this.render();
    this._bindGlobalEvents();

    // フォント確定でラベル寸法が変わっても円配置は盤面サイズ依存なので
    // 影響は小さいが、規律統一のため再レイアウトしておく。
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => this._layoutCircles());
    }
  }

  // ─────────────────────────────────────────
  // 描画
  // ─────────────────────────────────────────

  /** ベン図全体を再描画する */
  render() {
    this.container.innerHTML = '';
    this.container.appendChild(this._buildToolbar());

    const wrapper = document.createElement('div');
    wrapper.className = 'venn-wrapper';

    // 正方形の盤面（サイズは _layoutCircles でJS算出）
    const board = document.createElement('div');
    board.className = 'venn-board';

    // 円レイヤー（背面・操作を奪わない）
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'venn-circles');

    // アイテムレイヤー（クリックで追加・ドラッグで移動を受ける）
    const itemLayer = document.createElement('div');
    itemLayer.className = 'venn-item-layer';
    itemLayer.addEventListener('click', (e) => {
      // アイテム自身のクリックは無視（addItem誤発火を防ぐ）
      if (e.target.closest('.venn-item')) return;
      const rect = itemLayer.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;
      this.addItem(x, y);
    });
    this.config.items.forEach(item => {
      itemLayer.appendChild(this._buildItemEl(item));
    });

    board.appendChild(svg);
    board.appendChild(itemLayer);

    // 集合ラベル（円・アイテムと被らない外側の定位置に固定）。
    // アイテムレイヤーの外（兄弟）かつ前面に置き、クリックはラベルで止める
    // → addItem のクリック判定がラベル上で誤発火しない。
    const posClasses = this._labelPositions(this.config.sets.length);
    this.config.sets.forEach((set, i) => {
      board.appendChild(this._buildSetLabel(set, posClasses[i] || 'venn-set-label--tl', i));
    });

    wrapper.appendChild(board);
    this.container.appendChild(wrapper);

    this._boardEl = board;
    this._svgEl = svg;
    this._itemLayerEl = itemLayer;

    // 選択状態の見た目を復元
    if (this.selectedItemId) {
      const el = this._getItemEl(this.selectedItemId);
      if (el) el.classList.add('is-selected');
    }
    this._updateDeleteBtnState();

    // レイアウト確定後に円を配置
    requestAnimationFrame(() => this._layoutCircles());
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

    this._deleteBtn = btnDelete;
    this._updateDeleteBtnState();

    bar.appendChild(title);
    bar.appendChild(btnSave);
    bar.appendChild(btnDelete);
    bar.appendChild(btnExport);
    bar.appendChild(btnReset);
    return bar;
  }

  /** アイテム（付箋）要素を生成する（matrix のロジックを流用） */
  _buildItemEl(item) {
    const el = document.createElement('div');
    el.className = 'venn-item';
    el.dataset.id = item.id;
    el.style.left = (item.x * 100) + '%';
    el.style.top = (item.y * 100) + '%';

    const text = document.createElement('span');
    text.className = 'venn-item-text';
    text.textContent = item.text; // textContent のみ（XSS対策）
    el.appendChild(text);

    // 各アイテムの「✕」削除ボタン
    const del = document.createElement('button');
    del.className = 'venn-item-del';
    del.textContent = '✕';
    del.title = 'このアイテムを削除';
    // ドラッグ開始（pointerdown）を奪わないよう伝播停止
    del.addEventListener('pointerdown', (e) => e.stopPropagation());
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      this.deleteItem(item.id);
    });
    el.appendChild(del);

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
    // ポインタドラッグ（matrix と同じ：capture でレイヤー外でも追従）
    el.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this._onDragStart(e, item.id);
    });
    el.addEventListener('pointermove', (e) => this._onDragMove(e));
    el.addEventListener('pointerup', (e) => this._onDragEnd(e));
    el.addEventListener('pointercancel', (e) => this._onDragEnd(e));

    return el;
  }

  /** 集合ラベル要素を生成する（クリックで編集） */
  _buildSetLabel(set, posClass, colorIdx) {
    const el = document.createElement('div');
    el.className = 'venn-set-label ' + posClass;
    el.dataset.setId = set.id;
    el.textContent = set.label; // textContent のみ
    el.title = 'クリックして編集';

    // 集合色に合わせて文字色・枠線色を変える
    const col = this._setColor(colorIdx);
    el.style.color = col.stroke;
    el.style.borderColor = col.stroke;

    el.addEventListener('click', (e) => {
      e.stopPropagation();
      this.editSetLabel(set.id, el);
    });
    return el;
  }

  // ─────────────────────────────────────────
  // 円の配置（唯一の新規部分）
  // ─────────────────────────────────────────

  /** resize をまとめて1フレームに集約 */
  _scheduleRelayout() {
    if (this._relayoutScheduled) return;
    this._relayoutScheduled = true;
    requestAnimationFrame(() => {
      this._relayoutScheduled = false;
      this._layoutCircles();
    });
  }

  /**
   * 盤面サイズから円を算出してSVGへ描画する。
   * 座標系は cycle の教訓を踏襲：SVGのviewBoxとピクセルサイズを一致させ、
   * アイテムレイヤーと同一原点・同一サイズの正方形に収める（横スクロールを出さない）。
   */
  _layoutCircles() {
    const wrapper = this._boardEl && this._boardEl.parentElement;
    const board = this._boardEl;
    const svg = this._svgEl;
    if (!wrapper || !board || !svg) return;

    const sets = this.config.sets;
    const N = sets.length;

    // 正方形の一辺（コンテナ幅から算出。横スクロールが出ないよう内側に収める）
    const avail = wrapper.clientWidth || 480;
    const S = Math.max(320, Math.min(avail - 8, 560));
    board.style.width = S + 'px';
    board.style.height = S + 'px';

    // SVGサイズとviewBoxを一致させる
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    svg.setAttribute('width', S);
    svg.setAttribute('height', S);
    svg.setAttribute('viewBox', `0 0 ${S} ${S}`);

    const cx = S / 2;
    const cy = S / 2;
    const margin = 28; // 円が盤面からはみ出さない余白

    let circles = [];
    if (N <= 2) {
      // 2集合：左右に並べ、中心間距離 ≈ 半径×1.1 で適度に重ねる
      // 横方向の総幅 = d + 2R = 3.1R が (S - 2*margin) に収まるよう半径を決める
      const R = (S - 2 * margin) / 3.1;
      const d = R * 1.1;
      if (N === 1) {
        circles = [{ cx, cy, r: R }];
      } else {
        circles = [
          { cx: cx - d / 2, cy, r: R },
          { cx: cx + d / 2, cy, r: R },
        ];
      }
    } else {
      // 3集合：正三角形配置（中心を120°間隔、中央で3円が重なる）
      // 中心は盤面中心から距離 dd の円周上。各円の最遠点 dd+R が収まるよう半径を決める。
      // 4集合以上は未対応（スコープ外）。3つだけ描く。
      const R = (S / 2 - margin) / 1.577; // 1.577 = 1 + 1/√3
      const dd = R / Math.sqrt(3);
      const angles = [-90, 30, 150]; // 上 / 右下 / 左下
      circles = angles.map(a => {
        const rad = a * Math.PI / 180;
        return { cx: cx + dd * Math.cos(rad), cy: cy + dd * Math.sin(rad), r: R };
      });
    }

    // 円を描画（単純な半透明重ね塗り。mix-blend-modeには頼らない）
    const NS = 'http://www.w3.org/2000/svg';
    circles.forEach((c, i) => {
      const col = this._setColor(i);
      const el = document.createElementNS(NS, 'circle');
      el.setAttribute('cx', c.cx);
      el.setAttribute('cy', c.cy);
      el.setAttribute('r', c.r);
      el.setAttribute('fill', col.fill);
      el.setAttribute('fill-opacity', '0.2'); // 重なりは塗りの重なりで自然に濃くなる
      el.setAttribute('stroke', col.stroke);
      el.setAttribute('stroke-width', '2');
      el.setAttribute('class', 'venn-circle');
      svg.appendChild(el);
    });
  }

  /** 集合インデックスごとの色（色相を変える） */
  _setColor(i) {
    const palette = [
      { fill: 'hsl(217, 85%, 55%)', stroke: 'hsl(217, 75%, 42%)' }, // 青（ブランド）
      { fill: 'hsl(0, 75%, 58%)',   stroke: 'hsl(0, 70%, 45%)' },   // 赤
      { fill: 'hsl(145, 55%, 45%)', stroke: 'hsl(145, 55%, 32%)' }, // 緑
    ];
    return palette[i % palette.length];
  }

  /**
   * 集合数に応じたラベル定位置クラス（円・アイテムと被らない外側）。
   * 円の角度配置（_layoutCircles の angles=[-90, 30, 150]）と一致させること：
   *   i=0 → 上 / i=1 → 右下 / i=2 → 左下
   */
  _labelPositions(n) {
    if (n >= 3) {
      return ['venn-set-label--t', 'venn-set-label--br', 'venn-set-label--bl'];
    }
    // 2集合（および1集合）は左上・右上（円も左・右の順）
    return ['venn-set-label--tl', 'venn-set-label--tr'];
  }

  // ─────────────────────────────────────────
  // アイテム操作（matrix を流用）
  // ─────────────────────────────────────────

  /** 指定座標(0〜1)に新しいアイテムを追加し、直後に編集モードへ */
  addItem(x, y) {
    const id = 'item_' + Date.now();
    const newItem = { id, text: '新しい項目', x, y };
    this.config.items.push(newItem);

    const el = this._buildItemEl(newItem);
    this._itemLayerEl.appendChild(el);

    this.editItem(id);
  }

  /** アイテムをインライン編集モードにする */
  editItem(id) {
    const el = this._getItemEl(id);
    if (!el) return;
    const textEl = el.querySelector('.venn-item-text');
    const item = this._getItemData(id);

    textEl.contentEditable = 'true';
    textEl.focus();

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
      // Enter で確定。IME変換確定のEnterで誤確定しないよう e.isComposing でガード。
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        textEl.blur();
      }
    });
  }

  /** アイテムの座標を更新する（0〜1にクランプ。matrix と同じ） */
  moveItem(id, x, y) {
    const item = this._getItemData(id);
    if (!item) return;
    item.x = Math.max(0, Math.min(1, x));
    item.y = Math.max(0, Math.min(1, y));
    const el = this._getItemEl(id);
    if (el) {
      el.style.left = (item.x * 100) + '%';
      el.style.top = (item.y * 100) + '%';
    }
  }

  /** アイテムを削除する */
  deleteItem(id) {
    this.config.items = this.config.items.filter(i => i.id !== id);
    const el = this._getItemEl(id);
    if (el) el.remove();
    this.selectedItemId = null;
    this._updateDeleteBtnState();
  }

  /** ツールバーの削除ボタンから呼ばれる（選択アイテムを削除） */
  _deleteSelected() {
    if (!this.selectedItemId) {
      this._showToast('削除するアイテムを選択してください');
      return;
    }
    this.deleteItem(this.selectedItemId);
  }

  _selectItem(id) {
    if (this.selectedItemId) {
      const prev = this._getItemEl(this.selectedItemId);
      if (prev) prev.classList.remove('is-selected');
    }
    this.selectedItemId = id;
    const el = this._getItemEl(id);
    if (el) el.classList.add('is-selected');
    this._updateDeleteBtnState();
  }

  _deselectItem() {
    if (!this.selectedItemId) return;
    const el = this._getItemEl(this.selectedItemId);
    if (el) el.classList.remove('is-selected');
    this.selectedItemId = null;
    this._updateDeleteBtnState();
  }

  _updateDeleteBtnState() {
    if (this._deleteBtn) {
      this._deleteBtn.disabled = !this.selectedItemId;
    }
  }

  // ─────────────────────────────────────────
  // 集合ラベル編集
  // ─────────────────────────────────────────

  /** 集合ラベルをインライン編集する */
  editSetLabel(setId, el) {
    if (el.contentEditable === 'true') return;
    const set = this.config.sets.find(s => s.id === setId);
    if (!set) return;

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
      set.label = el.textContent.trim() || '（集合名）';
      el.textContent = set.label;
    };

    el.addEventListener('blur', finish, { once: true });
    el.addEventListener('keydown', (e) => {
      // IME変換確定のEnterで誤確定しないよう e.isComposing でガード。
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        el.blur();
      }
    });
  }

  // ─────────────────────────────────────────
  // ドラッグ処理（matrix と同一）
  // ─────────────────────────────────────────

  _onDragStart(e, id) {
    e.preventDefault();
    this._selectItem(id);

    const el = this._getItemEl(id);
    el.classList.add('is-dragging');
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
      try { el.releasePointerCapture(e.pointerId); } catch (_) {}
    }
    this.dragState = null;
  }

  // ─────────────────────────────────────────
  // グローバルイベント（init で1回だけ登録）
  // ─────────────────────────────────────────

  _bindGlobalEvents() {
    document.addEventListener('keydown', (e) => {
      // 削除トリガーは Delete キーのみ（Backspace は誤削除防止のため除外）
      if (e.key === 'Delete' && this.selectedItemId) {
        const active = document.activeElement;
        if (active && (active.contentEditable === 'true' || active.tagName === 'INPUT')) return;
        this.deleteItem(this.selectedItemId);
      }
      if (e.key === 'Escape') {
        this._deselectItem();
      }
    });

    // アイテム外クリックで選択解除
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.venn-item')) {
        this._deselectItem();
      }
    });

    // resize：盤面サイズが変わるので円を再配置
    window.addEventListener('resize', this._boundRelayout);
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
    this.selectedItemId = null;
    this.render();
  }

  exportJSON() {
    exportAsJSON(this.config.id, this.config);
  }

  // ─────────────────────────────────────────
  // ユーティリティ
  // ─────────────────────────────────────────

  _getItemEl(id) {
    return this._itemLayerEl
      ? this._itemLayerEl.querySelector('.venn-item[data-id="' + id + '"]')
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
