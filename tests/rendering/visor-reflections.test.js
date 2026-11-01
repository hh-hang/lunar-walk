import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { LunarVisorReflections } from '../../src/rendering/visor-reflections.js';

/** 建立当前回归用例所需的场景与可观测接口。 */
function fixture() {
  const scene = new THREE.Scene(),
    model = new THREE.Group(),
    head = new THREE.Bone();
  head.name = 'CC_Base_Head_038';
  head.position.y = 1.6;
  model.add(head);
  scene.add(model);
  const material = new THREE.MeshPhysicalMaterial({ metalness: 1, roughness: 0.16 });
  material.userData.lunarVisor = true;

  /** 模拟已有材质编译钩子，验证新功能不会覆盖它。 */
  const priorCompile = (shader) => {
    shader.uniforms.priorVisorMarker = { value: 0.7 };
  };
  material.onBeforeCompile = priorCompile;
  material.customProgramCacheKey = () => 'prior-visor-hook';
  model.add(new THREE.Mesh(new THREE.SphereGeometry(0.2, 8, 8), material));
  const halo = new THREE.Object3D(),
    alreadyHidden = new THREE.Object3D();
  alreadyHidden.visible = false;
  scene.add(halo, alreadyHidden);
  const originalTarget = { name: 'previous render target' },
    calls = [],
    publications = [];
  const renderer = {
    coordinateSystem: THREE.WebGLCoordinateSystem,
    target: originalTarget,
    face: 3,
    mip: 2,
    xr: { enabled: true },
    shadowMap: { autoUpdate: true },
    toneMapping: THREE.ACESFilmicToneMapping,

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

    /** 记录渲染目标及其附加状态。 */
    setRenderTarget(target, face = 0, mip = 0) {
      this.target = target;
      this.face = face;
      this.mip = mip;
    },

    /** 记录绘制行为，并按测试设置模拟渲染失败。 */
    render(_, camera) {
      assert.equal(model.visible, false, '角色不能出现在自己的反射捕获中');
      assert.equal(halo.visible, false, '太阳光晕不能重复产生直射高光');
      assert.equal(this.shadowMap.autoUpdate, false, '反射捕获应复用主视角太阳级联阴影');
      assert.equal(this.toneMapping, THREE.NoToneMapping, '反射捕获必须保留线性 HDR');
      assert.equal(this.xr.enabled, false);
      calls.push({
        face: this.face,
        position: camera.getWorldPosition(new THREE.Vector3()).toArray(),
        direction: camera.getWorldDirection(new THREE.Vector3()).toArray(),
      });
      if (this.fail) throw Error('模拟反射捕获失败');
    },
  };
  const capture = new LunarVisorReflections(renderer, scene, model, { exclude: [halo, alreadyHidden], interval: 0.6 });
  const filteredTargets = [0, 1].map(() => ({
    texture: new THREE.Texture(),

    /** 释放测试插件、碰撞句柄或临时渲染资源。 */
    dispose() {
      this.disposed = true;
    },
  }));
  const filtered = filteredTargets[0];
  capture.pmrem.fromCubemap = (texture, reuse) => {
    assert.equal(texture, capture.target.texture);
    const next = filteredTargets[publications.length % 2];
    assert.equal(reuse, publications.length < 2 ? null : next, '只能复用已完成旧过渡的目标');
    publications.push(calls.length);
    return next;
  };

  /** 检查渲染目标、图层与可见性是否完整恢复。 */
  function restored() {
    assert.equal(model.visible, true);
    assert.equal(halo.visible, true);
    assert.equal(alreadyHidden.visible, false);
    assert.equal(renderer.target, originalTarget);
    assert.equal(renderer.face, 3);
    assert.equal(renderer.mip, 2);
    assert.equal(renderer.xr.enabled, true);
    assert.equal(renderer.shadowMap.autoUpdate, true);
    assert.equal(renderer.toneMapping, THREE.ACESFilmicToneMapping);
  }
  return {
    scene,
    model,
    material,
    renderer,
    calls,
    publications,
    capture,
    filtered,
    filteredTargets,
    priorCompile,
    restored,
  };
}

