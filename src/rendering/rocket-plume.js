/*! @license aeronautic - Copyright (c) 2026 Romain Le Gall - MIT - /licenses/aeronautic.txt */
import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { plumeVertexShader, plumeFragmentShader } from './rocket-plume-shader.js';

/** CIE 拟合曲线的分段高斯，对应原示例的黑体颜色查找表。 */
function lobe(nm, mean, below, above) {
  const t = (nm - mean) / (nm < mean ? below : above);
  return Math.exp(-0.5 * t * t);
}

/** 积分 Planck 光谱并转换为线性 RGB，保留温度对应的亮度关系。 */
function blackbodyRGB(kelvin) {
  let x = 0, y = 0, z = 0;
  for (let nm = 380; nm <= 780; nm += 2) {
    const wavelength = nm * 1e-9;
    const power = 3.7418e-16 / wavelength ** 5 / Math.expm1(0.014388 / (wavelength * kelvin));
    x += power * (1.056 * lobe(nm, 599.8, 37.9, 31) + 0.362 * lobe(nm, 442, 16, 26.7) - 0.065 * lobe(nm, 501.1, 20.4, 26.2));
    y += power * (0.821 * lobe(nm, 568.8, 46.9, 40.5) + 0.286 * lobe(nm, 530.9, 16.3, 31.1));
    z += power * (1.217 * lobe(nm, 437, 11.8, 36) + 0.681 * lobe(nm, 459, 26, 13.8));
  }
  return [Math.max(0, 3.2406 * x - 1.5372 * y - 0.4986 * z),
    Math.max(0, -0.9689 * x + 1.8758 * y + 0.0415 * z),
    Math.max(0, 0.0557 * x - 0.204 * y + 1.057 * z), y];
}

