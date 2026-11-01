import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { VehicleRigidBody } from 'three-player-controller';
import { createRoverStabilizer } from '../../src/vehicle/rover-stability.js';

const up = new THREE.Vector3(0, 1, 0);

/** 从车身旋转计算相对世界竖直方向的倾角。 */
const tiltOf = (body) => Math.acos(THREE.MathUtils.clamp(up.clone().applyQuaternion(body.rotation()).y, -1, 1));

/** 创建可修改姿态、线速度与角速度的测试车身。 */
const makeBody = () =>
  new VehicleRigidBody({
    position: new THREE.Vector3(4, 3, -4),
    mass: 200,
    halfExtents: new THREE.Vector3(0.8, 0.5, 1.5),
  });

/** 提取测试四元数中的水平航向。 */
const yawOf = (q) => new THREE.Quaternion(0, q.y, 0, q.w).normalize();

test('倾角约束保留自然坡面姿态，限制过大侧倾且不改变航向或平移', () => {
  const body = makeBody(),
    stability = createRoverStabilizer(body);
  const axis = new THREE.Vector3(0.6, 0, 0.8),
    heading = new THREE.Quaternion().setFromAxisAngle(up, 1.8);

  /** 生成组合航向与倾角的测试旋转。 */
  const rotation = (angle) =>
    new THREE.Quaternion().setFromAxisAngle(axis, THREE.MathUtils.degToRad(angle)).multiply(heading);
  body.setRotation(rotation(22));
  const natural = body.rotation().clone();
  stability.constrain();
  assert.ok(body.rotation().angleTo(natural) < 1e-7);
  body.setRotation(rotation(130));
  body.setAngvel(axis.clone().multiplyScalar(1.2).addScaledVector(up, 2));
  body.setLinvel({ x: 3, y: -2, z: 7 });
  const position = body.position.clone(),
    velocity = body.linvel().clone();
  stability.constrain();
  assert.ok(Math.abs(tiltOf(body) - THREE.MathUtils.degToRad(35)) < 1e-7);
  assert.ok(yawOf(body.rotation()).angleTo(heading) < 1e-7);
  assert.ok(Math.abs(body.angvel().dot(axis)) < 1e-7);
  assert.equal(body.angvel().y, 2);
  assert.ok(body.position.equals(position));
  assert.ok(body.linvel().equals(velocity));
  // 即使达到倾角边界，也必须允许向内回正。
  body.setAngvel(axis.clone().multiplyScalar(-0.5));
  stability.constrain();
  assert.ok(body.angvel().dot(axis) < -0.49);
});

test('倾斜阻尼与角速度限制保留转向，禁用后不施加修正', () => {
  const body = makeBody(),
    stability = createRoverStabilizer(body);
  body.setAngvel({ x: 0.2, y: 2, z: -0.3 });
  stability.constrain(0.1);
  assert.ok(Math.abs(body.angvel().x - 0.2 * Math.exp(-0.6)) < 1e-9);
  assert.ok(Math.abs(body.angvel().z + 0.3 * Math.exp(-0.6)) < 1e-9);
  assert.equal(body.angvel().y, 2);
  body.setAngvel({ x: 50, y: 3, z: -40 });
  stability.constrain();
  assert.ok(Math.hypot(body.angvel().x, body.angvel().z) <= Math.PI / 2 + 1e-9);
  assert.equal(body.angvel().y, 3);
  stability.settings.enabled = false;
  body.setRotation(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 2));
  body.setAngvel({ x: 5, y: 4, z: 3 });
  const rotation = body.rotation().clone();
  stability.constrain(1);
  assert.ok(body.rotation().equals(rotation));
  assert.deepEqual(body.angvel().toArray(), [5, 4, 3]);
});

test('大冲量、倒置落地与不同时间倍率下均保持倾角限制', () => {
  for (const fps of [30, 60, 120])
    for (const timeScale of [0.25, 0.6, 1]) {
      const body = makeBody(),
        stability = createRoverStabilizer(body),
        delta = timeScale / fps;
      for (let i = 0; i < 180; i++) {
        stability.constrain(delta);
        // 在物理预过滤后施加碰撞级别的大冲量。
        body.applyImpulseAtPoint(
          new THREE.Vector3(Math.sin(i) * 600, 300, Math.cos(i) * 600),
          body.position.clone().add(new THREE.Vector3(1, 0.7, -1)),
        );
        body.integrate(delta);
        stability.constrain();
        assert.ok(tiltOf(body) <= THREE.MathUtils.degToRad(35) + 1e-7);
      }
      body.setRotation(new THREE.Quaternion(1, 0, 0, 0));
      stability.constrain();
      assert.ok(Number.isFinite(body.rotation().w));
      assert.ok(tiltOf(body) <= THREE.MathUtils.degToRad(35) + 1e-7);
      stability.settings.maxTiltDegrees = 0;
      stability.constrain();
      assert.ok(tiltOf(body) < 1e-7);
      assert.equal(body.angvel().x, 0);
      assert.equal(body.angvel().z, 0);
    }
});
