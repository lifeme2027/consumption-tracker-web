const test = require('node:test');
const assert = require('node:assert');
const { L, vectors, openStore, rec, backup, full } = require('./helpers');

// 本地模式不得发任何网络请求：把 fetch/XHR 都换成会抛错的桩
test.beforeEach(() => {
  globalThis.fetch = () => { throw new Error('本地模式不应发网络请求'); };
  globalThis.XMLHttpRequest = function () { throw new Error('本地模式不应发网络请求'); };
});

test('limits.json 被真正加载：前端常量与共享向量一致', () => {
  const lim = vectors('limits.json');
  assert.deepStrictEqual(lim, { name: 100, note: 1000, barcode: 64, batch: 60, patient: 40, dosage: 60, quantityMax: 1000000, quantityDecimals: 6, priceCentsMax: 100000000000 });
  for (const k of Object.keys(lim)) assert.strictEqual(L.LIMITS[k], lim[k], k);
});

test('增删改查 + 金额一致', async () => {
  const s = await openStore();
  const a = await s.add(rec({ priceCents: 777, quantity: 2.5, barcode: '6902', category: '饮料' }));
  assert.strictEqual(a.amountCents, 1943);
  assert.ok(a.id && a.createdAt);
  const b = await s.add(rec({ name: '药', priceCents: 1000, date: '2026-10-06', category: '药品', patient: '妈妈', batchName: '10月药方' }));
  let q = await s.query({});
  assert.deepStrictEqual(q.records.map((r) => r.name), ['药', '牛奶']);   // 日期降序
  assert.strictEqual(q.totalCents, 1943 + 1000);
  const up = await s.update(a.id, rec({ priceCents: 800, quantity: 2, barcode: '6902' }));
  assert.strictEqual(up.amountCents, 1600); assert.strictEqual(up.createdAt, a.createdAt);
  assert.strictEqual((await s.query({ keyword: '妈妈' })).count, 1);
  assert.strictEqual((await s.query({ batchId: '__none__' })).count, 1);
  assert.strictEqual(await s.remove([a.id, a.id, 'nope']), 1);
  assert.strictEqual((await s.query({})).count, 1);
  await assert.rejects(() => s.update('nope', rec()), /记录不存在/);
});

test('必填：名称/单价/数量/日期缺一不可；编码、分类等可选', async () => {
  const s = await openStore();
  await assert.rejects(() => s.add(rec({ name: ' ' })), /商品名不能为空/);
  await assert.rejects(() => s.add(rec({ priceCents: null })), /价格/);
  await assert.rejects(() => s.add(rec({ priceCents: -1 })), /价格/);
  await assert.rejects(() => s.add(rec({ quantity: 0 })), /数量必须大于 0/);
  await assert.rejects(() => s.add(rec({ date: '2026-02-30' })), /日期/);
  const ok = await s.add(rec());
  assert.strictEqual(ok.barcode, ''); assert.strictEqual(ok.category, '未分类');
  assert.strictEqual((await s.add(rec({ priceCents: 0 }))).amountCents, 0);   // 价格 0 合法
});

test('统一上限：每个字段恰好到上限通过、多 1 被拒', async () => {
  const s = await openStore();
  const lim = vectors('limits.json');
  const cases = [['name', 'name'], ['note', 'note'], ['barcode', 'barcode'], ['batch', 'batchName'], ['patient', 'patient'], ['dosage', 'dosage']];
  for (const [k, f] of cases) {
    await s.add(rec({ [f]: 'x'.repeat(lim[k]) }));
    await assert.rejects(() => s.add(rec({ [f]: 'x'.repeat(lim[k] + 1) })), new RegExp(`最多 ${lim[k]}`), k);
  }
  await s.add(rec({ priceCents: lim.priceCentsMax }));
  await assert.rejects(() => s.add(rec({ priceCents: lim.priceCentsMax + 1 })), /价格过大/);
  await s.add(rec({ quantity: lim.quantityMax }));
  await assert.rejects(() => s.add(rec({ quantity: lim.quantityMax + 1 })), /数量过大/);
  await s.add(rec({ quantity: 0.000001 }));
  await assert.rejects(() => s.add(rec({ quantity: 0.0000001 })), /6 位小数/);
  await assert.rejects(() => s.add(rec({ quantity: 1.1234567 })), /6 位小数/);
});

