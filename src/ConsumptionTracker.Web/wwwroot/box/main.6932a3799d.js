// ScaleBridge Web 入口：把存储、解析管线、蓝牙控制器与界面接起来。
// 约束：不用 innerHTML（只用 textContent）；不用 Web Worker；不发任何网络请求；解析与 IndexedDB 都在主线程。
import { applyDom, makeT, resolveLang } from './i18n/index.3841b75def.js';
import { openStore } from './core/store.f1047b4f3e.js';
import { detectSupport, getAvailability, supportLevel } from './core/detect.5311386e43.js';
import { ConnectionController } from './core/ble.62cdfcf5ad.js';
import { DEMO_DEVICE, DEMO_SCENARIOS } from './core/fake.0c2e641913.js';
import { processValue } from './core/pipeline.add5d7a784.js';
import { compareRecords } from './core/measurement.0911573984.js';
import { toCsv, toJson, exportFileName } from './core/export.d16d97726f.js';
import { importAuto, readFileText } from './core/import.d285109adc.js';
import { parseHex } from './core/bytes.ae517095e7.js';
import { parseCharacteristic } from './core/protocol.19124bbe03.js';
import { detailRows, tagFor, timeText, weightText } from './core/view.19f30d22f8.js';
import { decideIngest, isAbnormal, isDeviceClockSuspect } from './core/policy.bc3a5a457f.js';
import { msg, renderMsg, renderParts } from './core/status.1d415fe78d.js';
import { BUILD } from './build-info.6e32affd22.js';

const $ = (id) => document.getElementById(id);
const MAX_ROWS = 300;
const MAX_REJECT_LINES = 20;

const S = {
  store: null,
  settings: { displayUnit: 'kg', lang: 'auto', userNotes: {} },
  records: [],
  lang: 'en',
  t: makeT('en'),
  support: null,
  availability: null,
  conn: { state: 'idle', params: {} },
  connError: null,
  connInfo: [],
  info: null,
  storeError: null, // 消息 {key, params}，不是已翻译的字符串
  // 已生成的状态消息：存「键 + 参数」，切换语言时按新语言重渲染（SBW-L04）。
  msgs: { export: null, note: null },
  importResult: null, // importAuto / readFileText 的结果对象，按当前语言渲染
  dbgParts: [], // 调试面板输出：字符串（JSON 原文）或消息
  ctl: null,
};

function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else e.setAttribute(k, v);
  }
  for (const c of children) e.append(c);
  return e;
}
const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); };

/* ---------- 渲染 ---------- */

function renderSupport() {
  const { t, support: s } = S;
  const level = supportLevel(s, S.availability);
  $('support-msg').textContent = t(`support.${level}`);
  $('support-msg').dataset.level = level; // ok | noApi | insecure | noAdapter，供自动化测试读取
  const yn = (b) => t(b ? 'support.yes' : 'support.no');
  const avail = S.availability === null ? t('support.unknown') : t(`support.avail.${S.availability}`);
  const list = $('support-detail');
  clear(list);
  for (const text of [
    t('support.detail.bluetooth', { v: yn(s.hasBluetooth) }),
    t('support.detail.secure', { v: yn(s.secureContext) }),
    t('support.detail.availability', { v: s.hasGetAvailability ? avail : t('support.unknown') }),
    t('support.detail.watch', { v: yn(s.hasWatchAdvertisements) }),
    t('support.detail.idb', { v: yn(s.hasIndexedDB) }),
  ]) list.append(el('li', { text }));
}

function renderConnection() {
  const { t, conn } = S;
  const st = conn.state;
  $('conn-state').textContent = t(`connect.state.${st}`, conn.params);
  $('conn-state').dataset.state = st; // 稳定的状态值，供自动化测试读取（与界面语言无关）
  const busy = ['requesting', 'connecting', 'connected', 'reconnecting'].includes(st);
  const usable = S.support.hasBluetooth && S.support.secureContext && S.availability !== false;
  $('btn-connect').disabled = busy || !usable;
  $('chk-all').disabled = busy || !usable;
  $('btn-reconnect').hidden = !(S.ctl?.device && !busy);
  $('btn-disconnect').hidden = !['connecting', 'connected', 'reconnecting'].includes(st);
  const dev = S.ctl?.device;
  $('conn-device').textContent = dev ? ' · ' + t('connect.device', { name: dev.name || t('connect.deviceUnnamed') }) : '';
  const e = S.connError;
  $('conn-error').textContent = e
    ? t(`err.${e.code}`, e.params) + (e.detail && ['unknown', 'network', 'notAllowed'].includes(e.code) ? ' ' + t('err.detail', { detail: e.detail }) : '')
    : '';
  if (e) $('conn-error').dataset.code = e.code; else delete $('conn-error').dataset.code;
  const info = $('conn-info');
  const lines = [];
  if (S.info) lines.push(t('connect.info', { manufacturer: S.info.manufacturer ?? t('connect.unknownValue'), model: S.info.model ?? t('connect.unknownValue') }));
  for (const l of S.connInfo) lines.push(t(l.key, l.params));
  // conn-info 是 aria-live="polite" 区域：内容没变就不要重写 DOM（renderConnection 在每次状态变化时都会被调用），否则读屏会反复播报同一段话。
  const sig = lines.join('\n');
  if (info.dataset.sig === sig) return;
  info.dataset.sig = sig;
  clear(info);
  lines.forEach((text, i) => { if (i) info.append(el('br')); info.append(text); });
}

