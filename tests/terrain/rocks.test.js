import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { playerController } from 'three-player-controller';
import { LunarRockField, ROCK_LOD_BANDS, rockDetailScale } from '../../src/terrain/rocks.js';

/** 创建带确定性摆放数据的岩石场景夹具。 */
function fieldWithRocks() {
  const scene = new THREE.Scene(),
    focus = { value: new THREE.Vector2() };
  const field = new LunarRockField(scene, new THREE.MeshStandardMaterial(), focus);
  const placement = {
    items: [
      { id: 'boulder', variant: 0, index: 0, x: 4, z: 0, scale: 2 },
      { id: 'small', variant: 1, index: 0, x: -5, z: 3, scale: 0.18 },
      { id: 'distant', variant: 0, index: 1, x: 30, z: 0, scale: 2 },
    ],
  };
  const transform = new THREE.Object3D();
  for (const item of placement.items) {
    transform.position.set(item.x, item.scale * 0.1, item.z);
    transform.rotation.set(0.2, 1.1, -0.1);
    transform.scale.set(item.scale, item.scale * 0.83, item.scale * 0.9);
    transform.updateMatrix();
    field.far[item.variant].setMatrixAt(item.index, transform.matrix);
    field.far[item.variant].setColorAt(item.index, new THREE.Color(0.8, 0.8, 0.8));
    field.far[item.variant].count = Math.max(field.far[item.variant].count, item.index + 1);
  }
  field.update(placement, 0, 0, true);
  return { scene, field, placement, focus };
}

test('岩石细节等级合并法线、按尺寸调整距离并保留固定摆放姿态', () => {
  const { field, placement, focus } = fieldWithRocks();
  const matrix = new THREE.Matrix4(),
    point = new THREE.Vector3();
  const canonical = field.far.map((mesh) => mesh.instanceMatrix.array.slice());
  for (let variant = 0; variant < 3; variant++) {
    const [near, mid, far] = field.levels.map((level) => level[variant].geometry);
    assert.equal(near.index.count / 3, 5120);
    assert.equal(mid.index.count / 3, 1280);
    assert.equal(far.index.count / 3, variant === 2 ? 20 : 80);
    assert.ok(near.getAttribute('position').count < near.index.count / 2, '共享顶点必须合并');
    const normals = near.getAttribute('normal');
    for (let i = 0; i < normals.count; i++)
      assert.ok(Math.abs(point.fromBufferAttribute(normals, i).length() - 1) < 1e-5);
  }
  for (const x of [0, 10, 45, 150, 300]) {
    field.update(placement, x, 0);
    for (let level = 0; level < 2; level++) {
      const [begin, end] = ROCK_LOD_BANDS[level];
      for (const mesh of field.levels[level])
        for (let i = 0; i < mesh.count; i++) {
          mesh.getMatrixAt(i, matrix);
          const item = placement.items.find((item) => Math.abs(item.x - matrix.elements[12]) < 1e-5);
          const source = field.far[item.variant].instanceMatrix.array.subarray(item.index * 16, item.index * 16 + 16);
          assert.deepEqual(matrix.elements, [...source]);
          const distance = Math.hypot(item.x - x, item.z) / rockDetailScale(item.scale);
          assert.ok(distance >= begin - 2 && distance <= end + 2);
        }
    }
    field.far.forEach((mesh, i) => assert.deepEqual(mesh.instanceMatrix.array, canonical[i]));
  }
  const depth = field.levels[0][0].customDepthMaterial;
  const shader = {
    uniforms: {},
    vertexShader: THREE.ShaderLib.depth.vertexShader,
    fragmentShader: THREE.ShaderLib.depth.fragmentShader,
  };
  depth.onBeforeCompile(shader);
  assert.equal(shader.uniforms.uGravelFocus, focus);
  assert.ok(shader.fragmentShader.includes('smoothstep(14.0, 20.0'));
  assert.ok(shader.vertexShader.includes('length(instanceMatrix[0].xyz) / 0.6'));
});

