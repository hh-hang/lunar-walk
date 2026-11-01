import { parentPort } from 'node:worker_threads';
import { buildTerrainJob, terrainTransferables } from '../../src/terrain/terrain.worker.js';

parentPort.on('message', (job) => {
  try {
    const result = buildTerrainJob(job);
    parentPort.postMessage(result, terrainTransferables(result.data));
  } catch (error) {
    parentPort.postMessage({ id: job.id, error: error.message });
  }
});
