import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';
import { smoothNoise } from './height.js';
import { addGravelLodShader } from './gravel.js';

export const ROCK_LOD_BANDS = [
  [0, 20],
  [14, 80],
  [56, Infinity],
];
/** 根据岩石尺寸调整细节等级切换距离。 */
export const rockDetailScale = (scale) => Math.min(3.5, Math.max(0.5, scale / 0.6));

/** 为岩石设置按尺寸变化的距离过渡。 */
export function addRockLodShader(material, focus, level) {
  return addGravelLodShader(material, focus, level, { near: [14, 20], far: [56, 80], sizeScaled: true });
}

/** 生成有断裂起伏的岩石几何，并合并法线。 */
export function createRockGeometry(variant, detail) {
  const source = new THREE.IcosahedronGeometry(1, detail);
  const position = source.getAttribute('position');
  const point = new THREE.Vector3();
  const cuts = [
    new THREE.Vector3(0.8, 0.45, 0.25),
    new THREE.Vector3(-0.5, 0.65, -0.6),
    new THREE.Vector3(-0.7, 0.15, 0.75),
    new THREE.Vector3(0.15, -0.4, -0.9),
  ];
  for (const cut of cuts) cut.normalize().applyAxisAngle(THREE.Object3D.DEFAULT_UP, variant * 1.9);
  for (let i = 0; i < position.count; i++) {
    point.fromBufferAttribute(position, i);
    let radius = 0.77 + smoothNoise(point.x * 2.6 + variant * 5, point.z * 2.6 + point.y, 930) * 0.38;
    radius += (smoothNoise(point.x * 7.4 + point.y * 2.1, point.z * 8.1 - point.y + variant * 3, 932) - 0.5) * 0.11;
    for (let c = 0; c < cuts.length; c++) {
      const facing = point.dot(cuts[c]);
      if (facing > 0) radius = Math.min(radius, (0.75 + c * 0.055) / facing);
    }
    point.multiplyScalar(radius);
    point.x += point.y * (variant === 1 ? -0.17 : 0.14);
    point.y = Math.max(point.y * (0.67 + variant * 0.025), -0.43);
    position.setXYZ(i, point.x, point.y, point.z);
  }
  // 二十面体的三角形顶点原本分离，必须先合并顶点，重新计算法线后才能平滑过渡。
  source.deleteAttribute('normal');
  source.deleteAttribute('uv');
  const geometry = mergeVertices(source, 1e-5);
  source.dispose();
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

export class LunarRockField {
  /** 准备岩石各级实例网格、固定碰撞原型与邻近缓存。 */
  constructor(scene, material, focus) {
    this.focus = focus;
    this.lastX = this.lastZ = NaN;
    this.colliders = new Map();
    this.colliderShapes = [0, 1, 2].map((variant) => {
      const geometry = createRockGeometry(variant, 5);
      const bvh = MeshBVH.serialize(new MeshBVH(geometry));
      return { geometry, bvh };
    });
    const materials = Array.isArray(material)
      ? material
      : [0, 1, 2].map((level) => {
          const clone = material.clone();
          clone.onBeforeCompile = material.onBeforeCompile;
          clone.customProgramCacheKey = material.customProgramCacheKey;
          return addRockLodShader(clone, focus, level);
        });
    const depthMaterials = [0, 1, 2].map((level) =>
      addRockLodShader(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }), focus, level),
    );
    this.levels = [15, 7, 1].map((detail, level) =>
      [0, 1, 2].map((variant) => {
        const geometry = createRockGeometry(variant, level === 2 && variant === 2 ? 0 : detail);
        geometry.setAttribute('gravelFadeEnd', new THREE.InstancedBufferAttribute(new Float32Array(6500).fill(1e6), 1));
        const mesh = new THREE.InstancedMesh(geometry, materials[level], 6500);
        mesh.name = `Lunar rocks LOD ${level} variant ${variant}`;
        mesh.userData = { level, variant };
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.castShadow = mesh.receiveShadow = true;
        mesh.customDepthMaterial = depthMaterials[level];
        mesh.frustumCulled = false;
        mesh.count = 0;
        scene.add(mesh);
        return mesh;
      }),
    );
    // 远景缓冲同时保存固定摆放目录；近处由更精细网格接管，远景着色器隐藏相应实例。
    this.far = this.levels[2];
    this.meshes = this.levels.flat();
  }

  /** 按角色距离更新可见实例分区，保留固定摆放姿态。 */
  update(placement, worldX, worldZ, force = false) {
    if (!placement || (!force && Math.hypot(worldX - this.lastX, worldZ - this.lastZ) < 1)) return;
    this.lastX = worldX;
    this.lastZ = worldZ;
    const counts = [
      [0, 0, 0],
      [0, 0, 0],
    ];
    for (const item of placement.items) {
      const distance = Math.hypot(item.x - worldX, item.z - worldZ) / rockDetailScale(item.scale);
      for (let level = 0; level < 2; level++) {
        const [begin, end] = ROCK_LOD_BANDS[level];
        // 为两次上传间的移动预留一米范围，避免细节等级交界处缺失石块。
        if (distance < begin - 2 || distance > end + 2) continue;
        const mesh = this.levels[level][item.variant],
          source = this.far[item.variant];
        const index = counts[level][item.variant]++;
        mesh.instanceMatrix.array.set(
          source.instanceMatrix.array.subarray(item.index * 16, item.index * 16 + 16),
          index * 16,
        );
        if (!mesh.instanceColor) mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(6500 * 3), 3);
        mesh.instanceColor.array.set(
          source.instanceColor.array.subarray(item.index * 3, item.index * 3 + 3),
          index * 3,
        );
      }
    }
    for (let level = 0; level < 2; level++)
      this.levels[level].forEach((mesh, variant) => {
        mesh.count = counts[level][variant];
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      });
  }

  /** 为附近岩石复用或烘焙独立 BVH 碰撞体。 */
  nearbyColliders(placement, worldX, worldZ) {
    const needed = new Map();
    if (!placement) return needed;
    for (const item of placement.items) {
      const reach = 16 + item.scale * 1.6;
      if (
        Math.abs(item.x - worldX) >= reach ||
        Math.abs(item.z - worldZ) >= reach ||
        Math.hypot(item.x - worldX, item.z - worldZ) >= reach
      )
        continue;
      const key = `rock:${item.id}`;
      const array = this.far[item.variant].instanceMatrix.array,
        offset = item.index * 16;
      let mesh = this.colliders.get(key);
      let matches = Boolean(mesh);
      if (mesh)
        for (let i = 0; i < 16; i++)
          if (mesh.userData.rockPose[i] !== array[offset + i]) {
            matches = false;
            break;
          }
      if (!matches) {
        const shape = this.colliderShapes[item.variant];
        const geometry = shape.geometry.clone();
        const transform = new THREE.Matrix4().fromArray(array, offset);
        transform.setPosition(0, 0, 0);
        // 控制器按网格局部单位处理胶囊半径；把缩放与旋转烘焙到顶点，碰撞体只保留平移。
        geometry.applyMatrix4(transform);
        geometry.boundsTree = MeshBVH.deserialize(
          { ...shape.bvh, roots: shape.bvh.roots.map((root) => root.slice(0)) },
          geometry,
        );
        geometry.boundsTree.refit();
        mesh = new THREE.Mesh(
          geometry,
          new THREE.MeshBasicMaterial({
            wireframe: true,
            transparent: true,
            opacity: 0.5,
            color: 0xe5bd7c,
            side: THREE.DoubleSide,
          }),
        );
        mesh.name = `Rock collider ${item.id}`;
        mesh.userData.rockPose = array.slice(offset, offset + 16);
        mesh.raycast = acceleratedRaycast;
        mesh.matrixAutoUpdate = false;
        mesh.matrix.makeTranslation(array[offset + 12], array[offset + 13], array[offset + 14]);
        mesh.updateMatrixWorld(true);
        this.colliders.set(key, mesh);
      }
      needed.set(key, mesh);
    }
    return needed;
  }

  /** 释放旧岩石碰撞资源，保留已准备的替代姿态。 */
  releaseCollider(key, mesh) {
    if (!mesh || this.colliders.get(key) === mesh) this.colliders.delete(key);
  }
}
