import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { LunarBloom } from '../../src/rendering/bloom.js';
import { assignRoverMaterials } from '../../src/vehicle/rover.js';

/** 建立当前回归用例所需的场景与可观测接口。 */
function fixture(enabled = true) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x123456);
  const camera = new THREE.PerspectiveCamera(),
    light = new THREE.DirectionalLight();
  scene.add(light);
  const sun = new THREE.Mesh(new THREE.CircleGeometry(1), new THREE.MeshBasicMaterial({ color: 0xfffdf5 }));
  scene.add(sun);
  const halo = new THREE.Sprite(new THREE.SpriteMaterial());
  scene.add(halo);
  const model = new THREE.Group(),
    visorMaterial = new THREE.MeshPhysicalMaterial({ metalness: 1, roughness: 0.16 });
  visorMaterial.name = 'LunarVisor_GoldCoating';

  /** 模拟已有材质编译钩子，验证新功能不会覆盖它。 */
  const priorCompile = (shader) => {
    shader.uniforms.priorMarker = { value: 0.7 };
  };
  visorMaterial.onBeforeCompile = priorCompile;
  visorMaterial.customProgramCacheKey = () => 'prior-visor-hook';
  const visor = new THREE.Mesh(new THREE.SphereGeometry(0.2), visorMaterial);
  const suit = new THREE.Mesh(
    new THREE.BoxGeometry(),
    new THREE.MeshStandardMaterial({ emissive: 0xffffff, emissiveIntensity: 50 }),
  );
  model.add(visor, suit);
  scene.add(model);
  const calls = [],
    originalTarget = { name: 'prior target' },
    clearColor = new THREE.Color(0x456789);
  const renderer = {
    capabilities: { maxSamples: 4 },
    info: { render: { calls: 0 } },
    autoClear: false,
    shadowMap: { autoUpdate: true },
    toneMapping: THREE.ACESFilmicToneMapping,
    target: originalTarget,
    face: 2,
    mip: 1,
    alpha: 0.7,
    getDrawingBufferSize: (out) => out.set(1280, 720),

    /** 返回模拟渲染器当前目标。 */
    getRenderTarget() {
      return this.target;
    },

    /** 返回当前立方体面的测试状态。 */
    getActiveCubeFace() {
      return this.face;
    },

    /** 返回当前多级纹理层的测试状态。 */
    getActiveMipmapLevel() {
      return this.mip;
    },
    getClearColor: (out) => out.copy(clearColor),

    /** 返回模拟透明清屏值。 */
    getClearAlpha() {
      return this.alpha;
    },

    /** 记录清屏颜色与透明度变更。 */
    setClearColor(color, alpha) {
      clearColor.set(color);
      this.alpha = alpha;
    },

    /** 记录渲染目标及其附加状态。 */
    setRenderTarget(target, face = 0, mip = 0) {
      this.target = target;
      this.face = face;
      this.mip = mip;
    },

    /** 记录绘制行为，并按测试设置模拟渲染失败。 */
    render(object) {
      if (object === scene) {
        const source = bloom.uniforms.stage.value === 1;
        calls.push(source ? 'sources' : 'scene');
        assert.equal(bloom.uniforms.depth.value, source ? bloom.sceneTarget.depthTexture : null);
        assert.equal(this.target, source ? bloom.sourceTarget : (bloom.settings.enabled || bloom.plume?.mesh.visible) ? bloom.sceneTarget : null);
        assert.equal(this.shadowMap.autoUpdate, !source);
        if (source && this.fail) throw Error('模拟光源提取失败');
        this.info.render.calls = source ? 2 : 100;
      } else {
        calls.push('output');
        assert.equal(this.target, null);
        assert.equal(bloom.uniforms.stage.value, 0);
        assert.equal(bloom.uniforms.depth.value, null);
      }
    },
  };
  const bloom = new LunarBloom(renderer, scene, camera, { sun, halo, model });
  bloom.configure({ enabled });
  bloom.bloom.render = () => calls.push('blur');

  /** 检查渲染目标、图层与可见性是否完整恢复。 */
  const restored = () => {
    assert.equal(renderer.target, originalTarget);
    assert.equal(renderer.face, 2);
    assert.equal(renderer.mip, 1);
    assert.equal(camera.layers.mask, 1);
    assert.equal(scene.background.getHex(), 0x123456);
    assert.equal(clearColor.getHex(), 0x456789);
    assert.equal(renderer.alpha, 0.7);
    assert.equal(renderer.autoClear, false);
    assert.equal(renderer.shadowMap.autoUpdate, true);
    assert.equal(renderer.toneMapping, THREE.ACESFilmicToneMapping);
    assert.equal(bloom.uniforms.stage.value, 0);
    assert.equal(bloom.uniforms.depth.value, null);
  };
  return { bloom, scene, camera, sun, halo, visor, suit, light, renderer, calls, restored, priorCompile };
}

