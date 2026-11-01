import * as THREE from 'three';
import { randomAt, smoothNoise } from '../terrain/noise.js';

/**
 * 登月舱金箔：预烘焙褶皱贴图 + 物体空间三平面采样。
 */
let shared = null;

/** LM-5 下降级多为 2 mil 镀铝 Kapton：镜面琥珀橙金（非金属金）。 */
export const FOIL_COLOR = 0xd9a24a;
const FOIL_METALNESS = 0.7;
const FOIL_ROUGHNESS = 0.16;
/** 局部更厚的 5 mil 观感：更深、偏红琥珀。 */
export const FOIL_COLOR_HEAVY = 0xc48438;
/** 物体空间尺度：偏小让褶皱跨度更大，减少“贴砖”感。 */
const FOIL_WORLD_SCALE = 0.72;

/** Worley F1（2D），烘焙用。 */
function worleyF1(x, z, channel) {
  const ix = Math.floor(x),
    iz = Math.floor(z);
  let nearest = 1e9;
  for (let oz = -1; oz <= 1; oz++)
    for (let ox = -1; ox <= 1; ox++) {
      const cx = ix + ox + randomAt(ix + ox, iz + oz, channel);
      const cz = iz + oz + randomAt(ix + ox, iz + oz, channel + 19);
      nearest = Math.min(nearest, Math.hypot(x - cx, z - cz));
    }
  return nearest;
}

function fbm(u, v, channel, octaves = 3) {
  let sum = 0,
    amp = 0.5,
    freq = 1,
    weight = 0;
  for (let i = 0; i < octaves; i++) {
    sum += (smoothNoise(u * freq, v * freq, channel + i) - 0.5) * 2 * amp;
    weight += amp;
    amp *= 0.5;
    freq *= 2.05;
  }
  return sum / weight;
}

/** 手揉锡箔高度：低频为主，与当前视觉密度接近。 */
function crinkleHeight(u, v) {
  const wu = fbm(u * 1.7, v * 1.7, 8001, 3) * 0.28;
  const wv = fbm(u * 1.7 + 4.2, v * 1.7 - 2.6, 8002, 3) * 0.28;
  const pu = u + wu,
    pv = v + wv;
  let crumple = 0,
    amp = 0.5,
    freq = 3.4;
  for (let i = 0; i < 3; i++) {
    crumple += worleyF1(pu * freq, pv * freq, 8100 + i * 43) * amp;
    amp *= 0.5;
    freq *= 2.0;
  }
  return Math.pow(Math.max(0, 0.84 - crumple * 1.08), 1.28) + fbm(pu * 2.2, pv * 2.2, 8201, 2) * 0.1;
}

/** 四角加权采样，让烘焙贴图可无缝平铺。 */
function seamlessHeight(u, v) {
  const u0 = ((u % 1) + 1) % 1,
    v0 = ((v % 1) + 1) % 1;
  const a = crinkleHeight(u0, v0);
  const b = crinkleHeight(u0 - 1, v0);
  const c = crinkleHeight(u0, v0 - 1);
  const d = crinkleHeight(u0 - 1, v0 - 1);
  // 在贴图边界附近混到周期邻域，消除接缝。
  const wu = u0 * u0 * (3 - 2 * u0);
  const wv = v0 * v0 * (3 - 2 * v0);
  // 靠近 0/1 边才需要跨周期；中心区直接用 a。
  const eu = Math.min(u0, 1 - u0);
  const ev = Math.min(v0, 1 - v0);
  const edge = 1 - Math.min(1, Math.min(eu, ev) / 0.08);
  if (edge <= 0) return a;
  const mixed =
    a * (1 - wu) * (1 - wv) + b * wu * (1 - wv) + c * (1 - wu) * wv + d * wu * wv;
  return a * (1 - edge) + mixed * edge;
}

