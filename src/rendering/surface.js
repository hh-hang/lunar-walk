import * as THREE from 'three';
import { makeRegolithTextures } from '../terrain/regolith.js';
import { addGravelLodShader } from '../terrain/gravel.js';
import { addRockLodShader } from '../terrain/rocks.js';

export const LUNAR_PALETTE = Object.freeze({
  soil: 0x9e9ea4,
  rock: 0x737377,
  gravel: 0xa6a6aa,
  sunlight: 0xffffff,
  skyFill: 0x9a9a9d,
  groundFill: 0x646466,
});

const surfaceFunctions =  `
  varying vec3 vMoonWorld;
  uniform vec2 uMoonOrigin;
  float soilHash(vec2 p) {
    vec3 q = fract(vec3(p.xyx) * vec3(0.0973, 0.1137, 0.1379));
    q += dot(q, q.yzx + 17.17);
    return fract((q.x + q.z) * q.y);
  }
  float soilNoise(vec2 p) {
    vec2 cell = floor(p), t = fract(p);
    t = t * t * (3.0 - 2.0 * t);
    return mix(mix(soilHash(cell), soilHash(cell + vec2(1, 0)), t.x),
      mix(soilHash(cell + vec2(0, 1)), soilHash(cell + vec2(1, 1)), t.x), t.y);
  }
`;

/** 向月壤或石块材质注入稳定世界坐标纹理与颗粒光照。 */
function configureSurface(material, origin, kind) {
  const previousCompile = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previousCompile.call(material, shader, renderer);
    shader.uniforms.uMoonOrigin = origin;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      '#include <common>\nvarying vec3 vMoonWorld;',
    );
    shader.vertexShader = shader.vertexShader.replace(
      '#include <project_vertex>',
       `
      #include <project_vertex>
      vec4 moonWorldPosition = vec4(transformed, 1.0);
      #ifdef USE_INSTANCING
        moonWorldPosition = instanceMatrix * moonWorldPosition;
      #endif
      vMoonWorld = (modelMatrix * moonWorldPosition).xyz;
    `,
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      `#include <common>\n${surfaceFunctions}`,
    );

    if (kind === 'soil') {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
         `
        #include <color_fragment>
        vec2 soilPosition = vMoonWorld.xz + uMoonOrigin;
        float terrainPatch = soilNoise(soilPosition * 0.016) * 0.65 + soilNoise(soilPosition * 0.071) * 0.35;
        diffuseColor.rgb *= mix(0.78, 1.10, terrainPatch);
        float grainFootprint = max(length(dFdx(soilPosition)), length(dFdy(soilPosition)));
        float grainVisibility = 1.0 - smoothstep(0.008, 0.025, grainFootprint);
        float fineGrain = soilHash(floor(soilPosition * 170.0));
        diffuseColor.rgb *= 1.0 + (fineGrain - 0.5) * 0.20 * grainVisibility;
        diffuseColor.rgb *= mix(1.0, 0.82, smoothstep(650.0, 4300.0, distance(cameraPosition, vMoonWorld)));
      `,
      );
      const diffuse =
        'reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );';
      if (!THREE.ShaderChunk.lights_physical_pars_fragment.includes(diffuse))
        throw new Error('地表光照着色器钩子已变化。');
      const physical = THREE.ShaderChunk.lights_physical_pars_fragment.replace(
        diffuse,
         `
        float soilIncidence = saturate(dot(geometryNormal, directLight.direction));
        float soilEmergence = saturate(dot(geometryNormal, geometryViewDir));
        float powderScatter = 0.46 + 0.54 / max(0.32, soilIncidence + soilEmergence);
        float backscatter = pow(saturate(dot(directLight.direction, geometryViewDir)), 14.0);
        reflectedLight.directDiffuse += irradiance * BRDF_Lambert(material.diffuseContribution)
          * (1.0 - F) * powderScatter * (1.0 + backscatter * 0.19);
      `,
      );
      shader.fragmentShader = shader.fragmentShader.replace('#include <lights_physical_pars_fragment>', physical);
    } else if (kind === 'rock' || kind === 'gravel') {
      const isGravel = kind === 'gravel';
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
         `
        #include <color_fragment>
        vec3 rockPosition = vMoonWorld + vec3(uMoonOrigin.x, 0.0, uMoonOrigin.y);
        float mineral = soilNoise(rockPosition.xz * ${isGravel ? '85.0' : '9.0'} + rockPosition.y * ${isGravel ? '31.0' : '3.0'});
        float fracture = soilNoise(rockPosition.xy * ${isGravel ? '24.0' : '3.1'} + rockPosition.z * ${isGravel ? '19.0' : '2.0'});
        float rockFootprint = max(length(dFdx(rockPosition)), length(dFdy(rockPosition)));
        mineral = mix(0.5, mineral, 1.0 - smoothstep(0.5, 1.5, rockFootprint * ${isGravel ? '85.0' : '9.0'}));
        fracture = mix(0.5, fracture, 1.0 - smoothstep(0.5, 1.5, rockFootprint * ${isGravel ? '24.0' : '3.1'}));
        diffuseColor.rgb *= 0.71 + mineral * 0.39 + fracture * 0.22;
      `,
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <normal_fragment_maps>',
         `
        #include <normal_fragment_maps>
        vec3 rockNormal = transformDirectionByInverseViewMatrix(normal, viewMatrix);
        vec3 rockWorld = vMoonWorld + vec3(uMoonOrigin.x, 0.0, uMoonOrigin.y);
        float chipFrequency = ${isGravel ? '180.0' : '18.0'};
        // 混合三个投影方向，让竖直断裂面也具有颗粒细节。
        vec3 weights = abs(rockNormal);
        weights /= max(dot(weights, vec3(1.0)), 0.0001);
        vec3 sampleAt = rockWorld * chipFrequency;
        float chip = dot(vec3(soilNoise(sampleAt.yz), soilNoise(sampleAt.xz), soilNoise(sampleAt.xy)), weights);
        vec3 chipSlope;
        chipSlope.x = chip - dot(vec3(soilNoise(sampleAt.yz), soilNoise(sampleAt.xz + vec2(0.25, 0.0)), soilNoise(sampleAt.xy + vec2(0.25, 0.0))), weights);
        chipSlope.y = chip - dot(vec3(soilNoise(sampleAt.yz + vec2(0.25, 0.0)), soilNoise(sampleAt.xz), soilNoise(sampleAt.xy + vec2(0.0, 0.25))), weights);
        chipSlope.z = chip - dot(vec3(soilNoise(sampleAt.yz + vec2(0.0, 0.25)), soilNoise(sampleAt.xz + vec2(0.0, 0.25)), soilNoise(sampleAt.xy)), weights);
        chipSlope -= rockNormal * dot(rockNormal, chipSlope);
        float chipFade = 1.0 - smoothstep(12.0, 75.0, length(vViewPosition));
        float chipFootprint = max(length(dFdx(rockWorld)), length(dFdy(rockWorld))) * chipFrequency;
        chipFade *= 1.0 - smoothstep(0.5, 1.5, chipFootprint);
        normal = normalize(mat3(viewMatrix) * normalize(rockNormal + chipSlope * 0.4 * chipFade));
      `,
      );
    }
  };
  material.customProgramCacheKey = () => `moon-surface-${kind}`;
  material.needsUpdate = true;
  return material;
}

