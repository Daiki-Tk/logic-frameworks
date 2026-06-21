/**
 * tree.js - 型B：ツリー/階層型エンジン
 *
 * 使い方:
 *   const engine = new TreeEngine(containerEl, config);
 *   engine.init();
 *
 * config は frameworks.json の1エントリ（type: "tree"）を渡す。
 * direction で2方向を1エンジンが賄う:
 *   "horizontal" … ロジックツリー（親の右に子を縦並び：左→右）
 *   "vertical"   … ピラミッド（親の下に子を横並び：上→下）
 *
 * ■ 型Aとの本質的な違い
 *   型A(matrix)は付箋を0〜1座標で自由配置・ドラッグした。
 *   型Bは座標を持たず、children の入れ子（階層構造）から
 *   レイアウトを自動計算する。ノードを任意座標へドラッグする機能は作らない。
 *
 * ■ 将来拡張（今回はスコープ外。コメント言及のみ）
 *   - ドラッグによる兄弟の並べ替え
 *   - サブツリーの折りたたみ/展開
 *   - ノード個別の色分け
 *   - 複数ルート（フォレスト）
 */
class TreeEngine {
  /**
   * @param {HTMLElement} containerEl - ツリーを描画するコンテナ要素
   * @param {object} config - フレームワーク定義（frameworks.json の1エントリ）
   */
  constructor(containerEl, config) {
    this.container = containerEl;
    this.config = JSON.parse(JSON.stringify(config)); // ディープコピー（編集対象）
    // リセット用に初期configをインスタンスに保持（グローバル定数に依存しない）
    this._defaultConfig = JSON.parse(JSON.stringify(config));

    this.selectedNodeId = null; // 現在選択中のノードID

    this._deleteBtn = null;     // ツールバーの削除ボタン参照
    this._wrapperEl = null;     // スクロールコンテナ
    this._canvasEl = null;      // ノード＋線を載せる内側コンテナ
    this._svgEl = null;         // 接続線レイヤー
    this._nodesEl = null;       // ノードツリーのルート要素

    // 接続線の再描画ハンドラ（this バインドした固定参照）。
    // resize リスナーを init で1回だけ登録し、render毎に増やさないため。
    this._boundRedraw = () => this._redrawLines();
  }

