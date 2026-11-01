import { relief, smoothNoise } from './noise.js';
import { craterHeightAt } from './craters.js';

export { ease, randomAt, smoothNoise } from './noise.js';
export { impactProfile } from './craters.js';

/** 生成宽缓区域起伏和古老撞击洼地，不按固定网格摆放环形山。 */
export function regionalHeight(x, z) {
  const warp = relief(x / 1150, z / 1150, 23, 3);
  let height = relief(x / 700 + warp, z / 700 - warp, 41) * 24;
  height += relief(x / 180, z / 180, 57, 3) * 5;
  return height + craterHeightAt(x, z, 'regional');
}

/** 按世界坐标生成非周期的小坑和亚米级月壤起伏。 */
export function nearReliefAt(x, z) {
  const roughness = (smoothNoise(x / 1.8, z / 1.8, 104) - 0.5) * 0.055 +
    (smoothNoise(x / 0.65, z / 0.65, 105) - 0.5) * 0.025;
  return roughness + craterHeightAt(x, z, 'detail');
}

/** 叠加区域地貌、不同尺寸和退化程度的陨石坑及中尺度起伏。 */
export function landformHeightAt(x, z) {
  return regionalHeight(x, z) + craterHeightAt(x, z) +
    relief(x / 23, z / 23, 89, 3) * 1.2 + relief(x / 8.5, z / 8.5, 94, 3) * 0.28;
}

/** 返回含细节起伏的最终世界坐标地表高度。 */
export function heightAt(x, z) {
  return landformHeightAt(x, z) + nearReliefAt(x, z);
}
