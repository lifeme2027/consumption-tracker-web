// 特性检测：不嗅探 User-Agent 来决定功能，只看 API 是否存在；浏览器名只用于给出更友好的提示。

/**
 * 同步部分。nav/win 可注入（测试用）。
 * 返回 {hasBluetooth, secureContext, hasGetAvailability, hasWatchAdvertisements, hasIndexedDB, family}
 */
export function detectSupport(nav = globalThis.navigator, win = globalThis) {
  const hasBluetooth = !!nav && 'bluetooth' in nav && !!nav.bluetooth;
  const BD = win.BluetoothDevice;
  return {
    hasBluetooth,
    secureContext: win.isSecureContext === true,
    // 浏览器是否给出了 isSecureContext 这个布尔值；老浏览器没有它（也没有 Web Bluetooth），那时不能断言「不是 HTTPS」。
    secureKnown: typeof win.isSecureContext === 'boolean',
    hasGetAvailability: hasBluetooth && typeof nav.bluetooth.getAvailability === 'function',
    hasWatchAdvertisements: !!(BD && BD.prototype && 'watchAdvertisements' in BD.prototype),
    hasIndexedDB: !!win.indexedDB,
    family: browserFamily(nav),
  };
}

/** 仅用于提示文案："chromium"（Chrome/Edge/Opera 等）| "firefox" | "safari" | "other"。 */
export function browserFamily(nav = globalThis.navigator) {
  const brands = nav?.userAgentData?.brands;
  if (Array.isArray(brands) && brands.some((b) => /chrom/i.test(b.brand))) return 'chromium';
  const ua = String(nav?.userAgent ?? '');
  if (/firefox\//i.test(ua)) return 'firefox';
  if (/(chrome|chromium|crios|edg)\//i.test(ua)) return 'chromium';
  if (/safari\//i.test(ua)) return 'safari';
  return 'other';
}

/** 蓝牙适配器是否可用：true / false / null（无法判断）。不抛异常。 */
export async function getAvailability(nav = globalThis.navigator) {
  try {
    if (!nav?.bluetooth || typeof nav.bluetooth.getAvailability !== 'function') return null;
    return (await nav.bluetooth.getAvailability()) === true;
  } catch {
    return null;
  }
}

/**
 * 汇总成界面用的状态码：'ok' | 'noApi' | 'insecure' | 'noAdapter'。
 * 必须先判安全上下文：在非安全上下文（http 且非 localhost）里 navigator.bluetooth 根本不存在（[SecureContext]），
 * 如果先判 hasBluetooth，用户只会看到「浏览器不支持」，而真正的原因是「需要 HTTPS」。
 */
export function supportLevel(sup, availability) {
  if (!sup.secureContext && sup.secureKnown !== false) return 'insecure';
  if (!sup.hasBluetooth) return 'noApi';
  if (!sup.secureContext) return 'insecure';
  if (availability === false) return 'noAdapter';
  return 'ok';
}