/** 生成共享的金箔 albedo / normal / roughness 贴图（只算一次）。 */
export function makeKaptonFoilTextures() {
  if (shared) return shared;
  const resolution = 512,
    sample = 1 / resolution;
  const heights = new Float32Array(resolution * resolution);
  let minH = 1e9,
    maxH = -1e9;
  for (let y = 0; y < resolution; y++)
    for (let x = 0; x < resolution; x++) {
      const h = seamlessHeight(x / resolution, y / resolution);
      heights[y * resolution + x] = h;
      minH = Math.min(minH, h);
      maxH = Math.max(maxH, h);
    }
  const span = Math.max(1e-5, maxH - minH);
  for (let i = 0; i < heights.length; i++) heights[i] = (heights[i] - minH) / span;

  const albedo = new Uint8Array(resolution * resolution * 4);
  const normal = new Uint8Array(albedo.length);
  const roughness = new Uint8Array(albedo.length);
  const read = (x, y) => heights[((y + resolution) % resolution) * resolution + ((x + resolution) % resolution)];

  for (let y = 0; y < resolution; y++)
    for (let x = 0; x < resolution; x++) {
      const offset = (y * resolution + x) * 4;
      const h = read(x, y);
      const nx = (read(x - 1, y) - read(x + 1, y)) / (2 * sample);
      const ny = (read(x, y - 1) - read(x, y + 1)) / (2 * sample);
      const relief = 0.9;
      const length = Math.hypot(nx * relief, ny * relief, 1);
      // 灰度明暗层：只做轻微起伏，色相交给 material.color。
      const shade = Math.min(255, Math.max(0, (0.9 + h * 0.22 + (randomAt(x, y, 8301) - 0.5) * 0.03) * 255));
      albedo.set([shade, shade, shade, 255], offset);
      normal.set(
        [
          ((nx * relief) / length) * 0.5 * 255 + 127.5,
          ((ny * relief) / length) * 0.5 * 255 + 127.5,
          (1 / length) * 0.5 * 255 + 127.5,
          255,
        ],
        offset,
      );
      const slope = Math.min(1, Math.hypot(nx, ny) * 0.35);
      const rough = Math.min(1, Math.max(0, 0.08 + (1 - h) * 0.24 + slope * 0.16));
      const byte = rough * 255;
      roughness.set([byte, byte, byte, 255], offset);
    }

  const texture = (data, colorSpace) => {
    const map = new THREE.DataTexture(data, resolution, resolution);
    map.colorSpace = colorSpace;
    map.wrapS = map.wrapT = THREE.RepeatWrapping;
    map.magFilter = THREE.LinearFilter;
    map.minFilter = THREE.LinearMipmapLinearFilter;
    map.generateMipmaps = true;
    map.anisotropy = 4;
    map.needsUpdate = true;
    return map;
  };

  shared = {
    albedo: texture(albedo, THREE.SRGBColorSpace),
    normal: texture(normal, THREE.NoColorSpace),
    roughness: texture(roughness, THREE.NoColorSpace),
  };
  return shared;
}

/** 记录套箔前的 GLB 原色与金属响应，供开关关闭时还原。 */
export function snapshotKaptonOriginal(material) {
  if (material.userData.kaptonOriginal) return material.userData.kaptonOriginal;
  material.userData.kaptonOriginal = {
    color: material.color.clone(),
    metalness: material.metalness,
    roughness: material.roughness,
    envMapIntensity: material.envMapIntensity ?? 1,
  };
  return material.userData.kaptonOriginal;
}