test('商品记忆、重复提醒、批次、撤销删除（原 id/createdAt/批次不变）', async () => {
  const s = await openStore();
  const a = await s.add(rec({ barcode: '6902', category: '饮料', priceCents: 777, batchName: '甲' }));
  const f = await s.lookup('6902');
  assert.deepStrictEqual(f, { found: true, name: '牛奶', category: '饮料', lastPriceCents: 777 });
  assert.strictEqual((await s.lookup('none')).found, false);
  assert.strictEqual((await s.duplicates('6902', '2026-10-05')).length, 1);
  assert.strictEqual((await s.duplicates('6902', '2026-10-06')).length, 0);
  assert.strictEqual((await s.duplicates('', '2026-10-05')).length, 0);
  assert.strictEqual((await s.duplicates('6902', '2026-10-05', a.id)).length, 0);
  const b = await s.add(rec({ name: '乙', batchName: '甲' }));
  assert.strictEqual(b.batchId, a.batchId);                                  // 同名批次沿用
  const before = (await s.query({})).records.find((r) => r.id === a.id);
  await s.remove([a.id]);
  assert.strictEqual((await s.query({})).count, 1);
  assert.strictEqual(await s.restore([before]), 1);
  const after = (await s.query({})).records.find((r) => r.id === a.id);
  assert.deepStrictEqual(after, before);
  const m = await s.meta();
  assert.ok(m.categories.includes('药品') && m.categories.includes('饮料'));
  assert.deepStrictEqual(m.batches.map((x) => [x.batchName, x.count]), [['甲', 2]]);
  assert.strictEqual(await s.assignBatch([a.id], ''), 1);
  assert.strictEqual((await s.meta()).batches[0].count, 1);
});

test('统计与列表同一算法', async () => {
  const s = await openStore();
  await s.add(rec({ priceCents: 777, quantity: 2.5, category: '食品', date: '2026-10-05' }));
  await s.add(rec({ priceCents: 1000, category: '药品', date: '2026-10-06' }));
  await s.add(rec({ priceCents: 999, date: '2026-09-30' }));
  const st = await s.stats('2026-10', '2026-10-05');
  assert.strictEqual(st.monthTotalCents, 1943 + 1000); assert.strictEqual(st.monthCount, 2);
  assert.strictEqual(st.dayTotalCents, 1943);
  assert.deepStrictEqual(st.categories.map((c) => c.category), ['食品', '药品']);
  assert.ok(Math.abs(st.categories.reduce((x, c) => x + c.ratio, 0) - 1) < 1e-9);
  assert.deepStrictEqual(st.days.map((d) => d.date), ['2026-10-05', '2026-10-06']);
  const q = await s.query({ from: '2026-10-01', to: '2026-10-31' });
  assert.strictEqual(q.totalCents, st.monthTotalCents);
  await assert.rejects(() => s.stats('2026-13', '2026-10-05'), /月份/);
});

test('JSON/CSV 导出再导入往返无损；CSV 防公式注入往返', async () => {
  const s = await openStore();
  await s.add(rec({ name: '=1+1', note: "a,b\n\"c\"", barcode: '6902', priceCents: 1005, quantity: 1.5, batchName: '批', patient: "'+x", dosage: '0.5g' }));
  await s.add(rec({ name: '药', date: '2026-10-07' }));
  const json = await s.exportJson(), csv = await s.exportCsv();
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes("'=1+1"));
  const orig = (await s.query({})).records;
  const j = await openStore(); const rj = await j.importText(json, 'replace');
  assert.deepStrictEqual([rj.added, rj.skipped], [2, 0]);
  assert.deepStrictEqual((await j.query({})).records, orig);
  const c = await openStore(); await c.importText(csv, 'merge');
  const strip = (r) => ({ ...r, id: 0, createdAt: 0 });
  assert.deepStrictEqual((await c.query({})).records.map(strip).sort((a, b) => a.name.localeCompare(b.name)), orig.map(strip).sort((a, b) => a.name.localeCompare(b.name)));
  const again = await c.importText(csv, 'merge');                              // 同一文件重复合并不重复
  assert.strictEqual((await c.query({})).count, 2); assert.strictEqual(again.updated, 2);
});

