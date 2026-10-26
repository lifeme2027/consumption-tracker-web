// Bluetooth SIG 标准 Weight Scale（0x181D）与 Body Composition（0x181B）特征解析器。
// 独立实现；字段布局依据 SIG《Weight Scale Service v1.0.1》《Body Composition Service v1.0.1》（见仓库 NOTES.md「协议信息来源」）。
// 状态：实验性（仅按规范实现，未真机验证）。
//
// 输出形状与 shared-vectors/README.md 的 `expect` 完全一致：带小数的值是十进制字符串（不经过二进制浮点），
// 质量 {raw, original, kilograms}，身高 {raw, original, meters}，时间戳 "YYYY-MM-DDTHH:MM:SS" 或 null。
// 任何输入（含截断、乱码）都不会抛异常，而是返回 {ok:false, errorCode, message}。

import { ByteReader } from './bytes.ae517095e7.js';
import { fromScaled, mul, KG_PER_LB, M_PER_IN } from './decimal.d1b6f6c095.js';

export const UUID = Object.freeze({
  WEIGHT_SCALE_SERVICE: 0x181d,
  BODY_COMPOSITION_SERVICE: 0x181b,
  DEVICE_INFORMATION_SERVICE: 0x180a,
  WEIGHT_SCALE_FEATURE: 0x2a9e,
  WEIGHT_MEASUREMENT: 0x2a9d,
  BODY_COMPOSITION_FEATURE: 0x2a9b,
  BODY_COMPOSITION_MEASUREMENT: 0x2a9c,
});

// 质量分辨率码 → [kg, lb]；身高分辨率码 → [m, in]。取自 SIG 枚举表；码 0（未指定）与保留值返回 null。
const MASS_RES = [null, ['0.5', '1'], ['0.2', '0.5'], ['0.1', '0.2'], ['0.05', '0.1'], ['0.02', '0.05'], ['0.01', '0.02'], ['0.005', '0.01']];
const HEIGHT_RES = [null, ['0.01', '1'], ['0.005', '0.5'], ['0.001', '0.1']];

const ok = (value, warnings) => ({ ok: true, value, warnings: [...new Set(warnings)] });
const fail = (errorCode, message) => ({ ok: false, errorCode, message });

function massRes(code) {
  const e = code >= 1 && code <= 7 ? MASS_RES[code] : null;
  return { kg: e ? e[0] : null, lb: e ? e[1] : null };
}
function heightRes(code) {
  const e = code >= 1 && code <= 3 ? HEIGHT_RES[code] : null;
  return { m: e ? e[0] : null, in: e ? e[1] : null };
}
const reservedMass = (c) => c >= 8;
const reservedHeight = (c) => c >= 4;

/** uint16 → 质量值。SI：0.005 kg 一格；Imperial：0.01 lb 一格，kg = lb × 0.45359237（精确）。 */
export function decodeMass(raw, imperial) {
  if (!imperial) {
    const kg = fromScaled(BigInt(raw) * 5n, 3);
    return { raw, original: kg, kilograms: kg };
  }
  const lb = fromScaled(raw, 2);
  return { raw, original: lb, kilograms: mul(lb, KG_PER_LB) };
}

/** uint16 → 身高值。SI：0.001 m 一格；Imperial：0.1 in 一格，m = in × 0.0254（精确）。 */
export function decodeHeight(raw, imperial) {
  if (!imperial) {
    const m = fromScaled(raw, 3);
    return { raw, original: m, meters: m };
  }
  const inch = fromScaled(raw, 1);
  return { raw, original: inch, meters: mul(inch, M_PER_IN) };
}

const tenth = (raw) => fromScaled(raw, 1);

/** GATT Date Time（7 字节）：不是合法日期时间（年 1582–9999、月日时分秒越界、日历上不存在）返回 null。 */
export function parseGattDateTime(b) {
  if (b.length < 7) return null;
  const year = b[0] | (b[1] << 8);
  const [month, day, hour, minute, second] = [b[2], b[3], b[4], b[5], b[6]];
  if (year < 1582 || year > 9999) return null;
  if (month < 1 || month > 12) return null;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (day < 1 || day > dim) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  const p = (n, w) => String(n).padStart(w, '0');
  return `${p(year, 4)}-${p(month, 2)}-${p(day, 2)}T${p(hour, 2)}:${p(minute, 2)}:${p(second, 2)}`;
}

// ---------------------------------------------------------------- Weight Scale