function demoLabel() { return S.t('tag.demo'); }

function renderLatest() {
  const { t } = S;
  const body = $('latest-body');
  clear(body);
  if (S.records.length === 0) { body.append(el('p', { class: 'muted', text: t('latest.empty') })); return; }
  const rec = [...S.records].sort(compareRecords).at(-1);
  const head = el('p', { class: 'big', id: 'latest-weight', 'data-testid': 'latest-weight', 'data-kg': rec.weightKg ?? '', 'data-demo': rec.demo ? '1' : '0', text: weightText(rec, S.settings.displayUnit, t) });
  body.append(head);
  if (rec.demo) body.append(el('p', {}, el('span', { class: 'tag-demo', text: demoLabel() })));
  for (const [on, key] of [[isAbnormal(rec), 'tag.abnormal'], [isDeviceClockSuspect(rec), 'tag.clockSuspect']]) {
    if (on) body.append(el('p', {}, el('span', { class: 'tag-warn', 'data-testid': key, text: t(key) })));
  }
  const dl = el('dl', { class: 'fields' });
  for (const [k, v] of detailRows(rec, S.settings.displayUnit, t, S.settings.userNotes)) {
    dl.append(el('dt', { text: t(k) }), el('dd', { text: v }));
  }
  body.append(dl);
}

function renderHistory() {
  const { t } = S;
  const rows = $('history-rows');
  clear(rows);
  const sorted = [...S.records].sort(compareRecords).reverse();
  const demo = sorted.filter((r) => r.demo).length;
  $('history-count').textContent = t('history.count', { n: sorted.length, demo })
    + (sorted.length > MAX_ROWS ? ' ' + t('history.truncated', { n: MAX_ROWS }) : '');
  $('history-empty').hidden = sorted.length > 0;
  $('history-table').hidden = sorted.length === 0;
  $('btn-clear-demo').disabled = demo === 0;
  $('btn-clear-all').disabled = sorted.length === 0;
  for (const r of sorted.slice(0, MAX_ROWS)) {
    const time = timeText(r);
    const tag = el('span', { class: r.demo ? 'tag-demo' : '', text: t(tagFor(r)) });
    const src = el('td', {}, tag, ` ${t(`src.${r.source}`)}`);
    for (const [on, key] of [[isAbnormal(r), 'tag.abnormal'], [isDeviceClockSuspect(r), 'tag.clockSuspect']]) {
      if (on) src.append(' ', el('span', { class: 'tag-warn', 'data-testid': key, text: t(key) }));
    }
    const del = el('button', { type: 'button', 'data-testid': 'history-delete', 'data-id': String(r.id), 'aria-label': t('history.deleteAria', { time }), text: t('history.delete') });
    rows.append(el('tr', { 'data-testid': 'history-row', 'data-id': String(r.id), 'data-kg': r.weightKg ?? '', 'data-demo': r.demo ? '1' : '0' },
      el('td', { text: time }),
      el('td', { 'data-testid': 'history-weight', text: weightText(r, S.settings.displayUnit, t) }),
      el('td', { text: r.bmi ?? '—' }),
      el('td', { text: r.bodyFatPercent === null ? '—' : `${r.bodyFatPercent} ${t('u.percent')}` }),
      src,
      el('td', {}, del)));
  }
  const warn = $('store-warning');
  const text = S.storeError ? renderMsg(t, S.storeError) : (S.store && !S.store.persistent ? t('store.memoryOnly') : null);
  warn.hidden = !text;
  warn.textContent = text ?? '';
}

