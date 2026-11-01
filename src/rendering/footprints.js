import * as THREE from 'three';
import { FootprintStore, FOOTPRINT_TILE_SIZE, FOOTPRINT_GRID, positiveMod } from './footprint-store.js';

const TILE = FOOTPRINT_TILE_SIZE,
  GRID = FOOTPRINT_GRID;

export class LunarFootprints {
  /** 创建固定大小的高度与坡度图集，以及印记历史和调试标记。 */
  constructor(renderer, scene, material, { resolution, limit = 5000, trackLimit = 8000 } = {}) {
    this.renderer = renderer;
    this.scene = scene;
    this.store = new FootprintStore({ limit, trackLimit });
    const maxResolution = 2 ** Math.floor(Math.log2(renderer.capabilities.maxTextureSize / GRID));
    this.resolution = Math.min(resolution ?? 2048, maxResolution);
    this.target = new THREE.WebGLRenderTarget(this.resolution * GRID, this.resolution * GRID, {
      format: THREE.RedFormat,
      internalFormat: 'R8',
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    this.target.texture.name = 'Bounded lunar footprint height atlas';
    this.slots = Array.from({ length: GRID * GRID }, () => ({ key: null, lastId: 0, dirty: true, patches: [] }));
    this.slopeQueue = [];
    this.slopeRects = [];
    this.store.onErase = (key, record) => {
      for (const slot of this.slots) if (slot.key === key) this.markErased(slot, record);
    };
    this.shaded = new THREE.WebGLRenderTarget(this.target.width, this.target.height, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    this.shaded.texture.name = 'Lunar footprint height and slope atlas';
    this.shaded.texture.colorSpace = THREE.NoColorSpace;
    this.target.texture.colorSpace = THREE.NoColorSpace;
    this.stats = {
      count: 0,
      trackCount: 0,
      digCount: 0,
      tiles: 0,
      bakeMs: 0,
      peakBakeMs: 0,
      draws: 0,
      gpuMiB: (this.target.width * this.target.height * 5) / 1024 ** 2,
    };
    this.enabled = true;
    this.tracksEnabled = false;
    this.debug = false;
    this.lastRecords = { left: null, right: null };
    this.uniforms = {
      uFootprintMap: { value: this.shaded.texture },
      uFootprintWindow: { value: new THREE.Vector2() },
      uFootprintSlot: { value: new THREE.Vector2() },
      uFootprintResolution: { value: this.resolution },
      uFootprintEnabled: { value: 1 },
      uFootprintDepth: { value: 0.008 },
    };
    this.makeStampPass(limit + trackLimit);
    this.markers = ['left', 'right'].map((side) => {
      const marker = new THREE.ArrowHelper(
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3(),
        0.09,
        side === 'left' ? 0x6de0b8 : 0xffd083,
        0.025,
        0.015,
      );
      marker.visible = false;
      scene.add(marker);
      marker.userData.side = side;
      return marker;
    });
    this.addMaterialShader(material);
  }

  /** 在加载阶段预热印记着色器和实例缓冲。 */
  async prepare() {
    // 加载期间编译并上传盖印与坡度通道，避免首次落脚时卡顿。
    await this.renderer.compileAsync(this.stampScene, this.stampCamera);
    await this.renderer.compileAsync(this.slopeScene, this.slopeCamera);
    this.update(0, 0, 0, 0);
    const renderer = this.renderer,
      target = renderer.getRenderTarget(),
      face = renderer.getActiveCubeFace(),
      mip = renderer.getActiveMipmapLevel();
    const autoClear = renderer.autoClear;
    try {
      // 零轴形成退化三角形，只预热缓冲，不在月壤上留下印记。
      this.stampMesh.geometry.instanceCount = 1;
      renderer.autoClear = false;
      renderer.setRenderTarget(this.target);
      renderer.render(this.stampScene, this.stampCamera);
    } finally {
      this.stampMesh.geometry.instanceCount = 0;
      renderer.setRenderTarget(target, face, mip);
      renderer.autoClear = autoClear;
    }
    this.stats.peakBakeMs = 0;
  }

  /** 创建可批量绘制鞋印与连续胎纹的实例化盖印通道。 */
  makeStampPass(limit) {
    const quad = new THREE.PlaneGeometry(2, 2);
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.index = quad.index;
    geometry.attributes = { position: quad.attributes.position, uv: quad.attributes.uv };
    geometry.setAttribute(
      'stampCenter',
      new THREE.InstancedBufferAttribute(new Float32Array(limit * 2), 2).setUsage(THREE.DynamicDrawUsage),
    );
    geometry.setAttribute(
      'stampAxes',
      new THREE.InstancedBufferAttribute(new Float32Array(limit * 4), 4).setUsage(THREE.DynamicDrawUsage),
    );
    geometry.setAttribute(
      'stampSide',
      new THREE.InstancedBufferAttribute(new Float32Array(limit), 1).setUsage(THREE.DynamicDrawUsage),
    );
    geometry.setAttribute(
      'stampTread',
      new THREE.InstancedBufferAttribute(new Float32Array(limit * 2), 2).setUsage(THREE.DynamicDrawUsage),
    );
    geometry.instanceCount = 0;
    const material = new THREE.ShaderMaterial({
      uniforms: { tileSize: { value: TILE }, trackStrength: { value: 0.85 } },
      depthTest: false,
      depthWrite: false,
      transparent: true,
      toneMapped: false,
      side: THREE.DoubleSide,
      forceSinglePass: true,
      blending: THREE.CustomBlending,
      blendEquation: THREE.MaxEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      vertexShader: `attribute vec2 stampCenter; attribute vec4 stampAxes; attribute float stampSide; attribute vec2 stampTread;
        uniform float tileSize; varying vec2 sole; varying float footSide; varying vec2 treadPhase;
        void main() { sole = position.xy; footSide = stampSide; treadPhase = stampTread;
          vec2 p = stampCenter + stampAxes.xy * position.x + stampAxes.zw * position.y;
          gl_Position = vec4(p / tileSize * 2.0 - 1.0, 0.0, 1.0); }`,
      fragmentShader: `varying vec2 sole; varying float footSide; varying vec2 treadPhase; uniform float trackStrength;
        void main() {
          vec2 p = sole;
          // 采样 scoop trench：陡壁长槽 + 一侧扰动带，写入同一高度图。
          if (footSide > 1.5) {
            float along = abs(p.x);
            float across = abs(p.y);
            float trench = (1.0 - smoothstep(0.82, 1.0, along)) * (1.0 - smoothstep(0.48, 0.78, across));
            float bowl = exp(-along * along * 2.4 - across * across * 9.0);
            float lip = (1.0 - smoothstep(0.6, 1.0, along)) * smoothstep(0.4, 0.68, across) * (1.0 - smoothstep(0.78, 1.0, across));
            float spoil = (1.0 - smoothstep(0.15, 0.95, along)) * smoothstep(0.1, 0.5, p.y) * (1.0 - smoothstep(0.65, 1.0, p.y));
            float pressure = trench * (0.5 + 0.5 * bowl) + lip * 0.35 + spoil * 0.3;
            if (pressure < 0.008) discard;
            gl_FragColor = vec4(clamp(pressure, 0.0, 1.0), 0.0, 0.0, 1.0); return;
          }
          if (abs(footSide) < .5) {
            float phase = treadPhase.x + (p.y * .5 + .5) * treadPhase.y;
            float row = abs(fract(phase + abs(p.x) * .35) - .5);
            float aa = max(fwidth(phase), .015);
            float chevron = 1.0 - smoothstep(.10 - aa, .10 + aa, row);
            float meshRow = abs(fract(phase * 3.0 + p.x * 5.0) - .5);
            float mesh = 1.0 - smoothstep(.06, .18, meshRow);
            float edge = 1.0 - smoothstep(.84, 1.0, abs(p.x));
            float end = 1.0 - smoothstep(.97, 1.0, abs(p.y));
            float pressure = edge * end * (.32 + .55 * chevron + .10 * mesh) * trackStrength;
            if (pressure < .005) discard;
            gl_FragColor = vec4(pressure, 0.0, 0.0, 1.0); return;
          }
          float width = mix(0.77, 0.94, smoothstep(-0.65, 0.1, p.y));
          width -= 0.14 * exp(-pow((p.y + 0.1) * 3.0, 2.0)) * (0.5 + p.x * footSide * 0.5);
          float boundary = max(abs(p.x) / width, abs(p.y) / 0.96);
          float toeCurve = length(vec2(p.x / width, max(p.y - 0.60, 0.0) * 2.7));
          float shape = (1.0 - smoothstep(0.86, 1.0, boundary)) * (1.0 - smoothstep(0.9, 1.03, toeCurve));
          float rows = abs(fract((p.y + p.x * footSide * 0.10) * 4.4) - 0.5);
          float tread = smoothstep(0.12, 0.24, rows);
          float split = smoothstep(0.045, 0.12, abs(p.x));
          float heelGap = 1.0 - 0.7 * (1.0 - smoothstep(0.025, 0.07, abs(p.y + 0.35)));
          float pressure = shape * (0.28 + tread * split * 0.72) * heelGap;
          if (pressure < 0.005) discard;
          gl_FragColor = vec4(pressure, 0.0, 0.0, 1.0);
        }`,
    });
    this.stampMesh = new THREE.Mesh(geometry, material);
    this.stampMesh.name = 'footprint-stamp';
    this.stampMesh.frustumCulled = false;
    this.stampScene = new THREE.Scene();
    this.stampScene.add(this.stampMesh);
    this.stampCamera = new THREE.Camera();
    this.makeSlopePass();
  }

  /** 创建将高度图转换为坡度纹理的局部更新通道。 */
  makeSlopePass() {
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uHeightMap: { value: this.target.texture },
        uFootprintWindow: this.uniforms.uFootprintWindow,
        uFootprintSlot: this.uniforms.uFootprintSlot,
        uFootprintResolution: this.uniforms.uFootprintResolution,
      },
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `uniform sampler2D uHeightMap; uniform vec2 uFootprintWindow; uniform vec2 uFootprintSlot; uniform float uFootprintResolution;
        float rawHeight(vec2 p) {
          vec2 cell = (p - uFootprintWindow) / ${TILE.toFixed(1)};
          if (any(lessThan(cell, vec2(0.0))) || any(greaterThanEqual(cell, vec2(${GRID.toFixed(1)})))) return 0.0;
          vec2 slot = mod(floor(cell) + uFootprintSlot, ${GRID.toFixed(1)});
          float halfTexel = 0.5 / uFootprintResolution;
          vec2 uv = (slot + clamp(fract(cell), vec2(halfTexel), vec2(1.0 - halfTexel))) / ${GRID.toFixed(1)};
          return texture2D(uHeightMap, uv).r;
        }
        void main() {
          float res = uFootprintResolution;
          vec2 slot = floor(gl_FragCoord.xy / res);
          vec2 offset = mod(slot - uFootprintSlot + ${GRID.toFixed(1)}, ${GRID.toFixed(1)});
          vec2 local = (gl_FragCoord.xy - slot * res + 0.5) / res;
          vec2 p = uFootprintWindow + (offset + local) * ${TILE.toFixed(1)};
          float stepSize = ${TILE.toFixed(1)} / res;
          float dhx = rawHeight(p + vec2(stepSize, 0.0)) - rawHeight(p - vec2(stepSize, 0.0));
          float dhz = rawHeight(p + vec2(0.0, stepSize)) - rawHeight(p - vec2(0.0, stepSize));
          gl_FragColor = vec4(rawHeight(p), clamp(dhx * 0.5 + 0.5, 0.0, 1.0), clamp(dhz * 0.5 + 0.5, 0.0, 1.0), 1.0);
        }`,
    });
    this.slopeMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    this.slopeMesh.name = 'footprint-slope';
    this.slopeMesh.frustumCulled = false;
    this.slopeScene = new THREE.Scene();
    this.slopeScene.add(this.slopeMesh);
    this.slopeCamera = new THREE.Camera();
  }

