import * as THREE from 'three';

const SIDES = ['left', 'right'];

// 集中适配控制器内部的接触状态；调试文字和 IK 权重不能当作落脚事件。
export class FootIKContactSource {
  /** 准备读取最终鞋底四角所需的临时向量。 */
  constructor(footIK) {
    this.footIK = footIK;
    this.corners = [0, 1, 2, 3].map(() => new THREE.Vector3());
  }

  /** 读取指定脚的支撑标记，并将最终鞋底四角转换到世界坐标。 */
  read(side) {
    const leg = this.footIK.legs?.[side];
    if (!leg?.foot || leg.soleSamples?.length !== 4) return null;
    leg.foot.updateWorldMatrix(true, false);
    for (let i = 0; i < 4; i++) this.corners[i].copy(leg.soleSamples[i].local).applyMatrix4(leg.foot.matrixWorld);
    return { planted: leg.planted, corners: this.corners };
  }
}

export class FootContactGate {
  /** 初始化左右脚的接触确认状态。 */
  constructor() {
    this.reset();
  }

  /** 清除支撑、连续接触帧数和本次落脚的消费标记。 */
  reset() {
    this.states = Object.fromEntries(SIDES.map((side) => [side, { planted: false, consumed: false, frames: 0 }]));
  }

  /** 连续两帧稳定接触后仅放行一次盖印。 */
  accept(side, planted, touching) {
    const state = this.states[side];
    if (!planted) {
      state.planted = false;
      state.consumed = false;
      state.frames = 0;
      return false;
    }
    if (!state.planted) {
      state.consumed = false;
      state.frames = 0;
    }
    state.planted = true;
    if (state.consumed) return false;
    state.frames = touching ? state.frames + 1 : 0;
    if (state.frames < 2) return false;
    state.consumed = true;
    return true;
  }

  /** 鞋底滑到新位置后重新确认当前支撑。 */
  reopen(side) {
    const state = this.states[side];
    state.consumed = false;
    state.frames = 0;
  }
}

export class LunarFootContacts {
  /** 初始化鞋底接触采样、去重门控与站立稳定检测。 */
  constructor(footIK, onContact, { origin = { value: new THREE.Vector2() }, tolerance = 0.018 } = {}) {
    this.name = 'lunar-footprint-contacts';
    this.footIK = footIK;
    this.source = new FootIKContactSource(footIK);
    this.gate = new FootContactGate();
    this.origin = origin;
    this.onContact = onContact;
    this.tolerance = tolerance;
    this.ray = new THREE.Raycaster(new THREE.Vector3(), new THREE.Vector3(0, -1, 0), 0, 0.16);
    this.ray.firstHitOnly = true;
    this.hits = [];
    this.normal = new THREE.Vector3();
    this.normalMatrix = new THREE.Matrix3();
    this.stats = { left: '等待落地', right: '等待落地', contacts: 0, rocks: 0 };
    this.last = { left: null, right: null };
    // 站立动画混合期间双脚保持支撑；等鞋底停止滑动后，才允许补上站立脚印。
    this.settleSpeed = 0.2;
    this.restampDistance = 0.06;
    this.soles = { left: new THREE.Vector3(), right: new THREE.Vector3() };
    this.previousSoles = { left: null, right: null };
  }

  /** 挂载到角色并保存控制器引用。 */
  onAttach(player) {
    this.player = player;
  }
  /** 解绑角色并清除待确认的支撑。 */
  onDetach() {
    this.player = null;
    this.gate.reset();
  }
  /** 更换角色模型后重新确认双脚接触。 */
  onPlayerModelChange() {
    this.gate.reset();
  }

