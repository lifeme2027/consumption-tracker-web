// 字节 → 记录的统一管线：真实 GATT 通知与「演示数据」走同一条路径（解析 → 工厂 → 记录）。
import { UUID, parseCharacteristic } from './protocol.19124bbe03.js';
import { fromWeightScale, fromBodyComposition } from './measurement.0911573984.js';
import { toHex } from './bytes.ae517095e7.js';

/**
 * 处理一次特征值。返回：
 *   {kind:'record', record, warnings, hex}      解析成功且有数值
 *   {kind:'unsuccessful', warnings, hex}         测量不成功（0xFFFF），不存记录
 *   {kind:'feature', feature, warnings, hex}     Feature 特征
 *   {kind:'error', errorCode, message, hex}      解析被拒绝
 */
export function processValue(service, characteristic, bytes, device, receivedAt = new Date()) {
  const hex = toHex(bytes);
  const r = parseCharacteristic(service, characteristic, bytes);
  if (!r.ok) return { kind: 'error', errorCode: r.errorCode, message: r.message, hex };
  if (characteristic === UUID.WEIGHT_SCALE_FEATURE || characteristic === UUID.BODY_COMPOSITION_FEATURE) {
    return { kind: 'feature', feature: r.value, warnings: r.warnings, hex };
  }
  const record = characteristic === UUID.WEIGHT_MEASUREMENT
    ? fromWeightScale(r.value, device, receivedAt)
    : fromBodyComposition(r.value, device, receivedAt);
  if (record === null) return { kind: 'unsuccessful', warnings: r.warnings, hex };
  return { kind: 'record', record, warnings: r.warnings, hex };
}
