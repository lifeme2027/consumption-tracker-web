// 十进制定点数（字符串 + BigInt）。全程不使用二进制浮点。
// 值的外部表示是十进制字符串（如 "70.005"）；内部用 {v: 带符号 BigInt, s: 小数位数}。
// 约定与桌面 Core 的 C# decimal 一致：乘以带 n 位小数的常数得到 n 位小数（保留末尾的 0，如 "70.000"）。

export const DEC_RE = /^-?(0|[1-9]\d*)(\.\d+)?$/;

/** 定义值（国际磅与英寸的定义）。 */
export const KG_PER_LB = '0.45359237';
export const M_PER_IN = '0.0254';

export function isDecimalString(s) {
  return typeof s === 'string' && s.length <= 40 && DEC_RE.test(s);
}

export function parse(str) {
  if (!isDecimalString(str)) throw new RangeError('not a decimal string: ' + String(str));
  const neg = str.startsWith('-');
  const body = neg ? str.slice(1) : str;
  const dot = body.indexOf('.');
  const s = dot < 0 ? 0 : body.length - dot - 1;
  const digits = dot < 0 ? body : body.slice(0, dot) + body.slice(dot + 1);
  const v = BigInt(digits);
  return { v: neg ? -v : v, s };
}

export function format({ v, s }) {
  const neg = v < 0n;
  let digits = (neg ? -v : v).toString();
  if (s > 0) {
    if (digits.length <= s) digits = '0'.repeat(s - digits.length + 1) + digits;
    digits = digits.slice(0, digits.length - s) + '.' + digits.slice(digits.length - s);
  }
  return (neg && v !== 0n ? '-' : '') + digits;
}

/** 整数 n（number 或 bigint）按 scale 位小数写成字符串：fromScaled(14001, 3) === "14.001"。 */
export function fromScaled(n, scale) {
  return format({ v: BigInt(n), s: scale });
}

const pow10 = (n) => 10n ** BigInt(n);

function align(a, b) {
  const s = Math.max(a.s, b.s);
  return [a.v * pow10(s - a.s), b.v * pow10(s - b.s), s];
}

export function compare(a, b) {
  const [x, y] = align(parse(a), parse(b));
  return x < y ? -1 : x > y ? 1 : 0;
}

export const equals = (a, b) => compare(a, b) === 0;

/** 乘法，结果小数位 = 两者小数位之和（精确，不舍入）。 */
export function mul(a, b) {
  const x = parse(a), y = parse(b);
  return format({ v: x.v * y.v, s: x.s + y.s });
}

/** 四舍五入（远离零）到 scale 位小数，返回固定 scale 位的字符串。 */
export function round(a, scale) {
  const x = parse(a);
  if (x.s <= scale) return format({ v: x.v * pow10(scale - x.s), s: scale });
  const d = pow10(x.s - scale);
  const neg = x.v < 0n;
  const abs = neg ? -x.v : x.v;
  let q = abs / d;
  if ((abs % d) * 2n >= d) q += 1n;
  return format({ v: neg ? -q : q, s: scale });
}

/** a / b，四舍五入（远离零）到 scale 位小数。b 不能为 0。 */
export function div(a, b, scale) {
  const x = parse(a), y = parse(b);
  if (y.v === 0n) throw new RangeError('division by zero');
  // (x.v / 10^x.s) / (y.v / 10^y.s) = x.v * 10^y.s / (y.v * 10^x.s)；再放大 10^scale
  let num = x.v * pow10(y.s + scale);
  let den = y.v * pow10(x.s);
  const neg = (num < 0n) !== (den < 0n);
  if (num < 0n) num = -num;
  if (den < 0n) den = -den;
  let q = num / den;
  if ((num % den) * 2n >= den) q += 1n;
  return format({ v: neg ? -q : q, s: scale });
}

/** 去掉小数部分末尾多余的 0，但至少保留 minFrac 位小数。 */
export function trimFraction(a, minFrac = 0) {
  const str = format(parse(a));
  const dot = str.indexOf('.');
  if (dot < 0) return minFrac > 0 ? str + '.' + '0'.repeat(minFrac) : str;
  let end = str.length;
  while (end - dot - 1 > minFrac && str[end - 1] === '0') end--;
  const out = str.slice(0, end);
  return out.endsWith('.') ? out.slice(0, -1) : out;
}

/** kg 显示：最多 3 位小数、至少 1 位（对应 C# 的 "0.0##"）。lb 显示：固定 2 位。 */
export function formatKgForDisplay(kg) {
  return trimFraction(round(kg, 3), 1);
}
export function kgToLbForDisplay(kg) {
  return round(div(kg, KG_PER_LB, 12), 2);
}
export function formatForUnit(kg, unit) {
  return unit === 'lb' ? kgToLbForDisplay(kg) : formatKgForDisplay(kg);
}
