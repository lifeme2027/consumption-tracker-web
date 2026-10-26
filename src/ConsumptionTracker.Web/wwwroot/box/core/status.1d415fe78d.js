// 状态消息：存「键 + 参数」而不是已翻译的字符串，这样切换语言时可以按新语言重新渲染（SBW-L04）。
// 参数值可以是另一条消息 {key, params}（如「十六进制有误：{reason}」里的 reason），渲染时递归翻译。

/** 创建一条消息。 */
export function msg(key, params) { return params === undefined ? { key } : { key, params }; }

const isMsg = (v) => v !== null && typeof v === 'object' && typeof v.key === 'string';

/** 用翻译函数 t 渲染一条消息；null/undefined → 空字符串。 */
export function renderMsg(t, m) {
  if (!m) return '';
  if (typeof m === 'string') return m; // 兼容：已是文本（不会随语言变化，代码里不应再这样用）
  let params;
  if (m.params) {
    params = {};
    for (const [k, v] of Object.entries(m.params)) params[k] = isMsg(v) ? renderMsg(t, v) : v;
  }
  return t(m.key, params);
}

/** 把若干段（消息 / 纯文本）按 sep 拼起来渲染，空段跳过。 */
export function renderParts(t, parts, sep = '\n\n') {
  return parts.map((p) => (typeof p === 'string' ? p : renderMsg(t, p))).filter((x) => x !== '').join(sep);
}
