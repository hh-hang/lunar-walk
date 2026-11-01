import * as THREE from 'three';
import {
  applyKaptonFoil, setKaptonFoilEnabled, snapshotKaptonOriginal,
  FOIL_COLOR, FOIL_COLOR_HEAVY,
} from './kapton-foil.js';

/**
 * 对照 Apollo LM / Paul Fjeld 涂层资料与本模型材质色：
 * 琥珀 = 外层镀铝 Kapton（2/5 mil，手揉 MLI）；银灰深灰 = 铝合金主结构与蒙皮。
 * 非金箔金属响应仍与月球车同源（Wheels / Antenne / Damping）。
 */
const LANDER_METAL_SURFACES = {
  // blinn1≈2 mil 琥珀主面；blinn9≈更深琥珀（近 5 mil 观感）。
  blinn1SG: { metalness: 0.7, roughness: 0.16, kapton: true, color: FOIL_COLOR },
  blinn9SG: { metalness: 0.68, roughness: 0.2, kapton: true, color: FOIL_COLOR_HEAVY },
  blinn2SG: { metalness: 0.74, roughness: 0.36 },
  blinn4SG: { metalness: 0.74, roughness: 0.36 },
  blinn3SG: { metalness: 0.86, roughness: 0.3 },
  initialShadingGr: { metalness: 0.86, roughness: 0.3 },
  blinn6SG: { metalness: 0.5, roughness: 0.4 },
};

/** 将登月舱金属改为同源金属响应；Kapton 面加手揉褶皱，可供 GUI 开关还原。 */
export function assignLanderMaterials(root, { kaptonFoil = true } = {}) {
  const kaptonMaterials = [];
  const prepared = new Set();
  root.traverse((object) => {
    if (!object.isMesh) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      const surface = LANDER_METAL_SURFACES[material?.name];
      if (!surface || prepared.has(material)) continue;
      prepared.add(material);
      if (surface.kapton) {
        snapshotKaptonOriginal(material);
        if (kaptonFoil) {
          applyKaptonFoil(material, {
            color: surface.color ?? FOIL_COLOR,
            metalness: surface.metalness,
            roughness: surface.roughness,
          });
        } else {
          material.metalness = surface.metalness;
          material.roughness = surface.roughness;
        }
        kaptonMaterials.push(material);
      } else {
        material.metalness = surface.metalness;
        material.roughness = surface.roughness;
      }
    }
  });
  return kaptonMaterials;
}

/** 批量开关登月舱金箔材质。 */
export function setLanderKaptonFoil(root, enabled) {
  const prepared = new Set();
  let changed = false;
  root?.traverse((object) => {
    if (!object.isMesh) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (!material || prepared.has(material)) continue;
      prepared.add(material);
      if (setKaptonFoilEnabled(material, enabled)) changed = true;
    }
  });
  return changed;
}

/** 按连通零件分配级段，焊接同位置的法线接缝，避免直接切面截断舱壁和支杆。 */
export function partitionStageGeometry(geometry, separationHeight, descentSupports = null, contentBounds = null) {
  const position = geometry.getAttribute('position');
  const parent = Uint32Array.from({ length: position.count }, (_, index) => index);
  const welded = new Map();
  /** 路径压缩后查找零件代表顶点。 */
  function find(index) {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  }
  /** 合并一条边或重合顶点连接的零件。 */
  function join(a, b) {
    parent[find(a)] = find(b);
  }
  for (let index = 0; index < position.count; index++) {
    const key = `${Math.round(position.getX(index) * 1e5)},${Math.round(position.getY(index) * 1e5)},${Math.round(position.getZ(index) * 1e5)}`;
    if (welded.has(key)) join(index, welded.get(key));
    else welded.set(key, index);
  }
  const source = geometry.index?.array ?? Uint32Array.from({ length: position.count }, (_, index) => index);
  for (let index = 0; index < source.length; index += 3) {
    join(source[index], source[index + 1]);
    join(source[index], source[index + 2]);
  }
  const ranges = new Map();
  const point = new THREE.Vector3();
  for (const index of source) {
    const id = find(index);
    if (!ranges.has(id)) ranges.set(id, new THREE.Box3());
    ranges.get(id).expandByPoint(point.fromBufferAttribute(position, index));
  }
  const indices = [[], []];
  for (let index = 0; index < source.length; index += 3) {
    const range = ranges.get(find(source[index]));
    // 只过滤整个零件都远离主体的残留，不截断仍与主体范围相交的细长结构。
    if (contentBounds && !contentBounds.intersectsBox(range)) continue;
    const support = descentSupports && range.min.y <= descentSupports.base && range.max.y <= descentSupports.top;
    const stage = !support && (range.min.y + range.max.y) / 2 >= separationHeight ? 1 : 0;
    indices[stage].push(source[index], source[index + 1], source[index + 2]);
  }
  return indices.map((items) => {
    if (!items.length) return null;
    const vertices = [...new Set(items)];
    const remap = new Map(vertices.map((index, next) => [index, next]));
    const result = new THREE.BufferGeometry();
    // 连同未引用顶点一起移除，保持原始法线、颜色及 UV 数值，不让残留进入包围盒或 GPU 缓冲。
    for (const [name, attribute] of Object.entries(geometry.attributes)) {
      const array = new attribute.array.constructor(vertices.length * attribute.itemSize);
      const stride = attribute.isInterleavedBufferAttribute ? attribute.data.stride : attribute.itemSize;
      const offset = attribute.isInterleavedBufferAttribute ? attribute.offset : 0;
      vertices.forEach((index, next) => {
        for (let channel = 0; channel < attribute.itemSize; channel++)
          array[next * attribute.itemSize + channel] = attribute.array[index * stride + offset + channel];
      });
      const compact = new THREE.BufferAttribute(array, attribute.itemSize, attribute.normalized);
      compact.gpuType = attribute.gpuType;
      result.setAttribute(name, compact);
    }
    result.setIndex(items.map((index) => remap.get(index)));
    result.computeBoundingBox();
    result.computeBoundingSphere();
    return result;
  });
}

