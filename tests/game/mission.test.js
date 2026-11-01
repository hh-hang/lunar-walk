import test from 'node:test';
import assert from 'node:assert/strict';
import { createFragmentPlan, createMissionPlan, findNearbyLanderSite, ReturnMission, RETURN_DURATION } from '../../src/game/mission-state.js';

/** 固定随机源，使走廊落点可复现。 */
function fixedRandom(values) {
  let index = 0;
  return () => values[index++ % values.length];
}

/** 在平地创建可复现路线，使任务门槛测试独立于地貌调整。 */
function fixture() {
  const plan = createMissionPlan(() => 0, [], fixedRandom([0.2, 0.7, 0.4, 0.1, 0.85, 0.55, 0.3, 0.9]));
  return { plan, mission: new ReturnMission(plan) };
}

/** 按指定顺序走到碎片旁并手动采样，不直接改进度字段。 */
function collect(mission, indices = [0, 1, 2]) {
  for (const index of indices) {
    const fragment = mission.fragments[index];
    assert.ok(mission.sample({ x: fragment.x, y: fragment.y + 1, z: fragment.z }));
  }
}

test('快速测试临时解锁登舱，关闭后保留真实收集进度并恢复正常门槛', () => {
  const { mission } = fixture();
  collect(mission, [1]);
  assert.equal(mission.canReturn(mission.lander), false);
  mission.debugBoarding = true;
  assert.equal(mission.canReturn(mission.lander), true);
  assert.equal(mission.canReturn(mission.lander, true), false);
  assert.equal(mission.canReturn({ ...mission.lander, x: mission.lander.x + 30 }), false);
  mission.debugBoarding = false;
  assert.equal(mission.mapTarget, null);
  assert.equal(mission.canReturn(mission.lander), false);
  assert.equal(mission.collectedCount, 1);
  collect(mission, [0, 2]);
  assert.equal(mission.canReturn(mission.lander), true);
});

test('调试停放点始终在人物附近，避开障碍并使用绝对坐标采样坡面', () => {
  const player = { x: 3200, y: 5, z: -3100 }, forward = { x: 0, z: -1 };
  const front = findNearbyLanderSite(() => 5, player, forward);
  assert.equal(front.x, player.x);
  assert.equal(front.z, player.z - 6.5);
  const site = findNearbyLanderSite((x) => 5 + (x - player.x) * 0.03, player, forward,
    [{ ...front, scale: 2 }]);
  assert.ok(Math.abs(Math.hypot(site.x - player.x, site.z - player.z) - 6.5) < 1e-9);
  assert.ok(Math.hypot(site.x - front.x, site.z - front.z) >= 4.5);
  assert.ok(Math.abs(site.slopeX - 0.03) < 1e-9);
  assert.equal(site.slopeZ, 0);
});

test('三份碎片落在出生点到登月舱走廊附近，登月舱远离出生点并避开大石头', () => {
  const { plan } = fixture();
  assert.equal(plan.fragments.length, 3);
  assert.equal(new Set(plan.fragments.map((fragment) => fragment.id)).size, 3);
  const landerDist = Math.hypot(plan.lander.x, plan.lander.z);
  assert.ok(landerDist > 120 && landerDist < 160);
  const ux = plan.lander.x / landerDist, uz = plan.lander.z / landerDist;
  for (const fragment of plan.fragments) {
    const along = fragment.x * ux + fragment.z * uz;
    const lateral = Math.abs(fragment.x * -uz + fragment.z * ux);
    assert.ok(along > landerDist * 0.12 && along < landerDist * 0.72);
    assert.ok(lateral < 40);
  }
  for (let i = 0; i < 3; i++)
    for (let j = i + 1; j < 3; j++)
      assert.ok(Math.hypot(plan.fragments[i].x - plan.fragments[j].x, plan.fragments[i].z - plan.fragments[j].z) > 24);
  const blocked = createMissionPlan(() => 0, [{ x: plan.lander.x, z: plan.lander.z, scale: 3 }], () => 0.5);
  assert.ok(Math.hypot(blocked.lander.x - plan.lander.x, blocked.lander.z - plan.lander.z) > 8);
});

