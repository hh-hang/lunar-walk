import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createAstronautPlayer, rampGeometry } from '../helpers/astronaut-player.js';
import { FootIKContactSource } from '../../src/character/foot-contacts.js';

/** 创建在 IK 之前记录基础骨骼姿态的测试插件。 */
function animatedPoseProbe() {
  return {
    name: 'animated-leg-test-probe',
    feet: {},

    /** 保存被测试的角色控制器。 */
    onAttach(player) {
      this.player = player;
    },

    /** 记录 IK 修正前的骨骼姿态，供接触与旋转比较。 */
    onAfterAnimationUpdate() {
      const model = this.player.playerModel;
      model.updateWorldMatrix(true, false);
      model.updateMatrixWorld(true);
      const ik = this.player.getPlugins().find((plugin) => plugin.name === 'foot-ik');
      this.hips = ik.hips.getWorldPosition(new THREE.Vector3());
      for (const side of ['left', 'right']) this.feet[side] = ik.legs[side].foot.getWorldPosition(new THREE.Vector3());
    },
  };
}

test('陡坡下滑后脚底目标不会残留在身体上方，并可在站立时恢复', async (t) => {
  const probe = animatedPoseProbe(),
    f = await createAstronautPlayer({ beforeIK: [probe] });
  t.after(f.dispose);
  f.register(rampGeometry());
  const changes = [];
  f.player.onAnimationChange = (name) => changes.push(name);
  const source = new FootIKContactSource(f.ik);

  /** 检查脚位、旧目标与旋转修正是否处于允许范围。 */
  const verify = () => {
    const options = f.ik.getOptions(),
      scale = f.player.playerModelConfig.scale;
    for (const side of ['left', 'right']) {
      const leg = f.ik.legs[side],
        actual = leg.foot.getWorldPosition(new THREE.Vector3());
      assert.ok(actual.y < probe.hips.y - 0.06, `${side} 站立下滑时脚踝应保持在身体下方`);
      assert.ok(
        actual.y <= probe.feet[side].y + options.maxFootRaise * scale + 0.02,
        `${side} 平滑后的实际脚位不能超过最大抬脚高度`,
      );
      assert.ok(
        leg.offsetY <= options.maxFootRaise * scale + 1e-6 && leg.offsetY >= -options.maxFootDrop * scale - 1e-6,
        `${side} 残留的世界坐标目标不能超出 IK 范围`,
      );
    }
  };

  /** 推进一帧模拟并校验落脚状态。 */
  const frame = () => {
    f.step();
    verify();
  };
  f.place(0, 0, 1, true);
  f.step(90);
  f.place(0, 1.5, -0.6, true, new THREE.Vector3(0, 1, 2.5).normalize());
  f.step(90);
  // 保持接地并站立，确保恢复不依赖跳跃、落地或行走事件。
  for (let i = 0; i <= 30; i++) {
    const z = -0.6 + i * 0.02;
    f.place(0, Math.max(0, -z * 2.5), z, true, new THREE.Vector3(0, 1, 2.5).normalize());
    frame();
  }
  f.place(0, 0, 0.3, true);
  for (let i = 0; i < 30; i++) frame();
  assert.equal(f.player.animation.getCurrentName(), 'idle');
  assert.deepEqual(changes, [], '恢复过程不能强制行走或切换动画');
  for (const side of ['left', 'right']) {
    assert.ok(f.ik.getFootIKWeight(side) > 0.9, `${side} 站立时应能重新获取支撑`);
    const sole = source.read(side).corners;
    assert.ok(
      sole.every((point) => Math.abs(point.y) < 0.025),
      `${side} 鞋底应重新稳定在地面上`,
    );
  }
});

test('普通支撑保持配置的追踪速度，起落后无需行走也能清理 IK 状态', async (t) => {
  const probe = animatedPoseProbe(),
    f = await createAstronautPlayer({ beforeIK: [probe] });
  t.after(f.dispose);
  const ground = f.register(new THREE.PlaneGeometry(8, 8).rotateX(-Math.PI / 2));
  f.place(0, 0, 0, true);
  f.step(90);
  const before = f.ik.legs.left.foot.getWorldPosition(new THREE.Vector3()).y;
  ground.position.y = 0.12;
  ground.updateMatrixWorld(true);
  f.player.setGroundSupport(new THREE.Vector3(0, 0.12, 0), new THREE.Vector3(0, 1, 0));
  f.step();
  const first = f.ik.legs.left.foot.getWorldPosition(new THREE.Vector3()).y;
  assert.ok(first > before && first < before + 0.05, '有效的小幅高度变化应保留平滑处理');
  f.step(60);
  const raised = f.ik.legs.left.foot.getWorldPosition(new THREE.Vector3()).y;
  assert.ok(raised > before + 0.09, '普通抬高支撑仍应可达');
  const names = [];
  f.player.onAnimationChange = (name) => names.push(name);
  f.place(0, 1.5, 0, false);
  f.step(30);
  for (const side of ['left', 'right']) assert.equal(f.ik.getFootIKWeight(side), 0);
  f.place(0, 0.12, 0, true);
  f.step(90);
  assert.equal(f.player.animation.getCurrentName(), 'idle');
  assert.ok(!names.includes('walking') && !names.includes('running'));
  for (const side of ['left', 'right']) {
    const foot = f.ik.legs[side].foot.getWorldPosition(new THREE.Vector3());
    assert.ok(foot.y < probe.hips.y - 0.1);
    assert.ok(Math.abs(f.ik.legs[side].offsetY) < 0.03);
    assert.ok(f.ik.getFootIKWeight(side) > 0.9);
  }
});