  /** 初期化：保存データがあれば復元、なければ config のまま描画 */
  init() {
    const saved = loadFramework(this.config.id);
    if (saved) {
      this.config = saved;
    }
    this.render();
    this._bindGlobalEvents();

    // Noto Sans JP は非同期で読み込まれるため、フォント確定後に線を引き直す
    // （フォント差し替えでノード幅が変わり接続線がズレるのを防ぐ）
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => this._redrawLines());
    }
  }

  // ─────────────────────────────────────────
  // 描画
  // ─────────────────────────────────────────

  /** ツリー全体を再描画する */
  render() {
    this.container.innerHTML = '';
    this.container.appendChild(this._buildToolbar());

    // スクロールコンテナ（横スクロールで全体を見られるようにする）
    const wrapper = document.createElement('div');
    wrapper.className = 'tree-wrapper';

    // 内側コンテナ（ノードと線を内包。コンテンツサイズに広がる）
    const canvas = document.createElement('div');
    canvas.className = 'tree-canvas';
    canvas.dataset.direction = this.config.direction === 'vertical' ? 'vertical' : 'horizontal';

    // 接続線レイヤー（ノードの背面）
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'tree-lines');

    // ノードツリー
    const nodes = document.createElement('div');
    nodes.className = 'tree-nodes';
    nodes.appendChild(this._buildNode(this.config.root, true));

    canvas.appendChild(svg);
    canvas.appendChild(nodes);
    wrapper.appendChild(canvas);
    this.container.appendChild(wrapper);

    this._wrapperEl = wrapper;
    this._canvasEl = canvas;
    this._svgEl = svg;
    this._nodesEl = nodes;

    // レイアウト確定後に接続線を描画する
    requestAnimationFrame(() => this._redrawLines());
  }

  /** ツールバー（ボタン群）を生成する */
  _buildToolbar() {
    const bar = document.createElement('div');
    bar.className = 'lf-toolbar'; // ツールバーのスタイルは全エンジン共通

    const title = document.createElement('h2');
    title.className = 'lf-title';
    title.textContent = this.config.title;

    const btnSave = this._createButton('保存', 'btn-primary', () => this.save());
    const btnDelete = this._createButton('削除', 'btn-danger', () => this._deleteSelected());
    const btnExport = this._createButton('JSONエクスポート', 'btn-secondary', () => this.exportJSON());
    const btnReset = this._createButton('リセット', 'btn-danger', () => this.reset());

    // 削除ボタンは選択ノードがあるときのみ有効
    this._deleteBtn = btnDelete;
    this._updateDeleteBtnState();

    bar.appendChild(title);
    bar.appendChild(btnSave);
    bar.appendChild(btnDelete);
    bar.appendChild(btnExport);
    bar.appendChild(btnReset);
    return bar;
  }

  /**
   * ノードのサブツリーを再帰的に生成する
   * @param {object} node - { id, text, children: [] }
   * @param {boolean} isRoot - ルートノードかどうか
   * @returns {HTMLElement} .tree-subtree 要素
   */
  _buildNode(node, isRoot) {
    const subtree = document.createElement('div');
    subtree.className = 'tree-subtree';

    // ── ノード本体（編集可能なボックス）
    const box = document.createElement('div');
    box.className = 'tree-node';
    box.dataset.id = node.id;
    if (isRoot) box.classList.add('is-root');

    const text = document.createElement('span');
    text.className = 'tree-node-text';
    // ユーザーテキストは textContent のみで描画（XSS対策。innerHTML禁止）
    text.textContent = node.text;
    box.appendChild(text);

    // ── ノード操作の小ボタン（ホバー/選択時に表示）
    const controls = document.createElement('div');
    controls.className = 'tree-node-controls';

    const btnChild = document.createElement('button');
    btnChild.className = 'tree-mini-btn';
    btnChild.textContent = '＋子';
    btnChild.title = '子ノードを追加';
    btnChild.addEventListener('click', (e) => {
      e.stopPropagation();
      this.addChild(node.id);
    });
    controls.appendChild(btnChild);

    // ルートには兄弟を作らない
    if (!isRoot) {
      const btnSibling = document.createElement('button');
      btnSibling.className = 'tree-mini-btn';
      btnSibling.textContent = '＋兄弟';
      btnSibling.title = '兄弟ノードを追加';
      btnSibling.addEventListener('click', (e) => {
        e.stopPropagation();
        this.addSibling(node.id);
      });
      controls.appendChild(btnSibling);
    }
    box.appendChild(controls);

    // クリックで選択
    box.addEventListener('click', (e) => {
      e.stopPropagation();
      this._selectNode(node.id);
    });
    // ダブルクリックで編集
    box.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      this.editNode(node.id);
    });

    subtree.appendChild(box);

    // ── 子ノード群
    const childrenWrap = document.createElement('div');
    childrenWrap.className = 'tree-children';
    (node.children || []).forEach(child => {
      childrenWrap.appendChild(this._buildNode(child, false));
    });
    subtree.appendChild(childrenWrap);

    return subtree;
  }

  // ─────────────────────────────────────────
  // 接続線
  // ─────────────────────────────────────────

  /**
   * 全ノードの矩形位置から親子の接続線を再計算してSVGへ描画する。
   * render時・resize時・フォント確定時・テキスト/構造変更時に呼ばれる。
   */
  _redrawLines() {
    // SVG(.tree-lines)は .tree-canvas の子で原点はcanvas左上。
    // よって座標もSVGサイズも canvas 基準に統一する（flow の cycle修正と同じ）。
    // wrapper基準だと canvas を margin:auto で中央寄せした分だけ線がずれるため。
    const ref = this._canvasEl;
    const svg = this._svgEl;
    if (!ref || !svg) return;

    // 既存の線を消去し、計測前に一旦サイズを0にする
    // （SVG自身がscrollWidthを膨らませる自己フィードバックを防ぐ）
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    svg.setAttribute('width', 0);
    svg.setAttribute('height', 0);

    // スクロール領域全体（見切れている部分も含む）にSVGを合わせる（canvas基準）
    const w = ref.scrollWidth;
    const h = ref.scrollHeight;
    svg.setAttribute('width', w);
    svg.setAttribute('height', h);
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);

    const horizontal = this.config.direction !== 'vertical';
    const refRect = ref.getBoundingClientRect();
    const SVGNS = 'http://www.w3.org/2000/svg';

    // canvas 基準の相対座標（スクロール不変なので scrollLeft/Top は加えない）。
    // SVG原点（canvasの子・0,0）と一致するため、canvas中央寄せにも線が追従する。
    const toContentX = (clientX) => clientX - refRect.left;
    const toContentY = (clientY) => clientY - refRect.top;

    // ツリーを辿りながら、親→各子へ線を引く
    const walk = (node) => {
      const pEl = this._getNodeEl(node.id);
      if (!pEl) return;
      const pr = pEl.getBoundingClientRect();

      (node.children || []).forEach(child => {
        const cEl = this._getNodeEl(child.id);
        if (cEl) {
          const cr = cEl.getBoundingClientRect();
          let x1, y1, x2, y2, d;

          if (horizontal) {
            // 親の右辺中央 → 子の左辺中央
            x1 = toContentX(pr.right);
            y1 = toContentY(pr.top + pr.height / 2);
            x2 = toContentX(cr.left);
            y2 = toContentY(cr.top + cr.height / 2);
            const mx = (x1 + x2) / 2; // 横方向の中間で曲げる滑らかなエルボー
            d = `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
          } else {
            // 親の下辺中央 → 子の上辺中央
            x1 = toContentX(pr.left + pr.width / 2);
            y1 = toContentY(pr.bottom);
            x2 = toContentX(cr.left + cr.width / 2);
            y2 = toContentY(cr.top);
            const my = (y1 + y2) / 2;
            d = `M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`;
          }

          const path = document.createElementNS(SVGNS, 'path');
          path.setAttribute('d', d);
          path.setAttribute('class', 'tree-line');
          svg.appendChild(path);
        }
        walk(child);
      });
    };

    walk(this.config.root);
  }

  // ─────────────────────────────────────────
  // ノード操作
  // ─────────────────────────────────────────

  /**
   * 子ノードを追加し、追加直後に編集モードへ入る
   * @param {string} parentId - 親ノードID
   */
  addChild(parentId) {
    const found = this._findNode(parentId);
    if (!found) return;
    const newNode = { id: this._genId(), text: '新しい項目', children: [] };
    found.node.children.push(newNode);
    this.render();           // 構造が変わったので再描画（接続線も再計算される）
    this.editNode(newNode.id);
  }

  /**
   * 兄弟ノードを追加する（ルートには兄弟を作らない）
   * @param {string} nodeId - 基準ノードID
   */
  addSibling(nodeId) {
    const found = this._findNode(nodeId);
    if (!found) return;
    if (!found.parent) {
      // ルートには兄弟を追加できない
      this._showToast('ルートには兄弟を追加できません');
      return;
    }
    const newNode = { id: this._genId(), text: '新しい項目', children: [] };
    const idx = found.parent.children.indexOf(found.node);
    found.parent.children.splice(idx + 1, 0, newNode); // 直後に挿入
    this.render();
    this.editNode(newNode.id);
  }

  /**
   * ノードのテキストをインライン編集する
   * @param {string} nodeId - ノードID
   */
  editNode(nodeId) {
    const found = this._findNode(nodeId);
    const box = this._getNodeEl(nodeId);
    if (!found || !box) return;
    const textEl = box.querySelector('.tree-node-text');

    textEl.contentEditable = 'true';
    box.classList.add('is-editing');
    textEl.focus();

    // テキストを全選択
    const range = document.createRange();
    range.selectNodeContents(textEl);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    const finish = () => {
      textEl.contentEditable = 'false';
      box.classList.remove('is-editing');
      found.node.text = textEl.textContent.trim() || '（空）';
      textEl.textContent = found.node.text;
      // テキスト変更でノード幅が変わるため接続線を引き直す
      this._redrawLines();
    };

    textEl.addEventListener('blur', finish, { once: true });
    textEl.addEventListener('keydown', (e) => {
      // Enter で確定（改行は許可しない）。
      // IME変換確定のEnterで誤確定しないよう e.isComposing でガード。
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        textEl.blur();
      }
    });
  }

  /**
   * ノードとその子孫をまとめて削除する。
   * 子を持つ場合は確認、ルートは削除不可。
   * @param {string} nodeId - ノードID
   */
  deleteNode(nodeId) {
    const found = this._findNode(nodeId);
    if (!found) return;
    if (!found.parent) {
      this._showToast('ルートは削除できません');
      return;
    }
    // 子を持つ場合はサブツリーごと消えるため確認する
    if (found.node.children && found.node.children.length > 0) {
      if (!confirm('このノードと配下の子ノードをすべて削除します。よろしいですか？')) return;
    }
    const idx = found.parent.children.indexOf(found.node);
    if (idx >= 0) found.parent.children.splice(idx, 1);

    this.selectedNodeId = null;
    this._updateDeleteBtnState();
    this.render(); // 構造が変わったので再描画（接続線も再計算）
  }

  /** ツールバーの削除ボタンから呼ばれる（選択ノードを削除） */
  _deleteSelected() {
    if (!this.selectedNodeId) {
      this._showToast('削除するノードを選択してください');
      return;
    }
    this.deleteNode(this.selectedNodeId);
  }

  // ─────────────────────────────────────────
  // 選択
  // ─────────────────────────────────────────

  /** ノードを選択状態にする */
  _selectNode(id) {
    if (this.selectedNodeId) {
      const prev = this._getNodeEl(this.selectedNodeId);
      if (prev) prev.classList.remove('is-selected');
    }
    this.selectedNodeId = id;
    const el = this._getNodeEl(id);
    if (el) el.classList.add('is-selected');
    this._updateDeleteBtnState();
  }

  /** 選択を解除する */
  _deselectNode() {
    if (!this.selectedNodeId) return;
    const el = this._getNodeEl(this.selectedNodeId);
    if (el) el.classList.remove('is-selected');
    this.selectedNodeId = null;
    this._updateDeleteBtnState();
  }

  /** 削除ボタンの活性/非活性を選択状態に合わせて更新する */
  _updateDeleteBtnState() {
    if (this._deleteBtn) {
      this._deleteBtn.disabled = !this.selectedNodeId;
    }
  }

  // ─────────────────────────────────────────
  // グローバルイベント（init で1回だけ登録）
  // ─────────────────────────────────────────

  _bindGlobalEvents() {
    // 削除トリガーは Delete キーのみ（Backspace は誤削除防止のため対象外）
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Delete' && this.selectedNodeId) {
        const active = document.activeElement;
        if (active && (active.contentEditable === 'true' || active.tagName === 'INPUT')) return;
        this.deleteNode(this.selectedNodeId);
      }
      if (e.key === 'Escape') {
        this._deselectNode();
      }
    });

    // ノード外クリックで選択解除
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.tree-node')) {
        this._deselectNode();
      }
    });

    // ウィンドウリサイズ時に接続線を再計算（固定参照で1回だけ登録）
    window.addEventListener('resize', this._boundRedraw);
  }

  // ─────────────────────────────────────────
  // 保存・読み込み・リセット・エクスポート
  // ─────────────────────────────────────────

  /** 現在の状態を localStorage に保存する */
  save() {
    saveFramework(this.config.id, this.config);
    this._showToast('保存しました');
  }

  /** localStorage から状態を復元する */
  load() {
    const saved = loadFramework(this.config.id);
    if (saved) {
      this.config = saved;
      this.render();
    }
  }

  /** 初期状態にリセットする（インスタンス保持の初期configへ戻す） */
  reset() {
    if (!confirm('リセットすると保存内容が消えます。よろしいですか？')) return;
    clearFramework(this.config.id);
    this.config = JSON.parse(JSON.stringify(this._defaultConfig));
    this.selectedNodeId = null;
    this.render();
  }

  /** 現在の状態を JSON ファイルとしてダウンロードする */
  exportJSON() {
    exportAsJSON(this.config.id, this.config);
  }

  // ─────────────────────────────────────────
  // ユーティリティ
  // ─────────────────────────────────────────

  /** ID から DOM 要素（.tree-node）を取得する */
  _getNodeEl(id) {
    return this._nodesEl
      ? this._nodesEl.querySelector('.tree-node[data-id="' + id + '"]')
      : null;
  }

  /**
   * ID からノードデータと親ノードを再帰的に探す
   * @returns {{node: object, parent: object|null}|null}
   *          parent が null ならルートノード
   */
  _findNode(id, node = this.config.root, parent = null) {
    if (node.id === id) return { node, parent };
    for (const child of (node.children || [])) {
      const hit = this._findNode(id, child, node);
      if (hit) return hit;
    }
    return null;
  }

  /** 衝突しにくいノードIDを生成する */
  _genId() {
    return 'n_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
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
