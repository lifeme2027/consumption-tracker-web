// 真浏览器 UI 回归。事故背景：068e1394 的 app.js 因同名函数 renderList 互相覆盖，历史列表整页不渲染，
// 而 dotnet / node 单测全绿——只有真的在浏览器里点一遍才抓得到。
// 需要：先 dotnet build -c Release；系统里有 Chrome/Chromium（CI 的 ubuntu-latest 自带 google-chrome）。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn, execFileSync } = require('child_process');
const puppeteer = require('puppeteer-core');

const ROOT = path.join(__dirname, '..', '..');
const DLL = path.join(ROOT, 'src', 'ConsumptionTracker.Web', 'bin', 'Release', 'net8.0', 'ConsumptionTrackerWeb.dll');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 表单里「今天」的本地日期。用例要保证「同日」，不能写死某一天（写死的日期过了当天，重复登记提醒就不再触发）。
const TODAY = new Intl.DateTimeFormat('sv-SE').format(new Date());

function chromePath() {
  const c = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean);
  const p = c.find((x) => fs.existsSync(x));
  if (!p) throw new Error('找不到 Chrome/Chromium，请设置 CHROME_PATH');
  return p;
}
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

let server, browser, base, dataDir, addr, catalogDb;
const errors = [];

test.before(async () => {
  assert.ok(fs.existsSync(DLL), '先执行 dotnet build -c Release：' + DLL);
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'life-e2e-'));
  addr = execFileSync('python3', [path.join(ROOT, 'scripts', 'gen_address.py')]).toString().trim();
  catalogDb = path.join(dataDir, 'synthetic-catalog.db');           // 合成商品库（与任何真实商品无关），放在数据目录里随测试清理
  execFileSync('python3', [path.join(__dirname, 'make_catalog.py'), catalogDb]);
  const port = await freePort(); base = 'http://127.0.0.1:' + port;
  server = spawn('dotnet', [DLL], {
    cwd: path.dirname(DLL),
    env: { ...process.env, ASPNETCORE_ENVIRONMENT: 'Development', Life__Auth__DevLogin: 'true', Life__Storage__DataDir: dataDir, Life__Catalog__Path: catalogDb, ASPNETCORE_URLS: base },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/healthz')).ok) break; } catch { /* 等待启动 */ } await sleep(200); }
  browser = await puppeteer.launch({ executablePath: chromePath(), args: ['--no-sandbox'], headless: true });
});
test.after(async () => {
  if (browser) await browser.close();
  if (server) server.kill();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function newPage() {
  const p = await browser.newPage();
  p.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('CONSOLE ' + m.text()); });
  p.apiCalls = [];
  p.on('request', (r) => { if (r.url().startsWith(base + '/api')) p.apiCalls.push(r.method() + ' ' + r.url().slice(base.length)); });
  await p.goto(base + '/', { waitUntil: 'networkidle0' });
  return p;
}
const text = (p, sel) => p.$eval(sel, (e) => e.textContent);
const rows = (p) => p.$$eval('#list .item', (e) => e.length);
async function clickBtn(p, label) { await p.evaluate((l) => [...document.querySelectorAll('#dlgBtns button')].find((b) => b.textContent === l).click(), label); }
async function waitRows(p, n, what) {
  for (let i = 0; i < 50; i++) { if ((await rows(p)) === n) return; await sleep(100); }
  assert.fail(`${what}：期望列表 ${n} 行，实际 ${await rows(p)} 行；汇总：${await text(p, '#listSummary')}`);
}
async function openHistory(p) { await p.click('[data-tab=history]'); await sleep(200); }
async function fillAndSave(p, { name, price, qty = '1', note = '' }) {
  await p.$eval('#recForm', (f, d) => { f.reset(); document.getElementById('fDate').value = d; }, TODAY);
  await p.type('#fName', name); await p.type('#fPrice', price);
  await p.$eval('#fQty', (e) => { e.value = ''; }); await p.type('#fQty', qty);
  if (note) await p.type('#fNote', note);
  await p.click('#saveBtn');
}

async function loginCloud(p) {
  if (!/云端/.test(await text(p, '#modeBadge'))) {   // 浏览器里已有会话 Cookie 时页面一打开就是云端模式
    await p.click('#loginBtn'); await sleep(300);
    await p.type('#loginAddr', addr); await p.click('#devBtn');
  }
  for (let i = 0; i < 50 && !/云端/.test(await text(p, '#modeBadge')); i++) await sleep(100);
}

