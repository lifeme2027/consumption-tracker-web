// 字节读取与十六进制文本转换。

/** 小端字节读取器；越界读取返回 null，不抛异常。 */
export class ByteReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.pos = 0;
  }
  get remaining() { return this.bytes.length - this.pos; }
  u8() {
    if (this.remaining < 1) return null;
    return this.bytes[this.pos++];
  }
  u16() {
    if (this.remaining < 2) return null;
    const v = this.bytes[this.pos] | (this.bytes[this.pos + 1] << 8);
    this.pos += 2;
    return v;
  }
  u32() {
    if (this.remaining < 4) return null;
    const b = this.bytes, p = this.pos;
    this.pos += 4;
    return (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;
  }
  take(n) {
    if (this.remaining < n) return null;
    const out = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
}

/**
 * 解析十六进制文本。允许空白、逗号、"0x" 前缀作为分隔；其余必须是成对的十六进制数字。
 * 成功返回 {ok:true, bytes}，失败返回 {ok:false, error}（error 为稳定的代码，供界面翻译）。
 */
export function parseHex(text) {
  if (typeof text !== 'string') return { ok: false, error: 'notText' };
  const cleaned = text.replace(/0x/gi, ' ').replace(/[\s,;:-]+/g, ' ').trim();
  if (cleaned === '') return { ok: true, bytes: new Uint8Array(0) };
  const tokens = cleaned.split(' ');
  const out = [];
  for (const tok of tokens) {
    if (!/^[0-9a-fA-F]+$/.test(tok)) return { ok: false, error: 'badChar' };
    if (tok.length % 2 !== 0) return { ok: false, error: 'oddLength' };
    for (let i = 0; i < tok.length; i += 2) out.push(parseInt(tok.slice(i, i + 2), 16));
  }
  if (out.length > 512) return { ok: false, error: 'tooLong' };
  return { ok: true, bytes: Uint8Array.from(out) };
}

export function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}
