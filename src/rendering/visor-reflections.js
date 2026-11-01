import * as THREE from 'three';

// 每帧只捕获一个立方体面以限制开销；完整捕获后逐帧混合，避免面罩反射突然跳变。
export class LunarVisorReflections {
  /** 准备面罩局部捕获、双环境贴图与平滑混合着色器。 */
  constructor(
    renderer,
    scene,
    model,
    { exclude = [], resolution = 256, interval = 0.6, moveDistance = 0.02, far = 14500 } = {},
  ) {
    this.renderer = renderer;
    this.scene = scene;
    this.model = model;
    this.materials = new Set();
    model.traverse((object) => {
      if (!object.isMesh) return;
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        if (material.userData.lunarVisor || material.name === 'LunarVisor_GoldCoating') this.materials.add(material);
      }
    });
    this.head = model.getObjectByName('CC_Base_Head_038') || model.getObjectByName('head') || model;
    this.excluded = [...new Set([model, ...exclude])];
    this.interval = interval;
    this.moveDistanceSquared = moveDistance ** 2;
    this.elapsed = interval;
    this.dirty = true;
    this.face = -1;
    this.position = new THREE.Vector3();
    this.lastPosition = new THREE.Vector3(Infinity, Infinity, Infinity);
    this.uniforms = { previous: { value: null }, blend: { value: 1 } };
    this.disposed = false;
    if (!this.materials.size) return;
    this.target = new THREE.WebGLCubeRenderTarget(resolution, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
    });
    this.target.texture.name = 'Visor local scene capture (linear HDR)';
    this.cube = new THREE.CubeCamera(0.025, far, this.target);
    this.cube.coordinateSystem = renderer.coordinateSystem;
    this.cube.updateCoordinateSystem();
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.originalMaps = [...this.materials].map((material) => {
      const previous = {
        material,
        map: material.envMap,
        intensity: material.envMapIntensity,
        compile: material.onBeforeCompile,
        key: material.customProgramCacheKey,
      };
      const cacheKey = material.customProgramCacheKey();
      material.onBeforeCompile = (shader, renderer) => {
        previous.compile.call(material, shader, renderer);
        shader.uniforms.uLunarPreviousReflection = this.uniforms.previous;
        shader.uniforms.uLunarReflectionBlend = this.uniforms.blend;
        // 两张预过滤环境贴图布局一致，过渡期只在面罩增加一次采样，无需额外全屏通道。
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <envmap_physical_pars_fragment>',
          `
          uniform sampler2D uLunarPreviousReflection;
          uniform float uLunarReflectionBlend;
          #if defined(USE_ENVMAP) && defined(ENVMAP_TYPE_CUBE_UV)
          vec4 sampleLunarVisorReflection(const in vec3 direction, const in float roughness) {
            vec4 current = textureCubeUV(envMap, direction, roughness);
            if(uLunarReflectionBlend >= 1.0) return current;
            return mix(textureCubeUV(uLunarPreviousReflection, direction, roughness), current, uLunarReflectionBlend);
          }
          #endif
          ${THREE.ShaderChunk.envmap_physical_pars_fragment.replaceAll('textureCubeUV( envMap,', 'sampleLunarVisorReflection(')}
        `,
        );
      };
      material.customProgramCacheKey = () => cacheKey + '|lunar-visor-temporal';
      material.needsUpdate = true;
      return previous;
    });
  }

  /** 标记反射待刷新，必要时丢弃尚未完成的六面捕获。 */
  invalidate(abortCapture = false) {
    this.dirty = true;
    if (abortCapture) this.face = -1;
  }

  /** 逐帧捕获一个面，完整后发布并混合到新反射。 */
  update(delta = 0) {
    if (!this.target || this.disposed) return false;
    // 五个显示帧内完成混合，早于下一组六面捕获发布，帧率改变时仍能保持连续。
    this.uniforms.blend.value = Math.min(1, this.uniforms.blend.value + 1 / 5);
    this.elapsed += Math.max(0, delta);
    this.head.getWorldPosition(this.position);
    if (this.face === -1) {
      if (
        !this.dirty &&
        this.elapsed < this.interval &&
        this.position.distanceToSquared(this.lastPosition) < this.moveDistanceSquared
      )
        return false;
      this.cube.position.copy(this.position);
      this.cube.updateMatrixWorld(true);
      this.face = 0;
      this.dirty = false;
    }
    // 传送或浮动原点切换后，丢弃所有未完成的立方体面。
    if (this.position.distanceToSquared(this.cube.position) > 64 ** 2) {
      this.cube.position.copy(this.position);
      this.cube.updateMatrixWorld(true);
      this.face = 0;
    }
    const renderer = this.renderer;
    const previous = {
      target: renderer.getRenderTarget(),
      face: renderer.getActiveCubeFace(),
      mip: renderer.getActiveMipmapLevel(),
      xr: renderer.xr.enabled,
      shadowAuto: renderer.shadowMap.autoUpdate,
      toneMapping: renderer.toneMapping,
      visibility: this.excluded.map((object) => object.visible),
    };
    try {
      for (const object of this.excluded) object.visible = false;
      renderer.xr.enabled = false;
      // 反射捕获复用主相机的太阳级联阴影，避免重复生成阴影或改变覆盖范围。
      renderer.shadowMap.autoUpdate = false;
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.setRenderTarget(this.target, this.face, 0);
      renderer.render(this.scene, this.cube.children[this.face]);
      this.face++;
      if (this.face === 6) {
        const next = this.pmrem.fromCubemap(this.target.texture, this.previousFiltered || null);
        this.previousFiltered = this.filtered;
        this.filtered = next;
        this.filtered.texture.name = 'Visor filtered local reflection';
        this.uniforms.previous.value = (this.previousFiltered || this.filtered).texture;
        this.uniforms.blend.value = this.previousFiltered ? 0 : 1;
        for (const material of this.materials) {
          if (material.envMap !== this.filtered.texture) {
            material.envMap = this.filtered.texture;
            material.envMapIntensity = 1;
            material.needsUpdate = true;
          }
        }
        this.lastPosition.copy(this.cube.position);
        this.elapsed = 0;
        this.face = -1;
      }
    } catch (error) {
      this.face = -1;
      this.dirty = true;
      throw error;
    } finally {
      this.excluded.forEach((object, index) => {
        object.visible = previous.visibility[index];
      });
      renderer.xr.enabled = previous.xr;
      renderer.shadowMap.autoUpdate = previous.shadowAuto;
      renderer.toneMapping = previous.toneMapping;
      renderer.setRenderTarget(previous.target, previous.face, previous.mip);
    }
    return true;
  }

  /** 恢复面罩原始材质钩子，并释放捕获与预过滤资源。 */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const { material, map, intensity, compile, key } of this.originalMaps || []) {
      material.envMap = map;
      material.envMapIntensity = intensity;
      material.onBeforeCompile = compile;
      material.customProgramCacheKey = key;
      material.needsUpdate = true;
    }
    this.target?.dispose();
    this.filtered?.dispose();
    this.previousFiltered?.dispose();
    this.pmrem?.dispose();
  }
}
