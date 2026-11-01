/** 读取可视视口尺寸，兼容移动浏览器工具栏变化。 */
export const viewSize = () => {
  const viewport = window.visualViewport;
  return [Math.round(viewport?.width ?? innerWidth), Math.round(viewport?.height ?? innerHeight)];
};
/** 限制像素比与总像素数，控制高分屏渲染开销。 */
export const pixelRatio = () => {
  const [width, height] = viewSize();
  return Math.min(devicePixelRatio, 1.6, Math.sqrt(2400000 / (width * height)));
};

/** 绑定窗口与可视视口变化，兼容移动端横屏工具栏。 */
export function bindViewport(renderer, camera, bloom) {
  let viewWidth = 0,
    viewHeight = 0,
    viewResize = 0;
  /** 仅在视口变化时同步相机、渲染器和辉光尺寸。 */
  function resizeView() {
    const [width, height] = viewSize();
    if (width === viewWidth && height === viewHeight) return;
    viewWidth = width;
    viewHeight = height;
    document.documentElement.style.height = `${height}px`;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(pixelRatio());
    renderer.setSize(width, height);
    bloom.setSize();
  }
  /** 合并视口变化事件，并在下一帧再次校准移动端尺寸。 */
  function scheduleViewResize() {
    cancelAnimationFrame(viewResize);
    viewResize = requestAnimationFrame(() => {
      resizeView();
      requestAnimationFrame(resizeView);
    });
  }
  addEventListener('resize', scheduleViewResize);
  visualViewport?.addEventListener('resize', scheduleViewResize);
  visualViewport?.addEventListener('scroll', scheduleViewResize);
  resizeView();
}
