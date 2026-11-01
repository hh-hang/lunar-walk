import { ASCENT_MOTION_DURATION, ENDING_FADE_DURATION } from './ascent-profile.js';

/** 采样 / 登舱水平交互半径；调试面板可改，玩法与可视化共用。 */
export const INTERACTION = {
  sampleDistance: 2.6,
  boardingDistance: 4,
};
export const SAMPLE_DISTANCE = INTERACTION.sampleDistance;
export const BOARDING_DISTANCE = INTERACTION.boardingDistance;
export { ENDING_FADE_DURATION };
/** 与舱体运动结束对齐：淡出完毕后再进入结局页。 */
export const RETURN_DURATION = ASCENT_MOTION_DURATION;

const FRAGMENT_DEFS = [
  { id: 'attitude', title: '姿态校准记录' },
  { id: 'orbit', title: '轨道参数记录' },
  { id: 'coordinates', title: '返航坐标记录' },
];

/** 沿出生点→登月舱走廊的三段进度；点位贴近该线，略偏一侧。 */
const FRAGMENT_BANDS = [
  [0.16, 0.30],
  [0.34, 0.48],
  [0.52, 0.66],
];

/** 在目标附近选择较平整且避开大石头的位置，不改动已有地形。 */
function findSite(heightAt, x, z, radius, rocks) {
  let best = null;
  for (let dz = -12; dz <= 12; dz += 4)
    for (let dx = -12; dx <= 12; dx += 4) {
      const px = x + dx, pz = z + dz, y = heightAt(px, pz);
      const left = heightAt(px - radius, pz), right = heightAt(px + radius, pz);
      const back = heightAt(px, pz - radius), front = heightAt(px, pz + radius);
      const slopeX = (right - left) / (2 * radius), slopeZ = (front - back) / (2 * radius);
      const roughness = Math.abs((left + right + back + front) / 4 - y);
      const blocked = rocks.some((rock) => rock.scale > 0.45 && Math.hypot(rock.x - px, rock.z - pz) < radius + rock.scale + 1);
      const score = Math.hypot(slopeX, slopeZ) * 20 + roughness * 10 + Math.hypot(dx, dz) * 0.025 + (blocked ? 1000 : 0);
      if (!best || score < best.score) best = { x: px, y, z: pz, slopeX, slopeZ, score };
    }
  return best;
}

/** 在出生点与登月舱连线附近随机落三点；每次调用结果不同。 */
export function createFragmentPlan(heightAt, lander, rocks = [], random = Math.random) {
  const dist = Math.hypot(lander.x, lander.z) || 1;
  const ux = lander.x / dist, uz = lander.z / dist;
  const px = -uz, pz = ux;
  const order = FRAGMENT_DEFS.map((_, index) => index);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const fragments = [];
  for (let slot = 0; slot < FRAGMENT_BANDS.length; slot++) {
    const [t0, t1] = FRAGMENT_BANDS[slot];
    let chosen = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      const t = t0 + random() * (t1 - t0);
      const lateral = (random() < 0.5 ? -1 : 1) * (6 + random() * 16);
      const site = findSite(heightAt, ux * dist * t + px * lateral, uz * dist * t + pz * lateral, 0.8, rocks);
      const crowded = fragments.some((item) => Math.hypot(item.x - site.x, item.z - site.z) < 28);
      if (crowded && attempt < 9) continue;
      if (!chosen || site.score < chosen.score) chosen = site;
    }
    fragments.push({ ...chosen, ...FRAGMENT_DEFS[order[slot]] });
  }
  return fragments;
}

/** 安排短途探索路线：登月舱约一百四十米外，三份记录沿途随机刷新。 */
export function createMissionPlan(heightAt, rocks = [], random = Math.random) {
  const lander = findSite(heightAt, 69.34, -126.59, 4.5, rocks);
  return {
    lander,
    fragments: createFragmentPlan(heightAt, lander, rocks, random),
  };
}

