import { ease, randomAt, smoothNoise } from './noise.js';

// 小坑尺寸参考月海平衡分布 N(>r) ∝ r^-2；密度和退化程度是面向探索的近似参数。
// https://arxiv.org/abs/1902.07746
const bands = [
  { spacing: 1400, min: 280, max: 700, density: 0.8, depth: 0.22, salt: 701, regional: true },
  { spacing: 192, min: 14, max: 90, density: 2.2, depth: 0.3, salt: 130 },
  { spacing: 48, min: 3.5, max: 14, density: 2.1, depth: 0.28, salt: 260 },
  { spacing: 16, min: 1.4, max: 3.5, density: 1.3, depth: 0.26, salt: 390 },
  { spacing: 6, min: 0.45, max: 1.4, density: 1.9, depth: 0.34, salt: 521 },
  { spacing: 2, min: 0.16, max: 0.45, density: 1.6, depth: 0.23, salt: 586 },
  { spacing: 0.8, min: 0.07, max: 0.16, density: 0.8, depth: 0.18, salt: 651 },
];
const catalogs = bands.map(() => new Map());
const neighborhoods = bands.map(() => new Map());
const CACHE_LIMIT = 4096;

/** 按泊松分布决定一个空间目录中的坑数，允许空白、重叠和局部密集。 */
function poissonCount(mean, sample) {
  let count = 0, probability = Math.exp(-mean), cumulative = probability;
  while (sample > cumulative && count < 16) {
    probability *= mean / ++count;
    cumulative += probability;
  }
  return count;
}

/** 从截断幂律分布采样半径，避免每个尺度的坑都接近同样大小。 */
export function craterRadius(min, max, sample) {
  return 1 / Math.sqrt(1 / min ** 2 - sample * (1 / min ** 2 - 1 / max ** 2));
}

/** 缓存空间目录，逐项淘汰旧数据以限制无限探索的内存占用。 */
function remember(cache, key, value) {
  cache.set(key, value);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  return value;
}

/** 目录仅用于查询加速，坑中心可落在整个目录内，不设置等间距或最小间距。 */
function cellCraters(index, ix, iz) {
  const cache = catalogs[index], key = `${ix}:${iz}`;
  if (cache.has(key)) return cache.get(key);
  const band = bands[index];
  const density = 0.45 + smoothNoise((ix + 0.5) * band.spacing / 360, (iz + 0.5) * band.spacing / 360, 801) * 1.1;
  const count = poissonCount(band.density * density, randomAt(ix, iz, band.salt));
  const craters = [];
  for (let i = 0; i < count; i++) {
    const salt = band.salt + 11 + i * 17;
    const radius = craterRadius(band.min, band.max, randomAt(ix, iz, salt + 2));
    const age = randomAt(ix, iz, salt + 3);
    const fresh = randomAt(ix, iz, salt + 7) < (index >= 4 ? 0.16 : 0.08);
    craters.push({
      x: (ix + randomAt(ix, iz, salt)) * band.spacing,
      z: (iz + randomAt(ix, iz, salt + 1)) * band.spacing,
      radius,
      reach: radius * 2.4,
      age: band.regional ? 0.76 + age * 0.23 : fresh ? age * 0.22 : 0.38 + age ** 0.45 * 0.61,
      depth: radius * band.depth * (0.8 + randomAt(ix, iz, salt + 4) * 0.4),
      ellipse: 0.96 + randomAt(ix, iz, salt + 5) * 0.08,
      phase: randomAt(ix, iz, salt + 6) * Math.PI * 2,
    });
  }
  return remember(cache, key, craters);
}

/** 查询会影响整块目录的坑，保证跨目录边界、负坐标和重新加载时高度一致。 */
function nearbyCraters(x, z, index) {
  const band = bands[index], ix = Math.floor(x / band.spacing), iz = Math.floor(z / band.spacing);
  const cache = neighborhoods[index], key = `${ix}:${iz}`;
  if (cache.has(key)) return cache.get(key);
  const reach = Math.ceil(band.max * 2.4 / band.spacing);
  const left = ix * band.spacing, top = iz * band.spacing, craters = [];
  for (let dz = -reach; dz <= reach; dz++)
    for (let dx = -reach; dx <= reach; dx++)
      for (const crater of cellCraters(index, ix + dx, iz + dz)) {
        if (crater.x + crater.reach < left || crater.x - crater.reach > left + band.spacing ||
            crater.z + crater.reach < top || crater.z - crater.reach > top + band.spacing) continue;
        craters.push(crater);
      }
  // 先旧后新，让后来的撞击削弱重叠处的旧坑缘。
  craters.sort((a, b) => b.age - a.age);
  return remember(cache, key, craters);
}

/** 模拟碗状坑底、随退化变宽变低的坑缘和薄喷出物裙；不为小坑添加中央峰。 */
export function impactProfile(radius, age, angle = 0, phase = 0) {
  if (radius >= 2.15) return 0;
  const bowl = radius < 1 ? -((1 - radius * radius) ** (1.25 + age * 0.55)) * (1 - 0.96 * age) : 0;
  const crest = 1.03;
  const shoulder = ease(0.72 - age * 0.18, crest, radius) * (1 - ease(crest, 1.45 + age * 0.5, radius));
  const breach = ease(0.55, 0.98, Math.cos(angle - phase));
  const rim = (0.17 * (1 - age) ** 2 + 0.004) * (1 - breach * (0.15 + age * 0.8));
  const apron = ease(1.03, 1.25, radius) * (1 - ease(1.25, 2.15, radius));
  return bowl + shoulder * rim + apron * 0.025 * (1 - age) ** 2;
}

/** 叠加指定尺度的撞击形态；世界坐标直接采样，不复用周期高度贴片。 */
export function craterHeightAt(x, z, scale = 'surface') {
  const begin = scale === 'regional' ? 0 : scale === 'detail' ? 4 : 1;
  const end = scale === 'regional' ? 1 : scale === 'detail' ? bands.length : 4;
  let result = 0;
  for (let index = begin; index < end; index++) {
    let layerHeight = 0;
    for (const crater of nearbyCraters(x, z, index)) {
      const dx = x - crater.x, dz = z - crater.z;
      if (Math.abs(dx) > crater.reach || Math.abs(dz) > crater.reach) continue;
      const px = dx * crater.ellipse, pz = dz / crater.ellipse;
      const distance = Math.hypot(px, pz) / crater.radius;
      if (distance > 2.22) continue;
      const angle = Math.atan2(pz, px);
      // 仅作低频、轻微的轮廓变化，避免固定高频正弦产生齿轮状坑缘。
      const radius = distance / (1 + Math.sin(angle * 2 + crater.phase) * 0.018 + Math.sin(angle * 3 - crater.phase) * 0.012);
      const cut = (1 - ease(0.5, 1.15, radius)) * (1 - crater.age) * 0.8;
      layerHeight *= 1 - cut;
      layerHeight += crater.depth * impactProfile(radius, crater.age, angle, crater.phase);
    }
    result += layerHeight;
  }
  return result;
}
