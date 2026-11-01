import { heightAt, regionalHeight } from './height.js';

const templates = new Map();
const heightCache = new Map();
const MAX_HEIGHT_SAMPLES = 160000;

/** 缓存世界坐标高度，复用相邻地块的重复采样。 */
function sampleHeight(x, z) {
  const key = `${x},${z}`;
  let height = heightCache.get(key);
  if (height === undefined) {
    height = heightAt(x, z);
    heightCache.set(key, height);
  }
  return height;
}

/** 按细分数缓存地表三角形与裙边拓扑。 */
function topology(segments) {
  if (templates.has(segments)) return templates.get(segments);
  const width = segments + 1,
    surfaceVertices = width ** 2;
  const IndexArray = surfaceVertices + segments * 16 > 65535 ? Uint32Array : Uint16Array;
  const indices = new IndexArray(segments ** 2 * 6 + segments * 24);
  let cursor = 0;
  for (let z = 0; z < segments; z++)
    for (let x = 0; x < segments; x++) {
      const i = z * width + x;
      indices.set([i, i + width, i + 1, i + 1, i + width, i + width + 1], cursor);
      cursor += 6;
    }
  const perimeter = [];
  for (let x = 0; x <= segments; x++) perimeter.push(x);
  for (let z = 1; z <= segments; z++) perimeter.push(z * width + segments);
  for (let x = segments - 1; x >= 0; x--) perimeter.push(segments * width + x);
  for (let z = segments - 1; z > 0; z--) perimeter.push(z * width);
  for (let i = 0; i < perimeter.length; i++) {
    const first = surfaceVertices + i * 4;
    indices.set([first, first + 1, first + 2, first + 2, first + 1, first + 3], cursor);
    cursor += 6;
  }
  const result = { indices, perimeter, surfaceVertices };
  templates.set(segments, result);
  return result;
}

/** 生成地块顶点、共享边界法线、纹理坐标与独立裙边。 */
export function createPatchData(ox, oz, size, segments) {
  const { indices, perimeter, surfaceVertices } = topology(segments);
  const count = surfaceVertices + perimeter.length * 4;
  const positions = new Float32Array(count * 3),
    normals = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  const width = segments + 1,
    stride = width + 2,
    step = size / segments;
  const heights = new Float32Array(stride ** 2);
  for (let z = -1; z <= width; z++)
    for (let x = -1; x <= width; x++) {
      heights[(z + 1) * stride + x + 1] = sampleHeight(ox + x * step, oz + z * step);
    }
  for (let z = 0; z < width; z++)
    for (let x = 0; x < width; x++) {
      const vertex = z * width + x,
        grid = (z + 1) * stride + x + 1;
      const wx = ox + x * step,
        wz = oz + z * step;
      positions.set([x * step, heights[grid], z * step], vertex * 3);
      uv.set([wx / 24, -wz / 24], vertex * 2);
      const edge = x === 0 || z === 0 || x === segments || z === segments;
      const delta = edge ? 0.18 : step;
      const nx = edge
        ? sampleHeight(wx - delta, wz) - sampleHeight(wx + delta, wz)
        : heights[grid - 1] - heights[grid + 1];
      const nz = edge
        ? sampleHeight(wx, wz - delta) - sampleHeight(wx, wz + delta)
        : heights[grid - stride] - heights[grid + stride];
      const length = Math.hypot(nx, delta * 2, nz);
      normals.set([nx / length, (delta * 2) / length, nz / length], vertex * 3);
    }
  for (let i = 0; i < perimeter.length; i++) {
    const a = perimeter[i],
      b = perimeter[(i + 1) % perimeter.length];
    for (let corner = 0; corner < 4; corner++) {
      const source = corner < 2 ? a : b,
        vertex = surfaceVertices + i * 4 + corner;
      positions.set(positions.subarray(source * 3, source * 3 + 3), vertex * 3);
      positions[vertex * 3 + 1] -= corner % 2 ? 18 : 0;
      normals.set(normals.subarray(source * 3, source * 3 + 3), vertex * 3);
      uv.set(uv.subarray(source * 2, source * 2 + 2), vertex * 2);
    }
  }
  // 分批淘汰最早的高度样本，限制内存并避免清空缓存后的集中重建。
  if (heightCache.size > MAX_HEIGHT_SAMPLES) {
    const oldest = heightCache.keys();
    while (heightCache.size > MAX_HEIGHT_SAMPLES * 0.8) heightCache.delete(oldest.next().value);
  }
  return { positions, normals, uv, indices: indices.slice(), surfaceVertices, surfaceIndexCount: segments ** 2 * 6 };
}

/** 生成带月球曲率的远景环带数据。 */
export function createHorizonData(x, z) {
  const spokes = 384,
    bands = 68,
    width = spokes + 1,
    count = width * (bands + 1);
  const positions = new Float32Array(count * 3),
    normals = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2),
    indices = new Uint16Array(spokes * bands * 6);
  for (let band = 0; band <= bands; band++) {
    const radius = 440 + (band / bands) ** 1.65 * 7200;
    for (let spoke = 0; spoke <= spokes; spoke++) {
      const angle = (spoke / spokes) * Math.PI * 2;
      const px = Math.cos(angle) * radius,
        pz = Math.sin(angle) * radius;
      const wx = x + px,
        wz = z + pz,
        i = band * width + spoke;
      positions.set([px, regionalHeight(wx, wz) - 24 - (radius * radius) / 3474800, pz], i * 3);
      uv.set([wx / 24, -wz / 24], i * 2);
      const nx = regionalHeight(wx - 4, wz) - regionalHeight(wx + 4, wz);
      const nz = regionalHeight(wx, wz - 4) - regionalHeight(wx, wz + 4);
      const length = Math.hypot(nx, 8, nz);
      normals.set([nx / length, 8 / length, nz / length], i * 3);
    }
  }
  for (let band = 0; band < bands; band++)
    for (let spoke = 0; spoke < spokes; spoke++) {
      const a = band * width + spoke,
        b = a + width;
      indices.set([a, a + 1, b, b, a + 1, b + 1], (band * spokes + spoke) * 6);
    }
  return { positions, normals, uv, indices };
}
