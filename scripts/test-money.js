// 用共享向量校验 wwwroot/money.js（与 C# Core 的 MoneyTests 同一份 shared-vectors）。运行：node scripts/test-money.js
const fs = require('fs'), path = require('path'), assert = require('assert');
const M = require('../src/ConsumptionTracker.Web/wwwroot/money.js');
const load = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'shared-vectors', f), 'utf8'));
let n = 0;
for (const { input, cents } of load('money.json')) {
  assert.strictEqual(M.yuanToCents(input), cents, `money '${input}' => ${M.yuanToCents(input)}，期望 ${cents}`); n++;
}
for (const { input, quantity } of load('quantity.json')) {
  const got = M.parseQty(input);
  if (quantity === null) assert.strictEqual(got, null, `quantity '${input}' 应拒绝，得到 ${got}`);
  else assert.strictEqual(got, Number(quantity), `quantity '${input}' => ${got}，期望 ${quantity}`);
  n++;
}
// 行合计：half-up，整数运算
assert.strictEqual(M.amountCents(777, '2.5'), 1943);
assert.strictEqual(M.amountCents(1, '0.5'), 1);
assert.strictEqual(M.amountCents(1, '0.499999'), 0);
assert.strictEqual(M.amountCents(100000000000, '1000000'), 100000000000000000);
assert.strictEqual(M.amountCents(null, '1'), null);
assert.strictEqual(M.amountCents(100, '0'), null);
console.log(`money.js OK (${n} shared vectors)`);