/** 创建用于隔离基础动画与 IK 修正的姿态探针。 */
function poseProbe() {
  return {
    name: 'slow-motion-animation-probe',
    poses: new Map(),

    /** 保存被测试的角色控制器。 */
    onAttach(player) {
      this.player = player;
    },

    /** 记录 IK 修正前的骨骼姿态，供接触与旋转比较。 */
    onAfterAnimationUpdate() {
      const ik = this.player.getPlugins().find((plugin) => plugin.name === 'foot-ik');
      for (const leg of Object.values(ik.legs))
        for (const key of ['upper', 'lower', 'foot']) this.poses.set(leg[key], leg[key].quaternion.clone());
    },
  };
}

/** 生成连续起伏地面，用于复现行走中的 IK 突变。 */
function unevenGround() {
  const geometry = new THREE.PlaneGeometry(12, 12, 120, 120).rotateX(-Math.PI / 2),
    p = geometry.attributes.position;
  for (let i = 0; i < p.count; i++)
    p.setY(i, 0.015 * Math.sin(p.getZ(i) * 12) + 0.01 * Math.sin(p.getX(i) * 19 + p.getZ(i) * 7));
  geometry.computeVertexNormals();
  return geometry;
}

test('慢速行走和奔跑可降低 IK 突变，同时保持基础动画时钟', async (t) => {
  const probe = poseProbe(),
    f = await createAstronautPlayer({ beforeIK: [probe] });
  t.after(f.dispose);
  f.register(unevenGround());
  f.place(0, 0, 0, true);
  f.step(90);

  /** 运行两个完整动画周期，测量最大旋转修正并校验动画时钟。 */
  const measure = (clip, timeScale, smoothingEnabled, fps = 60) => {
    f.ik.setEnabled(false);
    f.player.animation.playByName(clip, 0);
    f.player.animation.state.reset();
    f.step(1, 0);
    f.ik.configure({ smoothingEnabled });
    f.ik.setEnabled(true);
    const delta = Math.min(1 / fps, 1 / 40) * timeScale,
      duration = f.player.animation.state.getClip().duration;
    const previous = new Map(),
      frames = Math.ceil((duration * 2) / delta);
    let peak = 0;
    for (let i = 0; i < frames; i++) {
      f.place(0, 0, i * delta * 0.45, true);
      f.step(1, delta);
      for (const [bone, animated] of probe.poses) {
        assert.ok(bone.quaternion.toArray().every(Number.isFinite));
        // 夹角计算要求单位四元数，避免动画插值的微小长度误差在慢动作下放大。
        const correction = animated.clone().invert().multiply(bone.quaternion).normalize();
        if (i > 20 && previous.has(bone)) peak = Math.max(peak, previous.get(bone).angleTo(correction));
        previous.set(bone, correction);
      }
    }
    const expected = (frames * delta) % duration;
    const timeError = Math.abs(f.player.animation.state.time - expected);
    assert.ok(
      Math.min(timeError, Math.abs(duration - timeError)) < 1e-6,
      `IK 应保持动画时钟：${clip}，预期=${expected}，实际=${f.player.animation.state.time}`,
    );
    return THREE.MathUtils.radToDeg(peak);
  };
  for (const clip of ['walking', 'running'])
    for (const scale of [0.25, 0.6, 1]) {
      const before = measure(clip, scale, false),
        after = measure(clip, scale, true);
      assert.ok(before > 15, `${clip} 应能复现真实的 IK 突变`);
      assert.ok(after < before * 0.4, `${clip} 倍率=${scale}：${before.toFixed(2)} → ${after.toFixed(2)} 度`);
      assert.ok(after < scale * 6, '慢动作下旋转修正应随模拟时间缩小');
    }
  for (const fps of [30, 120]) {
    const peak = measure('walking', 0.6, true, fps);
    assert.ok(peak < 360 * Math.min(1 / fps, 1 / 40) * 0.6, `${fps} 帧率下应按模拟时间平滑，不能使用固定逐帧混合`);
  }
});

test('离地、禁用 IK 和重绑模型会清除修正历史并保留当前动画', async (t) => {
  const probe = poseProbe(),
    f = await createAstronautPlayer({ beforeIK: [probe] });
  t.after(f.dispose);
  f.register(unevenGround());
  f.place(0, 0, 0, true);
  f.step(90);
  f.player.animation.playByName('walking', 0);
  f.step(45, 0.6 / 60);
  assert.ok(f.ik.smoothPoses.size > 0);
  assert.ok([...f.ik.smoothPoses.values()].some((pose) => pose.correction.angleTo(new THREE.Quaternion()) > 0.01));
  f.place(0, 1, 0, false);
  f.step(1, 0.6 / 60);
  assert.equal(f.ik.smoothPoses.size, 0);
  assert.equal(f.ik.supportNormals.size, 0);
  for (const [bone, animated] of probe.poses)
    assert.deepEqual(bone.quaternion.toArray(), animated.toArray(), '离地后不能保留旧的接地旋转修正');
  f.place(0, 0, 0, true);
  f.step(30, 0.6 / 60);
  assert.ok(f.ik.smoothPoses.size > 0);
  f.ik.setEnabled(false);
  assert.equal(f.ik.smoothPoses.size, 0);
  f.step(1, 0.6 / 60);
  for (const [bone, animated] of probe.poses) assert.deepEqual(bone.quaternion.toArray(), animated.toArray());
  f.ik.setEnabled(true);
  f.step(15, 0.6 / 60);
  f.ik.onPlayerModelChange();
  assert.equal(f.ik.smoothPoses.size, 0);
  assert.equal(f.ik.supportNormals.size, 0);
});
