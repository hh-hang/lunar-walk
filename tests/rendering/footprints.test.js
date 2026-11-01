import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { FootContactGate, LunarFootContacts } from '../../src/character/foot-contacts.js';
import { createAstronautPlayer } from '../helpers/astronaut-player.js';
import { FootprintStore, footprintTileKeys } from '../../src/rendering/footprint-store.js';
import { LunarFootprints } from '../../src/rendering/footprints.js';

/** 创建包含四角、支撑法线与中心的测试鞋底接触。 */
function contact(x, z, side = 'left') {
  return {
    side,
    point: new THREE.Vector3(x, 0, z),
    normal: new THREE.Vector3(0, 1, 0),
    corners: [
      [-0.04, -0.09],
      [0.04, -0.09],
      [-0.04, 0.09],
      [0.04, 0.09],
    ].map(([dx, dz]) => new THREE.Vector3(x + dx, 0, z + dz)),
  };
}

test('接触门控确认支撑且每次只盖印一次，忽略摆动期的 IK 修正', () => {
  const gate = new FootContactGate();
  assert.equal(gate.accept('left', false, true), false);
  assert.equal(gate.accept('left', true, false), false);
  assert.equal(gate.accept('left', true, true), false);
  assert.equal(gate.accept('left', true, true), true);
  for (let i = 0; i < 200; i++) assert.equal(gate.accept('left', true, true), false);
  gate.accept('left', false, false);
  assert.equal(gate.accept('left', true, true), false);
  assert.equal(gate.accept('left', true, true), true);
  gate.reset();
  assert.equal(gate.accept('left', true, true), false);
});

test('接触适配读取最终鞋底位置，排除岩石支撑并保存绝对坐标', () => {
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(4, 4).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
  );
  floor.userData.surface = 'regolith';
  floor.updateMatrixWorld(true);
  const rock = new THREE.Mesh(
    new THREE.BoxGeometry(0.3, 0.2, 0.4),
    new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
  );
  rock.userData.surface = 'rock';
  rock.position.set(-0.2, 0.1, 0);
  rock.updateMatrixWorld(true);

  /** 创建保留可变支撑标记的测试腿部状态。 */
  const makeLeg = (x) => {
    const foot = new THREE.Object3D();
    foot.position.set(x, 0.003, 0);
    return { planted: true, foot, soleSamples: contact(0, 0).corners.map((local) => ({ local })) };
  };
  const footIK = {
    enabled: true,
    maxFootRaise: 0.25,
    maxFootDrop: 0.25,
    legs: { left: makeLeg(-0.2), right: makeLeg(0.2) },
  };
  const contacts = [],
    origin = { value: new THREE.Vector2(3072, -3072) };
  const detector = new LunarFootContacts(footIK, (c) => contacts.push(c), { origin });
  const player = { playerIsOnGround: true, getColliderMeshes: () => [floor, rock], getControllerMode: () => 0 };
  detector.onAttach(player);
  detector.onAfterAnimationUpdate();
  detector.onAfterAnimationUpdate();
  assert.equal(contacts.length, 1, '鞋底低于岩石顶部时不能在下方月壤盖印');
  assert.ok(Math.abs(contacts[0].point.x - 3072.2) < 1e-8);
  assert.equal(contacts[0].point.z, -3072);
  footIK.legs.left.foot.position.y = 0.2;
  detector.onAfterAnimationUpdate();
  detector.onAfterAnimationUpdate();
  assert.ok(detector.stats.rocks > 0);
  assert.equal(contacts.length, 1);
  footIK.legs.right.planted = false;
  for (let i = 0; i < 4; i++) detector.onAfterAnimationUpdate();
  assert.equal(contacts.length, 1, '摆动脚碰地不能视作新的落脚');
  player.playerIsOnGround = false;
  detector.onAfterAnimationUpdate();
  player.playerIsOnGround = true;
  footIK.legs.right.planted = true;
  detector.onAfterAnimationUpdate();
  detector.onAfterAnimationUpdate();
  assert.equal(contacts.length, 2, '重新落地允许在相同位置盖印');
  const right = footIK.legs.right;
  right.planted = false;
  detector.onAfterAnimationUpdate();
  right.planted = true;
  right.foot.position.x += 0.05;
  for (let i = 1; i < 4; i++) right.soleSamples[i].local.y = 0.04;
  detector.onAfterAnimationUpdate();
  detector.onAfterAnimationUpdate();
  assert.equal(detector.gate.states.right.consumed, false, '只有一个鞋底角接地时应等待更稳定的支撑');
  for (const sample of right.soleSamples) sample.local.y = 0;
  detector.onAfterAnimationUpdate();
  detector.onAfterAnimationUpdate();
  assert.equal(contacts.length, 3, '足够鞋底采样点接地后才允许盖印');
  detector.onDetach();
});

