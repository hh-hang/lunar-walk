import * as THREE from 'three';
import { LUNAR_PALETTE } from '../rendering/surface.js';
import { randomAt } from '../terrain/height.js';
import { createLunarSunlight } from './lighting.js';

/** 创建太阳、半球补光和低亮度环境反射，保留原始亮度与阴影参数。 */
export function createEnvironmentLighting(renderer, scene) {
  const sunlight = createLunarSunlight(renderer.capabilities.maxTextureSize);
  scene.add(sunlight);
  const fillLight = new THREE.HemisphereLight(LUNAR_PALETTE.skyFill, LUNAR_PALETTE.groundFill, 0.65);
  scene.add(fillLight);
  // 低亮度地面环境反射用于保留金属与阴影中衣料的细节。
  const reflectionScene = new THREE.Scene();
  const reflectionGeometry = new THREE.SphereGeometry(50, 32, 16);
  const reflectionPositions = reflectionGeometry.getAttribute('position');
  const reflectionColors = [];
  for (let i = 0; i < reflectionPositions.count; i++) {
    const elevation = reflectionPositions.getY(i) / 50;
    const brightness = elevation > 0 ? 0.018 + 0.065 * (1 - elevation) ** 5 : 0.075;
    reflectionColors.push(brightness, brightness, brightness);
  }
  reflectionGeometry.setAttribute('color', new THREE.Float32BufferAttribute(reflectionColors, 3));
  const reflectionMaterial = new THREE.MeshBasicMaterial({ side: THREE.BackSide, vertexColors: true });
  reflectionScene.add(new THREE.Mesh(reflectionGeometry, reflectionMaterial));
  const reflectionGenerator = new THREE.PMREMGenerator(renderer);
  scene.environment = reflectionGenerator.fromScene(reflectionScene, 0.02, 0.1, 100).texture;
  scene.environmentIntensity = 0.6;
  reflectionGenerator.dispose();
  reflectionGeometry.dispose();
  reflectionMaterial.dispose();

  return sunlight;
}

/** 以固定种子创建星空，使刷新后的星点位置和亮度保持一致。 */
export function createStars(scene) {
  const starPositions = [],
    starColors = [];
  for (let i = 0; i < 4400; i++) {
    const azimuth = randomAt(i, 3, 4000) * Math.PI * 2;
    const vertical = randomAt(i, 7, 4001) * 2 - 1;
    const horizontal = Math.sqrt(1 - vertical * vertical);
    starPositions.push(
      Math.cos(azimuth) * horizontal * 11000,
      vertical * 11000,
      Math.sin(azimuth) * horizontal * 11000,
    );
    const brightness = 0.13 + randomAt(i, 9, 4002) ** 4 * 0.52;
    starColors.push(brightness, brightness * 0.95, brightness * 0.88);
  }
  const starGeometry = new THREE.BufferGeometry();
  starGeometry.setAttribute('position', new THREE.Float32BufferAttribute(starPositions, 3));
  starGeometry.setAttribute('color', new THREE.Float32BufferAttribute(starColors, 3));
  const stars = new THREE.Points(
    starGeometry,
    new THREE.PointsMaterial({
      size: 1.05,
      sizeAttenuation: false,
      vertexColors: true,
      transparent: true,
      opacity: 0.65,
      depthWrite: false,
    }),
  );
  scene.add(stars);

  return stars;
}
