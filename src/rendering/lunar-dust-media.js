/*! 起飞尘幕：Ultra Elements media billboard + 半分辨率 WBOIT（MIT）适配。 */
import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import {
  dustMediaVertexShader,
  dustMediaFragmentShader,
  dustCompositeVertexShader,
} from './lunar-dust-media-shader.js';
import { bakeDustNoise3D } from './dust-noise-bake.js';

export const DUST_CAPACITY = 5000;
export const DUST_DEFAULT_COUNT = 3000;

/** 固定种子，保证重试与不同帧率下尘幕一致。 */
function randomSource(seed = 8731) {
  let s = seed;
  return () => {
    s = Math.imul(s, 1664525) + 1013904223 | 0;
    return (s >>> 0) / 4294967296;
  };
}

/**
 * Apollo 贴地尘幕：仅近地 sheet，半分辨率 media billboard + WBOIT。
 */
export class LunarDustMedia {
  /** @param {THREE.Object3D} parent 着陆器局部根（Y 已对齐月面向上）。 */
  constructor(parent, { capacity = DUST_CAPACITY } = {}) {
    this.parent = parent;
    this.capacity = capacity;
    this.settings = {
      enabled: true,
      count: DUST_DEFAULT_COUNT,
      opacity: 0.22,
      sizeScale: 1.5,
      sheetLife: 8,
      sheetDensity: 3.2,
      groundPersist: 0.82,
      fadeRadius: 20,
      strengthScale: 1,
      erosion: 0.55,
      visibleUntil: 7,
    };
    this.noiseTarget = null;
    this.sunDir = new THREE.Vector3(0.4, 0.75, 0.3).normalize();
    this.sunColor = new THREE.Color(1.0, 0.92, 0.78);
    this.ambient = new THREE.Color(0.12, 0.13, 0.15);
    this.active = false;
    this._time = 0;
    this._strength = 0;
    this._residual = 0;

    const random = randomSource();
    const origin = new Float32Array(capacity * 3);
    const velocity = new Float32Array(capacity * 3);
    const birth = new Float32Array(capacity);
    const size = new Float32Array(capacity);
    const seed = new Float32Array(capacity);
    // 径向以「覆盖半径分数」烘焙，shader 再乘 fadeRadius，GUI 才能真正改变铺开范围。
    for (let i = 0; i < capacity; i++) {
      const angle = random() * Math.PI * 2;
      const radius = 0.02 + random() * 0.12;
      const speed = 0.06 + random() * 0.16;
      const lift = 0.01 + random() * 0.06;
      origin.set([
        Math.cos(angle) * radius,
        0.04 + random() * 0.1,
        Math.sin(angle) * radius,
      ], i * 3);
      velocity.set([
        Math.cos(angle) * speed,
        lift,
        Math.sin(angle) * speed,
      ], i * 3);
      birth[i] = random() * 0.55;
      size[i] = 0.85 + random() * 1.5;
      seed[i] = random() * 1000;
    }

    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    geo.setAttribute('aOrigin', new THREE.InstancedBufferAttribute(origin, 3));
    geo.setAttribute('aVelocity', new THREE.InstancedBufferAttribute(velocity, 3));
    geo.setAttribute('aBirth', new THREE.InstancedBufferAttribute(birth, 1));
    geo.setAttribute('aSize', new THREE.InstancedBufferAttribute(size, 1));
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 1));
    geo.instanceCount = DUST_DEFAULT_COUNT;

    this.uniforms = {
      time: { value: 0 },
      strength: { value: 0 },
      residual: { value: 0 },
      sizeScale: { value: this.settings.sizeScale },
      fadeRadius: { value: this.settings.fadeRadius },
      groundPersist: { value: this.settings.groundPersist },
      sheetLife: { value: this.settings.sheetLife },
      sheetDensity: { value: this.settings.sheetDensity },
      opacity: { value: this.settings.opacity },
      erosion: { value: this.settings.erosion },
      sunDir: { value: this.sunDir },
      sunColor: { value: this.sunColor },
      ambient: { value: this.ambient },
      sceneDepth: { value: null },
      noise3D: { value: null },
      resolution: { value: new THREE.Vector2(1, 1) },
      fxResolution: { value: new THREE.Vector2(1, 1) },
      nearFar: { value: new THREE.Vector2(0.1, 2000) },
    };

    this.material = new THREE.RawShaderMaterial({
      name: '起飞尘幕 media',
      glslVersion: THREE.GLSL3,
      vertexShader: dustMediaVertexShader,
      fragmentShader: dustMediaFragmentShader,
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendEquationAlpha: THREE.AddEquation,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      toneMapped: false,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = '起飞尘幕 media';
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.visible = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.mesh);

    this.target = new THREE.WebGLRenderTarget(1, 1, {
      count: 2,
      type: THREE.HalfFloatType,
      depthBuffer: false,
    });
    this.target.textures[0].name = '尘幕 WBOIT accum';
    this.target.textures[1].name = '尘幕 WBOIT weight';

    this.compositeMaterial = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        accum: { value: this.target.textures[0] },
        weight: { value: this.target.textures[1] },
      },
      vertexShader: dustCompositeVertexShader,
      fragmentShader: /* glsl */`
precision highp float;
uniform sampler2D accum;
uniform sampler2D weight;
in vec2 vUv;
out vec4 fragColor;
void main() {
  vec4 m = texture(accum, vUv);
  float w = texture(weight, vUv).r;
  float revealage = m.a;
  if (w < 1e-4 && revealage > 0.999) discard;
  vec3 color = m.rgb / max(w, 1e-4);
  float alpha = clamp(1.0 - revealage, 0.0, 1.0);
  fragColor = vec4(color * alpha, alpha);
}`,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      toneMapped: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    this.quad = new FullScreenQuad(this.compositeMaterial);
    this.clearColor = new THREE.Color();
    this._parentWorld = new THREE.Matrix4();
  }

  /** 同步 GUI / 调用方参数。 */
  configure(values = {}) {
    Object.assign(this.settings, values);
    const s = this.settings;
    s.count = THREE.MathUtils.clamp(Math.round(s.count), 0, this.capacity);
    this.mesh.geometry.instanceCount = s.count;
    this.uniforms.sizeScale.value = s.sizeScale;
    this.uniforms.fadeRadius.value = s.fadeRadius;
    this.uniforms.groundPersist.value = s.groundPersist;
    this.uniforms.sheetLife.value = s.sheetLife;
    this.uniforms.sheetDensity.value = s.sheetDensity;
    this.uniforms.opacity.value = s.opacity;
    this.uniforms.erosion.value = s.erosion;
    this.mesh.visible = s.enabled && this.active;
  }

  /** 可选：从场景主光同步日照方向与色温。 */
  setSun({ direction, color, ambient } = {}) {
    if (direction) this.sunDir.copy(direction).normalize();
    if (color) this.sunColor.copy(color);
    if (ambient) this.ambient.copy(ambient);
  }

  /** 按起飞剖面推进；sheet 由 strength / residual 驱动并残存。 */
  update(profile, { strength = 0, residual = 0 } = {}) {
    const s = this.settings;
    this._time = profile.flightTime;
    this._strength = strength * s.strengthScale;
    this._residual = residual * s.strengthScale;
    this.active = s.enabled && (this._strength > 0.01 || this._residual > 0.02)
      && profile.flightTime < s.visibleUntil;
    this.mesh.visible = this.active && s.count > 0;
    this.uniforms.time.value = this._time;
    this.uniforms.strength.value = this._strength;
    this.uniforms.residual.value = this._residual;
  }

  /** 烘焙 Ultra 同款 Perlin–Worley，并预编译半分辨率通道。 */
  async prepare(renderer, camera, scene) {
    if (!this.noiseTarget) {
      this.noiseTarget = await bakeDustNoise3D(renderer, { size: 64 });
      this.uniforms.noise3D.value = this.noiseTarget.texture;
    }
    const previous = renderer.getRenderTarget();
    const face = renderer.getActiveCubeFace();
    const mip = renderer.getActiveMipmapLevel();
    const was = this.mesh.visible;
    this.mesh.visible = true;
    this.mesh.geometry.instanceCount = Math.min(4, this.capacity);
    try {
      renderer.setRenderTarget(this.target);
      await renderer.compileAsync(this.scene, camera, scene);
    } finally {
      this.mesh.visible = was;
      this.mesh.geometry.instanceCount = this.settings.count;
      renderer.setRenderTarget(previous, face, mip);
    }
  }

  /** 半分辨率 WBOIT 后合成进 HDR sceneTarget。 */
  render(renderer, camera, sceneTarget) {
    if (!this.mesh.visible) return;
    this.parent.updateWorldMatrix(true, false);
    this.mesh.matrix.copy(this.parent.matrixWorld);
    this.mesh.matrixWorld.copy(this.parent.matrixWorld);

    const width = Math.max(1, Math.ceil(sceneTarget.width / 2));
    const height = Math.max(1, Math.ceil(sceneTarget.height / 2));
    if (this.target.width !== width || this.target.height !== height) this.target.setSize(width, height);

    this.uniforms.sceneDepth.value = sceneTarget.depthTexture;
    this.uniforms.resolution.value.set(sceneTarget.width, sceneTarget.height);
    this.uniforms.fxResolution.value.set(width, height);
    this.uniforms.nearFar.value.set(camera.near, camera.far);

    const alpha = renderer.getClearAlpha();
    const autoClear = renderer.autoClear;
    renderer.getClearColor(this.clearColor);
    try {
      renderer.setRenderTarget(this.target);
      // revealage 初值 1，颜色 0。
      renderer.setClearColor(0x000000, 1);
      renderer.autoClear = true;
      renderer.clear();
      renderer.autoClear = false;
      renderer.render(this.scene, camera);

      this.compositeMaterial.uniforms.accum.value = this.target.textures[0];
      this.compositeMaterial.uniforms.weight.value = this.target.textures[1];
      renderer.setRenderTarget(sceneTarget);
      this.quad.render(renderer);
    } finally {
      this.uniforms.sceneDepth.value = null;
      renderer.setClearColor(this.clearColor, alpha);
      renderer.autoClear = autoClear;
      renderer.setRenderTarget(sceneTarget);
    }
  }

  reset() {
    this.active = false;
    this.mesh.visible = false;
    this._strength = this._residual = 0;
    this.uniforms.time.value = 0;
    this.uniforms.strength.value = 0;
    this.uniforms.residual.value = 0;
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.target.dispose();
    this.compositeMaterial.dispose();
    this.quad.dispose();
    this.uniforms.noise3D.value = null;
    this.noiseTarget?.dispose();
    this.noiseTarget = null;
  }
}
