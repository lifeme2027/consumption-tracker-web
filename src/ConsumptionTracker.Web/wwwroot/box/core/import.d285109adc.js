// 严格的 CSV / JSON 导入。不信任任何输入：
//   * JSON 用手写解析器，保留数字标记原文（JSON.parse 会把 70.005 之类先变成二进制浮点）；
//   * 版本、格式名、列头、类型、取值范围、日期有效性逐项校验；坏行跳过并逐行报告；
//   * 与已有记录/同文件内重复的行跳过（重复导入是幂等的）；
//   * 有体积与行数上限。
// 返回值只含稳定的错误代码（界面负责翻译）。

import { DEC_RE, trimFraction } from './decimal.d1b6f6c095.js';
import { FIELDS, SOURCES, VALUE_KEYS, recordSignature } from './measurement.0911573984.js';
import { CSV_HEADER, JSON_FORMAT, JSON_VERSION, unguardText } from './export.d16d97726f.js';

export const LIMITS = Object.freeze({ maxChars: 5_000_000, maxRecords: 50_000, maxText: 128, maxDepth: 16 });

// ------------------------------------------------------------------ 单条记录校验

const DT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/;
const RT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z|[+-]\d{2}:\d{2})$/;
const INT_RE = /^(0|[1-9]\d*)$/;
const BAD_TEXT_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function validDate(y, mo, d, h, mi, s) {
  if (y < 1582 || y > 9999 || mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  return d <= dim;
}

const DEC_MAX_INT_DIGITS = 7; // 数值上限 < 1e7，远大于任何协议可产生的值
const INT_RANGES = { rawWeight: [0, 65535], basalMetabolismKj: [0, 65535], userId: [0, 255] };

/** raw 为字段原始值：null | string（decimal/文本）；整数/小数在 JSON 路径下是 {num: token}，调用方已统一成字符串或 null。 */
function checkRecord(raw) {
  const out = {};
  for (const [, key, kind] of FIELDS) {
    const v = raw[key];
    switch (kind) {
      case 'deviceTime': {
        if (v === null) { out[key] = null; break; }
        const m = typeof v === 'string' && DT_RE.exec(v);
        if (!m || !validDate(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6])) return { error: 'badDeviceTime', field: key };
        out[key] = v;
        break;
      }
      case 'receivedTime': {
        const m = typeof v === 'string' && RT_RE.exec(v);
        if (!m || !validDate(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6])) return { error: 'badReceivedTime', field: key };
        if (m[7] !== 'Z') {
          const oh = +m[7].slice(1, 3), om = +m[7].slice(4, 6);
          if (oh > 14 || om > 59) return { error: 'badReceivedTime', field: key };
        }
        out[key] = v.slice(0, 19) + (m[7] === 'Z' ? '+00:00' : m[7]);
        break;
      }
      case 'dec': {
        if (v === null) { out[key] = null; break; }
        if (typeof v !== 'string' || v.length > 24 || !DEC_RE.test(v) || v.startsWith('-')) return { error: 'badNumber', field: key };
        if (v.split('.')[0].length > DEC_MAX_INT_DIGITS) return { error: 'badNumber', field: key };
        out[key] = v;
        break;
      }
      case 'int': {
        if (v === null) { out[key] = null; break; }
        if (typeof v !== 'string' || !INT_RE.test(v) || v.length > 6) return { error: 'badNumber', field: key };
        const n = Number(v);
        const [lo, hi] = INT_RANGES[key];
        if (n < lo || n > hi) return { error: 'badNumber', field: key };
        out[key] = n;
        break;
      }
      case 'unit': {
        if (v === null) { out[key] = null; break; }
        if (v !== 'kg' && v !== 'lb') return { error: 'badUnit', field: key };
        out[key] = v;
        break;
      }
      case 'source': {
        if (!SOURCES.includes(v)) return { error: 'badSource', field: key };
        out[key] = v;
        break;
      }
      case 'bool': {
        if (v !== true && v !== false) return { error: 'badBoolean', field: key };
        out[key] = v;
        break;
      }
      case 'text': {
        if (key === 'deviceName' && v === null) { out[key] = null; break; }
        if (typeof v !== 'string' || v.length > LIMITS.maxText || BAD_TEXT_RE.test(v) || (key === 'deviceId' && v === '')) {
          return { error: 'badText', field: key };
        }
        out[key] = v;
        break;
      }
    }
  }
  if (out.weightOriginal !== null && out.originalUnit === null) return { error: 'badUnit', field: 'originalUnit' };
  if (!VALUE_KEYS.some((k) => out[k] !== null)) return { error: 'noValues', field: null };
  return { record: out };
}

// ------------------------------------------------------------------ JSON（保留数字原文）

