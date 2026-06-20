/**
 * flow.js - 型C：プロセス/フロー型エンジン
 *
 * 使い方:
 *   const engine = new FlowEngine(containerEl, config);
 *   engine.init();
 *
 * config は frameworks.json の1エントリ（type: "flow"）を渡す。
 * layout で2形態を1エンジンが賄う:
 *   "linear" … 順次フロー（左→右にカードを並べ、隣接間に右向き矢印 N-1本）
 *   "cycle"  … 循環フロー（PDCA等。円周上に等間隔配置、隣接＋最後→最初の矢印 N本）
 *
 * ■ 型A/Bとの関係
 *   フローは「順序を持つステップ列」。座標は自由配置せず、配列順から
 *   レイアウトを自動計算する（型Aの自由座標は持ち込まない）。
 *
 * ■ 将来拡張（今回はスコープ外。コメント言及のみ）
 *   - ドラッグによる並べ替え
 *   - 分岐/条件（ひし形の判断ノード）
 *   - スイムレーン、並列パス
 *   - ステップ個別の色分け
 */
class FlowEngine {
  /**
   * @param {HTMLElement} containerEl - フローを描画するコンテナ要素
   * @param {object} config - フレームワーク定義（frameworks.json の1エントリ）
   */
  constructor(containerEl, config) {
    this.container = containerEl;
    this.config = JSON.parse(JSON.stringify(config)); // ディープコピー（編集対象）
    // リセット用に初期configをインスタンスに保持（グローバル定数に依存しない）
    this._defaultConfig = JSON.parse(JSON.stringify(config));

    this.selectedStepId = null;

    this._deleteBtn = null;  // ツールバーの削除ボタン参照
    this._wrapperEl = null;  // スクロールコンテナ
    this._canvasEl = null;   // カード＋線を載せる内側コンテナ
    this._svgEl = null;      // 接続線（矢印）レイヤー
    this._cardsEl = null;    // カード群のコンテナ

    // 矢印markerの一意id（複数エンジン同居時の衝突回避）
    this._markerId = 'flow-arrow-' + this.config.id;

    // resize 用の固定参照（init で1回だけ登録）
    this._boundResize = () => this._scheduleRelayout();
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

    // Noto Sans JP は非同期読み込み。フォント確定でカード寸法が変わるため、
    // cycle はカード位置の再計算（再レイアウト）→線の再クリップを行う。
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => this._relayoutAndDraw());
    }
  }

  // ─────────────────────────────────────────
  // 描画
  // ─────────────────────────────────────────

  /** フロー全体を再描画する */
  render() {
    this.container.innerHTML = '';
    this.container.appendChild(this._buildToolbar());

    const wrapper = document.createElement('div');
    wrapper.className = 'flow-wrapper';

    const canvas = document.createElement('div');
    canvas.className = 'flow-canvas';
    const layout = this.config.layout === 'cycle' ? 'cycle' : 'linear';
    canvas.dataset.layout = layout;

    // 接続線（矢印）レイヤー（カードの背面）
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'flow-lines');

    // カード群
    const cards = document.createElement('div');
    cards.className = 'flow-cards';
    this.config.steps.forEach((step, i) => {
      cards.appendChild(this._buildCard(step, i));
    });

    canvas.appendChild(svg);
    canvas.appendChild(cards);
    wrapper.appendChild(canvas);
    this.container.appendChild(wrapper);

    this._wrapperEl = wrapper;
    this._canvasEl = canvas;
    this._svgEl = svg;
    this._cardsEl = cards;

    // 選択状態の見た目を復元（render で作り直されるため）
    if (this.selectedStepId) {
      const el = this._getCardEl(this.selectedStepId);
      if (el) el.classList.add('is-selected');
    }
    this._updateDeleteBtnState();

    // レイアウト確定後に（cycleは位置計算→）線を描画
    requestAnimationFrame(() => this._relayoutAndDraw());
  }

  /** ツールバー（ボタン群）を生成する */
  _buildToolbar() {
    const bar = document.createElement('div');
    bar.className = 'lf-toolbar';

    const title = document.createElement('h2');
    title.className = 'lf-title';
    title.textContent = this.config.title;

    const btnSave = this._createButton('保存', 'btn-primary', () => this.save());
    const btnAdd = this._createButton('ステップを追加', 'btn-secondary', () => this.addStep(null));
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
   * ステップカードを生成する
   * @param {object} step - { id, title, text }
   * @param {number} index - 配列内の位置（1始まりの番号表示に使用）
   */
  _buildCard(step, index) {
    const card = document.createElement('div');
    card.className = 'flow-card';
    card.dataset.id = step.id;

    // 連番バッジ
    const badge = document.createElement('span');
    badge.className = 'flow-card-badge';
    badge.textContent = String(index + 1);
    card.appendChild(badge);

    // 見出し（必須）— ダブルクリックで編集
    const titleEl = document.createElement('div');
    titleEl.className = 'flow-card-title';
    titleEl.textContent = step.title; // textContent のみ（XSS対策）
    titleEl.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      this.editStep(step.id, 'title');
    });
    card.appendChild(titleEl);

    // 説明（任意・空可）— ダブルクリックで編集
    const textEl = document.createElement('div');
    textEl.className = 'flow-card-text';
    textEl.textContent = step.text || '';
    textEl.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      this.editStep(step.id, 'text');
    });
    card.appendChild(textEl);

    // ステップ操作の小ボタン（ホバー/選択時に表示）
    const controls = document.createElement('div');
    controls.className = 'flow-card-controls';

    const btnPrev = this._miniBtn('◀', '前へ移動', (e) => {
      e.stopPropagation();
      this.moveStep(step.id, -1);
    });
    const btnAdd = this._miniBtn('＋', 'このステップの直後に追加', (e) => {
      e.stopPropagation();
      this.addStep(step.id);
    });
    const btnNext = this._miniBtn('▶', '次へ移動', (e) => {
      e.stopPropagation();
      this.moveStep(step.id, +1);
    });
    controls.appendChild(btnPrev);
    controls.appendChild(btnAdd);
    controls.appendChild(btnNext);
    card.appendChild(controls);

    // クリックで選択
    card.addEventListener('click', (e) => {
      e.stopPropagation();
      this._selectStep(step.id);
    });

    return card;
  }

  // ─────────────────────────────────────────
  // レイアウト（cycle はカード位置をJSで計算）
  // ─────────────────────────────────────────

  /** resize をまとめて1フレームに集約して再レイアウトする */
  _scheduleRelayout() {
    if (this._relayoutScheduled) return;
    this._relayoutScheduled = true;
    requestAnimationFrame(() => {
      this._relayoutScheduled = false;
      this._relayoutAndDraw();
    });
  }

  /**
   * cycle のときはカード位置を再計算してから線を描く。
   * linear は配置をCSSに任せるため線の再描画のみ。
   */
  _relayoutAndDraw() {
    if (!this._canvasEl) return;
    if (this.config.layout === 'cycle') {
      this._layoutCycle();
    }
    this._redrawLines();
  }

  /**
   * cycle レイアウト：カード中心を円周上に等間隔配置する。
   * - 角度 = -90° + i×360/N（上から時計回り）
   * - カード中心が円周点に乗るよう translate(-50%,-50%) で補正（CSS側）
   * - 半径はカードの半サイズ分だけ内側に収め、はみ出し/重なりを防ぐ
   */
  _layoutCycle() {
    const wrapper = this._wrapperEl;
    const canvas = this._canvasEl;
    const steps = this.config.steps;
    const N = steps.length;

    // 正方形キャンバスの一辺（コンテナ幅から算出。過大/過小を抑制）
    const avail = wrapper.clientWidth || 480;
    const S = Math.max(300, Math.min(avail - 8, 560));
    canvas.style.width = S + 'px';
    canvas.style.height = S + 'px';

    const center = S / 2;

    // カードの最大半径（最大の幅/高さの半分）を測り、円からのはみ出しを防ぐ
    let maxHalf = 0;
    steps.forEach(step => {
      const el = this._getCardEl(step.id);
      if (el) {
        maxHalf = Math.max(maxHalf, el.offsetWidth / 2, el.offsetHeight / 2);
      }
    });

    // 半径：盤面の半分からカード半径と余白を引いて内側に収める
    let R = center - maxHalf - 8;
    if (R < 0) R = 0;

    if (N === 1) {
      // N=1：矢印なし。中央に1枚だけ置く
      const el = this._getCardEl(steps[0].id);
      if (el) {
        el.style.left = center + 'px';
        el.style.top = center + 'px';
      }
      return;
    }

    steps.forEach((step, i) => {
      const el = this._getCardEl(step.id);
      if (!el) return;
      const angle = (-90 + i * 360 / N) * Math.PI / 180;
      const x = center + R * Math.cos(angle);
      const y = center + R * Math.sin(angle);
      el.style.left = x + 'px';
      el.style.top = y + 'px';
    });
  }

  // ─────────────────────────────────────────
  // 接続線（矢印）
  // ─────────────────────────────────────────

  /**
   * 全カードの矩形位置から矢印を再計算してSVGへ描画する。
   * render後・resize時・fonts.ready後・編集確定後・追加/削除/並べ替え後に呼ばれる。
   */
  _redrawLines() {
    // SVG(.flow-lines)は .flow-canvas の子で原点はcanvas左上。
    // よって座標もSVGサイズも canvas 基準に統一する。
    // （wrapper基準だと cycle の margin:0 auto 中央寄せ分だけ矢印が右へずれ、
    //   かつ過大サイズSVGで余計な横スクロールが出ていた）
    const ref = this._canvasEl;
    const svg = this._svgEl;
    if (!ref || !svg) return;

    // 既存内容を消し、計測前に一旦0サイズへ（SVG自身がscrollWidthを膨らませるのを防ぐ）
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    svg.setAttribute('width', 0);
    svg.setAttribute('height', 0);

    const w = ref.scrollWidth;  // cycle≈S / linear=コンテンツ幅
    const h = ref.scrollHeight;
    svg.setAttribute('width', w);
    svg.setAttribute('height', h);
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);

    // 矢印marker（orient="auto" で線の向きに追従）
    svg.appendChild(this._buildArrowDefs());

    const steps = this.config.steps;
    const N = steps.length;
    if (N < 2) return; // N=1 は矢印なし

    // canvas 基準の相対座標（スクロール不変なので scrollLeft/Top は加えない）
    const refRect = ref.getBoundingClientRect();
    const toX = (clientX) => clientX - refRect.left;
    const toY = (clientY) => clientY - refRect.top;

    const isCycle = this.config.layout === 'cycle';
    // 描画する辺の本数：linear は N-1、cycle は N（最後→最初を含む）
    const arrowCount = isCycle ? N : N - 1;

    for (let i = 0; i < arrowCount; i++) {
      const from = this._getCardEl(steps[i].id);
      const to = this._getCardEl(steps[(i + 1) % N].id);
      if (!from || !to) continue;
      const fr = from.getBoundingClientRect();
      const tr = to.getBoundingClientRect();

      // 各カードの中心（コンテンツ座標）
      const fc = { x: toX(fr.left + fr.width / 2), y: toY(fr.top + fr.height / 2) };
      const tc = { x: toX(tr.left + tr.width / 2), y: toY(tr.top + tr.height / 2) };

      let d;
      if (isCycle) {
        // 中心同士を結ぶ線を、各カード境界の少し手前で切る
        const start = this._edgePoint(fr, toX, toY, tc.x, tc.y, 4);
        const end = this._edgePoint(tr, toX, toY, fc.x, fc.y, 6);
        // 円らしく見せるため弦に対して垂直方向へ少し膨らませる
        // （N=2 では前進/戻りが逆側へ膨らみ、重ならない）
        const mx = (start.x + end.x) / 2;
        const my = (start.y + end.y) / 2;
        const dx = end.x - start.x, dy = end.y - start.y;
        const len = Math.hypot(dx, dy) || 1;
        const bow = len * 0.14;
        const ctrlX = mx + (-dy / len) * bow;
        const ctrlY = my + (dx / len) * bow;
        d = `M ${start.x} ${start.y} Q ${ctrlX} ${ctrlY} ${end.x} ${end.y}`;
      } else {
        // linear：前カード右辺中央 → 次カード左辺中央（境界の少し手前まで）
        const sx = toX(fr.right) + 2;
        const sy = toY(fr.top + fr.height / 2);
        const ex = toX(tr.left) - 6;
        const ey = toY(tr.top + tr.height / 2);
        d = `M ${sx} ${sy} L ${ex} ${ey}`;
      }

      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      path.setAttribute('class', 'flow-line');
      path.setAttribute('marker-end', `url(#${this._markerId})`);
      svg.appendChild(path);
    }
  }

  /** 矢印markerの <defs> を生成する */
  _buildArrowDefs() {
    const NS = 'http://www.w3.org/2000/svg';
    const defs = document.createElementNS(NS, 'defs');
    const marker = document.createElementNS(NS, 'marker');
    marker.setAttribute('id', this._markerId);
    marker.setAttribute('markerWidth', '10');
    marker.setAttribute('markerHeight', '10');
    marker.setAttribute('refX', '8');     // 線の終端に矢じりの先端を合わせる
    marker.setAttribute('refY', '3');
    marker.setAttribute('orient', 'auto'); // 線の向きに追従
    marker.setAttribute('markerUnits', 'userSpaceOnUse');

    const head = document.createElementNS(NS, 'path');
    head.setAttribute('d', 'M0,0 L8,3 L0,6 Z');
    head.setAttribute('class', 'flow-arrow-head');
    marker.appendChild(head);
    defs.appendChild(marker);
    return defs;
  }

  /**
   * カード矩形の中心から (towardX, towardY) 方向へ伸ばし、矩形の境界点を求める。
   * backoff 分だけ外側（toward方向）へずらして、矢印が境界の少し手前で止まるようにする。
   */
  _edgePoint(rect, toX, toY, towardX, towardY, backoff) {
    const cx = toX(rect.left + rect.width / 2);
    const cy = toY(rect.top + rect.height / 2);
    const hw = rect.width / 2;
    const hh = rect.height / 2;
    let dx = towardX - cx;
    let dy = towardY - cy;
    if (dx === 0 && dy === 0) return { x: cx, y: cy };

    const sx = dx !== 0 ? hw / Math.abs(dx) : Infinity;
    const sy = dy !== 0 ? hh / Math.abs(dy) : Infinity;
    const s = Math.min(sx, sy);
    let bx = cx + dx * s;
    let by = cy + dy * s;

    // toward方向へ backoff px ずらす
    const len = Math.hypot(dx, dy);
    bx += (dx / len) * backoff;
    by += (dy / len) * backoff;
    return { x: bx, y: by };
  }

  // ─────────────────────────────────────────
  // ステップ操作
  // ─────────────────────────────────────────

  /**
   * ステップを追加する。afterId があればその直後、なければ末尾に追加。
   * 追加直後に見出しの編集モードへ入る。
   * @param {string|null} afterId
   */
  addStep(afterId) {
    const step = { id: this._genId(), title: '新しいステップ', text: '' };
    if (afterId) {
      const idx = this._indexOf(afterId);
      this.config.steps.splice(idx + 1, 0, step);
    } else {
      this.config.steps.push(step);
    }
    this.render();
    this.editStep(step.id, 'title');
  }

  /**
   * ステップの見出し/説明をインライン編集する
   * @param {string} stepId
   * @param {"title"|"text"} field
   */
  editStep(stepId, field = 'title') {
    const step = this._getStep(stepId);
    const card = this._getCardEl(stepId);
    if (!step || !card) return;
    const el = card.querySelector(field === 'text' ? '.flow-card-text' : '.flow-card-title');

    el.contentEditable = 'true';
    card.classList.add('is-editing');
    el.focus();

    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    const finish = () => {
      el.contentEditable = 'false';
      card.classList.remove('is-editing');
      const value = el.textContent.trim();
      if (field === 'title') {
        step.title = value || '（無題）'; // 見出しは必須なので空ならプレースホルダ
        el.textContent = step.title;
      } else {
        step.text = value; // 説明は空を許容
        el.textContent = step.text;
      }
      // テキスト変更でカード寸法が変わるため、再レイアウト＋線の再クリップ
      this._relayoutAndDraw();
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

  /**
   * ステップを削除する
   * @param {string} stepId
   */
  deleteStep(stepId) {
    const idx = this._indexOf(stepId);
    if (idx < 0) return;
    this.config.steps.splice(idx, 1);
    this.selectedStepId = null;
    this._updateDeleteBtnState();
    this.render();
  }

  /**
   * ステップを前後へ並べ替える（配列の順序変更）
   * @param {string} stepId
   * @param {number} dir - -1（前へ）/ +1（後へ）
   */
  moveStep(stepId, dir) {
    const idx = this._indexOf(stepId);
    if (idx < 0) return;
    const j = idx + dir;
    if (j < 0 || j >= this.config.steps.length) return; // 端ではそれ以上動かさない
    const steps = this.config.steps;
    [steps[idx], steps[j]] = [steps[j], steps[idx]];
    this.render(); // selectedStepId は維持され、render で選択枠も復元される
  }

  /** ツールバーの削除ボタンから呼ばれる（選択ステップを削除） */
  _deleteSelected() {
    if (!this.selectedStepId) {
      this._showToast('削除するステップを選択してください');
      return;
    }
    this.deleteStep(this.selectedStepId);
  }

  // ─────────────────────────────────────────
  // 選択
  // ─────────────────────────────────────────

  _selectStep(id) {
    if (this.selectedStepId) {
      const prev = this._getCardEl(this.selectedStepId);
      if (prev) prev.classList.remove('is-selected');
    }
    this.selectedStepId = id;
    const el = this._getCardEl(id);
    if (el) el.classList.add('is-selected');
    this._updateDeleteBtnState();
  }

  _deselectStep() {
    if (!this.selectedStepId) return;
    const el = this._getCardEl(this.selectedStepId);
    if (el) el.classList.remove('is-selected');
    this.selectedStepId = null;
    this._updateDeleteBtnState();
  }

  _updateDeleteBtnState() {
    if (this._deleteBtn) {
      this._deleteBtn.disabled = !this.selectedStepId;
    }
  }

  // ─────────────────────────────────────────
  // グローバルイベント（init で1回だけ登録）
  // ─────────────────────────────────────────

  _bindGlobalEvents() {
    document.addEventListener('keydown', (e) => {
      // 削除トリガーは Delete キーのみ（Backspace は誤削除防止のため除外）
      if (e.key === 'Delete' && this.selectedStepId) {
        const active = document.activeElement;
        if (active && (active.contentEditable === 'true' || active.tagName === 'INPUT')) return;
        this.deleteStep(this.selectedStepId);
      }
      if (e.key === 'Escape') {
        this._deselectStep();
      }
    });

    document.addEventListener('click', (e) => {
      if (!e.target.closest('.flow-card')) {
        this._deselectStep();
      }
    });

    // resize：cycle は再レイアウト→線描画、linear は線描画のみ（_relayoutAndDraw が判定）
    window.addEventListener('resize', this._boundResize);
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
    this.selectedStepId = null;
    this.render();
  }

  exportJSON() {
    exportAsJSON(this.config.id, this.config);
  }

  // ─────────────────────────────────────────
  // ユーティリティ
  // ─────────────────────────────────────────

  _getCardEl(id) {
    return this._cardsEl
      ? this._cardsEl.querySelector('.flow-card[data-id="' + id + '"]')
      : null;
  }

  _getStep(id) {
    return this.config.steps.find(s => s.id === id) || null;
  }

  _indexOf(id) {
    return this.config.steps.findIndex(s => s.id === id);
  }

  _genId() {
    return 's_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
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
    btn.className = 'flow-mini-btn';
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
