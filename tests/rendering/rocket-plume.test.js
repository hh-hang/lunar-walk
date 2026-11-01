import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { RocketPlume } from '../../src/rendering/rocket-plume.js';

test('喷流从实际喷口沿舱体局部负 Y 喷出，未点火和重测后不绘制', () => {
  const plume = new RocketPlume({ nozzleRadius: 0.3, reach: 7.8, flareDeg: 50 });
  const stage = new THREE.Group();
  stage.position.set(19, 13, -8);
  stage.rotation.set(0.1, 0.4, -0.2);
  stage.add(plume.mesh);
  plume.mesh.position.set(0, 1.2, 0);
  plume.mesh.updateWorldMatrix(true, false);
  const axis = new THREE.Vector3(0, 0, 1).transformDirection(plume.mesh.matrixWorld);
  const expected = new THREE.Vector3(0, -1, 0).applyQuaternion(stage.quaternion);
  assert.ok(axis.distanceTo(expected) < 1e-9);
  // 包围体应为真空圆锥：喷口端窄、下游端宽。
  const pos = plume.mesh.geometry.attributes.position;
  let nearR = 0, farR = 0, nearN = 0, farN = 0;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const r = Math.hypot(x, y);
    if (z < 0.2) { nearR += r; nearN++; }
    if (z > 7.6) { farR += r; farN++; }
  }
  assert.ok(nearN > 0 && farN > 0);
  assert.ok(farR / farN > (nearR / nearN) * 2);
  assert.ok(Math.abs(plume.uniforms.flareSlope.value - Math.tan(50 * Math.PI / 180)) < 1e-6);
  assert.equal(plume.mesh.visible, false);
  assert.equal(plume.mesh.layers.test(new THREE.Layers()), false);
  plume.update({ powered: false, flightTime: 0 });
  assert.equal(plume.uniforms.strength.value, 0);
  plume.update({ powered: true, flightTime: 0.5 });
  assert.equal(plume.mesh.visible, true);
  assert.equal(plume.uniforms.strength.value, 1);
  plume.reset();
  assert.equal(plume.mesh.visible, false);
  assert.equal(plume.uniforms.strength.value, 0);
  assert.equal(plume.uniforms.time.value, 0);
  plume.dispose();
  assert.equal(stage.children.length, 0);
});

test('体积绘制使用独立颜色缓冲读取场景深度，异常后恢复渲染状态且可重试', () => {
  const plume = new RocketPlume();
  plume.mesh.position.set(1, 3, 2);
  const camera = new THREE.PerspectiveCamera(59, 2, 0.04, 1000);
  camera.position.set(8, 5, 6);
  camera.updateMatrixWorld(true);
  const target = new THREE.WebGLRenderTarget(800, 400, { depthTexture: new THREE.DepthTexture(800, 400) });
  const clearColor = new THREE.Color(0x123456);
  let fail = true, renders = 0;
  const renderer = {
    autoClear: false, target, alpha: 0.7,
    getClearColor: (out) => out.copy(clearColor),
    getClearAlpha() { return this.alpha; },
    setRenderTarget(value) { this.target = value; },
    setClearColor(color, alpha) { clearColor.set(color); this.alpha = alpha; },
    render() {
      renders++;
      if (this.target === plume.target) {
        assert.equal(this.target.depthTexture, null);
        assert.equal(plume.uniforms.sceneDepth.value, target.depthTexture);
        if (fail) throw new Error('模拟喷流绘制失败');
      } else assert.equal(this.target, target);
    },
  };
  assert.throws(() => plume.render(renderer, camera, target), /模拟喷流绘制失败/);
  assert.equal(renderer.target, target);
  assert.equal(renderer.autoClear, false);
  assert.equal(clearColor.getHex(), 0x123456);
  assert.equal(renderer.alpha, 0.7);
  assert.equal(plume.uniforms.sceneDepth.value, null);
  fail = false;
  plume.render(renderer, camera, target);
  assert.equal(renders, 3);
  assert.equal(plume.target.width, 400);
  assert.equal(plume.target.height, 200);
  assert.equal(plume.uniforms.sceneDepth.value, null);
  assert.equal(renderer.autoClear, false);
  plume.dispose();
  target.dispose();
});