/** 登记 → 保存后列表出现 → 编辑 → 删除 → 撤销。本地与云端共用。 */
async function crud(p, label) {
  await fillAndSave(p, { name: '回归药' + label, price: '12.5', qty: '2', note: '备注' + label });
  for (let i = 0; i < 30 && !/已保存/.test(await text(p, '#formMsg')); i++) await sleep(100);
  assert.match(await text(p, '#formMsg'), /已保存/, label + ' 登记保存提示');
  await openHistory(p);
  await waitRows(p, 1, label + ' 保存后列表应出现新记录');
  assert.match(await text(p, '#list'), new RegExp('回归药' + label));
  assert.match(await text(p, '#list'), /25\.00/);                      // 12.5 × 2

  // 编辑：改单价，保存后列表金额更新
  await p.evaluate(() => [...document.querySelectorAll('#list button')].find((b) => b.textContent === '编辑').click());
  assert.strictEqual(await p.$eval('#fPrice', (e) => e.value), '12.50');
  await p.$eval('#fPrice', (e) => { e.value = ''; }); await p.type('#fPrice', '20');
  await p.click('#saveBtn');
  await sleep(300);
  await waitRows(p, 1, label + ' 编辑后');
  assert.match(await text(p, '#list'), /40\.00/);                      // 20 × 2

  // 删除（确认框）→ 列表空 → 撤销 → 记录回来
  await p.evaluate(() => [...document.querySelectorAll('#list button')].find((b) => b.textContent === '删除').click());
  await sleep(150); await clickBtn(p, '删除');
  await waitRows(p, 0, label + ' 删除后');
  assert.match(await text(p, '#toastText'), /已删除 1 条/);
  await p.click('#toastUndo');
  await waitRows(p, 1, label + ' 撤销后记录应恢复');
  assert.match(await text(p, '#list'), /40\.00/);
  // 清理：再删一次并等撤销条消失，不影响后续
  await p.evaluate(() => [...document.querySelectorAll('#list button')].find((b) => b.textContent === '删除').click());
  await sleep(150); await clickBtn(p, '删除'); await waitRows(p, 0, label + ' 清理');
}

test('本地模式：登记 → 列表 → 编辑 → 删除 → 撤销（全程不发 /api 请求）', async () => {
  const p = await newPage();
  assert.match(await text(p, '#modeBadge'), /本地/);
  await crud(p, 'L');
  assert.deepStrictEqual(p.apiCalls, [], '本地模式不应向服务器发任何 /api 请求');
  await p.close();
});

test('LM-L3：单价 0.001 不再静默存成 0 分，给出明确提示且不保存', async () => {
  const p = await newPage();
  await fillAndSave(p, { name: '过小单价', price: '0.001' });
  await sleep(300);
  assert.match(await text(p, '#formMsg'), /单价过小/);
  await openHistory(p);
  await waitRows(p, 0, '0.001 不应保存');
  await p.close();
});

test('③/① 本地模式：空文件/高版本/缺版本的覆盖导入被拒绝，现有记录保持原样', async () => {
  const p = await newPage();
  assert.match(await text(p, '#modeBadge'), /本地/);
  await emptyReplaceRegression(p, 'L');
  await p.close();
});

test('云端（开发登录）模式：登记 → 列表 → 编辑 → 删除 → 撤销', async () => {
  const p = await newPage();
  await loginCloud(p);
  assert.match(await text(p, '#modeBadge'), /云端/);
  await crud(p, 'C');
  await p.close();
});

