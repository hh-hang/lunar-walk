import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { FootprintStore } from '../../src/rendering/footprint-store.js';
import { LunarRoverEffects } from '../../src/vehicle/rover-effects.js';
import { LunarRoverDust } from '../../src/vehicle/rover-dust.js';

/** 建立当前回归用例所需的场景与可观测接口。 */
function fixture() {
  const scene = new THREE.Scene(),
    group = new THREE.Group();
  scene.add(group);
  const wheels = [0, 1, 2, 3].map((i) => {
    const wrapper = new THREE.Group(),
      mesh = new THREE.Mesh(
        new THREE.CylinderGeometry(0.3, 0.3, 0.16, 12).rotateZ(Math.PI / 2),
        new THREE.MeshBasicMaterial(),
      );
    mesh.name = ['Wheel_LF', 'Wheel_RF', 'Wheel_LR', 'Wheel_RR'][i];
    wrapper.position.set(i % 2 ? 0.45 : -0.45, 0, i < 2 ? -0.7 : 0.7);
    wrapper.add(mesh);
    group.add(wrapper);
    return {
      isInContact: true,
      contactMesh: { userData: { surface: 'regolith' } },
      contactPoint: wrapper.position.clone(),
      contactNormal: new THREE.Vector3(0, 1, 0),
      axle: new THREE.Vector3(1, 0, 0),
      connectionPoint: wrapper.position.clone(),
      radius: 0.3,
      steering: 0,
    };
  });
  const velocity = new THREE.Vector3(0, 0, -1),
    vehicle = {
      scale: 0.4,
      vehicleGroup: group,
      forwardLocal: new THREE.Vector3(0, 0, -1),
      chassisBody: {
        position: group.position,
        quaternion: group.quaternion,
        linvel: () => velocity,
        angvel: () => new THREE.Vector3(),
      },
      vehicleController: {
        wheelAt: (i) => wheels[i],
        wheelAxleCs: (i) => wheels[i].axle,
        wheelSteering: (i) => wheels[i].steering,
      },
    };
  const store = new FootprintStore({ trackLimit: 100 }),
    atlas = {
      /** 记录车辙显示开关。 */
      setTracksEnabled() {},

      /** 记录胎纹强度设置。 */
      setTrackStrength() {},
      addTrack: (s) => store.addTrack(s),
      clear: (k) => store.clear(k),
    };
  const origin = { value: new THREE.Vector2() },
    effects = new LunarRoverEffects({ getAllVehicles: () => [vehicle] }, atlas, scene, { origin, random: () => 0.5 });

  /** 按指定模拟步长推进动画与插件，并更新矩阵。 */
  const step = (distance = -0.02, dt = 0.01) => {
    group.position.z += distance;
    wheels.forEach((w) => (w.contactPoint.z += distance));
    effects.update(dt);
  };
  return { effects, wheels, vehicle, store, origin, velocity, step };
}

test('四轮接触复用实际轮宽，支持倒车并在岩石或离地时停止且不跨空隙连线', () => {
  const f = fixture();
  for (let i = 0; i < 30; i++) f.step();
  assert.ok(f.store.records.size > 10);
  assert.ok(f.effects.dust.stats.active > 0);
  for (const record of f.store.records.values())
    assert.ok(Math.abs(Math.hypot(record.ax, record.az) * 2 - 0.16) < 1e-6);
  let count = f.effects.stats.stamps,
    emitted = f.effects.dust.stats.emitted;
  f.velocity.set(0, 0, 0);
  for (let i = 0; i < 50; i++) f.step(i % 2 ? 0.001 : -0.001);
  assert.equal(f.effects.stats.stamps, count);
  assert.equal(f.effects.dust.stats.emitted, emitted);
  f.velocity.z = 1;
  for (let i = 0; i < 20; i++) f.step(0.02);
  assert.ok(
    [...f.store.records.values()].some((r) => r.span < 0),
    '倒车时应反向累计胎纹相位',
  );
  f.wheels.forEach((w) => (w.contactMesh.userData.surface = 'rock'));
  count = f.effects.stats.stamps;
  emitted = f.effects.dust.stats.emitted;
  for (let i = 0; i < 20; i++) f.step(0.03);
  assert.equal(f.effects.stats.stamps, count);
  assert.equal(f.effects.dust.stats.emitted, emitted);
  f.wheels.forEach((w) => {
    w.contactMesh.userData.surface = 'regolith';
    w.isInContact = false;
  });
  for (let i = 0; i < 20; i++) f.step(0.03);
  f.wheels.forEach((w) => (w.isInContact = true));
  f.step(0.03);
  assert.equal(f.effects.stats.stamps, count, '落地应开始新车辙，不能跨过空中路段连线');
  f.step(0.05);
  assert.ok(f.effects.stats.stamps > count);
  count = f.effects.stats.stamps;
  f.step(50);
  assert.equal(f.effects.stats.stamps, count, '传送不能绘制长条车辙');
  f.effects.dispose();
});

