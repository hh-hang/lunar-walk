import * as THREE from 'three';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';

/** 仅在阴影绘制期间裁掉地形裙边，完成后恢复原绘制范围。 */
export function excludeTerrainSkirtsFromShadows(mesh, surfaceIndexCount) {
  let start = 0,
    count = Infinity;
  // 裙边只用于遮住地形细节等级接缝；阴影通道排除其竖壁，防止产生网格状伪阴影。
  mesh.onBeforeShadow = () => {
    const range = mesh.geometry.drawRange;
    start = range.start;
    count = range.count;
    mesh.geometry.setDrawRange(start, Math.max(0, Math.min(count, surfaceIndexCount - start)));
  };
  mesh.onAfterShadow = () => mesh.geometry.setDrawRange(start, count);
  return mesh;
}

/** 用可传输地形数据创建几何，优先复用已算好的包围盒。 */
export function geometryFromData(data) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(data.uv, 2));
  geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
  if (data.bounds) {
    geometry.boundingBox = new THREE.Box3(new THREE.Vector3(...data.bounds.min), new THREE.Vector3(...data.bounds.max));
    geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new THREE.Sphere());
  } else {
    geometry.computeBoundingSphere();
  }
  return geometry;
}

/** 创建仅含地表的碰撞网格，并复用工作线程生成的 BVH。 */
export function collisionMeshFromData(data) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(data.positions.subarray(0, data.surfaceVertices * 3), 3));
  const index = data.bvh?.index ?? data.indices.subarray(0, data.surfaceIndexCount);
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  if (data.bvh) geometry.boundsTree = MeshBVH.deserialize(data.bvh, geometry);
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({
      wireframe: true,
      transparent: true,
      opacity: 0.5,
      side: THREE.DoubleSide,
      depthTest: true,
    }),
  );
  mesh.raycast = data.bvh ? acceleratedRaycast : mesh.raycast;
  return mesh;
}
