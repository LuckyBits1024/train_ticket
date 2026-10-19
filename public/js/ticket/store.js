/** 本地存储：草稿/行程/乘客/车次历史/免责声明 + IndexedDB 自定义背面图。 */

const PREFIX = 'train-ticket:';
export const KEYS = {
  draft: `${PREFIX}draft:v1`,
  trips: `${PREFIX}trips:v1`,
  passengers: `${PREFIX}passengers:v1`,
  history: `${PREFIX}train-history:v1`,
  disclaimer: `${PREFIX}disclaimer:v1`,
  settings: `${PREFIX}settings:v1`,
};

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const value = JSON.parse(raw);
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function loadDraft() {
  return readJson(KEYS.draft, null);
}
export function saveDraft(draft) {
  return writeJson(KEYS.draft, draft);
}
export function clearDraft() {
  try {
    localStorage.removeItem(KEYS.draft);
  } catch {
    /* ignore */
  }
}

export function loadTrips() {
  const value = readJson(KEYS.trips, []);
  return Array.isArray(value) ? value : [];
}
export function saveTrips(trips) {
  return writeJson(KEYS.trips, trips);
}

export function loadPassengers() {
  const value = readJson(KEYS.passengers, []);
  return Array.isArray(value) ? value : [];
}
export function savePassengers(list) {
  return writeJson(KEYS.passengers, list);
}

export function loadHistory() {
  const value = readJson(KEYS.history, []);
  return Array.isArray(value) ? value : [];
}
export function pushHistory(trainNo) {
  const value = String(trainNo || '').trim().toUpperCase();
  if (!value) return loadHistory();
  const list = loadHistory().filter((item) => item !== value);
  list.unshift(value);
  const trimmed = list.slice(0, 12);
  writeJson(KEYS.history, trimmed);
  return trimmed;
}

export function loadSettings() {
  return readJson(KEYS.settings, { disclaimerVersion: 0 });
}
export function saveSettings(settings) {
  return writeJson(KEYS.settings, { ...loadSettings(), ...settings });
}
export function hasAcceptedDisclaimer(version = 1) {
  const settings = loadSettings();
  return Number(settings.disclaimerVersion) >= version;
}
export function acceptDisclaimer(version = 1) {
  saveSettings({ disclaimerVersion: version });
}

/* ---------------- IndexedDB：自定义背面图 ---------------- */

const DB_NAME = `${PREFIX}assets`;
const STORE_NAME = 'images';
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('当前浏览器不支持 IndexedDB'));
      return;
    }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB 打开失败'));
  });
  return dbPromise;
}

export async function putImage(id, blob) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(blob, id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error || new Error('图片保存失败'));
  });
}

export async function getImage(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error('图片读取失败'));
  });
}

export async function deleteImage(id) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error || new Error('图片删除失败'));
  });
}
