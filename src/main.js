import * as THREE from 'three';
import { createRenderer } from './rendering/renderer.js';
import { createEnvironmentLighting, createStars } from './environment/setup.js';
import { createAstronautPlayer } from './character/player.js';
import { configurePlayerCamera, setInitialCameraView } from './character/camera.js';
import { createControlHints } from './ui/control-hints.js';
import { createMinimap } from './ui/minimap.js';
import { setLoading, reportDownload, nextFrame, finishLoading, showLoadingError } from './ui/loading.js';
import { bindViewport } from './ui/viewport.js';
import { createGLTFLoader } from './loaders/gltf-loader.js';
import { publicAssetUrl } from './loaders/asset-url.js';
import { LunarTerrain, TILE_SIZE, heightAt } from './terrain/terrain.js';
import { makeLunarMaterials, prepareAstronaut } from './rendering/surface.js';
import { createTerrainPreparation } from './terrain/preparation.js';
import { attachAstronautFootIK } from './character/foot-ik.js';
import { LunarFootprints } from './rendering/footprints.js';
import { LunarFootContacts } from './character/foot-contacts.js';
import { LunarVisorReflections } from './rendering/visor-reflections.js';
import { LunarSky } from './environment/sky.js';
import { LunarBloom } from './rendering/bloom.js';
import { loadLunarRover, explorationPosition, rebaseRovers, resetRovers, rescueSunkenRovers } from './vehicle/rover.js';
import { LunarRoverEffects } from './vehicle/rover-effects.js';
import { createReturnMission } from './game/return-mission.js';