test('碎片坐标每次刷新都不同，同一随机源可复现', () => {
  const lander = createMissionPlan(() => 0, [], () => 0.5).lander;
  const a = createFragmentPlan(() => 0, lander, [], fixedRandom([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]));
  const b = createFragmentPlan(() => 0, lander, [], fixedRandom([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]));
  const c = createFragmentPlan(() => 0, lander, [], fixedRandom([0.9, 0.1, 0.8, 0.2, 0.7, 0.3, 0.6, 0.4, 0.5]));
  assert.deepEqual(a.map(({ id, x, z }) => ({ id, x, z })), b.map(({ id, x, z }) => ({ id, x, z })));
  assert.notDeepEqual(a.map(({ x, z }) => ({ x, z })), c.map(({ x, z }) => ({ x, z })));
});

test('收集一到两份碎片不公开登月舱，任意顺序集齐三份后解锁坐标', () => {
  const { mission } = fixture();
  assert.equal(mission.mapTarget, null);
  collect(mission, [2]);
  assert.equal(mission.collectedCount, 1);
  assert.equal(mission.mapTarget, null);
  collect(mission, [0]);
  assert.equal(mission.collectedCount, 2);
  assert.equal(mission.mapTarget, null);
  collect(mission, [1]);
  assert.equal(mission.collectedCount, 3);
  assert.deepEqual(mission.mapTarget, mission.lander);
  assert.equal(mission.phase, 'exploring');
});

test('靠近不自动采样；高空、远处、车上或重复采样均无效', () => {
  const { mission } = fixture(), fragment = mission.fragments[0];
  mission.update({ x: fragment.x, y: fragment.y + 1, z: fragment.z }, 1);
  assert.equal(mission.collectedCount, 0);
  assert.equal(mission.canSample({ x: fragment.x, y: fragment.y + 20, z: fragment.z }), false);
  assert.equal(mission.canSample({ x: fragment.x + 4, y: fragment.y, z: fragment.z }), false);
  assert.equal(mission.canSample(fragment, true), false);
  assert.ok(mission.sample(fragment));
  assert.equal(mission.collectedCount, 1);
  assert.equal(mission.sample(fragment), null);
  assert.equal(mission.canSample(fragment), false);
});

test('提前找到登月舱也不能返航，集齐后仍需下车并靠近舱体', () => {
  const { mission } = fixture(), lander = mission.lander;
  assert.equal(mission.startReturn(lander), false);
  collect(mission);
  assert.equal(mission.startReturn({ ...lander, x: lander.x + 20 }), false);
  assert.equal(mission.startReturn({ ...lander, y: lander.y + 20 }), false);
  assert.equal(mission.startReturn(lander, true), false);
  assert.equal(mission.startReturn({ ...lander, x: lander.x + 6, y: lander.y + 1 }), false);
  assert.equal(mission.startReturn({ ...lander, x: lander.x + 3, y: lander.y + 1 }), true);
});

test('返航过场只触发一次，完成后不能再次采样或重置返航计时', () => {
  const { mission } = fixture();
  collect(mission);
  assert.equal(mission.startReturn(mission.lander), true);
  assert.equal(mission.mapTarget, null);
  mission.update(mission.lander, RETURN_DURATION / 2);
  assert.equal(mission.phase, 'returning');
  assert.equal(mission.startReturn(mission.lander), false);
  mission.update(mission.lander, RETURN_DURATION);
  assert.equal(mission.phase, 'complete');
  assert.equal(mission.returnElapsed, RETURN_DURATION);
  assert.equal(mission.sample(mission.fragments[0]), null);
  assert.equal(mission.collectedCount, 3);
});

test('再探索重置清空收集与过场；无新坐标时保留原路线，有新坐标时换点', () => {
  const { mission, plan } = fixture();
  collect(mission);
  mission.debugBoarding = true;
  assert.equal(mission.startReturn(mission.lander), true);
  mission.update(mission.lander, RETURN_DURATION);
  assert.equal(mission.phase, 'complete');
  mission.reset();
  assert.equal(mission.phase, 'exploring');
  assert.equal(mission.collectedCount, 0);
  assert.equal(mission.elapsed, 0);
  assert.equal(mission.returnElapsed, 0);
  assert.equal(mission.debugBoarding, false);
  assert.equal(mission.mapTarget, null);
  assert.deepEqual(mission.fragments.map(({ id, x, z }) => ({ id, x, z })), plan.fragments.map(({ id, x, z }) => ({ id, x, z })));
  const next = createFragmentPlan(() => 0, plan.lander, [], fixedRandom([0.05, 0.95, 0.15, 0.85, 0.25, 0.75, 0.35, 0.65]));
  mission.reset(next);
  assert.deepEqual(mission.fragments.map(({ id, x, z }) => ({ id, x, z })), next.map(({ id, x, z }) => ({ id, x, z })));
  assert.equal(mission.collectedCount, 0);
});
