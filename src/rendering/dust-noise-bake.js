/*! Ultra Elements noise.js 的精简版：仅烘焙 64^3 Perlin–Worley（MIT）。 */
import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

const BAKE_VERT = /* glsl */`
precision highp float;
in vec3 position;
in vec2 uv;
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// 与 ultra noise.js 同结构的 Perlin–Worley fbm，体积更小供尘幕采样。
const BAKE_FRAG = /* glsl */`
precision highp float;
precision highp int;
uniform float uZ;
uniform int uOne;
in vec2 vUv;
layout(location = 0) out vec4 outColor;

uvec3 pcg3d(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}
uvec3 hashL(ivec3 c, int P, uint seed) {
  c += P * (ivec3(lessThan(c, ivec3(0))) - ivec3(greaterThanEqual(c, ivec3(P))));
  return pcg3d(uvec3(c) + seed * uvec3(0x9E3779B9u, 0x85EBCA6Bu, 0xC2B2AE35u));
}
vec3 hash3(ivec3 c, int P, uint seed) { return vec3(hashL(c, P, seed) >> 8u) * (1.0 / 16777216.0); }
float worley(vec3 x, int P, uint seed) {
  ivec3 i = ivec3(floor(x));
  vec3 f = fract(x);
  float d = 8.0;
  for (int z = -uOne; z <= uOne; z++)
    for (int y = -uOne; y <= uOne; y++)
      for (int k = -uOne; k <= uOne; k++) {
        ivec3 o = ivec3(k, y, z);
        vec3 r = vec3(o) + hash3(i + o, P, seed) - f;
        d = min(d, dot(r, r));
      }
  return 1.0 - clamp(sqrt(d), 0.0, 1.0);
}
float gnoise(vec3 x, int P, uint seed) {
  ivec3 i = ivec3(floor(x));
  vec3 f = fract(x), u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float v = 0.0;
  for (int c = 0; c < 8 * uOne; c++) {
    ivec3 o = ivec3(c & 1, (c >> 1) & 1, c >> 2);
    vec3 s = mix(1.0 - u, u, vec3(o));
    v += s.x * s.y * s.z * dot(hash3(i + o, P, seed) * 2.0 - 1.0, f - vec3(o));
  }
  return v;
}
float stretch(float x, float lo, float hi) { return clamp((x - lo) / (hi - lo), 0.0, 1.0); }
void main() {
  vec3 p = vec3(vUv, uZ);
  float pf = 0.0, amp = 1.0;
  for (int o = 0; o < 5 * uOne; o++) { pf += gnoise(p * float(4 << o), 4 << o, 7u) * amp; amp *= 0.5; }
  float perlin = clamp(pf * 0.5 + 0.5, 0.0, 1.0);
  vec3 gba = vec3(0.0);
  for (int o = 0; o < 5 * uOne; o++) {
    vec3 k = float(o) - vec3(0.0, 1.0, 2.0);
    vec3 wt = 0.625 * step(abs(k), vec3(0.5)) + 0.25 * step(abs(k - 1.0), vec3(0.5)) + 0.125 * step(abs(k - 2.0), vec3(0.5));
    gba += wt * worley(p * float(2 << o), 2 << o, uint(o + 1));
  }
  float pw = gba.y + perlin * (1.0 - gba.y);
  outColor = vec4(stretch(pw, 0.53, 0.90), stretch(gba.x, 0.21, 0.75), stretch(gba.y, 0.21, 0.75), stretch(gba.z, 0.21, 0.75));
}
`;

/** 烘焙可平铺的 64^3 RGBA8 噪声；r=Perlin-Worley，gba=Worley 细节。 */
export async function bakeDustNoise3D(renderer, { size = 64 } = {}) {
  const previous = renderer.getRenderTarget();
  const face = renderer.getActiveCubeFace();
  const mip = renderer.getActiveMipmapLevel();
  const material = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: BAKE_VERT,
    fragmentShader: BAKE_FRAG,
    uniforms: { uZ: { value: 0 }, uOne: { value: 1 } },
    depthTest: false,
    depthWrite: false,
  });
  const quad = new FullScreenQuad(material);
  const target = new THREE.WebGL3DRenderTarget(size, size, size, {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.RepeatWrapping,
    depthBuffer: false,
    generateMipmaps: false,
  });
  target.texture.wrapR = THREE.RepeatWrapping;
  target.texture.name = '尘幕 Perlin-Worley';
  try {
    // FullScreenQuad 无对外 mesh；首片绘制会触发编译，无需 compileAsync。
    for (let z = 0; z < size; z++) {
      material.uniforms.uZ.value = (z + 0.5) / size;
      renderer.setRenderTarget(target, z);
      quad.render(renderer);
    }
  } finally {
    material.dispose();
    quad.dispose();
    renderer.setRenderTarget(previous, face, mip);
  }
  return target;
}
