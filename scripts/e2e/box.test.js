// /box（ScaleBridge Web 版）真浏览器回归：用 Release 构建的真实站点（Production 环境）打开 /box，
// 检查响应头、控制台零错误零警告、CSP 零违规、不向任何接口发请求、演示数据入库并在刷新后仍在、导出再导入、中英切换、
// navigator.bluetooth 特性检测、不支持浏览器的友好提示 + 演示模式、以及连接超时看门狗的界面表现。
// Chrome 要带 --enable-features=WebBluetooth（Linux 版 Chrome 默认没有 navigator.bluetooth；没开时 Permissions-Policy 的 bluetooth 会在控制台出现
// “Unrecognized feature” 警告，那是浏览器自己的提示，不是站点的问题——所以「零警告」的断言只在开了该特性的主测试里做）。
// 注意：没有任何真实蓝牙硬件参与；真实蓝牙路径在这里不做验证（实验性，未真机验证）。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer-core');

const ROOT = path.join(__dirname, '..', '..');
const DLL = path.join(ROOT, 'src', 'ConsumptionTracker.Web', 'bin', 'Release', 'net8.0', 'ConsumptionTrackerWeb.dll');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BOX_CSP = "default-src 'self'; script-src 'self'; connect-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function chromePath() {
  const c = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean);
  const p = c.find((x) => fs.existsSync(x));
  if (!p) throw new Error('找不到 Chrome/Chromium，请设置 CHROME_PATH');
  return p;
}
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

let server, browser, base, dataDir, dlDir;
const sel = (id) => `[data-testid="${id}"]`;

test.before(async () => {
  assert.ok(fs.existsSync(DLL), '先执行 dotnet build -c Release：' + DLL);
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'box-e2e-'));
  dlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'box-dl-'));
  const port = await freePort(); base = 'http://127.0.0.1:' + port;
  server = spawn('dotnet', [DLL], {
    cwd: path.join(ROOT, 'src', 'ConsumptionTracker.Web'),   // Production 下没有静态资源清单，内容根指到项目目录才能找到 wwwroot
    env: { ...process.env, ASPNETCORE_ENVIRONMENT: 'Production', Life__Storage__DataDir: dataDir, ASPNETCORE_URLS: base },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/healthz')).ok) break; } catch { /* 等待启动 */ } await sleep(200); }
  browser = await puppeteer.launch({ executablePath: chromePath(), args: ['--no-sandbox', '--enable-features=WebBluetooth'], headless: true });
});
test.after(async () => {
  if (browser) await browser.close();
  if (server) server.kill();
  for (const d of [dataDir, dlDir]) try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** 新开一个干净的浏览器上下文（独立的 IndexedDB），收集控制台/CSP/请求信息。 */
async function openBox(opts = {}) {
  const ctx = await browser.createBrowserContext();
  // 下载目录要按浏览器上下文设置（匿名上下文不继承默认上下文的设置）
  await (await browser.target().createCDPSession()).send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir, browserContextId: ctx.id });
  const page = await ctx.newPage();
  const log = { console: [], pageErrors: [], violations: [], requests: [], failed: [] };
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) log.console.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', (e) => log.pageErrors.push(e.message));
  page.on('request', (r) => log.requests.push(r.method() + ' ' + r.url()));
  page.on('requestfailed', (r) => log.failed.push(r.url() + ' ' + r.failure()?.errorText));
  await page.exposeFunction('__report', (v) => log.violations.push(v));
  await page.evaluateOnNewDocument(() => {
    document.addEventListener('securitypolicyviolation', (e) => window.__report(`${e.violatedDirective} ${e.blockedURI}`));
  });
  // 语言默认「跟随浏览器」：固定成中文，测试不依赖运行机器的区域设置
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh'] });
    Object.defineProperty(navigator, 'language', { get: () => 'zh-CN' });
  });
  if (opts.beforeLoad) await page.evaluateOnNewDocument(opts.beforeLoad);
  await page.goto(base + (opts.url ?? '/box'), { waitUntil: 'networkidle0' });
  await page.waitForSelector('html[data-ready="1"]');
  return { ctx, page, log };
}
const text = (p, id) => p.$eval(sel(id), (e) => e.textContent);
const rowCount = (p) => p.$$eval(sel('history-row'), (e) => e.length);
async function waitFor(fn, what, ms = 5000) {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) assert.fail('超时：' + what); await sleep(100); }
}

test('响应头：/box 与 /box/ 都 200；CSP 与 Permissions-Policy 正确；无 Cookie；其它路径不带 bluetooth', async () => {
  for (const u of ['/box', '/box/']) {
    const r = await fetch(base + u, { redirect: 'manual' });
    assert.equal(r.status, 200, u);
    assert.equal(r.headers.get('content-security-policy'), BOX_CSP);
    assert.match(r.headers.get('permissions-policy'), /^bluetooth=\(self\),/);
    assert.equal(r.headers.get('set-cookie'), null);
    assert.equal(r.headers.get('cache-control'), 'no-cache');
  }
  const root = await fetch(base + '/');
  assert.equal(root.headers.get('permissions-policy'), 'camera=(self), microphone=(), geolocation=(), payment=(), usb=()');
  assert.doesNotMatch(root.headers.get('content-security-policy'), /bluetooth/);
});

