import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { playerController } from 'three-player-controller';
import { LunarTerrain, planTerrainPatches, heightAt } from '../../src/terrain/terrain.js';
import { nodeTerrainWorker, nextTurn, waitForTerrain } from '../helpers/terrain-worker.js';

test('流式地形就绪前保留旧覆盖与 BVH 碰撞，并正确处理换原点后的延迟结果', async (t) => {
  const scene = new THREE.Scene(),
    worker = nodeTerrainWorker();
  const terrain = new LunarTerrain(scene, new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial());
  t.after(() => terrain.stream?.dispose());
  let prepared = 0;
  await terrain.initializeStreaming({ worker, nextFrame: nextTurn, prepareGeometry: () => prepared++ });
  assert.ok(prepared >= terrain.tiles.size);
  const originalKeys = [...terrain.tiles.keys()];
  const player = new playerController();
  player.scene = scene;
  const handles = new Map();

  /** 同步测试或基准中角色附近的地形碰撞体。 */
  const sync = (x, z) => {
    const needed = terrain.nearbyColliders(x, z);
    for (const [key, mesh] of needed) {
      assert.ok(mesh.geometry.boundsTree, '注册碰撞体时 BVH 必须已就绪');
      if (handles.get(key)?.collisionMesh !== mesh) {
        terrain.onRemove(key);
        handles.set(key, player.addCollider({ motion: 'static', shape: { kind: 'mesh', mesh } }));
      }
    }
    for (const [key, handle] of handles)
      if (!needed.has(key)) {
        player.removeCollider(handle);
        terrain.releaseCollider(key, handle.collisionMesh);
        handles.delete(key);
      }
  };
  terrain.onRemove = (key) => {
    if (!handles.has(key)) return;
    const handle = handles.get(key);
    player.removeCollider(handle);
    terrain.releaseCollider(key, handle.collisionMesh);
    handles.delete(key);
  };
  sync(0, 0);
  assert.ok(player.isStaticColliderUsable());
  const initialRay = new THREE.Raycaster(new THREE.Vector3(0.37, 200, 0.51), new THREE.Vector3(0, -1, 0));
  assert.ok(
    Math.abs(initialRay.intersectObjects(player.getColliderMeshes())[0].point.y - terrain.surfaceHeightAt(0.37, 0.51)) <
      1e-5,
  );

  worker.paused = true;
  terrain.update(96.1, 1, 0, 0);
  assert.deepEqual([...terrain.tiles.keys()], originalKeys, '待提交方案不能移除现有地表');
  assert.ok(player.isStaticColliderUsable(), '工作线程繁忙时旧碰撞仍需有效');
  // 在旧请求尚未返回时替换排队方案，并切换浮动原点。
  terrain.update(108.1, -12.1, 0, 0);
  for (const [key, handle] of handles) {
    player.removeCollider(handle);
    terrain.releaseCollider(key, handle.collisionMesh);
  }
  handles.clear();
  terrain.rebase(3072, -3072, 3072, -3072);
  worker.resume();
  await waitForTerrain(terrain, 108.1, -12.1, 3072, -3072);
  assert.deepEqual(new Set(terrain.tiles.keys()), new Set(planTerrainPatches(108.1, -12.1).map((p) => p.key)));
  sync(108.1, -12.1);
  for (const mesh of terrain.tiles.values()) {
    assert.equal(mesh.position.x, mesh.userData.x - 3072);
    assert.equal(mesh.position.z, mesh.userData.z + 3072);
  }
  const px = 108.37,
    pz = -12.51;
  const ray = new THREE.Raycaster(new THREE.Vector3(px - 3072, 200, pz + 3072), new THREE.Vector3(0, -1, 0));
  const hits = ray.intersectObjects(player.getColliderMeshes());
  assert.ok(hits.length);
  assert.ok(Math.abs(hits[0].point.y - terrain.surfaceHeightAt(px, pz)) < 1e-5);
  const underfoot = terrain.surfaceCells.get('9,-2');
  assert.equal(underfoot.userData.step, 0.25);
  const position = underfoot.geometry.getAttribute('position');
  assert.ok(Math.abs(position.getY(0) - heightAt(underfoot.userData.x, underfoot.userData.z)) < 1e-5);

  // 已释放注册碰撞网格的缓存方案仍应能够重建并复用。
  await waitForTerrain(terrain, 120.1, -12.1, 3072, -3072);
  sync(120.1, -12.1);
  const hitsBefore = terrain.stream.stats.cacheHits;
  await waitForTerrain(terrain, 108.1, -12.1, 3072, -3072);
  sync(108.1, -12.1);
  assert.ok(terrain.stream.stats.cacheHits > hitsBefore);
  assert.ok(player.isStaticColliderUsable());
  assert.ok(terrain.gravelCells.size <= 384);
  // 缓存压力下不能淘汰正在显示的地形。
  terrain.stream.maxCacheBytes = 0;
  terrain.stream.trim();
  for (const key of terrain.tiles.keys()) assert.ok(terrain.stream.cache.has(key));
  for (const handle of handles.values()) player.removeCollider(handle);
});

test('工作线程失败应拒绝加载，不能永久等待地形方案', async (t) => {
  const terrain = new LunarTerrain(
    new THREE.Scene(),
    new THREE.MeshStandardMaterial(),
    new THREE.MeshStandardMaterial(),
  );
  t.after(() => terrain.stream?.dispose());
  const worker = {
    /** 模拟工作线程接收任务。 */
    postMessage() {
      queueMicrotask(() => worker.onerror({ message: '工作线程加载失败' }));
    },

    /** 提供工作线程终止接口，供测试释放资源。 */
    terminate() {},
  };
  await assert.rejects(terrain.initializeStreaming({ worker, nextFrame: nextTurn }), /工作线程加载失败/);
});