class JsonError extends Error {}

class JsonNumber {
  constructor(token) { this.token = token; }
}

/** 严格 JSON 解析（RFC 8259）：拒绝重复键、深度过大、尾随内容；数字返回 JsonNumber 保留原文。 */
export function parseJsonExact(text) {
  let i = 0;
  const fail = (msg) => { throw new JsonError(`${msg} at ${i}`); };
  const ws = () => { while (i < text.length && ' \t\n\r'.includes(text[i])) i++; };
  const value = (depth) => {
    if (depth > LIMITS.maxDepth) fail('too deep');
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      const obj = Object.create(null);
      ws();
      if (text[i] === '}') { i++; return obj; }
      for (;;) {
        ws();
        if (text[i] !== '"') fail('expected key');
        const k = str();
        if (k in obj) fail('duplicate key');
        ws();
        if (text[i++] !== ':') fail('expected :');
        obj[k] = value(depth + 1);
        ws();
        const d = text[i++];
        if (d === '}') return obj;
        if (d !== ',') fail('expected , or }');
      }
    }
    if (c === '[') {
      i++;
      const arr = [];
      ws();
      if (text[i] === ']') { i++; return arr; }
      for (;;) {
        arr.push(value(depth + 1));
        ws();
        const d = text[i++];
        if (d === ']') return arr;
        if (d !== ',') fail('expected , or ]');
      }
    }
    if (c === '"') return str();
    if (text.startsWith('true', i)) { i += 4; return true; }
    if (text.startsWith('false', i)) { i += 5; return false; }
    if (text.startsWith('null', i)) { i += 4; return null; }
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i, i + 64));
    if (!m) fail('unexpected token');
    i += m[0].length;
    return new JsonNumber(m[0]);
  };
  const str = () => {
    i++; // 开头的 "
    let out = '';
    for (;;) {
      if (i >= text.length) fail('unterminated string');
      const c = text[i++];
      if (c === '"') return out;
      if (c < ' ') fail('control char in string');
      if (c !== '\\') { out += c; continue; }
      const e = text[i++];
      switch (e) {
        case '"': out += '"'; break;
        case '\\': out += '\\'; break;
        case '/': out += '/'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'n': out += '\n'; break;
        case 'r': out += '\r'; break;
        case 't': out += '\t'; break;
        case 'u': {
          const hex = text.slice(i, i + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('bad \\u escape');
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
          break;
        }
        default: fail('bad escape');
      }
    }
  };
  const v = value(0);
  ws();
  if (i < text.length) fail('trailing content');
  return v;
}

function jsonField(v, kind) {
  const numeric = kind === 'dec' || kind === 'int';
  if (v instanceof JsonNumber) return numeric ? v.token : { invalid: true }; // 令牌交给 checkRecord 校验（含拒绝科学计数法）
  if (numeric) return v === null || v === undefined ? null : { invalid: true }; // 数字字段不接受字符串/布尔
  return v === undefined ? null : v;
}

// ------------------------------------------------------------------ 公共入口

function finish(candidates, existing, extra) {
  const seen = new Set((existing ?? []).map(recordSignature));
  const records = [];
  const rejected = [];
  let duplicates = 0;
  for (const c of candidates) {
    if (c.error) { rejected.push({ row: c.row, error: c.error, field: c.field ?? null }); continue; }
    const sig = recordSignature(c.record);
    if (seen.has(sig)) { duplicates++; continue; }
    seen.add(sig);
    records.push(c.record);
  }
  return { ok: true, records, rejected, duplicates, ...extra };
}

/** 导入 JSON 文本。existing 为已存储记录（用于去重）。 */
export function importJson(text, existing = []) {
  if (typeof text !== 'string' || text.length === 0) return { ok: false, error: 'empty' };
  if (text.length > LIMITS.maxChars) return { ok: false, error: 'tooLarge' };
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let doc;
  try { doc = parseJsonExact(text); } catch { return { ok: false, error: 'notJson' }; }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return { ok: false, error: 'notExport' };
  if (doc.format !== JSON_FORMAT) return { ok: false, error: 'wrongFormat' };
  if (!(doc.version instanceof JsonNumber)) return { ok: false, error: 'missingVersion' };
  if (!INT_RE.test(doc.version.token) || Number(doc.version.token) < 1) return { ok: false, error: 'badVersion' };
  if (Number(doc.version.token) > JSON_VERSION) return { ok: false, error: 'newerVersion', version: Number(doc.version.token) };
  if (!Array.isArray(doc.measurements)) return { ok: false, error: 'noMeasurements' };
  if (doc.measurements.length > LIMITS.maxRecords) return { ok: false, error: 'tooMany' };
  const candidates = doc.measurements.map((m, idx) => {
    const row = idx + 1;
    if (m === null || typeof m !== 'object' || Array.isArray(m)) return { row, error: 'notObject' };
    const raw = {};
    for (const [, key, kind] of FIELDS) raw[key] = jsonField(m[key], kind);
    const r = checkRecord(raw);
    return r.error ? { row, error: r.error, field: r.field } : { row, record: r.record };
  });
  return finish(candidates, existing, { total: doc.measurements.length, format: 'json' });
}

