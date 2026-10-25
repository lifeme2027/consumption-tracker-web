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

function chromePath() {
  const c = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean);
  const p = c.find((x) => fs.existsSync(x));
  if (!p) throw new Error('找不到 Chrome/Chromium，请设置 CHROME_PATH');
  return p;
}
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

let server, browser, base, dataDir, addr;
const errors = [];

test.before(async () => {
  assert.ok(fs.existsSync(DLL), '先执行 dotnet build -c Release：' + DLL);
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'life-e2e-'));
  addr = execFileSync('python3', [path.join(ROOT, 'scripts', 'gen_address.py')]).toString().trim();
  const port = await freePort(); base = 'http://127.0.0.1:' + port;
  server = spawn('dotnet', [DLL], {
    cwd: path.dirname(DLL),
    env: { ...process.env, ASPNETCORE_ENVIRONMENT: 'Development', Life__Auth__DevLogin: 'true', Life__Storage__DataDir: dataDir, ASPNETCORE_URLS: base },
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
  await p.$eval('#recForm', (f) => { f.reset(); document.getElementById('fDate').value = '2026-10-25'; });
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

test('整个过程没有页面脚本错误', () => { assert.deepStrictEqual(errors, []); });
