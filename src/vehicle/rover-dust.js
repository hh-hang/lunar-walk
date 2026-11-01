import * as THREE from 'three';

// 固定容量循环粒子池仅在发射时上传属性；弹道由顶点着色器计算，无需逐粒子射线或深度通道。
export class LunarRoverDust {
  /** 创建固定容量的 GPU 弹道粒子池。 */
  constructor(scene, { capacity = 768, sunDirection = new THREE.Vector3(0, 1, 0), random = Math.random } = {}) {
    this.scene = scene;
    this.capacity = capacity;
    this.random = random;
    this.time = 0;
    this.cursor = 0;
    this.enabled = true;
    this.stats = { active: 0, emitted: 0, capacity, draws: 0 };
    const geometry = new THREE.BufferGeometry();
    for (const [name, size] of [
      ['position', 3],
      ['velocity', 3],
      ['birth', 1],
      ['duration', 1],
      ['radius', 1],
      ['seed', 1],
      ['groundNormal', 3],
    ])
      geometry.setAttribute(
        name,
        new THREE.BufferAttribute(new Float32Array(capacity * size), size).setUsage(THREE.DynamicDrawUsage),
      );
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthTest: true,
      depthWrite: false,
      toneMapped: true,
      uniforms: {
        time: { value: 0 },
        gravity: { value: 1.62 },
        pixelScale: { value: 500 },
        sunDirection: { value: sunDirection },
        dustColor: { value: new THREE.Color(0x98958e) },
      },
      vertexShader: `attribute vec3 velocity; attribute vec3 groundNormal;
        attribute float birth; attribute float duration; attribute float radius; attribute float seed;
        uniform float time; uniform float gravity; uniform float pixelScale; uniform vec3 sunDirection;
        varying float opacity; varying float grainSeed; varying float illumination;
        void main() {
          float age = time - birth;
          if (duration <= 0.0 || age < 0.0 || age >= duration) { gl_Position=vec4(2.,2.,2.,1.); gl_PointSize=0.; return; }
          float t=age/duration;
          vec3 displacement=velocity*age-vec3(0.,.5*gravity*age*age,0.);
          vec3 p=position+displacement;
          float height=.012+dot(displacement,groundNormal);
          vec4 mv=modelViewMatrix*vec4(p,1.);
          gl_Position=projectionMatrix*mv;
          float size=min(radius*(1.+t*.25),max(.008,height*.8+.012));
          gl_PointSize=clamp(size*2.*pixelScale/max(.05,-mv.z),1.,48.);
          opacity=smoothstep(0.,.08,t)*(1.-smoothstep(.55,1.,t))*smoothstep(0.,.035,height);
          opacity*=1.-smoothstep(24.,38.,length(mv.xyz));
          vec3 toCamera=normalize(cameraPosition-p);
          illumination=.55+.45*pow(max(0.,dot(toCamera,sunDirection)),4.);
          grainSeed=seed;
        }`,
      fragmentShader: `uniform vec3 dustColor; varying float opacity; varying float grainSeed; varying float illumination;
        float hash(vec2 p) { return fract(sin(dot(p,vec2(127.1,311.7))+grainSeed)*43758.5453); }
        void main() {
          vec2 p=gl_PointCoord*2.-1.; float r=dot(p,p);
          float grain=mix(.45,1.,hash(floor(gl_PointCoord*13.)));
          grain=mix(grain,.72,smoothstep(.5,1.5,fwidth(gl_PointCoord.x)*13.));
          float alpha=exp(-r*3.2)*(1.-smoothstep(.55,1.,r))*grain*opacity*.23;
          if(alpha<.004)discard;
          gl_FragColor=vec4(dustColor*illumination,alpha);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.points = new THREE.Points(geometry, material);
    this.points.name = 'Lunar rover ballistic dust';
    this.points.frustumCulled = false;
    this.points.visible = false;
    this.points.userData.excludeFromCollider = true;
    const viewport = new THREE.Vector4();
    this.points.onBeforeRender = (renderer, scene, camera) => {
      // 面罩的小立方体贴图视口也需使用正确的粒子尺寸。
      renderer.getCurrentViewport(viewport);
      // 立方体相机会翻转投影的 Y 轴，点精灵尺寸仍必须为正。
      material.uniforms.pixelScale.value = viewport.w * 0.5 * Math.abs(camera.projectionMatrix.elements[5]);
    };
    scene.add(this.points);
    this.velocity = new THREE.Vector3();
  }

  /** 在真实场景中预热主视角与面罩反射所需的扬尘着色器。 */
  async prepare(renderer, camera, reflectionTarget) {
    const scene = new THREE.Scene(),
      points = new THREE.Points(this.points.geometry, this.points.material);
    scene.add(points);
    const target = renderer.getRenderTarget(),
      face = renderer.getActiveCubeFace(),
      mip = renderer.getActiveMipmapLevel();
    try {
      await renderer.compileAsync(scene, camera, this.scene);
      if (reflectionTarget) {
        renderer.setRenderTarget(reflectionTarget, 0);
        await renderer.compileAsync(scene, camera, this.scene);
      }
    } finally {
      renderer.setRenderTarget(target, face, mip);
    }
  }

  /** 在循环槽中初始化尘粒的出生位置、速度和寿命。 */
  emit(point, normal, direction, side, chassisVelocity, speed, scale = 1) {
    if (!this.enabled) return;
    const random = this.random,
      i = this.cursor,
      a = this.points.geometry.attributes;
    this.cursor = (i + 1) % this.capacity;
    const lateral = (random() - 0.5) * 0.22 * scale;
    a.position.setXYZ(
      i,
      point.x + side.x * lateral + normal.x * 0.012,
      point.y + side.y * lateral + normal.y * 0.012,
      point.z + side.z * lateral + normal.z * 0.012,
    );
    this.velocity
      .copy(chassisVelocity)
      .multiplyScalar(0.3)
      .addScaledVector(direction, -speed * (0.25 + random() * 0.35))
      .addScaledVector(side, (random() - 0.5) * 0.5 * scale)
      .addScaledVector(normal, (0.22 + Math.min(3, speed) * 0.14 + random() * 0.36) * Math.sqrt(scale));
    const gravity = this.points.material.uniforms.gravity.value;
    const duration = THREE.MathUtils.clamp(
      (2 * Math.max(0.05, this.velocity.dot(normal))) / (gravity * Math.max(0.35, normal.y)),
      0.18,
      1.5,
    );
    a.velocity.setXYZ(i, this.velocity.x, this.velocity.y, this.velocity.z);
    a.birth.setX(i, this.time);
    a.duration.setX(i, duration);
    a.radius.setX(i, (0.045 + random() * 0.065) * scale);
    a.seed.setX(i, random() * 1000);
    a.groundNormal.setXYZ(i, normal.x, normal.y, normal.z);
    this.dirtyMin = Math.min(this.dirtyMin ?? i, i);
    this.dirtyMax = Math.max(this.dirtyMax ?? i, i);
    this.stats.emitted++;
    this.stats.active = Math.min(this.capacity, this.stats.active + 1);
  }

  /** 推进模拟时间并更新有效粒子计数，不逐粒子求解运动。 */
  update(delta) {
    this.time += Math.max(0, delta);
    this.points.material.uniforms.time.value = this.time;
    if (this.dirtyMin !== undefined) {
      for (const attribute of Object.values(this.points.geometry.attributes)) {
        attribute.clearUpdateRanges();
        attribute.addUpdateRange(
          this.dirtyMin * attribute.itemSize,
          (this.dirtyMax - this.dirtyMin + 1) * attribute.itemSize,
        );
        attribute.needsUpdate = true;
      }
      this.dirtyMin = this.dirtyMax = undefined;
    }
    if (this.stats.active) {
      const a = this.points.geometry.attributes;
      let active = 0;
      for (let i = 0; i < this.capacity; i++)
        if (a.duration.getX(i) > 0 && this.time - a.birth.getX(i) < a.duration.getX(i)) active++;
      this.stats.active = active;
    }
    this.points.visible = this.enabled && this.stats.active > 0;
    this.stats.draws = this.points.visible ? 1 : 0;
  }

  /** 切换扬尘，关闭时立即清空现存粒子。 */
  setEnabled(value) {
    this.enabled = value;
    if (!value) this.clear();
  }
  /** 重置粒子寿命与可见状态。 */
  clear() {
    const duration = this.points.geometry.attributes.duration;
    duration.array.fill(0);
    duration.clearUpdateRanges();
    duration.needsUpdate = true;
    this.stats.active = 0;
    this.stats.draws = 0;
    this.points.visible = false;
  }
  /** 平移现存尘粒，保持换原点前后的世界位置一致。 */
  rebase(x, z) {
    const a = this.points.geometry.attributes.position;
    for (let i = 0; i < this.capacity; i++) {
      a.array[i * 3] -= x;
      a.array[i * 3 + 2] -= z;
    }
    a.clearUpdateRanges();
    a.needsUpdate = true;
  }
  /** 从场景移除扬尘并释放几何与材质。 */
  dispose() {
    this.points.removeFromParent();
    this.points.geometry.dispose();
    this.points.material.dispose();
  }
}
