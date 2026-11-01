import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { COMPASS, compassLabels, facingYaw, cameraYaw, mapMarker, worldToMap } from '../../src/ui/minimap.js';

import skySnapshot from '../../src/environment/sky-snapshot.json' with { type: 'json' };

test('箭头朝向取自角色胶囊与车辆实际车头', () => {
  const capsule = new THREE.Object3D();
  const player = {
    getControllerMode: () => 0,
    playerCapsule: capsule,
    getActiveVehicle: () => null,
  };
  capsule.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0);
  assert.ok(Math.abs(facingYaw(player)) < 1e-8);
  capsule.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
  assert.ok(Math.abs(facingYaw(player) - Math.PI / 2) < 1e-8);

  // 前向取自前后轮推得的 forwardLocal，再转到世界坐标。
  const chassis = { quaternion: new THREE.Quaternion() };
  player.getControllerMode = () => 1;
  player.getActiveVehicle = () => ({
    chassisBody: chassis,
    forwardLocal: new THREE.Vector3(-1, 0, 0),
  });
  assert.ok(Math.abs(facingYaw(player) + Math.PI / 2) < 1e-8);
});

test('地图读取镜头朝向，独立于人物转身并支持第一人称相机父级旋转', () => {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 5, -10);
  camera.lookAt(0, 0, 0);
  assert.ok(Math.abs(cameraYaw(camera)) < 1e-8);
  camera.lookAt(10, 5, -10);
  assert.ok(Math.abs(cameraYaw(camera) - Math.PI / 2) < 1e-8);

  const rig = new THREE.Group();
  rig.rotation.y = Math.PI / 2;
  const firstPerson = new THREE.PerspectiveCamera();
  rig.add(firstPerson);
  assert.ok(Math.abs(cameraYaw(firstPerson) + Math.PI / 2) < 1e-8, '第一人称应读取父级变换后的世界方向');
});

test('镜头接近垂直时保持上次地图方位，恢复水平后立即读取新朝向', () => {
  const camera = new THREE.PerspectiveCamera();
  camera.lookAt(0, -10, 0);
  assert.equal(cameraYaw(camera, 1.2), 1.2);
  camera.lookAt(-10, -2, 0);
  assert.ok(Math.abs(cameraYaw(camera, 1.2) + Math.PI / 2) < 1e-8);
});

test('小地图方位与天空快照的世界轴一致', () => {
  assert.equal(skySnapshot.axes.x, 'east');
  assert.equal(skySnapshot.axes.z, 'south');
  assert.deepEqual(
    COMPASS.map((card) => card.id),
    ['N', 'E', 'S', 'W'],
  );
  assert.deepEqual(compassLabels(), { N: 'N', E: 'E', S: 'S', W: 'W' });
  assert.deepEqual(COMPASS[0], { id: 'N', x: 0, y: -1 });
});

test('各镜头朝向下，地图左右与真实三维投影一致，前方始终在上方', () => {
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  const origin = new THREE.Vector3();
  const right = new THREE.Vector3();
  const target = new THREE.Vector3();
  for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2, 0.7, -2.2]) {
    camera.position.set(-Math.sin(yaw) * 10, 5, -Math.cos(yaw) * 10);
    camera.lookAt(origin);
    camera.updateMatrixWorld(true);
    right.setFromMatrixColumn(camera.matrixWorld, 0);
    for (const side of [-1, 1]) {
      target.copy(right).multiplyScalar(side * 3);
      const screen = target.clone().project(camera);
      const map = worldToMap(target.x, target.z, cameraYaw(camera));
      assert.equal(Math.sign(map.x), Math.sign(screen.x), `镜头朝向 ${yaw} 时，左右不能镜像`);
      assert.ok(Math.abs(map.y) < 1e-8);
    }
    const ahead = worldToMap(Math.sin(yaw) * 5, Math.cos(yaw) * 5, cameraYaw(camera));
    assert.ok(Math.abs(ahead.x) < 1e-8 && ahead.y < 0);
  }
});

test('车辆超出范围后保留圆周方向，转身后方位仍正确', () => {
  const ahead = mapMarker(12, 0, Math.PI / 2, 85.5);
  assert.ok(Math.abs(ahead.x) < 1e-8);
  assert.ok(ahead.y < 0);
  assert.equal(ahead.offscreen, false);
  for (const radius of [42, 56, 85.5]) {
    const distant = mapMarker(-1000, 2000, 0.7, radius);
    const farther = mapMarker(-10000, 20000, 0.7, radius);
    assert.equal(distant.offscreen, true);
    assert.ok(Math.abs(Math.hypot(distant.x, distant.y) - (radius - 12)) < 1e-8);
    assert.ok(Math.abs(distant.angle - farther.angle) < 1e-8, '距离变化不能改变目标方位');
  }
});

test('前方视野偏移与驾驶缩放使用实际可见圆周判断目标是否超界', () => {
  const radius = 85.5;
  const offset = radius * 0.16;
  assert.equal(mapMarker(0, 72, 0, radius, 72, offset).offscreen, false);
  assert.equal(mapMarker(0, -72, 0, radius, 72, offset).offscreen, true);
  assert.equal(mapMarker(0, 84, 0, radius, 72, offset).offscreen, true);
  assert.equal(mapMarker(0, 84, 0, radius, 96, offset).offscreen, false);
  for (const yaw of [0, 1.2, -2.3, Math.PI]) {
    const marker = mapMarker(1500, -3000, yaw, radius, 96, offset);
    assert.ok(Math.hypot(marker.x, marker.y) <= radius - 12 + 1e-8, '偏移和缩放不能将远处标记推到圆周外');
  }
});