export function parseWeightScaleFeature(data) {
  if (data.length < 4) return fail('TooShort', `Weight Scale Feature needs 4 bytes, got ${data.length}.`);
  const raw = new ByteReader(data).u32();
  const warnings = [];
  if (data.length > 4) warnings.push('TrailingBytes');
  if ((raw & 0xfffffc00) !== 0) warnings.push('ReservedBitsSet');
  const wCode = (raw >>> 3) & 0xf;
  const hCode = (raw >>> 7) & 0x7;
  if (reservedMass(wCode) || reservedHeight(hCode)) warnings.push('ReservedResolutionCode');
  const w = massRes(wCode), h = heightRes(hCode);
  return ok({
    timeStampSupported: (raw & 1) !== 0,
    multipleUsersSupported: (raw & 2) !== 0,
    bmiSupported: (raw & 4) !== 0,
    weightResolutionCode: wCode,
    heightResolutionCode: hCode,
    weightResolutionKg: w.kg,
    weightResolutionLb: w.lb,
    heightResolutionMeters: h.m,
    heightResolutionInches: h.in,
  }, warnings);
}

export function parseWeightMeasurement(data) {
  if (data.length < 3) return fail('TooShort', `Weight Measurement needs at least 3 bytes (Flags + Weight), got ${data.length}.`);
  const r = new ByteReader(data);
  const flags = r.u8();
  const rawWeight = r.u16();
  const warnings = [];
  if ((flags & 0xf0) !== 0) warnings.push('ReservedBitsSet');
  const imperial = (flags & 1) !== 0;
  const unsuccessful = rawWeight === 0xffff;
  const weight = unsuccessful ? null : decodeMass(rawWeight, imperial);

  const truncated = (field, need) =>
    fail('Truncated', `Weight Measurement truncated: field '${field}' needs ${need} byte(s) at offset ${r.pos}, only ${r.remaining} left.`);

  let timestamp = null;
  if ((flags & 2) !== 0) {
    const ts = r.take(7);
    if (ts === null) return truncated('Time Stamp', 7);
    timestamp = parseGattDateTime(ts);
    if (timestamp === null) warnings.push('InvalidTimestamp');
  }
  let userId = null;
  if ((flags & 4) !== 0) {
    const uid = r.u8();
    if (uid === null) return truncated('User ID', 1);
    userId = uid === 0xff ? null : uid; // 0xFF = 未知用户
  }
  let bmi = null, height = null;
  if ((flags & 8) !== 0) {
    if (unsuccessful) {
      // 规范：Measurement Unsuccessful 时，除 Time Stamp 与 User ID 外的可选字段应被禁用。
      warnings.push('FieldsIgnoredMeasurementUnsuccessful');
    } else {
      const rawBmi = r.u16();
      if (rawBmi === null) return truncated('BMI', 2);
      const rawHeight = r.u16();
      if (rawHeight === null) return truncated('Height', 2);
      if (rawBmi === 0xffff) warnings.push('OptionalFieldMarkedUnknown'); else bmi = tenth(rawBmi);
      if (rawHeight === 0xffff) warnings.push('OptionalFieldMarkedUnknown'); else height = decodeHeight(rawHeight, imperial);
    }
  }
  if (r.remaining > 0) warnings.push('TrailingBytes');
  return ok({
    unit: imperial ? 'imperial' : 'si',
    measurementUnsuccessful: unsuccessful,
    weight, timestamp, userId, bmi, height,
  }, warnings);
}

// ------------------------------------------------------------ Body Composition

export function parseBodyCompositionFeature(data) {
  if (data.length < 4) return fail('TooShort', `Body Composition Feature needs 4 bytes, got ${data.length}.`);
  const raw = new ByteReader(data).u32();
  const warnings = [];
  if (data.length > 4) warnings.push('TrailingBytes');
  if ((raw & 0xfffc0000) !== 0) warnings.push('ReservedBitsSet');
  const bit = (n) => ((raw >>> n) & 1) !== 0;
  const mCode = (raw >>> 11) & 0xf;
  const hCode = (raw >>> 15) & 0x7;
  if (reservedMass(mCode) || reservedHeight(hCode)) warnings.push('ReservedResolutionCode');
  const m = massRes(mCode), h = heightRes(hCode);
  return ok({
    timeStampSupported: bit(0),
    multipleUsersSupported: bit(1),
    basalMetabolismSupported: bit(2),
    musclePercentageSupported: bit(3),
    muscleMassSupported: bit(4),
    fatFreeMassSupported: bit(5),
    softLeanMassSupported: bit(6),
    bodyWaterMassSupported: bit(7),
    impedanceSupported: bit(8),
    weightSupported: bit(9),
    heightSupported: bit(10),
    massResolutionCode: mCode,
    heightResolutionCode: hCode,
    massResolutionKg: m.kg,
    massResolutionLb: m.lb,
    heightResolutionMeters: h.m,
    heightResolutionInches: h.in,
  }, warnings);
}