  /** 记录待擦除矩形；局部更新过多时改为重建整块。 */
  markErased(slot, record) {
    if (!record || slot.dirty) {
      slot.dirty = true;
      slot.patches.length = 0;
      return;
    }
    const rx = Math.abs(record.ax) + Math.abs(record.bx),
      rz = Math.abs(record.az) + Math.abs(record.bz);
    slot.patches.push({ minX: record.x - rx, maxX: record.x + rx, minZ: record.z - rz, maxZ: record.z + rz });
    if (slot.patches.length > 24) {
      slot.dirty = true;
      slot.patches.length = 0;
    }
  }

  /** 计算单枚印记在世界平面上的轴对齐边界。 */
  recordBounds(record) {
    const rx = Math.abs(record.ax) + Math.abs(record.bx),
      rz = Math.abs(record.az) + Math.abs(record.bz);
    return { minX: record.x - rx, maxX: record.x + rx, minZ: record.z - rz, maxZ: record.z + rz };
  }

  /** 将世界矩形转换为当前图集地块内的像素裁剪范围。 */
  tilePixels(rect, tx, tz) {
    const scale = this.resolution / TILE;
    const x0 = Math.max(0, Math.floor((rect.minX - tx * TILE) * scale) - 1);
    const z0 = Math.max(0, Math.floor((rect.minZ - tz * TILE) * scale) - 1);
    const x1 = Math.min(this.resolution, Math.ceil((rect.maxX - tx * TILE) * scale) + 1);
    const z1 = Math.min(this.resolution, Math.ceil((rect.maxZ - tz * TILE) * scale) + 1);
    if (x1 <= x0 || z1 <= z0) return null;
    return { x: x0, y: z0, w: x1 - x0, h: z1 - z0 };
  }

