// Media 烟尘 billboard + WBOIT，改编自 Ultra Elements (MIT) Particles media + common NOISE_GLSL。
// 仅近地 sheet：贴地慢扩、可残存。

export const dustMediaVertexShader = /* glsl */`
precision highp float;
precision highp int;
uniform mat4 modelMatrix;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform vec3 cameraPosition;
uniform float time;
uniform float strength;
uniform float residual;
uniform float sizeScale;
uniform float fadeRadius;
uniform float groundPersist;
uniform float sheetLife;
uniform float sheetDensity;
uniform float opacity;
uniform float erosion;
uniform vec3 sunDir;
uniform vec3 sunColor;
uniform vec3 ambient;
in vec3 position;
in vec3 aOrigin;
in vec3 aVelocity;
in float aBirth;
in float aSize;
in float aSeed;
out vec2 vUv;
out vec3 vSun;
out vec3 vAmb;
out vec3 vSunL;
out vec3 vUpL;
out float vAlpha;
out float vViewZ;
out float vRadius;
out float vDensity;
out float vErode;
out float vSoftScale;
out vec3 vNoise;

void main() {
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vAlpha = 0.0;
  float age = max(0.0, time - aBirth);
  float life = sheetLife;

  float fadeIn = smoothstep(0.0, 0.12, age / max(life, 0.05));
  float fadeOut = mix(1.0, groundPersist, smoothstep(life * 0.7, life * 1.15, age));
  float alive = fadeIn * fadeOut;
  if (alive < 0.004) return;

  // aOrigin/aVelocity.xz 为覆盖半径分数；乘 fadeRadius 后铺满可调范围。
  float R = max(fadeRadius, 1.0);
  vec2 home = aOrigin.xz * R;
  vec2 expand = home + aVelocity.xz * R * age;
  // 外圈继续外扩；近舱粒子多留在底部，避免抬升后中心被掏空。
  expand *= 1.0 / (1.0 + age * 0.04);
  float stay = (1.0 - smoothstep(0.025, 0.12, length(aOrigin.xz))) * groundPersist;
  vec2 drift = home * (0.65 + 0.2 * sin(aSeed * 1.7 + age * 0.4));
  vec2 xz = mix(expand, drift, stay);
  // 注意：不能写 vec3(vec2, 0)——那会把水平 z 塞进 y、真正的 z 变成 0，尘幕会收成一条。
  vec3 local = vec3(
    xz.x,
    max(0.05, 0.07 + aOrigin.y * 0.4 + 0.03 * sin(aSeed + age * 0.9) * exp(-age * 0.25)),
    xz.y
  );

  float radial = length(local.xz);
  float near = 1.0 - smoothstep(R * 0.55, R, radial);
  float pad = mix(1.0, near, smoothstep(R * 0.2, R * 0.85, radial));
  // 舱底中心用 residual 托底，不跟喷流 strength 随高度掉光。
  float core = 1.0 - smoothstep(0.0, R * 0.28, radial);
  float drive = max(strength, residual * (1.05 + 0.35 * core));
  float alpha = alive * drive * pad * opacity;
  if (alpha < 0.004 || pad < 0.02) return;

  vec3 world = (modelMatrix * vec4(local, 1.0)).xyz;
  vec4 cv4 = viewMatrix * vec4(world, 1.0);
  vec3 cv = cv4.xyz;
  float viewZ = -cv.z;
  if (viewZ < 0.05) return;

  float growth = 1.0 + age * 0.55;
  float size = aSize * sizeScale * growth;
  // 屏幕上限随 sizeScale 放宽，避免一律打顶导致 GUI「粒子大小」几乎无感。
  float maxR = 0.28 * max(sizeScale, 0.15) * viewZ / projectionMatrix[1][1];
  float r = min(size * 0.5, maxR);

  float spin = aSeed + age * 0.15;
  vec2 c = vec2(cos(spin), sin(spin));
  vec2 q = mat2(c.x, -c.y, c.y, c.x) * position.xy;
  gl_Position = projectionMatrix * vec4(cv + vec3(q * r, 0.0), 1.0);

  vUv = position.xy;
  vViewZ = viewZ;
  vRadius = r;
  vDensity = sheetDensity * mix(1.35, 0.4, smoothstep(0.0, R * 0.85, radial)) * (1.0 + 0.25 * core);
  float t = min(1.0, age / max(life, 0.05));
  vErode = erosion * (0.25 + 0.45 * t);
  vSoftScale = 2.8;
  vNoise = world * 0.35 + vec3(aSeed * 0.017);
  vAlpha = alpha;

  vec3 albedo = vec3(0.62, 0.58, 0.50);
  vec3 v = normalize(cameraPosition - world);
  float g = 0.35;
  float hg = (1.0 - g * g) / pow(max(1.0 + g * g - 2.0 * g * dot(sunDir, -v), 1e-3), 1.5);
  vSun = albedo * sunColor * hg * 0.85;
  vAmb = albedo * ambient * 1.35;
  vec3 sv = mat3(viewMatrix) * sunDir;
  vec3 up = mat3(viewMatrix) * vec3(0.0, 1.0, 0.0);
  mat2 unspin = mat2(c.x, c.y, -c.y, c.x);
  vSunL = vec3(unspin * sv.xy, sv.z);
  vUpL = vec3(unspin * up.xy, up.z);
}
`;

