/** 跟随 Vite 的部署路径；直接在 Node.js 中运行测试时使用根路径。 */
export function publicAssetUrl(path) {
  return `${import.meta.env?.BASE_URL ?? '/'}${path}`;
}
