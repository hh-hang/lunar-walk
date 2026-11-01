import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createLanderStages, partitionStageGeometry } from '../../src/game/lander-stages.js';
import { ASCENT_DURATION, ASCENT_MOTION_DURATION, IGNITION_TIME, PITCH_TIME, sampleAscent } from '../../src/game/ascent-profile.js';
import { createLunarAscent } from '../../src/game/lunar-ascent.js';

test('起飞先准备再分离，垂直段内不转向，约七秒后结束过场', () => {
  assert.equal(sampleAscent(IGNITION_TIME - 0.01).powered, false);
  assert.equal(sampleAscent(IGNITION_TIME).flash, 1);
  assert.equal(sampleAscent(IGNITION_TIME + 0.3).flash, 0);
  assert.equal(sampleAscent(0.5).label, '上升准备');
  assert.equal(sampleAscent(IGNITION_TIME - 0.01).label, '上升准备');
  assert.equal(sampleAscent(IGNITION_TIME + 0.5).label, '级间分离');
  assert.equal(sampleAscent(IGNITION_TIME + 3).label, '垂直上升');
  let previousHeight = 0;
  for (let elapsed = 0; elapsed <= ASCENT_MOTION_DURATION; elapsed += 0.1) {
    const flight = sampleAscent(elapsed);
    assert.ok(flight.height >= previousHeight);
    assert.equal(flight.pitch + flight.distance, 0);
    assert.notEqual(flight.label, '转向加速');
    previousHeight = flight.height;
  }
  assert.ok(sampleAscent(ASCENT_MOTION_DURATION).height > sampleAscent(ASCENT_DURATION).height);
  assert.ok(ASCENT_MOTION_DURATION - IGNITION_TIME <= PITCH_TIME);
  assert.deepEqual(sampleAscent(100), sampleAscent(ASCENT_MOTION_DURATION));
});

test('连通零件跨过分界面也保持完整，法线接缝不会拆散同一个零件', () => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0, 1, 0, 0, 0, 3, 0,
    0, 3, 0, 1, 0, 0, 1, 3, 0,
    3, 5, 0, 4, 5, 0, 3, 6, 0,
    100, -100, 0,
  ], 3));
  geometry.setIndex([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  const [lower, upper] = partitionStageGeometry(geometry, 2);
  assert.equal(lower.index.count, 6);
  assert.equal(upper.index.count, 3);
  assert.equal(lower.boundingBox.max.y, 3);
  assert.equal(lower.boundingBox.max.x, 1);
  for (const item of [geometry, lower, upper]) item.dispose();
});

test('只过滤完整脱离主体的游离部件，不裁断伸出范围的正常结构', () => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0, 1, 0, 0, 0, 1, 0,
    2, 4, 0, 5, 4, 0, 2, 5, 0,
    8, 4, 0, 9, 4, 0, 8, 5, 0,
  ], 3));
  const bounds = new THREE.Box3(new THREE.Vector3(-3.5, -Infinity, -3.5), new THREE.Vector3(3.5, Infinity, 3.5));
  const [lower, upper] = partitionStageGeometry(geometry, 2, null, bounds);
  assert.equal(lower.index.count, 3);
  assert.equal(upper.index.count, 3);
  assert.equal(upper.boundingBox.max.x, 5);
  assert.equal(upper.boundingBox.max.y, 5);
  for (const item of [geometry, lower, upper]) item.dispose();
});

