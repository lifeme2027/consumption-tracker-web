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
  if (opts.beforeLoad) await page.evaluateOnNewDocument(opts.beforeLoad, opts.args);
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

// ---------------------------------------------------------------------------------------------------------------------
// 验收后修复的回归（SBW-M01 / L01 / L02 / L03 / L04）
// ---------------------------------------------------------------------------------------------------------------------
const reflow = (p) => p.evaluate(() => ({
  scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth,
  bodyScroll: document.body.scrollWidth, inner: window.innerWidth,
}));

test('SBW-M01 窄屏（320/360/390）整页不横向滚动：初始、有历史记录、长设备名、展开调试面板、隐私页', async () => {
  const longName = 'ScaleBridge-' + 'X'.repeat(70);   // 没有空格的超长设备名
  const { ctx, page } = await openBox({
    beforeLoad: (name) => {
      const dev = { id: 'stub', name, addEventListener() {}, removeEventListener() {}, gatt: { connected: false, connect: () => new Promise(() => {}), disconnect() {} } };
      Object.defineProperty(navigator, 'bluetooth', { configurable: true, value: { getAvailability: async () => true, requestDevice: async () => dev } });
    },
    args: longName,
  });
  const numbers = {};
  const check = async (what) => {
    for (const w of [320, 360, 390]) {
      await page.setViewport({ width: w, height: 800 });
      await sleep(50);
      const r = await reflow(page);
      numbers[`${what}@${w}`] = `${r.scroll}/${r.client}`;
      assert.ok(r.scroll <= r.client, `${what} @${w}px：documentElement.scrollWidth ${r.scroll} > clientWidth ${r.client}`);
      assert.ok(r.bodyScroll <= r.client, `${what} @${w}px：body.scrollWidth ${r.bodyScroll} > clientWidth ${r.client}`);
    }
  };
  await check('初始');
  // 多条历史记录（表格在自己的容器里滚动，不能撑宽页面）
  for (const d of ['demo-si-full', 'demo-body-composition', 'demo-imperial', 'demo-si-basic']) {
    const n = await rowCount(page);
    await page.click(sel(d));
    await waitFor(async () => (await rowCount(page)) > n, d);
  }
  await check('有历史记录');
  // 展开调试面板 + 很长的十六进制输入 + 设置里的备注
  await page.$eval(sel('debug') + ' details', (d) => { d.open = true; });
  await page.$eval(sel('dbg-hex'), (e, v) => { e.value = v; }, 'AB'.repeat(250));
  await page.$eval(sel('import-text'), (e, v) => { e.value = v; }, 'x'.repeat(400));
  await check('调试面板展开');
  // 连接中的设备名（超长且无空格）
  await page.click(sel('btn-connect'));
  await waitFor(async () => (await page.$eval(sel('conn-state'), (e) => e.dataset.state)) === 'connecting', '连接中', 3000);
  assert.ok((await text(page, 'conn-device')).includes(longName), '界面确实显示了超长设备名');
  await check('长设备名');
  // 导入结果里的长错误文字
  await page.$eval(sel('import-text'), (e, v) => { e.value = v; }, '{"' + 'k'.repeat(300) + '":1}');
  await page.click(sel('btn-import'));
  await sleep(300);
  await check('导入失败提示');
  await page.goto(base + '/box/privacy.html', { waitUntil: 'networkidle0' });
  await page.waitForSelector('html[data-ready="1"]');
  await check('隐私页');
  console.log('reflow scrollWidth/clientWidth:', JSON.stringify(numbers));
  await ctx.close();
});

test('SBW-L01 非安全上下文：显示「需要 HTTPS」（navigator.bluetooth 此时不存在），连接按钮禁用，演示数据仍可用', async () => {
  const { ctx, page } = await openBox({
    beforeLoad: () => {
      Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
      delete Navigator.prototype.bluetooth; try { delete navigator.bluetooth; } catch { /* */ }   // [SecureContext]：非安全上下文里没有它
    },
  });
  assert.equal(await page.evaluate(() => [window.isSecureContext, 'bluetooth' in navigator]).then((a) => a.join()), 'false,false');
  assert.equal(await page.$eval(sel('support-msg'), (e) => e.dataset.level), 'insecure');
  assert.match(await text(page, 'support-msg'), /HTTPS/);
  assert.equal(await page.$eval(sel('btn-connect'), (b) => b.disabled), true);
  await page.click(sel('demo-si-basic'));
  await waitFor(async () => (await rowCount(page)) === 1, '非安全上下文下演示数据仍可入库');
  await page.select(sel('lang-select'), 'en');
  await waitFor(async () => /HTTPS/.test(await text(page, 'support-msg')) && !/[\u4e00-\u9fff]/.test(await text(page, 'support-msg')), '英文提示');
  await ctx.close();
});