  /** 绑定循环图集中的高度地块与对应视口。 */
  bindHeightTile(sx, sz) {
    const size = this.resolution;
    this.target.viewport.set(sx * size, sz * size, size, size);
    this.target.scissor.set(sx * size, sz * size, size, size);
    this.target.scissorTest = true;
    this.renderer.setRenderTarget(this.target);
  }

  /** 批量上传印记实例并绘制到指定高度地块。 */
  drawStamps(stamps, tx, tz) {
    const geometry = this.stampMesh.geometry;
    stamps.forEach((record, i) => {
      geometry.attributes.stampCenter.setXY(i, record.x - tx * TILE, record.z - tz * TILE);
      geometry.attributes.stampAxes.setXYZW(i, record.ax, record.az, record.bx, record.bz);
      geometry.attributes.stampSide.setX(i,
        record.kind === 'tire' ? 0 : record.kind === 'dig' ? 2 : record.side === 'left' ? -1 : 1);
      geometry.attributes.stampTread.setXY(i, record.phase ?? 0, record.span ?? 0);
    });
    geometry.instanceCount = stamps.length;
    for (const name of ['stampCenter', 'stampAxes', 'stampSide', 'stampTread']) {
      const attribute = geometry.attributes[name];
      attribute.clearUpdateRanges();
      attribute.addUpdateRange(0, stamps.length * attribute.itemSize);
      attribute.needsUpdate = true;
    }
    this.renderer.render(this.stampScene, this.stampCamera);
  }