function renderDemoButtons() {
  const box = $('demo-buttons');
  clear(box);
  for (const sc of DEMO_SCENARIOS) {
    box.append(el('button', { type: 'button', 'data-testid': `demo-${sc.id}`, 'data-scenario': sc.id, text: S.t('demo.add', { name: S.t(`demo.s.${sc.id}`) }) }));
  }
}

function renderLimits() {
  const ul = $('limits-list');
  clear(ul);
  for (let i = 1; i <= 9; i++) ul.append(el('li', { text: S.t(`limits.item${i}`) }));
}

function renderNotes() {
  const { t } = S;
  const ul = $('note-list');
  clear(ul);
  const ids = Object.keys(S.settings.userNotes).sort((a, b) => a - b);
  if (ids.length === 0) { ul.append(el('li', { class: 'muted', text: t('settings.noteEmpty') })); return; }
  for (const id of ids) {
    ul.append(el('li', {},
      t('settings.noteItem', { id, text: S.settings.userNotes[id] }), ' ',
      el('button', { type: 'button', 'data-note': id, text: t('settings.noteDelete') })));
  }
}

/** 导出 / 备注 / 导入结果 / 调试输出：全部由「键 + 参数」按当前语言渲染。 */
function renderStatus() {
  // 这几个元素是 role="status"：文字没变就不要重写，避免读屏重复播报。
  for (const [id, text] of [['export-msg', renderMsg(S.t, S.msgs.export)], ['note-msg', renderMsg(S.t, S.msgs.note)], ['dbg-out', renderParts(S.t, S.dbgParts)]]) {
    const node = $(id);
    if (node.textContent !== text) node.textContent = text;
  }
}

function renderAll() {
  applyDom(document, S.t, S.lang);
  $('lang-select').value = S.settings.lang;
  $('set-unit').value = S.settings.displayUnit;
  $('build-info').textContent = `${BUILD.version} (${BUILD.commit})`;
  renderSupport();
  renderConnection();
  renderDemoButtons();
  renderLatest();
  renderHistory();
  renderLimits();
  renderNotes();
  renderStatus();
  renderImportResult(S.importResult);
}

/* ---------- 数据 ---------- */

async function reload() {
  S.records = await S.store.all();
  renderLatest();
  renderHistory();
}

/** 实时来源（蓝牙 / 演示）的入库策略：体重 0 不入库、去重（NOTES Q13/Q16）。返回 'save'|'zero'|'duplicate'|'failed'。 */
async function ingestLive(rec) {
  const decision = decideIngest(rec, S.records);
  if (decision !== 'save') return decision;
  return (await addRecords([rec])) ? 'save' : 'failed';
}

async function addRecords(recs) {
  try {
    await S.store.add(recs);
    S.storeError = null;
  } catch (e) {
    S.storeError = msg('store.writeFailed', { detail: String(e?.message ?? e) });
    renderHistory();
    return false;
  }
  await reload();
  return true;
}

async function setSetting(key, value) {
  S.settings[key] = value;
  try { await S.store.setSetting(key, value); } catch (e) { S.storeError = msg('store.writeFailed', { detail: String(e?.message ?? e) }); }
}

function setLang(pref) {
  S.settings.lang = pref;
  S.lang = resolveLang(pref, navigator.languages ?? [navigator.language]);
  S.t = makeT(S.lang);
}

/* ---------- 蓝牙 ---------- */

function wireBluetooth() {
  const ctl = new ConnectionController({ bluetooth: S.support.hasBluetooth ? navigator.bluetooth : undefined });
  S.ctl = ctl;
  ctl.on('state', ({ state, attempt, max }) => {
    S.conn = { state, params: { attempt, max } };
    if (state === 'connecting' || state === 'connected') S.connError = null;
    renderConnection();
  });
  ctl.on('error', ({ code, detail, attempt, step, timeoutMs }) => {
    S.connError = { code, detail, params: { attempt, step: step ?? '', sec: timeoutMs ? Math.round(timeoutMs / 1000) : '' } };
    renderConnection();
  });
  ctl.on('device', () => { S.info = null; S.connInfo = []; renderConnection(); });
  ctl.on('info', (i) => { S.info = i; renderConnection(); });
  ctl.on('feature', ({ service, hex }) => {
    S.connInfo = [...S.connInfo.filter((x) => x.params?.svc !== `0x${service.toString(16).toUpperCase()}`),
      { key: 'connect.feature', params: { svc: `0x${service.toString(16).toUpperCase()}`, hex } }];
    renderConnection();
  });
  ctl.on('record', async ({ record }) => {
    const r = await ingestLive(record);
    if (r !== 'failed') { S.connInfo = [{ key: r === 'save' ? 'connect.saved' : `ingest.${r}`, params: {} }]; renderConnection(); }
  });
  ctl.on('unsuccessful', () => { S.connInfo = [{ key: 'connect.unsuccessful', params: {} }]; renderConnection(); });
  ctl.on('parseError', ({ errorCode, hex }) => { S.connInfo = [{ key: 'connect.parseError', params: { code: errorCode, hex } }]; renderConnection(); });
}

