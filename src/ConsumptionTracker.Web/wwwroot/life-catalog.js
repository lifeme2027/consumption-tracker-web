/* 商品库查询（可选，只读）：把扫到的条码用 POST /api/catalog/lookup 发给本站服务器，换回名称/分类/参考售价。
 * 隐私：只有条码这一个字段会发出（不含任何记录、不带 Cookie：credentials 'omit'）；服务器不记录、不保存条码；
 * 条码放在请求体而不是网址里，所以也不会出现在 IIS 访问日志的网址中。
 * 开关（默认开启）存在 localStorage 的 life.catalog：'off' 时本模块不发任何请求。
 * 失败、超时、商品库未配置、未命中一律静默当作「没有」，不影响原有的本地历史记忆与手动填写。
 * 纯函数 merge() 决定如何与本地历史记忆合并（测试在 scripts/js-tests/catalog.test.js）。 */
(function (root) {
  'use strict';
  var KEY = 'life.catalog';
  var TIMEOUT_MS = 3000;
  var MAX_NAME = 100, MAX_CATEGORY = 30;     // 与 shared-vectors/limits.json / life-local.js 一致

  function store() { try { return root.localStorage || null; } catch (e) { return null; } }
  /** 默认开启：只有明确存成 'off' 才关闭。读不到存储（隐私模式）时按默认开启。 */
  function isEnabled(st) {
    st = st === undefined ? store() : st;
    try { return !st || st.getItem(KEY) !== 'off'; } catch (e) { return true; }
  }
  function setEnabled(on, st) {
    st = st === undefined ? store() : st;
    try { if (st) st.setItem(KEY, on ? 'on' : 'off'); } catch (e) { /* 隐私模式下忽略，仅本页有效 */ }
    return !!on;
  }

  function cut(s, n) { s = typeof s === 'string' ? s.trim() : ''; return Array.from(s).slice(0, n).join(''); }

  /** 把服务端响应整理成命中结果；不是有效命中返回 null。 */
  function normalize(j) {
    if (!j || j.available !== true || j.found !== true) return null;
    var name = cut(j.name, MAX_NAME);
    if (!name) return null;
    var price = (typeof j.salePriceCents === 'number' && isFinite(j.salePriceCents) && j.salePriceCents >= 0 && Math.floor(j.salePriceCents) === j.salePriceCents) ? j.salePriceCents : null;
    return { name: name, category: cut(j.category, MAX_CATEGORY), unit: cut(j.unit, 20), spec: cut(j.spec, 60), salePriceCents: price };
  }

  /** 查询商品库。永不 reject：返回命中结果或 null。opts: {fetch, timeoutMs, storage}。开关关闭时不发请求。 */
  function query(code, opts) {
    opts = opts || {};
    if (!isEnabled(opts.storage)) return Promise.resolve(null);
    var f = opts.fetch || (root.fetch ? function () { return root.fetch.apply(root, arguments); } : null);
    if (!f || !code) return Promise.resolve(null);
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = null;
    var timeout = new Promise(function (resolve) { timer = setTimeout(function () { if (ctl) ctl.abort(); resolve(null); }, opts.timeoutMs || TIMEOUT_MS); });
    var call = Promise.resolve().then(function () {
      return f('/api/catalog/lookup', {
        method: 'POST', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
        headers: { 'X-Requested-With': 'life-web', 'Content-Type': 'application/json' },
        body: JSON.stringify({ barcode: code }), signal: ctl ? ctl.signal : undefined,
      });
    }).then(function (res) { return res && res.ok ? res.json() : null; }).then(normalize).catch(function () { return null; });
    return Promise.race([call, timeout]).then(function (r) { clearTimeout(timer); return r; });
  }

  /**
   * 合并商品库命中与本地历史记忆（mem 为 store.lookup 的结果，可为 null）。
   * 规则：名称、分类取商品库（分类为空则退回历史分类）；价格「本地历史价优先，否则商品库参考售价，都没有则不动」。
   * 返回 {name, category, priceCents, source:'catalog'|'memory'|'none', priceFrom:'memory'|'catalog'|'none'}。
   */
  function merge(hit, mem) {
    var m = mem && mem.found ? mem : null;
    if (!hit) {
      if (!m) return { name: '', category: '', priceCents: null, source: 'none', priceFrom: 'none' };
      return { name: m.name, category: m.category || '', priceCents: m.lastPriceCents == null ? null : m.lastPriceCents, source: 'memory', priceFrom: m.lastPriceCents == null ? 'none' : 'memory' };
    }
    var memPrice = m && m.lastPriceCents != null ? m.lastPriceCents : null;
    return {
      name: hit.name,
      category: hit.category || (m && m.category) || '',
      priceCents: memPrice != null ? memPrice : hit.salePriceCents,
      source: 'catalog',
      priceFrom: memPrice != null ? 'memory' : (hit.salePriceCents != null ? 'catalog' : 'none'),
    };
  }

  var api = { KEY: KEY, TIMEOUT_MS: TIMEOUT_MS, MAX_CATEGORY: MAX_CATEGORY, isEnabled: isEnabled, setEnabled: setEnabled, normalize: normalize, query: query, merge: merge };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.LifeCatalog = api;
})(typeof window !== 'undefined' ? window : globalThis);
