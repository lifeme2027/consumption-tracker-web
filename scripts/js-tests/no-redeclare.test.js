// 静态检查：同一作用域内不允许重复声明同名函数（或函数与 var/let/const 同名）。
// 背景：068e1394 的 app.js 在同一个 IIFE 里有两个 renderList()，后者悄悄覆盖前者，历史列表整页不渲染。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const { WW } = require('./helpers');

const FN = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

function children(node) {
  const out = [];
  for (const k of Object.keys(node)) {
    if (k === 'type' || k === 'start' || k === 'end' || k === 'loc') continue;
    const v = node[k];
    if (Array.isArray(v)) { for (const x of v) if (x && typeof x.type === 'string') out.push(x); }
    else if (v && typeof v.type === 'string') out.push(v);
  }
  return out;
}

/** 返回 [{name, kind, line}]：属于 scopeNode 这一层作用域的声明（不进入嵌套函数）。 */
function declsOf(scopeNode, src) {
  const decls = [];
  const line = (n) => src.slice(0, n.start).split('\n').length;
  function patNames(p, out) {
    if (!p) return;
    if (p.type === 'Identifier') out.push(p.name);
    else if (p.type === 'ObjectPattern') p.properties.forEach((x) => patNames(x.value || x.argument, out));
    else if (p.type === 'ArrayPattern') p.elements.forEach((x) => patNames(x, out));
    else if (p.type === 'AssignmentPattern') patNames(p.left, out);
    else if (p.type === 'RestElement') patNames(p.argument, out);
  }
  function visit(n, top) {
    if (!top && FN.has(n.type)) {
      if (n.type === 'FunctionDeclaration' && n.id) decls.push({ name: n.id.name, kind: 'function', line: line(n) });
      return;                                   // 不进入嵌套函数
    }
    if (n.type === 'VariableDeclaration') {
      const names = []; n.declarations.forEach((d) => patNames(d.id, names));
      names.forEach((name) => decls.push({ name, kind: n.kind, line: line(n) }));
    }
    children(n).forEach((c) => visit(c, false));
  }
  const body = scopeNode.body;
  (Array.isArray(body) ? body : [body]).forEach((b) => b && visit(b, false));
  return decls;
}

function check(file) {
  const src = fs.readFileSync(file, 'utf8');
  const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true });
  const problems = [];
  function walk(n) {
    if (n.type === 'Program' || FN.has(n.type)) {
      const seen = new Map();
      for (const d of declsOf(n, src)) {
        const prev = seen.get(d.name);
        if (prev && (prev.kind === 'function' || d.kind === 'function' || prev.kind !== 'var' || d.kind !== 'var'))
          problems.push(`${path.basename(file)}: "${d.name}" 在同一作用域重复声明（第 ${prev.line} 行 ${prev.kind} 与第 ${d.line} 行 ${d.kind}）`);
        else if (!prev) seen.set(d.name, d);
      }
    }
    children(n).forEach(walk);
  }
  walk(ast);
  return problems;
}

const files = fs.readdirSync(WW).filter((f) => f.endsWith('.js')).map((f) => path.join(WW, f));

test('wwwroot 下所有 js：同一作用域没有重复声明的函数/变量', () => {
  assert.ok(files.length >= 6);
  const all = files.flatMap(check);
  assert.deepStrictEqual(all, []);
});

test('检查器本身有效：能抓到同名函数被覆盖（renderList 事故的最小复现）', () => {
  const tmp = path.join(require('os').tmpdir(), 'dup-' + process.pid + '.js');
  fs.writeFileSync(tmp, '(function(){ function renderList() {}\n function renderList(a, b) {}\n renderList(); })();');
  try { const p = check(tmp); assert.strictEqual(p.length, 1); assert.match(p[0], /renderList/); } finally { fs.unlinkSync(tmp); }
  fs.writeFileSync(tmp, '(function(){ function a() {}\n function b() { function a() {} }\n let x = 1; })(); function a() {}');
  try { assert.deepStrictEqual(check(tmp), []); } finally { fs.unlinkSync(tmp); }
});
