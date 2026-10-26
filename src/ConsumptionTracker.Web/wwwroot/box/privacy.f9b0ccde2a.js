// 隐私页：只负责语言（读取首页保存在 IndexedDB 里的语言偏好）。
import { applyDom, makeT, resolveLang } from './i18n/index.430b69b1ad.js';
import { openStore } from './core/store.f1047b4f3e.js';

const sel = document.getElementById('lang-select');
let store = null;

function render(pref) {
  const lang = resolveLang(pref, navigator.languages ?? [navigator.language]);
  applyDom(document, makeT(lang), lang);
  sel.value = pref;
}

async function main() {
  store = await openStore();
  const settings = await store.getSettings();
  render(settings.lang);
  sel.addEventListener('change', async () => {
    render(sel.value);
    try { await store.setSetting('lang', sel.value); } catch { /* 偏好保存失败不影响阅读 */ }
  });
  document.documentElement.dataset.ready = '1';
}
main().catch(() => { render('auto'); document.documentElement.dataset.ready = '1'; });