test('面罩分六帧捕获世界方向，并只发布完整 HDR 反射', () => {
  const f = fixture();
  for (let i = 0; i < 6; i++) {
    assert.equal(f.capture.update(1 / 60), true);
    f.restored();
    assert.equal(f.calls.length, i + 1);
    if (i < 5) assert.equal(f.material.envMap, null);
  }
  assert.deepEqual(
    f.calls.map((c) => c.face),
    [0, 1, 2, 3, 4, 5],
  );
  assert.equal(new Set(f.calls.map((c) => c.direction.map((v) => Math.round(v)).join(','))).size, 6);
  assert.ok(f.calls.every((c) => Math.abs(c.position[1] - 1.6) < 1e-8));
  assert.deepEqual(f.publications, [6]);
  assert.equal(f.material.envMap, f.filtered.texture);
  assert.equal(f.capture.uniforms.blend.value, 1, '首次捕获不能采样未初始化的旧贴图');
  const shader = { uniforms: {}, fragmentShader: THREE.ShaderLib.physical.fragmentShader };
  f.material.onBeforeCompile(shader, f.renderer);
  assert.equal(shader.uniforms.priorVisorMarker.value, 0.7);
  assert.equal(shader.uniforms.uLunarPreviousReflection, f.capture.uniforms.previous);
  assert.equal(shader.uniforms.uLunarReflectionBlend, f.capture.uniforms.blend);
  assert.ok(shader.fragmentShader.includes('sampleLunarVisorReflection( envMapRotation * reflectVec, roughness )'));
  f.capture.dispose();
  assert.equal(f.material.envMap, null);
  assert.equal(f.filtered.disposed, true);
  assert.equal(f.material.onBeforeCompile, f.priorCompile);
  assert.equal(f.material.customProgramCacheKey(), 'prior-visor-hook');
  assert.equal(f.capture.update(1), false);
});

test('面罩在小位移后刷新，逐帧混合并复用两个完整反射目标', () => {
  const f = fixture();
  for (let i = 0; i < 6; i++) f.capture.update(1 / 60);
  assert.equal(f.capture.update(0.1), false);
  assert.equal(f.calls.length, 6);
  f.model.position.x = 0.03;
  assert.equal(f.capture.update(0.01), true);
  f.capture.invalidate(); // 捕获过程中的变化不能使当前周期一直无法完成。
  for (let i = 0; i < 5; i++) f.capture.update(0.01);
  assert.equal(f.publications.length, 2);
  assert.equal(f.material.envMap, f.filteredTargets[1].texture);
  assert.equal(f.capture.uniforms.previous.value, f.filtered.texture);
  assert.equal(f.capture.uniforms.blend.value, 0);
  for (let i = 1; i <= 5; i++) {
    assert.equal(f.capture.update(i % 2 ? 1 / 30 : 1 / 120), true);
    assert.ok(Math.abs(f.capture.uniforms.blend.value - i / 5) < 1e-8);
    assert.equal(f.publications.length, 2, '不能覆盖未完成捕获或仍在混合的目标');
  }
  assert.equal(f.capture.update(0.01), true);
  assert.equal(f.publications.length, 3);
  assert.equal(f.material.envMap, f.filtered.texture);
  assert.equal(f.capture.uniforms.previous.value, f.filteredTargets[1].texture);
  assert.equal(f.capture.uniforms.blend.value, 0);
  // 静止场景也必须在下一次刷新前完成反射混合。
  for (let i = 0; i < 5; i++) assert.equal(f.capture.update(0.01), false);
  assert.equal(f.capture.uniforms.blend.value, 1);
  f.capture.dispose();
  assert.ok(f.filteredTargets.every((target) => target.disposed));
});

test('面罩捕获失败后恢复渲染器与可见状态，并允许重试', () => {
  const f = fixture();
  f.renderer.fail = true;
  assert.throws(() => f.capture.update(0.01), /模拟反射捕获失败/);
  f.restored();
  assert.equal(f.material.envMap, null);
  assert.equal(f.publications.length, 0);
  f.renderer.fail = false;
  for (let i = 0; i < 6; i++) f.capture.update(0.01);
  assert.equal(f.material.envMap, f.filtered.texture);
  f.restored();
  f.capture.invalidate();
  f.renderer.fail = true;
  assert.throws(() => f.capture.update(0.01), /模拟反射捕获失败/);
  f.restored();
  assert.equal(f.material.envMap, f.filtered.texture, '刷新失败必须保留已发布反射');
  f.capture.dispose();
});

test('浮动原点切换后丢弃未完成的立方体面', () => {
  const f = fixture();
  f.capture.update(0.01);
  f.capture.update(0.01);
  f.model.position.x -= 3072;
  for (let i = 0; i < 5; i++) f.capture.update(0.01);
  assert.equal(f.material.envMap, null, '五个新面不足以发布混合了不同原点的立方体贴图');
  f.capture.update(0.01);
  assert.equal(f.material.envMap, f.filtered.texture);
  assert.deepEqual(
    f.calls.slice(2).map((c) => c.face),
    [0, 1, 2, 3, 4, 5],
  );
  assert.ok(f.calls.slice(2).every((c) => c.position[0] === -3072));
  f.restored();
  f.capture.dispose();
});
