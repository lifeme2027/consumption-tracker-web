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

test('覆盖导入 422：错误带逐条原因（rejected/total/rejectedCount/messageEn）；合并结果原样带 skippedRows', async () => {
  const body = {
    error: '导入已中止：3 条中有 1 条不合格，现有数据没有任何改动', errorEn: 'Import aborted: 1 of 3 records are invalid; your existing data was not changed',
    rejected: [{ row: 2, label: '第 2 条', labelEn: 'Record #2', reason: '备注过长（最多 1000 字）', reasonEn: 'Note too long (max 1000 characters)' }], rejectedCount: 1, total: 3,
  };
  const s = new RemoteStore({ fetch: fakeFetch(() => ({ status: 422, json: body })) });
  await assert.rejects(() => s.importText('{}', 'replace'), (e) =>
    e.status === 422 && e.rejected.length === 1 && e.rejected[0].row === 2 && e.rejected[0].label === '第 2 条' &&
    e.total === 3 && e.rejectedCount === 1 && /没有任何改动/.test(e.message) && /Import aborted/.test(e.messageEn));
  const ok = { added: 2, updated: 0, skipped: 1, total: 3, skippedRows: [{ row: 2, label: '第 2 条', reason: '数量过大' }] };
  const m = new RemoteStore({ fetch: fakeFetch(() => ({ status: 200, json: ok })) });
  const r = await m.importText('{}', 'merge');
  assert.deepStrictEqual(r.skippedRows, ok.skippedRows);
  assert.strictEqual(r.skipped, 1);
});

test('服务端 400/413 的 errorEn 变成 messageEn；网络错误自带英文', async () => {
  const mk = (status, body) => ({ ok: false, status, headers: { get: () => 'application/json' }, json: async () => body });
  const s = new RemoteStore({ fetch: async () => mk(400, { error: '文件不是有效的 JSON', errorEn: 'The file is not valid JSON' }) });
  await assert.rejects(() => s.importText('x', 'merge'), (e) => e.message === '文件不是有效的 JSON' && e.messageEn === 'The file is not valid JSON');
  const n = new RemoteStore({ fetch: async () => { throw new TypeError('x'); } });
  await assert.rejects(() => n.meta(), (e) => e.message === '网络错误，请稍后重试' && e.messageEn === 'Network error, please try again later');
});

test('查询自动翻页：没给 limit 时取全所有页；给了 limit/offset 时只发一次；总计用服务端全量值', async () => {
  const rows = Array.from({ length: 7 }, (_, i) => ({ id: 'r' + i }));
  const f = fakeFetch((u, init) => {
    const b = JSON.parse(init.body); const off = b.offset || 0; const lim = b.limit || 3;
    const page = rows.slice(off, off + lim);
    return { status: 200, json: { records: page, count: 7, totalCents: 700, total: 7, offset: off, limit: lim, returned: page.length, hasMore: off + page.length < 7 } };
  });
  const s = new RemoteStore({ fetch: f });
  const r = await s.query({ keyword: 'k' });
  assert.deepStrictEqual(r.records.map((x) => x.id), rows.map((x) => x.id));
  assert.strictEqual(r.count, 7); assert.strictEqual(r.totalCents, 700); assert.strictEqual(r.hasMore, false);
  assert.deepStrictEqual(f.calls.map((c) => JSON.parse(c.body).offset), [0, 3, 6]);
  assert.ok(f.calls.every((c) => JSON.parse(c.body).keyword === 'k'));
  const g = fakeFetch((u, init) => ({ status: 200, json: { records: [{ id: 'x' }], count: 7, totalCents: 1, hasMore: true } }));
  const s2 = new RemoteStore({ fetch: g });
  const one = await s2.query({ limit: 1, offset: 2 });
  assert.strictEqual(g.calls.length, 1); assert.strictEqual(one.hasMore, true);
  assert.deepStrictEqual(JSON.parse(g.calls[0].body), { limit: 1, offset: 2 });
});

test('查询自动翻页：服务端异常返回空页时不会死循环', async () => {
  const f = fakeFetch(() => ({ status: 200, json: { records: [], count: 5, totalCents: 0, hasMore: true } }));
  const r = await new RemoteStore({ fetch: f }).query({});
  assert.strictEqual(f.calls.length, 1); assert.strictEqual(r.records.length, 0);
});

test('LM-M1：撤销删除按 ≤150 条且 ≤48KB 分批 restore，合计返回；批量删除按 ≤500 个 id 分批', async () => {
  const f = fakeFetch((u, init) => {
    if (init.method === 'DELETE') return { status: 200, json: { deleted: 1 } };
    const b = JSON.parse(init.body);
    return u.endsWith('/restore') ? { status: 200, json: { restored: b.records.length } } : { status: 200, json: { deleted: b.ids.length } };
  });
  const s = new RemoteStore({ fetch: f });
  const recs = Array.from({ length: 400 }, (_, i) => ({ id: 'r' + i, name: 'x', note: 'n' }));
  assert.strictEqual(await s.restore(recs), 400);
  const sizes = f.calls.map((c) => JSON.parse(c.body).records.length);
  assert.deepStrictEqual(sizes, [150, 150, 100]);
  assert.ok(f.calls.every((c) => Buffer.byteLength(c.body) < 64 * 1024));
  // 大记录（长备注，中文 3 字节/字）：按字节再切，每批请求体都不超过 64KB
  f.calls.length = 0;
  const fat = Array.from({ length: 60 }, (_, i) => ({ id: 'f' + i, name: '药'.repeat(100), note: '备'.repeat(1000) }));
  assert.strictEqual(await s.restore(fat), 60);
  assert.ok(f.calls.length > 1);
  assert.ok(f.calls.every((c) => Buffer.byteLength(c.body) < 64 * 1024));
  assert.deepStrictEqual(f.calls.flatMap((c) => JSON.parse(c.body).records.map((r) => r.id)), fat.map((r) => r.id));
  // 批量删除 1200 个 id
  f.calls.length = 0;
  const ids = Array.from({ length: 1200 }, (_, i) => 'i' + i);
  assert.strictEqual(await s.remove(ids), 1200);
  assert.deepStrictEqual(f.calls.map((c) => JSON.parse(c.body).ids.length), [500, 500, 200]);
  // 单个 id 仍走 DELETE
  f.calls.length = 0;
  await s.remove(['one']);
  assert.strictEqual(f.calls[0].method, 'DELETE');
});

test('LM-M1：分批中途失败时错误带上已恢复条数', async () => {
  let n = 0;
  const f = fakeFetch(() => (++n === 2 ? { status: 413, json: { error: '请求内容过大' } } : { status: 200, json: { restored: 150 } }));
  const s = new RemoteStore({ fetch: f });
  await assert.rejects(() => s.restore(Array.from({ length: 400 }, (_, i) => ({ id: 'r' + i }))), (e) => e.status === 413 && e.restored === 150);
});
