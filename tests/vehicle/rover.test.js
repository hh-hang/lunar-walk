import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { createGLTFLoader } from '../../src/loaders/gltf-loader.js';
import { createAstronautPlayer } from '../helpers/astronaut-player.js';
import {
  loadLunarRover,
  explorationPosition,
  rebaseRovers,
  resetRovers,
  roverChassisY,
  ROVER_SPAWN,
  ROVER_WHEELS,
  ROVER_FENDERS,
} from '../../src/vehicle/rover.js';
import { heightAt } from '../../src/terrain/height.js';
import { LunarRoverEffects } from '../../src/vehicle/rover-effects.js';
import { FootprintStore } from '../../src/rendering/footprint-store.js';

test('真实月球车通过车辆接口加载、驾驶、换原点并正常下车', async (t) => {
  const f = await createAstronautPlayer();
  t.after(() => {
    f.player.vehicle.destroy();
    f.dispose();
  });
  f.player.timeScale = 0.6;
  f.player.animation.actions.set('driving', f.player.animation.actions.get('idle'));
  const groundHeight = heightAt(4, -4);
  const ground = f.register(new THREE.PlaneGeometry(256, 256).rotateX(-Math.PI / 2).translate(0, groundHeight, 0));
  const bytes = await readFile(new URL('../../public/models/lunar_rove.glb', import.meta.url));
  const loader = createGLTFLoader();
  loader.register(() => ({
    name: 'NoTextureDecoding',
    loadMaterial: () => Promise.resolve(new THREE.MeshStandardMaterial()),
  }));
  const gltf = await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  // 记录原生归一化与重挂载后、项目绑定前的挡泥板位置，用于检测错误支点。
  const nativeLoad = f.player.loadVehicleModel.bind(f.player),
    restFenders = [];
  let configuredScale, configuredSeat;
  f.player.loadVehicleModel = async (options) => {
    configuredScale = options.scale ?? 1;
    configuredSeat = options.driverSeatPosition.toArray();
    const v = await nativeLoad(options);
    v.vehicleGroup.updateWorldMatrix(true, true);
    for (const [i, name] of ROVER_FENDERS.entries()) {
      const mesh = v.vehicleGroup.getObjectByName(name),
        wheel = v.vehicleGroup.getObjectByName(ROVER_WHEELS[i]).parent;
      const vertices = mesh.geometry.attributes.position;
      const samples = [0, Math.floor(vertices.count / 2), vertices.count - 1].map((index) => {
        const local = new THREE.Vector3().fromBufferAttribute(vertices, index);
        const world = mesh.localToWorld(local.clone());
        return { local, world, offset: v.vehicleGroup.worldToLocal(world.clone()).sub(wheel.position) };
      });
      restFenders.push({ mesh, samples });
    }
    return v;
  };
  const vehicle = await loadLunarRover(f.player, {
    loadAsync: async (url) => {
      assert.equal(url, '/models/lunar_rove.glb');
      return gltf;
    },
  });
  assert.equal(vehicle.scale, configuredScale);
  assert.ok(vehicle.scale > 0);
  assert.deepEqual(vehicle.driverSeatPosition.toArray(), configuredSeat);
  assert.equal(vehicle.vehicleController.numWheels(), 4);
  const spawnChassisY = vehicle.chassisBody.position.y;
  assert.ok(Math.abs(spawnChassisY - roverChassisY(vehicle)) < 1e-6);
  for (const name of ROVER_WHEELS) assert.ok(vehicle.vehicleGroup.getObjectByName(name));
  for (const { mesh, samples } of restFenders)
    for (const sample of samples)
      assert.ok(
        mesh.localToWorld(sample.local.clone()).distanceTo(sample.world) < 1e-7,
        '绑定后必须保留模型原始挡泥板位置',
      );

  /** 校验真实挡泥板跟随轮毂和转向，但不继承轮胎自转。 */
  const assertFenders = () => {
    vehicle.vehicleGroup.updateWorldMatrix(true, true);
    for (const [i, { mesh, samples }] of restFenders.entries()) {
      const wheel = vehicle.vehicleGroup.getObjectByName(ROVER_WHEELS[i]).parent;
      const steering = vehicle.vehicleController.wheelSteering(i);
      for (const sample of samples) {
        const expected = sample.offset
          .clone()
          .applyAxisAngle(new THREE.Vector3(0, 1, 0), steering)
          .add(wheel.position)
          .applyMatrix4(vehicle.vehicleGroup.matrixWorld);
        assert.ok(
          mesh.localToWorld(sample.local.clone()).distanceTo(expected) < 1e-7,
          '挡泥板应跟随可见轮毂与转向，但不能继承轮胎自转',
        );
      }
    }
  };
  const nativeWheels = vehicle.vehicleController.wheels,
    savedWheels = nativeWheels.map((w) => ({
      rotation: w.rotation,
      steering: w.steering,
      visualLength: w.visualLength,
    }));
  for (const direction of [-1, 1]) {
    for (const [i, wheel] of nativeWheels.entries()) {
      vehicle.vehicleController.setWheelSteering(i, direction * [0.4, 0.3, -0.25, -0.2][i]);
      wheel.visualLength = 0.02 + i * 0.04;
      wheel.rotation = 2 + i;
    }
    vehicle.updateWheelVisuals(0.1);
    assertFenders();
    const fenderRotation = restFenders[0].mesh.getWorldQuaternion(new THREE.Quaternion());
    const tire = vehicle.vehicleGroup.getObjectByName(ROVER_WHEELS[0]),
      tireRotation = tire.getWorldQuaternion(new THREE.Quaternion());
    nativeWheels[0].rotation += 1;
    vehicle.updateWheelVisuals(0);
    assertFenders();
    assert.ok(restFenders[0].mesh.getWorldQuaternion(new THREE.Quaternion()).angleTo(fenderRotation) < 1e-7);
    assert.ok(
      tire.getWorldQuaternion(new THREE.Quaternion()).angleTo(tireRotation) > 0.9,
      '挡泥板稳定时轮胎仍应正常自转',
    );
  }
  nativeWheels.forEach((wheel, i) => Object.assign(wheel, savedWheels[i]));
  assert.ok(Math.hypot(vehicle.vehicleGroup.position.x, vehicle.vehicleGroup.position.z) > 4);
  for (let i = 0; i < 180; i++) f.player.vehicle.finishPhysics(0.6 / 60);
  assertFenders();
  assert.ok(vehicle.vehicleGroup.position.y > groundHeight && vehicle.vehicleGroup.position.y < groundHeight + 4);
  assert.ok([0, 1, 2, 3].some((i) => vehicle.vehicleController.wheelIsInContact(i)));
  f.player.updateKinematicColliders();
  const collider = f.player.getKinematicColliderEntries().find((entry) => entry.source === vehicle.vehicleGroup);
  collider.mesh.geometry.computeBoundingBox();
  const collisionBounds = collider.mesh.geometry.boundingBox.clone().applyMatrix4(collider.mesh.matrixWorld);
  const visualBounds = new THREE.Box3().setFromObject(vehicle.vehicleGroup);
  assert.ok(collisionBounds.intersectsBox(visualBounds));
  assert.ok(
    collisionBounds.getCenter(new THREE.Vector3()).distanceTo(visualBounds.getCenter(new THREE.Vector3())) < 0.15,
    '月球车碰撞体应与可见底盘对齐',
  );
  f.place(
    vehicle.vehicleGroup.position.x + vehicle.halfExtents.x * 0.5,
    groundHeight,
    vehicle.vehicleGroup.position.z,
    true,
  );
  const inside = f.player.getPlayerCapsule().position.clone();
  for (let i = 0; i < 5; i++) await f.player.update(1 / 60);
  const pushed = f.player.getPlayerCapsule().position;
  assert.ok(
    pushed.distanceTo(vehicle.vehicleGroup.position) >
      inside.distanceTo(vehicle.vehicleGroup.position) + vehicle.halfExtents.x * 0.2,
    '与车身重叠的角色应被推出',
  );
  f.place(
    vehicle.vehicleGroup.position.x + vehicle.halfExtents.x + 0.2,
    groundHeight,
    vehicle.vehicleGroup.position.z,
    true,
  );
  f.player.setInput({ toggleVehicle: true });
  assert.equal(f.player.getControllerMode(), 1);
  assert.equal(f.player.getPlayerCapsule().parent, vehicle.vehicleGroup);
  const mounted = explorationPosition(f.player);
  assert.ok(mounted.distanceTo(f.player.getPosition()) > 1, '流式地形必须使用世界坐标，而非座椅局部坐标');
  f.player.setInput({ moveY: 1 });
  const start = vehicle.chassisBody.position.clone();
  const trackStore = new FootprintStore(),
    atlas = {
      /** 记录车辙显示开关。 */
      setTracksEnabled() {},

      /** 记录胎纹强度设置。 */
      setTrackStrength() {},
      addTrack: (s) => trackStore.addTrack(s),
      clear: (kind) => trackStore.clear(kind),
    };
  const effects = new LunarRoverEffects(f.player, atlas, f.scene, { random: () => 0.5 });
  t.after(() => effects.dispose());
  const forward = vehicle.forwardLocal.clone().applyQuaternion(vehicle.chassisBody.quaternion).setY(0).normalize();
  for (let i = 0; i < 180; i++) {
    await f.player.update(1 / 60);
    effects.update(f.player.getCurrentDelta());
  }
  assert.ok(trackStore.byKind.tire.size > 20, '真实车轮接触应留下连续车辙');
  assert.ok(effects.dust.stats.emitted > 0 && effects.dust.stats.active > 0, '实际控制器应驱动扬尘发射');
  for (const record of trackStore.byKind.tire.values()) assert.ok(Math.abs(record.y - groundHeight) < 0.01);
  assertFenders();
  assert.ok(vehicle.chassisBody.position.distanceTo(start) > 1, '轮组配置必须保证车辆可驾驶');
  assert.ok(
    vehicle.chassisBody.position.clone().sub(start).setY(0).normalize().dot(forward) > 0.95,
    '正向油门应沿前轮方向前进，不能侧向移动',
  );
  for (let i = 0; i < 4; i++) {
    const wheel = vehicle.vehicleGroup.getObjectByName(ROVER_WHEELS[i]);
    const shaft = new THREE.Vector3(0, 0, 1).applyQuaternion(wheel.getWorldQuaternion(new THREE.Quaternion()));
    const axle = vehicle.vehicleController
      .wheelAxleCs(i)
      .clone()
      .applyAxisAngle(new THREE.Vector3(0, 1, 0), vehicle.vehicleController.wheelSteering(i))
      .applyQuaternion(vehicle.chassisBody.quaternion);
    assert.ok(Math.abs(shaft.dot(axle)) > 0.999, '轮胎自转应保留实际轴向');
  }
  const before = explorationPosition(f.player),
    velocity = vehicle.chassisBody.linvel().clone();
  ground.position.x -= 3072;
  ground.position.z += 3072;
  ground.updateMatrixWorld(true);
  rebaseRovers(f.player, 3072, -3072);
  assert.ok(explorationPosition(f.player).distanceTo(before.clone().add(new THREE.Vector3(-3072, 0, 3072))) < 1e-7);
  assert.ok(vehicle.chassisBody.linvel().distanceTo(velocity) < 1e-9);
  assert.equal(f.player.getControllerMode(), 1);
  for (const entry of f.player.getKinematicColliderEntries())
    if (entry.source === vehicle.vehicleGroup) {
      assert.equal(entry.deltaPos.length(), 0);
      assert.ok(entry.prevWorldMatrix.equals(entry.mesh.matrixWorld));
    }
  // 主场景在换原点后会重新注册流式地形的碰撞体。
  f.register(new THREE.PlaneGeometry(256, 256).rotateX(-Math.PI / 2).translate(-3072, groundHeight, 3072));
  const shifted = vehicle.chassisBody.position.clone();
  await f.player.update(1 / 60);
  assertFenders();
  assert.ok(vehicle.chassisBody.position.distanceTo(shifted) < 0.5, '下一步物理更新不能将原点平移当作车速');
  assert.ok([0, 1, 2, 3].some((i) => vehicle.vehicleController.wheelIsInContact(i)));
  f.player.setInput({ moveY: 0, toggleVehicle: true });
  assert.equal(f.player.getControllerMode(), 0);
  assert.equal(f.player.getPlayerCapsule().parent, f.scene);
  assert.ok(
    explorationPosition(f.player).distanceTo(vehicle.vehicleGroup.position) < 10,
    '下车后应仍在平移后的车辆附近',
  );
  // 使用真实控制器的接触、积分与连续碰撞路径，反复测试翻转姿态、硬着陆和侧向冲量。
  assert.equal(vehicle.stability.settings.enabled, true);
  vehicle.chassisBody.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);
  for (let i = 0; i < 120; i++) {
    vehicle.chassisBody.setAngvel({ x: 30 * Math.sin(i), y: 0.3, z: 30 * Math.cos(i) });
    f.player.vehicle.finishPhysics(0.6 / 60);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(vehicle.chassisBody.quaternion);
    assert.ok(up.y >= Math.cos((35 * Math.PI) / 180) - 1e-7, '碰撞后的车身与可见模型不能翻转');
    assert.ok(vehicle.vehicleGroup.quaternion.angleTo(vehicle.chassisBody.quaternion) < 1e-7);
  }
  const parked = vehicle.chassisBody.position.clone();
  vehicle.vehicleController.updateVehicle(0.1, []);
  assert.ok(vehicle.chassisBody.position.equals(parked), '停放月球车不能穿过已卸载地形坠落');

  // 模拟开局后换过原点：重开应回到默认世界停放点，底盘高度与加载语义一致，并清零速度。
  vehicle.chassisBody.position.set(120, vehicle.chassisBody.position.y, -80);
  vehicle.vehicleGroup.position.set(120, vehicle.vehicleGroup.position.y, -80);
  vehicle.chassisBody.setLinvel({ x: 3, y: 0, z: -2 });
  resetRovers(f.player, { originX: 3072, originZ: -3072 });
  assert.equal(f.player.getControllerMode(), 0);
  assert.ok(
    Math.hypot(
      vehicle.chassisBody.position.x - (ROVER_SPAWN.x - 3072),
      vehicle.chassisBody.position.z - (ROVER_SPAWN.z + 3072),
    ) < 1e-6,
  );
  assert.ok(Math.abs(vehicle.chassisBody.position.y - spawnChassisY) < 1e-6);
  assert.ok(vehicle.chassisBody.linvel().length() < 1e-9);
});
