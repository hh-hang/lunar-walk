import * as THREE from 'three';
import { createGLTFLoader } from '../loaders/gltf-loader.js';
import { publicAssetUrl } from '../loaders/asset-url.js';
import { heightAt } from '../terrain/height.js';
import { createRoverStabilizer } from './rover-stability.js';

export const ROVER_WHEELS = ['Wheel_LF', 'Wheel_RF', 'Wheel_LR', 'Wheel_RR'];
export const ROVER_FENDERS = ['Fender_LF', 'Fender_RF', 'Fender_LR', 'Fender_RR'];
/** 开局停放点（世界坐标）；局部坐标 = 世界 − 浮动原点。 */
export const ROVER_SPAWN = { x: 6, z: -4 };

/** 轮胎接地点高度：落点邻域最高地表 + 微抬，交给 loadVehicleModel / 底盘换算。 */
export function roverSpawnHeight(worldX = ROVER_SPAWN.x, worldZ = ROVER_SPAWN.z) {
  return Math.max(
    ...[-2, 0, 2].flatMap((dx) => [-3, 0, 3].map((dz) => heightAt(worldX + dx, worldZ + dz))),
  ) + 0.02;
}

/** 与 three-player-controller 一致：position.y 为轮胎底，底盘中心 = 轮胎底 − minTireBottom。 */
export function roverChassisY(vehicle, worldX = ROVER_SPAWN.x, worldZ = ROVER_SPAWN.z) {
  return roverSpawnHeight(worldX, worldZ) + vehicle.halfExtents.y + vehicle.chassisClearance * vehicle.scale;
}

// 车漆、太阳能板和黄色隔热膜共用贴图材质，通过底色识别隔热膜，单独调整反射响应。
const ROVER_SURFACES = {
  Chassis: { metalness: 0.28, roughness: 0.46, film: true },
  FrontParts: { metalness: 0.04, roughness: 0.58, film: true },
  BackParts: { metalness: 0.04, roughness: 0.58, film: true },
  ControlPanel: { metalness: 0.08, roughness: 0.5 },
  Seats: { metalness: 0.02, roughness: 0.75 },
  Damping: { metalness: 0.5, roughness: 0.4 },
  Wheels: { metalness: 0.74, roughness: 0.36 },
  Fenders: { metalness: 0.06, roughness: 0.32 },
  Antenne: { metalness: 0.86, roughness: 0.3 },
  Kameralinse: { metalness: 0.04, roughness: 0.08 },
};

/** 按贴图中的黄色区域注入隔热膜金属度与粗糙度。 */
export function addThermalFilm(material) {
  const previousCompile = material.onBeforeCompile,
    previousKey = material.customProgramCacheKey?.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    previousCompile?.call(material, shader, renderer);
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <metalnessmap_fragment>',
      `#include <metalnessmap_fragment>
      {
        float yellowness=smoothstep(0.05,0.16,diffuseColor.r-diffuseColor.b);
        float warmth=smoothstep(0.10,0.22,diffuseColor.r)*smoothstep(0.08,0.18,diffuseColor.g);
        float film=yellowness*warmth*(1.0-smoothstep(0.08,0.20,diffuseColor.b));
        metalnessFactor=mix(metalnessFactor,0.45,film);
        roughnessFactor=mix(roughnessFactor,0.28,film);
      }`,
    );
  };
  material.customProgramCacheKey = () => `${previousKey?.() ?? ''}|rover-film`;
  material.userData.lunarThermalFilm = true;
  material.needsUpdate = true;
}

/** 将归一化交错顶点展开为浮点缓冲，供碰撞烘焙使用。 */
function unpackColliderGeometry(root) {
  root.traverse((object) => {
    const geometry = object.geometry;
    const position = geometry?.getAttribute?.('position');
    if (!object.isMesh || !position) return;
    if (!position.isInterleavedBufferAttribute && !position.normalized) return;
    const next = new THREE.BufferGeometry();
    for (const name of Object.keys(geometry.attributes)) {
      const attribute = geometry.getAttribute(name);
      const array = new Float32Array(attribute.count * attribute.itemSize);
      for (let i = 0; i < attribute.count; i++)
        for (let k = 0; k < attribute.itemSize; k++) array[i * attribute.itemSize + k] = attribute.getComponent(i, k);
      next.setAttribute(name, new THREE.BufferAttribute(array, attribute.itemSize));
    }
    if (geometry.index) next.setIndex(geometry.index.clone());
    for (const group of geometry.groups) next.addGroup(group.start, group.count, group.materialIndex);
    object.geometry = next;
  });
}

