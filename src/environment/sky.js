import * as THREE from 'three';
import skySnapshot from './sky-snapshot.json' with { type: 'json' };

const EARTH_DISPLAY_DISTANCE = 6021.835268421081,
  SUN_DISPLAY_DISTANCE = 10000;
const EARTH_ANGULAR_RADIUS = THREE.MathUtils.degToRad(skySnapshot.bodies.earth.angularDiameterDegrees / 2);
const SUN_ANGULAR_RADIUS = THREE.MathUtils.degToRad(skySnapshot.bodies.sun.angularDiameterDegrees / 2);

/** 创建程序地球表面、云层和太阳照明材质。 */
function earthMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { sun: { value: new THREE.Vector3() } },
    vertexShader: `varying vec3 direction; varying vec3 lightNormal; void main(){direction=normalize(position);lightNormal=normalize(mat3(modelMatrix)*normal);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
    fragmentShader: `varying vec3 direction; varying vec3 lightNormal; uniform vec3 sun;
      float hash(vec3 p){p=fract(p*0.137);p+=dot(p,p.yzx+19.7);return fract((p.x+p.y)*p.z);}
      float field(vec3 p){vec3 c=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);return mix(mix(mix(hash(c),hash(c+vec3(1,0,0)),f.x),mix(hash(c+vec3(0,1,0)),hash(c+vec3(1,1,0)),f.x),f.y),mix(mix(hash(c+vec3(0,0,1)),hash(c+vec3(1,0,1)),f.x),mix(hash(c+vec3(0,1,1)),hash(c+vec3(1,1,1)),f.x),f.y),f.z);}
      void main(){vec3 d=normalize(direction);float continents=field(d*4.8)+field(d*11.0)*0.35;vec3 color=mix(vec3(0.018,0.12,0.25),vec3(0.18,0.22,0.12),smoothstep(0.61,0.73,continents));float clouds=smoothstep(0.53,0.72,field(d*20.0+2.0));color=mix(color,vec3(0.79,0.83,0.87),clouds*0.78);color=mix(color,vec3(0.8),smoothstep(0.87,0.98,abs(d.y)));color*=0.012+max(dot(normalize(lightNormal),sun),0.0);gl_FragColor=vec4(color,1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      }`,
  });
}

/** 创建真实角尺寸太阳圆盘及柔和的光学光晕。 */
function sunVisual() {
  const group = new THREE.Group();
  group.name = 'Sun';
  const disk = new THREE.Mesh(
    new THREE.CircleGeometry(1, 64),
    new THREE.MeshBasicMaterial({ color: 0xfffdf5, toneMapped: false, depthWrite: false }),
  );
  disk.name = 'Solar photosphere';
  group.add(disk);
  // 模拟相机或面罩观察过曝太阳时的光晕，白色内核向外柔和衰减，避免硬边圆环。
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 512;
  const context = canvas.getContext('2d'),
    glow = context.createRadialGradient(256, 256, 0, 256, 256, 256);
  for (const [radius, color] of [
    [0, 'rgba(255,255,253,1)'],
    [0.045, 'rgba(255,255,253,0.98)'],
    [0.07, 'rgba(255,254,250,0.85)'],
    [0.11, 'rgba(255,253,247,0.48)'],
    [0.18, 'rgba(255,251,242,0.18)'],
    [0.3, 'rgba(255,249,238,0.065)'],
    [0.5, 'rgba(255,248,236,0.018)'],
    [0.75, 'rgba(255,250,240,0.004)'],
    [1, 'rgba(255,250,240,0)'],
  ])
    glow.addColorStop(radius, color);
  context.fillStyle = glow;
  context.fillRect(0, 0, 512, 512);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.name = 'Solar optical glare';
  const halo = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: true,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  halo.name = 'Solar lens halo';
  group.add(halo);
  return { group, disk, halo };
}

export class LunarSky {
  /** 依据固定天文快照创建太阳、地球并关联星空。 */
  constructor(scene, sunlight, stars) {
    this.stars = stars;
    this.sunDirection = sunlight.position.clone().normalize();
    // 固定观测点的 JPL 天体方向：+X 向东，+Y 向上，-Z 向北。
    this.earthDirection = new THREE.Vector3().fromArray(skySnapshot.bodies.earth.direction).normalize();
    this.group = new THREE.Group();
    this.group.name = 'Lunar sky';
    scene.add(this.group);
    this.group.userData = { utc: skySnapshot.utc, site: { ...skySnapshot.site }, source: skySnapshot.source };
    this.earth = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 40), earthMaterial());
    this.earth.name = 'Earth';
    this.group.add(this.earth);
    this.earth.scale.setScalar(EARTH_DISPLAY_DISTANCE * Math.sin(EARTH_ANGULAR_RADIUS));
    this.earth.quaternion.set(-0.1676214886809654, 0.8050547015949417, -0.5685965801385737, 0.022088300681012384);
    this.earth.material.uniforms.sun.value.fromArray(skySnapshot.bodies.earth.sunDirection);
    const sun = sunVisual();
    this.sunVisual = sun.group;
    this.sunDisk = sun.disk;
    this.sunHalo = sun.halo;
    this.group.add(this.sunVisual);
    const radius = SUN_DISPLAY_DISTANCE * Math.tan(SUN_ANGULAR_RADIUS);
    // 光晕可大于光源，太阳圆盘仍保持 JPL 快照中的真实视直径。
    this.sunDisk.scale.setScalar(radius);
    this.sunHalo.scale.setScalar(radius * 32);
  }
  /** 随相机位置更新远景天体，保持其天空方向和视大小。 */
  update(camera) {
    // 随相机平移远景天体与星空，保持天空方向稳定，也适用于浮动原点切换。
    this.earth.position.copy(camera.position).addScaledVector(this.earthDirection, EARTH_DISPLAY_DISTANCE);
    this.sunVisual.position.copy(camera.position).addScaledVector(this.sunDirection, SUN_DISPLAY_DISTANCE);
    this.sunDisk.quaternion.copy(camera.quaternion);
    this.stars.position.copy(camera.position);
  }
  /** 释放太阳、地球及光晕纹理。 */
  dispose() {
    this.group.removeFromParent();
    this.earth.geometry.dispose();
    this.earth.material.dispose();
    this.sunDisk.geometry.dispose();
    this.sunDisk.material.dispose();
    this.sunHalo.material.map.dispose();
    this.sunHalo.material.dispose();
  }
}