test('I-01 本地：覆盖导入先全量预检，有任何不合格就整体中止、旧数据保持原样', async () => {
  const s = await openStore();
  const old = await s.add(rec({ name: '旧数据' }));
  const oldAll = JSON.stringify((await s.query({})).records);
  const bad = [
    ['备注过长', full({ id: 'b1', note: 'x'.repeat(1001) }), /备注过长\(最多1000字\)|备注过长（最多 1000 字）/],
    ['数量超6位小数', full({ id: 'b2', quantity: 0.1234567 }), /6 位小数/],
    ['数量超上限', full({ id: 'b3', quantity: 1000001 }), /数量过大/],
    ['价格超限', full({ id: 'b4', priceCents: 100000000001 }), /价格过大/],
  ];
  for (const [, r, re] of bad) {
    const text = backup([full({ id: 'ok1' }), r, full({ id: 'ok2' })]);
    await assert.rejects(() => s.importText(text, 'replace'), (e) => {
      assert.strictEqual(e.name, 'ImportRejected');
      assert.strictEqual(e.rejected.length, 1);
      assert.strictEqual(e.rejected[0].row, 2); assert.strictEqual(e.rejected[0].label, '第 2 条');
      assert.match(e.rejected[0].reason, re); return true;
    });
    assert.strictEqual(JSON.stringify((await s.query({})).records), oldAll);   // 旧数据一条没少、没变
  }
  // 全部无效（L-7）也不清空
  await assert.rejects(() => s.importText(backup([full({ id: 'z', name: '' })]), 'replace'), /导入已中止/);
  assert.strictEqual((await s.query({})).count, 1);
  assert.ok((await s.query({})).records.some((r) => r.id === old.id));
});

test('I-01 本地：合并导入继续导入合法记录，并列出被跳过的行号与原因', async () => {
  const s = await openStore();
  const r = await s.importText(backup([full({ id: 'g1' }), full({ id: 'b1', note: 'x'.repeat(1001) }), full({ id: 'g2' }), full({ id: 'b2', quantity: 2000000 })]), 'merge');
  assert.deepStrictEqual([r.added, r.updated, r.skipped], [2, 0, 2]);
  assert.deepStrictEqual(r.skippedRows.map((x) => x.row), [2, 4]);
  assert.match(r.skippedRows[0].reason, /备注过长/);
  assert.strictEqual((await s.query({})).count, 2);
});

test('覆盖导入通过预检后，清空+写入在同一事务（中途失败不会留下半成品）', async () => {
  const s = await openStore();
  await s.add(rec({ name: '旧' }));
  const ok = await s.importText(backup([full({ id: 'n1', name: '新' })]), 'replace');
  assert.strictEqual(ok.added, 1);
  assert.deepStrictEqual((await s.query({})).records.map((r) => r.name), ['新']);
});

test('CSV 导入：行号+原因；覆盖导入有坏行则中止', async () => {
  const s = await openStore();
  await s.add(rec({ name: '旧' }));
  const csv = '日期,商品名,单价,数量,备注\r\n2026-10-01,甲,1.50,2,\r\n2026-10-02,乙,abc,1,\r\n2026-10-03,丙,3,0.1234567,\r\n2026-10-04,丁,4,1,' + 'x'.repeat(1001) + '\r\n';
  await assert.rejects(() => s.importText(csv, 'replace'), (e) => {
    assert.deepStrictEqual(e.rejected.map((x) => x.label), ['第 3 行', '第 4 行', '第 5 行']);
    assert.match(e.rejected[0].reason, /价格无效/); assert.match(e.rejected[1].reason, /数量无效/); assert.match(e.rejected[2].reason, /备注过长/); return true;
  });
  assert.strictEqual((await s.query({})).count, 1);
  const r = await s.importText(csv, 'merge');
  assert.deepStrictEqual([r.added, r.skipped], [1, 3]);
  await assert.rejects(() => s.importText('a,b\n1,2', 'merge'), /缺少必需列/);
  await assert.rejects(() => s.importText('{"app":"x"}', 'merge'), /不是本应用导出的备份文件/);
  await assert.rejects(() => s.importText('{oops', 'merge'), /不是有效的 JSON/);
});

test('一键删除只清本地', async () => {
  const s = await openStore();
  await s.add(rec({ barcode: '1' })); await s.add(rec());
  assert.strictEqual(await s.wipe(), 2);
  assert.strictEqual((await s.query({})).count, 0);
  assert.strictEqual((await s.lookup('1')).found, false);
});

test('shared-vectors：金额/数量规则（money.js）与 CSV 防注入向量在本地存储里同样成立', () => {
  for (const { text, cell } of vectors('csv-text.json')) {
    assert.strictEqual(L.guardText(text), cell, JSON.stringify(text));
    assert.strictEqual(L.unguardText(cell), text, JSON.stringify(cell));
  }
});
