/* 本地存储（默认模式）：数据只存在本浏览器的 IndexedDB，本文件不含任何网络调用（fetch/XHR），测试里有静态检查。
 * 校验、限额、CSV/JSON 导入导出、统计与服务端 Core 同一规则（shared-vectors/*.json 在 CI 里校验）。
 * 与云端实现（life-remote.js）共用同一套接口，UI 不关心当前是哪一种：
 *   meta() lookup(barcode) add(body) update(id, body) remove(ids) restore(records) query(q) stats(month, day)
 *   duplicates(barcode, date, excludeId) assignBatch(ids, name) exportJson() exportCsv() importText(text, mode) wipe()
 */
(function (root) {
  'use strict';
  var Money = (typeof require === 'function' && typeof module !== 'undefined') ? require('./money.js') : root.LifeMoney;

  // 统一上限（三端同一组值，见 shared-vectors/limits.json；category/id 为网站额外上限）
  var LIMITS = {
    name: 100, note: 1000, barcode: 64, batch: 60, patient: 40, dosage: 60,
    quantityMax: 1000000, quantityDecimals: 6, priceCentsMax: 100000000000,
    category: 30, id: 64, maxRecords: 50000,
  };
  var UNCAT = '未分类';
  var DEFAULT_CATEGORIES = ['药品', '食品', '饮料', '日用', '餐饮', '交通', '服饰', '数码', '医疗', '娱乐', '其他'];
  var QTY_HINT = '数量无效（需大于 0，最多 6 位小数，不超过 1000000）';
  var PRICE_HINT = '价格无效（需为不小于 0 的数字，小数请用小数点，如 12.50）';

  // ---------- 小工具 ----------
  /** 带英文消息的错误：message 为中文（默认界面语言），messageEn 供英文界面使用。 */
  function err(zh, en) { var e = new Error(zh); e.messageEn = en; return e; }
  function str(v) { return v == null ? '' : (typeof v === 'string' ? v : String(v)); }
  function pad(n) { return String(n).padStart(2, '0'); }
  function newId() {
    var c = root.crypto;
    if (c && c.randomUUID) return c.randomUUID();
    var b = new Uint8Array(16);
    if (c && c.getRandomValues) c.getRandomValues(b); else for (var i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    var h = Array.prototype.map.call(b, function (x) { return pad(x.toString(16)); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }
  function isValidDate(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
    if (!m) return false;
    var y = +m[1], mo = +m[2], d = +m[3];
    if (y < 1) return false;
    var dt = new Date(0); dt.setUTCFullYear(y, mo - 1, d);
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
  }
  function monthRange(month) {
    var y = +month.slice(0, 4), m = +month.slice(5, 7);
    var last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return [month + '-01', month + '-' + pad(last)];
  }
  function today() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

  // 同步 SHA-256（仅用于 CSV 无 id 行的确定性 id，不依赖 crypto.subtle——它在非 HTTPS 页面不可用）
  function sha256hex(s) {
    var bytes = new TextEncoder().encode(s), H = [], K = [], pc = 0, isc = {}, c, i, j;
    for (c = 2; pc < 64; c++) if (!isc[c]) { for (i = 0; i < 313; i += c) isc[i] = c; H[pc] = (Math.pow(c, 0.5) * 4294967296) | 0; K[pc++] = (Math.pow(c, 1 / 3) * 4294967296) | 0; }
    var rotr = function (x, n) { return (x >>> n) | (x << (32 - n)); };
    var l = bytes.length, nw = (((l + 8) >> 6) + 1) * 16, w = new Array(nw).fill(0);
    for (i = 0; i < l; i++) w[i >> 2] |= bytes[i] << (24 - (i % 4) * 8);
    w[l >> 2] |= 0x80 << (24 - (l % 4) * 8);
    w[nw - 2] = Math.floor(l * 8 / 4294967296); w[nw - 1] = (l * 8) >>> 0;
    var h = H.slice(0, 8);
    for (j = 0; j < nw; j += 16) {
      var W = w.slice(j, j + 16);
      for (i = 16; i < 64; i++) {
        var w15 = W[i - 15], w2 = W[i - 2];
        W[i] = (W[i - 16] + (rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3)) + W[i - 7] + (rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10))) | 0;
      }
      var a = h[0], b = h[1], cc = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
      for (i = 0; i < 64; i++) {
        var t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + W[i]) | 0;
        var t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & cc) ^ (b & cc))) | 0;
        hh = g; g = f; f = e; e = (d + t1) | 0; d = cc; cc = b; b = a; a = (t1 + t2) | 0;
      }
      h = [(h[0] + a) | 0, (h[1] + b) | 0, (h[2] + cc) | 0, (h[3] + d) | 0, (h[4] + e) | 0, (h[5] + f) | 0, (h[6] + g) | 0, (h[7] + hh) | 0];
    }
    return h.map(function (v) { return (v >>> 0).toString(16).padStart(8, '0'); }).join('');
  }

  // ---------- 记录校验（与 Core RecordValidator.Sanitize + RecordLimits.Check 一致） ----------
  /** raw: {id,barcode,name,priceCents,quantity,category,note,batchId,batchName,patient,dosage,date,createdAt}
   *  返回 {record} 或 {error:'中文原因'}。不在原因里回显记录内容。 */
  function sanitize(raw) {
    if (!raw || typeof raw !== 'object') return { error: '记录内容无效' };
    var batchId = str(raw.batchId).trim();
    var r = {
      id: str(raw.id).trim() === '' ? newId() : str(raw.id),
      barcode: str(raw.barcode).trim(),
      name: str(raw.name).trim(),
      priceCents: raw.priceCents,
      quantity: raw.quantity,
      category: str(raw.category).trim() === '' ? UNCAT : str(raw.category).trim(),
      note: str(raw.note),
      batchId: batchId,
      batchName: batchId === '' ? '' : str(raw.batchName).trim(),
      patient: str(raw.patient).trim(),
      dosage: str(raw.dosage).trim(),
      date: str(raw.date).trim(),
      createdAt: Number.isFinite(Number(raw.createdAt)) && raw.createdAt !== null && raw.createdAt !== '' ? Math.trunc(Number(raw.createdAt)) : Date.now(),
    };
    var errs = [];
    if (r.name === '') errs.push('商品名不能为空');
    if (!Number.isInteger(r.priceCents)) errs.push(PRICE_HINT);
    else if (r.priceCents < 0) errs.push('价格不能为负数');
    if (typeof r.quantity !== 'number' || !Number.isFinite(r.quantity)) errs.push(QTY_HINT);
    else if (r.quantity <= 0) errs.push('数量必须大于 0');
    if (!isValidDate(r.date)) errs.push('日期格式应为 YYYY-MM-DD');
    if (errs.length) return { error: errs.join('；') };
    var lim = checkLimits(r);
    return lim ? { error: lim } : { record: r };
  }
  function checkLimits(r) {
    if (r.id.length > LIMITS.id) return '记录 ID 过长';
    if (r.barcode.length > LIMITS.barcode) return '编码过长（最多 ' + LIMITS.barcode + ' 字）';
    if (r.name.length > LIMITS.name) return '名称过长（最多 ' + LIMITS.name + ' 字）';
    if (r.category.length > LIMITS.category) return '分类过长';
    if (r.note.length > LIMITS.note) return '备注过长（最多 ' + LIMITS.note + ' 字）';
    if (r.batchName.length > LIMITS.batch) return '批次名过长（最多 ' + LIMITS.batch + ' 字）';
    if (r.patient.length > LIMITS.patient) return '用药人过长（最多 ' + LIMITS.patient + ' 字）';
    if (r.dosage.length > LIMITS.dosage) return '剂量/规格过长（最多 ' + LIMITS.dosage + ' 字）';
    if (r.priceCents > LIMITS.priceCentsMax) return '价格过大（最多 10 亿元）';
    if (r.quantity > LIMITS.quantityMax) return '数量过大（最多 ' + LIMITS.quantityMax + '）';
    var s = String(r.quantity), dot = s.indexOf('.');
    if (/e/i.test(s) || (dot >= 0 && s.length - dot - 1 > LIMITS.quantityDecimals)) return '数量最多 ' + LIMITS.quantityDecimals + ' 位小数';
    return null;
  }
  function amountOf(r) { return Money.amountCents(r.priceCents, String(r.quantity)); }
  function withAmount(r) { return Object.assign({}, r, { amountCents: amountOf(r) }); }

  // ---------- CSV（与 Core CsvService 一致） ----------
  var CSV_HEADER = ['日期', '条码/追溯码', '商品名', '分类', '单价', '数量', '金额', '批次/药方', '批次ID', '用药人', '剂量/规格', '备注'];
  function csvEscape(v) { return /[,"\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
  var TRIG = /^'*[=+\-@\t\r]/;
  function guardText(v) { return TRIG.test(v) ? "'" + v : v; }
  function unguardText(v) { return v.charAt(0) === "'" && TRIG.test(v.slice(1)) ? v.slice(1) : v; }
  function yuan(c) { return Math.floor(c / 100) + '.' + pad(c % 100); }
  function toCsv(records) {
    var sorted = records.slice().sort(function (a, b) { return cmp(a.date, b.date) || a.createdAt - b.createdAt; });
    var out = ['\uFEFF' + CSV_HEADER.map(csvEscape).join(',')];
    sorted.forEach(function (r) {
      out.push([guardText(r.date), guardText(r.barcode), guardText(r.name), guardText(r.category), yuan(r.priceCents), String(r.quantity), yuan(amountOf(r)),
        guardText(r.batchName), guardText(r.batchId), guardText(r.patient), guardText(r.dosage), guardText(r.note)].map(csvEscape).join(','));
    });
    return out.join('\r\n') + '\r\n';
  }
  function parseRows(text) {
    if (text.charAt(0) === '\uFEFF') text = text.slice(1);
    var rows = [], row = [], field = '', inQ = false, any = false;
    for (var i = 0; i < text.length; i++) {
      var c = text.charAt(i);
      if (inQ) {
        if (c === '"') { if (text.charAt(i + 1) === '"') { field += '"'; i++; } else inQ = false; } else field += c;
        continue;
      }
      if (c === '"') { inQ = true; any = true; }
      else if (c === ',') { row.push(field); field = ''; any = true; }
      else if (c === '\r' && text.charAt(i + 1) === '\n') { /* CRLF：由随后的 \n 结束本行 */ }
      else if (c === '\r' || c === '\n') {
        if (any || field.length) { row.push(field); rows.push(row); }
        row = []; field = ''; any = false;
      } else { field += c; any = true; }
    }
    if (any || field.length) { row.push(field); rows.push(row); }
    return rows;
  }

  // ---------- 导入解析（只解析，不写库） ----------
  /** 返回 {items:[{row,label,raw}], rejected:[{row,label,reason}], products:[]}。
   *  label：「第 N 条」（JSON）或「第 N 行」（CSV，表头为第 1 行）。解析失败（整个文件不可用）抛 Error（中文原因）。 */
  function parseImport(text) {
    var t = text.replace(/^[\uFEFF \t\r\n]+/, '');
    return t.charAt(0) === '{' ? parseJsonImport(text) : parseCsvImport(text);
  }
  function numberOf(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'string' && /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(v)) return Number(v);
    return null;
  }
  function parseJsonImport(text) {
    var obj;
    try { obj = JSON.parse(text.replace(/^\uFEFF/, '')); } catch (e) { throw err('文件不是有效的 JSON', 'The file is not valid JSON'); }
    if (!obj || typeof obj !== 'object' || obj.app !== 'consumption-tracker' || !Array.isArray(obj.records)) throw err('不是本应用导出的备份文件', 'This is not a backup file exported by this app');
    var items = [], rejected = [];
    obj.records.forEach(function (o, i) {
      var label = '第 ' + (i + 1) + ' 条';
      if (!o || typeof o !== 'object') { rejected.push({ row: i + 1, label: label, reason: '记录内容无效' }); return; }
      var cents = null, pc = numberOf(o.priceCents);
      if (pc !== null && pc >= 0) cents = Math.round(pc);
      else { var py = o.price, ps = typeof py === 'number' ? String(py) : typeof py === 'string' ? py : null; cents = ps === null ? null : Money.yuanToCents(ps); if (cents === null && pc !== null && pc < 0) cents = -1; }
      if (cents === null) { rejected.push({ row: i + 1, label: label, reason: PRICE_HINT }); return; }
      var q = numberOf(o.quantity);
      if (q === null) { rejected.push({ row: i + 1, label: label, reason: QTY_HINT }); return; }
      items.push({ row: i + 1, label: label, raw: Object.assign({}, o, { priceCents: cents, quantity: q }) });
    });
    var products = [];
    (Array.isArray(obj.products) ? obj.products : []).forEach(function (o) {
      if (!o || typeof o !== 'object') return;
      var barcode = str(o.barcode).trim(); if (!barcode) return;
      var last = null, lc = numberOf(o.lastPriceCents), ly = numberOf(o.lastPrice);
      if (lc !== null && lc >= 0) last = Math.round(lc); else if (ly !== null && ly >= 0) last = Math.round(ly * 100);
      var u = numberOf(o.updatedAt);
      products.push({ barcode: barcode, name: str(o.name).trim(), category: str(o.category).trim(), lastPriceCents: last, updatedAt: u === null ? Date.now() : u });
    });
    return { items: items, rejected: rejected, products: products };
  }
  function parseCsvImport(text) {
    var rows = parseRows(text);
    if (!rows.length) throw err('CSV 文件为空', 'The CSV file is empty');
    var header = rows[0].map(function (h) { return h.trim(); });
    var col = function () { var names = arguments; for (var i = 0; i < header.length; i++) if (Array.prototype.indexOf.call(names, header[i]) >= 0) return i; return -1; };
    var cDate = col('日期'), cName = col('商品名', '名称'), cPrice = col('单价', '价格'), cQty = col('数量');
    if (cDate < 0 || cName < 0 || cPrice < 0 || cQty < 0) throw err('CSV 表头缺少必需列：日期、商品名、单价、数量', 'The CSV header is missing required columns: date, name, price, quantity (日期, 商品名, 单价, 数量)');
    var cBarcode = col('条码/追溯码', '条码', '编码'), cCat = col('分类'), cBatchName = col('批次/药方', '批次名', '批次'),
      cBatchId = col('批次ID'), cPatient = col('用药人'), cDosage = col('剂量/规格', '剂量'), cNote = col('备注');
    var get = function (r, c) { return c >= 0 && c < r.length ? r[c] : ''; };
    var gt = function (r, c) { return unguardText(get(r, c)); };
    var items = [], rejected = [], seen = {};
    rows.slice(1).forEach(function (r, i) {
      var rowNo = i + 2, label = '第 ' + rowNo + ' 行';
      var cents = Money.yuanToCents(get(r, cPrice)), qty = Money.parseQty(get(r, cQty));
      if (cents === null) { rejected.push({ row: rowNo, label: label, reason: PRICE_HINT }); return; }
      if (qty === null) { rejected.push({ row: rowNo, label: label, reason: QTY_HINT }); return; }
      var batchName = gt(r, cBatchName).trim(), batchId = gt(r, cBatchId).trim();
      if (batchId === '' && batchName !== '') batchId = 'batch-' + sha256hex('batch|' + batchName).slice(0, 16);
      var raw = { id: '', barcode: gt(r, cBarcode), name: gt(r, cName), priceCents: cents, quantity: qty, category: gt(r, cCat), note: gt(r, cNote),
        batchId: batchId, batchName: batchName, patient: gt(r, cPatient), dosage: gt(r, cDosage), date: gt(r, cDate).trim() };
      // 先按 Sanitize 规则算出确定性 id（只与内容有关），随后统一预检
      var s = sanitize(Object.assign({}, raw, { id: 'x' }));
      if (s.record) {
        var k = [s.record.date, s.record.barcode, s.record.name, s.record.priceCents, s.record.quantity, s.record.category, s.record.batchId, s.record.patient, s.record.dosage, s.record.note].join('\u001f');
        seen[k] = Object.prototype.hasOwnProperty.call(seen, k) ? seen[k] + 1 : 0;
        raw.id = 'csv-' + sha256hex(k + '#' + seen[k]).slice(0, 32);
      } else raw.id = 'x';
      items.push({ row: rowNo, label: label, raw: raw });
    });
    return { items: items, rejected: rejected, products: [] };
  }
  /** 全量预检：对所有解析出的记录逐条校验。返回 {records, rejected:[{row,label,reason}]}（rejected 含解析阶段已拒绝的）。 */
  function precheck(parsed) {
    var records = [], rejected = parsed.rejected.slice();
    parsed.items.forEach(function (it) {
      var s = sanitize(it.raw);
      if (s.record) records.push(s.record); else rejected.push({ row: it.row, label: it.label, reason: s.error });
    });
    rejected.sort(function (a, b) { return a.row - b.row; });
    return { records: records, rejected: rejected };
  }

  // ---------- IndexedDB ----------
  function req(r) { return new Promise(function (res, rej) { r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); }; }); }
  function txDone(tx) { return new Promise(function (res, rej) { tx.oncomplete = function () { res(); }; tx.onerror = function () { rej(tx.error); }; tx.onabort = function () { rej(tx.error || new Error('事务已中止')); }; }); }

  function ImportRejected(rejected, total) {
    var e = err('导入已中止：' + rejected.length + ' 条记录不合格，未改动任何现有数据', 'Import aborted: ' + rejected.length + ' records are invalid; your existing data was not changed');
    e.name = 'ImportRejected'; e.rejected = rejected; e.total = total; return e;
  }

  function LocalStore(db) { this.db = db; this.kind = 'local'; }
  LocalStore.open = function (opts) {
    opts = opts || {};
    var factory = opts.indexedDB || root.indexedDB;
    if (!factory) return Promise.reject(new Error('此浏览器不支持本地存储（IndexedDB）'));
    var r = factory.open(opts.name || 'life-local', 1);
    r.onupgradeneeded = function () {
      var db = r.result;
      var rec = db.createObjectStore('records', { keyPath: 'id' });
      rec.createIndex('date', 'date'); rec.createIndex('barcode', 'barcode');
      db.createObjectStore('products', { keyPath: 'barcode' });
    };
    return req(r).then(function (db) { return new LocalStore(db); });
  };
  var P = LocalStore.prototype;
  P.close = function () { this.db.close(); };
  P._all = function () { return req(this.db.transaction('records').objectStore('records').getAll()); };
  P._products = function () { return req(this.db.transaction('products').objectStore('products').getAll()); };

  P.meta = function () {
    return this._all().then(function (all) {
      var cats = {}, batches = {};
      all.forEach(function (r) {
        cats[r.category] = 1;
        if (r.batchId) { var b = batches[r.batchId] || (batches[r.batchId] = { batchId: r.batchId, batchName: r.batchName, count: 0 }); b.count++; }
      });
      var extra = Object.keys(cats).sort(), list = DEFAULT_CATEGORIES.slice();
      extra.forEach(function (c) { if (list.indexOf(c) < 0) list.push(c); });
      var bl = Object.keys(batches).map(function (k) { return batches[k]; }).sort(function (a, b) { return a.batchName.localeCompare(b.batchName, 'zh'); });
      return { categories: list, batches: bl };
    });
  };

  P.lookup = function (barcode) {
    var b = str(barcode).trim();
    if (!b) return Promise.resolve({ found: false, name: '', category: '', lastPriceCents: null });
    return req(this.db.transaction('products').objectStore('products').get(b)).then(function (p) {
      return p ? { found: true, name: p.name, category: p.category, lastPriceCents: p.lastPriceCents == null ? null : p.lastPriceCents }
        : { found: false, name: '', category: '', lastPriceCents: null };
    });
  };

  function bodyToRaw(b) {
    if (!b) return null;
    return { barcode: b.barcode, name: b.name, priceCents: b.priceCents, quantity: b.quantity == null ? 1 : b.quantity, category: b.category, note: b.note,
      date: b.date, batchName: b.batchName, patient: b.patient, dosage: b.dosage };
  }
  function resolveBatch(all, name) {
    var n = str(name).trim();
    if (!n) return { batchId: '', batchName: '' };
    if (n.length > LIMITS.batch) return { error: '批次名过长（最多 ' + LIMITS.batch + ' 字）' };
    for (var i = 0; i < all.length; i++) if (all[i].batchName === n && all[i].batchId) return { batchId: all[i].batchId, batchName: n };
    return { batchId: newId(), batchName: n };
  }
  function rememberProduct(tx, r) {
    if (!r.barcode) return;
    tx.objectStore('products').put({ barcode: r.barcode, name: r.name, category: r.category, lastPriceCents: r.priceCents, updatedAt: Date.now() });
  }
  function fail(msg) { return Promise.reject(new Error(msg)); }

  P.add = function (body) {
    var self = this, raw = bodyToRaw(body);
    if (!raw) return fail('请求体为空');
    if (!Number.isInteger(raw.priceCents) || raw.priceCents < 0) return fail('价格不能为空或为负');
    return this._all().then(function (all) {
      if (all.length >= LIMITS.maxRecords) throw new Error('记录数已达上限（' + LIMITS.maxRecords + ' 条）');
      var b = resolveBatch(all, raw.batchName); if (b.error) throw new Error(b.error);
      var s = sanitize(Object.assign({}, raw, { id: newId(), createdAt: Date.now(), batchId: b.batchId, batchName: b.batchName }));
      if (!s.record) throw new Error(s.error);
      var tx = self.db.transaction(['records', 'products'], 'readwrite');
      tx.objectStore('records').put(s.record); rememberProduct(tx, s.record);
      return txDone(tx).then(function () { return withAmount(s.record); });
    });
  };
  P.update = function (id, body) {
    var self = this, raw = bodyToRaw(body);
    if (!raw) return fail('请求体为空');
    if (!Number.isInteger(raw.priceCents) || raw.priceCents < 0) return fail('价格不能为空或为负');
    return this._all().then(function (all) {
      var old = all.filter(function (r) { return r.id === id; })[0];
      if (!old) { var e = new Error('记录不存在'); e.status = 404; throw e; }
      var b = resolveBatch(all, raw.batchName); if (b.error) throw new Error(b.error);
      var s = sanitize(Object.assign({}, raw, { id: id, createdAt: old.createdAt, batchId: b.batchId, batchName: b.batchName }));
      if (!s.record) throw new Error(s.error);
      var tx = self.db.transaction(['records', 'products'], 'readwrite');
      tx.objectStore('records').put(s.record); rememberProduct(tx, s.record);
      return txDone(tx).then(function () { return withAmount(s.record); });
    });
  };
  P.remove = function (ids) {
    var tx = this.db.transaction('records', 'readwrite'), st = tx.objectStore('records'), n = 0;
    var uniq = ids.filter(function (x, i) { return ids.indexOf(x) === i; });
    return Promise.all(uniq.map(function (id) { return req(st.count(id)).then(function (c) { if (c) { n++; st.delete(id); } }); }))
      .then(function () { return txDone(tx); }).then(function () { return n; });
  };
  /** 撤销删除：按原样写回（含原 id、createdAt、批次）；逐条仍走同一套校验。 */
  P.restore = function (records) {
    var self = this, good = [];
    for (var i = 0; i < records.length; i++) {
      var s = sanitize(records[i]);
      if (!s.record) return fail(s.error);
      good.push(s.record);
    }
    var tx = this.db.transaction('records', 'readwrite');
    good.forEach(function (r) { tx.objectStore('records').put(r); });
    return txDone(tx).then(function () { return good.length; });
  };

  function matches(q, r) {
    if (q.from && cmp(r.date, q.from) < 0) return false;
    if (q.to && cmp(r.date, q.to) > 0) return false;
    if (q.category && r.category !== q.category) return false;
    if (q.batchId === '__none__') { if (r.batchId !== '') return false; }
    else if (q.batchId && r.batchId !== q.batchId) return false;
    var kw = q.keyword ? q.keyword.trim().toLowerCase() : '';
    if (kw) {
      var hay = [r.name, r.barcode, r.note, r.category, r.batchName, r.patient, r.dosage];
      if (!hay.some(function (s) { return s.toLowerCase().indexOf(kw) >= 0; })) return false;
    }
    return true;
  }
  function sortRecords(list) { return list.sort(function (a, b) { return cmp(b.date, a.date) || b.createdAt - a.createdAt || cmp(a.id, b.id); }); }
  P.query = function (q) {
    q = q || {};
    if ((q.keyword || '').length > 100) return fail('关键词过长');
    return this._all().then(function (all) {
      var rows = sortRecords(all.filter(function (r) { return matches(q, r); })).map(withAmount);
      return { records: rows, count: rows.length, totalCents: rows.reduce(function (s, r) { return s + r.amountCents; }, 0) };
    });
  };
  P.stats = function (month, day) {
    month = month || today().slice(0, 7); day = day || today();
    if (!/^\d{4}-\d{2}$/.test(month) || !isValidDate(month + '-01')) return fail('月份格式应为 YYYY-MM');
    if (!isValidDate(day)) return fail('日期格式应为 YYYY-MM-DD');
    var range = monthRange(month);
    return this._all().then(function (all) {
      var rows = all.filter(function (r) { return cmp(r.date, range[0]) >= 0 && cmp(r.date, range[1]) <= 0; }).map(withAmount);
      var dayRows = all.filter(function (r) { return r.date === day; }).map(withAmount);
      var sum = function (l) { return l.reduce(function (s, r) { return s + r.amountCents; }, 0); };
      var group = function (keyOf) { var m = {}; rows.forEach(function (r) { var k = keyOf(r), b = m[k] || (m[k] = { key: k, cents: 0, count: 0 }); b.cents += r.amountCents; b.count++; }); return Object.keys(m).map(function (k) { return m[k]; }); };
      var cats = group(function (r) { return r.category || UNCAT; }).sort(function (a, b) { return b.cents - a.cents || cmp(a.key, b.key); });
      var total = cats.reduce(function (s, b) { return s + b.cents; }, 0);
      return {
        month: month, monthTotalCents: sum(rows), monthCount: rows.length, day: day, dayTotalCents: sum(dayRows), dayCount: dayRows.length,
        categories: cats.map(function (b) { return { category: b.key, cents: b.cents, count: b.count, ratio: total > 0 ? b.cents / total : 0 }; }),
        days: group(function (r) { return r.date; }).sort(function (a, b) { return cmp(a.key, b.key); }).map(function (b) { return { date: b.key, cents: b.cents, count: b.count }; }),
      };
    });
  };
  P.duplicates = function (barcode, date, excludeId) {
    var code = str(barcode).trim();
    if (!code) return Promise.resolve([]);
    return this._all().then(function (all) { return all.filter(function (r) { return r.barcode === code && r.date === date && r.id !== excludeId; }).map(withAmount); });
  };
  P.assignBatch = function (ids, name) {
    var self = this;
    return this._all().then(function (all) {
      var b = resolveBatch(all, name); if (b.error) throw new Error(b.error);
      var set = {}; ids.forEach(function (i) { set[i] = 1; });
      var hit = all.filter(function (r) { return set[r.id]; });
      var tx = self.db.transaction('records', 'readwrite');
      hit.forEach(function (r) { tx.objectStore('records').put(Object.assign({}, r, { batchId: b.batchId, batchName: b.batchName })); });
      return txDone(tx).then(function () { return hit.length; });
    });
  };

  P.exportJson = function () {
    var self = this;
    return Promise.all([this._all(), this._products()]).then(function (v) {
      var recs = sortRecords(v[0]), prods = v[1].slice().sort(function (a, b) { return cmp(a.barcode, b.barcode); });
      return JSON.stringify({
        app: 'consumption-tracker', version: 2, exportedAt: new Date().toISOString(),
        records: recs.map(function (r) { return { id: r.id, barcode: r.barcode, name: r.name, price: r.priceCents / 100, priceCents: r.priceCents, quantity: r.quantity, category: r.category, note: r.note, batchId: r.batchId, batchName: r.batchName, patient: r.patient, dosage: r.dosage, date: r.date, createdAt: r.createdAt }; }),
        products: prods.map(function (p) { var o = { barcode: p.barcode, name: p.name, category: p.category, updatedAt: p.updatedAt }; if (p.lastPriceCents != null) { o.lastPrice = p.lastPriceCents / 100; o.lastPriceCents = p.lastPriceCents; } return o; }),
      }, null, 2);
    });
  };
  P.exportCsv = function () { return this._all().then(toCsv); };

  /** 导入。replace：先全量预检——有任何一条不合格就抛 ImportRejected，不动现有数据；通过后在同一事务里清空+写入。
   *  merge：合格的照常导入，返回被跳过的行号与原因（skippedRows）。 */
  P.importText = function (text, mode) {
    var self = this, parsed, pre;
    try { parsed = parseImport(text); pre = precheck(parsed); } catch (e) { return Promise.reject(e); }
    var total = parsed.items.length + parsed.rejected.length;
    if (mode === 'replace' && pre.rejected.length) return Promise.reject(ImportRejected(pre.rejected, total));
    return Promise.all([this._all(), this._products()]).then(function (v) {
      var existing = v[0], curProds = v[1];
      var ids = {}; existing.forEach(function (r) { ids[r.id] = 1; });
      var recs = pre.records, added = 0, updated = 0;
      if (mode === 'replace') { added = recs.length; }
      else {
        var seen = {};
        var newCount = recs.filter(function (r) { if (ids[r.id] || seen[r.id]) return false; seen[r.id] = 1; return true; }).length;
        if (existing.length + newCount > LIMITS.maxRecords) throw err('导入后记录数将超过上限（' + LIMITS.maxRecords + ' 条），已取消', 'The record count would exceed the limit of ' + LIMITS.maxRecords + ' after import; cancelled');
      }
      var tx = self.db.transaction(['records', 'products'], 'readwrite');
      var rs = tx.objectStore('records'), ps = tx.objectStore('products');
      if (mode === 'replace') { rs.clear(); ps.clear(); }
      var seen2 = {};
      recs.forEach(function (r) {
        if (mode !== 'replace') { if (ids[r.id] || seen2[r.id]) updated++; else added++; }
        seen2[r.id] = 1; rs.put(r);
      });
      {
        var cur = {}; curProds.forEach(function (p) { cur[p.barcode] = p; });
        var have = mode === 'replace' ? {} : cur;
        parsed.products.forEach(function (p) {
          if (p.barcode.length > LIMITS.barcode || p.name.length > LIMITS.name || p.category.length > LIMITS.category) return;
          var c = have[p.barcode]; if (!c || p.updatedAt >= c.updatedAt) { ps.put(p); have[p.barcode] = p; }
        });
        // 没有商品记忆的编码（如 CSV 导入）根据其最新一条记录补出
        var byCode = {};
        recs.forEach(function (r) { if (r.barcode) { var o = byCode[r.barcode]; if (!o || cmp(r.date, o.date) > 0 || (r.date === o.date && r.createdAt > o.createdAt)) byCode[r.barcode] = r; } });
        Object.keys(byCode).forEach(function (code) {
          if (have[code]) return;
          var l = byCode[code];
          ps.put({ barcode: code, name: l.name, category: l.category, lastPriceCents: l.priceCents, updatedAt: l.createdAt });
        });
      }
      return txDone(tx).then(function () { return { added: added, updated: updated, skipped: pre.rejected.length, skippedRows: pre.rejected }; });
    });
  };

  P.wipe = function () {
    var tx = this.db.transaction(['records', 'products'], 'readwrite'), n = 0;
    return req(tx.objectStore('records').count()).then(function (c) { n = c; tx.objectStore('records').clear(); tx.objectStore('products').clear(); return txDone(tx); }).then(function () { return n; });
  };

  var api = { LIMITS: LIMITS, LocalStore: LocalStore, sanitize: sanitize, parseImport: parseImport, precheck: precheck, toCsv: toCsv, parseRows: parseRows,
    guardText: guardText, unguardText: unguardText, isValidDate: isValidDate, sha256hex: sha256hex, DEFAULT_CATEGORIES: DEFAULT_CATEGORIES, newId: newId };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.LifeLocal = api;
})(typeof self !== 'undefined' ? self : this);