/* ---------- 导出 / 导入 ---------- */

function download(name, mime, text) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function doExport(kind) {
  if (S.records.length === 0) { S.msgs.export = msg('io.exportNone'); renderStatus(); return; }
  const recs = [...S.records].sort(compareRecords);
  const hasDemo = recs.some((r) => r.demo);
  const now = new Date();
  const name = exportFileName(kind, now, hasDemo);
  if (kind === 'csv') download(name, 'text/csv;charset=utf-8', toCsv(recs));
  else download(name, 'application/json;charset=utf-8', toJson(recs, now));
  S.msgs.export = msg(hasDemo ? 'io.exportedDemo' : 'io.exported', { n: recs.length, file: name });
  renderStatus();
}

function renderImportResult(res) {
  const { t } = S;
  const box = $('import-result');
  clear(box);
  if (!res) return;
  if (!res.ok) {
    box.append(el('p', { class: 'error', text: t('io.importFailed', { reason: t(`io.fatal.${res.error}`) }) }));
    return;
  }
  box.append(el('p', { text: t('io.importDone', { added: res.added, dup: res.duplicates, rej: res.rejected.length, total: res.total }) }));
  if (res.unknownColumns?.length) box.append(el('p', { class: 'muted', text: t('io.unknownColumns', { cols: res.unknownColumns.join(', ') }) }));
  if (res.rejected.length) {
    const ul = el('ul');
    for (const r of res.rejected.slice(0, MAX_REJECT_LINES)) {
      ul.append(el('li', { text: t('io.rejectedRow', { row: r.row, reason: t(`io.row.${r.error}`), field: r.field ? t('io.row.field', { f: r.field }) : '' }) }));
    }
    if (res.rejected.length > MAX_REJECT_LINES) ul.append(el('li', { text: t('io.rejectedMore', { n: res.rejected.length - MAX_REJECT_LINES }) }));
    box.append(ul);
  }
}

async function doImport(text) {
  const res = importAuto(text, S.records);
  if (res.ok) {
    res.added = 0;
    if (res.records.length > 0) {
      if (!(await addRecords(res.records))) { S.importResult = { ok: false, error: 'storeFailed' }; renderImportResult(S.importResult); return; }
      res.added = res.records.length;
    }
  }
  S.importResult = res;
  renderImportResult(res);
}

/* ---------- 调试面板 ---------- */

function debugParse(save) {
  const [svcHex, chHex] = $('dbg-char').value.split(':');
  const service = parseInt(svcHex, 16), ch = parseInt(chHex, 16);
  const h = parseHex($('dbg-hex').value);
  if (!h.ok) { S.dbgParts = [msg('debug.badHex', { reason: msg(`hex.${h.error}`) })]; renderStatus(); return; }
  const r = parseCharacteristic(service, ch, h.bytes);
  const parts = [JSON.stringify(r.ok ? { reject: false, warnings: r.warnings, expect: r.value } : { reject: true, errorCode: r.errorCode }, null, 2)];
  S.dbgParts = parts;
  renderStatus();
  if (!save) return;
  const res = processValue(service, ch, h.bytes, { deviceId: 'DEMO:debug-panel', deviceName: 'Debug panel', isDemo: true });
  if (res.kind !== 'record') { parts.push(msg('debug.noRecord')); renderStatus(); return; }
  ingestLive(res.record).then((r) => {
    if (r === 'failed') return;
    parts.push(msg(r === 'save' ? 'debug.saved' : `ingest.${r}`));
    if (S.dbgParts === parts) renderStatus();
  });
}

/* ---------- 事件 ---------- */

/** 「历史记录」标题带 tabindex="-1"，只用来接住焦点（不进 Tab 顺序）。 */
function focusHistoryHeading() { $('history-h').focus(); }