test('辉光只提取指定来源，并保留宇航服与已有着色器钩子', () => {
  const f = fixture(),
    { bloom, sun, visor, suit } = f,
    sourceCamera = new THREE.PerspectiveCamera();
  sourceCamera.layers.set(29);
  assert.ok(sourceCamera.layers.test(sun.layers) && sourceCamera.layers.test(visor.layers));
  assert.ok(!sourceCamera.layers.test(suit.layers));
  assert.equal(bloom.sceneTarget.texture.type, THREE.HalfFloatType);
  assert.ok(bloom.sceneTarget.depthTexture);
  assert.equal(bloom.sourceTarget.width, 640);
  assert.equal(bloom.sourceTarget.height, 360);
  for (const material of [sun.material, visor.material]) {
    const shader = {
      uniforms: {},
      fragmentShader: THREE.ShaderLib[material.isMeshPhysicalMaterial ? 'physical' : 'basic'].fragmentShader,
    };
    material.onBeforeCompile(shader, f.renderer);
    assert.equal(shader.uniforms.uLunarSceneDepth, bloom.uniforms.depth);
    assert.ok(shader.fragmentShader.includes('gl_FragCoord.z>sceneDepth+depthTolerance'));
    assert.ok(shader.fragmentShader.includes('smoothstep(uLunarBloomThreshold'));
    if (material.isMeshPhysicalMaterial) assert.equal(shader.uniforms.priorMarker.value, 0.7);
  }
  const originalColor = new THREE.Color(0xfffdf5);
  bloom.dispose();
  assert.ok(sun.material.color.equals(originalColor));
  assert.equal(f.halo.material.opacity, 1);
  assert.equal(sun.layers.mask, 1);
  assert.equal(visor.layers.mask, 1);
  assert.equal(f.light.layers.mask, 1);
  assert.equal(visor.material.onBeforeCompile, f.priorCompile);
  assert.equal(visor.material.customProgramCacheKey(), 'prior-visor-hook');
});

test('辉光默认开启，并可切换回直接渲染', () => {
  const f = fixture();
  assert.equal(f.bloom.settings.enabled, true);
  f.bloom.render();
  f.restored();
  assert.deepEqual(f.calls, ['scene', 'sources', 'blur', 'output']);
  assert.equal(f.bloom.stats.sourceDraws, 2);
  assert.equal(f.halo.material.opacity, 0.12);
  f.calls.length = 0;
  f.bloom.configure({ enabled: true });
  f.bloom.render();
  f.restored();
  assert.deepEqual(f.calls, ['scene', 'sources', 'blur', 'output']);
  assert.equal(f.bloom.stats.sourceDraws, 2);
  assert.equal(f.halo.material.opacity, 0.12);
  f.calls.length = 0;
  f.bloom.configure({ enabled: false, resolutionScale: 0.25 });
  f.bloom.render();
  f.restored();
  assert.deepEqual(f.calls, ['scene']);
  assert.equal(f.bloom.stats.sourceDraws, 0);
  assert.equal(f.bloom.stats.cpuMs, 0);
  assert.equal(f.bloom.sourceTarget.width, 320);
  assert.equal(f.bloom.sourceTarget.height, 180);
  assert.ok(f.sun.material.color.equals(new THREE.Color(0xfffdf5)));
  assert.equal(f.halo.material.opacity, 1);
  f.bloom.dispose();
});

