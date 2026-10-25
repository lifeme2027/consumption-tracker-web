const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { WW } = require('./helpers');
const { RemoteStore } = require(path.join(WW, 'life-remote.js'));

function fakeFetch(handler) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body, credentials: init.credentials });
    const r = handler(url, init) || { status: 200, json: {} };
    return {
      ok: r.status >= 200 && r.status < 300, status: r.status,
      headers: { get: () => (r.text !== undefined ? 'text/plain' : 'application/json') },
      json: async () => r.json, text: async () => r.text,
    };
  };
  f.calls = calls; return f;
}

test('适配层把同一接口映射到原有 /api，并带 CSRF 头与同源 Cookie', async () => {
  const f = fakeFetch((u) => (u.includes('/records/delete') ? { status: 200, json: { deleted: 2 } } : u.endsWith('/restore') ? { status: 200, json: { restored: 1 } } : { status: 200, json: { ok: 1, records: [] } }));
  const s = new RemoteStore({ fetch: f });
  await s.add({ name: 'x' }); await s.update('a b', { name: 'y' });
  assert.strictEqual(await s.remove(['1', '2']), 2);
  await s.remove(['1']);
  assert.strictEqual(await s.restore([{ id: '1' }]), 1);
  await s.query({ keyword: 'k' }); await s.stats('2026-10', '2026-10-05'); await s.meta(); await s.lookup('6902'); await s.assignBatch(['1'], 'b');
  assert.deepStrictEqual(f.calls.map((c) => c.method + ' ' + c.url), [
    'POST /api/records', 'PUT /api/records/a%20b', 'POST /api/records/delete', 'DELETE /api/records/1', 'POST /api/records/restore',
    'POST /api/records/query', 'GET /api/stats?month=2026-10&day=2026-10-05', 'GET /api/meta', 'POST /api/products/lookup', 'POST /api/records/batch']);
  for (const c of f.calls) { assert.strictEqual(c.headers['X-Requested-With'], 'life-web'); assert.strictEqual(c.credentials, 'same-origin'); }
});

test('导入：merge / replace 参数；导出读文本；查询关键词在 POST 体里而不是 URL', async () => {
  const f = fakeFetch((u) => (u.includes('export') ? { status: 200, text: 'DATA' } : { status: 200, json: { added: 1, updated: 0, skipped: 0 } }));
  const s = new RemoteStore({ fetch: f });
  await s.importText('{"a":1}', 'merge'); await s.importText('x', 'replace');
  assert.strictEqual(await s.exportJson(), 'DATA'); assert.strictEqual(await s.exportCsv(), '\uFEFFDATA'); // Response.text() 会吃掉 BOM，适配层补回
  assert.deepStrictEqual(f.calls.map((c) => c.url), ['/api/import?mode=merge', '/api/import?mode=replace&confirm=yes', '/api/export.json', '/api/export.csv']);
  assert.strictEqual(f.calls[0].body, '{"a":1}'); assert.match(f.calls[0].headers['Content-Type'], /text\/plain/);
  await s.query({ keyword: '秘密药名' });
  assert.ok(!f.calls[4].url.includes('秘密'));
});

test('401 通知模式控制器；错误带服务端中文信息；网络错误统一提示', async () => {
  let expired = 0;
  const s = new RemoteStore({ fetch: fakeFetch(() => ({ status: 401, json: { error: '未登录或会话已过期' } })), onUnauthorized: () => expired++ });
  await assert.rejects(() => s.meta(), (e) => e.status === 401 && /会话已过期/.test(e.message));
  assert.strictEqual(expired, 1);
  const bad = new RemoteStore({ fetch: fakeFetch(() => ({ status: 400, json: { error: '备注过长（最多 1000 字）', rejected: [{ row: 2 }] } })) });
  await assert.rejects(() => bad.add({}), (e) => e.status === 400 && /备注过长/.test(e.message) && e.rejected[0].row === 2);
  const down = new RemoteStore({ fetch: () => { throw new TypeError('x'); } });
  await assert.rejects(() => down.meta(), /网络错误/);
});

test('重复提醒（云端）：按同日同编码过滤，排除自身', async () => {
  const recs = [{ id: 'a', barcode: '1', date: 'd' }, { id: 'b', barcode: '1', date: 'd' }, { id: 'c', barcode: '2', date: 'd' }];
  const s = new RemoteStore({ fetch: fakeFetch(() => ({ status: 200, json: { records: recs } })) });
  assert.deepStrictEqual((await s.duplicates('1', 'd')).map((r) => r.id), ['a', 'b']);
  assert.deepStrictEqual((await s.duplicates('1', 'd', 'a')).map((r) => r.id), ['b']);
  assert.deepStrictEqual(await s.duplicates('', 'd'), []);
});
