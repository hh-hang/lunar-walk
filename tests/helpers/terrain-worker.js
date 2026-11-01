import { Worker } from 'node:worker_threads';

/** 用 Node 工作线程模拟浏览器接口，支持暂停与延迟返回。 */
export function nodeTerrainWorker() {
  const worker = new Worker(new URL('./terrain-node-worker.js', import.meta.url));
  const held = [];
  const bridge = {
    paused: false,
    postMessage: (job) => worker.postMessage(job),
    terminate: () => worker.terminate(),

    /** 按原顺序发送暂停期间暂存的工作线程结果。 */
    resume() {
      bridge.paused = false;
      for (const data of held.splice(0)) bridge.onmessage?.({ data });
    },
  };
  worker.on('message', (data) => {
    if (bridge.paused) held.push(data);
    else bridge.onmessage?.({ data });
  });
  worker.on('error', (error) => bridge.onerror?.({ message: error.message }));
  return bridge;
}

/** 等待下一个事件循环，允许工作线程处理任务。 */
export const nextTurn = () => new Promise((resolve) => setTimeout(resolve, 1));

/** 等待指定地形方案提交，超时给出明确错误。 */
export async function waitForTerrain(terrain, x, z, originX = 0, originZ = 0) {
  const wanted = `${Math.floor(x / 12)},${Math.floor(z / 12)}`;
  const deadline = performance.now() + 15000;
  while (performance.now() < deadline) {
    terrain.update(x, z, originX, originZ);
    if (terrain.stream.appliedId === wanted) return;
    await nextTurn();
  }
  throw new Error(`地形方案 ${wanted} 未在期限内就绪`);
}
