const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { WW, L, openStore, rec, backup, full } = require('./helpers');
const { ModeController } = require(path.join(WW, 'life-mode.js'));
const { RemoteStore } = require(path.join(WW, 'life-remote.js'));

function mem() { const m = {}; return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, m }; }
function mk(opts = {}) {
  const net = []; const storage = opts.storage || mem();
  const fetch = async (url, init) => { net.push(init.method + ' ' + url); return opts.fetch ? opts.fetch(url, init) : { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ records: [] }) }; };
  return openStore().then((local) => {
    const mc = new ModeController({ local, storage, makeRemote: () => new RemoteStore({ fetch, onUnauthorized: () => mc.sessionExpired() }),
      probe: opts.probe || (async () => { net.push('GET /api/auth/me'); throw new Error('401'); }) });
    return { mc, local, net, storage };
  });
}

test('默认本地模式：init 不发任何网络请求，所有功能直接可用', async () => {
  const { mc, net } = await mk();
  const seen = []; mc.onChange((e) => seen.push(e));
  assert.strictEqual(await mc.init(), 'local');
  assert.strictEqual(mc.mode, 'local'); assert.strictEqual(mc.store.kind, 'local'); assert.strictEqual(mc.address, null);
  await mc.store.add(rec()); assert.strictEqual((await mc.store.query({})).count, 1);
  assert.deepStrictEqual(net, []);
  assert.deepStrictEqual(seen.map((e) => e.mode), ['local']);
});

test('登录后切到云端：同一接口改走服务端；不自动同步，本地数据原样保留', async () => {
  const { mc, local, net, storage } = await mk();
  await local.add(rec({ name: '本地的' }));
  await mc.init();
  mc.loginSucceeded('kaspa:qq1');
  assert.strictEqual(mc.mode, 'cloud'); assert.strictEqual(mc.address, 'kaspa:qq1'); assert.strictEqual(mc.store.kind, 'remote');
  assert.deepStrictEqual(net, []);                       // 登录本身之后没有任何记录请求/自动上传
  await mc.store.query({});
  assert.deepStrictEqual(net, ['POST /api/records/query']);
  assert.strictEqual((await local.query({})).count, 1);  // 本地数据仍在
  assert.strictEqual(storage.m['life.mode'], 'cloud');
});

test('退出云端 / 会话过期：回到本地模式，作废会话失败也照样退出，本地数据不动', async () => {
  const a = await mk(); await a.local.add(rec());
  await a.mc.init(); a.mc.loginSucceeded('x');
  let called = 0;
  await a.mc.logout(async () => { called++; throw new Error('网络断了'); });
  assert.strictEqual(called, 1); assert.strictEqual(a.mc.mode, 'local'); assert.strictEqual(a.mc.store.kind, 'local');
  assert.strictEqual((await a.mc.store.query({})).count, 1); assert.strictEqual(a.storage.m['life.mode'], 'local');

  const b = await mk({ fetch: () => ({ ok: false, status: 401, headers: { get: () => 'application/json' }, json: async () => ({ error: '未登录或会话已过期' }) }) });
  const reasons = []; b.mc.onChange((e) => reasons.push(e.reason));
  await b.mc.init(); b.mc.loginSucceeded('x');
  await assert.rejects(() => b.mc.store.meta(), /会话已过期/);
  assert.strictEqual(b.mc.mode, 'local'); assert.deepStrictEqual(reasons.slice(-2), ['login', 'expired']);
  const n = reasons.length; b.mc.sessionExpired(); assert.strictEqual(reasons.length, n);   // 本地模式下 sessionExpired 无动作
});

test('上次是云端：init 才探测会话；会话有效回云端，失效回本地并记住', async () => {
  const st1 = mem(); st1.setItem('life.mode', 'cloud');
  const ok = await mk({ storage: st1, probe: async () => ({ address: 'kaspa:qq9' }) });
  assert.strictEqual(await ok.mc.init(), 'cloud'); assert.strictEqual(ok.mc.address, 'kaspa:qq9');
  const st2 = mem(); st2.setItem('life.mode', 'cloud');
  const bad = await mk({ storage: st2 });
  assert.strictEqual(await bad.mc.init(), 'local'); assert.deepStrictEqual(bad.net, ['GET /api/auth/me']); assert.strictEqual(st2.m['life.mode'], 'local');
});

test('localStorage 不可用（隐私模式）也能正常用本地模式', async () => {
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  const { mc } = await mk({ storage: broken });
  assert.strictEqual(await mc.init(), 'local'); mc.loginSucceeded('a'); await mc.logout(); assert.strictEqual(mc.mode, 'local');
});

test('显式「从账户下载到本地」「上传本地到账户」的数据通路：合并/覆盖语义、预检不丢数据', async () => {
  const cloud = await openStore();                 // 用另一个本地库模拟“云端”导出/导入
  await cloud.add(rec({ name: '云端药', date: '2026-10-02' }));
  const { local } = await mk();
  await local.add(rec({ name: '本地奶', date: '2026-10-03' }));
  // 下载（合并）：本地保留，云端的并入
  const dl = await local.importText(await cloud.exportJson(), 'merge');
  assert.strictEqual(dl.added, 1); assert.strictEqual((await local.query({})).count, 2);
  // 再合并一次：不重复
  assert.strictEqual((await local.importText(await cloud.exportJson(), 'merge')).added, 0);
  assert.strictEqual((await local.query({})).count, 2);
  // 下载（覆盖）：云端导出有坏记录 → 预检拒绝，本地原样
  const poisoned = backup([full({ id: 'p1', note: 'x'.repeat(1001) })]);
  await assert.rejects(() => local.importText(poisoned, 'replace'), /导入已中止/);
  assert.strictEqual((await local.query({})).count, 2);
  // 覆盖成功：本地变成与云端一致
  await local.importText(await cloud.exportJson(), 'replace');
  assert.deepStrictEqual((await local.query({})).records.map((r) => r.name), ['云端药']);
});
