export const TILE_SIZE = 96;
export const VIEW_RADIUS = 6;
export const FOCUS_GRID = 12;

/** 计算平面点到方形地块的最近距离。 */
export function distanceToPatch(x, z, px, pz, size) {
  return Math.hypot(Math.max(px - x, 0, x - px - size), Math.max(pz - z, 0, z - pz - size));
}

/** 根据角色位置递归划分地块，近处保留高精度网格。 */
export function planTerrainPatches(worldX, worldZ) {
  const rootX = Math.floor(worldX / TILE_SIZE),
    rootZ = Math.floor(worldZ / TILE_SIZE);
  const focusX = (Math.floor(worldX / FOCUS_GRID) + 0.5) * FOCUS_GRID;
  const focusZ = (Math.floor(worldZ / FOCUS_GRID) + 0.5) * FOCUS_GRID;
  const patches = [];
  /** 递归细分附近地块，并为最终地块选择网格步长。 */
  function visit(x, z, size) {
    const distance = distanceToPatch(focusX, focusZ, x, z, size);
    const splitDistance = size === 96 ? 72 : size === 48 ? 32 : size === 24 ? 16 : -1;
    if (distance < splitDistance) {
      const half = size / 2;
      visit(x, z, half);
      visit(x + half, z, half);
      visit(x, z + half, half);
      visit(x + half, z + half, half);
      return;
    }
    const step = size === 12 ? 0.25 : size === 24 ? 0.5 : size === 48 ? 1 : distance < 260 ? 2 : distance < 460 ? 4 : 8;
    patches.push({ key: `${x},${z},${size},${step}`, x, z, size, step, segments: size / step });
  }
  for (let dz = -VIEW_RADIUS; dz <= VIEW_RADIUS; dz++)
    for (let dx = -VIEW_RADIUS; dx <= VIEW_RADIUS; dx++) {
      visit((rootX + dx) * TILE_SIZE, (rootZ + dz) * TILE_SIZE, TILE_SIZE);
    }
  return patches;
}