test('清理真实登月舱的两枚游离圆球，保留正常零件与跟舱视角', async () => {
  const bytes = await readFile(new URL('../../public/models/lunar_module.glb', import.meta.url));
  const { scene: model } = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  const sourceBounds = new THREE.Box3().setFromObject(model);
  const scale = 3.6 / (sourceBounds.max.y - sourceBounds.min.y);
  const stages = createLanderStages(model, scale, sourceBounds.min.y);
  let triangles = 0;
  for (const group of [stages.descent, stages.ascent]) {
    assert.ok(group.children.length > 5);
    group.traverse((object) => { if (object.isMesh && /^Object_/.test(object.name)) triangles += object.geometry.index.count / 3; });
  }
  assert.equal(triangles, 99540 - 2 * 760);
  const cleanBounds = new THREE.Box3().setFromObject(stages.ascent, true);
  assert.ok(cleanBounds.max.x < 3.5 * scale && cleanBounds.min.x > -3.5 * scale);
  assert.ok(cleanBounds.max.z < 3.5 * scale && cleanBounds.min.z > -3.5 * scale);
  assert.ok(new THREE.Box3().setFromObject(stages.ascent).min.y > 1.2);
  const upperShields = stages.ascent.getObjectByName('Object_16-上级');
  assert.ok(upperShields.geometry.boundingBox.min.y > (3.0 - sourceBounds.min.y) * scale, '低处的喷流挡板与支架必须留在下降级');
  const scene = new THREE.Scene(), lander = new THREE.Group(), head = new THREE.Group();
  const capsule = new THREE.Object3D();
  scene.add(lander, head, capsule);
  lander.position.set(153, 2, -140);
  lander.rotation.z = 0.035;
  lander.add(stages.descent, stages.ascent);
  const camera = new THREE.PerspectiveCamera(59, 1.5, 0.04, 1000);
  head.add(camera);
  const inputs = [];
  const player = {
    camera,
    playerModel: { visible: true },
    playerModelConfig: { scale: 1 },
    playerCapsule: capsule,
    cam: { originMaxDist: 300, changeView() {} },
    bindKeyboardEvents: true,
    setBindKeyboardEvents(enabled) { this.bindKeyboardEvents = enabled; },
    setMaxCamDistance(distance) { this.cam.originMaxDist = distance; this.maxCamDistance = distance; },
    getIsFirstPerson: () => false,
    setInput(input) { inputs.push(input); },
    reset(position) { capsule.position.copy(position); },
  };
  const launch = createLunarAscent({ lander, stages, player });
  const baseBefore = lander.position.clone();
  lander.rotation.z = -0.08;
  // 模拟登舱黑场已先禁键，再起飞；重开后仍应恢复可控制。
  player.setBindKeyboardEvents(false);
  launch.start();
  assert.equal(player.playerModel.visible, false);
  assert.equal(player.bindKeyboardEvents, false);
  assert.equal(player.maxCamDistance, 2000);
  assert.equal(camera.parent, head);
  launch.update(0);
  assert.ok(stages.ascent.quaternion.angleTo(new THREE.Quaternion()) < 1e-9, '调试停放后必须从当前坡面姿态起飞');
  assert.ok(capsule.position.distanceTo(stages.pivot.clone().applyMatrix4(stages.ascent.matrixWorld)) < 1e-6);
  launch.update(IGNITION_TIME + 6);
  assert.deepEqual(lander.position, baseBefore);
  assert.equal(stages.descent.position.length(), 0);
  assert.ok(stages.ascent.position.y > 10);
  launch.setPaused(true);
  assert.equal(launch.paused, true);
  launch.setPaused(false);
  assert.equal(launch.paused, false);
  assert.ok(capsule.position.distanceTo(stages.pivot.clone().applyMatrix4(stages.ascent.matrixWorld)) < 1e-6);
  assert.equal(launch.effects.root.visible, true);
  assert.ok([...launch.effects.foil.instanceMatrix.array].every(Number.isFinite));
  const upperBefore = stages.ascent.getWorldPosition(new THREE.Vector3());
  const seatBefore = capsule.position.clone();
  lander.position.x -= 3168;
  launch.update(IGNITION_TIME + 6);
  assert.ok(Math.abs(stages.ascent.getWorldPosition(new THREE.Vector3()).x + 3168 - upperBefore.x) < 1e-9);
  assert.ok(Math.abs(capsule.position.x + 3168 - seatBefore.x) < 1e-9);
  launch.update(ASCENT_DURATION);
  assert.equal(launch.effects.jet.visible, true);
  assert.ok(stages.ascent.position.y > 20);
  launch.reset();
  assert.equal(launch.active, false);
  assert.equal(camera.parent, head);
  assert.equal(player.playerModel.visible, true);
  assert.equal(player.bindKeyboardEvents, true);
  assert.equal(player.maxCamDistance, 300);
  assert.equal(stages.ascent.position.length(), 0);
  assert.equal(launch.effects.root.visible, false);
  assert.equal(launch.effects.jet.visible, false);
  assert.ok(inputs.some((input) => input.moveX === 0 && input.moveY === 0));
  launch.dispose();
  assert.equal(camera.parent, head);
  assert.equal(player.playerModel.visible, true);
  assert.equal(player.bindKeyboardEvents, true);
  const resources = new Set();
  lander.traverse((object) => { if (object.geometry) resources.add(object.geometry); if (object.material) resources.add(object.material); });
  resources.forEach((resource) => resource.dispose());
});
