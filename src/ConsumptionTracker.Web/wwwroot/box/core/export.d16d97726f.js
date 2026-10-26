// CSV / JSON 导出——与桌面 ScaleBridge.Core.Export.CsvExporter / JsonExporter 的格式一致，两端导出的文件可互相导入。
//   CSV：UTF-8 BOM + CRLF；设备 ID/名称两列做公式注入防护（以 = + - @ Tab CR 开头加前导单引号）；数值列不加引号前缀。
//   JSON：{format:"scalebridge-export", version:1, ...}，缩进 2 空格，十进制按原样写成 JSON 数字（不经过浮点）。

import { FIELDS, SOURCES, compareRecords, formatReceivedTime } from './measurement.0911573984.js';

export const CSV_HEADER = Object.freeze(FIELDS.map((f) => f[0]));
export const JSON_FORMAT = 'scalebridge-export';
export const JSON_VERSION = 1;
export const JSON_NOTE =
  'Experimental: parsed per Bluetooth SIG spec only, not verified on real hardware. Records with demo=true are demo data, not real weights.';

const isTrigger = (c) => c === '=' || c === '+' || c === '-' || c === '@' || c === '\t' || c === '\r';

/** 与桌面 GuardText 相同：跳过开头任意个 '，其后若是触发字符，则整体前加一个 '。 */
export function guardText(value) {
  let i = 0;
  while (i < value.length && value[i] === "'") i++;
  return i < value.length && isTrigger(value[i]) ? "'" + value : value;
}

/** guardText 的逆运算（导入用）：仅当去掉一个前导 ' 后确实"需要防护"才去掉，因此 unguardText(guardText(x)) === x。 */
export function unguardText(value) {
  if (!value.startsWith("'")) return value;
  const rest = value.slice(1);
  return guardText(rest) === value ? rest : value;
}

export function escapeCsv(value) {
  return /[,"\r\n]/.test(value) ? '"' + value.replaceAll('"', '""') + '"' : value;
}

const sourceName = (s) => (SOURCES.includes(s) ? s : 'unknown');

function sorted(records) {
  return [...records].sort(compareRecords);
}

export function toCsv(records) {
  const lines = [CSV_HEADER.join(',')];
  for (const r of sorted(records)) {
    const cols = FIELDS.map(([, key, kind]) => {
      const v = r[key];
      switch (kind) {
        case 'bool': return v ? 'true' : 'false';
        case 'source': return sourceName(v);
        case 'text': return v === null || v === undefined ? '' : guardText(String(v));
        default: return v === null || v === undefined ? '' : String(v);
      }
    });
    lines.push(cols.map(escapeCsv).join(','));
  }
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

function jsonValue(v, kind) {
  if (v === null || v === undefined) return 'null';
  switch (kind) {
    case 'dec': case 'int': return String(v); // 十进制字符串原样成为 JSON 数字标记
    case 'bool': return v ? 'true' : 'false';
    case 'source': return JSON.stringify(sourceName(v));
    default: return JSON.stringify(String(v));
  }
}

export function toJson(records, exportedAt = new Date()) {
  const list = sorted(records);
  const out = [];
  out.push('{');
  out.push(`  "format": ${JSON.stringify(JSON_FORMAT)},`);
  out.push(`  "version": ${JSON_VERSION},`);
  out.push(`  "exportedAt": ${JSON.stringify(formatReceivedTime(exportedAt))},`);
  out.push(`  "note": ${JSON.stringify(JSON_NOTE)},`);
  out.push(`  "count": ${list.length},`);
  if (list.length === 0) {
    out.push('  "measurements": []');
  } else {
    out.push('  "measurements": [');
    list.forEach((r, i) => {
      out.push('    {');
      FIELDS.forEach(([, key, kind], j) => {
        out.push(`      ${JSON.stringify(key)}: ${jsonValue(r[key], kind)}${j < FIELDS.length - 1 ? ',' : ''}`);
      });
      out.push(`    }${i < list.length - 1 ? ',' : ''}`);
    });
    out.push('  ]');
  }
  out.push('}');
  return out.join('\n') + '\n';
}

/** 导出文件名：scalebridge-YYYYMMDD-HHMMSS[-demo].csv|json。含演示数据时文件名带 -demo。 */
export function exportFileName(ext, now = new Date(), hasDemo = false) {
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `scalebridge-${stamp}${hasDemo ? '-demo' : ''}.${ext}`;
}
