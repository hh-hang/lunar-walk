import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { assignLanderMaterials } from '../../src/game/lander-stages.js';
import { setKaptonFoilEnabled } from '../../src/game/kapton-foil.js';

test('登月舱 Kapton 用物体空间褶皱着色，铝合金走同源金属响应', () => {
  const kapton = new THREE.Mesh(
    new THREE.BoxGeometry(),
    new THREE.MeshStandardMaterial({ name: 'blinn1SG', color: 0xe3c045 }),
  );
  const amber = new THREE.Mesh(
    new THREE.BoxGeometry(),
    new THREE.MeshStandardMaterial({ name: 'blinn9SG', color: 0xd19926 }),
  );
  const alloy = new THREE.Mesh(
    new THREE.BoxGeometry(),
    new THREE.MeshStandardMaterial({ name: 'blinn4SG', color: 0xe0e0e0 }),
  );
  const strut = new THREE.Mesh(
    new THREE.BoxGeometry(),
    new THREE.MeshStandardMaterial({ name: 'blinn2SG', color: 0x8d8d8d }),
  );
  const antenna = new THREE.Mesh(
    new THREE.BoxGeometry(),
    new THREE.MeshStandardMaterial({ name: 'blinn3SG', color: 0xd7d7d7 }),
  );
  const dark = new THREE.Mesh(
    new THREE.BoxGeometry(),
    new THREE.MeshStandardMaterial({ name: 'blinn6SG', color: 0x3d3d3d }),
  );
  const paint = new THREE.Mesh(
    new THREE.BoxGeometry(),
    new THREE.MeshStandardMaterial({ name: 'blinn7SG', color: 0xffffff, metalness: 0, roughness: 0.6 }),
  );
  const root = new THREE.Group();
  root.add(kapton, amber, alloy, strut, antenna, dark, paint);
  assignLanderMaterials(root);

  assert.equal(kapton.material.map, null);
  assert.ok(kapton.material.userData.kaptonFoil);
  assert.ok(kapton.material.userData.lunarThermalFilm);
  assert.ok(kapton.material.customProgramCacheKey().includes('kapton-foil'));
  assert.equal(kapton.material.metalness, 0.7);
  assert.equal(kapton.material.color.getHex(), 0xd9a24a);
  assert.equal(amber.material.userData.kaptonFoil, true);
  assert.equal(amber.material.color.getHex(), 0xc48438);
  const shader = {
    uniforms: {},
    vertexShader: THREE.ShaderLib.standard.vertexShader,
    fragmentShader: THREE.ShaderLib.standard.fragmentShader,
  };
  kapton.material.onBeforeCompile(shader);
  assert.ok(shader.fragmentShader.includes('kapTriplanarNormal'));
  assert.ok(shader.fragmentShader.includes('uKaptonEnabled'));
  assert.equal(shader.uniforms.uKaptonEnabled, kapton.material.userData.kaptonEnabled);
  assert.ok(shader.uniforms.uKaptonShade?.value);

  const originalHex = kapton.material.userData.kaptonOriginal.color.getHex();
  setKaptonFoilEnabled(kapton.material, false);
  assert.equal(kapton.material.userData.kaptonEnabled.value, 0);
  assert.equal(kapton.material.color.getHex(), originalHex);
  assert.equal(kapton.material.userData.lunarThermalFilm, false);
  setKaptonFoilEnabled(kapton.material, true);
  assert.equal(kapton.material.userData.kaptonEnabled.value, 1);
  assert.equal(kapton.material.metalness, 0.7);
  assert.equal(kapton.material.userData.lunarThermalFilm, true);

  assert.equal(alloy.material.metalness, 0.74);
  assert.equal(alloy.material.roughness, 0.36);
  assert.equal(alloy.material.userData.kaptonFoil, undefined);
  assert.equal(strut.material.metalness, 0.74);
  assert.equal(antenna.material.metalness, 0.86);
  assert.equal(dark.material.metalness, 0.5);
  assert.equal(paint.material.metalness, 0);
  assert.equal(paint.material.userData.lunarThermalFilm, undefined);
});