/** 按依赖顺序创建渲染场景、地形、角色与车辆，并启动帧循环。 */
async function start() {
  const renderer = createRenderer();
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x010102);
  const camera = new THREE.PerspectiveCamera(59, innerWidth / innerHeight, 0.04, 14500);
  const sunlight = createEnvironmentLighting(renderer, scene);

  const surfaceOrigin = { value: new THREE.Vector2() };
  const gravelFocus = { value: new THREE.Vector2() };
  const materials = makeLunarMaterials(surfaceOrigin, gravelFocus);
  for (const texture of [materials.ground.map, materials.ground.normalMap]) {
    texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  }
  const terrain = new LunarTerrain(
    scene,
    materials.ground,
    [materials.rock, materials.rockMid, materials.rockFar],
    [materials.gravel, materials.gravelMid, materials.gravelFar],
    gravelFocus,
  );
  setLoading(0.16);
  await nextFrame();
  await terrain.initializeStreaming({ prepareGeometry: createTerrainPreparation(renderer, camera) });
  setLoading(0.46);

  const stars = createStars(scene);
  const sky = new LunarSky(scene, sunlight, stars);
  sky.update(camera);

  setLoading(0.52);
  await nextFrame();
  const gltf = await createGLTFLoader().loadAsync(publicAssetUrl('models/astronaut.glb'), reportDownload(0.52, 0.76));
  setLoading(0.76);
  const { player, controls } = await createAstronautPlayer(scene, camera, renderer.domElement, gltf);
  const hints = createControlHints(player);
  configurePlayerCamera(player, renderer.domElement, hints.dismiss);
  prepareAstronaut(gltf.scene);
  // 面罩捕获排除视觉太阳光晕，太阳高光由真实光照提供，避免重复反射。
  const visorReflections = new LunarVisorReflections(renderer, scene, gltf.scene, { exclude: [sky.sunVisual] });
  const bloom = new LunarBloom(renderer, scene, camera, { sun: sky.sunDisk, halo: sky.sunHalo, model: gltf.scene });
  player.reset(new THREE.Vector3(0, heightAt(0, 0) + player.getCapsuleGroundHeight(), 0));

  setLoading(0.76);
  await nextFrame();
  const rover = await loadLunarRover(player, createGLTFLoader(), reportDownload(0.76, 0.9));
  bloom.addRover(rover.vehicleGroup);
  setLoading(0.9);
  const localPosition = new THREE.Vector3();
  /** 复用临时向量读取角色或驾驶员的世界位置。 */
  const getPosition = () => explorationPosition(player, localPosition);

  let originX = 0,
    originZ = 0;
  let colliderX = NaN,
    colliderZ = NaN;
  const colliderHandles = new Map();
  /** 注销碰撞句柄并通知地形释放相应网格。 */
  const removeCollider = (key) => {
    const handle = colliderHandles.get(key);
    if (!handle) return;
    player.removeCollider(handle);
    colliderHandles.delete(key);
    terrain.releaseCollider(key, handle.collisionMesh);
  };
  terrain.onRemove = removeCollider;
  /** 同步角色与车辆附近的碰撞体，保留仍在使用的网格。 */
  function syncColliders(x, z) {
    const needed = terrain.nearbyColliders(x, z);
    for (const vehicle of player.getAllVehicles()) {
      const position = vehicle.vehicleGroup.position;
      for (const [key, mesh] of terrain.nearbyColliders(position.x + originX, position.z + originZ))
        needed.set(key, mesh);
    }
    for (const [key, mesh] of needed) {
      mesh.userData.surface = key.startsWith('rock:') ? 'rock' : 'regolith';
      if (colliderHandles.get(key)?.collisionMesh === mesh) continue;
      removeCollider(key);
      colliderHandles.set(
        key,
        player.addCollider({
          motion: 'static',
          shape: { kind: 'mesh', mesh },
        }),
      );
    }
    for (const key of colliderHandles.keys()) if (!needed.has(key)) removeCollider(key);
    colliderX = x;
    colliderZ = z;
  }
  syncColliders(0, 0);
  const footIK = attachAstronautFootIK(player);
  const footprints = new LunarFootprints(renderer, scene, materials.ground);
  const roverEffects = new LunarRoverEffects(player, footprints, scene, {
    origin: surfaceOrigin,
    camera,
    sunDirection: sky.sunDirection,
  });
  const mission = await createReturnMission({
    scene, player, controls, terrain, getPosition, sunlight, footprints,
    loader: createGLTFLoader(), onProgress: reportDownload(0.9, 0.94),
    onRestart: () => {
      footprints.clear();
      roverEffects.clearTracks?.();
      roverEffects.dust?.clear?.();
      resetRovers(player, { originX, originZ });
    },
  });
  bloom.addLander(mission.lander);
  bloom.setPlume(mission.launch.effects.plume);
  bloom.setDustMedia(mission.launch.effects.dust);
  mission.launch.effects.dust.setSun({
    direction: sky.sunDirection,
    color: sunlight.color,
    ambient: new THREE.Color(0.1, 0.11, 0.13),
  });
  setLoading(0.94);
  const minimap = createMinimap(player, {
    camera,
    renderer,
    terrain,
    scene,
    sunlight,
    getObjective: mission.getMapTarget,
    getFragments: mission.getFragmentMarkers,
    getLocalXZ: () => {
      const position = getPosition();
      return { x: position.x, z: position.z };
    },
  });
  await footprints.prepare();
  await roverEffects.dust.prepare(renderer, camera, visorReflections.target);
  await mission.launch.effects.prepare(renderer, camera, scene);
  const footContacts = new LunarFootContacts(footIK, (contact) => footprints.add(contact), { origin: surfaceOrigin });
  player.use(footContacts);
  await nextFrame();
  await player.update(1 / 60);

  setInitialCameraView(camera, controls);

  let debugPanel = null,
    debugRouteVersion = 0;
  /** 按地址片段异步创建或销毁调试面板，过滤过期导入结果。 */
  async function syncDebugRoute() {
    const version = ++debugRouteVersion;
    if (location.hash !== '#debug') {
      debugPanel?.dispose();
      debugPanel = null;
      return;
    }
    if (debugPanel) return;
    const { createDebugPanel } = await import('./ui/debug-panel.js');
    if (version !== debugRouteVersion || location.hash !== '#debug') return;
    debugPanel = createDebugPanel(player, terrain, footIK, footprints, footContacts, bloom, roverEffects, {
      sunlight,
      renderer,
      mission,
      scene,
      getOrigin: () => ({ x: originX, z: originZ }),
      getWorldPosition: () => {
        const position = getPosition();
        return { x: position.x + originX, y: position.y, z: position.z + originZ };
      },
    });
  }
  window.addEventListener('hashchange', () => syncDebugRoute().catch(console.error));
  await syncDebugRoute();

  /** 远离局部原点时同步平移地形、车辆、相机与印记采样坐标。 */
  function rebase() {
    const position = getPosition();
    if (Math.max(Math.abs(position.x), Math.abs(position.z)) < 3000) return;
    const shiftX = Math.round(position.x / TILE_SIZE) * TILE_SIZE;
    const shiftZ = Math.round(position.z / TILE_SIZE) * TILE_SIZE;
    originX += shiftX;
    originZ += shiftZ;
    for (const key of [...colliderHandles.keys()]) removeCollider(key);
    terrain.rebase(shiftX, shiftZ, originX, originZ);
    surfaceOrigin.value.set(originX, originZ);
    const next = new THREE.Vector3(position.x - shiftX, position.y, position.z - shiftZ);
    rebaseRovers(player, shiftX, shiftZ);
    roverEffects.rebase(shiftX, shiftZ);
    mission.rebase(shiftX, shiftZ);
    // 换原点时保留驾驶状态及车辆速度，不能重置已上车的胶囊体。
    if (player.getControllerMode() !== 1) player.reset(next);
    // 原点平移后清除旧世界坐标下的落脚预测。
    const ikEnabled = footIK.getOptions().enabled;
    footIK.setEnabled(false);
    footIK.setEnabled(ikEnabled);
    camera.position.x -= shiftX;
    camera.position.z -= shiftZ;
    controls.target.x -= shiftX;
    controls.target.z -= shiftZ;
    syncColliders(next.x + originX, next.z + originZ);
    visorReflections.invalidate(true);
  }

  let frame = 0;
  const timer = new THREE.Timer();
  timer.connect(document);
  /** 按帧更新控制器、流式地形、足迹和反射，并渲染场景。 */
  function animate() {
    requestAnimationFrame(animate);
    timer.update();
    const realDelta = timer.getDelta();
    const dt = Math.min(realDelta, 0.04);
    player.update(dt);
    rescueSunkenRovers(player, { originX, originZ });
    if (!player.manageCamera) controls.update();
    hints.update();
    const current = getPosition();
    const worldX = current.x + originX,
      worldZ = current.z + originZ;
    const terrainChanged = terrain.update(worldX, worldZ, originX, originZ);
    if (terrainChanged || Math.hypot(worldX - colliderX, worldZ - colliderZ) >= 1) syncColliders(worldX, worldZ);
    rebase();
    roverEffects.update(player.getCurrentDelta());
    footprints.update(worldX, worldZ, originX, originZ);
    mission.update(originX, originZ, realDelta, terrainChanged);
    sky.update(camera);
    bloom.render(dt);
    if (terrainChanged) visorReflections.invalidate();
    if (!mission.launch.active) visorReflections.update(dt);
    if (!mission.launch.active) minimap.update(originX, originZ, dt, terrainChanged);
    debugPanel?.sampleFrame();
    if (frame++ % 12 === 0) debugPanel?.update();
  }
  bindViewport(renderer, camera, bloom);
  setLoading(0.96);
  await renderer.compileAsync(scene, camera);
  // 在加载遮罩内完成首张地图及其阴影编译，避免进入场景后首帧停顿。
  minimap.update(originX, originZ, 0, true);
  setLoading(1);
  finishLoading();
  timer.reset();
  animate();
}

start().catch(showLoadingError);
