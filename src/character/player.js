import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { playerController } from 'three-player-controller';
import { heightAt } from '../terrain/height.js';
import { CAMERA_ZOOM_LIMITS } from './camera.js';

/** 创建宇航员控制器，集中保留移动、动画、相机和移动端按钮参数。 */
export async function createAstronautPlayer(scene, camera, canvas, gltf) {
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.enablePan = false;
  const player = new playerController();
  // 初始化前设置离地高度，控制器内部再乘以模型缩放。
  player.rideHeight = 30;
  await player.init({
    scene,
    camera,
    controls,
    initPos: new THREE.Vector3(0, heightAt(0, 0), 0),
    playerModelConfig: {
      model: gltf.scene,
      animations: gltf.animations,
      scale: 0.005,
      idleAnim: 'idle',
      walkAnim: 'walk',
      runAnim: 'run',
      drivingAnim: 'driving',
      jumpAnim: ['jumpStart', 'jumpLoop', 'jumpEnd'],
      speed: 200,
      runSpeed: 600,
      gravity: -1600,
      rotateY: Math.PI / 2,
    },
    minCamDistance: CAMERA_ZOOM_LIMITS.min,
    maxCamDistance: 300,
    camLookAtHeightRatio: 0.5,
    enableOverShoulderView: true,
    camOverShoulderOffsetRatio: 0.1,
    enableZoom: true,
    isFirstPerson: false,
    enableSpringCamera: true,
    springCameraTime: 0.1,
    isShowMobileControls: true,
    // 移动端按钮从下到上依次排列跳跃、视角与上下车。
    mobileControls: {
      joystick: true,
      fly: false,
      jump: { right: 14, bottom: 14 },
      view: { right: 14, bottom: 86 },
      vehicle: { right: 14, bottom: 158 },
    },
    keyMap: { toggleFly: null, toggleVehicle: ['KeyF'] },
    timeScale: 0.6,
  });

  return { player, controls };
}
