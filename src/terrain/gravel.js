import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

export const GRAVEL_LOD_BANDS = [
  [0, 8],
  [6, 20],
  [16, Infinity],
];

/** 生成不规则碎石，合并共享顶点并重算平滑法线。 */
export function createGravelGeometry(variant, detail, noise) {
  const source = new THREE.IcosahedronGeometry(1, detail);
  const positions = source.getAttribute('position');
  const point = new THREE.Vector3();
  const cuts = [
    new THREE.Vector3(0.8, 0.48, 0.3).normalize(),
    new THREE.Vector3(-0.4, 0.65, -0.7).normalize(),
    new THREE.Vector3(-0.75, -0.2, 0.6).normalize(),
  ];
  for (const cut of cuts) cut.applyAxisAngle(THREE.Object3D.DEFAULT_UP, variant * 1.7);
  for (let i = 0; i < positions.count; i++) {
    point.fromBufferAttribute(positions, i);
    let radius = 0.79 + noise(point.x * 2.6 + variant * 7, point.z * 2.6 + point.y, 3201) * 0.28;
    radius += (noise(point.x * 9 + point.y * 3 + variant, point.z * 8 - point.y * 2, 3202) - 0.5) * 0.055;
    for (let c = 0; c < cuts.length; c++) {
      const facing = point.dot(cuts[c]);
      if (facing > 0) radius = Math.min(radius, (0.76 + c * 0.055) / facing);
    }
    point.multiplyScalar(radius);
    point.x += point.y * (variant % 2 ? 0.22 : -0.14);
    point.y = Math.max(-0.32, point.y * (0.58 + variant * 0.045));
    positions.setXYZ(i, point.x, point.y, point.z);
  }
  // 先合并共享顶点再计算法线，避免逐三角形出现明暗斑块。
  source.deleteAttribute('normal');
  source.deleteAttribute('uv');
  const geometry = mergeVertices(source, 1e-5);
  source.dispose();
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

/** 为实例材质加入距离淡出与相邻细节等级的抖动过渡。 */
export function addGravelLodShader(material, focus, level, options = {}) {
  const { near = [6, 8], far = [16, 20], sizeScaled = false } = options;
  material.defines = { ...material.defines, GRAVEL_LOD: level };
  const compile = material.onBeforeCompile;
  const cacheKey = material.customProgramCacheKey();
  material.onBeforeCompile = (shader, renderer) => {
    compile.call(material, shader, renderer);
    shader.uniforms.uGravelFocus = focus;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
      attribute float gravelFadeEnd;
      varying float vGravelFadeEnd;
      varying vec2 vGravelCenter;
      varying float vStoneDetailScale;
    `,
      )
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
      vGravelCenter = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xz;
      vGravelFadeEnd = gravelFadeEnd;
      vStoneDetailScale = ${sizeScaled ? 'clamp(length(instanceMatrix[0].xyz) / 0.6, 0.5, 3.5)' : '1.0'};
    `,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
      uniform vec2 uGravelFocus;
      varying float vGravelFadeEnd;
      varying vec2 vGravelCenter;
      varying float vStoneDetailScale;
    `,
      )
      .replace(
        '#include <alphatest_fragment>',
        `#include <alphatest_fragment>
      float gravelDistance = distance(vGravelCenter, uGravelFocus) / vStoneDetailScale;
      float nearCoverage = 1.0 - smoothstep(${near[0].toFixed(1)}, ${near[1].toFixed(1)}, gravelDistance);
      float farCoverage = smoothstep(${far[0].toFixed(1)}, ${far[1].toFixed(1)}, gravelDistance);
      float grainDither = fract(52.9829189 * fract(dot(floor(gl_FragCoord.xy), vec2(0.06711056, 0.00583715))));
      #if GRAVEL_LOD == 0
        if (grainDither >= nearCoverage) discard;
      #elif GRAVEL_LOD == 1
        if (grainDither < nearCoverage || grainDither >= 1.0 - farCoverage) discard;
      #else
        if (grainDither < 1.0 - farCoverage) discard;
      #endif
      float gravelVisibility = 1.0 - smoothstep(vGravelFadeEnd - 6.0, vGravelFadeEnd, gravelDistance);
      float distanceDither = fract(grainDither * 17.17 + 0.37);
      if (distanceDither >= gravelVisibility) discard;
    `,
      );
  };
  material.customProgramCacheKey = () => `${cacheKey}-stone-lod-${level}-${near}-${far}-${sizeScaled}`;
  return material;
}

/** 让碎石接触阴影随距离平滑淡出。 */
export function addContactDistanceFade(material, focus) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uGravelFocus = focus;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
      attribute float gravelFadeEnd;
      varying float vGravelFadeEnd;
      varying vec2 vGravelCenter;
    `,
      )
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
      vGravelCenter = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xz;
      vGravelFadeEnd = gravelFadeEnd;
    `,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
      uniform vec2 uGravelFocus;
      varying float vGravelFadeEnd;
      varying vec2 vGravelCenter;
    `,
      )
      .replace(
        '#include <alphatest_fragment>',
        `#include <alphatest_fragment>
      diffuseColor.a *= 1.0 - smoothstep(vGravelFadeEnd - 6.0, vGravelFadeEnd, distance(vGravelCenter, uGravelFocus));
    `,
      );
  };
  material.customProgramCacheKey = () => 'gravel-contact-distance';
}
