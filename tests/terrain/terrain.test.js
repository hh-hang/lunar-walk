import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  TILE_SIZE,
  VIEW_RADIUS,
  createPatchGeometry,
  heightAt,
  landformHeightAt,
  nearReliefAt,
  normalAt,
  impactProfile,
  planTerrainPatches,
  LunarTerrain,
} from '../../src/terrain/terrain.js';
import { makeLunarMaterials } from '../../src/rendering/surface.js';
import { createLunarSunlight } from '../../src/environment/lighting.js';
import { GRAVEL_LOD_BANDS } from '../../src/terrain/gravel.js';
import { createPatchData } from '../../src/terrain/data.js';

test('相邻细节等级地块的共享边界顶点一致，并支持负坐标', () => {
  const fine = createPatchGeometry(-12, -12, 12, 48);
  const coarse = createPatchGeometry(0, -12, 24, 48);
  const finePositions = fine.geometry.getAttribute('position');
  const coarsePositions = coarse.geometry.getAttribute('position');
  const fineNormals = fine.geometry.getAttribute('normal');
  const coarseNormals = coarse.geometry.getAttribute('normal');
  for (let z = 0; z <= 24; z++) {
    const a = z * 2 * 49 + 48,
      b = z * 49;
    assert.equal(finePositions.getX(a) - 12, coarsePositions.getX(b));
    assert.equal(finePositions.getY(a), coarsePositions.getY(b));
    assert.equal(finePositions.getZ(a), coarsePositions.getZ(b));
    assert.ok(
      new THREE.Vector3()
        .fromBufferAttribute(fineNormals, a)
        .distanceTo(new THREE.Vector3().fromBufferAttribute(coarseNormals, b)) < 1e-6,
    );
  }
});

test('表面法线独立于竖直裙边，碰撞网格排除裙边', () => {
  const { geometry, collision } = createPatchGeometry(0, 0, 12, 48);
  const normals = geometry.getAttribute('normal');
  for (const [x, z] of [
    [0, 0],
    [6, 0],
    [12, 6],
    [6, 12],
  ]) {
    const expected = normalAt(x, z);
    const actual = new THREE.Vector3().fromBufferAttribute(normals, z * 4 * 49 + x * 4);
    assert.ok(actual.distanceTo(expected) < 1e-6);
    assert.ok(actual.y > 0);
  }
  assert.equal(collision.getAttribute('position').count, 49 ** 2);
  assert.equal(collision.index.count, 48 ** 2 * 6);
  assert.ok(geometry.getAttribute('position').count > collision.getAttribute('position').count);
  const positions = collision.getAttribute('position');
  for (const index of [0, 24 * 49 + 24, positions.count - 1]) {
    assert.ok(Math.abs(positions.getY(index) - heightAt(positions.getX(index), positions.getZ(index))) < 2e-6);
  }
});

test('地形阴影排除裙边，并在每次级联结束后恢复完整绘制范围', () => {
  const terrain = new LunarTerrain(
    new THREE.Scene(),
    new THREE.MeshStandardMaterial(),
    new THREE.MeshStandardMaterial(),
  );
  const data = createPatchData(0, 0, 12, 48);
  const mesh = terrain.makeStreamMesh({ x: 0, z: 0, size: 12, step: 0.25, segments: 48 }, data, 'patch', 0, 0);
  assert.ok(mesh.castShadow && mesh.receiveShadow);
  assert.ok(mesh.geometry.index.count > data.surfaceIndexCount, '颜色通道必须保留裙边以遮盖细节等级接缝');
  for (let cascade = 0; cascade < 2; cascade++) {
    mesh.onBeforeShadow();
    assert.deepEqual(mesh.geometry.drawRange, { start: 0, count: data.surfaceIndexCount });
    mesh.onAfterShadow();
    assert.deepEqual(mesh.geometry.drawRange, { start: 0, count: Infinity });
  }
  for (const [start, count, shadowCount] of [
    [6, 12, 12],
    [data.surfaceIndexCount - 3, 30, 3],
    [data.surfaceIndexCount, 24, 0],
  ]) {
    mesh.geometry.setDrawRange(start, count);
    mesh.onBeforeShadow();
    assert.deepEqual(mesh.geometry.drawRange, { start, count: shadowCount });
    mesh.onAfterShadow();
    assert.deepEqual(mesh.geometry.drawRange, { start, count });
  }
  mesh.geometry.dispose();
});