/** 在人物周围六米半内选较平整的位置，优先视野前方，并避开岩石及车辆。 */
export function findNearbyLanderSite(heightAt, position, forward, obstacles = []) {
  const heading = Math.atan2(forward.x, forward.z);
  let best = null;
  for (let index = 0; index < 16; index++) {
    const angle = heading + index * Math.PI / 8;
    const x = position.x + Math.sin(angle) * 6.5, z = position.z + Math.cos(angle) * 6.5;
    const y = heightAt(x, z);
    const left = heightAt(x - 2, z), right = heightAt(x + 2, z);
    const back = heightAt(x, z - 2), front = heightAt(x, z + 2);
    const slopeX = (right - left) / 4, slopeZ = (front - back) / 4;
    const blocked = obstacles.some((item) => item.scale > 0.45 && Math.hypot(item.x - x, item.z - z) < 2.5 + item.scale);
    const score = Math.hypot(slopeX, slopeZ) * 20 + Math.abs((left + right + back + front) / 4 - y) * 10 +
      Math.abs(y - position.y) * 2 + Math.min(index, 16 - index) * 0.02 + (blocked ? 1000 : 0);
    if (!best || score < best.score) best = { x, y, z, slopeX, slopeZ, score };
  }
  return best;
}

/** 保存收集与返航进度；判断始终使用绝对世界坐标，独立于画面和浮动原点。 */
export class ReturnMission {
  /** 每次探索创建独立进度，重新开始时不继承已采样状态。 */
  constructor(plan) {
    this.lander = { ...plan.lander };
    this.fragments = plan.fragments.map((fragment) => ({ ...fragment, collected: false }));
    this.phase = 'exploring';
    this.elapsed = 0;
    this.returnElapsed = 0;
    this.debugBoarding = false;
  }

  /** 返回已采样数量。 */
  get collectedCount() {
    return this.fragments.reduce((count, fragment) => count + Number(fragment.collected), 0);
  }

  /** 正常探索集齐导航后公开坐标；调试开关临时放行，不改动碎片进度。 */
  get mapTarget() {
    return (this.debugBoarding || this.collectedCount === this.fragments.length) && this.phase === 'exploring' ? this.lander : null;
  }

  /** 步行靠近未采样点时可挖掘；车上不能采样。 */
  findSamplable(position, driving = false) {
    if (driving || this.phase !== 'exploring') return null;
    let best = null;
    let bestDistance = INTERACTION.sampleDistance;
    for (const fragment of this.fragments) {
      if (fragment.collected || Math.abs(position.y - fragment.y) > 3.5) continue;
      const distance = Math.hypot(position.x - fragment.x, position.z - fragment.z);
      if (distance > bestDistance) continue;
      best = fragment;
      bestDistance = distance;
    }
    return best;
  }

  /** 是否可在当前位置按 F 采样。 */
  canSample(position, driving = false) {
    return Boolean(this.findSamplable(position, driving));
  }

  /** 手动采样最近一点；成功后返回该碎片，失败返回 null。 */
  sample(position, driving = false) {
    const fragment = this.findSamplable(position, driving);
    if (!fragment) return null;
    fragment.collected = true;
    return fragment;
  }

  /** 推进返航过场计时；采样改为按键触发，靠近不再自动收集。 */
  update(position, delta) {
    const dt = Math.max(0, delta);
    if (this.phase === 'returning') {
      this.returnElapsed = Math.min(RETURN_DURATION, this.returnElapsed + dt);
      if (this.returnElapsed >= RETURN_DURATION) this.phase = 'complete';
    } else if (this.phase === 'exploring') {
      this.elapsed += dt;
    }
  }

  /** 返航要求导航解锁、步行登舱，并实际位于舱体附近。 */
  canReturn(position, driving = false) {
    return Boolean(this.mapTarget) && !driving && Math.abs(position.y - this.lander.y) < 4 &&
      Math.hypot(position.x - this.lander.x, position.z - this.lander.z) <= INTERACTION.boardingDistance;
  }

  /** 只触发一次返航，避免键盘连按或重复点击重置过场。 */
  startReturn(position, driving = false) {
    if (!this.canReturn(position, driving)) return false;
    this.phase = 'returning';
    this.returnElapsed = 0;
    return true;
  }

  /** 再探索时清空收集与过场；可选换上新的碎片坐标，登月舱仍由场景侧恢复。 */
  reset(nextFragments = null) {
    if (nextFragments) {
      for (let i = 0; i < this.fragments.length; i++) {
        const next = nextFragments[i];
        Object.assign(this.fragments[i], {
          id: next.id,
          title: next.title,
          x: next.x,
          y: next.y,
          z: next.z,
          slopeX: next.slopeX,
          slopeZ: next.slopeZ,
          collected: false,
        });
      }
    } else {
      for (const fragment of this.fragments) fragment.collected = false;
    }
    this.phase = 'exploring';
    this.elapsed = 0;
    this.returnElapsed = 0;
    this.debugBoarding = false;
  }
}