  /** 将变化区域加入坡度更新队列。 */
  queueSlope(rect) {
    this.slopeQueue.push(rect);
  }

  /** 合并相交的坡度更新矩形，减少重复绘制。 */
  addSlopeRect(rect) {
    for (const item of this.slopeRects) {
      if (
        item.x < rect.x + rect.w &&
        rect.x < item.x + item.w &&
        item.y < rect.y + rect.h &&
        rect.y < item.y + item.h
      ) {
        const x = Math.min(item.x, rect.x),
          y = Math.min(item.y, rect.y);
        const right = Math.max(item.x + item.w, rect.x + rect.w),
          top = Math.max(item.y + item.h, rect.y + rect.h);
        item.x = x;
        item.y = y;
        item.w = right - x;
        item.h = top - y;
        return;
      }
    }
    this.slopeRects.push(rect);
  }

  /** 为本批变化区域重算坡度，并清空更新队列。 */
  flushSlopes(minX, minZ) {
    const pad = (2 * TILE) / this.resolution;
    for (const region of this.slopeQueue) {
      const expanded = {
        minX: region.minX - pad,
        maxX: region.maxX + pad,
        minZ: region.minZ - pad,
        maxZ: region.maxZ + pad,
      };
      for (let z = minZ; z < minZ + GRID; z++)
        for (let x = minX; x < minX + GRID; x++) {
          const pixels = this.tilePixels(expanded, x, z);
          if (!pixels) continue;
          const sx = positiveMod(x, GRID),
            sz = positiveMod(z, GRID);
          this.addSlopeRect({
            x: sx * this.resolution + pixels.x,
            y: sz * this.resolution + pixels.y,
            w: pixels.w,
            h: pixels.h,
          });
        }
    }
    this.slopeQueue.length = 0;
    for (const rect of this.slopeRects) {
      this.shaded.viewport.set(rect.x, rect.y, rect.w, rect.h);
      this.shaded.scissor.copy(this.shaded.viewport);
      this.shaded.scissorTest = true;
      this.renderer.setRenderTarget(this.shaded);
      this.renderer.render(this.slopeScene, this.slopeCamera);
    }
    this.slopeRects.length = 0;
  }