/** 以半浮点编码色度与对数亮度，避免每个光线步长都积分光谱。 */
function createBlackbodyTexture() {
  const reference = blackbodyRGB(2000)[3];
  const data = new Uint16Array(256 * 4);
  for (let index = 0; index < 256; index++) {
    const [r, g, b, y] = blackbodyRGB(500 + 5500 * index / 255);
    const luminance = Math.max(y, 1e-30);
    [r / luminance, g / luminance, b / luminance, Math.log2(luminance / reference)]
      .forEach((value, channel) => { data[index * 4 + channel] = THREE.DataUtils.toHalfFloat(value); });
  }
  const texture = new THREE.DataTexture(data, 256, 1, THREE.RGBAFormat, THREE.HalfFloatType);
  texture.name = '喷流黑体光谱';
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/** 真空羽流半角（相对轴线）。NASA LM 全张角约 97° → 半角约 48.5°。 */
export const VACUUM_FLARE_DEG = 50;

/** 按喷管半径、射程与真空张角生成包围圆锥；+Z 为喷射轴。 */
function createBoundsGeometry(nozzleRadius, reach, flareDeg = VACUUM_FLARE_DEG) {
  const tip = nozzleRadius * 1.15;
  const base = tip + reach * Math.tan(THREE.MathUtils.degToRad(flareDeg));
  // radiusTop=+Y→旋转后 +Z（远场），radiusBottom→z=0（喷口）。
  const geometry = new THREE.CylinderGeometry(base, tip, reach, 24, 1);
  geometry.rotateX(Math.PI / 2);
  geometry.translate(0, 0, reach / 2);
  return geometry;
}

/** 将 aeronautic 的体积火箭喷流适配至现有 WebGL / HDR / 选择性辉光流程。 */
export class RocketPlume {
  /** 代理网格只提供包围体，真正的火焰在半分辨率缓冲中沿视线积分。 */
  constructor({ nozzleRadius = 0.21, reach = 5.4, flareDeg = VACUUM_FLARE_DEG } = {}) {
    this.settings = {
      nozzleRadius,
      reach,
      flareDeg,
      intensity: 0.85,
      coreLengthScale: 1.6,
      shockSpacingScale: 2.8,
      flowSpeed: 2,
      // Aerozine 50 / N2O4 真空羽流近乎无色；保留极低烟炱便于辨认。
      sootAmount: 0.12,
      shockHeat: 140,
      glowStrength: 0.14,
      ignitionDuration: 0.18,
      stepCount: 40,
    };
    this.blackbody = createBlackbodyTexture();
    const flareSlope = Math.tan(THREE.MathUtils.degToRad(flareDeg));
    this.uniforms = {
      sceneDepth: { value: null }, blackbody: { value: this.blackbody },
      viewport: { value: new THREE.Vector2() }, projectionInverse: { value: new THREE.Matrix4() },
      viewToLocal: { value: new THREE.Matrix4() }, cameraLocal: { value: new THREE.Vector3() },
      time: { value: 0 }, strength: { value: 0 },
      nozzleRadius: { value: nozzleRadius }, reach: { value: reach }, flareSlope: { value: flareSlope },
      stepCount: { value: 40 },
      intensity: { value: 0.85 }, coreLengthScale: { value: 1.6 }, shockSpacingScale: { value: 2.8 },
      flowSpeed: { value: 2 }, sootAmount: { value: 0.12 }, shockHeat: { value: 140 },
    };
    const material = new THREE.ShaderMaterial({
      name: '体积火箭喷流', uniforms: this.uniforms,
      vertexShader: plumeVertexShader, fragmentShader: plumeFragmentShader,
      side: THREE.BackSide, depthTest: false, depthWrite: false, transparent: true,
      blending: THREE.NoBlending, toneMapped: false,
    });
    this.mesh = new THREE.Mesh(createBoundsGeometry(nozzleRadius, reach, flareDeg), material);
    this.mesh.name = '上升发动机体积喷流';
    this.mesh.userData.excludeFromCollider = true;
    this.mesh.rotation.x = Math.PI / 2; // 原示例 +Z 喷射方向转换为登月舱局部 -Y。
    this.mesh.layers.set(28); // 主场景与阴影不绘制代理体，由专用缓冲绘制。
    this.mesh.visible = false;
    this.proxy = this.mesh.clone();
    this.proxy.layers.set(0);
    this.proxy.visible = true;
    this.proxy.matrixAutoUpdate = false;
    this.proxy.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.proxy);
    this.target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
    this.target.texture.name = '半分辨率体积喷流';
    this.compositeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        plume: { value: this.target.texture },
        glow: { value: false },
        glowStrength: { value: this.settings.glowStrength },
      },
      vertexShader: 'varying vec2 vUv; void main(){vUv=uv;gl_Position=vec4(position.xy,0.0,1.0);}',
      fragmentShader: `varying vec2 vUv; uniform sampler2D plume; uniform bool glow; uniform float glowStrength;
        void main(){vec4 color=texture2D(plume,vUv);
          if(glow){float brightness=dot(color.rgb,vec3(0.2126,0.7152,0.0722));
            color=vec4(color.rgb*smoothstep(1.0,2.0,brightness)*glowStrength,0.0);}
          gl_FragColor=color;}`,
      depthTest: false, depthWrite: false, transparent: true, toneMapped: false,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    this.quad = new FullScreenQuad(this.compositeMaterial);
    this.inverse = new THREE.Matrix4();
    this.clearColor = new THREE.Color();
  }

  /** 同步 GUI / 调用方写入的外形与外观参数；喷管 / 射程 / 张角变化时重建包围锥。 */
  configure(values = {}) {
    const previousRadius = this.settings.nozzleRadius;
    const previousReach = this.settings.reach;
    const previousFlare = this.settings.flareDeg;
    Object.assign(this.settings, values);
    const {
      nozzleRadius, reach, flareDeg, intensity, coreLengthScale, shockSpacingScale,
      flowSpeed, sootAmount, shockHeat, glowStrength, stepCount,
    } = this.settings;
    this.uniforms.nozzleRadius.value = nozzleRadius;
    this.uniforms.reach.value = reach;
    this.uniforms.flareSlope.value = Math.tan(THREE.MathUtils.degToRad(flareDeg));
    this.uniforms.intensity.value = intensity;
    this.uniforms.coreLengthScale.value = coreLengthScale;
    this.uniforms.shockSpacingScale.value = shockSpacingScale;
    this.uniforms.flowSpeed.value = flowSpeed;
    this.uniforms.sootAmount.value = sootAmount;
    this.uniforms.shockHeat.value = shockHeat;
    this.uniforms.stepCount.value = stepCount;
    this.compositeMaterial.uniforms.glowStrength.value = glowStrength;
    if (nozzleRadius !== previousRadius || reach !== previousReach || flareDeg !== previousFlare) {
      const geometry = createBoundsGeometry(nozzleRadius, reach, flareDeg);
      const old = this.mesh.geometry;
      this.mesh.geometry = geometry;
      this.proxy.geometry = geometry;
      old.dispose();
    }
  }

  /** 根据绝对起飞时间推进流动，点火渐亮；离开月面后主发动机喷流保持稳定。 */
  update({ powered, flightTime }) {
    this.mesh.visible = powered;
    this.uniforms.time.value = flightTime;
    const ramp = Math.max(1e-4, this.settings.ignitionDuration);
    this.uniforms.strength.value = powered ? THREE.MathUtils.smoothstep(flightTime, 0, ramp) : 0;
  }

  /** 在真实半浮点目标上预编译喷流，点火时复用相同的着色器程序。 */
  async prepare(renderer, camera, scene) {
    const target = renderer.getRenderTarget(), face = renderer.getActiveCubeFace(), mip = renderer.getActiveMipmapLevel();
    try {
      renderer.setRenderTarget(this.target);
      await renderer.compileAsync(this.scene, camera, scene);
    } finally {
      renderer.setRenderTarget(target, face, mip);
    }
  }

  /** 先用已完成的场景深度截断喷流，再合成至 HDR；不会读写同一深度附件。 */
  render(renderer, camera, sceneTarget) {
    const width = Math.max(1, Math.ceil(sceneTarget.width / 2)), height = Math.max(1, Math.ceil(sceneTarget.height / 2));
    if (this.target.width !== width || this.target.height !== height) this.target.setSize(width, height);
    this.mesh.updateWorldMatrix(true, false);
    this.proxy.matrix.copy(this.mesh.matrixWorld);
    this.inverse.copy(this.mesh.matrixWorld).invert();
    this.uniforms.cameraLocal.value.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(this.inverse);
    this.uniforms.viewToLocal.value.multiplyMatrices(this.inverse, camera.matrixWorld);
    this.uniforms.projectionInverse.value.copy(camera.projectionMatrixInverse);
    this.uniforms.sceneDepth.value = sceneTarget.depthTexture;
    this.uniforms.viewport.value.set(width, height);
    const steps = this.settings.stepCount;
    this.uniforms.stepCount.value = width < 500 ? Math.min(28, steps) : steps;
    const alpha = renderer.getClearAlpha(), autoClear = renderer.autoClear;
    renderer.getClearColor(this.clearColor);
    try {
      renderer.setRenderTarget(this.target);
      renderer.setClearColor(0x000000, 0);
      renderer.autoClear = true;
      renderer.render(this.scene, camera);
      this.composite(renderer, sceneTarget);
    } finally {
      this.uniforms.sceneDepth.value = null;
      renderer.setClearColor(this.clearColor, alpha);
      renderer.autoClear = autoClear;
      renderer.setRenderTarget(sceneTarget);
    }
  }

  /** 复用已积分结果，分别叠加正常辐射与少量辉光来源。 */
  composite(renderer, target, glow = false) {
    const autoClear = renderer.autoClear;
    try {
      renderer.autoClear = false;
      this.compositeMaterial.uniforms.glow.value = glow;
      renderer.setRenderTarget(target);
      this.quad.render(renderer);
    } finally {
      renderer.autoClear = autoClear;
    }
  }

  /** 重测时即时收起喷流并清空时钟。 */
  reset() {
    this.mesh.visible = false;
    this.uniforms.strength.value = this.uniforms.time.value = 0;
  }

  /** 释放体积缓冲、光谱纹理、代理网格和合成通道。 */
  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.blackbody.dispose();
    this.target.dispose();
    this.compositeMaterial.dispose();
    this.quad.dispose();
  }
}
