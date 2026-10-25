'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { WW, L, vectors } = require('./helpers');
const I = require(path.join(WW, 'life-i18n.js'));
const HAN = /[\u4e00-\u9fff]/;

test('默认语言是中文；切到 English 后再切回', () => {
  assert.strictEqual(I.lang(), 'zh');
  assert.strictEqual(I.setLang('en'), 'en');
  assert.strictEqual(I.t('你好', 'Hello'), 'Hello');
  assert.strictEqual(I.setLang('zh'), 'zh');
  assert.strictEqual(I.t('你好', 'Hello'), '你好');
  assert.strictEqual(I.setLang('fr'), 'zh');   // 非法值回到中文
});

test('reasons.json：每一条 zh 都能被翻译成对应的 en，字典里没有多余条目', () => {
  const v = vectors('reasons.json');
  assert.ok(v.length >= 25);
  for (const { zh, en } of v) assert.strictEqual(I.translateReason(zh), en, zh);
  assert.deepStrictEqual(Object.keys(I.REASONS).sort(), v.map((x) => x.zh).sort());
});

test('多个原因用「；」连接时逐个翻译；未知原因保留中文原文', () => {
  assert.strictEqual(I.translateReason('商品名不能为空；价格不能为负数'), 'Name is required; Price cannot be negative');
  assert.strictEqual(I.translateReason('某个以后新增的原因'), '某个以后新增的原因');
});

test('本地模式产生的每一种原因都有英文（译文里不含汉字）', async () => {
  const B = (n) => 'x'.repeat(n);
  const mk = (o) => ({ name: 'a', priceCents: 100, quantity: 1, date: '2026-10-01', ...o });
  const bad = [123, mk({ name: '' }), mk({ priceCents: -1 }), mk({ priceCents: 'x' }), mk({ quantity: 0 }), mk({ quantity: 'x' }), mk({ date: 'x' }),
    mk({ id: B(65) }), mk({ barcode: B(65) }), mk({ name: B(101) }), mk({ category: B(31) }), mk({ note: B(1001) }),
    mk({ batchId: 'b', batchName: B(61) }), mk({ patient: B(41) }), mk({ dosage: B(61) }),
    mk({ priceCents: 100000000001 }), mk({ quantity: 1000001 }), mk({ quantity: 0.0000001 }), mk({ name: '', priceCents: -1 })];
  const text = JSON.stringify({ app: 'consumption-tracker', version: 2, records: bad });
  const pre = L.precheck(L.parseImport(text));
  assert.strictEqual(pre.rejected.length, bad.length);
  for (const r of pre.rejected) {
    const en = I.translateReason(r.reason);
    assert.ok(!HAN.test(en), `缺少英文：${r.reason} → ${en}`);
  }
  // CSV 路径的价格/数量原因
  const csv = '日期,商品名,单价,数量\n2026-10-01,a,abc,1\n2026-10-01,a,1,abc\n2026-10-01,a,1,0\n';
  for (const r of L.precheck(L.parseImport(csv)).rejected) assert.ok(!HAN.test(I.translateReason(r.reason)), r.reason);
});

test('标签：第 N 条 / 第 N 行', () => {
  assert.strictEqual(I.translateLabel('第 3 条'), 'Record #3');
  assert.strictEqual(I.translateLabel('第 12 行'), 'Row 12');
});

test('本地模式整体解析失败：中文 message + 英文 messageEn', () => {
  for (const [text, zh, en] of [['{ nope', '文件不是有效的 JSON', 'The file is not valid JSON'], ['{"a":1}', '不是本应用导出的备份文件', 'This is not a backup file exported by this app'], ['', 'CSV 文件为空', 'The CSV file is empty']]) {
    try { L.parseImport(text); assert.fail('应抛错'); } catch (e) {
      assert.strictEqual(e.message, zh); assert.strictEqual(e.messageEn, en);
      assert.strictEqual(I.errorText(e, 'zh'), zh); assert.strictEqual(I.errorText(e, 'en'), en);
    }
  }
  try { L.parseImport('日期,商品名\n2026-10-01,a'); assert.fail(); } catch (e) { assert.match(I.errorText(e, 'en'), /missing required columns/); }
});

