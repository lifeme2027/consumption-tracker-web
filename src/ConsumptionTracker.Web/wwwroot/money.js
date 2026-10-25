/* 金额/数量解析：与桌面、手机共用同一规则，测试向量见 shared-vectors/*.json（scripts/test-money.js 在 CI 里逐条校验）。
 * - 价格字符串→分：十进制字符串精确解析，不经过浮点；超过两位小数按半进位 (half-up) 到分（1.005→101，2.675→268）。
 * - 逗号：只接受严格千分位（1,234.50、1,234,567）；12,5 / 1,5 / 1,234（有歧义）一律拒绝，请用小数点。
 * - 价格 ≤ 10 亿元；数量 >0、最多 6 位小数、≤ 1,000,000。
 * - 行合计：round_half_up(单价分 × 数量)，BigInt 整数运算。
 */
(function (root) {
  'use strict';
  var MAX_PRICE_CENTS = 100000000000;
  var QTY_DECIMALS = 6;
  var MAX_QTY_MICROS = 1000000n * 1000000n;

  function digits(s) { return /^[0-9]*$/.test(s); }

  function strictThousands(intPart, hasPoint) {
    var g = intPart.split(',');
    if (g.length < 2) return false;
    if (!/^[0-9]{1,3}$/.test(g[0])) return false;
    for (var i = 1; i < g.length; i++) if (!/^[0-9]{3}$/.test(g[i])) return false;
    if (g.length === 2 && !hasPoint) return false;
    return true;
  }

  /** "12.3" -> 1230；非法/歧义/负数/超限返回 null。 */
  function yuanToCents(text) {
    if (typeof text !== 'string') return null;
    var s = text.trim();
    if (s[0] === '¥' || s[0] === '￥') s = s.slice(1).replace(/^\s+/, '');
    if (!s) return null;
    var dot = s.indexOf('.');
    var intPart = dot < 0 ? s : s.slice(0, dot);
    var frac = dot < 0 ? '' : s.slice(dot + 1);
    if (dot >= 0 && !frac) return null;
    if (!digits(frac)) return null;
    if (intPart.indexOf(',') >= 0) {
      if (!strictThousands(intPart, dot >= 0)) return null;
      intPart = intPart.replace(/,/g, '');
    }
    if (!intPart || !digits(intPart)) return null;
    intPart = intPart.replace(/^0+/, '');
    if (intPart.length > 10) return null;
    var whole = intPart ? parseInt(intPart, 10) : 0;
    var f2 = (frac + '00').slice(0, 2);
    var v = whole * 100 + parseInt(f2, 10);
    if (frac.length > 2 && frac.charCodeAt(2) >= 53) v += 1; // '5'
    return v > MAX_PRICE_CENTS ? null : v;
  }

  /** 数量文本 → 微单位整数 (BigInt，1 = 0.000001)；非法返回 null。 */
  function qtyMicros(text) {
    if (typeof text !== 'string') return null;
    var s = text.trim();
    if (!s) return null;
    var dot = s.indexOf('.');
    var intPart = dot < 0 ? s : s.slice(0, dot);
    var frac = dot < 0 ? '' : s.slice(dot + 1);
    if (!intPart || !digits(intPart) || !digits(frac)) return null;
    if (dot >= 0 && !frac) return null;
    if (frac.length > QTY_DECIMALS) return null;
    var v = BigInt(intPart) * 1000000n + BigInt((frac + '000000').slice(0, QTY_DECIMALS));
    return (v > 0n && v <= MAX_QTY_MICROS) ? v : null;
  }

  /** 数量文本 → Number（用于 JSON 提交，最多 13 位有效数字，Number 往返精确）；非法返回 null。 */
  function parseQty(text) {
    var m = qtyMicros(text);
    return m == null ? null : Number(text.trim());
  }

  /** 行合计（分）：round_half_up(单价分 × 数量)；任一非法返回 null。 */
  function amountCents(priceCents, qtyText) {
    var m = qtyMicros(qtyText);
    if (priceCents == null || m == null) return null;
    return Number((BigInt(priceCents) * m + 500000n) / 1000000n);
  }

  var api = { yuanToCents: yuanToCents, parseQty: parseQty, qtyMicros: qtyMicros, amountCents: amountCents, MAX_PRICE_CENTS: MAX_PRICE_CENTS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.LifeMoney = api;
})(typeof self !== 'undefined' ? self : this);
