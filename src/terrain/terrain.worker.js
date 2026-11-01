import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { createPatchData, createHorizonData } from './data.js';

/** 在工作线程生成地形、包围盒和仅含地表的碰撞 BVH。 */
export function buildTerrainJob(job) {
  const start = performance.now();
  const { x, z, size, segments } = job.patch;
  const data = job.kind === 'horizon' ? createHorizonData(x, z) : createPatchData(x, z, size, segments);
  const bounds = new THREE.Box3().setFromBufferAttribute(new THREE.BufferAttribute(data.positions, 3));
  data.bounds = { min: bounds.min.toArray(), max: bounds.max.toArray() };
  if (job.kind !== 'horizon') {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(data.positions.subarray(0, data.surfaceVertices * 3), 3),
    );
    geometry.setIndex(new THREE.BufferAttribute(data.indices.slice(0, data.surfaceIndexCount), 1));
    data.bvh = MeshBVH.serialize(new MeshBVH(geometry, { maxDepth: 100 }), { cloneBuffers: false });
  }
  return { id: job.id, data, duration: performance.now() - start };
}

/** 去重并收集可转移缓冲，避免跨线程复制大块数据。 */
export function terrainTransferables(data) {
  const buffers = [data.positions.buffer, data.normals.buffer, data.uv.buffer, data.indices.buffer];
  if (data.bvh) buffers.push(data.bvh.index.buffer, ...data.bvh.roots);
  return [...new Set(buffers)];
}

if (typeof self !== 'undefined')
  self.onmessage = ({ data: job }) => {
    try {
      const result = buildTerrainJob(job);
      self.postMessage(result, terrainTransferables(result.data));
    } catch (error) {
      self.postMessage({ id: job.id, error: error.message || String(error) });
    }
  };
