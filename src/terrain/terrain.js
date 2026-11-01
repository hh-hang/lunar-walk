import * as THREE from 'three';
import { GRAVEL_LOD_BANDS, createGravelGeometry, addGravelLodShader, addContactDistanceFade } from './gravel.js';

import { randomAt, smoothNoise, ease, heightAt, regionalHeight } from './height.js';
import { TILE_SIZE, FOCUS_GRID, distanceToPatch, planTerrainPatches } from './patches.js';
import { createPatchData, createHorizonData } from './data.js';
import { geometryFromData, collisionMeshFromData, excludeTerrainSkirtsFromShadows } from './mesh.js';
import { TerrainStream } from './stream.js';
import { LunarRockField } from './rocks.js';
export { randomAt, heightAt, regionalHeight, landformHeightAt, nearReliefAt, impactProfile } from './height.js';
export { TILE_SIZE, VIEW_RADIUS, planTerrainPatches } from './patches.js';
const TWO_PI = Math.PI * 2;

/** 用固定世界步长估计地表法线。 */
export function normalAt(x, z, result = new THREE.Vector3()) {
  const delta = 0.18;
  return result
    .set(heightAt(x - delta, z) - heightAt(x + delta, z), delta * 2, heightAt(x, z - delta) - heightAt(x, z + delta))
    .normalize();
}

/** 为预览与校验同步创建可见地块和表面碰撞几何。 */
export function createPatchGeometry(ox, oz, size, segments) {
  const data = createPatchData(ox, oz, size, segments);
  return { geometry: geometryFromData(data), collision: collisionMeshFromData(data).geometry };
}

/** 创建实例化碎石接触阴影，并按距离淡出。 */
function makeGravelContactShadows(capacity, focus) {
  const size = 32,
    pixels = new Uint8Array(size * size * 4);
  for (let z = 0; z < size; z++)
    for (let x = 0; x < size; x++) {
      const radius = Math.hypot(((x + 0.5) / size) * 2 - 1, ((z + 0.5) / size) * 2 - 1);
      pixels.set([255, 255, 255, (1 - ease(0.15, 1, radius)) * 255], (z * size + x) * 4);
    }
  const texture = new THREE.DataTexture(pixels, size, size);
  texture.magFilter = texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  const material = new THREE.MeshBasicMaterial({
    color: 0x000000,
    map: texture,
    transparent: true,
    opacity: 0.45,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
    toneMapped: false,
  });
  const geometry = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
  geometry.setAttribute('gravelFadeEnd', new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1));
  addContactDistanceFade(material, focus);
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.name = 'Gravel contact shadows';
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.count = 0;
  return mesh;
}

