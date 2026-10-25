/* 模式控制器：默认「本地」；登录 Kaspa 后进入「云端」；退出云端/会话过期回到本地。
 * 不依赖 DOM，便于测试。UI 订阅 onChange 刷新。任何功能都不以登录为前提。
 * 偏好 life.mode 存 localStorage：'cloud' 表示上次是云端（下次打开时仅在会话仍有效时回到云端，否则本地）。 */
(function (root) {
  'use strict';
  var KEY = 'life.mode';

  function ModeController(opts) {
    this.local = opts.local;                 // 本地存储实例（常驻）
    this.makeRemote = opts.makeRemote;       // () => RemoteStore
    this.probe = opts.probe;                 // () => Promise<{address}>，会话是否有效（登录后才会调用）
    this.storage = opts.storage || null;     // localStorage 兼容对象（可为 null）
    this.mode = 'local'; this.address = null; this.store = this.local; this.remote = null;
    this.listeners = [];
  }
  var P = ModeController.prototype;
  P.onChange = function (f) { this.listeners.push(f); };
  P._emit = function (reason) { var s = this; this.listeners.forEach(function (f) { f({ mode: s.mode, address: s.address, reason: reason || '' }); }); };
  P._pref = function (v) { try { if (this.storage) { if (v == null) return this.storage.getItem(KEY); this.storage.setItem(KEY, v); } } catch (e) { /* 隐私模式下忽略 */ } return null; };

  /** 启动：本地模式不发任何网络请求；只有上次是云端时才探测会话。 */
  P.init = function () {
    var self = this;
    if (this._pref() !== 'cloud') { this._emit('init'); return Promise.resolve(this.mode); }
    return Promise.resolve().then(function () { return self.probe(); })
      .then(function (me) { self._enterCloud(me.address, 'init'); return self.mode; })
      .catch(function () { self._pref('local'); self._emit('init'); return self.mode; });
  };
  P._enterCloud = function (address, reason) {
    this.remote = this.makeRemote(); this.store = this.remote; this.mode = 'cloud'; this.address = address;
    this._pref('cloud'); this._emit(reason);
  };
  P.loginSucceeded = function (address) { this._enterCloud(address, 'login'); };
  P._leave = function (reason) {
    this.mode = 'local'; this.address = null; this.store = this.local; this.remote = null; this._pref('local'); this._emit(reason);
  };
  /** 退出云端：先让调用方作废服务器会话（logout），无论成功与否都回到本地；本地数据不受影响。 */
  P.logout = function (doLogout) {
    var self = this;
    return Promise.resolve().then(function () { return doLogout ? doLogout() : null; }).catch(function () {}).then(function () { self._leave('logout'); });
  };
  P.sessionExpired = function () { if (this.mode === 'cloud') this._leave('expired'); };

  var api = { ModeController: ModeController, PREF_KEY: KEY };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.LifeMode = api;
})(typeof self !== 'undefined' ? self : this);
