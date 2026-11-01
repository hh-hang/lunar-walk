import * as THREE from 'three';

// 控制器距离单位在步行与驾驶模式下都会乘以角色缩放。
export const CAMERA_ZOOM_LIMITS = { min: 100, max: 1600 };
const DRIVING_CAMERA_PITCH_LIMIT = THREE.MathUtils.degToRad(60);
// 偏移使用控制器距离单位，实际位移还需乘以角色缩放。
const DRIVING_FIRST_PERSON_SHIFT = { down: 20, back: 30 };

/** 配置驾驶相机、步行缩放与上下车时的视距恢复。 */
export function configurePlayerCamera(player, canvas, dismissHint) {
  // 每次从原始相机偏移重建，避免切换模式累积位移；第一人称局部 +Z 为前方。
  const nativeSetFirstPerson = player.cam.setFirstPerson;
  player.cam.setFirstPerson = function (...args) {
    nativeSetFirstPerson.apply(this, args);
    if (player.getControllerMode() === 1) {
      const scale = player.playerModelConfig.scale;
      player.camera.position.y -= DRIVING_FIRST_PERSON_SHIFT.down * scale;
      player.camera.position.z -= DRIVING_FIRST_PERSON_SHIFT.back * scale;
    }
  };
  // 保留控制器输入与水平转向处理，将驾驶第一人称俯仰范围扩展到水平线上下。
  const nativeSetToward = player.cam.setToward;
  player.cam.setToward = function (dx, dy, speed) {
    const previousPitch = player.camera.rotation.x;
    nativeSetToward.call(this, dx, dy, speed);
    if (
      player.enableToward &&
      player.getControllerMode() === 1 &&
      player.getIsFirstPerson() &&
      player.getActiveVehicle()
    ) {
      player.camera.rotation.x = THREE.MathUtils.clamp(
        previousPitch - dy * speed * this.sensitivity,
        -DRIVING_CAMERA_PITCH_LIMIT,
        DRIVING_CAMERA_PITCH_LIMIT,
      );
    }
  };
  // 在原生滚轮处理后限制缩放目标，同时适用于步行和驾驶。
  canvas.addEventListener(
    'wheel',
    () => {
      const scale = player.playerModelConfig.scale;
      player.cam.maxDist = THREE.MathUtils.clamp(
        player.cam.maxDist,
        CAMERA_ZOOM_LIMITS.min * scale,
        Math.max(CAMERA_ZOOM_LIMITS.max * scale, player.cam.originMaxDist),
      );
      dismissHint('zoom', true);
    },
    { passive: true },
  );
  // 每次上车只设置一次驾驶距离，之后仍允许滚轮缩放；下车恢复步行距离。
  let walkingCamera = null;
  player.onVehicleEnter = () => {
    const scale = player.playerModelConfig.scale;
    walkingCamera = { distance: player.cam.maxDist / scale, defaultDistance: player.cam.originMaxDist / scale };
    player.setMaxCamDistance(800);
    if (player.getIsFirstPerson()) {
      const rotation = player.camera.rotation.clone();
      player.cam.setFirstPerson();
      player.camera.rotation.copy(rotation);
    }
  };
  player.onVehicleExit = () => {
    if (!walkingCamera) return;
    player.setMaxCamDistance(walkingCamera.defaultDistance);
    player.cam.maxDist = Math.max(player.cam.minDist, walkingCamera.distance * player.playerModelConfig.scale);
    walkingCamera = null;
  };
}

/** 初始视角保留地平线上方天空，不改变玩家朝向。 */
export function setInitialCameraView(camera, controls) {
  const offset = new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target));
  offset.phi = THREE.MathUtils.degToRad(80);
  camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(offset));
  controls.update();
}

/** 重新开始。 */
export function snapExplorationCamera(player, controls) {
  if (player.getIsFirstPerson?.()) player.cam?.changeView?.();
  const rotateY = player.playerModelConfig?.rotateY ?? Math.PI / 2;
  player.playerCapsule.rotation.set(0, rotateY, 0);
  const lookAt = player.cam.getLookAtPoint();
  const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(player.playerCapsule.quaternion);
  const angle = Math.atan2(dir.z, dir.x);
  const scale = player.playerModelConfig.scale;
  const rawOffset = new THREE.Vector3(Math.cos(angle) * 400 * scale, 200 * scale, Math.sin(angle) * 400 * scale);
  controls.target.copy(lookAt);
  player.camera.position.copy(lookAt).add(rawOffset.normalize().multiplyScalar(player.cam.maxDist));
  const offset = new THREE.Spherical().setFromVector3(player.camera.position.clone().sub(controls.target));
  offset.phi = THREE.MathUtils.degToRad(80);
  player.camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(offset));
  player.cam._springVelocity?.set(0, 0, 0);
  player.cam.setOverShoulder?.(player.enableOverShoulderView && !player.getIsFirstPerson?.());
  controls.update();
}
