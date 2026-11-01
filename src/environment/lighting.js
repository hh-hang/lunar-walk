import { SunLight } from 'three/addons/lights/SunLight.js';
import { LUNAR_PALETTE } from '../rendering/surface.js';
import skySnapshot from './sky-snapshot.json' with { type: 'json' };
import { ConfigurableSunLightShadow, syncSunCascadeShaderDefine } from './sun-light-shadow.js';

/** 按固定天空快照创建太阳光。 */
export function createLunarSunlight(maxTextureSize = 8192) {
  const light = new SunLight(LUNAR_PALETTE.sunlight, 3.6);
  // 太阳光的位置表达方向，不受世界原点平移影响。
  light.position.fromArray(skySnapshot.bodies.sun.direction).normalize();
  light.castShadow = true;
  light.shadow.dispose();
  light.shadow = new ConfigurableSunLightShadow(2);
  const resolution = maxTextureSize >= 8192 ? 4096 : 2048;
  light.shadow.mapSize.set(resolution, resolution); 
  light.shadow.camera.near = 1;
  light.shadow.camera.far = 50;
  light.shadow.bias = -0.000005;
  light.shadow.normalBias = 0.02;
  light.shadow.radius = 1;
  syncSunCascadeShaderDefine(light.shadow.cascadeCount);
  return light;
}
