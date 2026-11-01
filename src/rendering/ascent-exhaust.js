import * as THREE from 'three';
import { LUNAR_GRAVITY } from '../game/ascent-profile.js';
import { RocketPlume } from './rocket-plume.js';
import {
  LunarDustMedia,
  DUST_CAPACITY,
  DUST_DEFAULT_COUNT,
} from './lunar-dust-media.js';

/** 以固定种子生成粒子属性，重试和不同帧率下的起飞效果一致。 */
function randomSource() {
  let seed = 9103;
  return () => {
    seed = Math.imul(seed, 1664525) + 1013904223 | 0;
    return (seed >>> 0) / 4294967296;
  };
}

export { DUST_CAPACITY, DUST_DEFAULT_COUNT };
export const EJECTA_CAPACITY = 5000;
export const FOIL_CAPACITY = 5000;
export const EJECTA_DEFAULT_COUNT = 500;
export const FOIL_DEFAULT_COUNT = 100;

/**
 * Apollo plume-surface：media 贴地尘幕 + 弹道碎屑 + 体积喷流。
 * 尘幕半分辨率 WBOIT；仅近地 sheet。
 */
export class AscentExhaust {
  /** 预建固定容量资源，探索时隐藏；起飞时不持续创建对象或纹理。 */
  constructor(ascent, nozzle, groundRoot, { nozzleRadius = 0.21 } = {}) {
    this.root = new THREE.Group();
    this.root.name = '起飞扬尘与碎屑';
    this.root.userData.excludeFromCollider = true;
    this.root.quaternion.copy(groundRoot.quaternion).invert();
    this.root.visible = false;
    groundRoot.add(this.root);
    const random = randomSource();
    this.capacity = {
      dust: DUST_CAPACITY,
      ejecta: EJECTA_CAPACITY,
      foil: FOIL_CAPACITY,
    };
    this.settings = {
      fadeRadius: 20,
      visibleUntil: 7,
      surfaceFalloff: 6.5,
      earlyDuration: 2.2,
      dustEnabled: true,
      dustCount: DUST_DEFAULT_COUNT,
      dustOpacity: 0.22,
      dustSizeScale: 1.5,
      dustSheetLife: 8,
      dustSheetDensity: 3.2,
      dustGroundPersist: 0.82,
      dustErosion: 0.55,
      dustStrengthScale: 1,
      ejectaEnabled: true,
      ejectaCount: EJECTA_DEFAULT_COUNT,
      ejectaOpacity: 0.48,
      ejectaSizeScale: 1,
      ejectaLife: 4.2,
      ejectaStrengthScale: 1,
      foilEnabled: true,
      foilCount: FOIL_DEFAULT_COUNT,
      foilSizeScale: 1,
      foilLife: 4.5,
    };

    this.dust = new LunarDustMedia(this.root, { capacity: DUST_CAPACITY });
    this.syncDustSettings();

    // —— 弹道碎屑 ——
    const ejectaCount = EJECTA_CAPACITY;
    const ejectaPos = new Float32Array(ejectaCount * 3);
    const ejectaVel = new Float32Array(ejectaCount * 3);
    const ejectaBirth = new Float32Array(ejectaCount);
    const ejectaSize = new Float32Array(ejectaCount);
    for (let i = 0; i < ejectaCount; i++) {
      const angle = random() * Math.PI * 2;
      const radius = 0.9 + random() * 1.3;
      const speed = 7.5 + random() * 18;
      ejectaPos.set([Math.cos(angle) * radius, 0.1 + random() * 0.18, Math.sin(angle) * radius], i * 3);
      ejectaVel.set([Math.cos(angle) * speed, 1.5 + random() * 8.25, Math.sin(angle) * speed], i * 3);
      ejectaBirth[i] = random() * 0.7;
      ejectaSize[i] = 0.018 + random() * 0.07;
    }
    const ejectaGeometry = new THREE.BufferGeometry();
    ejectaGeometry.setAttribute('position', new THREE.BufferAttribute(ejectaPos, 3));
    ejectaGeometry.setAttribute('velocity', new THREE.BufferAttribute(ejectaVel, 3));
    ejectaGeometry.setAttribute('birth', new THREE.BufferAttribute(ejectaBirth, 1));
    ejectaGeometry.setAttribute('size', new THREE.BufferAttribute(ejectaSize, 1));
    const ejectaMaterial = new THREE.ShaderMaterial({
      name: '弹道扬尘碎屑',
      uniforms: {
        time: { value: -1 },
        residual: { value: 1 },
        fadeRadius: { value: this.settings.fadeRadius },
        pixelScale: { value: 650 },
        opacity: { value: this.settings.ejectaOpacity },
        sizeScale: { value: this.settings.ejectaSizeScale },
        life: { value: this.settings.ejectaLife },
      },
      vertexShader: `attribute vec3 velocity; attribute float birth; attribute float size;
        uniform float time; uniform float residual; uniform float fadeRadius; uniform float pixelScale;
        uniform float sizeScale; uniform float life;
        varying float visibility;
        void main(){
          float age=max(0.0,time-birth);
          vec3 p=position+velocity*age;
          p.y-=${LUNAR_GRAVITY * 0.5}*age*age;
          float radial=length(p.xz);
          float near=1.0-smoothstep(fadeRadius*0.45,fadeRadius,radial);
          float fadeStart=max(life*0.45,0.2);
          float alive=1.0-smoothstep(fadeStart,max(life,fadeStart+0.05),age);
          visibility=step(birth,time)*step(0.0,p.y)*alive*residual*near;
          vec4 mv=modelViewMatrix*vec4(p,1.0);
          gl_Position=projectionMatrix*mv;
          gl_PointSize=clamp(size*sizeScale*pixelScale/max(0.1,-mv.z),1.0,24.0)*step(0.01,visibility);
        }`,
      fragmentShader: `varying float visibility;
        uniform float opacity;
        void main(){
          float radius=length(gl_PointCoord-0.5)*2.0;
          float alpha=(1.0-smoothstep(0.12,1.0,radius))*visibility*opacity;
          if(alpha<0.002)discard;
          gl_FragColor=vec4(vec3(0.52,0.50,0.46),alpha);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent: true,
      depthWrite: false,
    });
    this.ejecta = new THREE.Points(ejectaGeometry, ejectaMaterial);
    this.ejecta.name = '弹道碎屑';
    this.ejecta.frustumCulled = false;
    this.root.add(this.ejecta);

    const viewport = new THREE.Vector4();
    this.ejecta.onBeforeRender = (renderer, scene, camera) => {
      renderer.getCurrentViewport(viewport);
      ejectaMaterial.uniforms.pixelScale.value = viewport.w * 0.5 * Math.abs(camera.projectionMatrix.elements[5]);
    };

    this.foil = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshStandardMaterial({
        color: 0xb39b62, metalness: 0.6, roughness: 0.65, side: THREE.DoubleSide,
      }),
      FOIL_CAPACITY,
    );
    this.foil.frustumCulled = false;
    this.root.add(this.foil);
    this.pieces = Array.from({ length: this.foil.count }, () => {
      const angle = random() * Math.PI * 2;
      const speed = 9 + random() * 16.5;
      return {
        x: Math.cos(angle) * 1.1,
        z: Math.sin(angle) * 1.1,
        vx: Math.cos(angle) * speed,
        vz: Math.sin(angle) * speed,
        vy: 2.25 + random() * 8.25,
        birth: random() * 0.4,
        size: 0.035 + random() * 0.06,
        spin: 4 + random() * 9,
      };
    });
    this.dummy = new THREE.Object3D();

    this.plume = new RocketPlume({ nozzleRadius, reach: nozzleRadius * 26 });
    this.jet = this.plume.mesh;
    this.jet.position.copy(nozzle);
    ascent.add(this.jet);

    this.flash = new THREE.Mesh(
      new THREE.SphereGeometry(0.22, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0xffd7b1, transparent: true, opacity: 0, depthWrite: false }),
    );
    this.flash.position.copy(nozzle);
    this.flash.userData.excludeFromCollider = true;
    ascent.add(this.flash);

    Object.defineProperty(this, 'fadeRadius', {
      get: () => this.settings.fadeRadius,
      set: (value) => { this.settings.fadeRadius = value; },
    });
    this.applyCounts();
  }

  /** 把任务 settings 映射到 LunarDustMedia。 */
  syncDustSettings() {
    const s = this.settings;
    this.dust.configure({
      enabled: s.dustEnabled,
      count: s.dustCount,
      opacity: s.dustOpacity,
      sizeScale: s.dustSizeScale,
      sheetLife: s.dustSheetLife,
      sheetDensity: s.dustSheetDensity,
      groundPersist: s.dustGroundPersist,
      fadeRadius: s.fadeRadius,
      strengthScale: s.dustStrengthScale,
      erosion: s.dustErosion,
      visibleUntil: s.visibleUntil,
    });
  }

  /** 按设置截取可见粒子数量。 */
  applyCounts() {
    const dustCount = THREE.MathUtils.clamp(Math.round(this.settings.dustCount), 0, this.capacity.dust);
    const ejectaCount = THREE.MathUtils.clamp(Math.round(this.settings.ejectaCount), 0, this.capacity.ejecta);
    const foilCount = THREE.MathUtils.clamp(Math.round(this.settings.foilCount), 0, this.capacity.foil);
    this.settings.dustCount = dustCount;
    this.settings.ejectaCount = ejectaCount;
    this.settings.foilCount = foilCount;
    this.dust.configure({ count: dustCount });
    this.ejecta.geometry.setDrawRange(0, ejectaCount);
    this.foil.count = foilCount;
  }

  /** 同步 GUI 写入的尘幕 / 碎屑参数。 */
  configure(values = {}) {
    Object.assign(this.settings, values);
    this.syncDustSettings();
    const {
      fadeRadius, ejectaOpacity, ejectaSizeScale, ejectaLife, ejectaEnabled, foilEnabled,
    } = this.settings;
    const ejecta = this.ejecta.material.uniforms;
    ejecta.fadeRadius.value = fadeRadius;
    ejecta.opacity.value = ejectaOpacity;
    ejecta.sizeScale.value = ejectaSizeScale;
    ejecta.life.value = ejectaLife;
    this.ejecta.visible = ejectaEnabled;
    this.foil.visible = foilEnabled;
    this.applyCounts();
  }

  /** 近地喷流耦合：喷流随高度衰减；尘幕舱底残存与高度脱钩，只随时间/熄火淡出。 */
  samplePlume(profile) {
    const { powered, flightTime, height } = profile;
    const falloff = Math.max(0.5, this.settings.surfaceFalloff);
    const earlyEnd = Math.max(0.2, this.settings.earlyDuration);
    const nearSurface = Math.exp(-height / falloff);
    const early = 1 - THREE.MathUtils.smoothstep(flightTime, 0.1, earlyEnd);
    const strength = powered ? nearSurface * Math.max(early, 0.2) : 0;
    // 飞石/箔片仍跟高度；尘幕用 dustResidual，抬升时舱底不跟着变疏。
    const residual = powered
      ? THREE.MathUtils.clamp(0.45 + nearSurface * 0.7, 0.35, 1)
      : Math.max(0, 1 - Math.max(0, flightTime - earlyEnd) / 6.0);
    const dustResidual = powered
      ? THREE.MathUtils.clamp(0.92 - flightTime * 0.015, 0.78, 1)
      : Math.max(0, 1 - Math.max(0, flightTime - earlyEnd) / 6.0);
    return {
      strength,
      residual: Math.max(strength * 0.35, residual),
      dustResidual: Math.max(dustResidual, strength),
    };
  }

  /** 在加载阶段编译起飞所需着色器。 */
  async prepare(renderer, camera, scene) {
    const preview = new THREE.Scene();
    for (const object of [this.ejecta, this.foil, this.jet, this.flash]) {
      const copy = object.clone();
      copy.visible = true;
      copy.layers.set(0);
      preview.add(copy);
    }
    try {
      await renderer.compileAsync(preview, camera, scene);
      await this.dust.prepare(renderer, camera, scene);
      await this.plume.prepare(renderer, camera, scene);
    } finally {
      preview.traverse((object) => {
        if (object.isInstancedMesh) object.dispose();
      });
      preview.clear();
    }
  }

  /** 按绝对过场时间重算。 */
  update(profile) {
    const { flightTime, flash } = profile;
    const { strength, residual, dustResidual } = this.samplePlume(profile);
    const {
      fadeRadius, visibleUntil, ejectaEnabled, ejectaStrengthScale,
      foilEnabled, foilSizeScale, foilLife,
    } = this.settings;
    const active = strength > 0.01 || residual > 0.02 || dustResidual > 0.02;
    this.root.visible = active && flightTime < visibleUntil;
    this.ejecta.visible = ejectaEnabled;
    this.foil.visible = foilEnabled;

    this.dust.update(profile, { strength, residual: dustResidual });
    this.ejecta.material.uniforms.time.value = flightTime;
    this.ejecta.material.uniforms.residual.value = residual * ejectaStrengthScale;
    this.ejecta.material.uniforms.fadeRadius.value = fadeRadius;

    this.plume.update(profile);

    this.flash.visible = flash > 0;
    this.flash.material.opacity = flash * 0.4;
    this.flash.scale.setScalar(1 + (1 - flash) * 1.6);

    if (!this.root.visible) return;
    const fade = fadeRadius;
    const foilDraw = Math.min(this.foil.count, this.pieces.length);
    for (let index = 0; index < foilDraw; index++) {
      const piece = this.pieces[index];
      const age = Math.max(0, flightTime - piece.birth);
      const x = piece.x + piece.vx * age;
      const z = piece.z + piece.vz * age;
      const y = 0.15 + piece.vy * age - LUNAR_GRAVITY * 0.5 * age * age;
      const radial = Math.hypot(x, z);
      const near = 1 - THREE.MathUtils.smoothstep(fade * 0.45, fade, radial);
      const visible = foilEnabled && residual > 0.05 && flightTime >= piece.birth && y > 0 && age < foilLife && near > 0.02;
      this.dummy.position.set(x, Math.max(0.05, y), z);
      this.dummy.rotation.set(age * piece.spin, index + age * 2, age * piece.spin * 0.7);
      this.dummy.scale.setScalar(visible ? piece.size * foilSizeScale * residual * near : 0);
      this.dummy.updateMatrix();
      this.foil.setMatrixAt(index, this.dummy.matrix);
    }
    this.foil.instanceMatrix.needsUpdate = true;
  }

  /** 重新开始时收起扬尘、碎屑与喷流。 */
  reset() {
    this.root.visible = false;
    this.plume.reset();
    this.dust.reset();
    this.ejecta.material.uniforms.time.value = 0;
    this.ejecta.material.uniforms.residual.value = 0;
    this.flash.visible = false;
    this.flash.material.opacity = 0;
    this.flash.scale.setScalar(1);
    this.dummy.scale.setScalar(0);
    this.dummy.updateMatrix();
    for (let index = 0; index < this.pieces.length; index++) {
      this.foil.setMatrixAt(index, this.dummy.matrix);
    }
    this.foil.instanceMatrix.needsUpdate = true;
  }

  /** 释放实例与半分辨率尘幕资源。 */
  dispose() {
    this.foil.dispose();
    this.dust.dispose();
    this.plume.dispose();
  }
}