test('世界高度确定且跨陨石坑目录与区域边界连续', () => {
  for (const [x, z] of [
    [0, 0],
    [-96, -29],
    [925, 0],
    [-925, 1850],
    [1000000, -1000000],
  ]) {
    assert.equal(heightAt(x, z), heightAt(x, z));
    assert.ok(Number.isFinite(heightAt(x, z)));
    assert.ok(Math.abs(heightAt(x - 1e-5, z) - heightAt(x + 1e-5, z)) < 0.01);
    assert.ok(Math.abs(heightAt(x, z - 1e-5) - heightAt(x, z + 1e-5)) < 0.01);
  }
});

test('风化陨石坑具有浅坑底、弱坑缘和宽外肩', () => {
  assert.ok(Math.abs(impactProfile(0, 0.95)) < Math.abs(impactProfile(0, 0.05)) * 0.3);
  assert.ok(impactProfile(1.2, 0.95) < impactProfile(1.2, 0.05) * 0.2);
  assert.ok(impactProfile(1.8, 0.05) > 0);
  assert.equal(impactProfile(2.15, 0.05), 0);
  assert.ok(impactProfile(1.2, 0.8, 0, 0) < impactProfile(1.2, 0.8, Math.PI, 0));
  for (const radius of [0.1, 0.36, 0.78, 1, 1.11, 2.15]) {
    assert.ok(Math.abs(impactProfile(radius - 1e-5, 0.4) - impactProfile(radius + 1e-5, 0.4)) < 0.001);
  }
});

test('亚米级起伏真实改变顶点高度', () => {
  const samples = [];
  let strongestCurve = 0;
  for (let z = -4; z <= 4; z += 0.25)
    for (let x = -4; x <= 4; x += 0.25) {
      const detail = nearReliefAt(x, z);
      assert.ok(Math.abs(heightAt(x, z) - landformHeightAt(x, z) - detail) < 1e-10);
      samples.push(detail);
      const linear = (nearReliefAt(x - 0.25, z) + nearReliefAt(x + 0.25, z)) * 0.5;
      strongestCurve = Math.max(strongestCurve, Math.abs(detail - linear));
    }
  assert.ok(Math.max(...samples) - Math.min(...samples) > 0.15);
  assert.ok(strongestCurve > 0.01);
});

test('近处浅坑中保留少量较深的新鲜凹坑', () => {
  let deepest = 0,
    deepSamples = 0,
    total = 0;
  for (let z = -24; z < 24; z += 0.25)
    for (let x = -24; x < 24; x += 0.25) {
      let surrounding = 0;
      for (let i = 0; i < 8; i++) {
        const angle = (i * Math.PI) / 4;
        surrounding += nearReliefAt(x + Math.cos(angle), z + Math.sin(angle)) / 8;
      }
      const depression = surrounding - nearReliefAt(x, z);
      deepest = Math.max(deepest, depression);
      if (depression > 0.15) deepSamples++;
      total++;
    }
  assert.ok(deepest > 0.23);
  assert.ok(deepSamples / total > 0.002);
  assert.ok(deepSamples / total < 0.02);
});

test('出生区域保持浅起伏与大部分缓坡', () => {
  const heights = [],
    slopes = [];
  for (let z = -12; z <= 12; z += 0.5)
    for (let x = -12; x <= 12; x += 0.5) {
      heights.push(heightAt(x, z));
      const dx = (heightAt(x + 0.125, z) - heightAt(x - 0.125, z)) / 0.25;
      const dz = (heightAt(x, z + 0.125) - heightAt(x, z - 0.125)) / 0.25;
      slopes.push(Math.hypot(dx, dz));
    }
  slopes.sort((a, b) => a - b);
  assert.ok(Math.max(...heights) - Math.min(...heights) < 1.5);
  assert.ok(slopes[Math.floor(slopes.length * 0.95)] < Math.tan((12 * Math.PI) / 180));
});

