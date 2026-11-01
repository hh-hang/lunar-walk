import { FOCUS_GRID, planTerrainPatches, distanceToPatch } from './patches.js';

class TerrainWorkerClient {
  /** 连接工作线程，维护串行任务与失败传播。 */
  constructor(worker) {
    this.worker = worker;
    this.jobs = new Map();
    this.serial = 0;
    this.active = null;
    this.failure = null;
    worker.onmessage = ({ data }) => {
      const job = this.active;
      if (!job || data.id !== job.id) return;
      this.active = null;
      this.jobs.delete(job.key);
      if (data.error) job.reject(new Error(data.error));
      else job.resolve(data);
      this.pump();
    };
    worker.onerror = (event) => {
      this.failure = new Error(event.message || '地形工作线程失败');
      for (const job of this.jobs.values()) job.reject(this.failure);
      this.jobs.clear();
      this.active = null;
    };
  }

  /** 按地块去重请求，并提高已有任务优先级。 */
  request(kind, patch, priority) {
    if (this.failure) return Promise.reject(this.failure);
    const existing = this.jobs.get(patch.key);
    if (existing) {
      existing.priority = Math.min(existing.priority, priority);
      return existing.promise;
    }
    const job = { id: ++this.serial, key: patch.key, kind, patch, priority };
    job.promise = new Promise((resolve, reject) => Object.assign(job, { resolve, reject }));
    this.jobs.set(job.key, job);
    this.pump();
    return job.promise;
  }

  /** 选择优先级最高的等待任务发送到工作线程。 */
  pump() {
    if (this.active || this.failure) return;
    let next;
    for (const job of this.jobs.values()) if (!next || job.priority < next.priority) next = job;
    if (!next) return;
    this.active = next;
    this.worker.postMessage({ id: next.id, kind: next.kind, patch: next.patch });
  }

  /** 取消不再需要且尚未开始的地形请求。 */
  cancelExcept(keys) {
    const cancelled = [];
    for (const [key, job] of this.jobs)
      if (job !== this.active && !keys.has(key)) {
        this.jobs.delete(key);
        job.reject(Object.assign(new Error('地形请求已过期'), { name: 'AbortError' }));
        cancelled.push(key);
      }
    return cancelled;
  }

  /** 终止工作线程并拒绝剩余任务。 */
  dispose() {
    this.worker.terminate();
    this.failure = new Error('流式地形已释放');
    for (const job of this.jobs.values()) job.reject(this.failure);
    this.jobs.clear();
    this.active = null;
  }
}

/** 计算地形属性、索引和 BVH 的总缓冲大小。 */
function byteSize(data) {
  return (
    data.positions.byteLength +
    data.normals.byteLength +
    data.uv.byteLength +
    data.indices.byteLength +
    (data.bvh ? data.bvh.index.byteLength + data.bvh.roots.reduce((sum, root) => sum + root.byteLength, 0) : 0)
  );
}

export class TerrainStream {
  /** 初始化流式地形队列、帧预算和有界缓存。 */
  constructor(terrain, { worker, prepareGeometry = () => {}, budgetMs = 2, maxCacheBytes = 64 * 1024 * 1024 } = {}) {
    this.terrain = terrain;
    this.source = new TerrainWorkerClient(
      worker ?? new Worker(new URL('./terrain.worker.js', import.meta.url), { type: 'module' }),
    );
    this.prepareGeometry = prepareGeometry;
    this.budgetMs = budgetMs;
    this.maxCacheBytes = maxCacheBytes;
    this.cache = new Map();
    this.bytes = 0;
    this.error = null;
    this.disposed = false;
    this.target = null;
    this.prefetch = [];
    this.horizonKey = null;
    this.pendingHorizon = null;
    this.stats = {
      updateMs: 0,
      peakMs: 0,
      commitMs: 0,
      preparationMs: 0,
      decorationMs: 0,
      commits: 0,
      cacheHits: 0,
      builds: 0,
      workerMs: 0,
      cached: 0,
      pending: 0,
    };
  }

  /** 复用缓存或请求地形数据，统计工作线程生成开销。 */
  request(patch, priority = 100, kind = 'patch') {
    let entry = this.cache.get(patch.key);
    if (entry) {
      if (priority < 1) {
        this.cache.delete(patch.key);
        this.cache.set(patch.key, entry);
      }
      if (entry.data) this.stats.cacheHits++;
      else this.source.request(kind, patch, priority);
      return entry;
    }
    entry = { patch, kind, data: null, mesh: null, prepared: false, bytes: 0 };
    this.cache.set(patch.key, entry);
    entry.promise = this.source
      .request(kind, patch, priority)
      .then((result) => {
        if (this.disposed) return;
        entry.data = result.data;
        entry.bytes = byteSize(entry.data);
        this.bytes += entry.bytes;
        this.stats.builds++;
        this.stats.workerMs = result.duration;
      })
      .catch((error) => {
        if (!this.disposed && error.name !== 'AbortError') this.error = error;
      });
    return entry;
  }

