import * as THREE from 'three';
import { randomAt } from './height.js';

/** 生成周期月壤底色与法线纹理，并配置远景过滤。 */
export function makeRegolithTextures() {
  const resolution = 512,
    period = 24,
    pixelSize = period / resolution;
  const heights = new Float32Array(resolution * resolution);
  for (let y = 0; y < resolution; y++)
    for (let x = 0; x < resolution; x++) {
      heights[y * resolution + x] =
        (randomAt(x, y, 3101) - 0.5) * 0.012 + (randomAt(Math.floor(x / 3), Math.floor(y / 3), 3102) - 0.5) * 0.007;
    }
  const albedo = new Uint8Array(resolution * resolution * 4);
  const normal = new Uint8Array(albedo.length);
  /** 周期读取纹理高度样本。 */
  const read = (x, y) => heights[((y + resolution) % resolution) * resolution + ((x + resolution) % resolution)];
  for (let y = 0; y < resolution; y++)
    for (let x = 0; x < resolution; x++) {
      const offset = (y * resolution + x) * 4;
      const nx = (read(x - 1, y) - read(x + 1, y)) / (2 * pixelSize);
      const ny = (read(x, y - 1) - read(x, y + 1)) / (2 * pixelSize);
      const length = Math.hypot(nx, ny, 1);
      const grain = randomAt(x, y, 3120);
      const color = Math.min(215, Math.max(150, 191 + (grain - 0.5) * 24 + heights[y * resolution + x] * 105));
      albedo.set([color, color, color, 255], offset);
      normal.set(
        [((nx / length) * 0.5 + 0.5) * 255, ((ny / length) * 0.5 + 0.5) * 255, ((1 / length) * 0.5 + 0.5) * 255, 255],
        offset,
      );
    }
  /** 将像素数据包装成可平铺并生成多级纹理的贴图。 */
  const texture = (data, colorSpace) => {
    const map = new THREE.DataTexture(data, resolution, resolution);
    map.colorSpace = colorSpace;
    map.wrapS = map.wrapT = THREE.RepeatWrapping;
    map.repeat.set(3, 3);
    map.magFilter = THREE.LinearFilter;
    map.minFilter = THREE.LinearMipmapLinearFilter;
    map.generateMipmaps = true;
    map.anisotropy = 8;
    map.needsUpdate = true;
    return map;
  };
  return {
    albedo: texture(albedo, THREE.SRGBColorSpace),
    normal: texture(normal, THREE.NoColorSpace),
  };
}
