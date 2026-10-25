'use strict';
/* 日常消费 / 用药记录 —— 前端。无第三方依赖（扫码库为本地 /vendor 文件）。
 * 所有数据一律用 textContent / value 写入 DOM，不使用 innerHTML。 */
(function () {
  const $ = (id) => document.getElementById(id);
  const state = { cfg: null, address: null, meta: { categories: [], batches: [] }, editingId: null, records: [], challenge: null };

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
  /** "12.3" -> 1230；非法返回 null。只做字符串解析，避免浮点误差。 */
  function yuanToCents(s) {
    const m = /^\s*(\d{1,9})(?:\.(\d{1,2}))?\s*$/.exec(s || '');
    if (!m) return null;
    return parseInt(m[1], 10) * 100 + parseInt((m[2] || '').padEnd(2, '0') || '0', 10);
  }
  function parseQty(s) {
    const m = /^\s*(\d{1,6})(?:\.(\d{1,4}))?\s*$/.exec(s || '');
    if (!m) return null;
    const v = Number(m[1] + (m[2] ? '.' + m[2] : ''));
    return v > 0 ? v : null;
  }

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
    if (res.status === 401 && state.address) { showLogin('登录已过期，请重新登录'); }
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
  function showLogin(msg) {
    state.address = null; state.challenge = null;
    $('who').classList.add('hidden'); $('appView').classList.add('hidden'); $('loginView').classList.remove('hidden');
    $('manualBox').classList.add('hidden'); $('sigInput').value = '';
    say('loginMsg', msg || '', msg ? 'err' : '');
    closeDialog();
  }
  async function showApp(address) {
    state.address = address;
    $('whoAddr').textContent = address; $('whoAddr').title = address;
    $('who').classList.remove('hidden'); $('loginView').classList.add('hidden'); $('appView').classList.remove('hidden');
    await loadMeta();
    resetForm();
    switchTab('register');
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
    await showApp(r.address);
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
    try { const r = await api('POST', '/api/auth/dev-login', { address }); await showApp(r.address); }
    catch (e) { say('loginMsg', e.message, 'err'); }
  }
  async function logout() {
    try { await api('POST', '/api/auth/logout'); } catch { /* ignore */ }
    showLogin('已退出登录');
  }

  // ---------- 元数据 ----------
  function fillSelect(sel, items, firstLabel) {
    const keep = sel.value; clear(sel);
    if (firstLabel != null) sel.append(el('option', { value: '', text: firstLabel }));
    for (const it of items) sel.append(el('option', { value: it.value, text: it.label }));
    if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
  }
  async function loadMeta() {
    const m = await api('GET', '/api/meta');
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
    const p = yuanToCents($('fPrice').value), q = parseQty($('fQty').value);
    $('fAmount').textContent = (p == null || q == null) ? '—' : fmtYuan(Math.round(p * q + 1e-9));
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
      const p = await api('POST', '/api/products/lookup', { barcode: code });
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
    if (priceCents == null) return { error: '单价格式不正确（最多两位小数）' };
    if (quantity == null) return { error: '数量必须大于 0（最多四位小数）' };
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
      if (state.editingId) {
        await api('PUT', '/api/records/' + encodeURIComponent(state.editingId), f.body);
        resetForm(); switchTab('history');
      } else {
        await api('POST', '/api/records', f.body);
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
      const r = await api('POST', '/api/records/query', readQuery());
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
  async function deleteOne(r) {
    if (!(await confirmBox('删除记录', `确定删除「${r.name}」（${r.date}，${fmtYuan(r.amountCents)}）吗？`, '删除', true))) return;
    try { await api('DELETE', '/api/records/' + encodeURIComponent(r.id)); await loadList(); await loadMeta(); }
    catch (e) { $('listSummary').textContent = e.message; }
  }
  async function bulkDelete() {
    const ids = selectedIds(); if (!ids.length) { $('listSummary').textContent = '请先勾选记录'; return; }
    if (!(await confirmBox('删除所选', `确定删除所选 ${ids.length} 条记录吗？`, '删除', true))) return;
    try { await api('POST', '/api/records/delete', { ids }); await loadList(); await loadMeta(); }
    catch (e) { $('listSummary').textContent = e.message; }
  }
  async function bulkAssign() {
    const ids = selectedIds(); if (!ids.length) { $('listSummary').textContent = '请先勾选记录'; return; }
    const name = $('bulkBatch').value.trim(); if (!name) { $('listSummary').textContent = '请输入批次名称'; return; }
    try { await api('POST', '/api/records/batch', { ids, name }); await loadMeta(); await loadList(); }
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
      const s = await api('GET', `/api/stats?month=${encodeURIComponent(month)}&day=${encodeURIComponent(day)}`);
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

  // ---------- 数据：导入 / 一键删除 ----------
  async function doImport() {
    const f = $('impFile').files[0];
    if (!f) { say('impMsg', '请选择 JSON 或 CSV 文件', 'err'); return; }
    if (f.size > 5 * 1024 * 1024) { say('impMsg', '文件超过 5MB', 'err'); return; }
    const mode = document.querySelector('input[name=impMode]:checked').value;
    if (mode === 'replace' && !(await confirmBox('覆盖导入', '覆盖导入会先清空此地址名下现有的全部记录，再导入文件内容。确定继续吗？', '清空并导入', true))) return;
    try {
      const text = await f.text();
      const r = await api('POST', `/api/import?mode=${mode}${mode === 'replace' ? '&confirm=yes' : ''}`, undefined, text);
      say('impMsg', `导入完成：新增 ${r.added}，更新 ${r.updated}，跳过 ${r.skipped}`, 'ok');
      $('impFile').value = ''; await loadMeta();
    } catch (e) { say('impMsg', e.message, 'err'); }
  }
  async function wipeAll() {
    // 第一次确认
    if (!(await confirmBox('删除全部数据（1/2）', '这会永久删除此地址名下的全部记录、商品记忆和批次，且无法恢复。是否继续？（建议先导出备份）', '继续', true))) return;
    // 第二次确认：必须手动输入
    const input = el('input', { type: 'text', autocomplete: 'off', placeholder: '输入 删除全部 以确认' });
    const ok = await new Promise((resolve) => {
      dialog('删除全部数据（2/2）', el('div', {}, el('p', { text: '最后一次确认：请输入“删除全部”四个字。' }), input), [
        { text: '取消', onClick: () => { closeDialog(); resolve(false); } },
        { text: '永久删除', cls: 'danger', onClick: () => { if (input.value.trim() === '删除全部') { closeDialog(); resolve(true); } else input.focus(); } },
      ]);
      input.focus();
    });
    if (!ok) return;
    try { const r = await api('POST', '/api/account/delete-data', { confirm: 'DELETE' }); say('wipeMsg', `已删除 ${r.deleted} 条记录`, 'ok'); await loadMeta(); }
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
  async function init() {
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
    $('impBtn').addEventListener('click', doImport);
    $('wipeBtn').addEventListener('click', wipeAll);
    $('overlay').addEventListener('click', (e) => { if (e.target === $('overlay')) closeDialog(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDialog(); });

    try { state.cfg = await api('GET', '/api/config'); } catch { state.cfg = { devLogin: false }; }
    $('devBox').classList.toggle('hidden', !state.cfg.devLogin);
    $('kaswareHint').textContent = window.kasware ? '已检测到 KasWare。' : '未检测到 KasWare 扩展（可用下方手动签名）。';
    try { const me = await api('GET', '/api/auth/me'); await showApp(me.address); }
    catch { showLogin(''); }
  }
  // KasWare 扩展可能晚于页面脚本注入
  window.addEventListener('load', () => { if (window.kasware) $('kaswareHint').textContent = '已检测到 KasWare。'; });
  init();
})();