export class LunarTerrain {
  /** 初始化地形地块、岩石分区、碎石实例与接触阴影。 */
  constructor(
    scene,
    material,
    rockMaterial,
    gravelMaterial = rockMaterial,
    gravelFocus = { value: new THREE.Vector2() },
  ) {
    this.scene = scene;
    this.material = material;
    this.tiles = new Map();
    this.centerX = NaN;
    this.centerZ = NaN;
    this.focusX = NaN;
    this.focusZ = NaN;
    this.surfaceCells = new Map();
    this.onRemove = () => {};
    this.gravelFocus = gravelFocus;
    this.gravelInstances = [];
    this.gravelCells = new Map();
    this.gravelVisibleCount = 0;
    this.gravelLodX = this.gravelLodZ = NaN;
    this.rockField = new LunarRockField(scene, rockMaterial, gravelFocus);
    this.rocks = this.rockField.far;
    this.rockMeshes = this.rockField.meshes;
    const gravelMaterials = Array.isArray(gravelMaterial)
      ? gravelMaterial
      : [gravelMaterial, gravelMaterial, gravelMaterial];
    const gravelDepthMaterials = [0, 1, 2].map((level) =>
      addGravelLodShader(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }), gravelFocus, level),
    );
    this.gravel = [5, 2, 0].flatMap((detail, level) =>
      [0, 1, 2, 3].map((variant) => {
        const geometry = createGravelGeometry(variant, detail, smoothNoise);
        const capacity =
          level === 0
            ? variant < 2
              ? 1600
              : 500
            : level === 1
              ? variant < 2
                ? 5000
                : 1500
              : variant < 2
                ? 12000
                : 4000;
        geometry.setAttribute(
          'gravelFadeEnd',
          new THREE.InstancedBufferAttribute(new Float32Array(capacity).fill(variant < 2 ? 28 : 54), 1),
        );
        const mesh = new THREE.InstancedMesh(geometry, gravelMaterials[level], capacity);
        mesh.name = `Lunar gravel LOD ${level} variant ${variant}`;
        mesh.userData = { level, variant };
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.castShadow = variant >= 2;
        mesh.customDepthMaterial = gravelDepthMaterials[level];
        mesh.receiveShadow = true;
        mesh.frustumCulled = false;
        mesh.count = 0;
        scene.add(mesh);
        return mesh;
      }),
    );
    // 用细小接触阴影补足阴影贴图无法分辨的碎石底部明暗。
    this.gravelShadows = makeGravelContactShadows(32000, gravelFocus);
    scene.add(this.gravelShadows);
    this.horizon = null;
  }

  /** 启动工作线程并等待初始地表与远景全部就绪。 */
  async initializeStreaming(options = {}) {
    this.stream = new TerrainStream(this, options);
    const nextFrame = options.nextFrame ?? (() => new Promise(requestAnimationFrame));
    while (!this.tiles.size || !this.horizon) {
      this.update(0, 0, 0, 0);
      await nextFrame();
    }
    this.stream.stats.peakMs = 0;
  }

  /** 将已生成的数据包装为可见网格，保持碰撞网格延迟创建。 */
  makeStreamMesh(patch, data, kind, originX, originZ) {
    const mesh = new THREE.Mesh(geometryFromData(data), this.material);
    if (kind !== 'horizon') excludeTerrainSkirtsFromShadows(mesh, data.surfaceIndexCount);
    mesh.position.set(patch.x - originX, 0, patch.z - originZ);
    mesh.receiveShadow = kind !== 'horizon';
    mesh.castShadow = kind !== 'horizon' && patch.step <= 2;
    mesh.userData = { ...patch, streamData: data, collisionMesh: null };
    return mesh;
  }

  /** 原子替换已就绪地形方案，并同步表面索引与装饰物。 */
  applyStreamPlan(plan, cache, originX, originZ) {
    for (const [key, mesh] of this.tiles)
      if (!plan.keys.has(key)) {
        this.onRemove(key);
        this.scene.remove(mesh);
        const { x, z, size } = mesh.userData;
        for (let pz = z; pz < z + size; pz += FOCUS_GRID)
          for (let px = x; px < x + size; px += FOCUS_GRID) {
            const cell = `${px / FOCUS_GRID},${pz / FOCUS_GRID}`;
            if (this.surfaceCells.get(cell) === mesh) this.surfaceCells.delete(cell);
          }
        this.tiles.delete(key);
      }
    for (const patch of plan.patches) {
      if (this.tiles.has(patch.key)) continue;
      const mesh = cache.get(patch.key).mesh;
      mesh.position.set(patch.x - originX, 0, patch.z - originZ);
      this.tiles.set(patch.key, mesh);
      this.scene.add(mesh);
      for (let z = patch.z; z < patch.z + patch.size; z += FOCUS_GRID) {
        for (let x = patch.x; x < patch.x + patch.size; x += FOCUS_GRID) {
          this.surfaceCells.set(`${x / FOCUS_GRID},${z / FOCUS_GRID}`, mesh);
        }
      }
    }
    this.centerX = Math.floor(this.worldX / TILE_SIZE);
    this.centerZ = Math.floor(this.worldZ / TILE_SIZE);
    this.focusX = plan.gx;
    this.focusZ = plan.gz;
    const decorationStart = performance.now();
    this.applyRocks(plan.decorations.rocks);
    this.applyGravel(plan.decorations.gravel, originX, originZ);
    this.stream.stats.decorationMs = performance.now() - decorationStart;
  }

  /** 释放退役的地表或岩石碰撞体。 */
  releaseCollider(key, collisionMesh) {
    if (key.startsWith('rock:')) {
      this.rockField.releaseCollider(key, collisionMesh);
      return;
    }
    const mesh = this.tiles.get(key) ?? this.stream?.cache.get(key)?.mesh;
    if (mesh?.userData.streamData && (!collisionMesh || mesh.userData.collisionMesh === collisionMesh)) {
      mesh.userData.collisionMesh = null;
    }
  }

  /** 更新角色周围地形；正式场景使用流式路径，预览支持同步生成。 */
  update(worldX, worldZ, originX, originZ, force = false) {
    this.worldX = worldX;
    this.worldZ = worldZ;
    if (this.stream) {
      const start = performance.now();
      const changed = this.stream.tick(worldX, worldZ, originX, originZ);
      this.updateGravelLod(worldX, worldZ, originX, originZ);
      this.rockField.update(this.rockPlacement, worldX, worldZ);
      this.stream.stats.updateMs = performance.now() - start;
      this.stream.stats.peakMs = Math.max(this.stream.stats.peakMs, this.stream.stats.updateMs);
      return changed;
    }
    const cx = Math.floor(worldX / TILE_SIZE),
      cz = Math.floor(worldZ / TILE_SIZE);
    const fx = Math.floor(worldX / FOCUS_GRID),
      fz = Math.floor(worldZ / FOCUS_GRID);
    if (!force && cx === this.centerX && cz === this.centerZ && fx === this.focusX && fz === this.focusZ) {
      this.updateGravelLod(worldX, worldZ, originX, originZ);
      this.rockField.update(this.rockPlacement, worldX, worldZ);
      return false;
    }
    const wanted = new Set();
    const patches = planTerrainPatches(worldX, worldZ);
    for (const patch of patches) {
      const { key, x, z, size, step, segments } = patch;
      wanted.add(key);
      if (this.tiles.has(key)) continue;
      const { geometry, collision } = createPatchGeometry(x, z, size, segments);
      const mesh = new THREE.Mesh(geometry, this.material);
      excludeTerrainSkirtsFromShadows(mesh, segments ** 2 * 6);
      mesh.position.set(x - originX, 0, z - originZ);
      mesh.receiveShadow = true;
      mesh.castShadow = step <= 2;
      const collisionMesh = new THREE.Mesh(collision);
      collisionMesh.position.copy(mesh.position);
      collisionMesh.updateMatrixWorld(true);
      mesh.userData = { key, x, z, size, step, segments, collisionMesh };
      this.scene.add(mesh);
      this.tiles.set(key, mesh);
    }
    for (const [key, mesh] of this.tiles) if (!wanted.has(key)) this.remove(key, mesh);
    this.centerX = cx;
    this.centerZ = cz;
    this.focusX = fx;
    this.focusZ = fz;
    this.surfaceCells.clear();
    for (const patch of patches) {
      const mesh = this.tiles.get(patch.key);
      for (let z = patch.z; z < patch.z + patch.size; z += FOCUS_GRID) {
        for (let x = patch.x; x < patch.x + patch.size; x += FOCUS_GRID) {
          this.surfaceCells.set(`${x / FOCUS_GRID},${z / FOCUS_GRID}`, mesh);
        }
      }
    }
    this.placeRocks(cx, cz, originX, originZ);
    this.placeGravel(originX, originZ);
    if (!this.horizon || Math.hypot(worldX - this.horizon.userData.x, worldZ - this.horizon.userData.z) > 300) {
      this.rebuildHorizon(worldX, worldZ, originX, originZ);
    }
    return true;
  }

  /** 获取附近十六米范围相交的地表与岩石碰撞体。 */
  nearbyColliders(worldX, worldZ) {
    const needed = new Map(
      [...this.tiles]
        .filter(([, mesh]) => {
          const { x, z, size } = mesh.userData;
          return distanceToPatch(worldX, worldZ, x, z, size) < 16;
        })
        .map(([key, mesh]) => {
          if (!mesh.userData.collisionMesh) {
            const collision = collisionMeshFromData(mesh.userData.streamData);
            collision.position.copy(mesh.position);
            collision.updateMatrixWorld(true);
            mesh.userData.collisionMesh = collision;
          }
          return [key, mesh.userData.collisionMesh];
        }),
    );
    for (const [key, mesh] of this.rockField.nearbyColliders(this.rockPlacement, worldX, worldZ)) needed.set(key, mesh);
    return needed;
  }

  /** 按当前实际三角形插值高度与法线，保证碎石贴合可见地表。 */
  surfaceHeightAt(x, z, surfaceNormal = null, cells = this.surfaceCells) {
    const mesh = cells.get(`${Math.floor(x / FOCUS_GRID)},${Math.floor(z / FOCUS_GRID)}`);
    if (!mesh) {
      if (surfaceNormal) normalAt(x, z, surfaceNormal);
      return heightAt(x, z);
    }
    const patch = mesh.userData;
    const gridX = (x - patch.x) / patch.step,
      gridZ = (z - patch.z) / patch.step;
    const ix = Math.min(patch.segments - 1, Math.floor(gridX));
    const iz = Math.min(patch.segments - 1, Math.floor(gridZ));
    const fx = gridX - ix,
      fz = gridZ - iz;
    const position = mesh.geometry.getAttribute('position');
    const width = patch.segments + 1,
      a = iz * width + ix;
    const h00 = position.getY(a),
      h10 = position.getY(a + 1);
    const h01 = position.getY(a + width),
      h11 = position.getY(a + width + 1);
    if (surfaceNormal) {
      if (fx + fz <= 1) surfaceNormal.set(h00 - h10, patch.step, h00 - h01).normalize();
      else surfaceNormal.set(h01 - h11, patch.step, h10 - h11).normalize();
    }
    return fx + fz <= 1
      ? h00 + fx * (h10 - h00) + fz * (h01 - h00)
      : h11 + (1 - fx) * (h01 - h11) + (1 - fz) * (h10 - h11);
  }

  /** 从同步地形中移除地块并释放相关资源。 */
  remove(key, mesh) {
    this.onRemove(key);
    this.scene.remove(mesh);
    mesh.geometry.dispose();
    mesh.userData.collisionMesh.geometry.dispose();
    mesh.userData.collisionMesh.material.dispose();
    this.tiles.delete(key);
  }

  /** 切换浮动原点并平移实例与缓存姿态，不重新随机生成地貌。 */
  rebase(shiftX, shiftZ, originX, originZ) {
    const meshes = this.stream
      ? [...this.stream.cache.values()].map((entry) => entry.mesh).filter(Boolean)
      : this.tiles.values();
    for (const mesh of meshes) {
      mesh.position.set(mesh.userData.x - originX, 0, mesh.userData.z - originZ);
      const collision = mesh.userData.collisionMesh;
      if (collision) {
        collision.position.copy(mesh.position);
        collision.updateMatrixWorld(true);
      }
    }
    if (!this.stream) {
      this.horizon.position.x -= shiftX;
      this.horizon.position.z -= shiftZ;
    }
    if (this.stream) {
      for (const mesh of this.rocks) {
        const array = mesh.instanceMatrix.array;
        for (let i = 0; i < mesh.count; i++) {
          array[i * 16 + 12] -= shiftX;
          array[i * 16 + 14] -= shiftZ;
        }
        mesh.instanceMatrix.clearUpdateRanges();
        mesh.instanceMatrix.needsUpdate = true;
      }
      Object.assign(this.rockPlacement, { originX, originZ });
      const shifted = new Set();
      /** 只平移一次共享的碎石与阴影矩阵。 */
      const shiftItem = (item) => {
        if (!item.placed) return;
        for (const matrix of [item.matrix, item.contact]) {
          if (shifted.has(matrix)) continue;
          matrix.elements[12] -= originX - item.originX;
          matrix.elements[14] -= originZ - item.originZ;
          shifted.add(matrix);
        }
        item.originX = originX;
        item.originZ = originZ;
      };
      for (const items of this.gravelCells.values()) for (const item of items) shiftItem(item);
      for (const item of this.gravelInstances) shiftItem(item);
      this.updateGravelLod(this.worldX, this.worldZ, originX, originZ, true);
      this.rockField.update(this.rockPlacement, this.worldX, this.worldZ, true);
      return;
    }
    this.placeRocks(this.centerX, this.centerZ, originX, originZ);
    this.placeGravel(originX, originZ);
  }

  /** 分批准备岩石摆放或地形变化后的高度修正。 */
  *prepareRocks(cx, cz, originX, originZ, cells = this.surfaceCells) {
    /** 查询世界位置所属的当前地表地块标识。 */
    const groundAt = (x, z) => cells.get(Math.floor(x / FOCUS_GRID) + ',' + Math.floor(z / FOCUS_GRID))?.userData.key;
    if (
      this.rockPlacement?.cx === cx &&
      this.rockPlacement.cz === cz &&
      this.rockPlacement.originX === originX &&
      this.rockPlacement.originZ === originZ
    ) {
      const updates = [];
      let processed = 0;
      for (const item of this.rockPlacement.items) {
        if (Math.hypot(item.x - this.worldX, item.z - this.worldZ) <= 90) {
          const ground = groundAt(item.x, item.z);
          if (ground !== item.ground) {
            const matrix = new THREE.Matrix4();
            this.rocks[item.variant].getMatrixAt(item.index, matrix);
            matrix.elements[13] = this.surfaceHeightAt(item.x, item.z, null, cells) + item.scale * 0.1;
            updates.push({ item, matrix, ground });
          }
        }
        if (++processed % 128 === 0) yield;
      }
      return { updates };
    }
    const counts = [0, 0, 0];
    const matrices = this.rocks.map((mesh) => new Float32Array(mesh.instanceMatrix.array.length));
    const colors = this.rocks.map((mesh) => new Float32Array(mesh.instanceMatrix.count * 3));
    const placement = { cx, cz, originX, originZ, items: [] };
    const transform = new THREE.Object3D();
    for (let dz = -4; dz <= 4; dz++)
      for (let dx = -4; dx <= 4; dx++) {
        const tx = cx + dx,
          tz = cz + dz;
        for (let i = 0; i < 74; i++) {
          if (randomAt(tx * 79 + i, tz, 951) > 0.77) continue;
          const x = (tx + randomAt(tx, tz, 1000 + i)) * TILE_SIZE;
          const z = (tz + randomAt(tx, tz, 1200 + i)) * TILE_SIZE;
          if (Math.hypot(x, z) < 4) continue;
          const sizeChoice = randomAt(tx, tz, 1400 + i);
          const variant = sizeChoice > 0.945 ? 0 : sizeChoice > 0.66 ? 1 : 2;
          const scale =
            variant === 0
              ? 0.75 + randomAt(tx, tz, 1600 + i) ** 2 * 2.3
              : variant === 1
                ? 0.19 + randomAt(tx, tz, 1600 + i) * 0.62
                : 0.055 + randomAt(tx, tz, 1600 + i) * 0.17;
          transform.position.set(x - originX, this.surfaceHeightAt(x, z, null, cells) + scale * 0.1, z - originZ);
          transform.rotation.set(
            (randomAt(tx, tz, 1800 + i) - 0.5) * 0.6,
            randomAt(tx, tz, 2000 + i) * TWO_PI,
            (randomAt(tx, tz, 2200 + i) - 0.5) * 0.5,
          );
          transform.scale.set(scale, scale * (0.8 + randomAt(tx, tz, 2400 + i) * 0.3), scale * 0.9);
          transform.updateMatrix();
          const index = counts[variant]++;
          matrices[variant].set(transform.matrix.elements, index * 16);
          colors[variant].fill(0.64 + randomAt(tx, tz, 2600 + i) * 0.48, index * 3, index * 3 + 3);
          placement.items.push({ id: `${tx},${tz},${i}`, x, z, scale, variant, index, ground: groundAt(x, z) });
        }
        yield;
      }
    return { placement, matrices, colors, counts };
  }

  /** 提交岩石实例与颜色，复用无需更新的姿态。 */
  applyRocks(plan) {
    if (plan.updates) {
      for (const { item, matrix, ground } of plan.updates) {
        const mesh = this.rocks[item.variant];
        mesh.setMatrixAt(item.index, matrix);
        mesh.instanceMatrix.addUpdateRange(item.index * 16, 16);
        mesh.instanceMatrix.needsUpdate = true;
        item.ground = ground;
      }
      if (plan.updates.length) this.rockField.update(this.rockPlacement, this.worldX, this.worldZ, true);
      return;
    }
    this.rockPlacement = plan.placement;
    this.rocks.forEach((mesh, variant) => {
      mesh.instanceMatrix.array.set(plan.matrices[variant]);
      mesh.instanceMatrix.clearUpdateRanges();
      mesh.instanceMatrix.needsUpdate = true;
      if (!mesh.instanceColor) mesh.instanceColor = new THREE.InstancedBufferAttribute(plan.colors[variant], 3);
      else mesh.instanceColor.array.set(plan.colors[variant]);
      mesh.instanceColor.needsUpdate = true;
      mesh.count = plan.counts[variant];
    });
    this.rockField.update(this.rockPlacement, this.worldX, this.worldZ, true);
  }

  /** 同步执行岩石准备，供预览路径使用。 */
  placeRocks(cx, cz, originX, originZ) {
    const iterator = this.prepareRocks(cx, cz, originX, originZ);
    let result;
    do {
      result = iterator.next();
    } while (!result.done);
    this.applyRocks(result.value);
  }

  /** 生成并缓存网格区域内可复现的碎石目录。 */
  gravelCell(layer, gx, gz) {
    const key = layer.salt + ':' + gx + ',' + gz;
    let items = this.gravelCells.get(key);
    if (items) {
      this.gravelCells.delete(key);
      this.gravelCells.set(key, items);
      return items;
    }
    items = [];
    const minX = Math.floor((gx * FOCUS_GRID) / layer.spacing),
      maxX = Math.ceil(((gx + 1) * FOCUS_GRID) / layer.spacing);
    const minZ = Math.floor((gz * FOCUS_GRID) / layer.spacing),
      maxZ = Math.ceil(((gz + 1) * FOCUS_GRID) / layer.spacing);
    for (let iz = minZ; iz < maxZ; iz++)
      for (let ix = minX; ix < maxX; ix++) {
        const x = (ix + randomAt(ix, iz, layer.salt)) * layer.spacing;
        const z = (iz + randomAt(ix, iz, layer.salt + 1)) * layer.spacing;
        if (Math.floor(x / FOCUS_GRID) !== gx || Math.floor(z / FOCUS_GRID) !== gz) continue;
        const abundance = smoothNoise(x / 9, z / 9, 3250) * 0.75 + smoothNoise(x / 2.8, z / 2.8, 3251) * 0.25;
        if (randomAt(ix, iz, layer.salt + 2) > layer.density * (0.2 + 0.8 * abundance)) continue;
        const variant = layer.shape + Math.floor(randomAt(ix, iz, layer.salt + 3) * 2);
        const scale = layer.min + (layer.max - layer.min) * randomAt(ix, iz, layer.salt + 4) ** 2.2;
        items.push({
          x,
          z,
          ix,
          iz,
          salt: layer.salt,
          variant,
          scale,
          matrix: new THREE.Matrix4(),
          contact: new THREE.Matrix4(),
          tint: new THREE.Color().setScalar(0.48 + randomAt(ix, iz, layer.salt + 10) ** 1.4 * 1.1),
          fadeEnd: variant < 2 ? 28 : 54,
        });
      }
    this.gravelCells.set(key, items);
    return items;
  }

  /** 分批计算贴地碎石姿态，待提交方案不修改活动实例。 */
  *prepareGravel(originX, originZ, cells = this.surfaceCells, staging = false) {
    const centerX = ((staging ? staging.gx : this.focusX) + 0.5) * FOCUS_GRID,
      centerZ = ((staging ? staging.gz : this.focusZ) + 0.5) * FOCUS_GRID;
    const instances = [],
      updates = [];
    const transform = new THREE.Object3D(),
      contact = new THREE.Object3D();
    const up = new THREE.Vector3(0, 1, 0),
      surfaceNormal = new THREE.Vector3();
    for (const layer of [
      { spacing: 0.36, radius: 38, min: 0.009, max: 0.055, density: 0.4, shape: 0, salt: 3300 },
      { spacing: 0.95, radius: 64, min: 0.04, max: 0.12, density: 0.18, shape: 2, salt: 3400 },
    ]) {
      const minX = Math.floor((centerX - layer.radius) / FOCUS_GRID),
        maxX = Math.floor((centerX + layer.radius) / FOCUS_GRID);
      const minZ = Math.floor((centerZ - layer.radius) / FOCUS_GRID),
        maxZ = Math.floor((centerZ + layer.radius) / FOCUS_GRID);
      for (let gz = minZ; gz <= maxZ; gz++)
        for (let gx = minX; gx <= maxX; gx++) {
          if (distanceToPatch(centerX, centerZ, gx * FOCUS_GRID, gz * FOCUS_GRID, FOCUS_GRID) > layer.radius) continue;
          for (const item of this.gravelCell(layer, gx, gz)) {
            const { x, z, ix, iz, salt, scale } = item;
            if ((x - centerX) ** 2 + (z - centerZ) ** 2 > layer.radius ** 2) continue;
            const ground = cells.get(Math.floor(x / FOCUS_GRID) + ',' + Math.floor(z / FOCUS_GRID))?.userData.key;
            let pose = item;
            if (!item.placed || item.ground !== ground || item.originX !== originX || item.originZ !== originZ) {
              if (staging) pose = { ...item, matrix: new THREE.Matrix4(), contact: new THREE.Matrix4() };
              const y = this.surfaceHeightAt(x, z, surfaceNormal, cells);
              transform.position.set(x - originX, y, z - originZ).addScaledVector(surfaceNormal, scale * 0.08);
              transform.quaternion.setFromUnitVectors(up, surfaceNormal);
              transform.rotateY(randomAt(ix, iz, salt + 5) * TWO_PI);
              transform.scale.set(
                scale * (0.7 + randomAt(ix, iz, salt + 7) * 0.6),
                scale * (0.65 + randomAt(ix, iz, salt + 8) * 0.5),
                scale * (0.65 + randomAt(ix, iz, salt + 9) * 0.5),
              );
              contact.position.set(x - originX, y, z - originZ).addScaledVector(surfaceNormal, 0.001);
              contact.quaternion.copy(transform.quaternion);
              contact.scale.set(transform.scale.x * 1.05, 1, transform.scale.z * 1.05);
              contact.updateMatrix();
              transform.rotateX((randomAt(ix, iz, salt + 6) - 0.5) * 0.3);
              transform.updateMatrix();
              pose.matrix.copy(transform.matrix);
              pose.contact.copy(contact.matrix);
              Object.assign(pose, { ground, originX, originZ, placed: true });
              if (staging) updates.push({ item, pose });
            }
            instances.push(pose);
          }
          yield;
        }
    }
    const oldest = this.gravelCells.keys();
    while (this.gravelCells.size > 384) this.gravelCells.delete(oldest.next().value);
    return { instances, updates };
  }

  /** 提交碎石姿态并刷新细节分区。 */
  applyGravel(plan, originX, originZ) {
    for (const { item, pose } of plan.updates) {
      item.matrix = pose.matrix;
      item.contact = pose.contact;
      item.ground = pose.ground;
      item.originX = originX;
      item.originZ = originZ;
      item.placed = true;
    }
    this.gravelInstances = plan.instances;
    this.updateGravelLod(this.worldX, this.worldZ, originX, originZ, true);
  }

  /** 同步执行碎石准备，供预览路径使用。 */
  placeGravel(originX, originZ) {
    const iterator = this.prepareGravel(originX, originZ);
    let result;
    do {
      result = iterator.next();
    } while (!result.done);
    this.applyGravel(result.value, originX, originZ);
  }

  /** 为待提交地块分批准备岩石和碎石。 */
  *prepareDecorations(plan, cache, originX, originZ) {
    const cells = new Map();
    for (const patch of plan.patches) {
      const mesh = cache.get(patch.key).mesh;
      for (let z = patch.z; z < patch.z + patch.size; z += FOCUS_GRID) {
        for (let x = patch.x; x < patch.x + patch.size; x += FOCUS_GRID) {
          cells.set(x / FOCUS_GRID + ',' + z / FOCUS_GRID, mesh);
        }
      }
      yield;
    }
    const rocks = yield* this.prepareRocks(
      Math.floor((plan.gx * FOCUS_GRID) / TILE_SIZE),
      Math.floor((plan.gz * FOCUS_GRID) / TILE_SIZE),
      originX,
      originZ,
      cells,
    );
    // 摆放目录跟随待提交方案，当前显示的实例在整套数据就绪前保持不动。
    const gravel = yield* this.prepareGravel(originX, originZ, cells, plan);
    return { rocks, gravel };
  }

  /** 按角色距离上传碎石细节分区与接触阴影。 */
  updateGravelLod(worldX, worldZ, originX, originZ, force = false) {
    this.gravelFocus.value.set(worldX - originX, worldZ - originZ);
    if (!force && Math.hypot(worldX - this.gravelLodX, worldZ - this.gravelLodZ) < 0.75) return;
    this.gravelLodX = worldX;
    this.gravelLodZ = worldZ;
    const counts = this.gravel.map(() => 0);
    let contactCount = 0;
    const contactRanges = this.gravelShadows.geometry.getAttribute('gravelFadeEnd');
    for (const item of this.gravelInstances) {
      const distance = Math.hypot(item.x - worldX, item.z - worldZ);
      if (distance > item.fadeEnd + 1) continue;
      for (let level = 0; level < GRAVEL_LOD_BANDS.length; level++) {
        const [begin, end] = GRAVEL_LOD_BANDS[level];
        if (distance < begin - 1 || distance > end + 1) continue;
        const slot = level * 4 + item.variant,
          mesh = this.gravel[slot];
        if (counts[slot] >= mesh.instanceMatrix.count) continue;
        const index = counts[slot]++;
        mesh.setMatrixAt(index, item.matrix);
        mesh.setColorAt(index, item.tint);
      }
      this.gravelShadows.setMatrixAt(contactCount, item.contact);
      contactRanges.setX(contactCount++, item.fadeEnd);
    }
    this.gravel.forEach((mesh, index) => {
      mesh.count = counts[index];
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    });
    this.gravelShadows.count = contactCount;
    this.gravelShadows.instanceMatrix.needsUpdate = true;
    contactRanges.needsUpdate = true;
    this.gravelVisibleCount = contactCount;
  }

  /** 重建带月球曲率的远景地平线。 */
  rebuildHorizon(x, z, originX, originZ) {
    if (this.horizon) {
      this.scene.remove(this.horizon);
      this.horizon.geometry.dispose();
    }
    // 与工作线程共用远景生成算法，避免维护两份地平线实现。
    this.horizon = new THREE.Mesh(geometryFromData(createHorizonData(x, z)), this.material);
    this.horizon.position.set(x - originX, 0, z - originZ);
    this.horizon.userData = { x, z };
    this.scene.add(this.horizon);
  }
}
