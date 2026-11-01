import * as THREE from 'three';
import skySnapshot from '../environment/sky-snapshot.json' with { type: 'json' };
import { MAP_RANGE, MAX_MAP_RANGE, MinimapTerrain } from './minimap-terrain.js';

const PAD = 14;
const TAU = Math.PI * 2;
const ARROW = [
  [0, -8],
  [5, 6],
  [0, 3.5],
  [-5, 6],
];

// 与天空快照一致：+X 东，+Z 南；未旋转的底图北朝上，画布向下对应 +Z。
export const COMPASS = [
  { id: 'N', x: 0, y: -1 },
  { id: 'E', x: 1, y: 0 },
  { id: 'S', x: 0, y: 1 },
  { id: 'W', x: -1, y: 0 },
];
export const COMPASS_LABELS = { N: 'N', E: 'E', S: 'S', W: 'W' };

/** 校验场景轴向后返回方位字母。 */
export function compassLabels() {
  if (skySnapshot.axes?.x !== 'east' || skySnapshot.axes?.z !== 'south') {
    throw new Error('小地图要求世界 +X 为东、+Z 为南');
  }
  return COMPASS_LABELS;
}

/** 读取步行胶囊或驾驶车身在水平面上的朝向角。 */
export function facingYaw(player, forward = new THREE.Vector3()) {
  if (player.getControllerMode() === 1) {
    const vehicle = player.getActiveVehicle();
    if (vehicle?.forwardLocal) {
      forward.copy(vehicle.forwardLocal).applyQuaternion(vehicle.chassisBody.quaternion);
      return Math.atan2(forward.x, forward.z);
    }
  }
  forward.set(0, 0, 1).applyQuaternion(player.playerCapsule.quaternion);
  return Math.atan2(forward.x, forward.z);
}

/** 读取相机的世界水平朝向；接近垂直俯仰时沿用上一朝向，避免方位抖动。 */
export function cameraYaw(camera, previousYaw = 0, forward = new THREE.Vector3()) {
  if (!camera) return previousYaw;
  camera.getWorldDirection(forward);
  return Math.hypot(forward.x, forward.z) < 0.01 ? previousYaw : Math.atan2(forward.x, forward.z);
}

/** 按镜头前向和右向投影世界偏移；观察 +Z 时，屏幕右侧对应世界 -X。 */
export function worldToMap(x, z, yaw, scale = 1, offsetY = 0) {
  return {
    x: (-x * Math.cos(yaw) + z * Math.sin(yaw)) * scale,
    y: (-x * Math.sin(yaw) - z * Math.cos(yaw)) * scale + offsetY,
  };
}

/** 投影目标相对坐标；驾驶缩放和玩家偏移后，仍按圆形可见边界限制标记。 */
export function mapMarker(x, z, yaw, radius, range = MAP_RANGE, offsetY = 0) {
  const { x: px, y: py } = worldToMap(x, z, yaw, radius / range, offsetY);
  const length = Math.hypot(px, py);
  const limit = radius - 12;
  const factor = length > limit ? limit / length : 1;
  return {
    x: px * factor,
    y: py * factor,
    angle: Math.atan2(px, -py),
    offscreen: length > radius,
  };
}

/** 以正立侧视车形表示车辆位置，标记不随车头旋转，便于一眼识别。 */
function drawVehicleMark(ctx) {
  ctx.strokeStyle = '#101619';
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(-7, 2);
  ctx.lineTo(-7, -1);
  ctx.lineTo(-4, -2);
  ctx.lineTo(-2, -5);
  ctx.lineTo(3, -5);
  ctx.lineTo(5, -2);
  ctx.lineTo(7, -1);
  ctx.lineTo(7, 2);
  ctx.closePath();
  ctx.stroke();
  ctx.fillStyle = '#d2dad6';
  ctx.fill();
  ctx.fillStyle = '#253135';
  ctx.fillRect(-2, -4, 5, 2);
  for (const x of [-4, 4]) {
    ctx.beginPath();
    ctx.arc(x, 2, 2, 0, TAU);
    ctx.fill();
  }
}

