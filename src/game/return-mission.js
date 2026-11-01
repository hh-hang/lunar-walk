import * as THREE from 'three';
import { publicAssetUrl } from '../loaders/asset-url.js';
import { snapExplorationCamera } from '../character/camera.js';
import { heightAt } from '../terrain/height.js';
import { createMissionHUD } from '../ui/mission-hud.js';
import { createFragmentPlan, createMissionPlan, findNearbyLanderSite, ReturnMission } from './mission-state.js';
import { createLanderStages } from './lander-stages.js';
import { createLunarAscent } from './lunar-ascent.js';
import { IGNITION_TIME } from './ascent-profile.js';
/** 登舱 / 采样黑场：先暗、短暂停黑，再变亮；变亮瞬间才切真实结果。 */
const BOARD_FADE_OUT = 0.7;
const BOARD_HOLD = 0.12;
const BOARD_FADE_IN = 0.85;

/** 制作导航碎片的柔光，不增加动态点光源或额外阴影通道。 */
function signalTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const glow = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  glow.addColorStop(0, '#fff4cd');
  glow.addColorStop(0.15, '#ffd783cc');
  glow.addColorStop(1, '#efb34d00');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, 64, 64);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** 用共用几何制作可辨识的破损记录盒；附近的弱信标帮助发现，小地图仍保留标记。 */
function createFragments(state, root) {
  const housing = new THREE.BoxGeometry(0.7, 0.12, 0.46);
  const panel = new THREE.BoxGeometry(0.48, 0.03, 0.3);
  const strip = new THREE.BoxGeometry(0.33, 0.035, 0.035);
  const mast = new THREE.CylinderGeometry(0.012, 0.012, 2.4, 6);
  const metal = new THREE.MeshStandardMaterial({ color: 0x69727a, metalness: 0.7, roughness: 0.5 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x11191d, metalness: 0.3, roughness: 0.7 });
  const amber = new THREE.MeshStandardMaterial({ color: 0xe9bd73, emissive: 0xffbb55, emissiveIntensity: 0.65 });
  const texture = signalTexture();
  return state.fragments.map((fragment, index) => {
    const group = new THREE.Group();
    group.name = `导航碎片-${fragment.id}`;
    const body = new THREE.Mesh(housing, metal);
    body.position.y = 0.08;
    body.rotation.y = index * 1.7 + 0.35;
    body.castShadow = body.receiveShadow = true;
    const face = new THREE.Mesh(panel, dark);
    face.position.y = 0.075;
    body.add(face);
    const indicator = new THREE.Mesh(strip, amber);
    indicator.position.set(0, 0.095, -0.08);
    body.add(indicator);
    const beam = new THREE.Mesh(mast, new THREE.MeshBasicMaterial({ color: 0xf6ce87, transparent: true, opacity: 0.3, depthWrite: false }));
    beam.position.y = 1.25;
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, color: 0xffdf9b }));
    glow.position.y = 2.5;
    glow.scale.setScalar(0.75);
    group.add(body, beam, glow);
    root.add(group);
    return { group, beam, glow, fragment };
  });
}