test('自适应地块无重叠覆盖世界，并在脚下保留四分之一米网格', () => {
  for (const [x, z] of [
    [0, 0],
    [-0.2, -12.1],
    [11.99, 23.99],
    [96.01, -96.01],
    [3100, -3150],
  ]) {
    const patches = planTerrainPatches(x, z);
    const covered = new Set();
    let area = 0,
      triangles = 0;
    for (const patch of patches) {
      area += patch.size ** 2;
      triangles += 2 * patch.segments ** 2 + patch.segments * 8;
      for (let pz = patch.z; pz < patch.z + patch.size; pz += 12) {
        for (let px = patch.x; px < patch.x + patch.size; px += 12) {
          const key = `${px},${pz}`;
          assert.ok(!covered.has(key), `overlapping patch at ${key}`);
          covered.add(key);
        }
      }
    }
    const underfoot = patches.find((p) => x >= p.x && x < p.x + p.size && z >= p.z && z < p.z + p.size);
    assert.equal(underfoot.step, 0.25);
    assert.equal(area, ((2 * VIEW_RADIUS + 1) * TILE_SIZE) ** 2);
    assert.ok(triangles < 600000);
    assert.ok(patches.some((p) => p.step === 8));
  }
});

test('碎石贴合可见地表，换原点后保持装饰物摆放', () => {
  const scene = new THREE.Scene();
  const terrain = new LunarTerrain(scene, new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial());
  terrain.update(0, 0, 0, 0, true);
  const nearby = terrain.nearbyColliders(0, 0);
  assert.ok([...nearby.keys()].some((key) => key.startsWith('rock:')));
  assert.ok([...nearby.keys()].every((key) => !key.startsWith('gravel:')));
  const boulder = terrain.rockPlacement.items
    .filter((item) => item.variant === 0)
    .sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z))[0];
  const boulderMesh = terrain.nearbyColliders(boulder.x, boulder.z).get(`rock:${boulder.id}`);
  const boulderRay = new THREE.Raycaster(new THREE.Vector3(boulder.x, 500, boulder.z), new THREE.Vector3(0, -1, 0));
  assert.ok(boulderRay.intersectObject(boulderMesh)[0].point.y > terrain.surfaceHeightAt(boulder.x, boulder.z) + 0.4);
  const matrixBefore = new THREE.Matrix4();
  terrain.rocks[0].getMatrixAt(0, matrixBefore);
  const rockBefore = new THREE.Vector3().setFromMatrixPosition(matrixBefore);
  assert.equal(terrain.gravelShadows.count, terrain.gravelVisibleCount);
  assert.ok(terrain.gravelVisibleCount < terrain.gravel.reduce((n, mesh) => n + mesh.count, 0));
  const gravelBefore = [...terrain.gravel, terrain.gravelShadows].map((mesh) => {
    assert.ok(mesh.count > 0 && mesh.count <= mesh.instanceMatrix.count);
    const matrix = new THREE.Matrix4();
    mesh.getMatrixAt(0, matrix);
    return matrix;
  });
  const point = new THREE.Vector3(),
    center = new THREE.Vector3(),
    matrix = new THREE.Matrix4();
  let checked = 0;
  for (const mesh of terrain.gravel) {
    const [begin, end] = GRAVEL_LOD_BANDS[mesh.userData.level];
    const positions = mesh.geometry.getAttribute('position');
    for (let i = 0; i < mesh.count; i += 83) {
      mesh.getMatrixAt(i, matrix);
      center.setFromMatrixPosition(matrix);
      const distance = Math.hypot(center.x, center.z);
      assert.ok(distance >= Math.max(0, begin - 1) - 1e-5 && distance <= end + 1 + 1e-5);
      if (Math.hypot(center.x, center.z) > 24) continue;
      let bottom = Infinity,
        top = -Infinity;
      for (let j = 0; j < positions.count; j++) {
        point.fromBufferAttribute(positions, j).applyMatrix4(matrix);
        const clearance = point.y - terrain.surfaceHeightAt(point.x, point.z);
        bottom = Math.min(bottom, clearance);
        top = Math.max(top, clearance);
      }
      assert.ok(bottom < 0.002, `floating fragment at ${center.x}, ${center.z}`);
      assert.ok(top > 0.002, `buried fragment at ${center.x}, ${center.z}`);
      checked++;
    }
  }
  assert.ok(checked > 30);
  const tile = terrain.surfaceCells.get('0,0');
  const originalPosition = tile.position.clone();
  const terrainY = tile.geometry.getAttribute('position').getY(0);
  for (const [x, z] of [
    [0.37, 0.51],
    [-2.37, 1.41],
    [333.12, 201.41],
  ]) {
    const mesh = terrain.surfaceCells.get(`${Math.floor(x / 12)},${Math.floor(z / 12)}`);
    const ray = new THREE.Raycaster(new THREE.Vector3(x, 500, z), new THREE.Vector3(0, -1, 0));
    const hits = ray.intersectObject(mesh.userData.collisionMesh, false);
    assert.ok(hits.length > 0);
    assert.ok(Math.abs(hits[0].point.y - terrain.surfaceHeightAt(x, z)) < 1e-5);
  }
  terrain.rebase(3072, -3072, 3072, -3072);
  assert.equal(tile.position.x + 3072, originalPosition.x);
  assert.equal(tile.position.z - 3072, originalPosition.z);
  assert.equal(tile.userData.collisionMesh.position.x, tile.position.x);
  assert.equal(tile.userData.collisionMesh.position.z, tile.position.z);
  assert.equal(tile.geometry.getAttribute('position').getY(0), terrainY);
  const matrixAfter = new THREE.Matrix4();
  terrain.rocks[0].getMatrixAt(0, matrixAfter);
  const rockAfter = new THREE.Vector3().setFromMatrixPosition(matrixAfter).add(new THREE.Vector3(3072, 0, -3072));
  assert.ok(rockBefore.distanceTo(rockAfter) < 0.001);
  [...terrain.gravel, terrain.gravelShadows].forEach((mesh, index) => {
    mesh.getMatrixAt(0, matrixAfter);
    matrixAfter.elements[12] += 3072;
    matrixAfter.elements[14] -= 3072;
    matrixAfter.elements.forEach((value, component) => {
      assert.ok(Math.abs(value - gravelBefore[index].elements[component]) < 0.001);
    });
  });
  assert.deepEqual(terrain.gravelFocus.value.toArray(), [-3072, 3072]);

  // 在同一地块内移动也需更新细节；不同细节等级共享的石块应保持相同变换。
  assert.equal(terrain.update(1, 1, 3072, -3072), false);
  assert.deepEqual(terrain.gravelFocus.value.toArray(), [-3071, 3073]);
  const visible = new Set();
  for (const mesh of terrain.gravel)
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, matrix);
      visible.add(`${matrix.elements[12].toFixed(3)},${matrix.elements[14].toFixed(3)}`);
    }
  for (const item of terrain.gravelInstances) {
    const distance = Math.hypot(item.x - 1, item.z - 1);
    if (distance > item.fadeEnd) continue;
    assert.ok(
      visible.has(
        `${Math.fround(item.matrix.elements[12]).toFixed(3)},${Math.fround(item.matrix.elements[14]).toFixed(3)}`,
      ),
    );
  }
  terrain.update(1.1, 1.1, 3072, -3072);
  assert.equal(terrain.gravelLodX, 1);
  assert.ok(Math.abs(terrain.gravelFocus.value.x + 3070.9) < 1e-9);
  for (let variant = 0; variant < 4; variant++) {
    const near = terrain.gravel[variant].geometry,
      mid = terrain.gravel[4 + variant].geometry;
    const far = terrain.gravel[8 + variant].geometry;
    assert.ok(near.index.count > mid.index.count && mid.index.count > far.index.count);
    assert.ok(near.getAttribute('position').count < near.index.count / 2);
  }
});

