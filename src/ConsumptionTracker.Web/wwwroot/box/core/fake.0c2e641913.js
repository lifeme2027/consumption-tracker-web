// 演示数据（Fake）：几组标准 0x2A9D / 0x2A9C 字节，经与真实蓝牙相同的解析管线产生记录。
// 记录的 deviceId 以 "DEMO:" 开头、demo=true；界面与导出处处标「演示数据」。这些数值是虚构的，不是任何真实测量。

export const DEMO_DEVICE = Object.freeze({ deviceId: 'DEMO:fake-scale', deviceName: 'Demo Scale', isDemo: true });

const u16 = (n) => [n & 0xff, (n >> 8) & 0xff];

/** GATT Date Time 7 字节（设备本地时间）。 */
export function gattDateTime(d) {
  return [...u16(d.getFullYear()), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()];
}

/** 场景：{id, service, characteristic, build(now) → Uint8Array}。 */
export const DEMO_SCENARIOS = Object.freeze([
  {
    id: 'si-basic', service: 0x181d, characteristic: 0x2a9d,
    // flags=0：公制，只有体重 70.000 kg（raw 14000）
    build: () => Uint8Array.from([0x00, ...u16(14000)]),
  },
  {
    id: 'si-full', service: 0x181d, characteristic: 0x2a9d,
    // flags=0x0E：时间戳 + 用户 ID 1 + BMI/身高；体重 69.350 kg，BMI 22.5，身高 1.755 m
    build: (now) => Uint8Array.from([0x0e, ...u16(13870), ...gattDateTime(now), 1, ...u16(225), ...u16(1755)]),
  },
  {
    id: 'imperial', service: 0x181d, characteristic: 0x2a9d,
    // flags=0x09：英制 + BMI/身高；体重 154.32 lb，BMI 22.1，身高 69.1 in
    build: () => Uint8Array.from([0x09, ...u16(15432), ...u16(221), ...u16(691)]),
  },
  {
    id: 'body-composition', service: 0x181b, characteristic: 0x2a9c,
    // flags=0x0FFE：时间戳、用户、基础代谢、肌肉率、肌肉量、去脂体重、软组织瘦体重、体水量、阻抗、体重、身高 全部存在
    build: (now) => Uint8Array.from([
      ...u16(0x0ffe), ...u16(187), ...gattDateTime(now), 2,
      ...u16(7000), ...u16(401), ...u16(5700), ...u16(11280), ...u16(10860), ...u16(8240), ...u16(5005),
      ...u16(13870), ...u16(1755),
    ]),
  },
]);

export function demoScenario(id) {
  return DEMO_SCENARIOS.find((s) => s.id === id) ?? null;
}
