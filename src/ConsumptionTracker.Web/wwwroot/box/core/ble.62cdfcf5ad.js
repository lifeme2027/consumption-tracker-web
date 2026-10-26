// Web Bluetooth 连接控制器。实验性（仅按规范实现，未真机验证）。
// 只在用户点击里调用 requestDevice；只访问 optionalServices 里声明的服务；解析走统一管线（pipeline.js）。
// bluetooth 对象可注入，所以测试里用伪造的 GATT 栈覆盖整个流程（这不是真机验证）。
// 不使用 Web Worker；不发任何网络请求。

import { UUID } from './protocol.19124bbe03.js';
import { processValue } from './pipeline.add5d7a784.js';

export const SERVICE_WEIGHT_SCALE = 0x181d;
export const SERVICE_BODY_COMPOSITION = 0x181b;
export const SERVICE_DEVICE_INFORMATION = 0x180a;
export const CHAR_MANUFACTURER_NAME = 0x2a29;
export const CHAR_MODEL_NUMBER = 0x2a24;

/** 每个标准服务下：Feature 特征与 Measurement 特征。 */
export const SERVICE_PLAN = Object.freeze([
  { service: SERVICE_WEIGHT_SCALE, feature: UUID.WEIGHT_SCALE_FEATURE, measurement: UUID.WEIGHT_MEASUREMENT },
  { service: SERVICE_BODY_COMPOSITION, feature: UUID.BODY_COMPOSITION_FEATURE, measurement: UUID.BODY_COMPOSITION_MEASUREMENT },
]);

export const OPTIONAL_SERVICES = Object.freeze([SERVICE_WEIGHT_SCALE, SERVICE_BODY_COMPOSITION, SERVICE_DEVICE_INFORMATION]);
export const RECONNECT_DELAYS_MS = Object.freeze([1000, 2000, 4000]);
/** 看门狗：GATT 连接 / 服务发现 / 订阅的每一步最长等待（Chromium 在某些故障下会让这些 Promise 永远不 settle）。 */
export const GATT_TIMEOUT_MS = 9000;
/** 可选步骤（Feature 读取、设备信息）的等待上限，超时即跳过。 */
export const OPTIONAL_TIMEOUT_MS = 3000;

/** Promise 加超时：超时抛 {name:'TimeoutError', code:'timeout'}。原 Promise 之后无论成败都被吞掉（不会产生未处理拒绝）。 */
export function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`${label} timed out after ${ms} ms`), { name: 'TimeoutError', code: 'timeout', step: label, ms })), ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

/** 把 DOMException / 其它错误映射为稳定的错误码（界面按码取文案）。 */
export function mapError(err) {
  const name = err?.name ?? '';
  const msg = String(err?.message ?? '');
  switch (name) {
    case 'NotFoundError': return /cancel/i.test(msg) ? 'cancelled' : 'noDevice';
    case 'SecurityError': return 'security';
    case 'NotAllowedError': return 'notAllowed';
    case 'NetworkError': return 'network';
    case 'InvalidStateError': return 'invalidState';
    case 'NotSupportedError': return 'notSupported';
    case 'AbortError': return 'aborted';
    case 'TimeoutError': return 'timeout';
    case 'TypeError': return 'badRequest';
    default: return 'unknown';
  }
}

export function requestOptions(acceptAll) {
  return acceptAll
    ? { acceptAllDevices: true, optionalServices: [...OPTIONAL_SERVICES] }
    : {
        filters: [{ services: [SERVICE_WEIGHT_SCALE] }, { services: [SERVICE_BODY_COMPOSITION] }],
        optionalServices: [...OPTIONAL_SERVICES],
      };
}

const bytesOf = (dv) => new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength).slice();
const text = (dv) => { try { return new TextDecoder('utf-8', { fatal: true }).decode(dv); } catch { return null; } };

/**
 * 状态：idle → requesting → connecting → connected → (reconnecting →) disconnected。
 * 事件：state{state,error?,attempt?}、device{id,name}、feature{service,feature,hex}、info{manufacturer,model}、
 *       record{record,warnings,hex}、unsuccessful{hex}、parseError{errorCode,hex,message}、error{code,detail}。
 */