test('换原点保留车辙绝对坐标，并平移现存尘粒而不跨世界连线', () => {
  const f = fixture();
  for (let i = 0; i < 25; i++) f.step();
  const records = [...f.store.records.values()].map((r) => [r.x, r.z]);
  const before = f.effects.dust.points.geometry.attributes.position.array.slice();
  f.effects.rebase(3072, -3072);
  f.origin.value.set(3072, -3072);
  const after = f.effects.dust.points.geometry.attributes.position.array;
  assert.ok(Math.abs(after[0] - (before[0] - 3072)) < 0.001);
  assert.ok(Math.abs(after[2] - (before[2] + 3072)) < 0.001);
  assert.deepEqual(
    [...f.store.records.values()].map((r) => [r.x, r.z]),
    records,
  );
  f.wheels.forEach((w) => {
    w.contactPoint.x -= 3072;
    w.contactPoint.z += 3072;
  });
  f.vehicle.vehicleGroup.position.x -= 3072;
  f.vehicle.vehicleGroup.position.z += 3072;
  const count = f.effects.stats.stamps;
  f.step();
  f.step();
  assert.equal(f.effects.stats.stamps, count);
  f.step(-0.06);
  assert.ok(f.effects.stats.stamps > count);
  for (const r of f.store.records.values()) assert.ok(Math.abs(r.x) < 2 && Math.abs(r.z) < 4);
  f.effects.dispose();
});

test('扬尘使用固定粒子池和模拟时间，停止后消散且禁用时无残留绘制', () => {
  const dust = new LunarRoverDust(new THREE.Scene(), { capacity: 16, random: () => 0.5 });
  const p = new THREE.Vector3(),
    n = new THREE.Vector3(0, 1, 0),
    d = new THREE.Vector3(0, 0, -1),
    s = new THREE.Vector3(1, 0, 0);
  const position = dust.points.geometry.attributes.position.array;
  for (let i = 0; i < 500; i++) dust.emit(p, n, d, s, d, 1);
  dust.update(0.1);
  assert.equal(dust.stats.active, 16);
  assert.equal(dust.stats.draws, 1);
  assert.equal(position, dust.points.geometry.attributes.position.array);
  assert.equal(dust.points.material.uniforms.time.value, 0.1);
  dust.update(0);
  assert.equal(dust.time, 0.1);
  dust.update(2);
  assert.equal(dust.stats.active, 0);
  assert.equal(dust.points.visible, false);
  dust.emit(p, n, d, s, d, 1);
  dust.update(0.01);
  dust.setEnabled(false);
  assert.equal(dust.stats.active, 0);
  assert.equal(dust.stats.draws, 0);
  dust.dispose();
});

test('扬尘适配当前视口与翻转后的立方体投影，保持点尺寸为正', () => {
  const scene = new THREE.Scene(),
    dust = new LunarRoverDust(scene),
    camera = new THREE.PerspectiveCamera(90, 1, 0.1, 100);
  const renderer = { getCurrentViewport: (target) => target.set(0, 0, 256, 256) };
  dust.points.onBeforeRender(renderer, scene, camera);
  assert.ok(Math.abs(dust.points.material.uniforms.pixelScale.value - 128) < 1e-6);
  camera.projectionMatrix.elements[5] *= -1;
  dust.points.onBeforeRender(renderer, scene, camera);
  assert.ok(Math.abs(dust.points.material.uniforms.pixelScale.value - 128) < 1e-6);
  dust.dispose();
});

test('扬尘预热主场景与反射着色器，失败时恢复渲染目标', async () => {
  const scene = new THREE.Scene(),
    dust = new LunarRoverDust(scene),
    main = { name: 'main' },
    reflection = { name: 'cube' },
    calls = [];
  const renderer = {
    target: main,

    /** 返回模拟渲染器当前目标。 */
    getRenderTarget() {
      return this.target;
    },
    getActiveCubeFace: () => 2,
    getActiveMipmapLevel: () => 1,

    /** 记录渲染目标及其附加状态。 */
    setRenderTarget(target, face, mip) {
      this.target = target;
      calls.push({ target, face, mip });
    },

    /** 模拟异步着色器编译，并按目标注入失败。 */
    async compileAsync(objects, camera, targetScene) {
      assert.equal(targetScene, scene);
      assert.equal(objects.children[0].material, dust.points.material);
      if (this.target === reflection) throw Error('模拟编译失败');
    },
  };
  await assert.rejects(dust.prepare(renderer, new THREE.PerspectiveCamera(), reflection), /模拟编译失败/);
  assert.deepEqual(calls, [
    { target: reflection, face: 0, mip: undefined },
    { target: main, face: 2, mip: 1 },
  ]);
  assert.equal(renderer.target, main);
  dust.dispose();
});
