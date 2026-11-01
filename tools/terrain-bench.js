import * as THREE from 'three';
import { playerController } from 'three-player-controller';
import { LunarTerrain } from '../src/terrain/terrain.js';
import { nodeTerrainWorker, nextTurn } from '../tests/helpers/terrain-worker.js';

const scene = new THREE.Scene();
const terrain = new LunarTerrain(scene, new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial());
const player = new playerController();
player.scene = scene;
const handles = new Map();

/** 注销基准中的地形碰撞体并释放句柄。 */
const remove = (key) => {
  if (!handles.has(key)) return;
  const handle = handles.get(key);
  player.removeCollider(handle);
  terrain.releaseCollider(key, handle.collisionMesh);
  handles.delete(key);
};
terrain.onRemove = remove;

/** 同步测试或基准中角色附近的地形碰撞体。 */
const sync = (x, z) => {
  const needed = terrain.nearbyColliders(x, z);
  for (const [key, mesh] of needed)
    if (handles.get(key)?.collisionMesh !== mesh) {
      remove(key);
      handles.set(key, player.addCollider({ motion: 'static', shape: { kind: 'mesh', mesh } }));
    }
  for (const key of handles.keys()) if (!needed.has(key)) remove(key);
};

/** 将统计值保留两位小数，便于比较。 */
const round = (n) => Math.round(n * 100) / 100;

try {
  await terrain.initializeStreaming({ worker: nodeTerrainWorker(), nextFrame: nextTurn });
  sync(0, 1);
  let colliderX = 0;
  // 先等待相邻区域预取稳定，再以高于步行的速度连续扫过地形。
  for (let i = 0; i < 1000 && (terrain.stream.stats.pending || terrain.stream.prefetch.length); i++) {
    terrain.update(0, 1, 0, 0);
    await nextTurn();
  }
  const samples = [];
  for (let x = 0; x <= 120; x += 0.6) {
    const start = performance.now();
    const changed = terrain.update(x, 1, 0, 0);
    const updateMs = performance.now() - start;
    const syncStart = performance.now();
    if (changed || Math.abs(x - colliderX) >= 1) {
      sync(x, 1);
      colliderX = x;
    }
    const syncMs = performance.now() - syncStart;
    samples.push(updateMs + syncMs);
    if (changed)
      console.log(
        JSON.stringify({
          x: round(x),
          updateMs: round(updateMs),
          collisionMs: round(syncMs),
          commitMs: round(terrain.stream.stats.commitMs),
          decorationMs: round(terrain.stream.stats.decorationMs),
          preparationMs: round(terrain.stream.stats.preparationMs),
          cached: terrain.stream.cache.size,
        }),
      );
    await new Promise((resolve) => setTimeout(resolve, 8));
  }
  samples.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      frames: samples.length,
      medianMs: round(samples[Math.floor(samples.length * 0.5)]),
      p95Ms: round(samples[Math.floor(samples.length * 0.95)]),
      maxMs: round(samples.at(-1)),
      includesGpu: false,
      cached: terrain.stream.cache.size,
      cacheMiB: round(terrain.stream.bytes / 1024 ** 2),
    }),
  );
} finally {
  for (const key of handles.keys()) remove(key);
  terrain.stream?.dispose();
}