/** 创建月壤、岩石和碎石各细节等级的共享材质。 */
export function makeLunarMaterials(
  origin = { value: new THREE.Vector2() },
  gravelFocus = { value: new THREE.Vector2() },
) {
  const textures = makeRegolithTextures();
  const ground = configureSurface(
    new THREE.MeshStandardMaterial({
      color: LUNAR_PALETTE.soil,
      map: textures.albedo,
      normalMap: textures.normal,
      normalScale: new THREE.Vector2(0.75, 0.75),
      roughness: 1,
      metalness: 0,
    }),
    origin,
    'soil',
  );
  const rockMaterials = [0, 1, 2].map((level) =>
    addRockLodShader(
      configureSurface(
        new THREE.MeshStandardMaterial({
          color: LUNAR_PALETTE.rock,
          roughness: 0.98,
          metalness: 0,
        }),
        origin,
        'rock',
      ),
      gravelFocus,
      level,
    ),
  );
  const gravelMaterials = [0, 1, 2].map((level) =>
    addGravelLodShader(
      configureSurface(
        new THREE.MeshStandardMaterial({
          color: LUNAR_PALETTE.gravel,
          roughness: 0.98,
          metalness: 0,
        }),
        origin,
        'gravel',
      ),
      gravelFocus,
      level,
    ),
  );
  return {
    ground,
    rock: rockMaterials[0],
    rockMid: rockMaterials[1],
    rockFar: rockMaterials[2],
    gravel: gravelMaterials[0],
    gravelMid: gravelMaterials[1],
    gravelFar: gravelMaterials[2],
  };
}

/** 启用宇航员阴影并修正双面材质的投影面。 */
export function prepareAstronaut(model) {
  const preparedMaterials = new Set();
  model.traverse((object) => {
    if (!object.isMesh) return;
    object.castShadow = object.receiveShadow = true;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (preparedMaterials.has(material)) continue;
      preparedMaterials.add(material);
      // 双面宇航服使用背面投影，避免低入射角下正面投到自身阴影而产生密集条纹。
      if (material.side === THREE.DoubleSide && material.shadowSide === null) {
        material.shadowSide = THREE.BackSide;
      }
    }
  });
}