/** 软三平面：连续混合 + 轴向错位 UV + 轻扭曲，避免硬接缝与贴砖感。 */
const KAPTON_TRIPLANAR = /* glsl */ `
varying vec3 vKaptonObj;
varying vec3 vKaptonNormal;
uniform float uKaptonEnabled;
uniform vec3 uKaptonOriginalColor;
uniform float uKaptonOriginalMetal;
uniform float uKaptonOriginalRough;
uniform sampler2D uKaptonShade;
uniform sampler2D uKaptonNormal;
uniform sampler2D uKaptonRough;
uniform float uKaptonScale;

vec3 kapBlendWeights(vec3 wn) {
  // 低次幂：宽过渡带，接缝处像一张膜翻过棱，而不是三块贴图硬切。
  vec3 blend = pow(abs(wn), vec3(1.6));
  return blend / max(dot(blend, vec3(1.0)), 1e-4);
}

vec2 kapWarp(vec2 uv) {
  // 轻量扭曲打断周期平铺，仍比片元 Worley 便宜。
  uv += vec2(
    sin(uv.y * 6.2831853 * 0.37 + 1.7) * 0.045,
    cos(uv.x * 6.2831853 * 0.31 - 0.9) * 0.045
  );
  return uv;
}

vec2 kapUvX(vec3 pos, float scale) {
  return kapWarp(vec2(pos.z * scale * 0.93 + 0.17, pos.y * scale * 1.07 - 0.11));
}
vec2 kapUvY(vec3 pos, float scale) {
  return kapWarp(vec2(pos.x * scale * 1.05 - 0.23, pos.z * scale * 0.97 + 0.31));
}
vec2 kapUvZ(vec3 pos, float scale) {
  return kapWarp(vec2(pos.x * scale * 0.99 + 0.41, pos.y * scale * 1.03 - 0.19));
}

vec3 kapTriplanarNormal(vec3 pos, vec3 wn, float scale) {
  vec3 blend = kapBlendWeights(wn);
  vec3 nX = texture2D(uKaptonNormal, kapUvX(pos, scale)).xyz * 2.0 - 1.0;
  vec3 nY = texture2D(uKaptonNormal, kapUvY(pos, scale)).xyz * 2.0 - 1.0;
  vec3 nZ = texture2D(uKaptonNormal, kapUvZ(pos, scale)).xyz * 2.0 - 1.0;
  nX = normalize(vec3(nX.z * sign(wn.x), nX.y, nX.x));
  nY = normalize(vec3(nY.x, nY.z * sign(wn.y), nY.y));
  nZ = normalize(vec3(nZ.x, nZ.y, nZ.z * sign(wn.z)));
  // Whiteout 混合，减少三平面法线接缝。
  vec3 n = normalize(vec3(
    nX.x * blend.x + nY.x * blend.y + nZ.x * blend.z,
    nX.y * blend.x + nY.y * blend.y + nZ.y * blend.z,
    nX.z * blend.x + nY.z * blend.y + nZ.z * blend.z + 1.0
  ));
  return n;
}

float kapTriplanarScalar(sampler2D map, vec3 pos, vec3 wn, float scale) {
  vec3 blend = kapBlendWeights(wn);
  float x = texture2D(map, kapUvX(pos, scale)).r;
  float y = texture2D(map, kapUvY(pos, scale)).r;
  float z = texture2D(map, kapUvZ(pos, scale)).r;
  return x * blend.x + y * blend.y + z * blend.z;
}

`;

