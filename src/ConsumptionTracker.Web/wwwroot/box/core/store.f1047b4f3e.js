// 本地存储层：只有 IndexedDB（浏览器内），没有任何网络调用。
//   IdbStore    —— 真实的 IndexedDB 封装（构造时可注入 indexedDB 工厂，测试用 fake-indexeddb）
//   MemoryStore —— 同接口的内存实现（IndexedDB 不可用，如部分隐私模式时降级；此时界面会提示"不会保存"）
// 测量记录见 measurement.js；设置是 key → JSON 值。

const DB_NAME = 'scalebridge';
const DB_VERSION = 1;
const M_STORE = 'measurements';
const S_STORE = 'settings';

export const DEFAULT_SETTINGS = Object.freeze({
  displayUnit: 'kg', // 'kg' | 'lb'
  lang: 'auto', // 'auto' | 'zh' | 'en'
  userNotes: {}, // { "<设备用户编号 0-254>": "备注" }——只是本机备注，不会写入设备
});

/** 把从存储里读出来的设置规整成已知形状（被篡改或旧版本的值不会让界面崩溃）。 */
export function sanitizeSettings(raw) {
  const out = structuredClone(DEFAULT_SETTINGS);
  const r = raw && typeof raw === 'object' ? raw : {};
  if (r.displayUnit === 'kg' || r.displayUnit === 'lb') out.displayUnit = r.displayUnit;
  if (r.lang === 'auto' || r.lang === 'zh' || r.lang === 'en') out.lang = r.lang;
  if (r.userNotes && typeof r.userNotes === 'object' && !Array.isArray(r.userNotes)) {
    for (const [k, v] of Object.entries(r.userNotes)) {
      if (/^(0|[1-9]\d{0,2})$/.test(k) && Number(k) <= 254 && typeof v === 'string' && v.length > 0 && v.length <= 40) out.userNotes[k] = v;
    }
  }
  return out;
}

const req = (r) => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});
const txDone = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error ?? new Error('aborted'));
});

export class IdbStore {
  persistent = true;

  constructor(factory = globalThis.indexedDB) {
    this.factory = factory;
    this.db = null;
  }

  async open() {
    if (this.db) return this;
    if (!this.factory) throw new Error('indexedDB unavailable');
    const openReq = this.factory.open(DB_NAME, DB_VERSION);
    openReq.onupgradeneeded = () => {
      const db = openReq.result;
      if (!db.objectStoreNames.contains(M_STORE)) db.createObjectStore(M_STORE, { keyPath: 'id', autoIncrement: true });
      if (!db.objectStoreNames.contains(S_STORE)) db.createObjectStore(S_STORE, { keyPath: 'key' });
    };
    this.db = await req(openReq);
    this.db.onversionchange = () => this.db.close();
    return this;
  }

  close() {
    if (this.db) this.db.close();
    this.db = null;
  }

  /** 追加记录，返回带自增 id 的记录。全部成功或全部失败（单个事务）。 */
  async add(records) {
    const tx = this.db.transaction(M_STORE, 'readwrite');
    const store = tx.objectStore(M_STORE);
    const done = txDone(tx);
    done.catch(() => {}); // 失败时由下面的 throw 报告，避免未处理的拒绝
    const stored = [];
    try {
      for (const r of records) {
        const copy = { ...r };
        delete copy.id;
        const id = await req(store.add(copy));
        stored.push({ ...copy, id });
      }
    } catch (e) {
      try { tx.abort(); } catch { /* 事务已结束 */ }
      throw e;
    }
    await done;
    return stored;
  }

  async all() {
    return req(this.db.transaction(M_STORE).objectStore(M_STORE).getAll());
  }

  async count() {
    return req(this.db.transaction(M_STORE).objectStore(M_STORE).count());
  }

  async remove(id) {
    const tx = this.db.transaction(M_STORE, 'readwrite');
    tx.objectStore(M_STORE).delete(id);
    await txDone(tx);
  }

  async removeDemo() {
    const tx = this.db.transaction(M_STORE, 'readwrite');
    const store = tx.objectStore(M_STORE);
    const all = await req(store.getAll());
    let n = 0;
    for (const r of all) if (r.demo) { store.delete(r.id); n++; }
    await txDone(tx);
    return n;
  }

  async clearMeasurements() {
    const tx = this.db.transaction(M_STORE, 'readwrite');
    tx.objectStore(M_STORE).clear();
    await txDone(tx);
  }

  async getSettings() {
    const rows = await req(this.db.transaction(S_STORE).objectStore(S_STORE).getAll());
    const raw = {};
    for (const { key, value } of rows) if (key in DEFAULT_SETTINGS) raw[key] = value;
    return sanitizeSettings(raw);
  }

  async setSetting(key, value) {
    if (!(key in DEFAULT_SETTINGS)) throw new RangeError('unknown setting ' + key);
    const tx = this.db.transaction(S_STORE, 'readwrite');
    tx.objectStore(S_STORE).put({ key, value });
    await txDone(tx);
  }
}

export class MemoryStore {
  persistent = false;

  constructor() {
    this.rows = [];
    this.nextId = 1;
    this.settings = structuredClone(DEFAULT_SETTINGS);
  }

  async open() { return this; }
  close() {}

  async add(records) {
    const stored = records.map((r) => ({ ...r, id: this.nextId++ }));
    this.rows.push(...stored);
    return stored.map((r) => ({ ...r }));
  }

  async all() { return this.rows.map((r) => ({ ...r })); }
  async count() { return this.rows.length; }
  async remove(id) { this.rows = this.rows.filter((r) => r.id !== id); }
  async removeDemo() {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !r.demo);
    return before - this.rows.length;
  }
  async clearMeasurements() { this.rows = []; }
  async getSettings() { return sanitizeSettings(this.settings); }
  async setSetting(key, value) {
    if (!(key in DEFAULT_SETTINGS)) throw new RangeError('unknown setting ' + key);
    this.settings[key] = structuredClone(value);
  }
}

/** 打开存储：优先 IndexedDB，失败则降级为内存（persistent=false）。 */
export async function openStore(factory = globalThis.indexedDB) {
  try {
    return await new IdbStore(factory).open();
  } catch {
    return new MemoryStore();
  }
}
