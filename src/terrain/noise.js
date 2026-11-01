const SEED = 197208;

/** 将数值限制到零至一。 */
const clamp01 = (n) => Math.min(1, Math.max(0, n));
/** 将指定区间平滑映射到零至一。 */
export const ease = (a, b, n) => {
  const t = clamp01((n - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** 根据整数坐标和通道生成可复现的伪随机数。 */
export function randomAt(x, z, channel = 0) {
  let n = Math.imul(x, 1597334677) ^ Math.imul(z, 3812015801) ^ Math.imul(channel + SEED, 1013904223);
  n = Math.imul(n ^ (n >>> 16), 2246822507);
  n = Math.imul(n ^ (n >>> 13), 3266489909);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

/** 对固定随机网格作平滑插值，生成连续噪声。 */
export function smoothNoise(x, z, channel = 0) {
  const ix = Math.floor(x),
    iz = Math.floor(z);
  const fx = x - ix,
    fz = z - iz;
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const v = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const a = randomAt(ix, iz, channel),
    b = randomAt(ix + 1, iz, channel);
  const c = randomAt(ix, iz + 1, channel),
    d = randomAt(ix + 1, iz + 1, channel);
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}

/** 叠加旋转后的多层噪声，形成不同尺度的地形起伏。 */
export function relief(x, z, channel, octaves = 4) {
  let result = 0,
    weight = 0.56;
  for (let i = 0; i < octaves; i++) {
    result += (smoothNoise(x, z, channel + i) - 0.5) * weight;
    const nx = x * 1.63 - z * 1.14 + 7.1;
    z = x * 1.14 + z * 1.63 - 11.7;
    x = nx;
    weight *= 0.49;
  }
  return result;
}
