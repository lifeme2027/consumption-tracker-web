/* 云端存储（登录 Kaspa 后的可选模式）：把同一套存储接口映射到服务端 /api。只有登录后才会被创建、被调用。
 * 服务端沿用原有鉴权（会话 Cookie + X-Requested-With），匿名请求一律 401。 */
(function (root) {
  'use strict';

  function RemoteStore(opts) {
    opts = opts || {};
    this.kind = 'remote';
    this.fetch = opts.fetch || function () { return root.fetch.apply(root, arguments); };
    this.onUnauthorized = opts.onUnauthorized || function () {};
  }
  var P = RemoteStore.prototype;

  function netError() { var e = new Error('网络错误，请稍后重试'); e.messageEn = 'Network error, please try again later'; return e; }
  P._send = function (method, url, body, raw) {
    var self = this, headers = { 'X-Requested-With': 'life-web' }, payload;
    if (raw !== undefined) { payload = raw; headers['Content-Type'] = 'text/plain; charset=utf-8'; }
    else if (body !== undefined) { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
    return Promise.resolve().then(function () { return self.fetch(url, { method: method, headers: headers, body: payload, credentials: 'same-origin', cache: 'no-store' }); })
      .catch(function () { throw netError(); })
      .then(function (res) {
        var ct = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
        var read = ct.indexOf('json') >= 0 ? res.json().catch(function () { return null; }) : Promise.resolve(null);
        return read.then(function (data) {
          if (res.status === 401) self.onUnauthorized();
          if (!res.ok) {
            var e = new Error((data && data.error) || ('请求失败（' + res.status + '）'));
            e.status = res.status; if (data) {
              e.data = data;
              if (data.rejected) { e.rejected = data.rejected; e.total = data.total; e.rejectedCount = data.rejectedCount; }   // 覆盖导入预检失败：逐条原因
              if (data.errorEn) e.messageEn = data.errorEn;
            }
            throw e;
          }
          return { data: data, res: res };
        });
      });
  };
  P._json = function (method, url, body, raw) { return this._send(method, url, body, raw).then(function (r) { return r.data; }); };
  P._text = function (url) {
    var self = this;
    return Promise.resolve().then(function () { return self.fetch(url, { method: 'GET', headers: { 'X-Requested-With': 'life-web' }, credentials: 'same-origin', cache: 'no-store' }); })
      .catch(function () { throw netError(); })
      .then(function (res) {
        if (res.status === 401) self.onUnauthorized();
        if (!res.ok) throw new Error('请求失败（' + res.status + '）');
        return res.text();
      });
  };

  P.meta = function () { return this._json('GET', '/api/meta'); };
  P.lookup = function (barcode) { return this._json('POST', '/api/products/lookup', { barcode: barcode }); };
  P.add = function (body) { return this._json('POST', '/api/records', body); };
  P.update = function (id, body) { return this._json('PUT', '/api/records/' + encodeURIComponent(id), body); };
  // 服务端单次上限：delete / restore 各 1000 条，且默认请求体 64KB。客户端分批发送，避免大批量删除后“撤销”因 413 丢数据。
  var DELETE_CHUNK = 500, RESTORE_CHUNK = 150, RESTORE_BYTES = 48000;
  function utf8Len(s) { return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(s).length : unescape(encodeURIComponent(s)).length; }
  function chunkRecords(records) {
    var out = [], cur = [], bytes = 0;
    records.forEach(function (r) {
      var n = utf8Len(JSON.stringify(r)) + 1;
      if (cur.length && (cur.length >= RESTORE_CHUNK || bytes + n > RESTORE_BYTES)) { out.push(cur); cur = []; bytes = 0; }
      cur.push(r); bytes += n;
    });
    if (cur.length) out.push(cur);
    return out;
  }
  function sequential(self, chunks, send, field) {
    var total = 0;
    return chunks.reduce(function (p, chunk) {
      return p.then(function () {
        return send(chunk).then(function (r) { total += (r && r[field]) || 0; });
      }).catch(function (e) { if (e && typeof e === 'object') e[field] = total; throw e; });
    }, Promise.resolve()).then(function () { return total; });
  }
  P.remove = function (ids) {
    var self = this;
    if (ids.length === 1) return this._json('DELETE', '/api/records/' + encodeURIComponent(ids[0])).then(function (r) { return r.deleted; });
    var chunks = []; for (var i = 0; i < ids.length; i += DELETE_CHUNK) chunks.push(ids.slice(i, i + DELETE_CHUNK));
    return sequential(self, chunks, function (c) { return self._json('POST', '/api/records/delete', { ids: c }); }, 'deleted');
  };
  P.restore = function (records) {
    var self = this;
    return sequential(self, chunkRecords(records), function (c) { return self._json('POST', '/api/records/restore', { records: c }); }, 'restored');
  };
  // 服务端分页（默认每页 2000、上限 5000）。调用方没指定 limit/offset 时这里自动翻页取全，
  // 返回的 records 是完整结果；count / totalCents 用服务端对全部命中记录算的合计。
  P.query = function (q) {
    var self = this, body = Object.assign({}, q || {});
    if (body.limit !== undefined || body.offset !== undefined) return self._json('POST', '/api/records/query', body);
    var all = [], first = null;
    function page(offset, guard) {
      return self._json('POST', '/api/records/query', Object.assign({}, body, { offset: offset })).then(function (r) {
        if (!first) first = r;
        var got = (r && r.records) || [];
        all = all.concat(got);
        if (r && r.hasMore && got.length > 0 && guard < 500) return page(offset + got.length, guard + 1);
        return Object.assign({}, first, { records: all, returned: all.length, hasMore: false });
      });
    }
    return page(0, 0);
  };
  P.stats = function (month, day) { return this._json('GET', '/api/stats?month=' + encodeURIComponent(month) + '&day=' + encodeURIComponent(day)); };
  P.duplicates = function (barcode, date, excludeId) {
    var code = (barcode || '').trim();
    if (!code) return Promise.resolve([]);
    return this.query({ from: date, to: date }).then(function (r) { return r.records.filter(function (x) { return x.barcode === code && x.id !== excludeId; }); });
  };
  P.assignBatch = function (ids, name) { return this._json('POST', '/api/records/batch', { ids: ids, name: name }).then(function (r) { return r.updated; }); };
  P.exportJson = function () { return this._text('/api/export.json'); };
  // Response.text() 会吃掉 UTF-8 BOM；补回，保持与服务端导出（Excel 可直接打开）一致
  P.exportCsv = function () { return this._text('/api/export.csv').then(function (t) { return t.charAt(0) === '\uFEFF' ? t : '\uFEFF' + t; }); };
  P.importText = function (text, mode) {
    return this._json('POST', '/api/import?mode=' + (mode === 'replace' ? 'replace&confirm=yes' : 'merge'), undefined, text);
  };
  P.wipe = function () { return this._json('POST', '/api/account/delete-data', { confirm: 'DELETE' }).then(function (r) { return r.deleted; }); };

  var api = { RemoteStore: RemoteStore };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.LifeRemote = api;
})(typeof self !== 'undefined' ? self : this);
