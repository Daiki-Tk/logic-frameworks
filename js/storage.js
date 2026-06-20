/**
 * storage.js - localStorage 読み書き共通処理
 * 全エンジン（matrix.js, tree.js など）から共通で利用する
 */

const STORAGE_PREFIX = 'lf_';

/**
 * フレームワークの状態を localStorage に保存する
 * @param {string} id - フレームワークID（例: "urgent-important-matrix"）
 * @param {object} data - 保存するデータオブジェクト
 */
function saveFramework(id, data) {
  try {
    localStorage.setItem(STORAGE_PREFIX + id, JSON.stringify(data));
  } catch (e) {
    console.error('保存に失敗しました:', e);
  }
}

/**
 * フレームワークの保存データを localStorage から読み込む
 * @param {string} id - フレームワークID
 * @returns {object|null} 保存データ、存在しない場合は null
 */
function loadFramework(id) {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + id);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    console.error('読み込みに失敗しました:', e);
    return null;
  }
}

/**
 * 指定IDの保存データを localStorage から削除する
 * @param {string} id - フレームワークID
 */
function clearFramework(id) {
  localStorage.removeItem(STORAGE_PREFIX + id);
}

/**
 * 指定IDのデータを JSON ファイルとしてダウンロードする
 * @param {string} id - フレームワークID
 * @param {object} data - エクスポートするデータオブジェクト
 */
function exportAsJSON(id, data) {
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = id + '.json';
  a.click();

  // メモリ解放
  URL.revokeObjectURL(url);
}
