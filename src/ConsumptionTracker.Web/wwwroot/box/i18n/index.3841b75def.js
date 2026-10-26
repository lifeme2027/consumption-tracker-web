// 极简 i18n：字典是普通对象（键 → 文案，{name} 占位）。所有界面文字都来自字典文件，不写在 JS/HTML 逻辑里。
import zh from './zh.d04bfe9ac1.js';
import en from './en.496024624f.js';

export const DICTS = Object.freeze({ zh, en });
export const LANGS = Object.freeze(['zh', 'en']);

/** pref: 'auto' | 'zh' | 'en'；languages: navigator.languages。 */
export function resolveLang(pref, languages = []) {
  if (pref === 'zh' || pref === 'en') return pref;
  for (const l of languages) {
    const s = String(l).toLowerCase();
    if (s.startsWith('zh')) return 'zh';
    if (s.startsWith('en')) return 'en';
  }
  return 'en';
}

export function makeT(lang) {
  const d = DICTS[lang] ?? DICTS.en;
  return (key, params) => {
    let s = Object.hasOwn(d, key) ? d[key] : Object.hasOwn(DICTS.en, key) ? DICTS.en[key] : key;
    if (params) s = s.replace(/\{(\w+)\}/g, (m, k) => (Object.hasOwn(params, k) ? String(params[k]) : m));
    return s;
  };
}

/**
 * 把 data-i18n（textContent）与 data-i18n-attr（"属性:键;属性:键"）套用到 root 下。
 * 只用 textContent / setAttribute，不插入 HTML。
 */
export function applyDom(root, t, lang) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-attr]')) {
    for (const pair of el.dataset.i18nAttr.split(';')) {
      const [attr, key] = pair.split(':');
      if (attr && key) el.setAttribute(attr.trim(), t(key.trim()));
    }
  }
  if (lang) root.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
}
