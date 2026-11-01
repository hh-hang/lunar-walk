import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { MinimapTerrain } from '../../src/ui/minimap-terrain.js';

/** 创建实际三角形与实例姿态，并用可观测渲染器检查离屏状态。 */
function fixture() {
  const material = new THREE.MeshStandardMaterial();
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(10, 10).rotateX(-Math.PI / 2), material);
  ground.userData = { x: -5, z: -5, size: 10, segments: 1, streamData: { surfaceIndexCount: 6 } };
  const rock = new THREE.InstancedMesh(new THREE.BoxGeometry(), material, 3);
  const pose = new THREE.Matrix4().compose(
    new THREE.Vector3(4, 1, -3),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.7),
    new THREE.Vector3(2, 1, 1.5),
  );
  rock.setMatrixAt(0, pose);
  rock.setMatrixAt(1, new THREE.Matrix4().makeTranslation(1000, 0, 0));
  rock.setMatrixAt(2, new THREE.Matrix4().makeScale(0.1, 0.1, 0.1));
  rock.setColorAt(0, new THREE.Color(0.5, 0.6, 0.7));
  const sunlight = new THREE.DirectionalLight(0xffffff, 3.6);
  sunlight.position.set(0.8, 0.22, 0.4);
  const terrain = { material, tiles: new Map([['ground', ground]]), rocks: [rock], surfaceHeightAt: () => 0 };
  let draws = 0;
  const context = {
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: () => draws++,
  };
  const canvas = { getContext: () => context };
  const originalTarget = { name: '原渲染目标' };
  const renderer = {
    target: originalTarget, face: 3, mip: 2, xr: { enabled: true }, autoClear: false,
    shadowMap: { autoUpdate: false }, viewport: new THREE.Vector4(2, 3, 400, 300),
    scissor: new THREE.Vector4(6, 7, 200, 100), scissorTest: true, calls: 0,
    /** 读取当前渲染目标。 */
    getRenderTarget() { return this.target; },
    /** 读取当前立方体面。 */
    getActiveCubeFace() { return this.face; },
    /** 读取当前纹理层级。 */
    getActiveMipmapLevel() { return this.mip; },
    /** 复制视口供状态恢复。 */
    getViewport(out) { return out.copy(this.viewport); },
    /** 复制裁剪范围供状态恢复。 */
    getScissor(out) { return out.copy(this.scissor); },
    /** 读取裁剪开关。 */
    getScissorTest() { return this.scissorTest; },
    /** 切换并记录渲染目标。 */
    setRenderTarget(target, face = 0, mip = 0) { this.target = target; this.face = face; this.mip = mip; },
    /** 支持向量及数值形式的视口参数。 */
    setViewport(...args) { if (args[0]?.isVector4) this.viewport.copy(args[0]); else this.viewport.set(...args); },
    /** 恢复裁剪范围。 */
    setScissor(value) { this.scissor.copy(value); },
    /** 设置裁剪开关。 */
    setScissorTest(value) { this.scissorTest = value; },
    /** 检查离屏状态，必要时模拟阴影通道失败。 */
    render(_scene, camera) {
      camera.updateMatrixWorld(true);
      this.calls++;
      assert.equal(this.xr.enabled, false);
      assert.equal(this.shadowMap.autoUpdate, true);
      if (this.fail) { ground.geometry.setDrawRange(3, 3); throw new Error('模拟阴影失败'); }
    },
    /** 填入固定灰色，验证读回图像的灰度转换。 */
    readRenderTargetPixels(_target, _x, _y, _width, _height, data) { data.fill(128); },
  };
  const capture = new MinimapTerrain(renderer, terrain, { sunlight, canvas });
  return { capture, renderer, terrain, ground, rock, sunlight, pose, originalTarget, draws: () => draws };
}

/** 验证离屏捕获没有遗留主视口或阴影状态。 */
function verifyRenderer(f) {
  assert.equal(f.renderer.target, f.originalTarget);
  assert.equal(f.renderer.face, 3);
  assert.equal(f.renderer.mip, 2);
  assert.equal(f.renderer.xr.enabled, true);
  assert.equal(f.renderer.autoClear, false);
  assert.equal(f.renderer.shadowMap.autoUpdate, false);
  assert.equal(f.renderer.scissorTest, true);
  assert.deepEqual(f.renderer.viewport.toArray(), [2, 3, 400, 300]);
  assert.deepEqual(f.renderer.scissor.toArray(), [6, 7, 200, 100]);
}

