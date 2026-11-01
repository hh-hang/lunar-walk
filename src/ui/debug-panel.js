import * as THREE from 'three';
import GUI from 'three/addons/libs/lil-gui.module.min.js';
import Stats from 'three/addons/libs/stats.module.js';
import { invalidateShadowMaterials } from '../environment/sun-light-shadow.js';
import { INTERACTION } from '../game/mission-state.js';

/** 地面水平圆环，用于显示交互半径。 */
function createRangeRing(color) {
  const geometry = new THREE.RingGeometry(0.94, 1.06, 72);
  geometry.rotateX(-Math.PI / 2);
  const material = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = 8;
  return mesh;
}

/** 创建按功能分组的调试面板，关闭时清理调试覆盖层与事件监听。 */
export function createDebugPanel(player, terrain, footIK, footprints, footContacts, bloom, roverEffects, { sunlight, renderer, mission, getWorldPosition, getOrigin, scene }) {
  const manageCamera = player.manageCamera;
  const state = { capsule: false, colliders: false, cameraReleased: !manageCamera };
  const worldPosition = { x: 0, y: 0, z: 0 };
  const gui = new GUI({ title: '月面调试', width: 280 });
  // 高于移动端右侧视角滑动层（998）与圆钮（1000），避免拖 GUI 变成转镜头。
  gui.domElement.style.zIndex = '1100';
  gui.domElement.style.maxHeight = 'calc(100vh - 24px)';
  gui.domElement.style.overflowY = 'auto';
  gui.domElement.setAttribute('aria-label', '月面调试面板');
  // 界面输入不再传给角色控制器；松开事件仍需透传，防止打开面板前按住的键或鼠标卡住。
  for (const event of ['pointerdown', 'mousedown', 'click', 'dblclick', 'wheel', 'keydown']) {
    gui.domElement.addEventListener(event, (e) => e.stopPropagation());
  }
  gui.add(worldPosition, 'x').name('世界 X / m').decimals(2).listen().disable();
  gui.add(worldPosition, 'y').name('世界 Y / m').decimals(2).listen().disable();
  gui.add(worldPosition, 'z').name('世界 Z / m').decimals(2).listen().disable();
  gui
    .add(state, 'cameraReleased')
    .name('暂停相机接管')
    .onChange((value) => {
      // 恢复接管前先关掉平移，避免 captureControls 把调试态的 enablePan 写进快照。
      if (!value) player.controls.enablePan = false;
      player.setManageCamera(!value);
      // 暂停后打开平移，便于自由查看场景。
      if (value) player.controls.enablePan = true;
    });
  if (mission) {
    // 用读写代理绑定真实任务状态，避免「重新开始」后勾选框与 debugBoarding 脱节。
    const landerTest = {
      get value() { return mission.state.debugBoarding; },
      set value(enabled) {
        mission.setDebugBoarding(Boolean(enabled));
        if (gui.domElement.contains(document.activeElement)) document.activeElement.blur();
      },
    };
    gui.add(landerTest, 'value').name('登月舱快速测试').listen();
    const kaptonFoil = {
      get value() { return mission.kaptonFoilEnabled; },
      set value(enabled) {
        mission.setKaptonFoil(Boolean(enabled));
        if (gui.domElement.contains(document.activeElement)) document.activeElement.blur();
      },
    };
    gui.add(kaptonFoil, 'value').name('登月舱金箔材质').listen();
    if (scene) {
      const rangeRoot = new THREE.Group();
      rangeRoot.name = '交互范围调试';
      rangeRoot.visible = false;
      scene.add(rangeRoot);
      const landerRing = createRangeRing(0xefcf91);
      const sampleRings = [0, 1, 2].map(() => createRangeRing(0xe9bd73));
      const vehicleRings = [];
      rangeRoot.add(landerRing, ...sampleRings);
      const rangeState = {
        visible: false,
        sampleDistance: INTERACTION.sampleDistance,
        boardingDistance: INTERACTION.boardingDistance,
      };
      const rangeFolder = gui.addFolder('交互范围');
      rangeFolder
        .add(rangeState, 'visible')
        .name('显示范围')
        .onChange((value) => {
          rangeRoot.visible = value;
        });
      rangeFolder
        .add(rangeState, 'sampleDistance', 1, 8, 0.1)
        .name('采样半径 / m')
        .onChange((value) => {
          INTERACTION.sampleDistance = value;
        });
      rangeFolder
        .add(rangeState, 'boardingDistance', 2, 12, 0.1)
        .name('登舱半径 / m')
        .onChange((value) => {
          INTERACTION.boardingDistance = value;
        });
      /** 按当前任务与车辆位置刷新圆环。 */
      const syncInteractionRanges = () => {
        if (!rangeRoot.visible) return;
        const origin = getOrigin?.() ?? { x: 0, z: 0 };
        const lander = mission.state.lander;
        landerRing.position.set(lander.x - origin.x, lander.y + 0.05, lander.z - origin.z);
        landerRing.scale.setScalar(INTERACTION.boardingDistance);
        landerRing.visible = true;
        for (const [index, ring] of sampleRings.entries()) {
          const fragment = mission.state.fragments[index];
          const show = fragment && !fragment.collected;
          ring.visible = Boolean(show);
          if (!show) continue;
          ring.position.set(fragment.x - origin.x, fragment.y + 0.05, fragment.z - origin.z);
          ring.scale.setScalar(INTERACTION.sampleDistance);
        }
        const vehicles = player.getAllVehicles?.() ?? [];
        while (vehicleRings.length < vehicles.length) {
          const ring = createRangeRing(0xd2dad6);
          vehicleRings.push(ring);
          rangeRoot.add(ring);
        }
        for (const [index, ring] of vehicleRings.entries()) {
          const vehicle = vehicles[index];
          if (!vehicle || (player.getControllerMode() === 1 && player.getActiveVehicle() === vehicle)) {
            ring.visible = false;
            continue;
          }
          const radius = player.vehicle?.boardingRadius?.(vehicle) ?? 2.5;
          const position = vehicle.vehicleGroup.position;
          ring.position.set(position.x, position.y - vehicle.halfExtents.y + 0.05, position.z);
          ring.scale.setScalar(radius);
          ring.visible = true;
        }
      };
      state.syncInteractionRanges = syncInteractionRanges;
      state.rangeRoot = rangeRoot;
    }
    if (mission.launch?.effects) {
      const effects = mission.launch.effects;
      const ascentFolder = gui.addFolder('上升过场');
      const ascentPause = {
        get value() { return mission.launch.paused; },
        set value(enabled) {
          mission.launch.setPaused(Boolean(enabled));
          if (gui.domElement.contains(document.activeElement)) document.activeElement.blur();
        },
      };
      ascentFolder.add(ascentPause, 'value').name('暂停上升动画').listen();

      if (effects.plume) {
        const plume = effects.plume;
        const folder = ascentFolder.addFolder('喷射火焰');
        const settings = plume.settings;
        for (const [key, label, min, max, step] of [
          ['reach', '喷流长度 / m', 1, 24, 0.1],
          ['nozzleRadius', '喷管半径 / m', 0.05, 1.2, 0.01],
          ['flareDeg', '真空张角半角 / °', 15, 75, 1],
          ['intensity', '亮度', 0.3, 2.5, 0.05],
          ['coreLengthScale', '势核长度倍率', 0.5, 6, 0.1],
          ['shockSpacingScale', '激波间距倍率', 1, 6, 0.1],
          ['flowSpeed', '湍流流速', 0, 8, 0.1],
          ['sootAmount', '烟炱密度（超燃宜低）', 0, 1, 0.01],
          ['shockHeat', '激波高温', 0, 600, 10],
          ['glowStrength', '辉光强度', 0, 1, 0.01],
          ['ignitionDuration', '点火渐亮 / s', 0.02, 1, 0.01],
          ['stepCount', '积分步数', 12, 48, 1],
        ]) {
          folder
            .add(settings, key, min, max, step)
            .name(label)
            .onChange((value) => plume.configure({ [key]: value }));
        }
      }

      const dustSettings = effects.settings;
      const capacity = effects.capacity;
      const dustFolder = ascentFolder.addFolder('尘幕');
      dustFolder
        .add(dustSettings, 'dustEnabled')
        .name('启用尘幕')
        .onChange((value) => effects.configure({ dustEnabled: value }));
      dustFolder
        .add(dustSettings, 'dustCount', 0, capacity.dust, 1)
        .name('数量')
        .onChange((value) => effects.configure({ dustCount: value }));
      for (const [key, label, min, max, step] of [
        ['dustOpacity', '不透明度', 0.02, 0.6, 0.01],
        ['dustSizeScale', '粒子大小', 0.15, 4, 0.05],
        ['dustSheetDensity', '近地密度', 0.4, 6, 0.1],
        ['dustSheetLife', '近地寿命 / s', 1, 10, 0.1],
        ['dustGroundPersist', '近地残存', 0, 1, 0.05],
        ['dustErosion', '絮状侵蚀', 0, 1, 0.05],
        ['dustStrengthScale', '强度倍率', 0, 2.5, 0.05],
        ['fadeRadius', '覆盖范围半径 / m', 8, 80, 1],
        ['surfaceFalloff', '近地衰减高度 / m', 2, 16, 0.5],
        ['earlyDuration', '早期扬尘时长 / s', 0.4, 5, 0.1],
        ['visibleUntil', '可见上限 / s', 2, 14, 0.5],
      ]) {
        dustFolder
          .add(dustSettings, key, min, max, step)
          .name(label)
          .onChange((value) => effects.configure({ [key]: value }));
      }

      const debrisFolder = ascentFolder.addFolder('飞石碎屑');
      debrisFolder
        .add(dustSettings, 'ejectaEnabled')
        .name('启用飞石')
        .onChange((value) => effects.configure({ ejectaEnabled: value }));
      debrisFolder
        .add(dustSettings, 'ejectaCount', 0, capacity.ejecta, 1)
        .name('飞石数量')
        .onChange((value) => effects.configure({ ejectaCount: value }));
      debrisFolder
        .add(dustSettings, 'foilEnabled')
        .name('启用箔片')
        .onChange((value) => effects.configure({ foilEnabled: value }));
      debrisFolder
        .add(dustSettings, 'foilCount', 0, capacity.foil, 1)
        .name('箔片数量')
        .onChange((value) => effects.configure({ foilCount: value }));
      for (const [key, label, min, max, step] of [
        ['ejectaOpacity', '飞石不透明度', 0.05, 1, 0.01],
        ['ejectaSizeScale', '飞石大小', 0.3, 3, 0.05],
        ['ejectaLife', '飞石寿命 / s', 1, 8, 0.1],
        ['ejectaStrengthScale', '飞石强度倍率', 0, 2.5, 0.05],
        ['foilSizeScale', '箔片大小', 0.3, 3, 0.05],
        ['foilLife', '箔片寿命 / s', 1, 8, 0.1],
      ]) {
        debrisFolder
          .add(dustSettings, key, min, max, step)
          .name(label)
          .onChange((value) => effects.configure({ [key]: value }));
      }
    }
  }
  gui
    .add(state, 'capsule')
    .name('人物胶囊体')
    .onChange((value) => player.setPlayerCapsuleDebug(value));
  gui
    .add(state, 'colliders')
    .name('地形 / 岩石碰撞体')
    .onChange((value) => player.setColliderDebug(value));
  const shadow = sunlight.shadow;
  const shadowFolder = gui.addFolder('级联阴影');
  shadowFolder.add(sunlight, 'castShadow').name('启用阴影');
  const cascade = {
    get count() { return shadow.cascadeCount ?? shadow.getViewportCount(); },
    set count(value) {
      if (typeof shadow.setCascadeCount !== 'function') return;
      shadow.setCascadeCount(value);
      // 图集变宽后单级分辨率不能超过 GPU 上限。
      const extents = shadow.getFrameExtents();
      const limit = renderer.capabilities.maxTextureSize / Math.max(extents.x, extents.y);
      if (shadow.mapSize.x > limit) {
        const fallback = [4096, 2048, 1024, 512, 256].find((size) => size <= limit) ?? 256;
        shadow.mapSize.set(fallback, fallback);
      }
      invalidateShadowMaterials(sunlight.parent);
    },
  };
  shadowFolder.add(cascade, 'count', { '1': 1, '2': 2, '3': 3, '4': 4 }).name('级联数量');
  shadowFolder.add(shadow.camera, 'near', 0.01, 20, 0.01).name('近裁剪 / m');
  // 起飞镜头可拉到约 2000 m，级联 far 需跟得上观察视深，上限放宽供调试。
  shadowFolder.add(shadow.camera, 'far', 5, 5000, 1).name('最大距离 / m');
  // 各级阴影共用横向图集，单级分辨率必须为整个图集留出空间。
  const extents = shadow.getFrameExtents();
  const limit = renderer.capabilities.maxTextureSize / Math.max(extents.x, extents.y);
  const resolutions = Object.fromEntries(
    [256, 512, 1024, 2048, 4096].filter((size) => size <= limit).map((size) => [String(size), size]),
  );
  shadowFolder
    .add(shadow.mapSize, 'x', resolutions)
    .name('单级分辨率')
    // Three.js 下一帧会自动调整图集大小并释放旧纹理，无需手动重建光源。
    .onChange((value) => shadow.mapSize.set(value, value));
  for (const [key, label, min, max, step] of [
    ['intensity', '阴影强度', 0, 1, 0.01],
    ['bias', '深度偏移', -0.001, 0.001, 0.000001],
    ['normalBias', '法线偏移 / m', 0, 0.1, 0.0005],
    ['radius', '滤波半径', 0, 5, 0.1],
  ]) shadowFolder.add(shadow, key, min, max, step).name(label);
  const vehicleDebug = player.vehicle.params.debug;
  const vehicleDebugFields = [
    ['showPhysicsBox', '车身碰撞盒'],
    ['showWheelRays', '车轮悬挂射线'],
    ['showWheelTravel', '悬挂行程'],
    ['showWheelSpheres', '车轮碰撞球'],
  ];
  const vehicleFolder = gui.addFolder('车辆调试');
  for (const [key, label] of vehicleDebugFields) {
    vehicleFolder
      .add(vehicleDebug, key)
      .name(label)
      .onChange(() => player.vehicle.syncDebugVisibility());
  }
  const stability = player.getAllVehicles()[0]?.stability?.settings;
  if (stability) {
    const folder = vehicleFolder.addFolder('防翻车');
    folder.add(stability, 'enabled').name('启用防翻车');
    folder.add(stability, 'maxTiltDegrees', 0, 60, 1).name('最大倾角 / °');
    folder.add(stability, 'tiltDamping', 0, 15, 0.5).name('倾斜阻尼');
    folder.add(stability, 'maxTiltSpeedDegrees', 15, 180, 5).name('倾斜速度 / °每秒');
  }
  if (roverEffects) {
    const folder = vehicleFolder.addFolder('车辙 / 扬尘'),
      settings = roverEffects.settings;
    folder
      .add(settings, 'tracksEnabled')
      .name('显示 / 生成车辙')
      .onChange((value) => roverEffects.configure({ tracksEnabled: value }));
    folder
      .add(settings, 'dustEnabled')
      .name('显示 / 生成扬尘')
      .onChange((value) => roverEffects.configure({ dustEnabled: value }));
    folder
      .add(settings, 'trackStrength', 0.2, 1.2, 0.05)
      .name('车辙深浅')
      .onChange((value) => roverEffects.configure({ trackStrength: value }));
    folder
      .add(settings, 'dustAmount', 0, 2, 0.1)
      .name('扬尘数量')
      .onChange((value) => roverEffects.configure({ dustAmount: value }));
    folder.add(footprints.stats, 'trackCount').name('保留车辙片段').listen().disable();
    folder.add(roverEffects.dust.stats, 'active').name('活动尘粒 / 上限 768').listen().disable();
    folder.add(roverEffects.stats, 'updateMs').name('车辆效果 CPU / ms').decimals(2).listen().disable();
    folder.add(roverEffects, 'clearTracks').name('清空车辙');
    folder.add(roverEffects.dust, 'clear').name('清空扬尘');
  }
  if (bloom) {
    const folder = gui.addFolder('太阳 / 面罩 Bloom');
    const state = { ...bloom.settings };
    folder
      .add(state, 'enabled')
      .name('启用 Bloom')
      .onChange((value) => bloom.configure({ enabled: value }));
    for (const [key, label, min, max, step] of [
      ['sunStrength', '太阳 Bloom', 0, 1, 0.01],
      ['visorStrength', '面罩高光 Bloom', 0, 0.4, 0.005],
      ['roverStrength', '月球车反光 Bloom', 0, 0.4, 0.005],
      ['threshold', '高光亮度阈值', 0.5, 4, 0.05],
      ['radius', '扩散半径', 0, 1, 0.01],
    ])
      folder
        .add(state, key, min, max, step)
        .name(label)
        .onChange((value) => bloom.configure({ [key]: value }));
    folder
      .add(state, 'resolutionScale', { 半分辨率: 0.5, 四分之一分辨率: 0.25 })
      .name('Bloom 分辨率')
      .onChange((value) => bloom.configure({ resolutionScale: value }));
    folder.add(bloom.stats, 'sourceDraws').name('光源绘制批次').listen().disable();
    folder.add(bloom.stats, 'cpuMs').name('后处理 CPU / ms').decimals(2).listen().disable();
  }
  /** 默认不更新足部面板；创建足部控件后替换为实际的采样逻辑。 */
  let updateFootIK = () => {};
  if (footIK) {
    const options = footIK.getOptions();
    const ikState = {
      enabled: options.enabled,
      debug: false,
      smoothingEnabled: options.smoothingEnabled,
      predictivePlacement: options.predictivePlacement,
      straightPoleEnabled: options.straightPoleEnabled,
      soleHalfWidth: options.soleHalfWidth,
      soleToeExtend: options.soleToeExtend,
      soleHeelExtend: options.soleHeelExtend,
      soleSkinThickness: options.soleSkinThickness,
      leftPhase: '',
      rightPhase: '',
      leftWeight: 0,
      rightWeight: 0,
      pelvisOffset: 0,
    };
    const folder = gui.addFolder('Foot IK');
    folder
      .add(ikState, 'enabled')
      .name('启用脚部 IK')
      .onChange((value) => {
        footIK.setEnabled(value);
        footIK.setDebugEnabled(value && ikState.debug);
      });
    folder
      .add(ikState, 'debug')
      .name('脚底检测标记')
      .onChange((value) => footIK.setDebugEnabled(value && ikState.enabled));
    folder
      .add(ikState, 'smoothingEnabled')
      .name('慢动作 IK 平滑')
      .onChange((value) => footIK.configure({ smoothingEnabled: value }));
    folder
      .add(ikState, 'predictivePlacement')
      .name('预测落脚')
      .onChange((value) => footIK.configure({ predictivePlacement: value }));
    folder
      .add(ikState, 'straightPoleEnabled')
      .name('膝盖朝前')
      .onChange((value) => footIK.configure({ straightPoleEnabled: value }));
    const sole = folder.addFolder('脚底参数');
    for (const [key, label, max] of [
      ['soleHalfWidth', '脚掌半宽', 24],
      ['soleToeExtend', '脚尖延伸', 24],
      ['soleHeelExtend', '脚跟延伸', 24],
      ['soleSkinThickness', '鞋底厚度补偿', 16],
    ]) {
      sole
        .add(ikState, key, 0, max, 0.1)
        .name(label)
        .onChange((value) => footIK.configure({ [key]: value }));
    }
    sole.close();
    const runtime = folder.addFolder('脚部状态');
    runtime.add(ikState, 'leftPhase').name('左脚相位').listen().disable();
    runtime.add(ikState, 'rightPhase').name('右脚相位').listen().disable();
    runtime.add(ikState, 'leftWeight').name('左脚 IK 权重').decimals(2).listen().disable();
    runtime.add(ikState, 'rightWeight').name('右脚 IK 权重').decimals(2).listen().disable();
    runtime.add(ikState, 'pelvisOffset').name('骨盆偏移').decimals(2).listen().disable();
    runtime.close();
    updateFootIK = () => {
      ikState.leftPhase = footIK.getFootPhaseDebugText('left');
      ikState.rightPhase = footIK.getFootPhaseDebugText('right');
      ikState.leftWeight = footIK.getFootIKWeight('left');
      ikState.rightWeight = footIK.getFootIKWeight('right');
      ikState.pelvisOffset = footIK.getPelvisOffset();
    };
    updateFootIK();
  }
  if (terrain?.stream) {
    const stats = terrain.stream.stats;
    const folder = gui.addFolder('地形更新性能');
    folder.add(stats, 'updateMs').name('本帧 CPU / ms').decimals(2).listen().disable();
    folder.add(stats, 'peakMs').name('峰值 / ms').decimals(2).listen().disable();
    folder.add(stats, 'pending').name('后台待办').listen().disable();
    folder.add(stats, 'cached').name('缓存分块').listen().disable();
    folder
      .add(
        {
          reset: () => {
            stats.peakMs = 0;
          },
        },
        'reset',
      )
      .name('重置峰值');
  }
  if (footprints) {
    const folder = gui.addFolder('月面脚印');
    const state = {
      enabled: footprints.enabled,
      markers: false,
      depth: footprints.uniforms.uFootprintDepth.value * 1000,
    };
    folder
      .add(state, 'enabled')
      .name('显示 / 生成脚印')
      .onChange((value) => footprints.setEnabled(value));
    folder
      .add(state, 'markers')
      .name('落地点标记')
      .onChange((value) => footprints.setDebug(value));
    folder
      .add(state, 'depth', 1, 10, 0.5)
      .name('共用凹痕深度 / mm')
      .onChange((value) => {
        footprints.uniforms.uFootprintDepth.value = value / 1000;
      });
    folder.add(footprints.stats, 'count').name('保留脚印').listen().disable();
    folder.add(footprints.stats, 'tiles').name('活动纹理块').listen().disable();
    folder.add(footprints.stats, 'gpuMiB').name('高度图 / MiB').decimals(1).disable();
    folder.add(footprints.stats, 'bakeMs').name('本帧更新 / ms').decimals(2).listen().disable();
    folder.add(footprints.stats, 'peakBakeMs').name('更新峰值 / ms').decimals(2).listen().disable();
    folder.add(footprints.stats, 'draws').name('本帧盖印批次').listen().disable();
    if (footContacts) {
      folder.add(footContacts.stats, 'left').name('左脚接触').listen().disable();
      folder.add(footContacts.stats, 'right').name('右脚接触').listen().disable();
    }
    folder.add({ clear: () => footprints.clear('foot') }, 'clear').name('清空脚印');
  }
  const stats = new Stats();
  stats.dom.style.left = '50%';
  stats.dom.style.right = 'auto';
  stats.dom.style.top = 'max(14px, env(safe-area-inset-top))';
  stats.dom.style.bottom = 'auto';
  stats.dom.style.transform = 'translateX(-50%)';
  for (const event of ['pointerdown', 'mousedown', 'click', 'dblclick', 'wheel', 'keydown']) {
    stats.dom.addEventListener(event, (e) => e.stopPropagation());
  }
  document.body.append(stats.dom);
  return {
    update: updateFootIK,
    /** 记录本帧性能统计，并刷新世界坐标读数。 */
    sampleFrame() {
      stats.update();
      const position = getWorldPosition?.();
      if (position) {
        worldPosition.x = position.x;
        worldPosition.y = position.y;
        worldPosition.z = position.z;
      }
      state.syncInteractionRanges?.();
    },
    /** 销毁调试界面，移除监听并隐藏覆盖层。 */
    dispose() {
      // 临时调试结束后恢复进入面板前的相机管理状态。
      player.controls.enablePan = false;
      player.setManageCamera(manageCamera);
      mission?.setDebugBoarding(false);
      mission?.launch?.setPaused?.(false);
      player.setPlayerCapsuleDebug(false);
      player.setColliderDebug(false);
      for (const [key] of vehicleDebugFields) vehicleDebug[key] = false;
      player.vehicle.syncDebugVisibility();
      footIK?.setDebugEnabled(false);
      footprints?.setDebug(false);
      if (state.rangeRoot) {
        state.rangeRoot.traverse((object) => {
          object.geometry?.dispose?.();
          object.material?.dispose?.();
        });
        state.rangeRoot.removeFromParent();
        state.rangeRoot = null;
      }
      INTERACTION.sampleDistance = 2.6;
      INTERACTION.boardingDistance = 4;
      stats.dom.remove();
      gui.destroy();
    },
  };
}
