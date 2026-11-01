import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { assignRoverMaterials } from '../../src/vehicle/rover.js';

test('车辆表面保留各自金属响应，玻璃纤维挡泥板与金属轮胎独立', () => {
  const shared = new THREE.MeshStandardMaterial({ name: 'Wheels' });
  const wheel = new THREE.Mesh(new THREE.BoxGeometry(), shared);
  wheel.name = 'Wheel_LF_Mesh';
  const fender = new THREE.Mesh(new THREE.BoxGeometry(), shared);
  fender.name = 'Fender_LF_Mesh';
  const chassis = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ name: 'Chassis' }));
  const seat = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ name: 'Seats' }));
  const lens = new THREE.Mesh(
    new THREE.SphereGeometry(0.1),
    new THREE.MeshStandardMaterial({ name: 'Kameralinse', metalness: 1, roughness: 1 }),
  );
  const antenna = new THREE.Mesh(new THREE.SphereGeometry(0.2), new THREE.MeshStandardMaterial({ name: 'Antenne' }));
  const root = new THREE.Group();
  root.add(wheel, fender, chassis, seat, lens, antenna);
  assignRoverMaterials(root);

  assert.equal(wheel.material.name, 'Wheels');
  assert.equal(wheel.material.metalness, 0.74);
  assert.equal(wheel.material.roughness, 0.36);
  assert.equal(fender.material.name, 'Fenders');
  assert.notEqual(fender.material, wheel.material);
  assert.equal(fender.material.metalness, 0.06);
  assert.equal(fender.material.roughness, 0.32);
  assert.equal(seat.material.roughness, 0.75);
  assert.equal(lens.material.metalness, 0.04);
  assert.equal(lens.material.roughness, 0.08);
  assert.equal(antenna.material.metalness, 0.86);
  assert.ok(chassis.material.customProgramCacheKey().includes('rover-film'));
  const shader = { fragmentShader: THREE.ShaderLib.standard.fragmentShader };
  chassis.material.onBeforeCompile(shader);
  assert.ok(shader.fragmentShader.includes('metalnessFactor=mix(metalnessFactor,0.45,film)'));
});