/** 加载登月舱并组织探索任务、场景道具和返航交互。 */
export async function createReturnMission({ scene, player, controls, terrain, getPosition, loader, onProgress, onRestart, sunlight, footprints }) {
  const state = new ReturnMission(createMissionPlan(heightAt, terrain.rockPlacement?.items));
  const originalSite = { ...state.lander };
  const root = new THREE.Group();
  root.name = '返航任务';
  scene.add(root);
  const { scene: model } = await loader.loadAsync(publicAssetUrl('models/lunar_module.glb'), onProgress);
  const bounds = new THREE.Box3().setFromObject(model);
  // 模型自身已转换为 Y 向上；按人物高度约四倍匹配场景比例，保留原始舱体中心。
  const height = player.playerCapsuleHeight * player.playerModelConfig.scale * 4;
  const scale = height / (bounds.max.y - bounds.min.y);
  const stages = createLanderStages(model, scale, bounds.min.y);
  const lander = new THREE.Group();
  lander.name = '登月舱';
  lander.add(stages.descent, stages.ascent);
  lander.position.set(state.lander.x, state.lander.y + 0.04, state.lander.z);
  lander.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(-state.lander.slopeX, 1, -state.lander.slopeZ).normalize());
  root.add(lander);
  // 加载时只构建一次真实模型 BVH；跟随舱体矩阵即可处理原点平移，不在探索途中重建。
  let collider = player.addCollider({ motion: 'kinematic', shape: { kind: 'mesh', source: lander }, follow: lander });
  const fragments = createFragments(state, root);
  const position = new THREE.Vector3();
  const lookDirection = new THREE.Vector3();
  let originX = 0, originZ = 0, time = 0;
  const launch = createLunarAscent({ lander, stages, player, sunlight });
  /** @type {{ kind: 'board' | 'sample', elapsed: number, committed: boolean, keyboardEnabled: boolean } | null} */
  let transition = null;

  /** 将当前步行或驾驶位置转换为绝对坐标，避免上车和换原点后误拾取。 */
  function worldPosition() {
    position.copy(getPosition());
    position.x += originX;
    position.z += originZ;
    return position;
  }

  /** 黑场结束后切状态、卸碰撞并真正起飞。 */
  function commitBoard() {
    if (!state.startReturn(worldPosition(), player.getControllerMode() === 1)) return false;
    // 登舱后角色已退出探索，不再让原始整舱碰撞体跟随运动的上升级。
    if (collider) player.removeCollider(collider);
    collider = null;
    launch.start();
    return true;
  }

  /** 采样提交：隐藏记录盒，并在月表高度图写入 scoop trench。 */
  function commitSample() {
    const fragment = state.sample(worldPosition(), player.getControllerMode() === 1);
    if (!fragment) return false;
    const item = fragments.find((entry) => entry.fragment === fragment);
    if (!item) return false;
    item.group.visible = false;
    fragment.y = terrain.surfaceHeightAt(fragment.x, fragment.z);
    footprints?.addDig(fragment, fragments.indexOf(item) + 1);
    return true;
  }

  /** 开始黑场过渡；采样与登舱互斥。 */
  function beginTransition(kind) {
    if (transition || state.phase !== 'exploring') return false;
    transition = {
      kind,
      elapsed: 0,
      committed: false,
      keyboardEnabled: player.bindKeyboardEvents !== false,
    };
    player.setInput?.({ moveX: 0, moveY: 0, shift: false, jump: false });
    player.setBindKeyboardEvents?.(false);
    hud.setBoardVeil(0);
    return true;
  }

  /** 按 F / 触屏登舱：先黑场过渡，变亮时才切换真实登舱。 */
  function requestBoard() {
    if (!state.canReturn(worldPosition(), player.getControllerMode() === 1)) return;
    beginTransition('board');
  }

  /** 按 F / 触屏采样：需下车靠近记录点；黑场后露出挖坑。 */
  function requestSample() {
    if (!state.canSample(worldPosition(), player.getControllerMode() === 1)) return;
    beginTransition('sample');
  }

  /** 推进黑场；峰值变亮瞬间 commit，失败则恢复探索控制。 */
  function updateTransition(delta) {
    if (!transition) return;
    transition.elapsed += delta;
    const t = transition.elapsed;
    const darkEnd = BOARD_FADE_OUT + BOARD_HOLD;
    let opacity = 1;
    if (t < BOARD_FADE_OUT) {
      opacity = t / BOARD_FADE_OUT;
    } else if (t < darkEnd) {
      opacity = 1;
    } else {
      if (!transition.committed) {
        transition.committed = true;
        const ok = transition.kind === 'board' ? commitBoard() : commitSample();
        if (!ok) {
          player.setBindKeyboardEvents?.(transition.keyboardEnabled);
          transition = null;
          hud.setBoardVeil(0);
          return;
        }
        if (transition.kind === 'sample') {
          player.setBindKeyboardEvents?.(transition.keyboardEnabled);
        }
      }
      const u = Math.min(1, (t - darkEnd) / BOARD_FADE_IN);
      opacity = 1 - u;
      if (u >= 1) {
        if (transition.kind === 'sample') {
          player.setBindKeyboardEvents?.(transition.keyboardEnabled);
        }
        transition = null;
        hud.setBoardVeil(0);
        return;
      }
    }
    player.setInput?.({ moveX: 0, moveY: 0, shift: false, jump: false });
    hud.setBoardVeil(opacity);
  }

  /** 再探索恢复任务、舱体、碎片、碰撞、人物与 HUD，不重新加载资源。 */
  function restart() {
    const restoreKeyboard = transition?.keyboardEnabled !== false;
    transition = null;
    hud.setBoardVeil(0);
    state.reset(createFragmentPlan(heightAt, originalSite, terrain.rockPlacement?.items ?? []));
    Object.assign(state.lander, originalSite);
    lander.position.set(originalSite.x - originX, originalSite.y + 0.04, originalSite.z - originZ);
    lander.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(-originalSite.slopeX, 1, -originalSite.slopeZ).normalize());
    launch.reset();
    // 登舱过渡 / 起飞都会禁键；重开后无论 launch 是否已 start，都必须恢复探索控制。
    player.setBindKeyboardEvents?.(restoreKeyboard);
    for (const item of fragments) {
      item.group.name = `导航碎片-${item.fragment.id}`;
      item.group.visible = true;
      item.group.userData.placed = false;
    }
    if (!collider) collider = player.addCollider({ motion: 'kinematic', shape: { kind: 'mesh', source: lander }, follow: lander });
    syncLanderCollider();
    onRestart?.();
    player.setInput?.({ moveX: 0, moveY: 0, shift: false, jump: false });
    // 起飞残留空中状态会播 jumpLoop，需强制站立 idle。
    player.reset(new THREE.Vector3(
      -originX,
      heightAt(0, 0) + player.getCapsuleGroundHeight(),
      -originZ,
    ));
    player.animation?.playByName?.('idle', 0);
    player.setOnGround?.(true);
    snapExplorationCamera(player, controls);
    hud.reset();
  }
  const hud = createMissionHUD({ onReturn: requestBoard, onSample: requestSample, onRestart: restart });

  /** 同步已烘焙的碰撞网格并清除平台位移，瞬移登月舱时不拖动人物，也不重建 BVH。 */
  function syncLanderCollider() {
    lander.updateWorldMatrix(true, true);
    const entry = player.getKinematicColliderEntries().find((item) => item.source === lander);
    if (!entry) return;
    entry.mesh.matrix.copy(lander.matrixWorld).multiply(entry.bakeInverse);
    entry.mesh.updateMatrixWorld(true);
    entry.prevWorldMatrix.copy(entry.mesh.matrixWorld);
    entry.deltaPos.set(0, 0, 0);
    entry.deltaRotY = 0;
  }

  /** 临时把登月舱移至身旁并跳过导航限制；关闭后恢复原位置和正常任务规则。 */
  function setDebugBoarding(enabled) {
    if (state.phase !== 'exploring') return false;
    if (state.debugBoarding === enabled) return true;
    let site = originalSite;
    if (enabled) {
      const current = worldPosition();
      player.camera.getWorldDirection(lookDirection);
      const obstacles = [...(terrain.rockPlacement?.items ?? []), ...player.getAllVehicles().map((vehicle) => ({
        x: vehicle.vehicleGroup.position.x + originX, z: vehicle.vehicleGroup.position.z + originZ,
        scale: Math.hypot(vehicle.halfExtents.x, vehicle.halfExtents.z),
      }))];
      site = findNearbyLanderSite((x, z) => terrain.surfaceHeightAt(x, z), current, lookDirection, obstacles);
    }
    state.debugBoarding = enabled;
    Object.assign(state.lander, site);
    lander.position.set(site.x - originX, site.y + 0.04, site.z - originZ);
    lander.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(-site.slopeX, 1, -site.slopeZ).normalize());
    syncLanderCollider();
    return true;
  }

  /** 步行且身旁有可上的静止车辆时，F 优先交给上下车。 */
  function canBoardVehicle() {
    if (player.getControllerMode() === 1 || player.isFlying) return false;
    const position = player.playerCapsule.position;
    for (const vehicle of player.getAllVehicles()) {
      if (!player.vehicle?.isInBoardingRange?.(vehicle, position)) continue;
      const velocity = vehicle.chassisBody.linvel();
      if (Math.hypot(velocity.x, velocity.z) > 0.1) continue;
      return true;
    }
    return false;
  }

  /**
   * 统一 F：上下车 > 采样 > 登舱。
   * 可上下车时不拦截，留给车辆；其余两档捕获阶段拦截。
   */
  function onKeyDown(event) {
    if (event.repeat || event.ctrlKey || event.altKey || event.metaKey) return;
    if (event.target?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName)) return;
    if (event.code !== 'KeyF') return;
    const driving = player.getControllerMode() === 1;
    if (driving || canBoardVehicle()) return;
    const position = worldPosition();
    if (state.canSample(position, driving)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      requestSample();
      return;
    }
    if (state.canReturn(position, driving)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      requestBoard();
    }
  }
  window.addEventListener('keydown', onKeyDown, true);

  /** 未收集记录盒的世界坐标，供小地图绘制。 */
  function getFragmentMarkers() {
    if (state.phase !== 'exploring') return [];
    return state.fragments.filter((fragment) => !fragment.collected).map(({ x, z }) => ({ x, z }));
  }

  /** 同步收集、弱信标与任务文字；登月舱坐标只在解锁后提供给小地图。 */
  function update(nextOriginX, nextOriginZ, delta, terrainChanged = false) {
    originX = nextOriginX;
    originZ = nextOriginZ;
    const current = worldPosition();
    time += delta;
    for (const item of fragments) {
      const { fragment, group, beam, glow } = item;
      group.visible = !fragment.collected;
      if (terrainChanged || !group.userData.placed) {
        fragment.y = terrain.surfaceHeightAt(fragment.x, fragment.z);
        group.position.set(fragment.x - originX, fragment.y + 0.04, fragment.z - originZ);
        group.userData.placed = true;
      }
      // 约 38–65 m 渐显金色弱信标，更近时脉冲更明显。
      const distance = Math.hypot(current.x - fragment.x, current.z - fragment.z);
      const visibility = fragment.collected ? 0 : 1 - THREE.MathUtils.smoothstep(distance, 38, 65);
      glow.visible = beam.visible = visibility > 0;
      glow.material.opacity = visibility * (0.65 + Math.sin(time * 2.5) * 0.2);
      beam.material.opacity = visibility * 0.28;
    }
    const driving = player.getControllerMode() === 1;
    updateTransition(delta);
    // 黑场未结束或调试暂停时不推进返航时钟；暂停时仍按当前时刻重同步舱体。
    const missionDelta = (transition?.kind === 'board' && transition.committed) || (launch.paused && state.phase === 'returning') ? 0 : delta;
    state.update(current, missionDelta);
    launch.update(state.returnElapsed);
    const detachCountdown = !transition && state.phase === 'returning' && state.returnElapsed < IGNITION_TIME
      ? IGNITION_TIME - state.returnElapsed
      : 0;
    const vehicleReady = canBoardVehicle();
    hud.update(state, {
      canReturn: !transition && !vehicleReady && state.canReturn(current, driving),
      canSample: !transition && !vehicleReady && state.canSample(current, driving),
      detachCountdown,
    }, delta);
  }

  /** 随世界原点平移任务道具；绝对坐标和收集进度保持不变。 */
  function rebase(shiftX, shiftZ) {
    originX += shiftX;
    originZ += shiftZ;
    for (const object of root.children) {
      object.position.x -= shiftX;
      object.position.z -= shiftZ;
    }
    syncLanderCollider();
  }

  /** 释放任务自有模型、共用道具资源、碰撞句柄与界面监听。 */
  function dispose() {
    window.removeEventListener('keydown', onKeyDown, true);
    if (collider) player.removeCollider(collider);
    launch.dispose();
    hud.dispose();
    const resources = new Set();
    root.traverse((object) => {
      if (object.geometry) resources.add(object.geometry);
      for (const material of object.material ? Array.isArray(object.material) ? object.material : [object.material] : []) {
        resources.add(material);
        for (const value of Object.values(material)) if (value?.isTexture) resources.add(value);
      }
    });
    for (const resource of resources) resource.dispose();
    root.removeFromParent();
  }
  return {
    state, lander, stages, launch, fragments, update, rebase, restart, dispose, setDebugBoarding,
    getMapTarget: () => state.mapTarget,
    getFragmentMarkers,
    get kaptonFoilEnabled() { return stages.kaptonFoilEnabled; },
    setKaptonFoil: (enabled) => stages.setKaptonFoil(enabled),
  };
}
