import * as THREE from 'three';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

const SOURCE_LAYER = 29;
const ROVER_GLINTS = new Set(['Kameralinse', 'Antenne']);
/** 判断材质是否属于宇航员金色面罩。 */
const isVisor = (material) => material.userData.lunarVisor || material.name === 'LunarVisor_GoldCoating';

// 场景只渲染一次 HDR，再以低分辨率提取太阳、面罩及车辆高光；复用场景深度完成遮挡。
export class LunarBloom {
  /** 初始化辉光来源、HDR 缓冲和低分辨率合成通道。 */
  constructor(renderer, scene, camera, { sun, halo, model } = {}) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.settings = {
      enabled: true,
      sunStrength: 0.3,
      visorStrength: 0.02,
      roverStrength: 0.06,
      threshold: 1.2,
      radius: 0.25,
      resolutionScale: 0.5,
    };
    this.stats = { sourceDraws: 0, cpuMs: 0 };
    this.disposed = false;
    this.uniforms = {
      stage: { value: 0 },
      depth: { value: null },
      size: { value: new THREE.Vector2() },
      threshold: { value: this.settings.threshold },
      sun: { value: this.settings.sunStrength },
      visor: { value: this.settings.visorStrength },
      rover: { value: this.settings.roverStrength },
    };
    this.patchedMaterials = new Map();
    this.layerMasks = new Map();
    this.size = new THREE.Vector2();
    this.sceneTarget = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      samples: Math.min(2, renderer.capabilities.maxSamples),
      depthTexture: new THREE.DepthTexture(1, 1, THREE.UnsignedIntType),
    });
    this.sceneTarget.texture.name = 'Lunar HDR scene';
    this.sourceTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
    this.sourceTarget.texture.name = 'Sun and visor bloom sources';
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 1, this.settings.radius, 0);
    this.outputMaterial = new THREE.ShaderMaterial({
      name: 'Lunar HDR and selective bloom output',
      uniforms: { sceneColor: { value: this.sceneTarget.texture }, bloomColor: { value: null }, bloomEnabled: { value: 1 } },
      vertexShader: 'varying vec2 vUv; void main(){vUv=uv;gl_Position=vec4(position.xy,0.0,1.0);}',
      fragmentShader: `varying vec2 vUv; uniform sampler2D sceneColor; uniform sampler2D bloomColor; uniform float bloomEnabled;
        void main(){gl_FragColor=vec4(texture2D(sceneColor,vUv).rgb+texture2D(bloomColor,vUv).rgb*bloomEnabled,1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        }`,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
    this.output = new FullScreenQuad(this.outputMaterial);
    this.sun = sun;
    this.halo = halo;
    if (sun) {
      this.originalSunColor = sun.material.color.clone();
      this.addSource(sun, 'sun');
    }
    if (halo) this.originalHaloOpacity = halo.material.opacity;
    model?.traverse((object) => {
      if (!object.isMesh) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      if (materials.some(isVisor)) this.addSource(object, 'visor');
    });
    scene.traverse((object) => {
      if (object.isLight) this.addLayer(object);
    });
    this.setSize();
    this.configure({ enabled: true });
  }

  /** 体积喷流复用主场景深度，只在发动机点火后增加专用绘制。 */
  setPlume(plume) {
    this.plume = plume;
  }

  /** 起飞尘幕半分辨率 WBOIT，与喷流共用场景深度。 */
  setDustMedia(dust) {
    this.dustMedia = dust;
  }

  /** 记录对象原始图层，并加入辉光提取层。 */
  addLayer(object) {
    if (!this.layerMasks.has(object)) this.layerMasks.set(object, object.layers.mask);
    object.layers.enable(SOURCE_LAYER);
  }

  /** 为指定高光来源注入强度、深度遮挡和亮度提取逻辑。 */
  addSource(object, kind) {
    this.addLayer(object);
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (this.patchedMaterials.has(material)) continue;
      const previous = { compile: material.onBeforeCompile, key: material.customProgramCacheKey };
      const cacheKey = material.customProgramCacheKey();
      const gain =
        kind === 'sun'
          ? this.uniforms.sun
          : kind === 'rover' || kind === 'film' || kind === 'lander-film' || kind === 'fender'
            ? this.uniforms.rover
            : isVisor(material)
              ? this.uniforms.visor
              : { value: 0 };
      const linearSource = kind === 'film' || kind === 'lander-film' || kind === 'fender';
      const filmLike = kind === 'film' || kind === 'lander-film';
      this.patchedMaterials.set(material, previous);
      material.onBeforeCompile = (shader, renderer) => {
        previous.compile.call(material, shader, renderer);
        Object.assign(shader.uniforms, {
          uLunarBloomStage: this.uniforms.stage,
          uLunarSceneDepth: this.uniforms.depth,
          uLunarSourceSize: this.uniforms.size,
          uLunarBloomThreshold: this.uniforms.threshold,
          uLunarBloomGain: gain,
        });
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <common>',
          `#include <common>
          uniform float uLunarBloomStage; uniform sampler2D uLunarSceneDepth; uniform vec2 uLunarSourceSize;
          uniform float uLunarBloomThreshold; uniform float uLunarBloomGain;
          ${linearSource ? 'vec3 lunarBloomLinear;' : ''}`,
        );
        if (linearSource)
          shader.fragmentShader = shader.fragmentShader.replace(
            '#include <tonemapping_fragment>',
            `lunarBloomLinear=gl_FragColor.rgb;
          #include <tonemapping_fragment>`,
          );
        const end = shader.fragmentShader.lastIndexOf('}');
        // 登月舱为整面金箔无贴图。
        const filmMask =
          kind === 'film'
            ? `float yellowness=smoothstep(0.05,0.16,diffuseColor.r-diffuseColor.b);
            float warmth=smoothstep(0.10,0.22,diffuseColor.r)*smoothstep(0.08,0.18,diffuseColor.g);
            float film=yellowness*warmth*(1.0-smoothstep(0.08,0.20,diffuseColor.b));
            highlight=smoothstep(0.04,0.22,brightness)*film;
            lunarBloomColor=mix(lunarBloomColor,diffuseColor.rgb,film);
            float lunarBloomLift=12.0;`
            : kind === 'lander-film'
              ? `float yellowness=smoothstep(0.04,0.14,diffuseColor.r-diffuseColor.b);
            float warmth=smoothstep(0.08,0.2,diffuseColor.r)*smoothstep(0.06,0.16,diffuseColor.g);
            float film=yellowness*warmth*(1.0-smoothstep(0.08,0.22,diffuseColor.b));
            // 折面高光阈值略降、lift 略抬，找回金箔微辉且不整舱洗白。
            highlight=smoothstep(0.18,0.55,brightness)*max(film,0.35);
            lunarBloomColor=mix(lunarBloomColor,diffuseColor.rgb,film*0.55);
            float lunarBloomLift=3.2;`
            : kind === 'fender'
              ? 'float lunarBloomLift=5.0;'
              : 'float lunarBloomLift=1.0;';
        shader.fragmentShader =
          shader.fragmentShader.slice(0, end) +
          `
          if(uLunarBloomStage>0.5){
            float sceneDepth=texture2D(uLunarSceneDepth,gl_FragCoord.xy/uLunarSourceSize).r;
            float depthTolerance=max(0.0000002,0.75*fwidth(gl_FragCoord.z));
            if(gl_FragCoord.z>sceneDepth+depthTolerance)discard;
            vec3 lunarBloomColor=${linearSource ? 'lunarBloomLinear' : 'gl_FragColor.rgb'};
            float brightness=luminance(lunarBloomColor);
            float highlight=smoothstep(${filmLike ? (kind === 'lander-film' ? '0.32' : '0.04') : linearSource ? '0.42' : 'uLunarBloomThreshold'},${filmLike ? (kind === 'lander-film' ? '0.72' : '0.22') : linearSource ? '1.05' : 'uLunarBloomThreshold+0.4'},brightness);
            ${filmMask}
            gl_FragColor=vec4(lunarBloomColor*highlight*uLunarBloomGain*lunarBloomLift,1.0);
          }
        ` +
          shader.fragmentShader.slice(end);
      };
      material.customProgramCacheKey = () => `${cacheKey}|lunar-selective-bloom-${kind}`;
      material.needsUpdate = true;
    }
  }

  /** 只将车辆的隔热膜、挡泥板、镜头和天线加入辉光来源。 */
  addRover(root) {
    root?.traverse((object) => {
      if (!object.isMesh) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      if (materials.some((material) => material.userData.lunarThermalFilm)) this.addSource(object, 'film');
      else if (materials.some((material) => material.name === 'Fenders')) this.addSource(object, 'fender');
      else if (materials.some((material) => ROVER_GLINTS.has(material.name))) this.addSource(object, 'rover');
    });
  }

  /** 登月舱金箔用弱化 film 辉光，避免整面 Kapton 被洗白。 */
  addLander(root) {
    root?.traverse((object) => {
      if (!object.isMesh) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      if (materials.some((material) => material.userData.lunarThermalFilm)) this.addSource(object, 'lander-film');
    });
  }

  /** 限制可调参数范围，并同步太阳亮度、光晕和渲染分辨率。 */
  configure(values) {
    const limits = {
      sunStrength: [0, 1],
      visorStrength: [0, 0.4],
      roverStrength: [0, 0.4],
      threshold: [0.5, 4],
      radius: [0, 1],
      resolutionScale: [0.25, 0.5],
    };
    for (const [key, value] of Object.entries(values)) {
      if (key === 'enabled') {
        this.settings.enabled = !!value;
        continue;
      }
      if (!limits[key] || !Number.isFinite(value)) continue;
      this.settings[key] = THREE.MathUtils.clamp(value, ...limits[key]);
    }
    this.uniforms.sun.value = this.settings.sunStrength;
    this.uniforms.visor.value = this.settings.visorStrength;
    this.uniforms.rover.value = this.settings.roverStrength;
    this.uniforms.threshold.value = this.settings.threshold;
    this.bloom.radius = this.settings.radius;
    if (this.sun) this.sun.material.color.copy(this.originalSunColor).multiplyScalar(this.settings.enabled ? 6 : 1);
    if (this.halo) this.halo.material.opacity = this.settings.enabled ? 0.12 : this.originalHaloOpacity;
    if ('resolutionScale' in values) this.setSize();
  }

  /** 按绘图缓冲尺寸调整场景、光源和模糊目标。 */
  setSize() {
    this.renderer.getDrawingBufferSize(this.size);
    const width = Math.max(1, this.size.x),
      height = Math.max(1, this.size.y);
    this.sceneTarget.setSize(width, height);
    const w = Math.max(1, Math.round(width * this.settings.resolutionScale)),
      h = Math.max(1, Math.round(height * this.settings.resolutionScale));
    this.sourceTarget.setSize(w, h);
    this.uniforms.size.value.set(w, h);
    this.bloom.setSize(w, h);
  }

  /** 绘制场景与选择性辉光，结束或失败时恢复渲染状态。 */
  render(delta = 0) {
    if (this.disposed) return;
    const renderer = this.renderer,
      scene = this.scene,
      camera = this.camera;
    const previous = {
      target: renderer.getRenderTarget(),
      face: renderer.getActiveCubeFace(),
      mip: renderer.getActiveMipmapLevel(),
      layers: camera.layers.mask,
      background: scene.background,
      clearColor: renderer.getClearColor(new THREE.Color()),
      clearAlpha: renderer.getClearAlpha(),
      autoClear: renderer.autoClear,
      shadowAuto: renderer.shadowMap.autoUpdate,
    };
    let begin;
    try {
      renderer.autoClear = true;
      this.stats.sourceDraws = 0;
      const hasPlume = this.plume?.mesh.visible;
      const hasDust = this.dustMedia?.mesh?.visible;
      this.outputMaterial.uniforms.bloomEnabled.value = this.settings.enabled ? 1 : 0;
      if (!this.settings.enabled && !hasPlume && !hasDust) {
        // 关闭辉光时直接渲染到屏幕，跳过 HDR 缓冲、光源提取、模糊和全屏合成。
        this.stats.cpuMs = 0;
        renderer.setRenderTarget(null);
        renderer.render(scene, camera);
        return;
      }
      renderer.setRenderTarget(this.sceneTarget);
      renderer.render(scene, camera);
      begin = performance.now();
      if (hasPlume) this.plume.render(renderer, camera, this.sceneTarget);
      if (hasDust) this.dustMedia.render(renderer, camera, this.sceneTarget);
      if (!this.settings.enabled) {
        renderer.setRenderTarget(null);
        this.output.render(renderer);
        this.stats.cpuMs = performance.now() - begin;
        return;
      }
      this.uniforms.stage.value = 1;
      this.uniforms.depth.value = this.sceneTarget.depthTexture;
      camera.layers.set(SOURCE_LAYER);
      scene.background = null;
      renderer.setClearColor(0x000000, 0);
      renderer.shadowMap.autoUpdate = false;
      renderer.setRenderTarget(this.sourceTarget);
      renderer.render(scene, camera);
      const sourceDraws = renderer.info.render.calls;
      if (hasPlume) this.plume.composite(renderer, this.sourceTarget, true);
      this.stats.sourceDraws = sourceDraws + (hasPlume ? renderer.info.render.calls : 0);
      this.uniforms.stage.value = 0;
      this.uniforms.depth.value = null;
      camera.layers.mask = previous.layers;
      scene.background = previous.background;
      this.bloom.render(renderer, null, this.sourceTarget, delta, false);
      this.outputMaterial.uniforms.bloomColor.value = this.bloom.renderTargetsHorizontal[0].texture;
      renderer.setClearColor(previous.clearColor, previous.clearAlpha);
      renderer.setRenderTarget(null);
      this.output.render(renderer);
      this.stats.cpuMs = performance.now() - begin;
    } finally {
      // 始终解绑深度采样器，避免下一次场景渲染或面罩捕获产生纹理读写反馈。
      this.uniforms.stage.value = 0;
      this.uniforms.depth.value = null;
      camera.layers.mask = previous.layers;
      scene.background = previous.background;
      renderer.autoClear = previous.autoClear;
      renderer.shadowMap.autoUpdate = previous.shadowAuto;
      renderer.setClearColor(previous.clearColor, previous.clearAlpha);
      renderer.setRenderTarget(previous.target, previous.face, previous.mip);
    }
  }

  /** 恢复材质和图层，释放所有辉光资源。 */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const [material, previous] of this.patchedMaterials) {
      material.onBeforeCompile = previous.compile;
      material.customProgramCacheKey = previous.key;
      material.needsUpdate = true;
    }
    for (const [object, mask] of this.layerMasks) object.layers.mask = mask;
    if (this.sun) this.sun.material.color.copy(this.originalSunColor);
    if (this.halo) this.halo.material.opacity = this.originalHaloOpacity;
    this.sceneTarget.dispose();
    this.sourceTarget.dispose();
    this.bloom.dispose();
    this.outputMaterial.dispose();
    this.output.dispose();
  }
}
