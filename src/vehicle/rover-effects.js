import * as THREE from 'three';
import { LunarRoverDust } from './rover-dust.js';

// 复用控制器车轮已有的四个地面接触结果，避免额外射线与粒子碰撞计算。
export class RoverContactSource {
  /** 只接收真实接地且法线有效的月壤车轮接触。 */
  read(vehicle, index) {
    const wheel = vehicle.vehicleController.wheelAt(index);
    return wheel?.isInContact && wheel.contactMesh?.userData.surface === 'regolith' && wheel.contactNormal.y > 0.35
      ? wheel
      : null;
  }
}

/** 沿实际轮轴测量轮胎世界宽度，供车辙盖印使用。 */
function tireWidth(vehicle, index) {
  const wheel = vehicle.vehicleGroup.getObjectByName(['Wheel_LF', 'Wheel_RF', 'Wheel_LR', 'Wheel_RR'][index]);
  const axle = vehicle.vehicleController
    .wheelAxleCs(index)
    .clone()
    .applyAxisAngle(new THREE.Vector3(0, 1, 0), vehicle.vehicleController.wheelSteering(index))
    .applyQuaternion(vehicle.chassisBody.quaternion)
    .normalize();
  let min = Infinity,
    max = -Infinity;
  const point = new THREE.Vector3();
  wheel.updateWorldMatrix(true, true);
  wheel.traverse((object) => {
    if (!object.isMesh) return;
    if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
    const box = object.geometry.boundingBox;
    for (let i = 0; i < 8; i++) {
      point
        .set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z)
        .applyMatrix4(object.matrixWorld);
      const d = point.dot(axle);
      min = Math.min(min, d);
      max = Math.max(max, d);
    }
  });
  return THREE.MathUtils.clamp(max - min, 0.025, vehicle.vehicleController.wheelAt(index).radius * 2);
}

export class LunarRoverEffects {
  /** 连接轮胎接触、共享印记图集和车辆扬尘。 */
  constructor(player, atlas, scene, { origin = { value: new THREE.Vector2() }, camera, sunDirection, random } = {}) {
    this.player = player;
    this.atlas = atlas;
    this.origin = origin;
    this.camera = camera;
    this.source = new RoverContactSource();
    this.vehicles = new Map();
    this.settings = { tracksEnabled: true, dustEnabled: true, trackStrength: 0.85, dustAmount: 1 };
    this.stats = { contacts: 0, stamps: 0, updateMs: 0, peakMs: 0 };
    this.dust = new LunarRoverDust(scene, { sunDirection, random });
    this.point = new THREE.Vector3();
    this.delta = new THREE.Vector3();
    this.direction = new THREE.Vector3();
    this.side = new THREE.Vector3();
    this.forward = new THREE.Vector3();
    this.up = new THREE.Vector3(0, 1, 0);
    this.configure({});
  }

  /** 同步车辙与扬尘设置，并重置轮迹连续状态。 */
  configure(options) {
    Object.assign(this.settings, options);
    this.atlas.setTracksEnabled(this.settings.tracksEnabled);
    this.atlas.setTrackStrength(this.settings.trackStrength);
    this.dust.setEnabled(this.settings.dustEnabled);
    this.vehicles.clear();
  }

  /** 按模拟时间更新四轮车辙与扬尘。 */
  update(delta) {
    if (!(delta > 0)) return;
    const start = performance.now();
    this.stats.contacts = 0;
    if (this.skipContact) {
      this.skipContact = false;
      this.dust.update(delta);
      return;
    }
    if (this.settings.tracksEnabled || this.settings.dustEnabled)
      for (const vehicle of this.player.getAllVehicles()) {
        let states = this.vehicles.get(vehicle);
        if (!states || states.scale !== vehicle.scale) {
          states = [0, 1, 2, 3].map((i) => ({
            width: tireWidth(vehicle, i),
            previous: null,
            anchor: null,
            phase: 0,
            emission: 0,
          }));
          states.scale = vehicle.scale;
          this.vehicles.set(vehicle, states);
        }
        for (let i = 0; i < 4; i++) this.updateWheel(vehicle, states[i], i, delta);
      }
    this.dust.update(delta);
    this.stats.updateMs = performance.now() - start;
    this.stats.peakMs = Math.max(this.stats.peakMs, this.stats.updateMs);
  }