export function parseBodyCompositionMeasurement(data) {
  if (data.length < 2) return fail('TooShort', `Body Composition Measurement needs at least 4 bytes (Flags + Body Fat Percentage), got ${data.length}.`);
  const r = new ByteReader(data);
  const flags = r.u16();
  // 多包测量：续包不含 Time Stamp / User ID，字段被拆分到两个包；阶段 1 不拼包，识别后拒绝。
  if ((flags & (1 << 12)) !== 0) {
    return fail('MultiPacketNotSupported', 'Body Composition Measurement with the Multiple Packet Measurement flag is not supported yet.');
  }
  if (data.length < 4) return fail('TooShort', `Body Composition Measurement needs at least 4 bytes (Flags + Body Fat Percentage), got ${data.length}.`);
  const rawBodyFat = r.u16();
  const warnings = [];
  if ((flags & 0xe000) !== 0) warnings.push('ReservedBitsSet');
  const imperial = (flags & 1) !== 0;
  const unsuccessful = rawBodyFat === 0xffff;
  const bodyFatPercent = unsuccessful ? null : tenth(rawBodyFat);

  const truncated = (field, need) =>
    fail('Truncated', `Body Composition Measurement truncated: field '${field}' needs ${need} byte(s) at offset ${r.pos}, only ${r.remaining} left.`);

  let timestamp = null;
  if ((flags & 2) !== 0) {
    const ts = r.take(7);
    if (ts === null) return truncated('Time Stamp', 7);
    timestamp = parseGattDateTime(ts);
    if (timestamp === null) warnings.push('InvalidTimestamp');
  }
  let userId = null;
  if ((flags & 4) !== 0) {
    const uid = r.u8();
    if (uid === null) return truncated('User ID', 1);
    userId = uid === 0xff ? null : uid;
  }

  const OPTIONAL_MASK = 0x0ff8; // 位 3–11
  const out = {
    unit: imperial ? 'imperial' : 'si',
    measurementUnsuccessful: unsuccessful,
    bodyFatPercent, timestamp, userId,
    basalMetabolismKj: null, musclePercent: null, muscleMass: null, fatFreeMass: null,
    softLeanMass: null, bodyWaterMass: null, impedanceOhm: null, weight: null, height: null,
  };
  if (unsuccessful) {
    if ((flags & OPTIONAL_MASK) !== 0) warnings.push('FieldsIgnoredMeasurementUnsuccessful');
    if (r.remaining > 0) warnings.push('TrailingBytes');
    return ok(out, warnings);
  }

  // 可选字段按位序依次出现；每个都是 uint16，0xFFFF 本项目保守地当作「未知」。
  const FIELDS = [
    [3, 'Basal Metabolism', 'basalMetabolismKj', (v) => v],
    [4, 'Muscle Percentage', 'musclePercent', tenth],
    [5, 'Muscle Mass', 'muscleMass', (v) => decodeMass(v, imperial)],
    [6, 'Fat Free Mass', 'fatFreeMass', (v) => decodeMass(v, imperial)],
    [7, 'Soft Lean Mass', 'softLeanMass', (v) => decodeMass(v, imperial)],
    [8, 'Body Water Mass', 'bodyWaterMass', (v) => decodeMass(v, imperial)],
    [9, 'Impedance', 'impedanceOhm', tenth],
    [10, 'Weight', 'weight', (v) => decodeMass(v, imperial)],
    [11, 'Height', 'height', (v) => decodeHeight(v, imperial)],
  ];
  for (const [bit, name, key, conv] of FIELDS) {
    if ((flags & (1 << bit)) === 0) continue;
    const v = r.u16();
    if (v === null) return truncated(name, 2);
    if (v === 0xffff) warnings.push('OptionalFieldMarkedUnknown'); else out[key] = conv(v);
  }
  if (r.remaining > 0) warnings.push('TrailingBytes');
  return ok(out, warnings);
}

/** 按（服务, 特征）分派。service/characteristic 为 16 位数字。未知组合返回 UnknownCharacteristic。 */
export function parseCharacteristic(service, characteristic, data) {
  const key = `${service.toString(16)}/${characteristic.toString(16)}`;
  switch (key) {
    case '181d/2a9e': return parseWeightScaleFeature(data);
    case '181d/2a9d': return parseWeightMeasurement(data);
    case '181b/2a9b': return parseBodyCompositionFeature(data);
    case '181b/2a9c': return parseBodyCompositionMeasurement(data);
    default: return fail('UnknownCharacteristic', `No parser for ${key}.`);
  }
}