test('俯视底图复用实际三角形、岩石矩阵与太阳方向，保持坐标轴一致', (t) => {
  const f = fixture();
  t.after(() => f.capture.dispose());
  f.capture.update(0, 0);
  assert.equal(f.capture.ground.children[0].geometry, f.ground.geometry);
  assert.equal(f.capture.rocks[0].count, 1, '跳过范围外岩石及小于像素的碎粒');
  const actual = new THREE.Matrix4(), expected = new THREE.Matrix4();
  f.capture.rocks[0].getMatrixAt(0, actual);
  f.rock.getMatrixAt(0, expected);
  assert.deepEqual(actual.elements, expected.elements);
  const direction = f.capture.light.position.clone().sub(f.capture.light.target.position).normalize();
  assert.ok(direction.distanceTo(f.sunlight.position.clone().normalize()) < 1e-8);
  assert.ok(new THREE.Vector3(5, 0, 0).project(f.capture.camera).x > 0);
  assert.ok(new THREE.Vector3(0, 0, -5).project(f.capture.camera).y > 0, '离屏相机应保持北（-Z）在上方');
  assert.equal(f.capture.image.data[0], 96);
  assert.equal(f.capture.image.data[3], 255);
  verifyRenderer(f);
});

test('WebGL 像素读回时反转行序，避免底图与标记投影发生镜像', (t) => {
  const f = fixture();
  t.after(() => f.capture.dispose());
  f.renderer.readRenderTargetPixels = (_target, _x, _y, width, height, data) => {
    data.fill(0);
    data.fill(200, 0, width * 4);
    data.fill(20, (height - 1) * width * 4);
  };
  f.capture.update(0, 0);
  const image = f.capture.image;
  assert.equal(image.data[0], 15, '画布顶行必须来自 WebGL 顶行');
  assert.equal(image.data[(512 - 1) * 512 * 4], 150, '画布底行必须来自 WebGL 底行');
});

test('镜头旋转及小幅移动复用快照，地形更新限频刷新并支持浮动原点', (t) => {
  const f = fixture();
  t.after(() => f.capture.dispose());
  assert.equal(f.capture.update(0, 0), true);
  assert.equal(f.capture.update(1, -1), false);
  assert.equal(f.capture.update(1, -1, 0, 0, 0.1, true), false);
  f.ground.position.set(-3072, 0, 3072);
  f.rock.position.set(-3072, 0, 3072);
  assert.equal(f.capture.update(1, -1, 3072, -3072, 0.8), true);
  assert.ok(f.capture.x === 0 && f.capture.z === 0, '原点两侧的采样应对齐到同一世界位置');
  assert.equal(f.capture.camera.position.x, -3072);
  assert.equal(f.capture.ground.children[0].matrix.elements[12], -3072);
  assert.equal(f.capture.rocks[0].count, 1);
  assert.equal(f.draws(), 2);
  assert.equal(f.capture.update(17, 0, 3072, -3072), true);
  assert.equal(f.capture.x, 16);
  verifyRenderer(f);
});

test('阴影捕获失败后恢复共用几何和渲染状态，下一次仍可重试', (t) => {
  const f = fixture();
  t.after(() => f.capture.dispose());
  f.renderer.fail = true;
  assert.throws(() => f.capture.update(0, 0), /模拟阴影失败/);
  verifyRenderer(f);
  assert.deepEqual(f.ground.geometry.drawRange, { start: 0, count: Infinity });
  assert.equal(f.draws(), 0);
  f.renderer.fail = false;
  assert.equal(f.capture.update(0, 0), true);
  assert.equal(f.draws(), 1);
});

test('释放底图只销毁自有资源，不释放主场景共用的几何和材质', () => {
  const f = fixture();
  let sharedDisposals = 0, ownDisposals = 0;
  for (const resource of [f.ground.geometry, f.rock.geometry, f.terrain.material])
    resource.addEventListener('dispose', () => sharedDisposals++);
  f.capture.rocks[0].material.addEventListener('dispose', () => ownDisposals++);
  f.capture.dispose();
  assert.equal(sharedDisposals, 0);
  assert.equal(ownDisposals, 1);
});
