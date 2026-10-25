'use strict';
/* 日常消费 / 用药记录 —— 前端。无第三方依赖（扫码库为本地 /vendor 文件）。
 * 所有数据一律用 textContent / value 写入 DOM，不使用 innerHTML。 */
(function () {
  const $ = (id) => document.getElementById(id);
  const LL = window.LifeLocal, LM = window.LifeMode, LR = window.LifeRemote, I18N = window.LifeI18n;
  // mc：模式控制器（默认本地；登录 Kaspa 后才是云端）。数据读写一律经 store()，界面不关心当前是哪种存储。
  const state = { cfg: null, meta: { categories: [], batches: [] }, editingId: null, records: [], challenge: null, mc: null };
  const store = () => state.mc.store;
  const NOTICE_KEY = 'life.noticeDismissed';
  function lsGet(k) { try { return window.localStorage.getItem(k); } catch { return null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); } catch { /* 隐私模式下忽略 */ } }

  // ---------- 小工具 ----------
  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v);
      else n.setAttribute(k, v);
    }
    for (const c of kids) if (c != null) n.append(c.nodeType ? c : document.createTextNode(String(c)));
    return n;
  }
  const clear = (n) => { while (n.firstChild) n.removeChild(n.firstChild); };
  function say(id, text, kind) { const n = $(id); n.textContent = text || ''; n.className = 'msg' + (kind ? ' ' + kind : ''); }
  const pad = (n) => String(n).padStart(2, '0');
  function today() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function fmtYuan(cents) {
    const neg = cents < 0; const a = Math.abs(cents);
    return (neg ? '-' : '') + '¥' + Math.floor(a / 100).toLocaleString('en-US') + '.' + pad(a % 100);
  }
  // 金额/数量解析在 money.js（与桌面/手机同一规则，shared-vectors 校验）
  const { yuanToCents, parseQty, amountCents } = window.LifeMoney;

  // 只用于登录相关接口与配置；记录数据一律走 store()（本地 IndexedDB 或云端 life-remote.js）
  async function api(method, url, body, raw) {
    const headers = { 'X-Requested-With': 'life-web' };
    let payload;
    if (raw !== undefined) { payload = raw; headers['Content-Type'] = 'text/plain; charset=utf-8'; }
    else if (body !== undefined) { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
    let res;
    try { res = await fetch(url, { method, headers, body: payload, credentials: 'same-origin', cache: 'no-store' }); }
    catch { throw new Error('网络错误，请稍后重试'); }
    let data = null;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('json')) { try { data = await res.json(); } catch { data = null; } }
    if (!res.ok) { const e = new Error((data && data.error) || `请求失败（${res.status}）`); e.status = res.status; throw e; }
    return data;
  }

  // ---------- 对话框 ----------
  let dlgCleanup = null;
  function closeDialog() {
    $('overlay').classList.add('hidden');
    if (dlgCleanup) { const f = dlgCleanup; dlgCleanup = null; try { f(); } catch { /* ignore */ } }
    clear($('dlgBody')); clear($('dlgBtns'));
  }
  function dialog(title, bodyNode, buttons, cleanup) {
    $('dlgTitle').textContent = title;
    clear($('dlgBody')); $('dlgBody').append(bodyNode);
    clear($('dlgBtns'));
    for (const b of buttons) $('dlgBtns').append(el('button', { class: 'btn' + (b.cls ? ' ' + b.cls : ''), type: 'button', onClick: b.onClick, text: b.text }));
    dlgCleanup = cleanup || null;
    $('overlay').classList.remove('hidden');
  }
  function confirmBox(title, message, okText, danger) {
    return new Promise((resolve) => {
      dialog(title, el('p', { text: message }), [
        { text: '取消', onClick: () => { closeDialog(); resolve(false); } },
        { text: okText || '确定', cls: danger ? 'danger' : 'primary', onClick: () => { closeDialog(); resolve(true); } },
      ]);
    });
  }

  // ---------- 视图切换 ----------
  async function showLogin(msg) {
    state.challenge = null;
    $('appView').classList.add('hidden'); $('loginView').classList.remove('hidden');
    $('manualBox').classList.add('hidden'); $('sigInput').value = '';
    say('loginMsg', msg || '', msg ? 'err' : '');
    closeDialog();
    if (!state.cfg) {   // 配置只在用户主动点登录时才请求
      try { state.cfg = await api('GET', '/api/config'); } catch { state.cfg = { devLogin: false }; }
      $('devBox').classList.toggle('hidden', !state.cfg.devLogin);
    }
    $('kaswareHint').textContent = window.kasware ? '已检测到 KasWare。' : '未检测到 KasWare 扩展（可用下方手动签名）。';
  }
  function hideLogin() { $('loginView').classList.add('hidden'); $('appView').classList.remove('hidden'); }

  // ---------- 模式（本地 / 云端） ----------
  function showToast(text, onUndo, ms) {
    clearToast();
    $('toastText').textContent = text; $('toastUndo').classList.toggle('hidden', !onUndo);
    state.undo = onUndo || null; $('toast').classList.remove('hidden');
    state.toastTimer = setTimeout(clearToast, ms || (onUndo ? 6000 : 5000));
  }
  function clearToast() {
    clearTimeout(state.toastTimer); state.undo = null; $('toast').classList.add('hidden');
  }
  async function applyMode(ev) {
    const cloud = ev.mode === 'cloud';
    $('modeBadge').textContent = cloud ? '云端模式' : '本地模式';
    $('modeBadge').className = 'badge ' + (cloud ? 'cloud' : 'local');
    $('whoAddr').textContent = ev.address || ''; $('whoAddr').title = ev.address || '';
    $('whoAddr').classList.toggle('hidden', !cloud);
    $('loginBtn').classList.toggle('hidden', cloud); $('logoutBtn').classList.toggle('hidden', !cloud);
    $('modeInfoLocal').classList.toggle('hidden', cloud); $('modeInfoCloud').classList.toggle('hidden', !cloud);
    $('cloudSync').classList.toggle('hidden', !cloud); $('loginTip').classList.toggle('hidden', cloud);
    $('localNotice').classList.toggle('hidden', cloud || lsGet(NOTICE_KEY) === '1');
    $('wipeHint').textContent = cloud
      ? '将删除此账户在服务器上的全部记录、商品记忆与批次，删除后无法在本页恢复。建议先导出备份。'
      : '将删除本浏览器里的全部记录、商品记忆与批次，删除后无法在本页恢复。建议先导出备份。';
    clearToast(); hideLogin(); closeDialog();
    clearFeedback('impMsg', 'impDetail'); clearFeedback('syncMsg', 'syncDetail'); say('wipeMsg', ''); say('expMsg', '');
    try { await loadMeta(); } catch (e) { say('formMsg', e.message, 'err'); }
    resetForm(); switchTab('register');
    if (ev.reason === 'expired') showToast('云端登录已过期，已回到本地模式（本地数据不受影响）', null, 8000);
  }

  // ---------- 登录 ----------
  async function requestChallenge(address) {
    const c = await api('POST', '/api/auth/challenge', { address });
    state.challenge = { address, nonce: c.nonce, message: c.message };
    return c;
  }
  async function submitSignature(address, signature) {
    const ch = state.challenge;
    if (!ch || ch.address !== address) throw new Error('请先获取待签名消息');
    state.challenge = null; // 挑战只能用一次
    const r = await api('POST', '/api/auth/verify', { address, nonce: ch.nonce, signature });
    state.mc.loginSucceeded(r.address);
  }
  async function kaswareLogin() {
    const kw = window.kasware;
    if (!kw) { say('loginMsg', '未检测到 KasWare 钱包。请安装 KasWare 浏览器扩展，或使用下方“手动签名”。', 'err'); return; }
    try {
      say('loginMsg', '请在 KasWare 中确认连接…');
      const accounts = await kw.requestAccounts();
      const address = String(accounts && accounts[0] || '').trim();
      if (!address) throw new Error('KasWare 没有返回地址');
      const c = await requestChallenge(address);
      say('loginMsg', '请在 KasWare 中签名（仅用于登录，不会产生交易）…');
      const sig = await kw.signMessage(c.message, { type: 'schnorr' });
      await submitSignature(address, String(sig));
    } catch (e) {
      say('loginMsg', (e && e.message) ? '登录失败：' + e.message : '已取消或登录失败', 'err');
    }
  }
  async function manualChallenge() {
    const address = $('loginAddr').value.trim();
    if (!address) { say('loginMsg', '请先输入 Kaspa 地址', 'err'); return; }
    try {
      const c = await requestChallenge(address.toLowerCase());
      $('challengeMsg').value = c.message;
      $('manualBox').classList.remove('hidden');
      say('loginMsg', '请用该地址的密钥对上面的消息进行 Schnorr 签名，把签名粘贴到下面。', 'ok');
    } catch (e) { say('loginMsg', e.message, 'err'); }
  }
  async function manualVerify() {
    const sig = $('sigInput').value.replace(/\s+/g, '');
    if (!sig) { say('loginMsg', '请粘贴签名', 'err'); return; }
    try { await submitSignature($('loginAddr').value.trim().toLowerCase(), sig); }
    catch (e) { say('loginMsg', '登录失败：' + e.message, 'err'); $('manualBox').classList.add('hidden'); }
  }
  async function devLogin() {
    const address = $('loginAddr').value.trim().toLowerCase();
    try { const r = await api('POST', '/api/auth/dev-login', { address }); state.mc.loginSucceeded(r.address); }
    catch (e) { say('loginMsg', e.message, 'err'); }
  }
  async function logout() {
    await state.mc.logout(() => api('POST', '/api/auth/logout'));
  }

  // ---------- 元数据 ----------
  function fillSelect(sel, items, firstLabel) {
    const keep = sel.value; clear(sel);
    if (firstLabel != null) sel.append(el('option', { value: '', text: firstLabel }));
    for (const it of items) sel.append(el('option', { value: it.value, text: it.label }));
    if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
  }
  async function loadMeta() {
    const m = await store().meta();
    state.meta = m;
    const cats = m.categories.map((c) => ({ value: c, label: c }));
    fillSelect($('fCategory'), cats);
    fillSelect($('qCategory'), cats, '全部分类');
    fillSelect($('qBatch'), m.batches.map((b) => ({ value: b.batchId, label: `${b.batchName}（${b.count}）` })), '全部批次');
    const dl = $('batchList'); clear(dl);
    for (const b of m.batches) dl.append(el('option', { value: b.batchName }));
  }

  // ---------- 登记 / 编辑 ----------
  function updateAmount() {
    const a = amountCents(yuanToCents($('fPrice').value), $('fQty').value);
    $('fAmount').textContent = a == null ? '—' : fmtYuan(a);
  }
  function resetForm() {
    state.editingId = null;
    $('recForm').reset();
    $('fQty').value = '1'; $('fDate').value = today();
    $('formTitle').textContent = '登记一条记录';
    $('saveBtn').textContent = '保存';
    $('cancelEditBtn').classList.add('hidden');
    say('formMsg', ''); $('lookupHint').textContent = '';
    updateAmount();
    focusBarcode();
  }
  function focusBarcode() { setTimeout(() => { if (!$('tab-register').classList.contains('hidden')) $('fBarcode').focus(); }, 0); }
  async function lookup() {
    const code = $('fBarcode').value.trim();
    if (!code) { $('fName').focus(); return; }
    try {
      const p = await store().lookup(code);
      if (p.found) {
        $('fName').value = p.name;
        if (p.category) $('fCategory').value = p.category;
        if (p.lastPriceCents != null) $('fPrice').value = (p.lastPriceCents / 100).toFixed(2);
        $('lookupHint').textContent = '已带出上次记录的名称、分类和价格，请核对。';
        updateAmount(); $('fQty').focus(); $('fQty').select();
      } else {
        $('lookupHint').textContent = '新条码，请填写名称和价格。';
        $('fName').focus();
      }
    } catch (e) { $('lookupHint').textContent = e.message; }
  }
  function collectForm() {
    const priceCents = yuanToCents($('fPrice').value), quantity = parseQty($('fQty').value);
    if (!$('fName').value.trim()) return { error: '请填写名称' };
    if (priceCents == null) return { error: '单价无效（小数请用小数点，如 12.50；超过两位小数按四舍五入）' };
    if (quantity == null) return { error: '数量无效（需大于 0，最多 6 位小数）' };
    if (!$('fDate').value) return { error: '请选择日期' };
    return {
      body: {
        barcode: $('fBarcode').value.trim(), name: $('fName').value.trim(), priceCents, quantity,
        category: $('fCategory').value, note: $('fNote').value.trim(), date: $('fDate').value,
        batchName: $('fBatch').value.trim(), patient: $('fPatient').value.trim(), dosage: $('fDosage').value.trim(),
      },
    };
  }
  async function saveRecord(ev) {
    ev.preventDefault();
    const f = collectForm();
    if (f.error) { say('formMsg', f.error, 'err'); return; }
    $('saveBtn').disabled = true;
    try {
      const st = store();
      if (f.body.barcode) {   // 同编码同日重复登记提醒：可继续保存
        const dups = await st.duplicates(f.body.barcode, f.body.date, state.editingId);
        if (dups.length) {
          const more = dups.length > 1 ? `等 ${dups.length} 条` : '';
          const ok = await confirmBox('重复登记提醒', `${f.body.date} 已登记过相同编码（${f.body.barcode}）的记录「${dups[0].name}」${more}。仍要保存吗？`, '仍然保存');
          if (!ok) { say('formMsg', '已取消保存', ''); return; }
        }
      }
      if (state.editingId) {
        await st.update(state.editingId, f.body);
        resetForm(); switchTab('history');
      } else {
        await st.add(f.body);
        const keepDate = f.body.date, keepBatch = f.body.batchName, keepPatient = f.body.patient;
        resetForm();
        $('fDate').value = keepDate; $('fBatch').value = keepBatch; $('fPatient').value = keepPatient; // 连续录入沿用
        say('formMsg', '已保存，可继续扫描下一件', 'ok');
      }
      await loadMeta();
    } catch (e) { say('formMsg', e.message, 'err'); }
    finally { $('saveBtn').disabled = false; }
  }
  function startEdit(r) {
    state.editingId = r.id;
    switchTab('register');
    $('fBarcode').value = r.barcode; $('fName').value = r.name; $('fPrice').value = (r.priceCents / 100).toFixed(2);
    $('fQty').value = String(r.quantity); $('fCategory').value = r.category; $('fDate').value = r.date;
    $('fBatch').value = r.batchName; $('fPatient').value = r.patient; $('fDosage').value = r.dosage; $('fNote').value = r.note;
    $('formTitle').textContent = '编辑记录'; $('saveBtn').textContent = '保存修改';
    $('cancelEditBtn').classList.remove('hidden'); say('formMsg', ''); updateAmount();
    window.scrollTo(0, 0);
  }

  // ---------- 相机扫码（本地 html5-qrcode） ----------
  function openCamera() {
    const readerId = 'qr-reader';
    const status = el('p', { class: 'hint', text: '正在启动相机…' });
    const manual = el('input', { type: 'text', placeholder: '或手动输入条码', autocomplete: 'off' });
    let scanner = null, finished = false;
    async function stop() {
      const s = scanner; scanner = null;
      try { if (s && s.isScanning) await s.stop(); if (s) s.clear(); } catch { /* ignore */ }
    }
    function done(code) {
      if (finished) return; finished = true;
      closeDialog(); $('fBarcode').value = code; lookup();
    }
    const body = el('div', {}, el('div', { id: readerId, class: 'reader' }), status, manual);
    dialog('扫描条码', body, [
      { text: '取消', onClick: closeDialog },
      { text: '使用手动输入', cls: 'primary', onClick: () => { const v = manual.value.trim(); if (v) done(v); } },
    ], () => { finished = true; void stop(); });
    (async () => {
      if (!window.Html5Qrcode) { status.textContent = '扫码组件未加载，请使用手动输入或 USB 扫码枪。'; return; }
      if (!window.isSecureContext) { status.textContent = '相机需要 HTTPS（或 localhost）访问，请使用手动输入或 USB 扫码枪。'; return; }
      try {
        const F = window.Html5QrcodeSupportedFormats;
        scanner = new window.Html5Qrcode(readerId, { verbose: false, formatsToSupport: [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128, F.CODE_39, F.ITF, F.QR_CODE] });
        await scanner.start({ facingMode: 'environment' }, { fps: 10, qrbox: { width: 260, height: 160 } }, (t) => done(t), () => {});
        status.textContent = '把条码放进取景框…';
      } catch (e) {
        status.textContent = '无法打开相机（权限被拒绝或没有摄像头）。可使用手动输入。';
      }
    })();
  }

  // ---------- 记录列表 ----------
  function readQuery() {
    const q = {};
    if ($('qFrom').value) q.from = $('qFrom').value;
    if ($('qTo').value) q.to = $('qTo').value;
    if ($('qCategory').value) q.category = $('qCategory').value;
    if ($('qBatch').value) q.batchId = $('qBatch').value;
    if ($('qKeyword').value.trim()) q.keyword = $('qKeyword').value.trim();
    return q;
  }
  async function loadList() {
    try {
      const r = await store().query(readQuery());
      state.records = r.records;
      $('listSummary').textContent = `共 ${r.count} 条，合计 ${fmtYuan(r.totalCents)}`;
      renderList();
    } catch (e) { $('listSummary').textContent = e.message; }
  }
  function renderList() {
    const box = $('list'); clear(box); $('selAll').checked = false;
    if (!state.records.length) { box.append(el('p', { class: 'hint', text: '没有符合条件的记录' })); return; }
    for (const r of state.records) {
      const meta = [r.date, `${fmtYuan(r.priceCents)} × ${r.quantity}`];
      if (r.barcode) meta.push('条码 ' + r.barcode);
      const extra = [];
      if (r.patient) extra.push('用药人：' + r.patient);
      if (r.dosage) extra.push('剂量：' + r.dosage);
      if (r.note) extra.push('备注：' + r.note);
      const main = el('div', { class: 'main' },
        el('div', { class: 't' }, el('span', { class: 'tag', text: r.category }), r.batchName ? el('span', { class: 'tag', text: '批次 ' + r.batchName }) : null, r.name),
        el('div', { class: 'm', text: meta.join(' · ') }),
        extra.length ? el('div', { class: 'm', text: extra.join(' · ') }) : null);
      box.append(el('div', { class: 'item' },
        el('input', { type: 'checkbox', 'data-id': r.id, 'aria-label': '选择' }),
        main,
        el('div', { class: 'amt', text: fmtYuan(r.amountCents) }),
        el('div', { class: 'acts' },
          el('button', { class: 'btn small', type: 'button', text: '编辑', onClick: () => startEdit(r) }),
          el('button', { class: 'btn small danger', type: 'button', text: '删除', onClick: () => deleteOne(r) }))));
    }
  }
  const selectedIds = () => [...$('list').querySelectorAll('input[type=checkbox]:checked')].map((c) => c.getAttribute('data-id'));
  // 删除后约 6 秒内可撤销：撤销 = 把原记录（含原 id、createdAt、批次）整条写回
  async function removeWithUndo(recs) {
    const st = store(), ids = recs.map((r) => r.id);
    try {
      await st.remove(ids);
      await loadList(); await loadMeta();
      showToast(`已删除 ${ids.length} 条记录`, async () => {
        try { await st.restore(recs); await loadMeta(); if (!$('tab-history').classList.contains('hidden')) await loadList(); $('listSummary').textContent = `已撤销删除，恢复 ${recs.length} 条`; }
        catch (e) { $('listSummary').textContent = '撤销失败：' + e.message; }
      });
    } catch (e) { $('listSummary').textContent = e.message; }
  }
  async function deleteOne(r) {
    if (!(await confirmBox('删除记录', `确定删除「${r.name}」（${r.date}，${fmtYuan(r.amountCents)}）吗？（删除后 6 秒内可撤销）`, '删除', true))) return;
    await removeWithUndo([r]);
  }
  async function bulkDelete() {
    const ids = selectedIds(); if (!ids.length) { $('listSummary').textContent = '请先勾选记录'; return; }
    if (!(await confirmBox('删除所选', `确定删除所选 ${ids.length} 条记录吗？（删除后 6 秒内可撤销）`, '删除', true))) return;
    await removeWithUndo(state.records.filter((r) => ids.includes(r.id)));
  }
  async function bulkAssign() {
    const ids = selectedIds(); if (!ids.length) { $('listSummary').textContent = '请先勾选记录'; return; }
    const name = $('bulkBatch').value.trim(); if (!name) { $('listSummary').textContent = '请输入批次名称'; return; }
    try { await store().assignBatch(ids, name); await loadMeta(); await loadList(); }
    catch (e) { $('listSummary').textContent = e.message; }
  }

  // ---------- 统计 ----------
  function bar(label, cents, ratio, text) {
    const fill = el('div', { class: 'fill' });
    fill.style.width = Math.max(0, Math.min(100, ratio * 100)).toFixed(1) + '%'; // CSSOM 写入，不受 CSP 限制
    return el('div', { class: 'bar' }, el('span', { text: label }), el('div', { class: 'track' }, fill), el('span', { class: 'v', text: text || fmtYuan(cents) }));
  }
  async function loadStats() {
    const month = $('sMonth').value || today().slice(0, 7), day = $('sDay').value || today();
    try {
      const s = await store().stats(month, day);
      $('sDayTotal').textContent = fmtYuan(s.dayTotalCents); $('sDayCount').textContent = `${s.dayCount} 条`;
      $('sMonthTotal').textContent = fmtYuan(s.monthTotalCents); $('sMonthCount').textContent = `${s.monthCount} 条`;
      const cats = $('sCats'), days = $('sDays'); clear(cats); clear(days);
      if (!s.categories.length) cats.append(el('p', { class: 'hint', text: '当月暂无数据' }));
      for (const c of s.categories) cats.append(bar(c.category, c.cents, c.ratio, `${fmtYuan(c.cents)} · ${(c.ratio * 100).toFixed(1)}%`));
      const max = Math.max(1, ...s.days.map((d) => d.cents));
      if (!s.days.length) days.append(el('p', { class: 'hint', text: '当月暂无数据' }));
      for (const d of s.days) days.append(bar(d.date.slice(5), d.cents, d.cents / max));
    } catch (e) { $('sDayCount').textContent = e.message; }
  }

  // ---------- 数据：导出 / 导入 / 同步 / 一键删除 ----------
  // 导入/上传/下载的反馈：每个反馈区记住「怎么画」，切换语言时按新语言重画（文案与翻译在 life-i18n.js，可单元测试）
  const feedback = {};
  function renderList(boxId, list) {
    const box = $(boxId); clear(box);
    if (!list) { box.classList.add('hidden'); return; }
    box.append(el('div', { class: 'total', text: list.head }));
    const ul = el('ul');
    for (const t of list.items) ul.append(el('li', { text: t }));
    if (list.more) ul.append(el('li', { text: list.more }));
    box.append(ul); box.classList.remove('hidden');
  }
  function setFeedback(msgId, boxId, kind, build) {
    const draw = () => { const v = build(); say(msgId, v.msg, kind); renderList(boxId, v.list); };
    feedback[msgId] = draw; draw();
  }
  function clearFeedback(msgId, boxId) { delete feedback[msgId]; say(msgId, ''); renderList(boxId, null); }
  function showImportFailure(msgId, boxId, e) { setFeedback(msgId, boxId, 'err', () => I18N.failureView(e)); }
  function showImportResult(msgId, boxId, kind, r) { setFeedback(msgId, boxId, 'ok', () => I18N.resultView(kind, r)); }
  function showImportNote(msgId, boxId, zh, en) { setFeedback(msgId, boxId, 'err', () => ({ msg: I18N.t(zh, en), list: null })); }
  function applyLang() {
    const en = I18N.lang() === 'en';
    document.documentElement.lang = en ? 'en' : 'zh-CN';
    $('langBtn').textContent = en ? '中文' : 'English';
    $('langBtn').title = en ? '切换为中文（目前只影响导入/上传/下载的提示与逐条原因）' : 'Switch to English (currently affects import / upload / download messages and per-row reasons)';
    for (const f of Object.values(feedback)) f();
  }
  function toggleLang() { I18N.setLang(I18N.lang() === 'en' ? 'zh' : 'en'); applyLang(); }
  function download(name, text, mime) {
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const a = el('a', { href: url, download: name }); document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  async function exportAs(kind, name) {
    try {
      const st = store();
      if (kind === 'csv') download(name || `consumption-${today()}.csv`, await st.exportCsv(), 'text/csv;charset=utf-8');
      else download(name || `consumption-${today()}.json`, await st.exportJson(), 'application/json');
      say('expMsg', '已导出，请妥善保管文件（含你的全部记录，未加密）。', 'ok');
    } catch (e) { say('expMsg', e.message, 'err'); }
  }
  async function doImport() {
    const f = $('impFile').files[0];
    clearFeedback('impMsg', 'impDetail');
    if (!f) { showImportNote('impMsg', 'impDetail', '请选择 JSON 或 CSV 文件', 'Please choose a JSON or CSV file'); return; }
    if (f.size > 5 * 1024 * 1024) { showImportNote('impMsg', 'impDetail', '文件超过 5MB', 'The file is larger than 5 MB'); return; }
    const mode = document.querySelector('input[name=impMode]:checked').value;
    const where = state.mc.mode === 'cloud' ? '此账户在服务器上现有的' : '本浏览器里现有的';
    if (mode === 'replace' && !(await confirmBox('覆盖导入', `覆盖导入会先清空${where}全部记录，再导入文件内容。会先检查整份文件，有任何一条不合格就整体中止、不动现有数据。确定继续吗？`, '清空并导入', true))) return;
    try {
      const text = await f.text();
      const r = await store().importText(text, mode);
      showImportResult('impMsg', 'impDetail', 'import', r);
      $('impFile').value = ''; await loadMeta();
    } catch (e) { showImportFailure('impMsg', 'impDetail', e); }
  }
  /** 三选一对话框：返回被点按钮的 value；点取消/空白处返回 null。 */
  function choose(title, paragraphs, buttons) {
    return new Promise((resolve) => {
      const body = el('div', {}, ...paragraphs.map((t) => el('p', { text: t })));
      dialog(title, body, buttons.map((b) => ({ text: b.text, cls: b.cls, onClick: () => { resolve(b.value); closeDialog(); } })), () => resolve(null));
    });
  }
  async function uploadLocal() {
    const remote = state.mc.remote, local = state.mc.local;
    clearFeedback('syncMsg', 'syncDetail');
    if (!remote) return;
    try {
      const text = await local.exportJson();
      const pre = LL.precheck(LL.parseImport(text));
      if (pre.rejected.length) { showImportFailure('syncMsg', 'syncDetail', Object.assign(Object.assign(new Error('本地有不合格记录'), { messageEn: 'Some local records are invalid' }), { rejected: pre.rejected, total: pre.records.length + pre.rejected.length })); return; }
      if (!pre.records.length) { showImportNote('syncMsg', 'syncDetail', '本地没有记录可上传', 'There are no local records to upload'); return; }
      const mode = await choose('上传本地数据到账户', [
        `把本浏览器里的 ${pre.records.length} 条记录上传到当前登录的账户（云端）。上传前已检查全部记录，均合格。`,
        '合并上传（推荐）：云端已有的记录全部保留；id 相同的以本地为准，其余新增。',
        '覆盖云端：先清空云端现有的全部记录，再写入本地记录——云端有而本地没有的记录会丢失。',
      ], [{ text: '取消', value: null }, { text: '覆盖云端', cls: 'danger', value: 'replace' }, { text: '合并上传', cls: 'primary', value: 'merge' }]);
      if (!mode) return;
      if (mode === 'replace' && !(await confirmBox('确认覆盖云端', '云端现有的全部记录将被清空并替换为本地的记录，无法在本页撤销。建议先在云端模式导出备份。确定覆盖吗？', '覆盖云端', true))) return;
      const r = await remote.importText(text, mode);
      showImportResult('syncMsg', 'syncDetail', 'upload', r);
    } catch (e) { showImportFailure('syncMsg', 'syncDetail', e); }
  }
  async function downloadCloud() {
    const remote = state.mc.remote, local = state.mc.local;
    clearFeedback('syncMsg', 'syncDetail');
    if (!remote) return;
    try {
      const mode = await choose('从账户下载到本地', [
        '把云端账户里的记录下载到本浏览器的本地存储。',
        '合并下载（推荐）：本地已有的记录全部保留；id 相同的以云端为准，其余新增。',
        '覆盖本地：先清空本地现有的全部记录，再写入云端的记录——本地有而云端没有的记录会丢失。会先检查整份云端数据，有任何一条不合格就整体中止、本地保持不变。',
      ], [{ text: '取消', value: null }, { text: '覆盖本地', cls: 'danger', value: 'replace' }, { text: '合并下载', cls: 'primary', value: 'merge' }]);
      if (!mode) return;
      if (mode === 'replace' && !(await confirmBox('确认覆盖本地', '本浏览器里现有的全部本地记录将被清空并替换为云端的记录。建议先退出云端后导出本地备份。确定覆盖吗？', '覆盖本地', true))) return;
      const text = await remote.exportJson();
      const r = await local.importText(text, mode);
      showImportResult('syncMsg', 'syncDetail', 'download', r);
    } catch (e) { showImportFailure('syncMsg', 'syncDetail', e); }
  }
  async function wipeAll() {
    const cloud = state.mc.mode === 'cloud';
    // 第一次确认
    if (!(await confirmBox('删除全部数据（1/2）', cloud
      ? '这会删除此账户在服务器上的全部记录、商品记忆和批次，删除后无法在本页恢复。是否继续？（建议先导出备份）'
      : '这会删除本浏览器里的全部记录、商品记忆和批次，删除后无法在本页恢复。是否继续？（建议先导出备份）', '继续', true))) return;
    // 第二次确认：必须手动输入
    const input = el('input', { type: 'text', autocomplete: 'off', placeholder: '输入 删除全部 以确认' });
    const ok = await new Promise((resolve) => {
      dialog('删除全部数据（2/2）', el('div', {}, el('p', { text: '最后一次确认：请输入“删除全部”四个字。' }), input), [
        { text: '取消', onClick: () => { resolve(false); closeDialog(); } },
        { text: '永久删除', cls: 'danger', onClick: () => { if (input.value.trim() === '删除全部') { resolve(true); closeDialog(); } else input.focus(); } },
      ], () => resolve(false));
      input.focus();
    });
    if (!ok) return;
    try { const n = await store().wipe(); say('wipeMsg', `已删除 ${n} 条记录`, 'ok'); await loadMeta(); }
    catch (e) { say('wipeMsg', e.message, 'err'); }
  }

  // ---------- 标签页 ----------
  function switchTab(name) {
    for (const b of $('tabs').querySelectorAll('button')) b.classList.toggle('active', b.dataset.tab === name);
    for (const t of ['register', 'history', 'stats', 'data']) $('tab-' + t).classList.toggle('hidden', t !== name);
    if (name === 'register') focusBarcode();
    if (name === 'history') loadList();
    if (name === 'stats') { if (!$('sMonth').value) $('sMonth').value = today().slice(0, 7); if (!$('sDay').value) $('sDay').value = today(); loadStats(); }
  }

  // ---------- 启动 ----------
  function unavailableStore(reason) {
    const msg = `此浏览器无法使用本地存储（${reason}）。请换用普通（非无痕）窗口，或登录 Kaspa 钱包使用云端保存。`;
    const s = { kind: 'local' };
    for (const m of ['meta', 'lookup', 'add', 'update', 'remove', 'restore', 'query', 'stats', 'duplicates', 'assignBatch', 'exportJson', 'exportCsv', 'importText', 'wipe']) s[m] = () => Promise.reject(new Error(msg));
    return s;
  }
  async function init() {
    $('langBtn').addEventListener('click', toggleLang); applyLang();
    $('loginBtn').addEventListener('click', () => showLogin(''));
    $('loginBackBtn').addEventListener('click', hideLogin);
    $('noticeClose').addEventListener('click', () => { lsSet(NOTICE_KEY, '1'); $('localNotice').classList.add('hidden'); });
    $('toastUndo').addEventListener('click', () => { const f = state.undo; clearToast(); if (f) f(); });
    $('kaswareBtn').addEventListener('click', kaswareLogin);
    $('challengeBtn').addEventListener('click', manualChallenge);
    $('verifyBtn').addEventListener('click', manualVerify);
    $('devBtn').addEventListener('click', devLogin);
    $('logoutBtn').addEventListener('click', logout);
    $('tabs').addEventListener('click', (e) => { const t = e.target.closest('button[data-tab]'); if (t) switchTab(t.dataset.tab); });
    $('recForm').addEventListener('submit', saveRecord);
    $('clearBtn').addEventListener('click', resetForm);
    $('cancelEditBtn').addEventListener('click', resetForm);
    $('camBtn').addEventListener('click', openCamera);
    // USB 扫码枪：模拟键盘输入，以回车结尾 —— 条码框回车只做查询，不提交表单
    $('fBarcode').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); lookup(); } });
    for (const id of ['fPrice', 'fQty']) $(id).addEventListener('input', updateAmount);
    $('filterForm').addEventListener('submit', (e) => { e.preventDefault(); loadList(); });
    $('qReset').addEventListener('click', () => { $('filterForm').reset(); loadList(); });
    $('selAll').addEventListener('change', (e) => { for (const c of $('list').querySelectorAll('input[type=checkbox]')) c.checked = e.target.checked; });
    $('bulkDelete').addEventListener('click', bulkDelete);
    $('bulkAssign').addEventListener('click', bulkAssign);
    $('sMonth').addEventListener('change', loadStats); $('sDay').addEventListener('change', loadStats);
    $('expJson').addEventListener('click', () => exportAs('json'));
    $('expCsv').addEventListener('click', () => exportAs('csv'));
    $('expAll').addEventListener('click', () => exportAs('json', `consumption-all-${today()}.json`));
    $('impBtn').addEventListener('click', doImport);
    $('uploadBtn').addEventListener('click', uploadLocal);
    $('downloadBtn').addEventListener('click', downloadCloud);
    $('wipeBtn').addEventListener('click', wipeAll);
    $('overlay').addEventListener('click', (e) => { if (e.target === $('overlay')) closeDialog(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDialog(); });

    let local;
    try { local = await LL.LocalStore.open(); } catch (e) { local = unavailableStore(e && e.message ? e.message : '未知原因'); }
    let storage = null; try { storage = window.localStorage; } catch { /* ignore */ }
    state.mc = new LM.ModeController({
      local, storage,
      makeRemote: () => new LR.RemoteStore({ onUnauthorized: () => state.mc.sessionExpired() }),
      probe: () => api('GET', '/api/auth/me'),
    });
    state.mc.onChange((ev) => { applyMode(ev); });
    await state.mc.init();   // 默认本地：不发任何请求；仅当上次是云端模式时才探测一次会话
  }
  // KasWare 扩展可能晚于页面脚本注入
  window.addEventListener('load', () => { if (window.kasware && $('kaswareHint')) $('kaswareHint').textContent = '已检测到 KasWare。'; });
  init();
})();
