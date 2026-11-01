export const FOOTPRINT_TILE_SIZE = 8;
export const FOOTPRINT_GRID = 3;
/** 计算非负余数，使负世界坐标也能映射到循环图集。 */
export const positiveMod = (value, divisor) => ((value % divisor) + divisor) % divisor;

/** 计算印记覆盖的全部地块，包含跨边界情况。 */
export function footprintTileKeys(record, size = FOOTPRINT_TILE_SIZE) {
  const rx = Math.abs(record.ax) + Math.abs(record.bx),
    rz = Math.abs(record.az) + Math.abs(record.bz);
  const keys = [];
  for (let z = Math.floor((record.z - rz) / size); z <= Math.floor((record.z + rz) / size); z++) {
    for (let x = Math.floor((record.x - rx) / size); x <= Math.floor((record.x + rx) / size); x++)
      keys.push(`${x},${z}`);
  }
  return keys;
}

export class FootprintStore {
  /** 创建按鞋印、车辙与采样坑分别限额的世界坐标历史。 */
  constructor({ limit = 5000, trackLimit = 8000, digLimit = 12, sizeScale = 1 } = {}) {
    this.sizeScale = sizeScale;
    this.serial = 0;
    this.records = new Map();
    this.tiles = new Map();
    this.onErase = () => {};
    this.byKind = { foot: new Map(), tire: new Map(), dig: new Map() };
    this.limits = { foot: limit, tire: trackLimit, dig: digLimit };
  }

  /** 将鞋底四角接触数据转换为可重建的印记记录。 */
  add(contact) {
    const [heelL, heelR, toeL] = contact.corners;
    const halfScale = 0.5 * this.sizeScale;
    const record = {
      kind: 'foot',
      side: contact.side,
      x: contact.point.x,
      y: contact.point.y,
      z: contact.point.z,
      ax: (heelR.x - heelL.x) * halfScale,
      az: (heelR.z - heelL.z) * halfScale,
      bx: (toeL.x - heelL.x) * halfScale,
      bz: (toeL.z - heelL.z) * halfScale,
      normal: { x: contact.normal.x, y: contact.normal.y, z: contact.normal.z },
    };
    return this.commit(record);
  }

  /** 保存一段轮胎印记，使用独立于鞋印的历史容量。 */
  addTrack(segment) {
    return this.commit({ ...segment, kind: 'tire' });
  }

  /**
   * 保存月壤采样坑（scoop trench）形变；
   * ax/az 为长轴半长，bx/bz 为短轴半宽，写入同一高度图集。
   */
  addDig(pit) {
    return this.commit({ ...pit, kind: 'dig' });
  }

  /** 过滤退化印记，建立地块索引，并淘汰超额的最旧记录。 */
  commit(record) {
    if (Math.abs(record.ax * record.bz - record.az * record.bx) < 1e-6) return null;
    record.id = ++this.serial;
    record.keys = footprintTileKeys(record);
    this.records.set(record.id, record);
    const kind = this.byKind[record.kind];
    kind.set(record.id, record);
    for (const key of record.keys) {
      if (!this.tiles.has(key)) this.tiles.set(key, new Set());
      this.tiles.get(key).add(record);
    }
    while (kind.size > this.limits[record.kind]) this.erase(kind.values().next().value);
    return record;
  }

  /** 移除历史记录及地块索引，通知图集清理相应区域。 */
  erase(record) {
    this.records.delete(record.id);
    this.byKind[record.kind].delete(record.id);
    for (const key of record.keys) {
      const tile = this.tiles.get(key);
      tile.delete(record);
      if (!tile.size) this.tiles.delete(key);
      this.onErase(key, record);
    }
  }

  /** 清理指定类型或全部印记历史。 */
  clear(kind) {
    if (kind) {
      for (const record of this.byKind[kind].values()) this.erase(record);
      return;
    }
    for (const key of this.tiles.keys()) this.onErase(key);
    this.tiles.clear();
    this.records.clear();
    this.byKind.foot.clear();
    this.byKind.tire.clear();
    this.byKind.dig.clear();
  }
}
