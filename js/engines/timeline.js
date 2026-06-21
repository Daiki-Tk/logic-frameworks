/**
 * timeline.js - 型F：時系列/線表型エンジン
 *
 * 使い方:
 *   const engine = new TimelineEngine(containerEl, config);
 *   engine.init();
 *
 * config は frameworks.json の1エントリ（type: "timeline"）を渡す。
 * ガントチャート/ロードマップを賄う。
 *
 * ■ 型Fの構造
 *   時間軸＝列、行＝タスク。バーは「開始(start)・期間(span)」を列インデックスで表す。
 *   座標は自由配置せず、行（タスク）×時間軸（目盛り）のグリッドにバーを配置する。
 *   タスクは配列順に縦に並ぶ。
 *
 * ■ 描画方式（堅さ優先）
 *   バーは座標計算せず CSS Grid の grid-column で列を指定する。
 *   grid-column: (start+2) / span (span)
 *     +2 = 1-based かつ行見出し列ぶん。
 *   ピクセル⇄列の変換を持たないので、cycle/矢印で起きたようなズレが原理的に起きない。
 *   座標の実測が要るのはバーのドラッグの「列デルタ計算」だけに集約する。
 *
 * ■ 将来拡張（今回はスコープ外。コメント言及のみ）
 *   - 依存関係の矢印、マイルストーン菱形
 *   - 日付の実カレンダー演算（目盛りは文字列ラベルのみ）
 *   - ズーム、行のグルーピング/階層、ドラッグでの行並べ替え
 */
class TimelineEngine {
  /**
   * @param {HTMLElement} containerEl - タイムラインを描画するコンテナ要素
   * @param {object} config - フレームワーク定義（frameworks.json の1エントリ）
   */
  constructor(containerEl, config) {
    this.container = containerEl;
    this.config = JSON.parse(JSON.stringify(config)); // ディープコピー（編集対象）
    // リセット用に初期configをインスタンスに保持（グローバル定数に依存しない）
    this._defaultConfig = JSON.parse(JSON.stringify(config));

    this.selectedTaskId = null;

    this._deleteBtn = null;
    this._gridEl = null;

    // バードラッグ中の状態（pointerdownで基準値をスナップショット固定する）
    this.barDrag = null;
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

  /** タイムライン全体を再描画する（構造変更時のみ呼ぶ。バー移動はgrid-column貼り替えで対応） */
  render() {
    this.container.innerHTML = '';
    this.container.appendChild(this._buildToolbar());

    const N = this.config.scale.length;

    const wrapper = document.createElement('div');
    wrapper.className = 'timeline-wrapper';

    const grid = document.createElement('div');
    grid.className = 'timeline-grid';
    // 列：行見出し列(160px) + 目盛り列 N本（minmax(72px,1fr) で可変・多い時は横スクロール）
    grid.style.gridTemplateColumns = `160px repeat(${N}, minmax(72px, 1fr))`;

    // ── ヘッダー行（row 1）：左上コーナー＋目盛りラベル
    const corner = document.createElement('div');
    corner.className = 'timeline-corner';
    corner.style.gridRow = '1';
    corner.style.gridColumn = '1';
    corner.textContent = 'タスク \\ 期間';
    grid.appendChild(corner);

    this.config.scale.forEach((label, i) => {
      const cell = document.createElement('div');
      cell.className = 'timeline-scale-cell';
      cell.dataset.index = i;
      cell.style.gridRow = '1';
      cell.style.gridColumn = (i + 2);
      cell.title = 'ダブルクリックで目盛りを編集';

      // ラベルは専用spanに入れる（セル直下に✕ボタンを共存させるため）
      const labelEl = document.createElement('span');
      labelEl.className = 'timeline-scale-label';
      labelEl.textContent = label; // textContent のみ（XSS対策）
      labelEl.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        this.editScaleLabel(i);
      });
      cell.appendChild(labelEl);

      // 列削除の✕（ホバーで表示。行の✕と同作法。タスク選択とは独立）
      const del = document.createElement('button');
      del.className = 'timeline-scale-del';
      del.textContent = '✕';
      del.title = 'この期間（列）を削除';
      del.addEventListener('pointerdown', (e) => e.stopPropagation());
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        this.deleteScale(i);
      });
      cell.appendChild(del);

