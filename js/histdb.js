// =============================================================
// histdb.js — 長歷史資料的本地儲存(IndexedDB)
// -------------------------------------------------------------
// 為什麼不用 localStorage:44 檔 × 16 年日線 ≈ 幾 MB~十幾 MB,
// localStorage 上限約 5MB 會爆。IndexedDB 裝得下。
//
// 只給「回測」用,跟日常即時資料(localStorage 那套)完全分開。
// =============================================================

const DB_NAME = 'signaldesk_hist';
const STORE = 'bars';       // key = symbol, value = [{d,o,h,l,c}, ...]
const META_KEY = '__meta__';
const VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function putBars(symbol, bars) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(bars, symbol);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

export async function getBars(symbol) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readonly');
    const rq = tx.objectStore(STORE).get(symbol);
    rq.onsuccess = () => res(rq.result || null);
    rq.onerror = () => rej(rq.error);
  });
}

export async function putMeta(meta) { return putBars(META_KEY, meta); }
export async function getMeta() { return getBars(META_KEY); }

export async function clearAll() {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
