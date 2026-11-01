import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { createGLTFLoader } from '../../src/loaders/gltf-loader.js';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';
import { playerController } from 'three-player-controller';
import { attachAstronautFootIK } from '../../src/character/foot-ik.js';

/** 加载真实宇航员模型，仅替换需要浏览器解码的纹理材质。 */
export async function loadAstronautModel(model = 'astronaut.glb') {
  const bytes = await readFile(new URL(`../../public/models/${model}`, import.meta.url));
  const loader = createGLTFLoader();
  loader.register(() => ({
    name: 'UntexturedTestMaterials',
    loadMaterial: () => Promise.resolve(new THREE.MeshBasicMaterial()),
  }));
  return loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
}

/** 创建供角色与车辆回归测试共用的真实骨架、动画及碰撞环境。 */
export async function createAstronautPlayer({ footIK = true, model = 'astronaut.glb', beforeIK = [] } = {}) {
  const gltf = await loadAstronautModel(model);
  const player = new playerController(),
    scene = new THREE.Scene();
  player.scene = scene;
  player.playerModelConfig = {
    model: gltf.scene,
    animations: gltf.animations,
    scale: 0.005,
    idleAnim: 'idle',
    walkAnim: 'walk',
    runAnim: 'run',
    jumpAnim: ['jumpStart', 'jumpLoop', 'jumpEnd'],
  };
  player.playerModel = gltf.scene;
  player.rideHeight = 30;
  const height = new THREE.Box3().setFromObject(gltf.scene).getSize(new THREE.Vector3()).y;
  gltf.scene.scale.multiplyScalar(0.9 / height);
  player.playerCapsule = new THREE.Mesh();
  player.playerCapsule.capsuleInfo = {
    radius: 0.15,
    segment: new THREE.Line3(new THREE.Vector3(), new THREE.Vector3(0, -0.5, 0)),
  };
  player.recomputeGroundThresholds();
  const groundHeight = player.getCapsuleGroundHeight();
  player.playerCapsule.position.y = groundHeight;
  gltf.scene.position.y = -groundHeight;
  player.playerCapsule.add(gltf.scene);
  scene.add(player.playerCapsule);
  scene.updateMatrixWorld(true);
  player.camera = new THREE.PerspectiveCamera();
  player.controls = {
    target: new THREE.Vector3(),
    /** 提供测试所需的轨道控制器更新接口。 */
    update() {},
  };
  player.animation.clips = gltf.animations;
  player.animation.mixer = new THREE.AnimationMixer(gltf.scene);
  player.animation.actions = new Map();
  player.animation.hasThreePartJump = true;
  for (const [key, name] of Object.entries({
    idle: 'idle',
    walking: 'walk',
    running: 'run',
    jumpStart: 'jumpStart',
    jumpLoop: 'jumpLoop',
    jumpEnd: 'jumpEnd',
  })) {
    const action = player.animation.mixer.clipAction(gltf.animations.find((c) => c.name === name));
    const once = key === 'jumpStart' || key === 'jumpEnd';
    action.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, once ? 1 : Infinity);
    action.clampWhenFinished = once;
    action.setEffectiveTimeScale(key === 'jumpStart' ? 1.2 : 1);
    action.enabled = true;
    action.setEffectiveWeight(0);
    player.animation.actions.set(key, action);
  }
  player.animation.mixer.addEventListener('finished', ({ action }) => {
    if (player.animation.state !== action) return;
    if (action === player.animation.actions.get('jumpStart')) player.animation.playByName('jumpLoop');
    if (action === player.animation.actions.get('jumpEnd')) player.animation.playByName('idle');
  });
  player.animation.playByName('idle', 0);
  player.animation.mixer.update(0);
  scene.updateMatrixWorld(true);
  const handles = [];

  /** 创建带 BVH 的测试碰撞体并登记到控制器。 */
  const register = (geometry, surface = 'regolith') => {
    geometry.boundsTree = new MeshBVH(geometry);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    mesh.userData.surface = surface;
    mesh.updateMatrixWorld(true);
    mesh.raycast = acceleratedRaycast;
    scene.add(mesh);
    handles.push(player.addCollider({ motion: 'static', shape: { kind: 'mesh', mesh } }));
    return mesh;
  };
  for (const plugin of beforeIK) player.use(plugin);
  const ik = footIK ? attachAstronautFootIK(player) : null;

  /** 按指定模拟步长推进动画与插件，并更新矩阵。 */
  const step = (frames = 1, delta = 1 / 60) => {
    for (let i = 0; i < frames; i++) player.runAnimationPass(delta);
    scene.updateMatrixWorld(true);
  };

  /** 设置测试角色位置、接地状态及支撑法线。 */
  const place = (x, y, z, grounded, normal = new THREE.Vector3(0, 1, 0)) => {
    player.playerCapsule.position.set(x, y + groundHeight, z);
    scene.updateMatrixWorld(true);
    player.setOnGround(grounded);
    if (grounded) player.setGroundSupport(new THREE.Vector3(x, y, z), normal);
  };

  /** 释放测试插件、碰撞句柄或临时渲染资源。 */
  const dispose = () => {
    if (ik) {
      player.unuse(ik);
      ik.dispose();
    }
    for (const plugin of beforeIK) player.unuse(plugin);
    for (const handle of handles) player.removeCollider(handle);
    player.animation.mixer.stopAllAction();
  };
  return { gltf, player, scene, ik, register, step, place, dispose };
}

/** 生成前半段抬高的斜坡测试几何。 */
export function rampGeometry(slope = 2.5) {
  const geometry = new THREE.PlaneGeometry(8, 8, 1, 2).rotateX(-Math.PI / 2);
  const p = geometry.getAttribute('position');
  for (let i = 0; i < p.count; i++) p.setY(i, Math.max(0, -p.getZ(i) * slope));
  geometry.computeVertexNormals();
  return geometry;
}