  /** 过滤停驶、离地和传送，按接触路径生成连续车辙与尘粒。 */
  updateWheel(vehicle, state, index, delta) {
    const wheel = this.source.read(vehicle, index);
    if (!wheel) {
      state.previous = state.anchor = null;
      state.emission = 0;
      return;
    }
    this.stats.contacts++;
    this.point.copy(wheel.contactPoint);
    this.point.x += this.origin.value.x;
    this.point.z += this.origin.value.y;
    if (!state.previous) {
      state.previous = this.point.clone();
      state.anchor = this.point.clone();
      return;
    }
    this.delta.subVectors(this.point, state.previous);
    const distance = this.delta.length();
    const velocity = vehicle.chassisBody.linvel();
    const bodySpeed =
      Math.hypot(velocity.x, velocity.z) +
      Math.abs(vehicle.chassisBody.angvel().y) * Math.hypot(wheel.connectionPoint.x, wheel.connectionPoint.z);
    if (distance > Math.max(0.5, bodySpeed * delta * 4) || bodySpeed < 0.06) {
      state.previous.copy(this.point);
      state.anchor.copy(this.point);
      state.emission = 0;
      return;
    }
    const speed = Math.min(distance / delta, bodySpeed * 2 + 0.05);
    this.direction.copy(this.delta).projectOnPlane(wheel.contactNormal).normalize();
    this.side
      .copy(wheel.axle)
      .applyAxisAngle(this.up, wheel.steering)
      .applyQuaternion(vehicle.chassisBody.quaternion)
      .projectOnPlane(wheel.contactNormal)
      .normalize();
    this.forward
      .copy(vehicle.forwardLocal)
      .applyAxisAngle(this.up, wheel.steering)
      .applyQuaternion(vehicle.chassisBody.quaternion);
    const sign = this.direction.dot(this.forward) >= 0 ? 1 : -1;
    const pitch = Math.max(0.035, (2 * Math.PI * wheel.radius) / 24);
    const length = state.anchor.distanceTo(this.point),
      spacing = Math.max(0.025, state.width * 0.25);
    if (this.settings.tracksEnabled && length >= spacing) {
      const dx = this.point.x - state.anchor.x,
        dz = this.point.z - state.anchor.z;
      const planar = Math.hypot(dx, dz),
        overlap = 0.005;
      if (planar > 0.001) {
        const record = this.atlas.addTrack({
          x: (state.anchor.x + this.point.x) * 0.5,
          y: this.point.y,
          z: (state.anchor.z + this.point.z) * 0.5,
          ax: this.side.x * state.width * 0.5,
          az: this.side.z * state.width * 0.5,
          bx: dx * (0.5 + overlap / planar),
          bz: dz * (0.5 + overlap / planar),
          phase: state.phase - (sign * overlap) / pitch,
          span: (sign * (length + 2 * overlap)) / pitch,
          normal: { x: wheel.contactNormal.x, y: wheel.contactNormal.y, z: wheel.contactNormal.z },
        });
        if (record) this.stats.stamps++;
      }
      state.phase += (sign * length) / pitch;
      state.phase %= 1000;
      state.anchor.copy(this.point);
    }
    if (
      this.settings.dustEnabled &&
      speed > 0.08 &&
      (!this.camera || this.camera.position.distanceTo(wheel.contactPoint) < 35)
    ) {
      state.emission += Math.min(140, 25 + speed * 50) * this.settings.dustAmount * delta;
      const count = Math.min(12, Math.floor(state.emission));
      state.emission %= 1;
      for (let n = 0; n < count; n++)
        this.dust.emit(
          wheel.contactPoint,
          wheel.contactNormal,
          this.direction,
          this.side,
          velocity,
          speed,
          Math.max(0.55, vehicle.scale / 0.5),
        );
    }
    state.previous.copy(this.point);
  }

  /** 清空轮胎历史及路径锚点。 */
  clearTracks() {
    this.atlas.clear('tire');
    this.vehicles.clear();
  }
  /** 换原点时断开旧轮迹段，并平移现存扬尘。 */
  rebase(x, z) {
    this.vehicles.clear();
    this.skipContact = true;
    this.dust.rebase(x, z);
  }
  /** 清理扬尘与车辆状态，并停止车辙生成。 */
  dispose() {
    this.dust.dispose();
    this.vehicles.clear();
    this.atlas.setTracksEnabled(false);
  }
}