// ------------------------------------------------------------------ CSV

/** RFC 4180 解析；引号内可含逗号/换行/双引号。格式有误返回 null。 */
export function parseCsvRows(text) {
  const rows = [];
  let row = [], field = '', i = 0, inQuotes = false, fieldStarted = false;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++;
        if (i < n && text[i] !== ',' && text[i] !== '\r' && text[i] !== '\n') return null; // 引号后只能是分隔符
        continue;
      }
      field += c; i++;
      continue;
    }
    if (c === '"') {
      if (field !== '' || fieldStarted) return null; // 引号只能出现在字段开头
      inQuotes = true; fieldStarted = true; i++;
    } else if (c === ',') {
      row.push(field); field = ''; fieldStarted = false; i++;
    } else if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      i++;
      row.push(field); field = ''; fieldStarted = false;
      rows.push(row); row = [];
    } else {
      field += c; fieldStarted = true; i++;
    }
  }
  if (inQuotes) return null;
  if (fieldStarted || field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

const CSV_FIELD_KIND = new Map(FIELDS.map(([col, key, kind]) => [col, { key, kind }]));

/** CSV 单元格 → 校验用的原始值。 */
function csvCell(cell, kind, key) {
  switch (kind) {
    case 'deviceTime': return cell === '' ? null : cell;
    case 'receivedTime': return cell;
    case 'dec': case 'int': case 'unit': return cell === '' ? null : cell;
    case 'bool': return cell === 'true' ? true : cell === 'false' ? false : cell;
    case 'source': return cell;
    case 'text': return key === 'deviceName' ? (cell === '' ? null : unguardText(cell)) : unguardText(cell);
    default: return cell;
  }
}

/** 导入 CSV 文本（桌面 CsvExporter 或本页导出的格式）。existing 为已存储记录（用于去重）。 */
export function importCsv(text, existing = []) {
  if (typeof text !== 'string' || text.length === 0) return { ok: false, error: 'empty' };
  if (text.length > LIMITS.maxChars) return { ok: false, error: 'tooLarge' };
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = parseCsvRows(text);
  if (rows === null) return { ok: false, error: 'badCsv' };
  if (rows.length === 0) return { ok: false, error: 'empty' };
  const header = rows[0];
  const idx = new Map();
  for (let c = 0; c < header.length; c++) {
    if (idx.has(header[c])) return { ok: false, error: 'badHeader' };
    idx.set(header[c], c);
  }
  if (!CSV_HEADER.every((h) => idx.has(h))) return { ok: false, error: 'badHeader' };
  const dataRows = rows.slice(1).filter((r) => !(r.length === 1 && r[0] === ''));
  if (dataRows.length > LIMITS.maxRecords) return { ok: false, error: 'tooMany' };
  const candidates = dataRows.map((cells, n) => {
    const row = n + 1;
    if (cells.length !== header.length) return { row, error: 'columnCount' };
    const raw = {};
    for (const [col, { key, kind }] of CSV_FIELD_KIND) raw[key] = csvCell(cells[idx.get(col)], kind, key);
    const r = checkRecord(raw);
    return r.error ? { row, error: r.error, field: r.field } : { row, record: r.record };
  });
  const unknownColumns = header.filter((h) => !CSV_FIELD_KIND.has(h)).length;
  return finish(candidates, existing, { total: dataRows.length, format: 'csv', unknownColumns });
}

/** 按内容自动判断 CSV / JSON（粘贴文本时用）。 */
export function importAuto(text, existing = []) {
  if (typeof text !== 'string') return { ok: false, error: 'empty' };
  const t = text.replace(/^\uFEFF/, '').trimStart();
  if (t === '') return { ok: false, error: 'empty' };
  return t[0] === '{' || t[0] === '[' ? importJson(text, existing) : importCsv(text, existing);
}

/** 读取用户选择的文件为文本：严格 UTF-8（非法字节报错），不信任文件名/类型。 */
export async function readFileText(file) {
  if (file.size > LIMITS.maxChars) return { ok: false, error: 'tooLarge' };
  try {
    const buf = await file.arrayBuffer();
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(buf) };
  } catch {
    return { ok: false, error: 'badEncoding' };
  }
}

export { trimFraction };