test('车辆辉光仅覆盖镜头、天线、挡泥板和黄色隔热膜', () => {
  const f = fixture(false);
  const wheels = new THREE.MeshStandardMaterial({ name: 'Wheels' });
  const wheel = new THREE.Mesh(new THREE.CylinderGeometry(), wheels);
  wheel.name = 'Wheel_LF_Mesh';
  const fender = new THREE.Mesh(new THREE.BoxGeometry(), wheels);
  fender.name = 'Fender_LF_Mesh';
  const chassis = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ name: 'Chassis' }));
  const lens = new THREE.Mesh(new THREE.SphereGeometry(0.05), new THREE.MeshStandardMaterial({ name: 'Kameralinse' }));
  const antenna = new THREE.Mesh(new THREE.SphereGeometry(0.2), new THREE.MeshStandardMaterial({ name: 'Antenne' }));
  const rover = new THREE.Group();
  rover.add(wheel, fender, chassis, lens, antenna);
  assignRoverMaterials(rover);
  f.bloom.addRover(rover);
  const source = new THREE.PerspectiveCamera();
  source.layers.set(29);
  assert.ok([lens, antenna, fender, chassis].every((mesh) => source.layers.test(mesh.layers)));
  assert.ok(!source.layers.test(wheel.layers));
  f.bloom.configure({ roverStrength: 0.06 });

  /** 执行已有材质编译钩子并检查兼容性。 */
  const compile = (material) => {
    const shader = { uniforms: {}, fragmentShader: THREE.ShaderLib.standard.fragmentShader };
    material.onBeforeCompile(shader, f.renderer);
    return shader;
  };
  for (const material of [lens.material, antenna.material, fender.material, chassis.material]) {
    const shader = compile(material);
    assert.equal(shader.uniforms.uLunarBloomGain, f.bloom.uniforms.rover);
    assert.equal(shader.uniforms.uLunarBloomGain.value, 0.06);
  }
  const chassisShader = compile(chassis.material).fragmentShader;
  const fenderShader = compile(fender.material).fragmentShader;
  assert.ok(chassisShader.includes('lunarBloomLinear=gl_FragColor.rgb'));
  assert.ok(chassisShader.includes('highlight=smoothstep(0.04,0.22,brightness)*film'));
  assert.ok(fenderShader.includes('lunarBloomLinear=gl_FragColor.rgb'));
  assert.ok(!fenderShader.includes('highlight*=yellowness'));
  assert.ok(!f.bloom.patchedMaterials.has(wheel.material));
  f.bloom.dispose();
  assert.equal(fender.layers.mask, 1);
  assert.equal(chassis.layers.mask, 1);
});

test('登月舱金箔用弱化 lander-film 辉光，不影响月球车 film', () => {
  const f = fixture(false);
  const kapton = new THREE.Mesh(
    new THREE.BoxGeometry(),
    new THREE.MeshStandardMaterial({ name: 'blinn1SG', color: 0xe3c045 }),
  );
  kapton.material.userData.lunarThermalFilm = true;
  const alloy = new THREE.Mesh(
    new THREE.BoxGeometry(),
    new THREE.MeshStandardMaterial({ name: 'blinn4SG' }),
  );
  const lander = new THREE.Group();
  lander.add(kapton, alloy);
  f.bloom.addLander(lander);
  const source = new THREE.PerspectiveCamera();
  source.layers.set(29);
  assert.ok(source.layers.test(kapton.layers));
  assert.ok(!source.layers.test(alloy.layers));
  const shader = { uniforms: {}, fragmentShader: THREE.ShaderLib.standard.fragmentShader };
  kapton.material.onBeforeCompile(shader, f.renderer);
  assert.ok(shader.fragmentShader.includes('lunarBloomLift=3.2'));
  assert.ok(shader.fragmentShader.includes('smoothstep(0.18,0.55,brightness)'));
  assert.ok(!shader.fragmentShader.includes('lunarBloomLift=12.0'));
  f.bloom.dispose();
});

test('体积喷流在主场景之后绘制，关闭辉光仍可显示且探索时跳过', () => {
  const f = fixture();
  const plume = {
    mesh: { visible: true },
    render(renderer, camera, target) {
      assert.equal(target, f.bloom.sceneTarget);
      assert.equal(f.bloom.uniforms.depth.value, null);
      f.calls.push('plume');
    },
    composite(renderer, target, glow) {
      assert.equal(target, f.bloom.sourceTarget);
      assert.equal(glow, true);
      f.calls.push('plume-glow');
    },
  };
  f.bloom.setPlume(plume);
  f.bloom.render();
  f.restored();
  assert.deepEqual(f.calls, ['scene', 'plume', 'sources', 'plume-glow', 'blur', 'output']);
  f.calls.length = 0;
  f.bloom.configure({ enabled: false });
  f.bloom.render();
  f.restored();
  assert.equal(f.bloom.outputMaterial.uniforms.bloomEnabled.value, 0);
  assert.deepEqual(f.calls, ['scene', 'plume', 'output']);
  f.calls.length = 0;
  plume.mesh.visible = false;
  f.bloom.render();
  assert.deepEqual(f.calls, ['scene']);
  f.bloom.dispose();
});

test('辉光提取失败后恢复深度绑定与图层，允许后续渲染和反射捕获', () => {
  const f = fixture();
  f.renderer.fail = true;
  assert.throws(() => f.bloom.render(), /模拟光源提取失败/);
  f.restored();
  f.renderer.fail = false;
  f.calls.length = 0;
  f.bloom.render();
  f.restored();
  assert.deepEqual(f.calls, ['scene', 'sources', 'blur', 'output']);
  f.bloom.dispose();
  f.bloom.dispose();
});