export class ConnectionController {
  constructor({ bluetooth, now = () => new Date(), wait = (ms) => new Promise((r) => setTimeout(r, ms)), delays = RECONNECT_DELAYS_MS, timeoutMs = GATT_TIMEOUT_MS, optionalTimeoutMs = OPTIONAL_TIMEOUT_MS } = {}) {
    this.timeoutMs = timeoutMs;
    this.optionalTimeoutMs = optionalTimeoutMs;
    this.bluetooth = bluetooth;
    this.now = now;
    this.wait = wait;
    this.delays = delays;
    this.state = 'idle';
    this.device = null;
    this.listeners = new Map();
    this.subscriptions = [];
    this.userDisconnect = false;
    this.session = 0;
    this.onGattDisconnected = () => this.#handleDisconnect();
  }

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
    return () => this.listeners.get(event).delete(fn);
  }

  #emit(event, payload) {
    for (const fn of this.listeners.get(event) ?? []) {
      try { fn(payload); } catch (e) { queueMicrotask(() => { throw e; }); }
    }
  }

  #setState(state, extra = {}) {
    this.state = state;
    this.#emit('state', { state, ...extra });
  }

  #guard(promise, label) { return withTimeout(promise, this.timeoutMs, label); }
  #guardOptional(promise, label) { return withTimeout(promise, this.optionalTimeoutMs, label); }

  #fail(err, extra = {}) {
    const code = err?.code && typeof err.code === 'string' ? err.code : mapError(err);
    const timing = code === 'timeout' ? { step: err.step ?? null, timeoutMs: err.ms ?? null } : {};
    this.#emit('error', { code, detail: String(err?.message ?? err ?? ''), ...timing, ...extra });
    return code;
  }

  get deviceInfo() {
    return this.device ? { deviceId: `web:${this.device.id}`, deviceName: this.device.name || null, isDemo: false } : null;
  }

  /** 必须在用户点击的同步调用栈里调用（Chromium 要求用户手势）。 */
  async requestAndConnect({ acceptAll = false } = {}) {
    if (!this.bluetooth) { this.#fail({ name: 'NotSupportedError', message: 'navigator.bluetooth missing' }); return false; }
    if (['requesting', 'connecting', 'connected', 'reconnecting'].includes(this.state)) return false;
    this.#setState('requesting');
    let device;
    try {
      device = await this.bluetooth.requestDevice(requestOptions(acceptAll));
    } catch (err) {
      this.#fail(err);
      this.#setState('idle');
      return false;
    }
    this.#detach();
    this.device = device;
    this.#emit('device', { id: device.id, name: device.name || null });
    return this.#connect();
  }

  /** 对上次选择的设备重连（不需要再弹选择器）。 */
  async reconnect() {
    if (!this.device) return false;
    if (['connecting', 'connected', 'reconnecting', 'requesting'].includes(this.state)) return false;
    return this.#connect();
  }

  async disconnect() {
    this.userDisconnect = true;
    this.session++;
    this.#teardown();
    try { this.device?.gatt?.disconnect?.(); } catch { /* 已断开 */ }
    this.#setState('disconnected');
  }

  #detach() {
    try { this.device?.removeEventListener?.('gattserverdisconnected', this.onGattDisconnected); } catch { /* ignore */ }
  }

  #teardown() {
    for (const { ch, handler } of this.subscriptions) {
      try { ch.removeEventListener('characteristicvaluechanged', handler); } catch { /* ignore */ }
      try { ch.stopNotifications?.()?.catch?.(() => {}); } catch { /* ignore */ }
    }
    this.subscriptions = [];
  }

  async #connect() {
    const session = ++this.session;
    this.userDisconnect = false;
    this.#setState('connecting');
    const device = this.device;
    device.removeEventListener('gattserverdisconnected', this.onGattDisconnected);
    device.addEventListener('gattserverdisconnected', this.onGattDisconnected);
    try {
      const server = await this.#guard(device.gatt.connect(), 'gatt.connect');
      if (session !== this.session) return false;
      const subscribed = await this.#setup(server, session);
      if (session !== this.session) return false;
      if (subscribed === 0) {
        const e = new Error('no weight-scale (0x181D) or body-composition (0x181B) service with a notifiable measurement characteristic');
        e.code = 'noSupportedService';
        throw e;
      }
      this.#setState('connected');
      return true;
    } catch (err) {
      if (session !== this.session) return false;
      this.#teardown();
      try { device.gatt?.disconnect?.(); } catch { /* ignore */ }
      this.#fail(err);
      this.#setState('disconnected');
      return false;
    }
  }

  /** 读 Feature（尽力）、订阅 Measurement、读设备信息（尽力）。返回成功订阅的特征数。 */
  async #setup(server, session) {
    let subscribed = 0;
    for (const plan of SERVICE_PLAN) {
      let svc;
      try { svc = await this.#guard(server.getPrimaryService(plan.service), `getPrimaryService(0x${plan.service.toString(16)})`); } catch (e) {
        if (e?.name === 'NotFoundError') continue; // 设备没有这个服务
        throw e;
      }
      try {
        const fch = await this.#guardOptional(svc.getCharacteristic(plan.feature), 'getCharacteristic(feature)');
        const dv = await this.#guardOptional(fch.readValue(), 'readValue(feature)');
        this.#dispatch(plan.service, plan.feature, bytesOf(dv));
      } catch { /* Feature 是可选的；读不到不影响订阅 */ }
      if (session !== this.session) return subscribed;
      let mch;
      try { mch = await this.#guard(svc.getCharacteristic(plan.measurement), 'getCharacteristic(measurement)'); } catch (e) {
        if (e?.name === 'NotFoundError') continue;
        throw e;
      }
      const handler = (ev) => this.#dispatch(plan.service, plan.measurement, bytesOf(ev.target.value));
      mch.addEventListener('characteristicvaluechanged', handler);
      this.subscriptions.push({ ch: mch, handler });
      await this.#guard(mch.startNotifications(), 'startNotifications'); // Web Bluetooth 的 startNotifications 对 notify 与 indicate 都适用
      subscribed++;
    }
    try {
      const info = await this.#guardOptional(server.getPrimaryService(SERVICE_DEVICE_INFORMATION), 'getPrimaryService(0x180a)');
      const read = async (c) => { try { return text(await this.#guardOptional((async () => (await info.getCharacteristic(c)).readValue())(), 'readValue(info)')); } catch { return null; } };
      const manufacturer = await read(CHAR_MANUFACTURER_NAME);
      const model = await read(CHAR_MODEL_NUMBER);
      if (manufacturer !== null || model !== null) this.#emit('info', { manufacturer, model });
    } catch { /* 设备信息服务是可选的 */ }
    return subscribed;
  }

  #dispatch(service, characteristic, bytes) {
    const res = processValue(service, characteristic, bytes, this.deviceInfo, this.now());
    switch (res.kind) {
      case 'record': this.#emit('record', res); break;
      case 'unsuccessful': this.#emit('unsuccessful', res); break;
      case 'feature': this.#emit('feature', { service, ...res }); break;
      default: this.#emit('parseError', res);
    }
  }

  async #handleDisconnect() {
    if (this.userDisconnect || this.state !== 'connected') return;
    const session = this.session;
    this.#teardown();
    for (let attempt = 1; attempt <= this.delays.length; attempt++) {
      this.#setState('reconnecting', { attempt, max: this.delays.length });
      await this.wait(this.delays[attempt - 1]);
      if (session !== this.session || this.userDisconnect) return;
      try {
        const server = await this.#guard(this.device.gatt.connect(), 'gatt.connect');
        if (session !== this.session) return;
        const n = await this.#setup(server, session);
        if (session !== this.session) return;
        if (n === 0) throw Object.assign(new Error('no measurement characteristic'), { code: 'noSupportedService' });
        this.#setState('connected');
        return;
      } catch (err) {
        if (session !== this.session) return;
        this.#teardown();
        try { this.device.gatt?.disconnect?.(); } catch { /* ignore */ }
        this.#emit('error', { code: 'reconnectFailed', detail: String(err?.message ?? err), attempt });
      }
    }
    this.#fail({ code: 'connectionLost', message: 'reconnect attempts exhausted' });
    this.#setState('disconnected');
  }
}