function wireEvents() {
  $('lang-select').addEventListener('change', async (e) => { setLang(e.target.value); await setSetting('lang', e.target.value); renderAll(); });
  $('set-unit').addEventListener('change', async (e) => { await setSetting('displayUnit', e.target.value); renderLatest(); renderHistory(); });

  // 必须同步进入 requestAndConnect：Web Bluetooth 要求 requestDevice 在用户手势里调用。
  $('btn-connect').addEventListener('click', () => { S.ctl.requestAndConnect({ acceptAll: $('chk-all').checked }); });
  $('btn-reconnect').addEventListener('click', () => { S.ctl.reconnect(); });
  $('btn-disconnect').addEventListener('click', () => { S.ctl.disconnect(); });

  $('demo-buttons').addEventListener('click', async (e) => {
    const id = e.target?.dataset?.scenario;
    const sc = DEMO_SCENARIOS.find((x) => x.id === id);
    if (!sc) return;
    const res = processValue(sc.service, sc.characteristic, sc.build(new Date()), DEMO_DEVICE);
    if (res.kind !== 'record') { S.msgs.export = msg('demo.error', { code: res.errorCode ?? res.kind }); renderStatus(); return; }
    const r = await ingestLive(res.record);
    if (r !== 'failed') { S.msgs.export = msg(r === 'save' ? 'demo.added' : `ingest.${r}`); renderStatus(); }
  });

  $('history-rows').addEventListener('click', async (e) => {
    const id = Number(e.target?.dataset?.id);
    if (!Number.isInteger(id)) return;
    const idx = [...$('history-rows').children].findIndex((tr) => tr.dataset.id === String(id));
    await S.store.remove(id);
    await reload();
    // 删除后焦点留在原来的位置（下一行的删除按钮；删的是最后一行就落到新的最后一行；没有行了就落到「历史记录」标题），
    // 否则被删掉的按钮消失，焦点会丢到 <body>（SBW-L03）。
    const buttons = $('history-rows').querySelectorAll('[data-testid="history-delete"]');
    if (buttons.length) buttons[Math.min(Math.max(idx, 0), buttons.length - 1)].focus();
    else focusHistoryHeading();
  });
  $('btn-clear-demo').addEventListener('click', async () => {
    if (!window.confirm(S.t('history.confirmClearDemo'))) return;
    await S.store.removeDemo();
    await reload();
    if ($('btn-clear-demo').disabled) focusHistoryHeading(); // 按钮已无事可做被禁用，焦点不能留在禁用按钮上
  });
  $('btn-clear-all').addEventListener('click', async () => {
    if (!window.confirm(S.t('history.confirmClear'))) return;
    await S.store.clearMeasurements();
    await reload();
    if ($('btn-clear-all').disabled) focusHistoryHeading();
    if (document.activeElement === document.body) focusHistoryHeading();
  });

  $('btn-export-csv').addEventListener('click', () => doExport('csv'));
  $('btn-export-json').addEventListener('click', () => doExport('json'));
  $('btn-import').addEventListener('click', () => doImport($('import-text').value));
  $('import-file').addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const r = await readFileText(f);
    if (!r.ok) { S.importResult = { ok: false, error: r.error }; renderImportResult(S.importResult); }
    else await doImport(r.text);
    e.target.value = '';
  });

  $('btn-note-save').addEventListener('click', async () => {
    const raw = $('note-id').value.trim();
    const text = $('note-text').value.trim();
    if (!/^\d{1,3}$/.test(raw) || Number(raw) > 254) { S.msgs.note = msg('settings.noteBad'); renderStatus(); return; }
    const notes = { ...S.settings.userNotes };
    const key = String(Number(raw));
    if (text === '') { delete notes[key]; S.msgs.note = msg('settings.noteDeleted'); } else { notes[key] = text.slice(0, 40); S.msgs.note = msg('settings.noteSaved'); }
    await setSetting('userNotes', notes);
    renderStatus();
    renderNotes();
    renderLatest();
  });
  $('note-list').addEventListener('click', async (e) => {
    const id = e.target?.dataset?.note;
    if (id === undefined) return;
    const notes = { ...S.settings.userNotes };
    delete notes[id];
    await setSetting('userNotes', notes);
    renderNotes();
    renderLatest();
  });

  $('btn-dbg-parse').addEventListener('click', () => debugParse(false));
  $('btn-dbg-save').addEventListener('click', () => debugParse(true));
}

async function main() {
  S.support = detectSupport();
  S.store = await openStore();
  S.settings = await S.store.getSettings();
  setLang(S.settings.lang);
  S.availability = await getAvailability();
  S.records = await S.store.all();
  wireBluetooth();
  wireEvents();
  renderAll();
  document.documentElement.dataset.ready = '1';
}

main().catch((e) => {
  document.documentElement.dataset.ready = 'error';
  const p = document.createElement('p');
  p.className = 'error';
  p.setAttribute('role', 'alert');
  p.textContent = 'ScaleBridge Web: ' + String(e?.message ?? e);
  document.body.prepend(p);
});
