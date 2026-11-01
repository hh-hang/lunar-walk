import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { LunarSky } from '../../src/environment/sky.js';
import { createLunarSunlight } from '../../src/environment/lighting.js';
import skySnapshot from '../../src/environment/sky-snapshot.json' with { type: 'json' };

test('固定天空快照在选定月面位置保持太阳与地球均位于地平线上方', () => {
  assert.equal(skySnapshot.utc, '2026-10-18T08:56:18.000Z');
  assert.equal(skySnapshot.site.latitude, 60);
  assert.equal(skySnapshot.site.longitude, 30);
  for (const body of ['sun', 'earth']) {
    const actual = skySnapshot.bodies[body];
    assert.ok(actual.altitude > 0 && actual.altitude < 45, `${body} 应位于地平线上方且仰角小于四十五度`);
  }
});

test('相机移动与换原点后保持地球视直径、太阳方向和光照一致', () => {
  const previous = globalThis.document;
  globalThis.document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        createRadialGradient: () => ({
          /** 占位模拟画布渐变，无需在 Node 中创建真实画布。 */
          addColorStop() {},
        }),
        /** 占位模拟画布填充，保留天空初始化流程。 */
        fillRect() {},
      }),
    }),
  };
  try {
    const scene = new THREE.Scene(),
      sunlight = createLunarSunlight(4096);
    const stars = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ opacity: 0.65 }));
    scene.add(sunlight, stars);
    const sky = new LunarSky(scene, sunlight, stars),
      camera = new THREE.PerspectiveCamera(59, 16 / 9, 0.04, 14500);
    assert.equal(sky.group.userData.utc, skySnapshot.utc);
    const direction = sunlight.position.clone(),
      orientation = sky.earth.quaternion.clone();
    let earthOffset;
    for (const position of [
      [0, 3, 0],
      [3100, 7, -3100],
      [28, 7, -28],
    ]) {
      camera.position.set(...position);
      sky.update(camera);
      const offset = sky.earth.position.clone().sub(camera.position);
      if (earthOffset) assert.ok(offset.distanceTo(earthOffset) < 1e-8);
      else earthOffset = offset;
      assert.ok(sky.sunVisual.position.clone().sub(camera.position).normalize().distanceTo(direction) < 1e-12);
      assert.ok(sky.earth.quaternion.angleTo(orientation) < 1e-7);
      const diameter = THREE.MathUtils.radToDeg(2 * Math.asin(sky.earth.scale.x / offset.length()));
      assert.ok(Math.abs(diameter - skySnapshot.bodies.earth.angularDiameterDegrees) < 1e-12);
      const solarDiameter = THREE.MathUtils.radToDeg(
        2 * Math.atan(sky.sunDisk.scale.x / sky.sunVisual.position.distanceTo(camera.position)),
      );
      assert.ok(Math.abs(solarDiameter - skySnapshot.bodies.sun.angularDiameterDegrees) < 1e-12);
      for (const [body, actual] of [
        ['earth', offset.clone().normalize()],
        ['sun', sunlight.position],
      ]) {
        const expected = skySnapshot.bodies[body];
        const altitude = THREE.MathUtils.radToDeg(Math.asin(actual.y));
        const azimuth = (THREE.MathUtils.radToDeg(Math.atan2(actual.x, -actual.z)) + 360) % 360;
        assert.ok(Math.abs(altitude - expected.altitude) < 1e-9);
        assert.ok(Math.abs(azimuth - expected.azimuth) < 1e-9);
      }
      assert.equal(sunlight.intensity, 3.6);
      assert.equal(sunlight.castShadow, true);
      assert.equal(stars.material.opacity, 0.65);
      assert.equal(sky.clock, undefined);
    }
    const earthSun = sky.earth.material.uniforms.sun.value;
    const litFraction = (1 - earthSun.dot(sky.earthDirection)) / 2;
    assert.ok(Math.abs(litFraction - skySnapshot.bodies.earth.illuminatedFraction) < 0.0001);
    // 改变观察方向可以看到地球，但不能改变天体本身的真实方向。
    camera.lookAt(sky.earth.position);
    camera.updateMatrixWorld();
    const screenPosition = sky.earth.position.clone().project(camera);
    assert.ok(Math.abs(screenPosition.x) < 1e-10 && Math.abs(screenPosition.y) < 1e-10 && screenPosition.z < 1);
    sky.dispose();
    assert.equal(sky.group.parent, null);
  } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
});
