// 记录 → 界面文字（纯函数，无 DOM；t 是 i18n 的翻译函数）。
import { formatKgForDisplay, formatForUnit, trimFraction } from './decimal.d1b6f6c095.js';
import { displayKey } from './measurement.0911573984.js';

const dec = (v) => (typeof v === 'number' ? String(v) : trimFraction(v, 0));

/** "70" kg / "154.32" lb；displayUnit 决定主显示单位。 */
export function weightText(rec, displayUnit, t) {
  if (rec.weightKg === null) return '—';
  const main = displayUnit === 'lb' ? `${formatForUnit(rec.weightKg, 'lb')} ${t('u.lb')}` : `${formatKgForDisplay(rec.weightKg)} ${t('u.kg')}`;
  return main;
}

/** 原单位 + kg 的完整文字：例 "154.32 lb（= 69.9984 kg）"。 */
export function weightDetail(rec, t) {
  if (rec.weightKg === null) return '—';
  const kg = `${formatKgForDisplay(rec.weightKg)} ${t('u.kg')}`;
  if (rec.originalUnit === 'lb') return `${dec(rec.weightOriginal)} ${t('u.lb')} (= ${kg})`;
  return kg;
}

export function timeText(rec) {
  return displayKey(rec).replace('T', ' ');
}

export function tagFor(rec) {
  return rec.demo ? 'tag.demo' : 'tag.real';
}

/** 详情字段：[标签键, 文本]，只列有值的。 */
export function detailRows(rec, displayUnit, t, userNotes = {}) {
  const rows = [];
  const add = (k, v) => { if (v !== null && v !== undefined) rows.push([k, v]); };
  const m = (key, unit) => (rec[key] === null ? null : `${dec(rec[key])} ${t(unit)}`);
  if (rec.weightKg !== null) {
    add('f.weight', weightText(rec, displayUnit, t));
    add('f.original', `${dec(rec.weightOriginal)} ${t(rec.originalUnit === 'lb' ? 'u.lb' : 'u.kg')} → ${weightDetail(rec, t)}`);
  }
  add('f.bmi', rec.bmi === null ? null : dec(rec.bmi));
  add('f.height', m('heightM', 'u.m'));
  add('f.bodyFat', m('bodyFatPercent', 'u.percent'));
  add('f.muscle', m('musclePercent', 'u.percent'));
  add('f.muscleMass', m('muscleMassKg', 'u.kg'));
  add('f.fatFree', m('fatFreeMassKg', 'u.kg'));
  add('f.softLean', m('softLeanMassKg', 'u.kg'));
  add('f.water', m('bodyWaterMassKg', 'u.kg'));
  add('f.basal', m('basalMetabolismKj', 'u.kj'));
  add('f.impedance', m('impedanceOhm', 'u.ohm'));
  if (rec.userId !== null) {
    const note = userNotes[String(rec.userId)];
    add('f.user', note ? `${rec.userId}（${note}）` : String(rec.userId));
  }
  add('f.deviceTime', rec.deviceTime ? rec.deviceTime.replace('T', ' ') : null);
  add('f.receivedTime', rec.receivedTime.replace('T', ' '));
  add('f.device', rec.deviceName ? `${rec.deviceName} (${rec.deviceId})` : rec.deviceId);
  return rows;
}
