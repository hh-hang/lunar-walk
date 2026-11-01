import * as THREE from 'three';
import { AscentExhaust } from '../rendering/ascent-exhaust.js';
import { sampleAscent } from './ascent-profile.js';

const ASCENT_CAM_DISTANCE = 2000;
/** 起飞过场用更短的级联覆盖，避免远距镜头把阴影精度摊没。 */
const ASCENT_SHADOW_FAR = 150;
/** 过场临时加大法线偏移，减轻舱体大平面自阴影摩尔纹。 */
const ASCENT_SHADOW_NORMAL_BIAS = 0.5;

/** 调度分离、起飞与转向；玩家坐标跟随上升级，视角仍由角色控制器处理。 */
export function createLunarAscent({ lander, stages, player, sunlight }) {
  const { ascent, nozzle, pivot } = stages;
  const effects = new AscentExhaust(ascent, nozzle, lander, { nozzleRadius: stages.nozzleRadius });
  const initialRotation = lander.quaternion.clone();
  const desiredRotation = new THREE.Quaternion();
  const uprightRotation = new THREE.Quaternion();
  const pitchRotation = new THREE.Quaternion();
  const inverseRotation = initialRotation.clone().invert();
  const tiltAxis = new THREE.Vector3(0, 0, -1);
  const rotatedPivot = new THREE.Vector3(), offset = new THREE.Vector3(), seat = new THREE.Vector3();
  let started = false, paused = false, wasVisible = true, keyboardEnabled = true;
  let savedCamDistance = 300, wasFirstPerson = false, savedShadowFar = 50, savedNormalBias = 0;

  /** 把胶囊钉在上升级座位点，并清掉可能残留的移动输入。 */
  function syncPlayer() {
    seat.copy(pivot).applyMatrix4(ascent.matrixWorld);
    player.reset(seat);
    player.setInput?.({ moveX: 0, moveY: 0, shift: false, jump: false });
  }

  /** 隐藏舱内宇航员模型，只禁键盘移动，保留插件视角。 */
  function start() {
    if (started) return;
    started = true;
    // 调试时登月舱可能换过位置与坡面姿态，起飞基准必须取当前值。
    initialRotation.copy(lander.quaternion);
    inverseRotation.copy(initialRotation).invert();
    effects.root.quaternion.copy(inverseRotation);
    wasVisible = player.playerModel.visible;
    player.playerModel.visible = false;
    // 登舱黑场可能已先关掉键盘；恢复目标固定为开，避免把 false 记成重开状态。
    keyboardEnabled = true;
    player.setBindKeyboardEvents(false);
    const scale = player.playerModelConfig?.scale || 1;
    savedCamDistance = player.cam?.originMaxDist ? player.cam.originMaxDist / scale : 300;
    wasFirstPerson = Boolean(player.getIsFirstPerson?.());
    // 第一人称看不到拉远效果，起飞时切到第三人称以套用远距镜头。
    if (wasFirstPerson) player.cam?.changeView?.();
    player.setMaxCamDistance(ASCENT_CAM_DISTANCE);
    if (sunlight?.shadow) {
      savedShadowFar = sunlight.shadow.camera.far;
      savedNormalBias = sunlight.shadow.normalBias;
      sunlight.shadow.camera.far = ASCENT_SHADOW_FAR;
      sunlight.shadow.normalBias = ASCENT_SHADOW_NORMAL_BIAS;
    }
    lander.updateWorldMatrix(true, true);
    syncPlayer();
  }

  /** 先竖直离台，再转向；每帧把玩家同步到上升级，避免物理把人拽走。 */
  function update(elapsed) {
    if (!started) return null;
    const profile = sampleAscent(elapsed);
    // 地形微倾斜只在离台后缓慢回正，避免整个下降级随飞船移动。
    const upright = THREE.MathUtils.smoothstep(profile.flightTime, 0, 2);
    desiredRotation.copy(initialRotation).slerp(uprightRotation, upright);
    pitchRotation.setFromAxisAngle(tiltAxis, profile.pitch);
    desiredRotation.premultiply(pitchRotation);
    ascent.quaternion.multiplyQuaternions(inverseRotation, desiredRotation);
    offset.set(profile.distance, profile.height, 0).applyQuaternion(inverseRotation);
    // 绕舱体重心转动，不能绕月面原点甩动整个上升级。
    rotatedPivot.copy(pivot).applyQuaternion(ascent.quaternion);
    ascent.position.copy(offset).add(pivot).sub(rotatedPivot);
    effects.update(profile);
    lander.updateWorldMatrix(true, true);
    syncPlayer();
    return profile;
  }

  /** 恢复探索阴影级联与法线偏移。 */
  function restoreShadow() {
    if (!sunlight?.shadow) return;
    sunlight.shadow.camera.far = savedShadowFar;
    sunlight.shadow.normalBias = savedNormalBias;
  }

  /** 暂停 / 继续上升级过场；暂停时任务侧冻结 returnElapsed，本帧仍按当前姿态重同步。 */
  function setPaused(value) {
    paused = Boolean(value);
  }

  /** 再探索时收回上升级并恢复键盘、视距与阴影，保留已预编译的喷流资源。 */
  function reset() {
    paused = false;
    if (!started) return;
    effects.reset();
    ascent.position.set(0, 0, 0);
    ascent.quaternion.identity();
    player.playerModel.visible = wasVisible;
    player.setBindKeyboardEvents(keyboardEnabled);
    player.setMaxCamDistance(savedCamDistance);
    restoreShadow();
    if (wasFirstPerson && !player.getIsFirstPerson?.()) player.cam?.changeView?.();
    started = false;
  }

  /** 销毁时恢复人物可见性、键盘、视距与阴影。 */
  function dispose() {
    effects.dispose();
    if (!started) return;
    player.playerModel.visible = wasVisible;
    player.setBindKeyboardEvents(keyboardEnabled);
    player.setMaxCamDistance(savedCamDistance);
    restoreShadow();
    if (wasFirstPerson && !player.getIsFirstPerson?.()) player.cam?.changeView?.();
  }
  return {
    start, update, reset, dispose, effects, setPaused,
    get active() { return started; },
    get paused() { return paused; },
  };
}
