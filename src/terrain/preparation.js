import * as THREE from 'three';

/** 创建不写入颜色与深度的几何预热回调。 */
export function createTerrainPreparation(renderer, camera) {
  const scene = new THREE.Scene();
  const placeholder = new THREE.BufferGeometry();
  const material = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: false });
  const mesh = new THREE.Mesh(placeholder, material);
  mesh.frustumCulled = false;
  scene.add(mesh);
  return (geometry) => {
    mesh.geometry = geometry;
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    try {
      renderer.render(scene, camera);
    } finally {
      renderer.autoClear = autoClear;
      mesh.geometry = placeholder;
    }
  };
}