/** 保留原模型材质与完整零件，将合并导出的模型重组为独立上下两级。 */
export function createLanderStages(model, scale, sourceBottom) {
  const kaptonMaterials = assignLanderMaterials(model);
  model.updateMatrixWorld(true);
  const descent = new THREE.Group(), ascent = new THREE.Group();
  descent.name = '下降级（留在月面）';
  ascent.name = '上升级';
  const transform = new THREE.Matrix4().makeTranslation(0, -sourceBottom * scale, 0)
    .multiply(new THREE.Matrix4().makeScale(scale, scale, scale));
  // 此资源的舱体与支腿横向范围约为 ±3.22；留出余量，排除 X≈11 的两枚游离圆球。
  const contentBounds = new THREE.Box3(
    new THREE.Vector3(-3.5 * scale, -Infinity, -3.5 * scale),
    new THREE.Vector3(3.5 * scale, Infinity, 3.5 * scale),
  );
  const sourceGeometries = new Set();
  model.traverse((object) => {
    if (!object.isMesh) return;
    const baked = object.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(transform, object.matrixWorld));
    // 四角 RCS 喷流挡板及其高支架属于下降级，不能仅凭零件中心高度归入上升级。
    const parts = partitionStageGeometry(baked, (2.38 - sourceBottom) * scale,
      { base: (2.43 - sourceBottom) * scale, top: (3.0 - sourceBottom) * scale }, contentBounds);
    parts.forEach((geometry, index) => {
      if (!geometry) return;
      const mesh = new THREE.Mesh(geometry, object.material);
      mesh.name = `${object.name}-${index ? '上' : '下'}级`;
      mesh.castShadow = mesh.receiveShadow = true;
      (index ? ascent : descent).add(mesh);
    });
    baked.dispose();
    sourceGeometries.add(object.geometry);
  });
  for (const geometry of sourceGeometries) geometry.dispose();
  // 原模型缺少中央上升喷管；按约 0.83 米实际口径与本场景比例补充简化的烧蚀喷管。
  const nozzle = new THREE.Vector3(0, (1.83 - sourceBottom) * scale, 0);
  const profile = [[0.29, 0], [0.275, 0.04], [0.20, 0.24], [0.12, 0.43], [0.065, 0.60]]
    .map(([radius, y]) => new THREE.Vector2(radius * scale, y * scale));
  const engine = new THREE.Mesh(new THREE.LatheGeometry(profile, 32),
    new THREE.MeshStandardMaterial({ color: 0x38302b, roughness: 0.88, side: THREE.DoubleSide }));
  engine.name = '上升发动机喷管（补充）';
  engine.position.copy(nozzle);
  engine.castShadow = engine.receiveShadow = true;
  ascent.add(engine);
  const opening = new THREE.Mesh(new THREE.CircleGeometry(0.36 * scale, 32),
    new THREE.MeshStandardMaterial({ color: 0x141311, roughness: 1 }));
  opening.name = '下降级中央喷流通道';
  opening.rotation.x = -Math.PI / 2;
  opening.position.y = (2.4234 - sourceBottom) * scale + 0.003;
  descent.add(opening);
  const pivot = new THREE.Vector3(0, (3.4 - sourceBottom) * scale, 0);
  let kaptonFoilEnabled = true;
  /** 开=金箔揉皱，关=GLB 原材质外观。 */
  function setKaptonFoil(enabled) {
    kaptonFoilEnabled = Boolean(enabled);
    for (const material of kaptonMaterials) setKaptonFoilEnabled(material, kaptonFoilEnabled);
    return kaptonFoilEnabled;
  }
  return {
    descent, ascent, nozzle, nozzleRadius: 0.29 * scale, pivot, kaptonMaterials,
    get kaptonFoilEnabled() { return kaptonFoilEnabled; },
    setKaptonFoil,
  };
}
