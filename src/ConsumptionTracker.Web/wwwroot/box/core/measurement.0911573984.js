// 应用级测量记录（与桌面 Core 的 Measurement 一一对应）与由解析结果生成记录的工厂。
// 记录是纯 JSON 对象：十进制值一律是十进制字符串，整数是 number，缺失是 null。

import { trimFraction } from './decimal.d1b6f6c095.js';

export const SOURCES = ['weight-scale', 'body-composition'];

/** [CSV 列名, JSON/记录键, 类型]——顺序即导出顺序（与桌面 CsvExporter.Header / JsonExporter 一致）。 */
export const FIELDS = Object.freeze([
  ['device_time', 'deviceTime', 'deviceTime'],
  ['received_time', 'receivedTime', 'receivedTime'],
  ['weight_kg', 'weightKg', 'dec'],
  ['weight_original', 'weightOriginal', 'dec'],
  ['original_unit', 'originalUnit', 'unit'],
  ['raw_weight', 'rawWeight', 'int'],
  ['bmi', 'bmi', 'dec'],
  ['height_m', 'heightM', 'dec'],
  ['body_fat_percent', 'bodyFatPercent', 'dec'],
  ['muscle_percent', 'musclePercent', 'dec'],
  ['muscle_mass_kg', 'muscleMassKg', 'dec'],
  ['fat_free_mass_kg', 'fatFreeMassKg', 'dec'],
  ['soft_lean_mass_kg', 'softLeanMassKg', 'dec'],
  ['body_water_mass_kg', 'bodyWaterMassKg', 'dec'],
  ['basal_metabolism_kj', 'basalMetabolismKj', 'int'],
  ['impedance_ohm', 'impedanceOhm', 'dec'],
  ['user_id', 'userId', 'int'],
  ['device_id', 'deviceId', 'text'],
  ['device_name', 'deviceName', 'text'],
  ['source', 'source', 'source'],
  ['experimental', 'experimental', 'bool'],
  ['demo', 'demo', 'bool'],
]);

/** 至少要有其中一个值，记录才有意义。 */
export const VALUE_KEYS = Object.freeze([
  'weightKg', 'bmi', 'heightM', 'bodyFatPercent', 'musclePercent', 'muscleMassKg', 'fatFreeMassKg',
  'softLeanMassKg', 'bodyWaterMassKg', 'basalMetabolismKj', 'impedanceOhm',
]);

const p2 = (n) => String(n).padStart(2, '0');

/** 本地时区的 "YYYY-MM-DDTHH:MM:SS+08:00"（秒精度，与桌面 'yyyy-MM-dd'T'HH:mm:sszzz' 一致）。 */
export function formatReceivedTime(date) {
  const off = -date.getTimezoneOffset();
  const sign = off < 0 ? '-' : '+';
  const a = Math.abs(off);
  return `${String(date.getFullYear()).padStart(4, '0')}-${p2(date.getMonth() + 1)}-${p2(date.getDate())}T${p2(date.getHours())}:${p2(date.getMinutes())}:${p2(date.getSeconds())}${sign}${p2(Math.floor(a / 60))}:${p2(a % 60)}`;
}

/** 排序键（墙上时间，与桌面 DisplayTime = DeviceTimestamp ?? ReceivedAt.LocalDateTime 同义）。 */
export function displayKey(rec) {
  return rec.deviceTime ?? rec.receivedTime.slice(0, 19);
}

export function compareRecords(a, b) {
  const ka = displayKey(a), kb = displayKey(b);
  if (ka !== kb) return ka < kb ? -1 : 1;
  return (a.id ?? 0) - (b.id ?? 0);
}

function base(device, receivedAt, source) {
  return {
    deviceTime: null,
    receivedTime: formatReceivedTime(receivedAt),
    weightKg: null, weightOriginal: null, originalUnit: null, rawWeight: null,
    bmi: null, heightM: null, bodyFatPercent: null, musclePercent: null,
    muscleMassKg: null, fatFreeMassKg: null, softLeanMassKg: null, bodyWaterMassKg: null,
    basalMetabolismKj: null, impedanceOhm: null, userId: null,
    deviceId: device.deviceId, deviceName: device.deviceName ?? null,
    source,
    experimental: true,
    demo: !!device.isDemo,
  };
}

const unitName = (u) => (u === 'imperial' ? 'lb' : 'kg');

/** 0x2A9D 解析结果 → 记录；测量不成功（0xFFFF）返回 null——不存没有数值的记录。 */
export function fromWeightScale(d, device, receivedAt) {
  if (d.measurementUnsuccessful || d.weight === null) return null;
  const r = base(device, receivedAt, 'weight-scale');
  r.deviceTime = d.timestamp;
  r.weightKg = d.weight.kilograms;
  r.weightOriginal = d.weight.original;
  r.originalUnit = unitName(d.unit);
  r.rawWeight = d.weight.raw;
  r.bmi = d.bmi;
  r.heightM = d.height ? d.height.meters : null;
  r.userId = d.userId;
  return r;
}

/** 0x2A9C 解析结果 → 记录；测量不成功返回 null。 */
export function fromBodyComposition(d, device, receivedAt) {
  if (d.measurementUnsuccessful) return null;
  const r = base(device, receivedAt, 'body-composition');
  r.deviceTime = d.timestamp;
  if (d.weight) {
    r.weightKg = d.weight.kilograms;
    r.weightOriginal = d.weight.original;
    r.originalUnit = unitName(d.unit);
    r.rawWeight = d.weight.raw;
  }
  r.heightM = d.height ? d.height.meters : null;
  r.bodyFatPercent = d.bodyFatPercent;
  r.musclePercent = d.musclePercent;
  r.muscleMassKg = d.muscleMass ? d.muscleMass.kilograms : null;
  r.fatFreeMassKg = d.fatFreeMass ? d.fatFreeMass.kilograms : null;
  r.softLeanMassKg = d.softLeanMass ? d.softLeanMass.kilograms : null;
  r.bodyWaterMassKg = d.bodyWaterMass ? d.bodyWaterMass.kilograms : null;
  r.basalMetabolismKj = d.basalMetabolismKj;
  r.impedanceOhm = d.impedanceOhm;
  r.userId = d.userId;
  return r;
}

/** 内容签名（不含自增 id；十进制按数值归一，"70.0" 与 "70.000" 视为同一值），用于导入去重。 */
export function recordSignature(rec) {
  const parts = FIELDS.map(([, key, kind]) => {
    const v = rec[key];
    if (v === null || v === undefined) return '';
    return kind === 'dec' ? trimFraction(v, 0) : String(v);
  });
  return parts.join('\u0001');
}