test('站立滑动后须等鞋底稳定才补印，行走中持续支撑不重复盖印', () => {
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(4, 4).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
  );
  floor.userData.surface = 'regolith';
  floor.updateMatrixWorld(true);
  const foot = new THREE.Object3D();
  foot.position.set(0.2, 0.003, 0);
  const samples = contact(0, 0).corners.map((local) => ({ local }));
  let locomotion = false;
  const footIK = {
    enabled: true,
    maxFootRaise: 0.25,
    maxFootDrop: 0.25,
    isLocomotion: () => locomotion,
    legs: {
      left: { planted: false, foot, soleSamples: samples },
      right: { planted: true, foot, soleSamples: samples },
    },
  };
  const contacts = [];
  const detector = new LunarFootContacts(footIK, (c) => contacts.push(c.point.clone()));
  detector.onAttach({ playerIsOnGround: true, getColliderMeshes: () => [floor], getControllerMode: () => 0 });
  detector.onAfterAnimationUpdate();
  detector.onAfterAnimationUpdate();
  assert.equal(contacts.length, 1);
  for (let i = 0; i < 4; i++) {
    foot.position.x += 0.03;
    detector.onAfterAnimationUpdate();
  }
  assert.equal(contacts.length, 1, '站立鞋底滑向新位置的途中不能盖印');
  detector.onAfterAnimationUpdate();
  detector.onAfterAnimationUpdate();
  assert.equal(contacts.length, 2);
  assert.ok(Math.abs(contacts[1].x - 0.32) < 1e-6, '第二枚脚印应对应最终稳定的站立鞋底');
  locomotion = true;
  foot.position.x += 0.12;
  for (let i = 0; i < 4; i++) detector.onAfterAnimationUpdate();
  assert.equal(contacts.length, 2, '行走中从未离地的支撑只能生成一枚脚印');
  detector.onDetach();
});

test('停止行走后双脚均留下最终站立脚印', async () => {
  const f = await createAstronautPlayer();
  f.register(new THREE.PlaneGeometry(8, 8).rotateX(-Math.PI / 2));
  f.place(0, 0, 0, true);
  const contacts = [];
  const detector = new LunarFootContacts(f.ik, (contact) => contacts.push(contact));
  f.player.use(detector);
  f.player.animation.playByName('walking', 0);
  f.step(80);
  const walked = contacts.length;
  f.player.animation.playByName('idle', 0.18);
  f.step(40);
  const idle = contacts.slice(walked);
  assert.equal(idle.length, 2, '每只脚都应留下站立脚印，而非动画混合中途的脚印');
  for (const side of ['left', 'right']) {
    const stamp = idle.find((contact) => contact.side === side);
    const corners = detector.source.read(side).corners;
    const pose = corners.reduce((sum, point) => sum.add(point), new THREE.Vector3()).multiplyScalar(0.25);
    assert.ok(
      Math.hypot(stamp.point.x - pose.x, stamp.point.z - pose.z) < 0.03,
      `${side} 站立脚印应匹配最终稳定的鞋底`,
    );
  }
  f.dispose();
});

test('脚印记录支持跨块、负坐标与有界历史', () => {
  const store = new FootprintStore({ limit: 3 });
  const erased = [];
  store.onErase = (key) => erased.push(key);
  const crossing = store.add(contact(0, 0));
  assert.deepEqual(new Set(crossing.keys), new Set(['-1,-1', '0,-1', '-1,0', '0,0']));
  assert.deepEqual(footprintTileKeys({ x: -8, z: -8, ax: 0.04, az: 0, bx: 0, bz: 0.1 }), [
    '-2,-2',
    '-1,-2',
    '-2,-1',
    '-1,-1',
  ]);
  store.add(contact(8, -2));
  store.add(contact(16, -2));
  store.add(contact(24, -2));
  assert.equal(store.records.size, 3);
  assert.ok(!store.records.has(crossing.id));
  for (const key of crossing.keys) assert.ok(erased.includes(key));
  for (const tile of store.tiles.values()) for (const record of tile) assert.ok(store.records.has(record.id));
  store.clear();
  assert.equal(store.tiles.size, 0);
  assert.equal(store.records.size, 0);
});