test('LM-M1：云端 400 条全选删除后撤销，全部恢复（分批 restore，不再 413）', async () => {
  const p = await newPage();
  await loginCloud(p);
  const records = Array.from({ length: 400 }, (_, i) => ({ id: 'bulk' + String(i).padStart(3, '0'), name: '批量' + i, priceCents: 100 + i, quantity: 1, date: '2026-10-25', note: '备'.repeat(150), category: '药品', createdAt: 1000 + i }));
  const status = await p.evaluate(async (recs) => {
    const r = await fetch('/api/import?mode=merge', { method: 'POST', headers: { 'X-Requested-With': 'life-web', 'Content-Type': 'text/plain' }, body: JSON.stringify({ app: 'consumption-tracker', version: 2, records: recs, products: [] }) });
    return r.status;
  }, records);
  assert.strictEqual(status, 200);
  await openHistory(p);
  await waitRows(p, 400, '导入 400 条后');
  await p.click('#selAll');
  await p.click('#bulkDelete'); await sleep(200); await clickBtn(p, '删除');
  await waitRows(p, 0, '批量删除后');
  await p.click('#toastUndo');
  await waitRows(p, 400, '撤销后应恢复全部 400 条');
  assert.doesNotMatch(await text(p, '#listSummary'), /失败/);
  await p.close();
});

/** 在「数据」页用覆盖模式导入一个文件，确认对话框点「清空并导入」，返回 #impMsg 与 #impDetail 的文字。 */
async function replaceImport(p, content, name) {
  const f = path.join(dataDir, name);
  fs.writeFileSync(f, content);
  await p.click('[data-tab=data]'); await sleep(200);
  const input = await p.$('#impFile');
  await input.uploadFile(f);
  await p.evaluate(() => { document.querySelector('input[name=impMode][value=replace]').click(); });
  await p.click('#impBtn'); await sleep(250);
  await clickBtn(p, '清空并导入');
  for (let i = 0; i < 40 && !(await text(p, '#impMsg')).trim(); i++) await sleep(100);
  return (await text(p, '#impMsg')) + ' | ' + (await text(p, '#impDetail'));
}

/** ③/① 回归：合法但空的文件、版本号异常的文件覆盖导入都要被拒绝并给出原因，现有记录原样保留。本地与云端共用。 */
async function emptyReplaceRegression(p, label) {
  await fillAndSave(p, { name: '要保留的药' + label, price: '9.9' });
  for (let i = 0; i < 30 && !/已保存/.test(await text(p, '#formMsg')); i++) await sleep(100);
  await openHistory(p);
  const base0 = (await rows(p)) - 1;                                    // 云端共享账户里可能已有别的测试留下的记录
  await waitRows(p, base0 + 1, label + ' 先有 1 条新记录');
  const empty = JSON.stringify({ app: 'consumption-tracker', version: 2, records: [], products: [] });
  let out = await replaceImport(p, empty, 'empty-' + label + '.json');
  assert.match(out, /没有任何记录/, label + ' 空覆盖应被拒绝：' + out);
  assert.match(out, /一键删除全部数据/, label + ' 应提示用一键删除：' + out);
  await openHistory(p);
  await waitRows(p, base0 + 1, label + ' 空覆盖被拒绝后旧记录必须还在');
  assert.match(await text(p, '#list'), new RegExp('要保留的药' + label));

  out = await replaceImport(p, JSON.stringify({ app: 'consumption-tracker', version: 99, records: [], products: [] }), 'v99-' + label + '.json');
  assert.match(out, /升级/, label + ' 高版本应提示升级：' + out);
  out = await replaceImport(p, JSON.stringify({ app: 'consumption-tracker', records: [], products: [] }), 'nov-' + label + '.json');
  assert.match(out, /版本号无效/, label + ' 缺少版本号应被拒绝：' + out);
  await openHistory(p);
  await waitRows(p, base0 + 1, label + ' 版本号被拒绝后旧记录必须还在');

  // 清理
  await p.evaluate(() => [...document.querySelectorAll('#list button')].find((b) => b.textContent === '删除').click());
  await sleep(150); await clickBtn(p, '删除'); await waitRows(p, base0, label + ' 清理');
}

test('③/① 云端模式：空文件/高版本/缺版本的覆盖导入被拒绝，现有记录保持原样', async () => {
  const p = await newPage();
  await loginCloud(p);
  await emptyReplaceRegression(p, 'C');
  await p.close();
});

