import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { loadAstronautModel } from '../helpers/astronaut-player.js';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';
import { playerController } from 'three-player-controller';
import { attachAstronautFootIK } from '../../src/character/foot-ik.js';
import { LunarFootContacts } from '../../src/character/foot-contacts.js';
import { FootprintStore } from '../../src/rendering/footprint-store.js';

test('足部 IK 正确绑定实际骨架，跟随斜坡与岩石并在离地后释放动画', async () => {
  const gltf = await loadAstronautModel(),
    scene = new THREE.Scene(),
    player = new playerController();
  player.scene = scene;
  player.playerModelConfig = { scale: 0.005, walkAnim: 'walk', runAnim: 'run' };
  player.playerModel = gltf.scene;
  player.rideHeight = 30;
  const size = new THREE.Box3().setFromObject(gltf.scene).getSize(new THREE.Vector3());
  gltf.scene.scale.multiplyScalar((180 * 0.005) / size.y);
  player.playerCapsule = new THREE.Mesh();
  player.playerCapsule.capsuleInfo = {
    radius: 0.15,
    segment: new THREE.Line3(new THREE.Vector3(), new THREE.Vector3(0, -0.5, 0)),
  };
  player.recomputeGroundThresholds();
  player.playerCapsule.position.y = player.getCapsuleGroundHeight();
  gltf.scene.position.y = -player.getCapsuleGroundHeight();
  player.playerCapsule.add(gltf.scene);
  scene.add(player.playerCapsule);
  player.animation.clips = gltf.animations;
  player.animation.mixer = new THREE.AnimationMixer(gltf.scene);

  /** 停止旧动画并直接播放指定测试片段。 */
  const play = (name) => {
    player.animation.mixer.stopAllAction();
    player.animation.state = player.animation.mixer
      .clipAction(gltf.animations.find((clip) => clip.name === name))
      .reset()
      .play();
  };
  play('idle');
  player.playerIsOnGround = true;
  player.setGroundSupport(new THREE.Vector3(), new THREE.Vector3(0, 1, 0));
  const handles = [];

  /** 创建带 BVH 的测试碰撞体并登记到控制器。 */
  const register = (geometry, position = new THREE.Vector3(), surface = 'regolith') => {
    geometry.boundsTree = new MeshBVH(geometry);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    mesh.userData.surface = surface;
    mesh.position.copy(position);
    mesh.updateMatrixWorld(true);
    mesh.raycast = acceleratedRaycast;
    handles.push(player.addCollider({ motion: 'static', shape: { kind: 'mesh', mesh } }));
    return mesh;
  };
  const groundGeometry = new THREE.PlaneGeometry(4, 4).rotateX(-Math.PI / 2);
  const positions = groundGeometry.getAttribute('position');
  for (let i = 0; i < positions.count; i++) positions.setY(i, positions.getX(i) * 0.18);
  groundGeometry.computeVertexNormals();
  register(groundGeometry);
  const footIK = attachAstronautFootIK(player);
  const contacts = [];
  const detector = new LunarFootContacts(footIK, (contact) => contacts.push(contact));
  player.use(detector);
  const left = footIK.legs.left.foot,
    right = footIK.legs.right.foot;
  const ccRig = !!gltf.scene.getObjectByName('CC_Base_Hip_02');
  assert.match(footIK.hips.name, ccRig ? /^CC_Base_Hip_\d+$/ : /^pelvis$/);
  for (const [side, letter] of [
    ['left', 'L'],
    ['right', 'R'],
  ]) {
    const leg = footIK.legs[side];
    assert.match(
      leg.foot.name,
      ccRig ? new RegExp(`^CC_Base_${letter}_Foot_\\d+$`) : new RegExp(`^foot_${letter.toLowerCase()}$`),
    );
    assert.match(
      leg.toe.name,
      ccRig ? new RegExp(`^CC_Base_${letter}_ToeBase_\\d+$`) : new RegExp(`^ball_${letter.toLowerCase()}$`),
    );
    const profile = footIK.soleCalibration.profiles[side];
    assert.ok(profile.length > 0.08 && profile.length < 0.2, `${side} 鞋底尺寸应匹配九十厘米模型`);
    assert.ok(profile.skinThickness >= 0 && profile.skinThickness < 0.05, '挂载到胶囊体后不能破坏蒙皮采样');
  }

  /** 推进指定数量的动画帧并更新场景矩阵。 */
  const run = (frames) => {
    for (let i = 0; i < frames; i++) player.runAnimationPass(1 / 60);
    scene.updateMatrixWorld(true);
  };
  run(90);
  assert.equal(player.getPlugins()[0], footIK);
  assert.ok(
    footIK.getFootIKWeight('left') > 0.9 && footIK.getFootIKWeight('right') > 0.9,
    JSON.stringify({
      weights: ['left', 'right'].map((side) => footIK.getFootIKWeight(side)),
      calibration: footIK.soleCalibration,
      options: footIK.getOptions(),
      legs: ['left', 'right'].map((side) => ({
        side,
        offset: footIK.legs[side].offsetY,
        planted: footIK.legs[side].planted,
        phase: footIK.getFootPhaseDebugText(side),
        foot: footIK.legs[side].foot.getWorldPosition(new THREE.Vector3()).toArray(),
        sole: detector.source.read(side).corners.map((point) => point.toArray()),
      })),
    }),
  );
  const leftSlope = left.getWorldPosition(new THREE.Vector3()),
    rightSlope = right.getWorldPosition(new THREE.Vector3());
  assert.ok(leftSlope.y - rightSlope.y > 0.015, '上坡侧脚位应高于下坡侧');
  assert.equal(contacts.length, 2, '即使站立九十帧，每次支撑也只盖印一次');
  for (const side of ['left', 'right']) {
    const leg = footIK.legs[side],
      corners = detector.source.read(side).corners;
    const width = corners[1].distanceTo(corners[0]),
      length = corners[2].distanceTo(corners[0]);
    assert.ok(
      width > 0.04 && width < 0.12 && length > 0.08 && length < 0.2,
      `${side} 鞋底采样框应保持鞋子尺寸，不能延伸到另一只脚`,
    );
    const direction = corners[2].clone().sub(corners[0]).setY(0).normalize();
    const toeDirection = leg.toe
      .getWorldPosition(new THREE.Vector3())
      .sub(leg.foot.getWorldPosition(new THREE.Vector3()))
      .setY(0)
      .normalize();
    assert.ok(direction.dot(toeDirection) > 0.99, `${side} 鞋底采样框应朝向本侧脚趾`);
    const stamp = new FootprintStore().add(contacts.find((c) => c.side === side));
    const contact = contacts.find((c) => c.side === side);
    const expectedWidth = Math.hypot(
      contact.corners[1].x - contact.corners[0].x,
      contact.corners[1].z - contact.corners[0].z,
    );
    const expectedLength = Math.hypot(
      contact.corners[2].x - contact.corners[0].x,
      contact.corners[2].z - contact.corners[0].z,
    );
    assert.ok(Math.abs(Math.hypot(stamp.ax, stamp.az) * 2 - expectedWidth) < 1e-8);
    assert.ok(Math.abs(Math.hypot(stamp.bx, stamp.bz) * 2 - expectedLength) < 1e-8, '脚印应保留实际鞋底尺寸');
    assert.ok(new THREE.Vector3(stamp.bx, 0, stamp.bz).normalize().dot(toeDirection) > 0.99);
  }

  // 十八厘米岩石处于当前最大抬脚范围内。
  register(new THREE.BoxGeometry(0.13, 0.18, 0.3), new THREE.Vector3(leftSlope.x, 0.09, leftSlope.z), 'rock');
  run(90);
  const raised = left.getWorldPosition(new THREE.Vector3());
  assert.ok(raised.y > leftSlope.y + 0.08, '脚底应检测到地形上方已注册的岩石碰撞体');
  assert.equal(contacts.length, 2, '持续支撑不能重复盖印');
  player.playerIsOnGround = false;
  run(2);
  player.playerIsOnGround = true;
  run(30);
  assert.ok(
    detector.stats.rocks > 0,
    JSON.stringify({
      message: '重新落在岩石上不能压印下方月壤',
      stats: detector.stats,
      corners: detector.source.read('left').corners.map((point) => point.toArray()),
      raised: left.getWorldPosition(new THREE.Vector3()).toArray(),
    }),
  );

  play('walk');
  run(40);
  assert.ok(footIK.getFootPhaseDebugText('left').includes('walk'));
  assert.ok(Number.isFinite(footIK.getFootTimeToLand('right')));
  for (const side of ['left', 'right']) assert.notEqual(footIK.getPredictiveFootDebugText(side), 'disabled');

  play('jumpLoop');
  player.playerIsOnGround = false;
  run(3);
  const afterJump = contacts.length;
  assert.equal(footIK.getFootIKWeight('left'), 0);
  assert.equal(footIK.getFootIKWeight('right'), 0);
  run(30);
  assert.equal(contacts.length, afterJump, '空中动画不能生成脚印');
  const airbornePose = left.quaternion.clone();
  footIK.setEnabled(false);
  player.runAnimationPass(0);
  assert.ok(left.quaternion.angleTo(airbornePose) < 1e-6, '离地时应恢复不受 IK 修正的动画');

  // 复现主场景切换浮动原点时的 IK 重置。
  player.playerCapsule.position.x -= 3072;
  player.playerCapsule.position.z += 3072;
  footIK.setEnabled(false);
  footIK.setEnabled(true);
  assert.ok(footIK.getOptions().predictivePlacement);
  player.unuse(detector);
  player.unuse(footIK);
  footIK.dispose();
  for (const handle of handles) player.removeCollider(handle);
});