test('SBW-L01 真实的非安全上下文：经由非回环 IP 的 http 访问（Chrome 视为不安全，navigator.bluetooth 不存在）', async (t) => {
  const ip = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
  if (!ip) return t.skip('这台机器没有非回环 IPv4 地址');
  const port = await freePort();
  const srv = spawn('dotnet', [DLL], {
    cwd: path.join(ROOT, 'src', 'ConsumptionTracker.Web'),
    env: { ...process.env, ASPNETCORE_ENVIRONMENT: 'Production', Life__Storage__DataDir: dataDir, ASPNETCORE_URLS: `http://0.0.0.0:${port}` },
    stdio: 'ignore',
  });
  try {
    const url = `http://${ip}:${port}`;
    for (let i = 0; i < 100; i++) { try { if ((await fetch(url + '/healthz')).ok) break; } catch { /* 等待启动 */ } await sleep(200); }
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.goto(url + '/box', { waitUntil: 'networkidle0' });
    await page.waitForSelector('html[data-ready="1"]');
    assert.equal(await page.evaluate(() => [window.isSecureContext, 'bluetooth' in navigator].join()), 'false,false');
    assert.equal(await page.$eval(sel('support-msg'), (e) => e.dataset.level), 'insecure');
    assert.match(await text(page, 'support-msg'), /HTTPS/);
    await ctx.close();
  } finally { srv.kill(); }
});

test('SBW-L02 conn-info 是 aria-live=polite；状态不变时不重写 DOM（不重复播报）', async () => {
  const { ctx, page } = await openBox();
  assert.equal(await page.$eval(sel('conn-info'), (e) => e.getAttribute('aria-live')), 'polite');
  assert.equal(await page.$eval(sel('conn-info'), (e) => e.getAttribute('aria-atomic')), null, '不用 aria-atomic，避免整段重读');
  await page.$eval(sel('conn-info'), (e) => { window.__mut = 0; new MutationObserver((l) => { window.__mut += l.length; }).observe(e, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['aria-live'] }); });
  await page.click(sel('demo-si-basic'));
  await waitFor(async () => (await rowCount(page)) === 1, '演示记录');
  await page.select(sel('set-unit'), 'lb');   // 触发整页重渲染
  await sleep(300);
  assert.equal(await page.evaluate(() => window.__mut), 0, '没有连接信息变化时，conn-info 不应被改写');
  await ctx.close();
});