test('/box 加载：零控制台错误/警告、零 CSP 违规、零失败请求、不向 /api 或外部发任何请求、无 Cookie', async () => {
  const { ctx, page, log } = await openBox();
  assert.deepEqual(log.console, [], '控制台');
  assert.deepEqual(log.pageErrors, []);
  assert.deepEqual(log.violations, []);
  assert.deepEqual(log.failed, []);
  const origins = new Set(log.requests.map((r) => new URL(r.split(' ')[1]).origin));
  assert.deepEqual([...origins], [base]);
  assert.ok(log.requests.every((r) => r.startsWith('GET ')), '只有 GET：' + log.requests.join(' | '));
  assert.ok(!log.requests.some((r) => /\/api\//.test(r)), '不应调用站点数据接口');
  assert.equal((await page.cookies()).length, 0);
  assert.equal(await page.evaluate(() => document.cookie), '');
  await ctx.close();
});

test('Web Bluetooth 特性检测：navigator.bluetooth 存在，getAvailability 可调用；页面按结果提示', async () => {
  const { ctx, page } = await openBox();
  const r = await page.evaluate(async () => ({
    has: 'bluetooth' in navigator,
    fn: typeof navigator.bluetooth?.getAvailability,
    avail: await navigator.bluetooth.getAvailability(),
    watch: typeof BluetoothDevice?.prototype?.watchAdvertisements,
    secure: window.isSecureContext,
  }));
  assert.equal(r.has, true); assert.equal(r.fn, 'function'); assert.equal(typeof r.avail, 'boolean'); assert.equal(r.secure, true);
  const level = await page.$eval(sel('support-msg'), (e) => e.dataset.level);
  assert.ok(['ok', 'noAdapter'].includes(level), level);   // 没有蓝牙适配器时是 noAdapter，这台机器就是
  assert.equal(await page.$eval(sel('btn-connect'), (b) => b.disabled), level !== 'ok');
  // 页面上的「兼容性与限制」说明存在，并带实验性标签
  assert.match(await text(page, 'limits'), /Chromium/);
  assert.match(await page.$eval('body', (b) => b.textContent), /实验性（仅按规范实现，未真机验证）/);
  await ctx.close();
});

test('演示数据：入库、每行标「演示数据」、刷新后仍在；中英切换；导出再导入不重复', async () => {
  const { ctx, page, log } = await openBox();
  assert.equal(await rowCount(page), 0);
  await page.click(sel('demo-si-full'));
  await waitFor(async () => (await rowCount(page)) === 1, '演示记录入库');
  await sleep(1100); // 演示数据的设备时间戳精确到秒，隔 1 秒以免被去重
  await page.click(sel('demo-body-composition'));
  await waitFor(async () => (await rowCount(page)) === 2, '第二条演示记录');
  assert.deepEqual(await page.$$eval(sel('history-row'), (r) => r.map((x) => x.dataset.demo)), ['1', '1']);
  assert.match(await page.$eval(sel('history-rows'), (e) => e.textContent), /演示数据/);
  assert.match(await text(page, 'latest-body'), /演示数据/);
  const kgBefore = await page.$$eval(sel('history-weight'), (r) => r.map((x) => x.closest('tr').dataset.kg));

  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForSelector('html[data-ready="1"]');
  assert.equal(await rowCount(page), 2, '刷新后记录仍在（IndexedDB）');
  assert.deepEqual(await page.$$eval(sel('history-weight'), (r) => r.map((x) => x.closest('tr').dataset.kg)), kgBefore);

  // 语言切换：英文后文案变化并在刷新后保持；切回中文
  await page.select(sel('lang-select'), 'en');
  await waitFor(async () => /History/i.test(await text(page, 'history-h')), '切到英文');
  assert.match(await page.$eval(sel('history-rows'), (e) => e.textContent), /Demo data/i);
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForSelector('html[data-ready="1"]');
  assert.match(await text(page, 'history-h'), /History/i, '语言设置刷新后保持');
  await page.select(sel('lang-select'), 'zh');
  await waitFor(async () => /历史/.test(await text(page, 'history-h')), '切回中文');

  // 导出 JSON 与 CSV（走真实下载）
  for (const kind of ['json', 'csv']) {
    for (const f of fs.readdirSync(dlDir)) fs.rmSync(path.join(dlDir, f));
    await page.click(sel(`btn-export-${kind}`));
    const file = await waitFor(() => fs.readdirSync(dlDir).find((f) => !f.endsWith('.crdownload') && f.endsWith('.' + kind)), `${kind} 下载`);
    const body = fs.readFileSync(path.join(dlDir, file));
    assert.match(file, /demo|演示/i, '文件名带演示标记：' + file);
    if (kind === 'csv') {
      assert.deepEqual([...body.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM');
      assert.ok(body.toString('utf8').includes('\r\n') && !/[^\r]\n/.test(body.toString('utf8')), 'CRLF');
      assert.match(body.toString('utf8'), /演示|demo/i);
    } else {
      const j = JSON.parse(body.toString('utf8'));
      assert.equal(typeof j.version, 'number');
      assert.equal(j.count, 2); assert.equal(j.measurements.length, 2);
      assert.ok(j.measurements.every((r) => r.demo === true || r.demo === 1 || r.demo === '1'), 'JSON 导出每条带 demo 标志');
    }
  }
  // 导出 → 清空 → 再导入（用上面最后一次的 CSV，再用 JSON）
  const jsonText = await (async () => {
    for (const f of fs.readdirSync(dlDir)) fs.rmSync(path.join(dlDir, f));
    await page.click(sel('btn-export-json'));
    const f = await waitFor(() => fs.readdirSync(dlDir).find((x) => x.endsWith('.json')), 'json');
    return fs.readFileSync(path.join(dlDir, f), 'utf8');
  })();
  page.on('dialog', (d) => d.accept());
  await page.click(sel('btn-clear-all'));
  await waitFor(async () => (await rowCount(page)) === 0, '清空');
  await page.$eval(sel('import-text'), (e, v) => { e.value = v; }, jsonText);
  await page.click(sel('btn-import'));
  await waitFor(async () => (await rowCount(page)) === 2, '导入后 2 条');
  assert.deepEqual(await page.$$eval(sel('history-weight'), (r) => r.map((x) => x.closest('tr').dataset.kg)), kgBefore, '数值逐条一致');
  assert.deepEqual(await page.$$eval(sel('history-row'), (r) => r.map((x) => x.dataset.demo)), ['1', '1'], '导入后仍标演示数据');
  // 再导入一次：全部判重，不新增
  await page.click(sel('btn-import'));
  await sleep(500);
  assert.equal(await rowCount(page), 2, '重复导入不产生重复记录');
  assert.deepEqual(log.console, []); assert.deepEqual(log.violations, []); assert.deepEqual(log.pageErrors, []);
  assert.ok(!log.requests.some((r) => /\/api\//.test(r)));
  await ctx.close();
});

test('不支持 Web Bluetooth 的浏览器：友好提示 + 演示数据与导入导出仍可用', async () => {
  const { ctx, page, log } = await openBox({ beforeLoad: () => { delete Navigator.prototype.bluetooth; try { delete navigator.bluetooth; } catch { /* */ } } });
  assert.equal(await page.evaluate(() => 'bluetooth' in navigator), false);
  assert.equal(await page.$eval(sel('support-msg'), (e) => e.dataset.level), 'noApi');
  assert.match(await text(page, 'support-msg'), /不可用|没有|不支持|Web Bluetooth/);
  assert.match(await text(page, 'support-msg'), /演示数据/);
  assert.equal(await page.$eval(sel('btn-connect'), (b) => b.disabled), true);
  await page.click(sel('demo-imperial'));
  await waitFor(async () => (await rowCount(page)) === 1, '不支持时演示数据仍可入库');
  assert.equal(await page.$eval(sel('history-row'), (r) => r.dataset.demo), '1');
  assert.deepEqual(log.pageErrors, []); assert.deepEqual(log.violations, []);
  await ctx.close();
});

test('连接看门狗（用桩 Bluetooth，不涉及真实硬件）：connect 永远挂起 → 约 9 秒后提示超时，可重试；选择器只在点击时出现', async () => {
  const { ctx, page } = await openBox({
    beforeLoad: () => {
      window.__chooser = 0;
      const dev = { id: 'stub', name: 'Stub', addEventListener() {}, removeEventListener() {}, gatt: { connected: false, connect: () => new Promise(() => {}), disconnect() {} } };
      Object.defineProperty(navigator, 'bluetooth', { configurable: true, value: { getAvailability: async () => true, requestDevice: async () => { window.__chooser++; return dev; } } });
    },
  });
  assert.equal(await page.evaluate(() => window.__chooser), 0, '加载时不弹选择器');
  assert.equal(await page.$eval(sel('btn-connect'), (b) => b.disabled), false);
  await page.click(sel('btn-connect'));
  assert.equal(await page.evaluate(() => window.__chooser), 1);
  await waitFor(async () => (await page.$eval(sel('conn-state'), (e) => e.dataset.state)) === 'connecting', '进入连接中', 3000);
  await waitFor(async () => (await page.$eval(sel('conn-error'), (e) => e.dataset.code ?? '')) === 'timeout', '超时提示', 14000);
  assert.ok((await text(page, 'conn-error')).length > 0);
  assert.match(await page.$eval(sel('conn-state'), (e) => e.dataset.state), /disconnected|idle/);
  assert.equal(await page.$eval(sel('btn-connect'), (b) => b.disabled), false, '超时后可以重试');
  await ctx.close();
});