export const dustMediaFragmentShader = /* glsl */`
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler3D;
uniform highp sampler2D sceneDepth;
uniform highp sampler3D noise3D;
uniform vec2 resolution;
uniform vec2 fxResolution;
uniform vec2 nearFar;
in vec2 vUv;
in vec3 vSun;
in vec3 vAmb;
in vec3 vSunL;
in vec3 vUpL;
in float vAlpha;
in float vViewZ;
in float vRadius;
in float vDensity;
in float vErode;
in float vSoftScale;
in vec3 vNoise;
layout(location = 0) out vec4 fxMedia;
layout(location = 1) out vec4 fxWeight;

float noise3(vec3 p) { return texture(noise3D, p).r; }
float worley3(vec3 p) { return texture(noise3D, p).g; }
float fbm3(vec3 p) { return texture(noise3D, p).r * 0.7 + texture(noise3D, p * 2.63 + 0.37).r * 0.3; }

float linearDepth(float d) {
  float n = nearFar.x, f = nearFar.y;
  float z = d * 2.0 - 1.0;
  return (2.0 * n * f) / (f + n - z * (f - n));
}
float sceneViewZ() {
  ivec2 b = ivec2(floor(floor(gl_FragCoord.xy) * resolution / fxResolution));
  ivec2 m = ivec2(resolution) - 1;
  float d = texelFetch(sceneDepth, min(b, m), 0).r;
  d = max(d, texelFetch(sceneDepth, min(b + ivec2(1, 0), m), 0).r);
  d = max(d, texelFetch(sceneDepth, min(b + ivec2(0, 1), m), 0).r);
  d = max(d, texelFetch(sceneDepth, min(b + ivec2(1, 1), m), 0).r);
  return linearDepth(d);
}
float softFade(float viewZ, float dist) {
  return clamp((sceneViewZ() - viewZ) / max(dist, 1e-3), 0.0, 1.0);
}
float wboitWeight(float viewZ, float a) {
  return a * clamp(10.0 / (1e-5 + pow(viewZ / 10.0, 2.0) + pow(viewZ / 200.0, 6.0)), 0.01, 30.0);
}

void main() {
  if (vAlpha <= 0.001) discard;
  float r2 = dot(vUv, vUv);
  if (r2 >= 1.0) discard;

  float h = sqrt(max(0.0, 1.0 - r2)) * vRadius;
  float sceneZ = sceneViewZ();
  float thick = clamp(min(vViewZ + h, sceneZ) - max(vViewZ - h, nearFar.x), 0.0, 2.0 * h);
  float soft = softFade(vViewZ, max(h * 1.25, 0.12) * vSoftScale);

  float n = fbm3(vNoise + vec3(vUv * 0.42, 0.0)) * 0.65
          + worley3(vNoise * 1.7 + vec3(vUv * 0.9, 0.13)) * 0.35;
  float nFine = worley3(vNoise * 3.1 + vec3(vUv * 1.6, 0.27));
  float er = smoothstep(vErode, vErode + 0.42, n * (1.2 - r2 * 0.75));
  float rim = smoothstep(0.15, 0.72, nFine * (1.05 - r2));
  float b = smoothstep(0.18, 0.68, n);
  float a = (1.0 - exp(-vDensity * thick * (0.28 + 0.72 * b))) * er * rim * soft * vAlpha;
  if (a < 0.003) discard;

  vec3 N = vec3(vUv, sqrt(max(0.0, 1.0 - r2)));
  float dense = 1.0 - exp(-vDensity * vRadius * 2.0);
  float ns = fbm3(vNoise + vec3((vUv + vSunL.xy * 0.3) * 0.42, 0.0));
  float self = clamp(0.5 + (n - ns) * 4.5, 0.0, 1.0);
  float lam = clamp((dot(N, vSunL) + 0.35) / 1.35, 0.0, 1.0);
  float through = exp(-vDensity * thick);
  float sunShade = mix(through, lam, clamp(vSunL.z * 0.5 + 0.5, 0.0, 1.0)) * mix(1.0, self, 0.85) * 2.2;
  float ambShade = (0.65 + 0.35 * dot(N, vUpL)) * (0.5 + 0.5 * sqrt(r2)) * 1.7;
  vec3 lit = vSun * mix(1.0, sunShade, dense) + vAmb * mix(1.0, ambShade, dense);

  a = clamp(a, 0.0, 0.999);
  float w = wboitWeight(vViewZ, a);
  fxMedia = vec4(lit * a * w, a);
  fxWeight = vec4(a * w, 0.0, 0.0, a);
}
`;

export const dustCompositeVertexShader = /* glsl */`
precision highp float;
in vec3 position;
in vec2 uv;
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;