test('采样坑写入独立历史，清空脚印时仍保留', () => {
  const store = new FootprintStore({ limit: 2, digLimit: 2 });
  store.add(contact(0, 0));
  store.add(contact(1, 0));
  const dig = store.addDig({
    x: 4, y: 0, z: -3,
    ax: 0.6, az: 0, bx: 0, bz: 0.3,
    normal: { x: 0, y: 1, z: 0 },
  });
  assert.equal(dig.kind, 'dig');
  assert.equal(store.byKind.dig.size, 1);
  store.clear('foot');
  assert.equal(store.byKind.foot.size, 0);
  assert.equal(store.byKind.dig.size, 1);
  store.clear('dig');
  assert.equal(store.byKind.dig.size, 0);
});

/** 提供可记录图集更新和渲染状态的模拟渲染器。 */
function fakeRenderer() {
  const renderer = {
    capabilities: { maxTextureSize: 8192 },
    target: null,
    autoClear: true,
    color: new THREE.Color(0x123456),
    alpha: 0.4,
    clears: [],
    draws: [],

    /** 返回模拟渲染器当前目标。 */
    getRenderTarget() {
      return this.target;
    },
    getActiveCubeFace: () => 0,
    getActiveMipmapLevel: () => 0,

    /** 将当前模拟清屏颜色写入目标对象。 */
    getClearColor(target) {
      return target.copy(this.color);
    },

    /** 返回模拟透明清屏值。 */
    getClearAlpha() {
      return this.alpha;
    },

    /** 记录渲染目标及其附加状态。 */
    setRenderTarget(target) {
      this.target = target;
    },

    /** 记录清屏颜色与透明度变更。 */
    setClearColor(color, alpha) {
      this.color.set(color);
      this.alpha = alpha;
    },

    /** 记录被清理的图集范围。 */
    clear() {
      this.clears.push(this.target.scissor.toArray());
    },

    /** 记录绘制行为，并按测试设置模拟渲染失败。 */
    render(scene) {
      const mesh = scene.children[0];
      this.draws.push({ count: mesh.geometry.instanceCount, name: mesh.name, target: this.target });
    },
  };
  return renderer;
}

/** 筛选印记绘制调用，排除坡度更新通道。 */
function stampDraws(renderer) {
  return renderer.draws.filter((draw) => draw.name === 'footprint-stamp');
}