  /** 在最终 IK 姿态上检测月壤支撑，过滤岩石并生成单次脚印。 */
  onAfterAnimationUpdate(delta = 1 / 60) {
    const player = this.player;
    if (
      !player ||
      !this.footIK.enabled ||
      !player.playerIsOnGround ||
      player.isFlying ||
      player.getControllerMode?.() === 1
    ) {
      this.gate.reset();
      if (player && !player.playerIsOnGround) this.last.left = this.last.right = null;
      this.stats.left = this.stats.right = '未接地';
      return;
    }
    const meshes = player.getColliderMeshes();
    for (const side of SIDES) {
      const contact = this.source.read(side);
      if (!contact) {
        this.stats[side] = '骨骼未就绪';
        continue;
      }
      const speed = this.trackSole(side, contact.corners, delta);
      if (!contact.planted) {
        this.gate.accept(side, false, false);
        this.stats[side] = '摆动';
        continue;
      }
      // 站立会保留上一次支撑标记；鞋底移到新位置后需重新确认，防止漏掉最终脚印。
      const holdingStance = typeof this.footIK.isLocomotion === 'function' && !this.footIK.isLocomotion();
      const settled = !holdingStance || speed <= this.settleSpeed;
      if (this.gate.states[side].consumed) {
        const last = this.last[side];
        const sole = this.soles[side];
        const shifted = holdingStance && last && Math.hypot(sole.x - last.x, sole.z - last.z) >= this.restampDistance;
        if (shifted) this.gate.reopen(side);
        else continue;
      }
      let touching = 0,
        soil = 0,
        closest = Infinity,
        hitY = 0,
        blockedByRock = false;
      const rayLift = this.footIK.maxFootRaise + 0.06;
      this.ray.far = rayLift + this.footIK.maxFootDrop + 0.06;
      this.normal.set(0, 0, 0);
      for (const point of contact.corners) {
        this.ray.ray.origin.copy(point).y += rayLift;
        this.hits.length = 0;
        this.ray.intersectObjects(meshes, false, this.hits);
        const hit = this.hits[0];
        if (!hit) continue;
        const gap = point.y - hit.point.y;
        if (hit.object.userData.surface !== 'regolith' && gap < this.tolerance) blockedByRock = true;
        closest = Math.min(closest, Math.abs(gap));
        if (Math.abs(gap) > this.tolerance) continue;
        touching++;
        if (hit.object.userData.surface !== 'regolith') continue;
        soil++;
        hitY += hit.point.y;
        this.normalMatrix.getNormalMatrix(hit.object.matrixWorld);
        this.normal.add(new THREE.Vector3().copy(hit.face.normal).applyMatrix3(this.normalMatrix).normalize());
      }
      this.stats[side] = touching
        ? `接触 ${soil}/4 月壤`
        : Number.isFinite(closest)
          ? `距地 ${(closest * 100).toFixed(1)} cm`
          : '无支撑';
      const soilContact = soil >= 2 && soil === touching && !blockedByRock;
      const rockContact = blockedByRock && touching > 0;
      if (!this.gate.accept(side, true, (soilContact || rockContact) && settled)) continue;
      // 混合支撑也不盖印，避免脚印跨过岩石并压到下方月壤。
      if (rockContact) {
        this.stats.rocks++;
        continue;
      }
      const corners = contact.corners.map((point) => ({
        x: point.x + this.origin.value.x,
        y: point.y,
        z: point.z + this.origin.value.y,
      }));
      const normal = this.normal.normalize().clone();
      const center = new THREE.Vector3();
      for (const point of corners) center.add(point);
      center.multiplyScalar(0.25);
      center.y = hitY / soil;
      const last = this.last[side];
      // 抑制动画切换或 IK 开关在同一位置重复盖印。
      if (last && Math.hypot(center.x - last.x, center.z - last.z) < 0.025) continue;
      this.last[side] = center.clone();
      this.stats.contacts++;
      this.onContact({ side, corners, point: center, normal });
    }
  }

  /** 记录鞋底世界位置并计算滑动速度，用于判断站立是否稳定。 */
  trackSole(side, corners, delta) {
    const sole = this.soles[side].set(0, 0, 0);
    for (const point of corners) sole.add(point);
    sole.multiplyScalar(0.25);
    sole.x += this.origin.value.x;
    sole.z += this.origin.value.y;
    const previous = this.previousSoles[side];
    const speed = previous ? Math.hypot(sole.x - previous.x, sole.z - previous.z) / Math.max(delta, 1 / 240) : 0;
    if (previous) previous.copy(sole);
    else this.previousSoles[side] = sole.clone();
    return speed;
  }
}