/** 绘制可辨认的舱体和支腿，与车辆的侧视图标区分。 */
function drawLanderMark(ctx) {
  ctx.fillStyle = '#11191de6';
  ctx.beginPath();
  ctx.arc(0, 0, 10, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = '#efcf91';
  ctx.fillStyle = '#efcf91';
  ctx.lineWidth = 1.6;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(-4, 0);
  ctx.lineTo(-4, -3);
  ctx.lineTo(-2, -6);
  ctx.lineTo(2, -6);
  ctx.lineTo(4, -3);
  ctx.lineTo(4, 0);
  ctx.closePath();
  ctx.stroke();
  ctx.fillRect(-3.5, 0, 7, 3);
  ctx.beginPath();
  for (const side of [-1, 1]) {
    ctx.moveTo(side * 3, 1);
    ctx.lineTo(side * 7, 7);
    ctx.moveTo(side * 5, 7);
    ctx.lineTo(side * 9, 7);
  }
  ctx.stroke();
}

/** 导航记录：小圆形标记，与登月舱侧视图标区分。 */
function drawFragmentMark(ctx) {
  ctx.fillStyle = '#11191de6';
  ctx.beginPath();
  ctx.arc(0, 0, 7, 0, TAU);
  ctx.fill();
  ctx.fillStyle = '#e9bd73';
  ctx.strokeStyle = '#f3d9a4';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.arc(0, 0, 3.2, 0, TAU);
  ctx.fill();
  ctx.stroke();
}

/** 在地图外缘提示超出显示范围的目标方向。 */
function drawEdgePointer(ctx, angle, radius, color) {
  ctx.save();
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(0, -radius + 2);
  ctx.lineTo(3, -radius + 6);
  ctx.lineTo(-3, -radius + 6);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

/** 创建跟随镜头转动的圆形地图，箭头独立表示人物或车头的实际朝向。 */
export function createMinimap(player, {
  getLocalXZ, camera, renderer, terrain, scene, sunlight,
  getObjective = () => null,
  getFragments = () => [],
}) {
  const root = document.createElement('div');
  root.className = 'minimap';
  root.setAttribute('aria-hidden', 'true');
  const canvas = document.createElement('canvas');
  root.append(canvas);
  document.querySelector('.hud')?.append(root);
  const ctx = canvas.getContext('2d');
  const mapTerrain = new MinimapTerrain(renderer, terrain, { sunlight, environment: scene.environment });
  const labels = compassLabels();
  const forward = new THREE.Vector3();
  const cameraForward = new THREE.Vector3();
  let size = 199;
  let dpr = 1;
  let range = MAP_RANGE;
  let mapYaw = cameraYaw(camera, facingYaw(player, forward), cameraForward);

  /** 按实际 CSS 尺寸分配画布，使图标和字母不随地图缩小。 */
  function resize() {
    size = root.getBoundingClientRect().width;
    dpr = Math.min(devicePixelRatio || 1, 2);
    const pixels = Math.round(size * dpr);
    // 重复的尺寸通知不能清空已绘制地图，避免进入场景时闪成空白。
    if (canvas.width !== pixels || canvas.height !== pixels) canvas.width = canvas.height = pixels;
  }
  const observer = new ResizeObserver(resize);
  observer.observe(root);
  resize();

  /** 绘制停放车辆；与登月舱 / 采样点同一套相对投影，超出范围时外指。 */
  function drawVehicles(localX, localZ, yaw, radius, offsetY) {
    for (const vehicle of player.getAllVehicles()) {
      if (player.getControllerMode() === 1 && player.getActiveVehicle() === vehicle) continue;
      const marker = mapMarker(
        vehicle.vehicleGroup.position.x - localX,
        vehicle.vehicleGroup.position.z - localZ,
        yaw,
        radius,
        range,
        offsetY,
      );
      ctx.save();
      ctx.translate(marker.x, marker.y);
      drawVehicleMark(ctx);
      ctx.restore();
      if (marker.offscreen) drawEdgePointer(ctx, marker.angle, radius, '#e3dfca');
    }
  }

  /** 复用缓存底图平滑平移；所有采样保持绝对坐标，兼容浮动原点。 */
  function update(nextOriginX = 0, nextOriginZ = 0, delta = 1 / 60, terrainChanged = false) {
    const { x: localX, z: localZ } = getLocalXZ();
    const worldX = localX + nextOriginX;
    const worldZ = localZ + nextOriginZ;
    mapTerrain.update(worldX, worldZ, nextOriginX, nextOriginZ, delta, terrainChanged);
    if (dpr !== Math.min(devicePixelRatio || 1, 2)) resize();
    // 地图直接跟随实际镜头，不另加转向插值；人物转身只改变箭头方向。
    const playerYaw = facingYaw(player, forward);
    mapYaw = cameraYaw(camera, mapYaw, cameraForward);
    const yaw = mapYaw;
    const vehicle = player.getControllerMode() === 1 ? player.getActiveVehicle() : null;
    const velocity = vehicle?.chassisBody.linvel();
    const targetRange = velocity
      ? Math.min(MAX_MAP_RANGE, 84 + Math.hypot(velocity.x, velocity.z) * 2)
      : MAP_RANGE;
    // 只有驾驶缩放缓动，方向始终直接更新；切换模式时避免底图突然跳大。
    range = THREE.MathUtils.damp(range, targetRange, 6, Math.min(delta, 0.1));
    const half = size / 2;
    const radius = half - PAD;
    const scale = radius / range;
    const offsetY = radius * 0.16;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.translate(half, half);
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, TAU);
    ctx.clip();
    ctx.fillStyle = '#1a1e20';
    ctx.fillRect(-radius, -radius, radius * 2, radius * 2);
    ctx.save();
    // 玩家略靠后，前方多留出可见距离；世界采样仍围绕绝对位置缓存。
    ctx.translate(0, offsetY);
    // 北朝上的底图随镜头旋转；此角度与 worldToMap 的投影保持一致。
    ctx.rotate(yaw - Math.PI);
    ctx.drawImage(
      mapTerrain.canvas,
      (mapTerrain.x - worldX - mapTerrain.extent / 2) * scale,
      (mapTerrain.z - worldZ - mapTerrain.extent / 2) * scale,
      mapTerrain.extent * scale,
      mapTerrain.extent * scale,
    );
    ctx.restore();
    drawVehicles(localX, localZ, yaw, radius, offsetY);
    for (const fragment of getFragments()) {
      const marker = mapMarker(fragment.x - worldX, fragment.z - worldZ, yaw, radius, range, offsetY);
      ctx.save();
      ctx.translate(marker.x, marker.y);
      drawFragmentMark(ctx);
      ctx.restore();
      if (marker.offscreen) drawEdgePointer(ctx, marker.angle, radius, '#e9bd73');
    }
    // 解锁前没有登月舱坐标，底图捕获也只含地形和岩石，不会提前泄露舱体。
    const objective = getObjective();
    if (objective) {
      const marker = mapMarker(objective.x - worldX, objective.z - worldZ, yaw, radius, range, offsetY);
      ctx.save();
      ctx.translate(marker.x, marker.y);
      drawLanderMark(ctx);
      ctx.restore();
      if (marker.offscreen) drawEdgePointer(ctx, marker.angle, radius, '#efcf91');
    }
    ctx.restore();

    // 底图与标记用径向羽化收边，替代硬裁切圆环。
    ctx.save();
    ctx.globalCompositeOperation = 'destination-in';
    const feather = ctx.createRadialGradient(half, half, radius * 0.72, half, half, radius);
    feather.addColorStop(0, '#ffffffff');
    feather.addColorStop(1, '#00000000');
    ctx.fillStyle = feather;
    ctx.fillRect(0, 0, size, size);
    ctx.restore();

    ctx.save();
    ctx.translate(half, half);
    ctx.font = '500 10px Inter,ui-sans-serif,system-ui,sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const north = COMPASS[0];
    const { x: northX, y: northY } = worldToMap(north.x, north.y, yaw, radius - 14);
    ctx.beginPath();
    ctx.arc(northX, northY, 6.5, 0, TAU);
    ctx.fillStyle = '#11191de6';
    ctx.fill();
    ctx.fillStyle = '#e5e9df';
    ctx.fillText(labels.N, northX, northY);
    // 箭头使用人物相对镜头的角度，与底图采用同一坐标变换。
    ctx.translate(0, offsetY);
    ctx.rotate(yaw - playerYaw);
    ctx.beginPath();
    for (const [i, [x, y]] of ARROW.entries()) {
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#101619';
    ctx.stroke();
    ctx.fillStyle = '#f3f4ed';
    ctx.fill();
    ctx.restore();
  }

  /** 解除尺寸监听并移除地图节点。 */
  function dispose() {
    observer.disconnect();
    mapTerrain.dispose();
    root.remove();
  }

  return { update, dispose };
}