test('全部材质着色器钩子与当前 Three.js 版本兼容', () => {
  const origin = { value: new THREE.Vector2(3072, -3072) };
  const focus = { value: new THREE.Vector2(1, 2) };
  const materials = makeLunarMaterials(origin, focus);
  for (const material of Object.values(materials)) {
    const shader = {
      uniforms: {},
      vertexShader: THREE.ShaderLib.standard.vertexShader,
      fragmentShader: THREE.ShaderLib.standard.fragmentShader,
    };
    material.onBeforeCompile(shader);
    assert.ok(shader.vertexShader.includes('vMoonWorld ='));
    assert.ok(shader.fragmentShader.includes('#include <lights_fragment_begin>'));
    assert.equal(shader.uniforms.uMoonOrigin, origin);
    assert.ok(!shader.fragmentShader.includes('uLightEnvelope'));
    if (material === materials.ground) {
      assert.ok(shader.fragmentShader.includes('* (1.0 - F) * powderScatter'));
      assert.equal(material.map.image.width, 512);
      assert.equal(material.aoMap, null);
      assert.equal(material.roughnessMap, null);
      assert.equal(material.map.generateMipmaps, true);
      assert.equal(material.normalMap.colorSpace, THREE.NoColorSpace);
    }
    if (material.defines?.GRAVEL_LOD !== undefined) {
      assert.equal(shader.uniforms.uGravelFocus, focus);
      assert.ok(shader.fragmentShader.includes('gravelVisibility'));
      assert.equal(material.flatShading, false);
    }
  }
});

