import * as THREE from 'three';
import { FootIK } from 'three-player-controller/foot-ik';

// 修正控制器下坡后残留的世界坐标脚底目标；适配逻辑集中在此，避免修改依赖源码。
export class LunarFootIK extends FootIK {
  /** 初始化足部旋转平滑、支撑法线与下坡恢复状态。 */
  constructor(options = {}) {
    super(options);
    this.smoothingEnabled = options.smoothingEnabled ?? true;
    this.smoothPoses = new Map();
    this.supportNormals = new Map();
    this.wantedCorrection = new THREE.Quaternion();
    this.smoothingDelta = 0;
  }

  /** 清除旋转和支撑法线历史，避免旧姿态污染新支撑。 */
  clearSmoothing() {
    this.smoothPoses?.clear();
    this.supportNormals?.clear();
  }

  /** 切换 IK 时同步清理平滑状态。 */
  setEnabled(enabled) {
    if (enabled !== this.enabled) this.clearSmoothing();
    super.setEnabled(enabled);
  }

  /** 解绑原生插件并释放平滑历史。 */
  onDetach() {
    super.onDetach();
    this.clearSmoothing();
  }
  /** 更换模型后清空历史并重新绑定骨骼。 */
  onPlayerModelChange() {
    this.clearSmoothing();
    super.onPlayerModelChange();
  }
  /** 清理平滑状态并释放原生 IK 资源。 */
  dispose() {
    this.clearSmoothing();
    super.dispose();
  }

  /** 返回原生 IK 配置及项目侧平滑开关。 */
  getOptions() {
    return { ...super.getOptions(), smoothingEnabled: this.smoothingEnabled };
  }

  /** 应用配置，并在平滑开关改变时重置历史。 */
  configure(options) {
    super.configure(options);
    if (options.smoothingEnabled !== undefined && options.smoothingEnabled !== this.smoothingEnabled) {
      this.smoothingEnabled = !!options.smoothingEnabled;
      this.clearSmoothing();
    }
  }

  /** 按模拟时间限制附加旋转变化，保留基础动画的播放速度。 */
  update(delta = 1 / 60) {
    if (!this.enabled || this.disposed) return;
    this.smoothingDelta = Math.max(0, delta);
    if (this.smoothingEnabled) {
      for (const leg of Object.values(this.legs))
        for (const key of ['upper', 'lower', 'foot']) {
          const bone = leg[key];
          if (!bone) continue;
          let pose = this.smoothPoses.get(bone);
          if (!pose) {
            pose = { animated: new THREE.Quaternion(), correction: new THREE.Quaternion() };
            this.smoothPoses.set(bone, pose);
          }
          pose.animated.copy(bone.quaternion);
        }
    }
    super.update(delta);
    const player = this.player;
    if (
      !this.smoothingEnabled ||
      !player?.playerIsOnGround ||
      player.isFlying ||
      player.getControllerMode?.() === 1 ||
      (!this.colliderMeshes.length && !player.getDynamicBodies?.().length)
    ) {
      this.clearSmoothing();
      return;
    }
    // 只过滤叠加的 IK 旋转，保留动画姿态；使用与动画混合器相同的模拟时间，保持慢动作连续。
    const alpha = -Math.expm1(-24 * this.smoothingDelta);
    for (const [bone, pose] of this.smoothPoses) {
      const wanted = this.wantedCorrection.copy(pose.animated).invert().multiply(bone.quaternion).normalize();
      const step = Math.min(pose.correction.angleTo(wanted) * alpha, 6 * this.smoothingDelta);
      pose.correction.rotateTowards(wanted, step);
      this.capture(bone);
      bone.quaternion.copy(pose.animated).multiply(pose.correction);
    }
    player.playerModel?.updateMatrixWorld(true);
  }

  /** 对有效支撑法线平滑，失去支撑时立即清理。 */
  castBestFootGround(leg) {
    const hit = super.castBestFootGround(leg);
    if (!this.smoothingEnabled) return hit;
    if (!hit) {
      this.supportNormals.delete(leg);
      return hit;
    }
    let normal = this.supportNormals.get(leg);
    if (!normal) {
      normal = hit.normal.clone();
      this.supportNormals.set(leg, normal);
    }
    normal.lerp(hit.normal, -Math.expm1(-20 * this.smoothingDelta)).normalize();
    hit.normal.copy(normal);
    leg.supportNormal.copy(normal);
    return hit;
  }

  /** 限制脚底高度，并立即恢复超出腿部范围的旧目标。 */
  moveFootHeightAlongUp(leg, footWorld, wantedOffset, previousWeight, delta, speed) {
    const previousOffset = leg.smoothedTarget.dot(this.up) - footWorld.dot(this.up);
    if (previousOffset > this.maxFootRaise || previousOffset < -this.maxFootDrop) {
      // 位移已超出腿部补偿范围，立即从当前动画脚位重新取样，无需等待下一次迈步。
      previousWeight = 0;
      leg.offsetY = 0;
      leg.smoothedTarget.copy(footWorld);
    }
    super.moveFootHeightAlongUp(leg, footWorld, wantedOffset, previousWeight, delta, speed);
    const offset = THREE.MathUtils.clamp(leg.offsetY, -this.maxFootDrop, this.maxFootRaise);
    leg.offsetY = offset;
    leg.smoothedTarget.copy(footWorld).addScaledVector(this.up, offset);
  }
}
