import * as THREE from 'three';

export const ROVER_STABILITY_DEFAULTS = Object.freeze({
  enabled: true,
  maxTiltDegrees: 35,
  tiltDamping: 6,
  maxTiltSpeedDegrees: 90,
});

/** 创建保留航向的车身倾角与角速度约束。 */
export function createRoverStabilizer(body, options = {}) {
  const settings = { ...ROVER_STABILITY_DEFAULTS, ...options };
  const worldUp = new THREE.Vector3(0, 1, 0),
    up = new THREE.Vector3(),
    axis = new THREE.Vector3();
  const yaw = new THREE.Quaternion(),
    swing = new THREE.Quaternion(),
    identity = new THREE.Quaternion();
  return {
    settings,
    /** 限制侧倾、俯仰和向外翻转速度，保留水平转向与线速度。 */
    constrain(delta = 0) {
      if (!settings.enabled) return;
      const rotation = body.rotation(),
        velocity = body.angvel();
      // 只抑制俯仰和侧倾，保留绕世界 Y 轴的转向响应。
      const damping = Math.exp(-Math.max(0, settings.tiltDamping) * Math.max(0, delta));
      velocity.x *= damping;
      velocity.z *= damping;
      const speed = Math.hypot(velocity.x, velocity.z);
      const maxSpeed = THREE.MathUtils.degToRad(Math.max(0, settings.maxTiltSpeedDegrees));
      if (speed > maxSpeed) {
        velocity.x *= maxSpeed / speed;
        velocity.z *= maxSpeed / speed;
      }

      up.copy(worldUp).applyQuaternion(rotation);
      const tilt = Math.acos(THREE.MathUtils.clamp(up.y, -1, 1));
      const limit = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(settings.maxTiltDegrees, 0, 60));
      // 分离倾斜与航向旋转，限制倾角时保留朝向；完全倒置时沿用上次有效航向。
      if (rotation.y * rotation.y + rotation.w * rotation.w > 1e-12) yaw.set(0, rotation.y, 0, rotation.w).normalize();
      if (tilt > limit) {
        swing.setFromUnitVectors(worldUp, up);
        swing.slerp(identity, 1 - limit / tilt);
        body.setRotation(swing.multiply(yaw));
        up.copy(worldUp).applyQuaternion(body.rotation());
      }
      if (limit === 0) {
        velocity.x = velocity.z = 0;
      } else if (tilt >= limit - 1e-8) {
        // 只移除继续向外翻转的角速度，车辆仍可转向并立即向水平姿态回正。
        axis.crossVectors(worldUp, up).normalize();
        const outward = velocity.dot(axis);
        if (outward > 0) velocity.addScaledVector(axis, -outward);
      }
    },
  };
}
