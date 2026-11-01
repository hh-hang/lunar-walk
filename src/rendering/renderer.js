import * as THREE from 'three';
import { t } from '../ui/locale.js';
import { viewSize, pixelRatio } from '../ui/viewport.js';

/** 创建主渲染器，集中设置色调映射、阴影和屏幕抗锯齿。 */
export function createRenderer() {
  // 关闭辉光时，原生多重采样抗锯齿仍能保持屏幕画面平滑。
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(pixelRatio());
  renderer.setSize(...viewSize());
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.22;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.domElement.setAttribute('aria-label', t('月面探索场景', 'Lunar exploration scene'));
  document.body.prepend(renderer.domElement);

  return renderer;
}