      grid.appendChild(cell);
    });

    // ── タスク行（row k+2）
    this.config.tasks.forEach((task, k) => {
      const rowIndex = k + 2;
      // start/span を防御的にクランプ
      const { start, span } = this._clampTask(task.start, task.span);
      task.start = start;
      task.span = span;

      // 行見出し（左固定列）
      grid.appendChild(this._buildRowhead(task, rowIndex));

      // 背景セル（グリッド線用）
      for (let c = 0; c < N; c++) {
        const cell = document.createElement('div');
        cell.className = 'timeline-cell';
        cell.style.gridRow = rowIndex;
        cell.style.gridColumn = (c + 2);
        grid.appendChild(cell);
      }

      // バー（grid-column で配置）
      grid.appendChild(this._buildBar(task, rowIndex));
    });

    wrapper.appendChild(grid);
    this.container.appendChild(wrapper);
    this._gridEl = grid;

    // 選択状態の見た目を復元
    if (this.selectedTaskId) {
      const bar = this._getBarEl(this.selectedTaskId);
      if (bar) bar.classList.add('is-selected');
      const rh = this._getRowheadEl(this.selectedTaskId);
      if (rh) rh.classList.add('is-selected');
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
    const btnAdd = this._createButton('タスクを追加', 'btn-secondary', () => this.addTask(null));
    // 期間（列）の追加。タスク選択とは独立。削除ボタンのdisabled連動には絡めない。
    const btnAddScale = this._createButton('期間を追加', 'btn-secondary', () => this.addScale());
    const btnDelete = this._createButton('削除', 'btn-danger', () => this._deleteSelected());
    const btnExport = this._createButton('JSONエクスポート', 'btn-secondary', () => this.exportJSON());
    const btnReset = this._createButton('リセット', 'btn-danger', () => this.reset());

    this._deleteBtn = btnDelete;
    this._updateDeleteBtnState();

    bar.appendChild(title);
    bar.appendChild(btnSave);
    bar.appendChild(btnAdd);
    bar.appendChild(btnAddScale);
    bar.appendChild(btnDelete);
    bar.appendChild(btnExport);
    bar.appendChild(btnReset);
    return bar;
  }

  /** 行見出し（タスク名＋操作ボタン。左固定列） */
  _buildRowhead(task, rowIndex) {
    const rh = document.createElement('div');
    rh.className = 'timeline-rowhead';
    rh.dataset.id = task.id;
    rh.style.gridRow = rowIndex;
    rh.style.gridColumn = '1';

    const label = document.createElement('span');
    label.className = 'timeline-rowhead-label';
    label.textContent = task.label;
    label.title = 'ダブルクリックで編集';
    label.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      this.editTaskLabel(task.id);
    });
    rh.appendChild(label);

    const controls = document.createElement('div');
    controls.className = 'timeline-controls';
    controls.appendChild(this._miniBtn('▲', '上へ移動', (e) => { e.stopPropagation(); this.moveTask(task.id, -1); }));
    controls.appendChild(this._miniBtn('▼', '下へ移動', (e) => { e.stopPropagation(); this.moveTask(task.id, +1); }));
    controls.appendChild(this._miniBtn('＋', 'このタスクの直後に追加', (e) => { e.stopPropagation(); this.addTask(task.id); }));
    controls.appendChild(this._miniBtn('✕', 'このタスクを削除', (e) => { e.stopPropagation(); this.deleteTask(task.id); }));
    rh.appendChild(controls);

    rh.addEventListener('click', (e) => {
      if (e.target.closest('.timeline-controls')) return;
      this._selectTask(task.id);
    });

    return rh;
  }

  /** バー要素（grid-column で start/span 列に配置） */
  _buildBar(task, rowIndex) {
    const bar = document.createElement('div');
    bar.className = 'timeline-bar';
    bar.dataset.id = task.id;
    bar.style.gridRow = rowIndex;
    this._applyBarColumn(bar, task.start, task.span);

    // 左ハンドル（span を左へ伸縮）
    const hl = document.createElement('div');
    hl.className = 'timeline-bar-handle timeline-bar-handle--left';
    hl.title = '左端をドラッグして開始を変更';
    hl.addEventListener('pointerdown', (e) => {
      e.stopPropagation(); // 本体ドラッグへ伝播させない
      this._startBarDrag(e, task.id, 'left');
    });
    bar.appendChild(hl);

    // バーのラベル
    const label = document.createElement('span');
    label.className = 'timeline-bar-label';
    label.textContent = task.label;
    bar.appendChild(label);

    // 右ハンドル（span を右へ伸縮）
    const hr = document.createElement('div');
    hr.className = 'timeline-bar-handle timeline-bar-handle--right';
    hr.title = '右端をドラッグして期間を変更';
    hr.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this._startBarDrag(e, task.id, 'right');
    });
    bar.appendChild(hr);

    // クリックで選択
    bar.addEventListener('click', (e) => {
      e.stopPropagation();
      this._selectTask(task.id);
    });
    // 本体ドラッグ（start 移動）
    bar.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this._startBarDrag(e, task.id, 'move');
    });
    // 移動・終了はキャプチャした本体が受け取る
    bar.addEventListener('pointermove', (e) => this._onBarDragMove(e));
    bar.addEventListener('pointerup', (e) => this._onBarDragEnd(e));
    bar.addEventListener('pointercancel', (e) => this._onBarDragEnd(e));

    return bar;
  }

  /** バーの grid-column を貼り替える */
  _applyBarColumn(bar, start, span) {
    bar.style.gridColumn = `${start + 2} / span ${span}`;
  }

  // ─────────────────────────────────────────
  // バーのドラッグ（列デルタ計算。ここだけ実測が要る）
  // ─────────────────────────────────────────

  /**
   * ドラッグ開始。基準値（列幅・起点X・起点start/span）をここで1回だけ
   * スナップショット固定する。move 中は測り直さない
   * （grid-column貼り替えでレイアウトが動くと累積ズレになるため）。
   * @param {PointerEvent} e
   * @param {string} taskId
   * @param {"move"|"left"|"right"} mode
   */
  _startBarDrag(e, taskId, mode) {
    e.preventDefault();
    this._selectTask(taskId);

    const bar = this._getBarEl(taskId);
    if (!bar) return;
    bar.setPointerCapture(e.pointerId);
    bar.classList.add('is-dragging');

    const task = this._getTask(taskId);
    this.barDrag = {
      taskId,
      pointerId: e.pointerId,
      mode,
      startX: e.clientX,
      // 列幅の基準は「目盛りセルの実測幅」（行見出し列=stickyは幅が違うので使わない）
      colW: this._measureColumnWidth(),
      origStart: task.start,
      origSpan: task.span,
      curStart: task.start,
      curSpan: task.span,
    };
  }

  _onBarDragMove(e) {
    if (!this.barDrag || e.pointerId !== this.barDrag.pointerId) return;
    const bar = this._getBarEl(this.barDrag.taskId);
    if (!bar) return;

    const N = this.config.scale.length;
    const { mode, startX, colW, origStart, origSpan } = this.barDrag;
    // 固定した基準で列デルタを整数丸め
    const delta = colW > 0 ? Math.round((e.clientX - startX) / colW) : 0;

    let s = origStart;
    let sp = origSpan;
    if (mode === 'move') {
      // 本体移動：span固定で start を 0〜(列数-span) にクランプ
      s = this._clampVal(origStart + delta, 0, N - origSpan);
      sp = origSpan;
    } else if (mode === 'left') {
      // 左ハンドル：start を動かし span を逆算（span≥1・start≥0）
      s = this._clampVal(origStart + delta, 0, origStart + origSpan - 1);
      sp = origStart + origSpan - s;
    } else if (mode === 'right') {
      // 右ハンドル：start固定で span を 1〜(列数-start) にクランプ
      s = origStart;
      sp = this._clampVal(origSpan + delta, 1, N - origStart);
    }

    this.barDrag.curStart = s;
    this.barDrag.curSpan = sp;
    // プレビュー（grid-column を仮更新）
    this._applyBarColumn(bar, s, sp);
  }

  _onBarDragEnd(e) {
    if (!this.barDrag || e.pointerId !== this.barDrag.pointerId) return;
    const bar = this._getBarEl(this.barDrag.taskId);
    const task = this._getTask(this.barDrag.taskId);

    // config反映と最終クランプ・スナップ（整数列に吸着）
    if (task) {
      const { start, span } = this._clampTask(this.barDrag.curStart, this.barDrag.curSpan);
      task.start = start;
      task.span = span;
      if (bar) this._applyBarColumn(bar, start, span);
    }
    if (bar) {
      bar.classList.remove('is-dragging');
      try { bar.releasePointerCapture(e.pointerId); } catch (_) {}
    }
    this.barDrag = null;
  }

  /** 目盛りセル1つの実測幅（列スナップの基準） */
  _measureColumnWidth() {
    const cell = this._gridEl ? this._gridEl.querySelector('.timeline-scale-cell') : null;
    return cell ? cell.getBoundingClientRect().width : 80;
  }

  // ─────────────────────────────────────────
  // タスク操作
  // ─────────────────────────────────────────

  /** タスク行を追加（afterId の直後／なければ末尾）。追加直後にラベル編集へ */
  addTask(afterId) {
    const N = this.config.scale.length;
    const task = { id: this._genId(), label: '新しいタスク', start: 0, span: Math.min(1, N) || 1 };
    if (afterId) {
      const idx = this._indexOf(afterId);
      this.config.tasks.splice(idx + 1, 0, task);
    } else {
      this.config.tasks.push(task);
    }
    this.render();
    this.editTaskLabel(task.id);
  }

  /** タスク行を削除 */
  deleteTask(taskId) {
    const idx = this._indexOf(taskId);
    if (idx < 0) return;
    this.config.tasks.splice(idx, 1);
    this.selectedTaskId = null;
    this._updateDeleteBtnState();
    this.render();
  }

  /** タスク行を上下入れ替え（端では止める） */
  moveTask(taskId, dir) {
    const idx = this._indexOf(taskId);
    if (idx < 0) return;
    const j = idx + dir;
    if (j < 0 || j >= this.config.tasks.length) return;
    const tasks = this.config.tasks;
    [tasks[idx], tasks[j]] = [tasks[j], tasks[idx]];
    this.render(); // selectedTaskId は維持され、render で選択枠も復元される
  }

  /** 行見出し（タスク名）をインライン編集 */
  editTaskLabel(taskId) {
    const task = this._getTask(taskId);
    const rh = this._getRowheadEl(taskId);
    if (!task || !rh) return;
    const labelEl = rh.querySelector('.timeline-rowhead-label');
    this._editInline(labelEl, rh, (text) => {
      task.label = text || '（タスク名）';
      labelEl.textContent = task.label;
      // バー内のラベルも更新
      const bar = this._getBarEl(taskId);
      if (bar) {
        const bl = bar.querySelector('.timeline-bar-label');
        if (bl) bl.textContent = task.label;
      }
    });
  }

  /** 目盛りラベルをインライン編集 */
  editScaleLabel(index) {
    const cell = this._gridEl.querySelector(`.timeline-scale-cell[data-index="${index}"]`);
    if (!cell) return;
    const labelEl = cell.querySelector('.timeline-scale-label');
    if (!labelEl) return;
    this._editInline(labelEl, cell, (text) => {
      this.config.scale[index] = text || '（目盛り）';
      labelEl.textContent = this.config.scale[index];
    });
  }

  /**
   * 期間（列）を末尾に1つ追加し、追加した目盛りを編集モードへ。
   * 既存タスクの start/span は変更しない（新列は空きとして増えるだけ）。
   * タスク選択とは独立した操作（削除ボタンのdisabled連動には絡めない）。
   */
  addScale() {
    this.config.scale.push('新しい期間');
    const newIndex = this.config.scale.length - 1;
    this.render();
    this.editScaleLabel(newIndex);
  }

  /**
   * 指定列を削除する。最低1列は残す。
   * 削除後、新しい列数を基準に全タスクの start/span を再クランプする。
   * @param {number} index - 削除する列インデックス
   */
  deleteScale(index) {
    if (this.config.scale.length <= 1) {
      this._showToast('期間は最低1つ必要です');
      return;
    }
    const k = index;
    this.config.scale.splice(k, 1); // 先に削除（以降は新しい列数で再クランプ）

    this.config.tasks.forEach(t => {
      const last = t.start + t.span - 1; // 削除前の占有最終列
      if (k < t.start) {
        // 削除列がバーより左：バーが1列左へ詰まる（span不変）
        t.start -= 1;
      } else if (k <= last) {
        // 削除列がバーの占有範囲内：その列を1つ失う
        t.span -= 1;
        if (t.span < 1) t.span = 1; // span<1 になったら1に留める
      }
      // k > last：変更なし

      // 新しい列数で共通クランプ（start∈[0,列数-1]・span∈[1,列数-start]）。
      // _clampTask は this.config.scale.length（=削除後の列数）を参照する。
      const c = this._clampTask(t.start, t.span);
      t.start = c.start;
      t.span = c.span;
    });

    this.render();
  }

  /**
   * インライン編集の共通処理（Enter確定・blur終了・IMEガード）
   * @param {HTMLElement} editEl - contenteditable にする要素
   * @param {HTMLElement} markEl - is-editing を付ける要素
   * @param {(text:string)=>void} commit - 確定時のコールバック（trim済みテキスト）
   */
  _editInline(editEl, markEl, commit) {
    editEl.contentEditable = 'true';
    markEl.classList.add('is-editing');
    editEl.focus();

    const range = document.createRange();
    range.selectNodeContents(editEl);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    const finish = () => {
      editEl.contentEditable = 'false';
      markEl.classList.remove('is-editing');
      commit(editEl.textContent.trim());
    };

    editEl.addEventListener('blur', finish, { once: true });
    editEl.addEventListener('keydown', (e) => {
      // Enter確定。IME変換確定のEnterで誤確定しないよう e.isComposing でガード。
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        editEl.blur();
      }
    });
  }

  /** ツールバーの削除ボタンから呼ばれる（選択タスクを削除） */
  _deleteSelected() {
    if (!this.selectedTaskId) {
      this._showToast('削除するタスクを選択してください');
      return;
    }
    this.deleteTask(this.selectedTaskId);
  }

  // ─────────────────────────────────────────
  // 選択
  // ─────────────────────────────────────────

  _selectTask(id) {
    if (this.selectedTaskId === id) return;
    this._clearSelectionUI();
    this.selectedTaskId = id;
    const bar = this._getBarEl(id);
    if (bar) bar.classList.add('is-selected');
    const rh = this._getRowheadEl(id);
    if (rh) rh.classList.add('is-selected');
    this._updateDeleteBtnState();
  }

  _deselectTask() {
    if (!this.selectedTaskId) return;
    this._clearSelectionUI();
    this.selectedTaskId = null;
    this._updateDeleteBtnState();
  }

  _clearSelectionUI() {
    if (!this.selectedTaskId) return;
    const bar = this._getBarEl(this.selectedTaskId);
    if (bar) bar.classList.remove('is-selected');
    const rh = this._getRowheadEl(this.selectedTaskId);
    if (rh) rh.classList.remove('is-selected');
  }

  _updateDeleteBtnState() {
    if (this._deleteBtn) {
      this._deleteBtn.disabled = !this.selectedTaskId;
    }
  }

  // ─────────────────────────────────────────
  // グローバルイベント（init で1回だけ登録）
  // ─────────────────────────────────────────

  _bindGlobalEvents() {
    document.addEventListener('keydown', (e) => {
      // 削除トリガーは Delete キーのみ（Backspace は誤削除防止のため除外）
      if (e.key === 'Delete' && this.selectedTaskId) {
        const active = document.activeElement;
        if (active && (active.contentEditable === 'true' || active.tagName === 'INPUT')) return;
        this.deleteTask(this.selectedTaskId);
      }
      if (e.key === 'Escape') {
        this._deselectTask();
      }
    });

    // タイムライン外クリックで選択解除（バー・行見出しの外）
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.timeline-bar') && !e.target.closest('.timeline-rowhead')) {
        this._deselectTask();
      }
    });

    // ※ バーは grid-column 配置でレスポンシブに追従するため resize 時の再計算は不要。
    //   ドラッグの基準列幅は pointerdown ごとに測り直すので resize 後も常に最新。
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
    this.selectedTaskId = null;
    this.render();
  }

  exportJSON() {
    exportAsJSON(this.config.id, this.config);
  }

  // ─────────────────────────────────────────
  // ユーティリティ
  // ─────────────────────────────────────────

  /** start/span を有効範囲にクランプ（start≥0・span≥1・start+span≤列数） */
  _clampTask(start, span) {
    const N = this.config.scale.length;
    let sp = Math.max(1, Math.min(span, N));
    let s = Math.max(0, Math.min(start, N - sp));
    return { start: s, span: sp };
  }

  _clampVal(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  _getBarEl(id) {
    return this._gridEl ? this._gridEl.querySelector('.timeline-bar[data-id="' + id + '"]') : null;
  }

  _getRowheadEl(id) {
    return this._gridEl ? this._gridEl.querySelector('.timeline-rowhead[data-id="' + id + '"]') : null;
  }

  _getTask(id) {
    return this.config.tasks.find(t => t.id === id) || null;
  }

  _indexOf(id) {
    return this.config.tasks.findIndex(t => t.id === id);
  }

  _genId() {
    return 't_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
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
    btn.className = 'timeline-mini-btn';
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
