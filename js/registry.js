/**
 * registry.js - type → エンジンクラスの対応表
 *
 * frameworks.json の各エントリは type を持つ。
 * REGISTRY[entry.type] で対応するエンジンクラスを引き、
 *   new REGISTRY[entry.type](container, entry); engine.init();
 * の形で描画する。
 *
 * 各エンジンクラス（MatrixEngine 等）は js/engines/*.js が
 * グローバルに定義済みであることを前提とする（先に読み込むこと）。
 */
const REGISTRY = {
  matrix: MatrixEngine,
  tree: TreeEngine,
  flow: FlowEngine,
  sheet: SheetEngine,
  venn: VennEngine,
  timeline: TimelineEngine,
};