  /** 向月壤材质注入印记高度与坡度采样，不改变地形碰撞。 */
  addMaterialShader(material) {
    const compile = material.onBeforeCompile,
      key = material.customProgramCacheKey();
    material.onBeforeCompile = (shader, renderer) => {
      compile.call(material, shader, renderer);
      Object.assign(shader.uniforms, this.uniforms);
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        `#include <common>
        uniform sampler2D uFootprintMap;
        uniform vec2 uFootprintWindow; uniform vec2 uFootprintSlot;
        uniform float uFootprintResolution; uniform float uFootprintEnabled; uniform float uFootprintDepth;
        float footprintFade(vec2 p) {
          vec2 cell = (p - uFootprintWindow) / ${TILE.toFixed(1)};
          if (any(lessThan(cell, vec2(0.0))) || any(greaterThanEqual(cell, vec2(${GRID.toFixed(1)})))) return 0.0;
          vec2 edge = min(cell, vec2(${GRID.toFixed(1)}) - cell) * ${TILE.toFixed(1)};
          return smoothstep(0.0, 1.0, min(edge.x, edge.y));
        }
        vec4 footprintRaw(vec2 p) {
          vec2 cell = (p - uFootprintWindow) / ${TILE.toFixed(1)};
          if (any(lessThan(cell, vec2(0.0))) || any(greaterThanEqual(cell, vec2(${GRID.toFixed(1)})))) return vec4(0.0);
          vec2 slot = mod(floor(cell) + uFootprintSlot, ${GRID.toFixed(1)});
          float halfTexel = 0.5 / uFootprintResolution;
          vec2 uv = (slot + clamp(fract(cell), vec2(halfTexel), vec2(1.0 - halfTexel))) / ${GRID.toFixed(1)};
          return texture2D(uFootprintMap, uv);
        }
      `,
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float printPixel = max(length(dFdx(vMoonWorld.xz)), length(dFdy(vMoonWorld.xz)));
        float printVisibility = uFootprintEnabled * (1.0 - smoothstep(0.008, 0.045, printPixel));
        vec4 printRelief = printVisibility > 0.001 ? footprintRaw(vMoonWorld.xz) : vec4(0.0);
        float printFade = printVisibility > 0.001 ? footprintFade(vMoonWorld.xz) : 0.0;
        float printDepth = printRelief.r * printFade * printVisibility;
        // 深印（采样坑）再略压暗，浅脚印保持原对比。
        diffuseColor.rgb *= 1.0 - printDepth * mix(0.28, 0.55, printDepth);
      `,
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        if (printDepth > 0.001) {
          float stepSize = ${TILE.toFixed(1)} / uFootprintResolution;
          float slopeX = (printRelief.g * 2.0 - 1.0) * printFade / (2.0 * stepSize);
          float slopeZ = (printRelief.b * 2.0 - 1.0) * printFade / (2.0 * stepSize);
          vec3 worldNormal = transformDirectionByInverseViewMatrix(normal, viewMatrix);
          vec3 gradient = vec3(slopeX, 0.0, slopeZ) * uFootprintDepth * printVisibility;
          gradient -= worldNormal * dot(worldNormal, gradient);
          normal = normalize(mat3(viewMatrix) * normalize(worldNormal + gradient));
        }
      `,
      );
    };
    material.customProgramCacheKey = () => `${key}-footprint-atlas`;
    material.needsUpdate = true;
  }

  /** 保存鞋印并记录左右脚的最新调试位置。 */
  add(contact) {
    if (!this.enabled) return;
    const record = this.store.add(contact);
    if (record) this.lastRecords[record.side] = record;
    this.stats.count = this.store.byKind.foot.size;
  }

  /** 在车辙启用时保存轮胎印记。 */
  addTrack(segment) {
    if (!this.tracksEnabled) return;
    const record = this.store.addTrack(segment);
    this.stats.trackCount = this.store.byKind.tire.size;
    return record;
  }

  /**
   * 在月表高度图写入采样坑形变（与脚印同一套图集）。
   * seed 旋转长槽朝向，使三处痕迹不完全雷同。
   */
  addDig(site, seed = 0) {
    const yaw = seed * 1.7 + 0.35;
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const halfLength = 0.72;
    const halfWidth = 0.34;
    const record = this.store.addDig({
      x: site.x,
      y: site.y,
      z: site.z,
      ax: cos * halfLength,
      az: sin * halfLength,
      bx: -sin * halfWidth,
      bz: cos * halfWidth,
      normal: { x: -(site.slopeX ?? 0), y: 1, z: -(site.slopeZ ?? 0) },
    });
    this.stats.digCount = this.store.byKind.dig.size;
    // 采样坑关闭脚印开关时仍需点亮图集采样。
    if (this.uniforms.uFootprintEnabled.value < 1) this.refreshVisibility();
    else for (const slot of this.slots) {
      slot.dirty = true;
      slot.patches.length = 0;
    }
    return record;
  }

  /** 显示状态变化后使驻留地块重新生成。 */
  refreshVisibility() {
    this.uniforms.uFootprintEnabled.value =
      this.enabled || this.tracksEnabled || this.store.byKind.dig.size > 0 ? 1 : 0;
    for (const slot of this.slots) {
      slot.dirty = true;
      slot.patches.length = 0;
    }
  }
  /** 切换鞋印显示与生成，并刷新图集。 */
  setEnabled(value) {
    if (this.enabled !== value) {
      this.enabled = value;
      this.refreshVisibility();
    }
  }
  /** 独立切换轮胎印记显示与生成。 */
  setTracksEnabled(value) {
    if (this.tracksEnabled !== value) {
      this.tracksEnabled = value;
      this.refreshVisibility();
    }
  }
  /** 更新胎纹强度并重建受影响图集。 */
  setTrackStrength(value) {
    if (this.stampMesh.material.uniforms.trackStrength.value === value) return;
    this.stampMesh.material.uniforms.trackStrength.value = value;
    for (const slot of this.slots) slot.dirty = true;
  }
  /** 切换最新接触位置的调试标记。 */
  setDebug(value) {
    this.debug = value;
    if (!value) for (const marker of this.markers) marker.visible = false;
  }
  /** 清理指定类型历史和最新接触标记。 */
  clear(kind) {
    this.store.clear(kind);
    for (const slot of this.slots) {
      slot.dirty = true;
      slot.patches.length = 0;
    }
    if (kind !== 'tire') {
      this.lastRecords = { left: null, right: null };
      for (const marker of this.markers) marker.visible = false;
    }
    this.stats.count = this.store.byKind.foot.size;
    this.stats.trackCount = this.store.byKind.tire.size;
    this.stats.digCount = this.store.byKind.dig.size;
  }

  /** 跟随角色维护循环图集，只重建新进入或发生变化的地块。 */
  update(worldX, worldZ, originX, originZ) {
    const start = performance.now(),
      renderer = this.renderer;
    const minX = Math.floor(worldX / TILE) - 1,
      minZ = Math.floor(worldZ / TILE) - 1;
    this.uniforms.uFootprintWindow.value.set(minX * TILE - originX, minZ * TILE - originZ);
    this.uniforms.uFootprintSlot.value.set(positiveMod(minX, GRID), positiveMod(minZ, GRID));
    const targetBefore = renderer.getRenderTarget(),
      face = renderer.getActiveCubeFace(),
      mip = renderer.getActiveMipmapLevel();
    const autoClear = renderer.autoClear,
      color = renderer.getClearColor(new THREE.Color()),
      alpha = renderer.getClearAlpha();
    let draws = 0,
      tiles = 0;
    /** 采样坑始终保留；鞋印 / 车辙跟随各自开关。 */
    const visible = (record) => (
      record.kind === 'dig' ? true : record.kind === 'tire' ? this.tracksEnabled : this.enabled
    );
    /** 判断印记是否与待重建的局部区域相交。 */
    const touches = (record, region) => {
      const bounds = this.recordBounds(record),
        pad = (2 * TILE) / this.resolution;
      return (
        bounds.minX <= region.maxX + pad &&
        bounds.maxX >= region.minX - pad &&
        bounds.minZ <= region.maxZ + pad &&
        bounds.maxZ >= region.minZ - pad
      );
    };
    this.slopeQueue.length = 0;
    try {
      renderer.autoClear = false;
      for (let z = minZ; z < minZ + GRID; z++)
        for (let x = minX; x < minX + GRID; x++) {
          const sx = positiveMod(x, GRID),
            sz = positiveMod(z, GRID),
            slot = this.slots[sz * GRID + sx],
            key = `${x},${z}`;
          if (slot.key !== key) {
            slot.key = key;
            slot.dirty = true;
            slot.lastId = 0;
            slot.patches.length = 0;
          }
          const records = this.store.tiles.get(key);
          if (records?.size) tiles++;
          if (!slot.dirty && !slot.patches.length && slot.lastId === this.store.serial) continue;
          this.bindHeightTile(sx, sz);
          if (slot.dirty) {
            renderer.setClearColor(0x000000, 1);
            renderer.clear(true, false, false);
            const stamps = records ? [...records].filter(visible) : [];
            if (stamps.length) {
              this.drawStamps(stamps, x, z);
              draws++;
            }
            this.queueSlope({ minX: x * TILE, maxX: (x + 1) * TILE, minZ: z * TILE, maxZ: (z + 1) * TILE });
          } else {
            const fresh = [];
            if (records)
              for (const record of records) if (visible(record) && record.id > slot.lastId) fresh.push(record);
            const redraw = [];
            if (slot.patches.length) {
              renderer.setClearColor(0x000000, 1);
              for (const region of slot.patches) {
                const pixels = this.tilePixels(region, x, z);
                if (!pixels) continue;
                this.target.scissor.set(
                  sx * this.resolution + pixels.x,
                  sz * this.resolution + pixels.y,
                  pixels.w,
                  pixels.h,
                );
                renderer.setRenderTarget(this.target);
                renderer.clear(true, false, false);
                this.queueSlope(region);
              }
              if (records)
                for (const record of records)
                  if (visible(record) && slot.patches.some((region) => touches(record, region))) redraw.push(record);
              this.bindHeightTile(sx, sz);
            }
            for (const record of fresh) if (!redraw.includes(record)) redraw.push(record);
            if (redraw.length) {
              this.drawStamps(redraw, x, z);
              draws++;
              for (const record of fresh) this.queueSlope(this.recordBounds(record));
            }
          }
          slot.dirty = false;
          slot.patches.length = 0;
          slot.lastId = this.store.serial;
        }
      this.flushSlopes(minX, minZ);
    } finally {
      renderer.setRenderTarget(targetBefore, face, mip);
      renderer.setClearColor(color, alpha);
      renderer.autoClear = autoClear;
    }
    for (const marker of this.markers) {
      const record = this.lastRecords[marker.userData.side];
      marker.visible = this.debug && Boolean(record && this.store.records.has(record.id));
      if (record && this.debug) {
        marker.position.set(record.x - originX, record.y + 0.003, record.z - originZ);
        marker.setDirection(new THREE.Vector3(record.normal.x, record.normal.y, record.normal.z));
      }
    }
    Object.assign(this.stats, { tiles, draws, bakeMs: performance.now() - start });
    this.stats.peakBakeMs = Math.max(this.stats.peakBakeMs, this.stats.bakeMs);
  }

  /** 释放图集、盖印网格和接触调试标记。 */
  dispose() {
    this.target.dispose();
    this.shaded.dispose();
    this.stampMesh.geometry.dispose();
    this.stampMesh.material.dispose();
    this.slopeMesh.geometry.dispose();
    this.slopeMesh.material.dispose();
    for (const marker of this.markers) {
      marker.removeFromParent();
      marker.dispose();
    }
  }
}
