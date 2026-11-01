import * as THREE from 'three';
import { excludeTerrainSkirtsFromShadows } from '../terrain/mesh.js';
import { LUNAR_PALETTE } from '../rendering/surface.js';

export const MAP_RANGE = 72;
export const MAX_MAP_RANGE = 96;
const EXTENT = 288;
const RESOLUTION = 512;
const CENTER_STEP = 16;

/** 复用实际地形和岩石，从正上方缓存灰度底图；独立阴影不会改动主场景。 */
export class MinimapTerrain {
  /** 创建小型离屏目标；仅自有材质、实例缓冲与阴影需要单独释放。 */
  constructor(renderer, terrain, { sunlight, environment = null, canvas = document.createElement('canvas') }) {
    this.renderer = renderer;
    this.terrain = terrain;
    this.sunlight = sunlight;
    this.extent = EXTENT;
    this.x = this.z = Infinity;
    this.elapsed = 1;
    this.dirty = true;
    this.canvas = canvas;
    canvas.width = canvas.height = RESOLUTION;
    this.context = canvas.getContext('2d');
    this.image = this.context.createImageData(RESOLUTION, RESOLUTION);
    this.pixels = new Uint8Array(RESOLUTION * RESOLUTION * 4);
    this.target = new THREE.WebGLRenderTarget(RESOLUTION, RESOLUTION, { samples: 2 });
    this.target.texture.colorSpace = THREE.SRGBColorSpace;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x161819);
    this.scene.environment = environment;
    this.scene.environmentIntensity = 0.6;
    this.ground = new THREE.Group();
    this.scene.add(this.ground);
    this.scene.add(new THREE.HemisphereLight(LUNAR_PALETTE.skyFill, LUNAR_PALETTE.groundFill, 0.65));
    this.light = new THREE.DirectionalLight(sunlight.color, sunlight.intensity);
    this.light.castShadow = true;
    this.light.shadow.mapSize.set(2048, 2048);
    this.light.shadow.normalBias = 0.01;
    this.light.shadow.bias = -0.000005;
    const shadow = this.light.shadow.camera;
    shadow.left = shadow.bottom = -EXTENT * 0.8;
    shadow.right = shadow.top = EXTENT * 0.8;
    shadow.near = 1;
    shadow.far = 900;
    shadow.updateProjectionMatrix();
    this.scene.add(this.light, this.light.target);
    this.camera = new THREE.OrthographicCamera(-EXTENT / 2, EXTENT / 2, EXTENT / 2, -EXTENT / 2, 1, 700);
    this.camera.up.set(0, 0, -1);
    this.rocks = terrain.rocks.map((source, variant) => {
      const geometry = terrain.rockField?.levels?.[1]?.[variant]?.geometry ?? source.geometry;
      // 不复用主视角的距离裁剪钩子，保证地图范围内的石头始终存在。
      const mesh = new THREE.InstancedMesh(geometry, source.material.clone(), source.instanceMatrix.count);
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.count = 0;
      this.scene.add(mesh);
      return mesh;
    });
    this.matrix = new THREE.Matrix4();
    this.color = new THREE.Color();
    this.sunDirection = new THREE.Vector3();
  }

  /** 绑定已显示的地表三角形，并从实际实例矩阵复制岩石位置、大小和旋转。 */
  syncGeometry(x, z, originX, originZ) {
    this.ground.clear();
    const reach = EXTENT / 2 + 48;
    for (const source of this.terrain.tiles.values()) {
      const patch = source.userData;
      if (
        patch.x > x + reach || patch.x + patch.size < x - reach ||
        patch.z > z + reach || patch.z + patch.size < z - reach
      ) continue;
      source.updateWorldMatrix(true, false);
      const mesh = new THREE.Mesh(source.geometry, this.terrain.material);
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(source.matrixWorld);
      mesh.castShadow = mesh.receiveShadow = true;
      const count = patch.streamData?.surfaceIndexCount ?? patch.segments ** 2 * 6;
      excludeTerrainSkirtsFromShadows(mesh, count);
      this.ground.add(mesh);
    }
    this.terrain.rocks.forEach((source, variant) => {
      const mesh = this.rocks[variant];
      source.updateWorldMatrix(true, false);
      let count = 0;
      for (let i = 0; i < source.count; i++) {
        source.getMatrixAt(i, this.matrix);
        this.matrix.premultiply(source.matrixWorld);
        const wx = this.matrix.elements[12] + originX;
        const wz = this.matrix.elements[14] + originZ;
        if (Math.abs(wx - x) > reach || Math.abs(wz - z) > reach || this.matrix.getMaxScaleOnAxis() < 0.18)
          continue;
        mesh.setMatrixAt(count, this.matrix);
        if (source.instanceColor) mesh.setColorAt(count, this.color.fromArray(source.instanceColor.array, i * 3));
        count++;
      }
      mesh.count = count;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    });
  }

  /** 缓存移动余量；地形提交后限频刷新，镜头转动直接旋转缓存图片。 */
  update(worldX, worldZ, originX = 0, originZ = 0, delta = 1 / 60, changed = false) {
    this.elapsed += delta;
    this.dirty ||= changed;
    const moved = Math.abs(worldX - this.x) > CENTER_STEP || Math.abs(worldZ - this.z) > CENTER_STEP;
    if (!moved && (!this.dirty || this.elapsed < 0.75)) return false;
    const x = Math.round(worldX / CENTER_STEP) * CENTER_STEP;
    const z = Math.round(worldZ / CENTER_STEP) * CENTER_STEP;
    this.capture(x, z, originX, originZ);
    this.x = x;
    this.z = z;
    this.elapsed = 0;
    this.dirty = false;
    return true;
  }

  /** 用同方向太阳生成真实遮挡，完成后恢复主渲染器的目标、视口和阴影状态。 */
  capture(x, z, originX, originZ) {
    this.syncGeometry(x, z, originX, originZ);
    const focus = new THREE.Vector3(x - originX, this.terrain.surfaceHeightAt(x, z), z - originZ);
    this.camera.position.copy(focus).add(new THREE.Vector3(0, 300, 0));
    this.camera.lookAt(focus);
    this.sunDirection.copy(this.sunlight.position).normalize();
    this.light.position.copy(focus).addScaledVector(this.sunDirection, 400);
    this.light.target.position.copy(focus);
    this.light.color.copy(this.sunlight.color);
    this.light.intensity = this.sunlight.intensity;
    const renderer = this.renderer;
    const drawRanges = this.ground.children.map(({ geometry }) => [
      geometry, geometry.drawRange.start, geometry.drawRange.count,
    ]);
    const previous = {
      target: renderer.getRenderTarget(),
      face: renderer.getActiveCubeFace(),
      mip: renderer.getActiveMipmapLevel(),
      viewport: renderer.getViewport(new THREE.Vector4()),
      scissor: renderer.getScissor(new THREE.Vector4()),
      scissorTest: renderer.getScissorTest(),
      xr: renderer.xr.enabled,
      autoClear: renderer.autoClear,
      shadowAuto: renderer.shadowMap.autoUpdate,
    };
    try {
      renderer.xr.enabled = false;
      renderer.autoClear = true;
      renderer.shadowMap.autoUpdate = true;
      renderer.setRenderTarget(this.target);
      renderer.setViewport(0, 0, RESOLUTION, RESOLUTION);
      renderer.setScissorTest(false);
      renderer.render(this.scene, this.camera);
      renderer.readRenderTargetPixels(this.target, 0, 0, RESOLUTION, RESOLUTION, this.pixels);
    } finally {
      // 即使阴影通道中途失败，也不能把主场景共用的几何留在临时裁剪范围。
      for (const [geometry, start, count] of drawRanges) geometry.setDrawRange(start, count);
      renderer.setRenderTarget(previous.target, previous.face, previous.mip);
      renderer.setViewport(previous.viewport);
      renderer.setScissor(previous.scissor);
      renderer.setScissorTest(previous.scissorTest);
      renderer.xr.enabled = previous.xr;
      renderer.autoClear = previous.autoClear;
      renderer.shadowMap.autoUpdate = previous.shadowAuto;
    }
    // WebGL 从底行读回，Canvas 从顶行写入；反转行序后保持 +X 向右、北（-Z）向上。
    for (let row = 0; row < RESOLUTION; row++) {
      const sourceRow = (RESOLUTION - 1 - row) * RESOLUTION * 4;
      const targetRow = row * RESOLUTION * 4;
      for (let col = 0; col < RESOLUTION; col++) {
        const source = sourceRow + col * 4;
        const target = targetRow + col * 4;
        const gray = Math.round(
          (this.pixels[source] * 0.2126 + this.pixels[source + 1] * 0.7152 + this.pixels[source + 2] * 0.0722) * 0.75,
        );
        this.image.data[target] = this.image.data[target + 1] = this.image.data[target + 2] = gray;
        this.image.data[target + 3] = 255;
      }
    }
    this.context.putImageData(this.image, 0, 0);
  }

  /** 只释放离屏渲染自有资源，保留主场景共用的地形与岩石几何。 */
  dispose() {
    this.target.dispose();
    this.light.shadow.dispose();
    for (const mesh of this.rocks) {
      mesh.material.dispose();
      mesh.dispose();
    }
    this.scene.clear();
  }
}