/** 给登月舱金箔材质：烘焙贴图 + 三平面，避免片元内重程序噪声。 */
export function applyKaptonFoil(material, {
  color = FOIL_COLOR,
  metalness = FOIL_METALNESS,
  roughness = FOIL_ROUGHNESS,
} = {}) {
  const original = snapshotKaptonOriginal(material);
  const maps = makeKaptonFoilTextures();
  material.map = null;
  material.normalMap = null;
  material.roughnessMap = null;
  material.metalnessMap = null;
  material.color.set(color);
  material.metalness = metalness;
  material.roughness = roughness;
  material.envMapIntensity = 1.65;
  material.userData.kaptonFoilLook = { color, metalness, roughness };

  const enabled = { value: 1 };
  const originalColor = { value: original.color.clone() };
  const originalMetal = { value: original.metalness };
  const originalRough = { value: original.roughness };
  const scale = { value: FOIL_WORLD_SCALE };
  material.userData.kaptonEnabled = enabled;
  material.userData.kaptonOriginalColor = originalColor;
  material.userData.kaptonOriginalMetal = originalMetal;
  material.userData.kaptonOriginalRough = originalRough;

  const previousCompile = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey?.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    previousCompile?.call(material, shader, renderer);
    Object.assign(shader.uniforms, {
      uKaptonEnabled: enabled,
      uKaptonOriginalColor: originalColor,
      uKaptonOriginalMetal: originalMetal,
      uKaptonOriginalRough: originalRough,
      uKaptonShade: { value: maps.albedo },
      uKaptonNormal: { value: maps.normal },
      uKaptonRough: { value: maps.roughness },
      uKaptonScale: scale,
    });
    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      `#include <common>
      varying vec3 vKaptonObj;
      varying vec3 vKaptonNormal;`,
    );
    shader.vertexShader = shader.vertexShader.replace(
      '#include <project_vertex>',
      `#include <project_vertex>
      vKaptonObj = (modelMatrix * vec4(transformed, 1.0)).xyz;
      vKaptonNormal = normalize(mat3(modelMatrix) * normal);`,
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      `#include <common>
      ${KAPTON_TRIPLANAR}`,
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_fragment>',
      `#include <color_fragment>
      {
        if (uKaptonEnabled < 0.5) diffuseColor.rgb = uKaptonOriginalColor;
        else {
          // 保留亮琥珀色相，只用灰度贴图做轻微明暗（避免 albedo 叠乘发闷）。
          float shade = kapTriplanarScalar(uKaptonShade, vKaptonObj, normalize(vKaptonNormal), uKaptonScale);
          diffuseColor.rgb *= mix(0.94, 1.14, shade);
        }
      }`,
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <normal_fragment_maps>',
      `#include <normal_fragment_maps>
      {
        if (uKaptonEnabled > 0.5) {
          vec3 wn = normalize(vKaptonNormal);
          vec3 foilN = kapTriplanarNormal(vKaptonObj, wn, uKaptonScale);
          foilN = normalize(mix(wn, foilN, 0.58));
          normal = normalize(transformDirection(foilN, viewMatrix));
        }
      }`,
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <roughnessmap_fragment>',
      `#include <roughnessmap_fragment>
      {
        if (uKaptonEnabled < 0.5) roughnessFactor = uKaptonOriginalRough;
        else roughnessFactor = kapTriplanarScalar(uKaptonRough, vKaptonObj, normalize(vKaptonNormal), uKaptonScale);
      }`,
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <metalnessmap_fragment>',
      `#include <metalnessmap_fragment>
      {
        if (uKaptonEnabled < 0.5) metalnessFactor = uKaptonOriginalMetal;
        else metalnessFactor = mix(0.62, 0.82, 1.0 - roughnessFactor);
      }`,
    );
  };
  material.customProgramCacheKey = () => `${previousKey?.() ?? ''}|kapton-foil`;
  material.userData.kaptonFoil = true;
  material.userData.lunarThermalFilm = true;
  material.needsUpdate = true;
}

/** 开关金箔：开=琥珀揉皱，关=GLB 原色与原金属度（不拆着色器）。 */
export function setKaptonFoilEnabled(material, enabled) {
  if (!material?.userData?.kaptonFoil) return false;
  const on = Boolean(enabled);
  const original = material.userData.kaptonOriginal;
  if (material.userData.kaptonEnabled) material.userData.kaptonEnabled.value = on ? 1 : 0;
  if (on) {
    const look = material.userData.kaptonFoilLook ?? {
      color: FOIL_COLOR, metalness: FOIL_METALNESS, roughness: FOIL_ROUGHNESS,
    };
    material.color.set(look.color);
    material.metalness = look.metalness;
    material.roughness = look.roughness;
    material.envMapIntensity = 1.65;
    material.userData.lunarThermalFilm = true;
  } else if (original) {
    material.color.copy(original.color);
    material.metalness = original.metalness;
    material.roughness = original.roughness;
    material.envMapIntensity = original.envMapIntensity;
    material.userData.lunarThermalFilm = false;
  }
  return true;
}