test('脚印图集仅更新变化区域，恢复渲染状态并在换原点后保持历史', () => {
  const renderer = fakeRenderer(),
    scene = new THREE.Scene(),
    material = new THREE.MeshStandardMaterial();
  // 补充通常由月壤材质注入的着色器插值变量。
  const footprints = new LunarFootprints(renderer, scene, material, { resolution: 1024, limit: 3 });
  footprints.update(1, 1, 0, 0);
  assert.equal(renderer.clears.length, 9);
  assert.equal(stampDraws(renderer).length, 0);
  footprints.add(contact(1, 1));
  footprints.update(1, 1, 0, 0);
  assert.equal(stampDraws(renderer).length, 1);
  assert.equal(stampDraws(renderer)[0].count, 1);
  const clears = renderer.clears.length,
    draws = renderer.draws.length;
  footprints.update(1.1, 1.1, 0, 0);
  footprints.update(1.1, 1.1, 3072, -3072);
  assert.equal(renderer.clears.length, clears);
  assert.equal(renderer.draws.length, draws);
  assert.deepEqual(footprints.uniforms.uFootprintWindow.value.toArray(), [-3080, 3064]);
  assert.equal(renderer.target, null);
  assert.equal(renderer.autoClear, true);
  assert.equal(renderer.alpha, 0.4);
  assert.equal(renderer.color.getHex(), 0x123456);

  footprints.add(contact(-0.01, -0.01));
  footprints.update(1, 1, 0, 0);
  assert.equal(footprints.stats.draws, 4, '边界脚印应覆盖所有相邻地块');
  footprints.update(40, 40, 0, 0);
  assert.equal(footprints.stats.tiles, 0);
  footprints.update(1, 1, 0, 0);
  assert.equal(footprints.stats.tiles, 4);
  assert.ok(footprints.stats.draws > 0, '返回区域后应重建驻留纹理');
  footprints.add(contact(2, 2));
  footprints.add(contact(3, 3));
  footprints.update(1, 1, 0, 0);
  assert.equal(footprints.store.records.size, 3);
  assert.ok(renderer.clears.length > clears, '淘汰脚印时应清理并重建受影响的驻留地块');
  footprints.clear();
  footprints.update(1, 1, 0, 0);
  assert.equal(footprints.stats.count, 0);
  assert.equal(footprints.stats.tiles, 0);
  assert.equal(footprints.target.texture.format, THREE.RedFormat);
  assert.equal(footprints.shaded.texture.format, THREE.RGBAFormat);
  assert.equal(footprints.uniforms.uFootprintMap.value, footprints.shaded.texture);
  assert.equal(footprints.target.depthBuffer, false);
  const shader = {
    uniforms: {},
    vertexShader: '',
    fragmentShader: '#include <common>\n#include <color_fragment>\n#include <normal_fragment_maps>\n',
  };
  material.onBeforeCompile(shader, renderer);
  assert.equal(shader.fragmentShader.match(/texture2D\(uFootprintMap/g).length, 1);
  footprints.dispose();
});

test('淘汰可见车辙时仅清理局部矩形，并重画与该区域相交的印记', () => {
  const renderer = fakeRenderer();
  const prints = new LunarFootprints(renderer, new THREE.Scene(), new THREE.MeshStandardMaterial(), {
    resolution: 256,
    trackLimit: 2,
  });
  prints.setTracksEnabled(true);
  prints.update(1, 1, 0, 0);

  /** 创建固定尺寸的测试轮胎印记。 */
  const track = (x) => ({
    x,
    y: 0,
    z: 1,
    ax: 0.08,
    az: 0,
    bx: 0,
    bz: 0.04,
    phase: 0,
    span: 0.2,
    normal: { x: 0, y: 1, z: 0 },
  });
  prints.addTrack(track(0.4));
  prints.addTrack(track(6));
  prints.update(1, 1, 0, 0);
  const clears = renderer.clears.length,
    stamps = stampDraws(renderer).length;
  prints.addTrack(track(0.45));
  prints.update(1, 1, 0, 0);
  const partial = renderer.clears.slice(clears);
  assert.equal(partial.length, 1);
  assert.ok(partial[0][2] < 64 && partial[0][3] < 64, '清理裁剪框应限制在移除的车辙段附近');
  assert.equal(stampDraws(renderer).length, stamps + 1);
  assert.equal(prints.stampMesh.geometry.instanceCount, 1);
  prints.dispose();
});

test('轮胎和鞋底历史具有独立容量与清理入口，并共用同一高度图集', () => {
  const renderer = fakeRenderer(),
    prints = new LunarFootprints(renderer, new THREE.Scene(), new THREE.MeshStandardMaterial(), {
      resolution: 256,
      limit: 2,
      trackLimit: 3,
    });

  /** 创建固定尺寸的测试轮胎印记。 */
  const target = prints.target,
    track = (x) => ({
      x,
      y: 0,
      z: 1,
      ax: 0.08,
      az: 0,
      bx: 0,
      bz: 0.04,
      phase: x,
      span: 0.8,
      normal: { x: 0, y: 1, z: 0 },
    });
  prints.setTracksEnabled(true);
  prints.add(contact(1, 1));
  prints.add(contact(2, 1));
  for (let i = 0; i < 12; i++) prints.addTrack(track(1 + i * 0.1));
  assert.equal(prints.store.byKind.foot.size, 2);
  assert.equal(prints.store.byKind.tire.size, 3);
  assert.equal(prints.store.records.size, 5);
  prints.update(1, 1, 0, 0);
  assert.equal(prints.target, target);
  assert.equal(prints.stampMesh.geometry.instanceCount, 5);
  const calls = renderer.draws.length;
  prints.update(1, 1, 3072, -3072);
  assert.equal(renderer.draws.length, calls);
  prints.setEnabled(false);
  prints.update(1, 1, 0, 0);
  assert.equal(prints.stampMesh.geometry.instanceCount, 3);
  assert.equal(prints.uniforms.uFootprintEnabled.value, 1, '隐藏脚印时车辙仍应可见');
  prints.setTracksEnabled(false);
  prints.update(1, 1, 0, 0);
  assert.equal(prints.uniforms.uFootprintEnabled.value, 0);
  prints.setEnabled(true);
  prints.setTracksEnabled(true);
  prints.update(1, 1, 0, 0);
  assert.equal(prints.stampMesh.geometry.instanceCount, 5);
  prints.clear('tire');
  assert.equal(prints.store.byKind.foot.size, 2);
  assert.equal(prints.stats.trackCount, 0);
  prints.update(1, 1, 0, 0);
  assert.equal(prints.stampMesh.geometry.instanceCount, 2);
  prints.dispose();
});