/** 设置车辆各部位的材质响应，并独立处理挡泥板。 */
export function assignRoverMaterials(root) {
  const prepared = new Set();
  root.traverse((object) => {
    if (!object.isMesh) return;
    const source = Array.isArray(object.material) ? object.material : [object.material];
    const materials = source.map((material) => {
      if (material.name === 'Wheels' && object.name.startsWith('Fender_')) {
        const fender = material.clone();
        fender.name = 'Fenders';
        return fender;
      }
      return material;
    });
    object.material = Array.isArray(object.material) ? materials : materials[0];
    for (const material of materials) {
      const surface = ROVER_SURFACES[material.name];
      if (!surface || prepared.has(material)) continue;
      prepared.add(material);
      material.metalness = surface.metalness;
      material.roughness = surface.roughness;
      if (surface.film) addThermalFilm(material);
    }
  });
}

/** 让四个挡泥板跟随对应轮毂、转向和悬挂，排除轮胎自转。 */
function bindRoverFenders(vehicle) {
  const group = vehicle.vehicleGroup,
    up = new THREE.Vector3(0, 1, 0);
  group.updateWorldMatrix(true, true);
  const bindings = ROVER_FENDERS.map((name, index) => {
    const fender = group.getObjectByName(name);
    // 挡泥板使用独立轮毂支点，仅跟随转向和悬挂，不继承轮胎自转。
    const wheel = group.getObjectByName(ROVER_WHEELS[index]).parent;
    const pivot = new THREE.Group();
    pivot.name = `${name}_steering`;
    pivot.position.copy(wheel.position);
    group.add(pivot);
    pivot.attach(fender); // 保留模型原始朝向和缩放。
    return { pivot, wheel };
  });
  const updateWheels = vehicle.updateWheelVisuals.bind(vehicle);
  vehicle.updateWheelVisuals = (delta) => {
    updateWheels(delta);
    for (const [index, { pivot, wheel }] of bindings.entries()) {
      // 读取悬挂平滑后的实际可见轮毂位置。
      pivot.position.copy(wheel.position);
      pivot.quaternion.setFromAxisAngle(up, vehicle.vehicleController.wheelSteering(index) ?? 0);
    }
  };
}

/** 加载月球车并配置轮组、座椅、悬挂、驱动和防翻车约束。 */
export async function loadLunarRover(player, loader = createGLTFLoader(), onProgress) {
  const gltf = await loader.loadAsync(publicAssetUrl('models/lunar_rove.glb'), onProgress);
  for (const name of [...ROVER_WHEELS, ...ROVER_FENDERS])
    if (!gltf.scene.getObjectByName(name)) throw new Error(`月球车缺少轮组节点：${name}`);
  assignRoverMaterials(gltf.scene);
  unpackColliderGeometry(gltf.scene);
  gltf.scene.traverse((object) => {
    if (!object.isMesh) return;
    object.castShadow = object.receiveShadow = true;
    for (const material of Array.isArray(object.material) ? object.material : [object.material])
      if (material.side === THREE.DoubleSide && material.shadowSide === null) material.shadowSide = THREE.BackSide;
  });
  const { x, z } = ROVER_SPAWN;
  const vehicle = await player.loadVehicleModel({
    model: gltf.scene,
    position: new THREE.Vector3(x, roverSpawnHeight(), z),
    wheelsNames: [...ROVER_WHEELS],
    scale: 0.4,
    driverSeatRotation: -Math.PI / 2,
    driverSeatPosition: new THREE.Vector3(0.35, 1.15, 0.55),
    followVehicleDirection: false,
    suspension: {
      rollInfluence: 0.02,
      stiffness: 12,
    },
    chassis: {
      clearance: 0.7,
      sizeScale: {
        x: 0.8,
        y: 0.5,
        z: 0.8,
      },
    },
    power: {
      maxSpeed: 60,
      acceleration: 5,
      deceleration: 5,
    },
  });
  if (!vehicle) throw new Error('月球车初始化失败');
  vehicle.vehicleGroup.name = 'Lunar rover';
  vehicle.stability = createRoverStabilizer(vehicle.chassisBody);
  bindRoverFenders(vehicle);
  // 模型原始前向沿 +X；从实际轴距推导轮轴方向，让驱动力与轮胎自转都跟随车头。
  const axle = new THREE.Vector3().crossVectors(vehicle.forwardLocal, new THREE.Vector3(0, 1, 0)).normalize();
  for (let i = 0; i < 4; i++) vehicle.vehicleController.setWheelAxleCs(i, axle);
  // 停放车辆可能位于已卸载地形上，地面碰撞恢复前冻结物理，防止坠落。
  const update = vehicle.vehicleController.updateVehicle.bind(vehicle.vehicleController);
  vehicle.vehicleController.updateVehicle = (delta, meshes) => {
    if (!meshes.length && (player.getControllerMode() !== 1 || player.getActiveVehicle() !== vehicle)) {
      vehicle.chassisBody.setLinvel({ x: 0, y: 0, z: 0 });
      vehicle.chassisBody.setAngvel({ x: 0, y: 0, z: 0 });
      vehicle.stability.constrain();
      return;
    }
    vehicle.stability.constrain(delta);
    update(delta, meshes);
    // 在碰撞与连续碰撞检测完成后再次限制倾角，确保可见车身和驾驶员同步前不会翻转。
    vehicle.stability.constrain();
  };
  return vehicle;
}

