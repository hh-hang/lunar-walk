/** 页面语言：与 index.html 按 navigator.language 写入的 html[lang] 一致。 */
export function isZh() {
  return /^zh\b/i.test(document.documentElement.lang || '');
}

/** 按当前页面语言取中文或英文文案。 */
export function t(zh, en) {
  return isZh() ? zh : en;
}