test('附近岩石碰撞体具有独立 BVH，保持世界单位与细节切换后的碰撞一致', () => {
  const { scene, field, placement } = fieldWithRocks();
  const player = new playerController();
  player.scene = scene;
  const needed = field.nearbyColliders(placement, 0, 0);
  assert.deepEqual([...needed.keys()], ['rock:boulder', 'rock:small']);
  const handles = [...needed].map(([key, mesh]) => {
    assert.ok(mesh.geometry.boundsTree);
    const scale = new THREE.Vector3().setFromMatrixScale(mesh.matrixWorld);
    assert.ok(scale.distanceTo(new THREE.Vector3(1, 1, 1)) < 1e-10, '胶囊碰撞必须使用世界单位');
    const item = placement.items.find((item) => key === `rock:${item.id}`);
    const ray = new THREE.Raycaster(new THREE.Vector3(item.x, 10, item.z), new THREE.Vector3(0, -1, 0));
    assert.ok(ray.intersectObject(mesh)[0].point.y > 0.01);
    return [key, player.addCollider({ motion: 'static', shape: { kind: 'mesh', mesh } })];
  });
  assert.ok(player.isStaticColliderUsable());
  player.setColliderDebug(true);
  for (const mesh of needed.values()) assert.ok(scene.children.includes(mesh));

  const boulder = needed.get('rock:boulder');
  assert.notEqual(boulder.geometry.boundsTree._roots[0], field.colliderShapes[0].bvh.roots[0]);
  const originalRoot = field.colliderShapes[0].bvh.roots[0].slice(0);
  field.update(placement, 300, 0);
  assert.equal(field.levels[0][0].count, 0, '可见网格应已切换到远景细节等级');
  assert.equal(field.nearbyColliders(placement, 0.5, 0).get('rock:boulder'), boulder);
  assert.ok(field.nearbyColliders(placement, 12, 0).has('rock:distant'), '包含与十六米范围相交的巨石');
  assert.deepEqual(field.colliderShapes[0].bvh.roots[0], originalRoot, '实例重拟合不能修改原型 BVH');

  // 地形方案变化可改变岩石高度，但不能改变其固定标识。
  field.far[0].instanceMatrix.array[13] += 0.12;
  const replacement = field.nearbyColliders(placement, 0, 0).get('rock:boulder');
  assert.notEqual(replacement, boulder);
  const [key, oldHandle] = handles[0];
  player.removeCollider(oldHandle);
  field.releaseCollider(key, oldHandle.collisionMesh);
  assert.equal(field.colliders.get(key), replacement, '释放旧姿态时应保留已准备的替代碰撞体');
  const handle = player.addCollider({ motion: 'static', shape: { kind: 'mesh', mesh: replacement } });
  assert.ok(scene.children.includes(replacement), '替换碰撞体应继承调试可见性');

  // 浮动原点只改变平移，不改变已烘焙缩放的碰撞几何。
  for (const mesh of field.far)
    for (let i = 0; i < mesh.count; i++) {
      mesh.instanceMatrix.array[i * 16 + 12] -= 3072;
      mesh.instanceMatrix.array[i * 16 + 14] += 3072;
    }
  const rebased = field.nearbyColliders(placement, 0, 0).get('rock:boulder');
  const ray = new THREE.Raycaster(new THREE.Vector3(4 - 3072, 10, 3072), new THREE.Vector3(0, -1, 0));
  assert.ok(ray.intersectObject(rebased).length);
  assert.deepEqual(
    rebased.geometry.getAttribute('position').array,
    replacement.geometry.getAttribute('position').array,
  );
  player.removeCollider(handle);
  field.releaseCollider(key, replacement);
  assert.equal(field.colliders.get(key), rebased);
  const smallHandle = handles[1][1];
  player.removeCollider(smallHandle);
  field.releaseCollider('rock:small', smallHandle.collisionMesh);
  for (const [colliderKey, mesh] of field.colliders) {
    mesh.geometry.dispose();
    mesh.material.dispose();
    field.releaseCollider(colliderKey, mesh);
  }
  assert.equal(field.colliders.size, 0);
});
