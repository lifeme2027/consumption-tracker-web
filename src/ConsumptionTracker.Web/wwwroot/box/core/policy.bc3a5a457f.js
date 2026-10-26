// 数据管线策略（纯函数，无 DOM）。与桌面 Core/Models/MeasurementPolicy.cs 对应，规则来自 NOTES.md「解析策略与已知分歧」Q13/Q14/Q16：
//   * 体重恰为 0 不自动入库；< 2.000 kg 或 > 200.000 kg 入库但标「异常」（2.000 / 200.000 恰好正常）；
//   * 去重键 = 设备 + 来源 + 用户 + 设备时间戳（到秒）+ 全部测量值；没有设备时间戳就没有键（不去重）；同时间戳不同数值保留两条；
//   * 设备时钟可疑：设备时间比接收时的本地墙钟晚 > 24 小时或早 > 366 天（设备时间无时区，不做时区换算）。
// 阈值是常量，不可配置。

import { compare, trimFraction } from './decimal.d1b6f6c095.js';

export const MIN_PLAUSIBLE_KG = '2';
export const MAX_PLAUSIBLE_KG = '200';
export const MAX_FUTURE_SKEW_MS = 24 * 3600 * 1000;
export const MAX_PAST_SKEW_MS = 366 * 24 * 3600 * 1000;

/** 'notApplicable' | 'normal' | 'zero' | 'tooLight' | 'tooHeavy' */
export function classifyWeight(kg) {
  if (kg === null || kg === undefined) return 'notApplicable';
  if (compare(kg, '0') === 0) return 'zero';
  if (compare(kg, MIN_PLAUSIBLE_KG) < 0) return 'tooLight';
  if (compare(kg, MAX_PLAUSIBLE_KG) > 0) return 'tooHeavy';
  return 'normal';
}

export const isAbnormal = (rec) => ['tooLight', 'tooHeavy'].includes(classifyWeight(rec.weightKg));
export const shouldAutoSave = (rec) => classifyWeight(rec.weightKg) !== 'zero';

const D = (v) => (v === null || v === undefined ? '-' : typeof v === 'number' ? String(v) : trimFraction(v, 0));

/** 没有设备时间戳时返回 null（两次相同读数是两次真实称重，不能合并）。 */
export function dedupKey(rec) {
  if (!rec.deviceTime) return null;
  return [
    rec.deviceId, rec.source, rec.userId ?? '-', rec.deviceTime.slice(0, 19),
    D(rec.rawWeight), D(rec.bmi), D(rec.heightM), D(rec.bodyFatPercent), D(rec.musclePercent),
    D(rec.muscleMassKg), D(rec.fatFreeMassKg), D(rec.softLeanMassKg), D(rec.bodyWaterMassKg),
    D(rec.basalMetabolismKj), D(rec.impedanceOhm),
  ].join('|');
}

const wallMs = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(s);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
};

export function isDeviceClockSuspect(rec) {
  if (!rec.deviceTime) return false;
  const dev = wallMs(rec.deviceTime);
  const rcv = wallMs(rec.receivedTime);
  if (dev === null || rcv === null) return false;
  const diff = dev - rcv;
  return diff > MAX_FUTURE_SKEW_MS || -diff > MAX_PAST_SKEW_MS;
}

/** 决定一条新收到的记录怎么处理：'save' | 'zero' | 'duplicate'。existing 为已存储记录。 */
export function decideIngest(rec, existing) {
  if (!shouldAutoSave(rec)) return 'zero';
  const key = dedupKey(rec);
  if (key !== null && existing.some((e) => dedupKey(e) === key)) return 'duplicate';
  return 'save';
}