  /** 规划新的中心区域，取消过期任务并安排相邻预取。 */
  setTarget(x, z) {
    const gx = Math.floor(x / FOCUS_GRID),
      gz = Math.floor(z / FOCUS_GRID),
      id = `${gx},${gz}`;
    if (this.target?.id === id) return;
    const patches = planTerrainPatches(x, z);
    this.target = { id, gx, gz, patches, keys: new Set(patches.map((patch) => patch.key)) };
    const keep = new Set([...this.terrain.tiles.keys(), ...this.target.keys]);
    if (this.pendingHorizon) keep.add(this.pendingHorizon.patch.key);
    for (const key of this.source.cancelExcept(keep)) this.cache.delete(key);
    for (const patch of patches) this.request(patch, distanceToPatch(x, z, patch.x, patch.z, patch.size) / 10000);
    // 每帧仅预取一个相邻中心区域，避免地形提交边界上集中规划导致卡顿。
    this.prefetch = [];
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++) {
        if (dx || dz) this.prefetch.push({ x: (gx + dx + 0.5) * FOCUS_GRID, z: (gz + dz + 0.5) * FOCUS_GRID });
      }
    this.prefetch.sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z));
  }

  /** 在帧预算内预热网格、准备装饰物并提交完整地形方案。 */
  tick(x, z, originX, originZ) {
    if (this.error) throw this.error;
    const start = performance.now();
    this.frame = (this.frame ?? 0) + 1;
    this.setTarget(x, z);
    if (
      !this.pendingHorizon &&
      (!this.terrain.horizon ||
        Math.hypot(x - this.terrain.horizon.userData.x, z - this.terrain.horizon.userData.z) > 240)
    ) {
      const patch = { key: `horizon:${x},${z}`, x, z };
      this.pendingHorizon = this.request(patch, 0.5, 'horizon');
    }
    let prepared = 0;
    const preparationStart = performance.now();
    const targetReady = this.target.patches.every((patch) => this.cache.get(patch.key)?.prepared);
    const candidates = [...this.cache.values()].filter(
      (entry) =>
        entry.data &&
        !entry.prepared &&
        (!targetReady || this.appliedId === this.target.id || entry === this.pendingHorizon),
    );
    candidates.sort(
      (a, b) =>
        Number(!this.target.keys.has(a.patch.key) && a !== this.pendingHorizon) -
        Number(!this.target.keys.has(b.patch.key) && b !== this.pendingHorizon),
    );
    for (const entry of candidates) {
      if (prepared >= 2 || performance.now() - start >= this.budgetMs) break;
      entry.mesh = this.terrain.makeStreamMesh(entry.patch, entry.data, entry.kind, originX, originZ);
      this.prepareGeometry(entry.mesh.geometry);
      entry.prepared = true;
      prepared++;
    }
    this.stats.preparationMs = performance.now() - preparationStart;
    let committed = false;
    if (
      this.target.id !== this.appliedId &&
      this.target.patches.every((patch) => this.cache.get(patch.key)?.prepared)
    ) {
      if (!this.target.decorator || this.target.originX !== originX || this.target.originZ !== originZ) {
        this.target.originX = originX;
        this.target.originZ = originZ;
        this.target.decorations = null;
        this.target.decorator = this.terrain.prepareDecorations(this.target, this.cache, originX, originZ);
      }
      while (!this.target.decorations && performance.now() - start < this.budgetMs) {
        const step = this.target.decorator.next();
        if (step.done) {
          this.target.decorations = step.value;
          this.target.decorationsFrame = this.frame;
        }
      }
    }
    // 准备阶段耗尽预算时延后一帧提交，但低性能设备也必须最终提交已就绪的方案。
    if (
      this.target.id !== this.appliedId &&
      this.target.decorations &&
      (this.target.decorationsFrame < this.frame || performance.now() - start < Math.min(0.5, this.budgetMs / 2))
    ) {
      const commitStart = performance.now();
      this.terrain.applyStreamPlan(this.target, this.cache, originX, originZ);
      this.appliedId = this.target.id;
      this.stats.commitMs = performance.now() - commitStart;
      this.stats.commits++;
      committed = true;
    }
    if (this.pendingHorizon?.prepared) {
      const old = this.terrain.horizon;
      if (old) this.terrain.scene.remove(old);
      this.terrain.horizon = this.pendingHorizon.mesh;
      this.terrain.horizon.position.set(
        this.pendingHorizon.patch.x - originX,
        0,
        this.pendingHorizon.patch.z - originZ,
      );
      this.terrain.scene.add(this.terrain.horizon);
      if (this.horizonKey) this.evict(this.horizonKey);
      this.horizonKey = this.pendingHorizon.patch.key;
      this.pendingHorizon = null;
    }
    if (this.prefetch.length && performance.now() - start < this.budgetMs) {
      const next = this.prefetch.shift();
      for (const patch of planTerrainPatches(next.x, next.z)) this.request(patch);
    }
    this.trim();
    this.stats.cached = this.cache.size;
    this.stats.pending = this.source.jobs.size;
    this.stats.updateMs = performance.now() - start;
    this.stats.peakMs = Math.max(this.stats.peakMs, this.stats.updateMs);
    return committed;
  }

  /** 释放单个缓存地块及其碰撞资源，并扣除内存统计。 */
  evict(key) {
    const entry = this.cache.get(key);
    if (!entry) return;
    entry.mesh?.removeFromParent();
    entry.mesh?.geometry.dispose();
    const collision = entry.mesh?.userData.collisionMesh;
    collision?.geometry.dispose();
    collision?.material.dispose();
    this.bytes -= entry.bytes;
    this.cache.delete(key);
  }

  /** 淘汰非活动缓存，保护可见地形、待提交方案和远景。 */
  trim() {
    if (this.bytes <= this.maxCacheBytes && this.cache.size <= 512) return;
    for (const [key, entry] of this.cache) {
      if (
        !entry.data ||
        this.terrain.tiles.has(key) ||
        this.target.keys.has(key) ||
        key === this.horizonKey ||
        entry === this.pendingHorizon
      )
        continue;
      this.evict(key);
      if (this.bytes <= this.maxCacheBytes && this.cache.size <= 512) break;
    }
  }

  /** 终止地形生成并释放全部流式缓存。 */
  dispose() {
    this.disposed = true;
    this.source.dispose();
    for (const key of this.cache.keys()) this.evict(key);
  }
}