/** 读取步行或驾驶时胶囊体的实际世界位置。 */
export function explorationPosition(player, target = new THREE.Vector3()) {
  // 上车后胶囊体挂到座椅下，必须读取世界坐标，不能使用座椅局部坐标。
  return player.getPlayerCapsule().getWorldPosition(target);
}

/**
 * 撞到复杂静态网格后底盘偶发穿月表；若中心明显低于地表则抬回可驾驶高度。
 * world = local + 浮动原点。
 */
export function rescueSunkenRovers(player, { originX = 0, originZ = 0 } = {}) {
  for (const vehicle of player.getAllVehicles()) {
    const position = vehicle.chassisBody.position;
    const worldX = position.x + originX;
    const worldZ = position.z + originZ;
    const ground = heightAt(worldX, worldZ);
    if (position.y >= ground - 0.35) continue;
    const y = roverChassisY(vehicle, worldX, worldZ);
    position.y = y;
    vehicle.chassisBody.setLinvel({ x: 0, y: 0, z: 0 });
    vehicle.chassisBody.setAngvel({ x: 0, y: 0, z: 0 });
    vehicle.vehicleGroup.position.copy(position);
    vehicle.vehicleGroup.quaternion.copy(vehicle.chassisBody.quaternion);
    vehicle.vehicleGroup.updateMatrixWorld(true);
    vehicle.stability?.constrain?.();
  }
}

/** 重新开始：下车并把所有月球车送回默认停放点，清零速度与姿态。 */
export function resetRovers(player, { originX = 0, originZ = 0 } = {}) {
  if (player.getControllerMode?.() === 1) {
    player.setInput?.({ toggleVehicle: true, moveX: 0, moveY: 0, shift: false, jump: false });
  }
  const x = ROVER_SPAWN.x - originX;
  const z = ROVER_SPAWN.z - originZ;
  const groups = new Set();
  for (const vehicle of player.getAllVehicles()) {
    const y = roverChassisY(vehicle);
    vehicle.chassisBody.position.set(x, y, z);
    vehicle.chassisBody.quaternion.identity();
    vehicle.chassisBody.setLinvel({ x: 0, y: 0, z: 0 });
    vehicle.chassisBody.setAngvel({ x: 0, y: 0, z: 0 });
    vehicle.vehicleGroup.position.set(x, y, z);
    vehicle.vehicleGroup.quaternion.identity();
    vehicle.vehicleGroup.updateMatrixWorld(true);
    vehicle.stability?.constrain?.();
    groups.add(vehicle.vehicleGroup);
  }
  for (const entry of player.getKinematicColliderEntries?.() ?? []) {
    if (!groups.has(entry.source)) continue;
    entry.mesh.matrix.copy(entry.source.matrixWorld);
    if (entry.bakeInverse) entry.mesh.matrix.multiply(entry.bakeInverse);
    entry.mesh.updateMatrixWorld(true);
    entry.prevWorldMatrix.copy(entry.mesh.matrixWorld);
    entry.deltaPos.set(0, 0, 0);
    entry.deltaRotY = 0;
  }
}

/** 同步平移车辆、驾驶员及碰撞历史，保留当前速度。 */
export function rebaseRovers(player, shiftX, shiftZ) {
  const groups = new Set();
  for (const vehicle of player.getAllVehicles()) {
    vehicle.chassisBody.position.x -= shiftX;
    vehicle.chassisBody.position.z -= shiftZ;
    vehicle.vehicleGroup.position.x -= shiftX;
    vehicle.vehicleGroup.position.z -= shiftZ;
    vehicle.vehicleGroup.updateMatrixWorld(true);
    groups.add(vehicle.vehicleGroup);
  }
  // 同步平移碰撞体的上一帧变换，避免将原点切换误判为平台瞬间移动数千米。
  for (const entry of player.getKinematicColliderEntries())
    if (groups.has(entry.source)) {
      entry.mesh.matrix.elements[12] -= shiftX;
      entry.mesh.matrix.elements[14] -= shiftZ;
      entry.mesh.updateMatrixWorld(true);
      entry.prevWorldMatrix.copy(entry.mesh.matrixWorld);
      entry.deltaPos.set(0, 0, 0);
      entry.deltaRotY = 0;
    }
}