test('SBW-L03 删除记录后焦点不丢：落到下一行的删除按钮 / 最后一行 / 「历史记录」标题；清空后同理', async () => {
  const { ctx, page } = await openBox();
  page.on('dialog', (d) => d.accept());
  for (const d of ['demo-si-full', 'demo-body-composition', 'demo-imperial']) {
    const n = await rowCount(page);
    await page.click(sel(d));
    await waitFor(async () => (await rowCount(page)) > n, d);
  }
  const ids = () => page.$$eval(sel('history-row'), (r) => r.map((x) => x.dataset.id));
  const active = () => page.evaluate(() => ({ id: document.activeElement?.id, tag: document.activeElement?.tagName, rowId: document.activeElement?.closest?.('tr')?.dataset.id, testid: document.activeElement?.dataset?.testid }));
  const rows = await ids();
  assert.equal(rows.length, 3);
  // 删中间一行：焦点在原位置（现在是原来的第 3 行）的删除按钮上
  await page.click(`${sel('history-row')}[data-id="${rows[1]}"] ${sel('history-delete')}`);
  await waitFor(async () => (await rowCount(page)) === 2, '删除后 2 行');
  let a = await active();
  assert.deepEqual([a.tag, a.testid, a.rowId], ['BUTTON', 'history-delete', rows[2]], '焦点应在下一行的删除按钮：' + JSON.stringify(a));
  // 删最后一行：焦点到新的最后一行
  await page.click(`${sel('history-row')}[data-id="${rows[2]}"] ${sel('history-delete')}`);
  await waitFor(async () => (await rowCount(page)) === 1, '删除后 1 行');
  a = await active();
  assert.deepEqual([a.tag, a.testid, a.rowId], ['BUTTON', 'history-delete', rows[0]], '焦点应在剩下那行的删除按钮：' + JSON.stringify(a));
  // 删光：焦点到「历史记录」标题（可聚焦，tabindex=-1）
  await page.click(`${sel('history-row')} ${sel('history-delete')}`);
  await waitFor(async () => (await rowCount(page)) === 0, '删光');
  a = await active();
  assert.equal(a.id, 'history-h', '没有行时焦点到标题：' + JSON.stringify(a));
  assert.equal(await page.$eval(sel('history-h'), (e) => e.getAttribute('tabindex')), '-1', '标题不进 Tab 顺序');
  // 「清空全部」：按钮被禁用后焦点不能留在它上面或 <body>
  await page.click(sel('demo-si-full'));
  await waitFor(async () => (await rowCount(page)) === 1, '一条');
  await page.focus(sel('btn-clear-all'));
  await page.keyboard.press('Enter');
  await waitFor(async () => (await rowCount(page)) === 0, '清空');
  a = await active();
  assert.equal(a.id, 'history-h', '清空后焦点：' + JSON.stringify(a));
  // 「清除演示数据」同理
  await page.click(sel('demo-si-full'));
  await waitFor(async () => (await rowCount(page)) === 1, '一条');
  await page.focus(sel('btn-clear-demo'));
  await page.keyboard.press('Enter');
  await waitFor(async () => (await rowCount(page)) === 0, '清演示');
  a = await active();
  assert.equal(a.id, 'history-h', '清演示数据后焦点：' + JSON.stringify(a));
  await ctx.close();
});

test('SBW-L04 切换语言：已经生成的状态消息（导出/导入/备注/调试）跟着变，不停留在旧语言', async () => {
  const { ctx, page } = await openBox();
  const cjk = /[\u4e00-\u9fff]/;
  await page.click(sel('demo-si-full'));
  await waitFor(async () => (await rowCount(page)) === 1, '演示记录');
  await page.click(sel('btn-export-csv'));
  await waitFor(async () => (await text(page, 'export-msg')).length > 0, '导出提示');
  await page.$eval(sel('note-id'), (e) => { e.value = '999'; });
  await page.click(sel('btn-note-save'));
  await waitFor(async () => (await text(page, 'note-msg')).length > 0, '备注提示');
  await page.$eval(sel('debug') + ' details', (d) => { d.open = true; });
  await page.$eval(sel('dbg-hex'), (e) => { e.value = 'zz'; });
  await page.click(sel('btn-dbg-parse'));
  await waitFor(async () => (await text(page, 'dbg-out')).length > 0, '调试输出');
  await page.$eval(sel('import-text'), (e) => { e.value = '{"x":1}'; });
  await page.click(sel('btn-import'));
  await waitFor(async () => (await text(page, 'import-result')).length > 0, '导入提示');
  const ids = ['export-msg', 'note-msg', 'dbg-out', 'import-result'];
  const zhTexts = {};
  for (const id of ids) { zhTexts[id] = await text(page, id); assert.match(zhTexts[id], cjk, `${id} 起始应是中文：${zhTexts[id]}`); }

  await page.select(sel('lang-select'), 'en');
  await waitFor(async () => /History/i.test(await text(page, 'history-h')), '切到英文');
  const enTexts = {};
  for (const id of ids) {
    enTexts[id] = await text(page, id);
    assert.ok(enTexts[id].length > 0, `${id} 切换语言后不应被清空`);
    assert.doesNotMatch(enTexts[id], cjk, `${id} 切到英文后仍有中文：${enTexts[id]}`);
    assert.notEqual(enTexts[id], zhTexts[id]);
  }
  // 英文里带参数的消息参数值保持不变（文件名、行数等）
  assert.match(enTexts['export-msg'], /\.csv/);

  await page.select(sel('lang-select'), 'zh');
  await waitFor(async () => /历史/.test(await text(page, 'history-h')), '切回中文');
  for (const id of ids) assert.equal(await text(page, id), zhTexts[id], `${id} 切回中文后应还原`);
  await ctx.close();
});