test('M-1 文案：一键删除的提示与确认框如实说明（云端 secure_delete/checkpoint/VACUUM/旧备份；本地 IndexedDB 残留），不含“永久/无法恢复”', async () => {
  const p = await newPage();
  await loginCloud(p);
  await p.click('[data-tab=data]'); await sleep(200);
  const cloudHint = await text(p, '#wipeHint');
  for (const k of ['secure_delete', 'checkpoint', 'VACUUM', '备份副本和访问日志不会随之自动删除', '手动清理']) assert.ok(cloudHint.includes(k), '云端提示缺少 ' + k + '：' + cloudHint);
  await p.click('#wipeBtn'); await sleep(250);
  const cloudDlg = await text(p, '#dlgBody');
  assert.ok(cloudDlg.includes('VACUUM') && cloudDlg.includes('备份'), cloudDlg);
  assert.ok(!/永久|无法恢复/.test(cloudDlg + cloudHint));
  await clickBtn(p, '取消');
  await p.click('#logoutBtn');
  for (let i = 0; i < 50 && !/本地/.test(await text(p, '#modeBadge')); i++) await sleep(100);
  await p.click('[data-tab=data]'); await sleep(200);
  const localHint = await text(p, '#wipeHint');
  assert.ok(localHint.includes('IndexedDB') && localHint.includes('不提供撤销') && !/永久|无法恢复/.test(localHint), localHint);
  await p.click('#wipeBtn'); await sleep(250);
  const localDlg = await text(p, '#dlgBody');
  assert.ok(localDlg.includes('IndexedDB') && !/永久|无法恢复/.test(localDlg), localDlg);
  await clickBtn(p, '取消');
  await p.close();
});

/** 条码记忆（本地模式）：保存带条码记录 → 重置表单 → 再输入同一条码（回车 / Tab 失焦）→ 名称/分类/单价自动出现、可改、可保存；未知条码保持手动。 */
async function typeBarcode(p, code, key) {
  await p.$eval('#recForm', (f, d) => { f.reset(); document.getElementById('fDate').value = d; document.getElementById('fQty').value = '1'; }, TODAY);
  await p.evaluate(() => document.getElementById('clearBtn').click());   // 真正走「重置」按钮（会清 lastLookedCode）
  await p.click('#fBarcode'); await p.type('#fBarcode', code); await p.keyboard.press(key);
  await sleep(300);
}
const val = (p, sel) => p.$eval(sel, (e) => e.value);
test('条码记忆（本地模式）：保存后再扫同一条码，回车 / Tab 都自动带出名称、分类、价格，可改可存；未知条码保持手动', async () => {
  const p = await newPage();
  assert.match(await text(p, '#modeBadge'), /本地/);
  const code = '69' + Date.now();
  // ① 第一次：手填并保存（分类选「食品」，单价 3.50）
  await p.type('#fBarcode', code); await p.keyboard.press('Enter'); await sleep(300);
  assert.match(await text(p, '#lookupHint'), /新条码，请填写/, '没有历史应提示新条码');
  assert.strictEqual(await val(p, '#fName'), '', '未命中不应自动填名称');
  await p.type('#fName', '记忆咖啡'); await p.type('#fPrice', '3.5');
  await p.select('#fCategory', '食品');
  await p.$eval('#fDate', (e, d) => { e.value = d; }, TODAY);
  await p.click('#saveBtn');
  for (let i = 0; i < 30 && !/已保存/.test(await text(p, '#formMsg')); i++) await sleep(100);
  assert.match(await text(p, '#formMsg'), /已保存/);
  let expName = '记忆咖啡', expPrice = '3.50';   // 每轮保存后，下一轮应带出的是「最近一次保存」的值
  for (const key of ['Enter', 'Tab']) {
    // ② 重置后 ③ 再输入同一条码
    await typeBarcode(p, code, key);
    assert.strictEqual(await val(p, '#fName'), expName, key + ' 应带出名称');
    assert.strictEqual(await val(p, '#fPrice'), expPrice, key + ' 应带出价格');
    assert.strictEqual(await val(p, '#fCategory'), '食品', key + ' 应带出分类');
    assert.match(await text(p, '#lookupHint'), /已带出上次的名称、分类、价格，请核对/);
    // 可修改并保存；Tab 之后再失焦不应再次覆盖用户的修改
    await p.$eval('#fName', (e) => { e.value = ''; }); await p.type('#fName', '记忆咖啡' + key);
    await p.$eval('#fPrice', (e) => { e.value = ''; }); await p.type('#fPrice', key === 'Enter' ? '4' : '4.25');
    await p.click('#fQty'); await p.click('#fNote'); await sleep(200);
    assert.strictEqual(await val(p, '#fName'), '记忆咖啡' + key, '失焦不应覆盖用户已改内容');
    await p.click('#saveBtn'); await sleep(300);
    assert.match(await text(p, '#dlgBody'), /重复登记提醒|已登记过相同编码/);      // 同条码同日已有记录：既有的重复提醒，点「仍然保存」
    await clickBtn(p, '仍然保存');
    for (let i = 0; i < 30 && !/已保存/.test(await text(p, '#formMsg')); i++) await sleep(100);
    assert.match(await text(p, '#formMsg'), /已保存/, key + ' 修改后保存应成功');
    expName = '记忆咖啡' + key; expPrice = key === 'Enter' ? '4.00' : '4.25';
  }
  // 最近一次保存（Tab 轮：名称「记忆咖啡Tab」，价格 4.25）成为新的记忆
  await typeBarcode(p, code, 'Enter');
  assert.strictEqual(await val(p, '#fName'), '记忆咖啡Tab'); assert.strictEqual(await val(p, '#fPrice'), '4.25');
  // ④ 未知条码：保持手动、不清空已输入内容、不报错
  await p.$eval('#fName', (e) => { e.value = ''; }); await p.type('#fName', '手填的名称');
  await p.$eval('#fBarcode', (e) => { e.value = ''; }); await p.type('#fBarcode', 'unknown-' + Date.now()); await p.keyboard.press('Tab'); await sleep(300);
  assert.match(await text(p, '#lookupHint'), /新条码，请填写/);
  assert.strictEqual(await val(p, '#fName'), '手填的名称', '未命中不清空用户已输入内容');
  // 默认开启「查询商品库」：每次查条码只会多出对商品库接口的 POST（商品库里没有这些条码 → 静默回退到本机记忆）；绝不会有别的 /api 请求
  assert.ok(p.apiCalls.length > 0 && p.apiCalls.every((c) => c === 'POST /api/catalog/lookup'), '条码记忆在本地模式只应有商品库查询：' + p.apiCalls.join(','));
  // 清理：删掉本用例的记录，避免影响其它用例的行数断言
  await openHistory(p);
  await p.$eval('#qKeyword', (e) => { e.value = '记忆咖啡'; }); await p.keyboard.press('Enter'); await sleep(300);
  await p.click('#selAll'); await p.click('#bulkDelete'); await sleep(200); await clickBtn(p, '删除'); await waitRows(p, 0, '条码记忆用例清理');
  await p.close();
});