test('客户端错误文字：字典与规则；未知消息退回原文', () => {
  assert.strictEqual(I.errorText(new Error('请求失败（502）'), 'en'), 'Request failed (502)');
  assert.strictEqual(I.errorText(new Error('网络错误，请稍后重试'), 'en'), 'Network error, please try again later');
  assert.strictEqual(I.errorText(Object.assign(new Error('中'), { messageEn: 'Eng' }), 'en'), 'Eng');
  assert.strictEqual(I.errorText(new Error('完全未知的消息'), 'en'), '完全未知的消息');
});

const serverRows = [{ row: 2, label: '第 2 条', labelEn: 'Record #2', reason: '商品名不能为空', reasonEn: 'Name is required' }];

test('failureView：覆盖导入被拒——中文与英文各自完整，服务端自带的英文优先', () => {
  const e = Object.assign(new Error('x'), { rejected: serverRows, rejectedCount: 1, total: 5 });
  const zh = I.failureView(e, 'zh'), en = I.failureView(e, 'en');
  assert.strictEqual(zh.msg, '导入已中止：共 5 条中有 1 条不合格，现有数据没有任何改动。');
  assert.deepStrictEqual(zh.list.items, ['第 2 条：商品名不能为空']);
  assert.strictEqual(en.msg, 'Import aborted: 1 of 5 records are invalid; your existing data was not changed.');
  assert.deepStrictEqual(en.list.items, ['Record #2: Name is required']);
  assert.match(en.list.head, /^Invalid records \(1 in total/);
});

test('failureView：本地模式的行没有英文字段，用字典翻译；超过 8 条提示未列出', () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ row: i + 1, label: '第 ' + (i + 1) + ' 行', reason: '数量必须大于 0' }));
  const e = Object.assign(new Error('x'), { rejected: rows, total: 20 });
  const en = I.failureView(e, 'en'), zh = I.failureView(e, 'zh');
  assert.strictEqual(en.list.items.length, 8);
  assert.strictEqual(en.list.items[0], 'Row 1: Quantity must be greater than 0');
  assert.strictEqual(en.list.more, '… and 4 more not shown (12 in total)');
  assert.strictEqual(zh.list.more, '……另有 4 条未列出（共 12 条）');
  assert.strictEqual(zh.list.items[0], '第 1 行：数量必须大于 0');
});

test('failureView：没有逐条原因时只显示错误文字', () => {
  const e = Object.assign(new Error('文件不是有效的 JSON'), { messageEn: 'The file is not valid JSON' });
  assert.deepStrictEqual(I.failureView(e, 'en'), { msg: 'The file is not valid JSON', list: null });
  assert.deepStrictEqual(I.failureView(e, 'zh'), { msg: '文件不是有效的 JSON', list: null });
});

test('resultView：导入/上传/下载的摘要与被跳过的行', () => {
  const r = { added: 2, updated: 1, skipped: 1, skippedRows: serverRows };
  assert.strictEqual(I.resultView('import', r, 'zh').msg, '导入完成：新增 2，更新 1，跳过 1');
  assert.strictEqual(I.resultView('import', r, 'en').msg, 'Import complete: added 2, updated 1, skipped 1');
  assert.strictEqual(I.resultView('upload', r, 'en').msg, 'Upload complete: added 2, updated 1, skipped 1');
  assert.strictEqual(I.resultView('download', r, 'zh').msg.slice(0, 4), '下载完成');
  assert.deepStrictEqual(I.resultView('import', r, 'en').list.items, ['Record #2: Name is required']);
  assert.strictEqual(I.resultView('import', { added: 1, updated: 0, skipped: 0 }, 'en').list, null);
});

test('英文界面下切换语言会改变同一个错误的显示（不需要重新导入）', () => {
  const e = Object.assign(new Error('x'), { rejected: serverRows, rejectedCount: 1, total: 5 });
  I.setLang('en'); const a = I.failureView(e).msg;
  I.setLang('zh'); const b = I.failureView(e).msg;
  assert.notStrictEqual(a, b);
});
