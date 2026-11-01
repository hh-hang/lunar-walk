import { t } from './locale.js';

const loadingEl = document.getElementById('loading');
const loadingBar = document.getElementById('loading-bar');
loadingEl?.setAttribute('aria-label', t('加载', 'Loading'));

/** 更新进度条宽度与无障碍进度值。 */
export const setLoading = (value) => {
  const percent = Math.round(value * 100);
  loadingBar.style.width = `${percent}%`;
  loadingEl.setAttribute('aria-valuenow', String(percent));
};
/** 创建单个模型下载进度到总进度区间的映射回调。 */
export const reportDownload = (from, to) => {
  let shown = from;
  return (event) => {
    if (!(event.total > 0)) return;
    const next = from + (to - from) * Math.min(1, event.loaded / event.total);
    if (next <= shown) return;
    shown = next;
    setLoading(next);
  };
};
/** 等待下一显示帧，使加载进度有机会呈现。 */
export const nextFrame = () => new Promise(requestAnimationFrame);

/** 完成加载后淡出遮罩。 */
export function finishLoading() {
  loadingEl.classList.add('hide');
}

/** 显示加载失败原因，保留控制台错误以便定位。 */
export function showLoadingError(error) {
  console.error(error);
  loadingEl.classList.remove('hide');
  const note = document.createElement('p');
  note.className = 'loading-error';
  note.innerHTML = `<span class="zh">加载失败：</span><span class="en">Failed to load: </span>${error.message || error}`;
  loadingEl.append(note);
}
