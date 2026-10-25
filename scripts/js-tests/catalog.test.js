// life-catalog.js：商品库查询开关、请求形状（POST 请求体、无 Cookie）、超时/失败静默、与本地历史记忆的合并规则。
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { WW } = require('./helpers');
const C = require(path.join(WW, 'life-catalog.js'));

const mem = (o = {}) => ({ getItem: (k) => (k in o ? o[k] : null), setItem: (k, v) => { o[k] = v; }, o });
const okRes = (j) => ({ ok: true, status: 200, json: async () => j });
const hitJson = { available: true, found: true, name: '合成饮料', category: '合成分类', unit: '瓶', spec: '500ml', salePriceCents: 350 };

test('开关：默认开启；只有明确存成 off 才关闭；setEnabled 往返；读不到存储时按默认开启', () => {
  assert.strictEqual(C.isEnabled(mem()), true);
  assert.strictEqual(C.isEnabled(null), true);
  const st = mem();
  C.setEnabled(false, st); assert.strictEqual(C.isEnabled(st), false); assert.strictEqual(st.o[C.KEY], 'off');
  C.setEnabled(true, st); assert.strictEqual(C.isEnabled(st), true);
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.strictEqual(C.isEnabled(broken), true);
  assert.doesNotThrow(() => C.setEnabled(false, broken));
});

test('开关关闭：完全不发请求（fetch 一次都不会被调用）', async () => {
  let calls = 0;
  const r = await C.query('9900000000017', { storage: mem({ [C.KEY]: 'off' }), fetch: async () => { calls++; return okRes(hitJson); } });
  assert.strictEqual(r, null); assert.strictEqual(calls, 0);
});

test('请求形状：POST /api/catalog/lookup，条码只在 JSON 请求体里，不在网址，不带 Cookie，不发其他字段', async () => {
  let seen;
  const r = await C.query('9900000000017', { storage: mem(), fetch: async (url, init) => { seen = { url, init }; return okRes(hitJson); } });
  assert.strictEqual(seen.url, '/api/catalog/lookup');
  assert.strictEqual(seen.init.method, 'POST');
  assert.strictEqual(seen.init.credentials, 'omit');
  assert.strictEqual(seen.init.headers['X-Requested-With'], 'life-web');
  assert.strictEqual(seen.init.headers['Content-Type'], 'application/json');
  assert.deepStrictEqual(JSON.parse(seen.init.body), { barcode: '9900000000017' });
  assert.ok(!seen.url.includes('9900000000017'));
  assert.deepStrictEqual(r, { name: '合成饮料', category: '合成分类', unit: '瓶', spec: '500ml', salePriceCents: 350 });
});

test('不可用 / 未命中 / HTTP 错误 / 网络异常 / 坏 JSON：都静默返回 null，不抛错', async () => {
  const cases = [
    async () => okRes({ available: false, found: false }),
    async () => okRes({ available: true, found: false, name: '' }),
    async () => ({ ok: false, status: 429, json: async () => ({ error: 'x' }) }),
    async () => { throw new TypeError('network'); },
    async () => ({ ok: true, json: async () => { throw new SyntaxError('bad'); } }),
    async () => okRes(null),
    async () => okRes({ available: true, found: true, name: '   ' }),
  ];
  for (const f of cases) assert.strictEqual(await C.query('x', { storage: mem(), fetch: f }), null);
});

test('超过 3 秒没回应：放弃（返回 null）并中止请求', async () => {
  let aborted = false;
  const f = (url, init) => new Promise((_, rej) => { init.signal.addEventListener('abort', () => { aborted = true; rej(new Error('aborted')); }); });
  const t0 = Date.now();
  const r = await C.query('x', { storage: mem(), fetch: f, timeoutMs: 60 });
  assert.strictEqual(r, null); assert.ok(Date.now() - t0 < 1500); assert.strictEqual(aborted, true);
  assert.strictEqual(C.TIMEOUT_MS, 3000);
});

test('normalize：名称 ≤100、分类 ≤30 字截断；价格只接受非负整数分', () => {
  const j = C.normalize({ available: true, found: true, name: '名'.repeat(150), category: '类'.repeat(45), unit: '', spec: '', salePriceCents: 100 });
  assert.strictEqual(Array.from(j.name).length, 100); assert.strictEqual(Array.from(j.category).length, 30);
  for (const bad of [-1, 1.5, '350', NaN, null, undefined]) assert.strictEqual(C.normalize({ available: true, found: true, name: 'a', salePriceCents: bad }).salePriceCents, null);
  assert.strictEqual(C.normalize({ available: true, found: true, name: 'a', salePriceCents: 0 }).salePriceCents, 0);
});

test('merge：商品库命中 → 名称/分类取商品库；价格本地历史价优先，否则商品库参考售价', () => {
  const hit = C.normalize(hitJson);
  const m1 = C.merge(hit, { found: true, name: '旧名', category: '食品', lastPriceCents: 299 });
  assert.deepStrictEqual(m1, { name: '合成饮料', category: '合成分类', priceCents: 299, source: 'catalog', priceFrom: 'memory' });
  const m2 = C.merge(hit, { found: false });
  assert.deepStrictEqual(m2, { name: '合成饮料', category: '合成分类', priceCents: 350, source: 'catalog', priceFrom: 'catalog' });
  const m3 = C.merge(C.normalize({ ...hitJson, salePriceCents: null, category: '' }), { found: true, name: '旧名', category: '食品', lastPriceCents: null });
  assert.deepStrictEqual(m3, { name: '合成饮料', category: '食品', priceCents: null, source: 'catalog', priceFrom: 'none' });   // 分类为空退回历史分类
  const m4 = C.merge(hit, null);
  assert.strictEqual(m4.priceFrom, 'catalog');
});

test('merge：商品库未命中 → 回到原有的本地历史记忆；都没有 → none（不清空表单）', () => {
  assert.deepStrictEqual(C.merge(null, { found: true, name: '旧名', category: '食品', lastPriceCents: 299 }), { name: '旧名', category: '食品', priceCents: 299, source: 'memory', priceFrom: 'memory' });
  assert.strictEqual(C.merge(null, { found: false }).source, 'none');
  assert.strictEqual(C.merge(null, null).source, 'none');
});

test('i18n 提示：三种价格来源在中英文下各不相同且点明来源', () => {
  const I = require(path.join(WW, 'life-i18n.js'));
  const zh = ['memory', 'catalog', 'none'].map((k) => I.catalogHint(k, 'zh'));
  const en = ['memory', 'catalog', 'none'].map((k) => I.catalogHint(k, 'en'));
  assert.strictEqual(new Set(zh).size, 3); assert.strictEqual(new Set(en).size, 3);
  assert.match(zh[0], /商品库.*历史记忆/); assert.match(zh[1], /商品库.*参考售价/);
  assert.match(en[0], /product catalog.*local history/); assert.match(en[1], /reference sale price/);
});