/** 商品库查询（本地模式，合成库）：命中带出名称/分类/参考售价；本地历史价优先；未命中回退本机记忆；开关关闭后不发任何请求。 */
test('商品库查询（本地模式）：命中带出名称、分类、参考售价，可改可存；历史价优先；超长分类截断；开关关闭零请求且持久；未命中回退', async () => {
  const hit = '9900000000017', noPrice = '9900000000024', longCat = '9900000000031';
  const p = await newPage();
  assert.match(await text(p, '#modeBadge'), /本地/);
  assert.strictEqual(await p.$eval('#catalogToggle', (e) => e.checked), true, '开关默认开启');
  // ① 命中：名称/分类/参考售价自动带出，提示说明来源
  await typeBarcode(p, hit, 'Enter');
  assert.strictEqual(await val(p, '#fName'), '合成测试饮料');
  assert.strictEqual(await val(p, '#fCategory'), '合成饮料');
  assert.strictEqual(await val(p, '#fPrice'), '3.50');
  assert.match(await text(p, '#lookupHint'), /已从商品库带出名称、分类、价格（价格取自商品库参考售价）/);
  assert.deepStrictEqual(p.apiCalls.filter((c) => c !== 'POST /api/catalog/lookup'), []);
  assert.ok(p.apiCalls.includes('POST /api/catalog/lookup'));
  // 可改并保存（改名称与单价）→ 成为本机记忆
  await p.$eval('#fName', (e) => { e.value = ''; }); await p.type('#fName', '合成饮料(改)');
  await p.$eval('#fPrice', (e) => { e.value = ''; }); await p.type('#fPrice', '5');
  await p.$eval('#fDate', (e, d) => { e.value = d; }, TODAY);
  await p.click('#saveBtn');
  for (let i = 0; i < 30 && !/已保存/.test(await text(p, '#formMsg')); i++) await sleep(100);
  assert.match(await text(p, '#formMsg'), /已保存/);
  // ② 再扫：名称、分类仍取商品库；价格取本机历史价 5.00（优先于参考售价 3.50）
  await typeBarcode(p, hit, 'Enter');
  assert.strictEqual(await val(p, '#fName'), '合成测试饮料');
  assert.strictEqual(await val(p, '#fPrice'), '5.00');
  assert.match(await text(p, '#lookupHint'), /已从商品库带出名称、分类（价格取自本地历史记忆）/);
  // ③ 参考售价为空：不填价格，提示请填写
  await typeBarcode(p, noPrice, 'Tab');
  assert.strictEqual(await val(p, '#fName'), '合成无价商品');
  assert.strictEqual(await val(p, '#fPrice'), '');
  assert.match(await text(p, '#lookupHint'), /已从商品库带出名称、分类，请填写价格/);
  // ④ 分类 45 字 → 截断为 30 字
  await typeBarcode(p, longCat, 'Enter');
  assert.strictEqual((await val(p, '#fCategory')).length, 30);
  // ⑤ 未命中：不清空已填内容；回退「新条码」提示
  await p.$eval('#fName', (e) => { e.value = ''; }); await p.type('#fName', '手填的名称');
  await p.$eval('#fBarcode', (e) => { e.value = ''; }); await p.type('#fBarcode', 'zz-miss-' + Date.now()); await p.keyboard.press('Tab'); await sleep(400);
  assert.match(await text(p, '#lookupHint'), /新条码，请填写/);
  assert.strictEqual(await val(p, '#fName'), '手填的名称');
  // ⑥ 关闭开关（持久化）：不再有任何请求；已有本机记忆仍可用
  await p.click('[data-tab=data]'); await sleep(150);
  await p.click('#catalogToggle');
  await p.reload({ waitUntil: 'networkidle0' });
  assert.strictEqual(await p.$eval('#catalogToggle', (e) => e.checked), false, '刷新后开关仍为关闭');
  p.apiCalls.length = 0;
  await p.click('[data-tab=register]'); await sleep(150);
  await typeBarcode(p, noPrice, 'Enter');                       // 商品库里有、本机没有 → 关闭后不应带出
  assert.strictEqual(await val(p, '#fName'), '');
  assert.match(await text(p, '#lookupHint'), /新条码，请填写/);
  await typeBarcode(p, hit, 'Tab');                             // 本机记忆（上面保存的改名记录）仍然带出
  assert.strictEqual(await val(p, '#fName'), '合成饮料(改)');
  assert.match(await text(p, '#lookupHint'), /已带出上次的名称、分类、价格/);
  assert.deepStrictEqual(p.apiCalls, [], '开关关闭后不应有任何 /api 请求（含商品库查询）');
  // ⑦ 重新打开开关
  await p.click('[data-tab=data]'); await sleep(150); await p.click('#catalogToggle');
  await p.click('[data-tab=register]'); await sleep(150);
  await typeBarcode(p, noPrice, 'Enter');
  assert.strictEqual(await val(p, '#fName'), '合成无价商品');
  // 清理
  await openHistory(p);
  await p.$eval('#qKeyword', (e) => { e.value = '合成饮料'; }); await p.keyboard.press('Enter'); await sleep(300);
  await p.click('#selAll'); await p.click('#bulkDelete'); await sleep(200); await clickBtn(p, '删除'); await waitRows(p, 0, '商品库用例清理');
  await p.close();
});

test('商品库查询（云端模式）：同一套逻辑，命中带出；商品库请求不带会话 Cookie', async () => {
  const p = await newPage();
  await loginCloud(p);
  assert.match(await text(p, '#modeBadge'), /云端/);
  let cookieHeader = 'unset';
  await p.setRequestInterception(true);
  p.on('request', (r) => { if (r.url().endsWith('/api/catalog/lookup')) cookieHeader = r.headers()['cookie']; r.continue(); });
  await typeBarcode(p, '9900000000017', 'Enter');
  assert.strictEqual(await val(p, '#fName'), '合成测试饮料');
  assert.match(await text(p, '#lookupHint'), /已从商品库带出名称、分类/);
  assert.ok(cookieHeader === undefined || cookieHeader === '', '商品库请求不应带 Cookie：' + cookieHeader);
  await p.close();
});

test('整个过程没有页面脚本错误', () => { assert.deepStrictEqual(errors, []); });