test('太阳原生级联阴影集中近景分辨率，换原点后保持有效', () => {
  const scene = new THREE.Scene();
  const light = createLunarSunlight();
  scene.add(light);
  const camera = new THREE.PerspectiveCamera(59, 16 / 9, 0.04, 14500);
  camera.position.set(5, 4, 7);
  camera.lookAt(-4, 0, -11);
  scene.updateMatrixWorld(true);
  camera.updateMatrixWorld(true);
  light.shadow.updateMatrices(light, camera);
  assert.ok(light.isSunLight && light.shadow.isSunLightShadow);
  assert.equal(light.shadow.getViewportCount(), 2);
  const limited = createLunarSunlight(4096);
  assert.ok(limited.shadow.mapSize.x * limited.shadow.getFrameExtents().x <= 4096);
  assert.ok(limited.shadow.mapSize.y * limited.shadow.getFrameExtents().y <= 4096);
  const near = light.shadow.getCamera(0),
    far = light.shadow.getCamera(1);
  const nearTexel = (near.right - near.left) / light.shadow.mapSize.x;
  assert.ok(nearTexel < 0.01);
  assert.ok(far.right - far.left > near.right - near.left);
  const probe = camera.position.clone().addScaledVector(camera.getWorldDirection(new THREE.Vector3()), 5);
  const before = probe.clone().applyMatrix4(light.shadow.getMatrix(0));
  camera.position.sub(new THREE.Vector3(3072, 0, -3072));
  camera.updateMatrixWorld(true);
  light.shadow.updateMatrices(light, camera);
  const after = probe.sub(new THREE.Vector3(3072, 0, -3072)).applyMatrix4(light.shadow.getMatrix(0));
  assert.ok(Math.abs(after.x - before.x) < 1 / light.shadow.mapSize.x);
  assert.ok(Math.abs(after.y - before.y) < 1 / light.shadow.mapSize.y);
  assert.ok(Math.abs(after.z - before.z) < 1e-8);
});
