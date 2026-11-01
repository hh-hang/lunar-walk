import * as THREE from 'three';
import { LunarFootIK } from './foot-ik-recovery.js';

/** 按模型骨骼命名规则精确解析骨盆、腿骨和脚趾。 */
export function resolveAstronautLegs(model) {
  const bones = [];
  model.traverse((object) => {
    if (object.isBone) bones.push(object);
  });
  /** 查找必需骨骼，缺失时给出明确错误。 */
  const required = (pattern, label) => {
    const bone = bones.find((bone) => pattern.test(bone.name));
    if (!bone) throw new Error(`宇航员缺少 ${label} 骨骼`);
    return bone;
  };
  if (bones.some((bone) => /^CC_Base_Hip_\d+$/.test(bone.name))) {
    /** 按左右侧映射当前模型的腿部骨骼。 */
    const leg = (side) =>
      Object.fromEntries(
        Object.entries({ upper: 'Thigh', lower: 'Calf', foot: 'Foot', toe: 'ToeBase' }).map(([key, name]) => [
          key,
          required(new RegExp(`^CC_Base_${side}_${name}_\\d+$`), `${side}.${key}`),
        ]),
      );
    return { hips: required(/^CC_Base_Hip_\d+$/, 'hips'), legs: { left: leg('L'), right: leg('R') } };
  }
  /** 按左右侧映射当前模型的腿部骨骼。 */
  const leg = (side) =>
    Object.fromEntries(
      Object.entries({ upper: 'thigh', lower: 'calf', foot: 'foot', toe: 'ball' }).map(([key, name]) => [
        key,
        required(new RegExp(`^${name}_${side}$`), `${side}.${key}`),
      ]),
    );
  return { hips: required(/^pelvis$/, 'hips'), legs: { left: leg('l'), right: leg('r') } };
}

/** 从实际蒙皮网格测量鞋底边界和厚度，校准 IK 接触尺寸。 */
export function measureAstronautSoles(player, skeleton) {
  const model = player.playerModel,
    scale = player.playerModelConfig.scale;
  // 模型可能刚被挂到胶囊体下，先更新父级矩阵，再刷新蒙皮网格的逆绑定矩阵。
  model.updateWorldMatrix(true, false);
  model.updateMatrixWorld(true);
  const meshes = [];
  model.traverse((object) => {
    if (object.isSkinnedMesh) meshes.push(object);
  });
  const height = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3()).y;
  const profiles = {};
  for (const [side, leg] of Object.entries(skeleton.legs)) {
    const descendants = new Set();
    leg.foot.traverse((object) => {
      if (object.isBone) descendants.add(object);
    });
    const foot = leg.foot.getWorldPosition(new THREE.Vector3()),
      toe = leg.toe.getWorldPosition(new THREE.Vector3());
    const forward = toe.clone().sub(foot).setY(0).normalize();
    if (forward.lengthSq() < 0.9) throw new Error(`${side} 脚趾方向无效`);
    const lateral = new THREE.Vector3().crossVectors(forward, THREE.Object3D.DEFAULT_UP).normalize();
    const points = [];
    for (const mesh of meshes) {
      const weights = mesh.geometry.getAttribute('skinWeight'),
        joints = mesh.geometry.getAttribute('skinIndex');
      for (let i = 0; i < weights.count; i++) {
        let influence = 0;
        for (let k = 0; k < 4; k++)
          if (descendants.has(mesh.skeleton.bones[joints.getComponent(i, k)])) influence += weights.getComponent(i, k);
        if (influence < 0.5) continue;
        points.push(mesh.getVertexPosition(i, new THREE.Vector3()).applyMatrix4(mesh.matrixWorld));
      }
    }
    if (points.length < 20) throw new Error(`${side} 鞋底蒙皮采样不足`);
    const bottom = Math.min(...points.map((point) => point.y));
    const sole = points.filter((point) => point.y <= bottom + height * 0.018);
    let heel = Infinity,
      tip = -Infinity,
      halfWidth = 0;
    for (const point of sole) {
      const offset = point.clone().sub(foot),
        along = offset.dot(forward);
      heel = Math.min(heel, along);
      tip = Math.max(tip, along);
      halfWidth = Math.max(halfWidth, Math.abs(offset.dot(lateral)));
    }
    const toeDistance = toe.clone().sub(foot).dot(forward);
    profiles[side] = {
      halfWidth,
      heelExtend: Math.max(0, -heel),
      toeExtend: Math.max(0, tip - toeDistance),
      skinThickness: Math.max(0, toe.y - bottom),
      length: tip - heel,
      bottom,
      foot: leg.foot.name,
      toe: leg.toe.name,
      samples: sole.length,
    };
  }
  /** 计算双脚尺寸均值，并换算到控制器缩放前的单位。 */
  const mean = (key) => (profiles.left[key] + profiles.right[key]) / (2 * scale);
  return {
    profiles,
    options: {
      soleHalfWidth: mean('halfWidth'),
      soleHeelExtend: mean('heelExtend'),
      soleToeExtend: mean('toeExtend'),
      soleSkinThickness: mean('skinThickness'),
    },
  };
}

/** 校准鞋底，创建并注册月面足部 IK 插件。 */
export function attachAstronautFootIK(player) {
  const skeleton = resolveAstronautLegs(player.playerModel);
  const calibration = measureAstronautSoles(player, skeleton);
  const footIK = new LunarFootIK({
    skeleton,
    ...calibration.options,
    maxFootRaise: 50,
    smoothingEnabled: true,
    plantedHeightSpeed: 200,
    penetrationLiftSpeed: 200,
    predictivePlacement: true,
    straightPoleEnabled: true,
    soleSkinThickness: 3,
  });
  footIK.soleCalibration = calibration;
  player.use(footIK);
  return footIK;
}
