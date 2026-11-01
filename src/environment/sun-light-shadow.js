import {
  Frustum,
  LightShadow,
  Matrix4,
  OrthographicCamera,
  ShaderChunk,
  Vector3,
  Vector4,
  WebGPUCoordinateSystem,
} from 'three';

const _lightOrientationMatrix = /*@__PURE__*/ new Matrix4();
const _viewToLightMatrix = /*@__PURE__*/ new Matrix4();
const _lightDirection = /*@__PURE__*/ new Vector3();
const _up = /*@__PURE__*/ new Vector3();
const _center = /*@__PURE__*/ new Vector3();
const _nearCorners = [new Vector3(), new Vector3(), new Vector3(), new Vector3()];
const _farCorners = [new Vector3(), new Vector3(), new Vector3(), new Vector3()];
const _cascadeCorners = [
  new Vector3(), new Vector3(), new Vector3(), new Vector3(),
  new Vector3(), new Vector3(), new Vector3(), new Vector3(),
];
const _cascadeFade = 0.1;

const MAX_CASCADES = 4;
let _shadowmapParsFragment = null;

/** 同步着色器中的 SUN_LIGHT_CASCADES，与阴影对象级联数一致。 */
export function syncSunCascadeShaderDefine(count) {
  if (!_shadowmapParsFragment) _shadowmapParsFragment = ShaderChunk.shadowmap_pars_fragment;
  ShaderChunk.shadowmap_pars_fragment = _shadowmapParsFragment.replace(
    /#define SUN_LIGHT_CASCADES \d+/,
    `#define SUN_LIGHT_CASCADES ${count}`,
  );
}

/** 强制场景材质按新的级联宏重新编译。 */
export function invalidateShadowMaterials(root) {
  root?.traverse((object) => {
    const materials = object.material
      ? Array.isArray(object.material) ? object.material : [object.material]
      : [];
    for (const material of materials) material.needsUpdate = true;
  });
}

/**
 * 可调整级联数量的太阳光阴影；行为对齐 three/addons SunLightShadow，
 * 但允许 1–4 级，并同步着色器宏。
 */
export class ConfigurableSunLightShadow extends LightShadow {
  constructor(cascadeCount = 2) {
    super(new OrthographicCamera(-5, 5, 5, -5, 0.5, 500));
    this.isSunLightShadow = true;
    this.mapSize.set(1024, 1024);
    this._cameras = [];
    this._matrices = [];
    this._frustums = [];
    this._cascadeData = [];
    this._cascadeSplits = [];
    this.setCascadeCount(cascadeCount);
  }

  get cascadeCount() {
    return this._viewportCount;
  }

  /** 调整级联数量，重建内部缓冲并更新着色器宏。 */
  setCascadeCount(count) {
    const next = Math.max(1, Math.min(MAX_CASCADES, Math.round(count)));
    while (this._cameras.length < next) {
      this._cameras.push(new OrthographicCamera());
      this._matrices.push(new Matrix4());
      this._frustums.push(new Frustum());
      this._cascadeData.push(new Vector4());
    }
    while (this._viewports.length < next) this._viewports.push(new Vector4());
    this._viewportCount = next;
    this._cascadeSplits = new Array(next + 1).fill(0);
    // 横向排布各级，与默认两级图集一致。
    this._frameExtents.set(next, 1);
    if (this.map) {
      this.map.dispose();
      this.map = null;
    }
    syncSunCascadeShaderDefine(next);
    return next;
  }

  getCamera(cascadeIndex = 0) {
    return this._cameras[cascadeIndex];
  }

  getMatrix(cascadeIndex = 0) {
    return this._matrices[cascadeIndex];
  }

  getFrustum(cascadeIndex = 0) {
    return this._frustums[cascadeIndex];
  }

  updateMatrices(light, viewCamera) {
    if (viewCamera === undefined) return;
    const cascadeCount = this._viewportCount;
    const insetX = Math.min(0.25, (Math.ceil(this.radius) + 1) / this.mapSize.x);
    const insetY = Math.min(0.25, (Math.ceil(this.radius) + 1) / this.mapSize.y);
    for (let i = 0; i < cascadeCount; i++) {
      this._viewports[i].set(i + insetX, insetY, 1 - 2 * insetX, 1 - 2 * insetY);
    }

    const resolutionX = this.mapSize.x * (1 - 2 * insetX);
    const resolutionY = this.mapSize.y * (1 - 2 * insetY);
    const resolution = Math.min(resolutionX, resolutionY);
    const camera = this.camera;
    const cameraNear = viewCamera.near;
    const cameraFar = Math.max(cameraNear + 1e-6, Math.min(camera.far, viewCamera.far));
    const splits = this._cascadeSplits;
    splits[0] = cameraNear;
    for (let i = 1; i < cascadeCount; i++) {
      const amount = i / cascadeCount;
      const uniform = cameraNear + (cameraFar - cameraNear) * amount;
      const logarithmic = cameraNear > 0 ? cameraNear * Math.pow(cameraFar / cameraNear, amount) : uniform;
      splits[i] = (uniform + logarithmic) * 0.5;
    }
    splits[cascadeCount] = cameraFar;

    _lightDirection.setFromMatrixPosition(light.matrixWorld).negate().normalize();
    _up.set(0, 1, 0);
    if (Math.abs(_up.dot(_lightDirection)) > 0.99) _up.set(0, 0, 1);
    _lightOrientationMatrix.lookAt(_center.set(0, 0, 0), _lightDirection, _up);
    _viewToLightMatrix.copy(_lightOrientationMatrix).transpose().multiply(viewCamera.matrixWorld);

    const zNear = viewCamera.reversedDepth ? 1 : (viewCamera.coordinateSystem === WebGPUCoordinateSystem ? 0 : -1);
    const inverseProjectionMatrix = viewCamera.projectionMatrixInverse;
    let globalMaxZ = -Infinity;
    for (let i = 0; i < 4; i++) {
      const x = i === 0 || i === 1 ? 1 : -1;
      const y = i === 0 || i === 3 ? 1 : -1;
      const nearCorner = _nearCorners[i].set(x, y, zNear).applyMatrix4(inverseProjectionMatrix);
      const farCorner = _farCorners[i];
      if (viewCamera.isPerspectiveCamera === true) farCorner.copy(nearCorner).multiplyScalar(cameraFar / cameraNear);
      else farCorner.set(nearCorner.x, nearCorner.y, -cameraFar);
      nearCorner.applyMatrix4(_viewToLightMatrix);
      farCorner.applyMatrix4(_viewToLightMatrix);
      globalMaxZ = Math.max(globalMaxZ, nearCorner.z, farCorner.z);
    }
    globalMaxZ += cameraFar;
    const shadowNear = camera.near;

    for (let i = 0; i < cascadeCount; i++) {
      const cascadeNear = i === 0 ? splits[0] : this._cascadeData[i - 1].z;
      const cascadeFar = splits[i + 1];
      const fadeStart = cascadeFar - _cascadeFade * (cascadeFar - splits[i]);
      this._cascadeData[i].set(i === 0 ? -1e10 : cascadeNear, cascadeFar, fadeStart, 0);
      const nearAlpha = (cascadeNear - cameraNear) / (cameraFar - cameraNear);
      const farAlpha = (cascadeFar - cameraNear) / (cameraFar - cameraNear);
      _center.set(0, 0, 0);
      for (let j = 0; j < 4; j++) {
        _cascadeCorners[j * 2].lerpVectors(_nearCorners[j], _farCorners[j], nearAlpha);
        _cascadeCorners[j * 2 + 1].lerpVectors(_nearCorners[j], _farCorners[j], farAlpha);
        _center.add(_cascadeCorners[j * 2]).add(_cascadeCorners[j * 2 + 1]);
      }
      _center.multiplyScalar(1 / 8);
      let radiusSq = 0;
      let minZ = Infinity;
      for (let j = 0; j < 8; j++) {
        radiusSq = Math.max(radiusSq, _cascadeCorners[j].distanceToSquared(_center));
        minZ = Math.min(minZ, _cascadeCorners[j].z);
      }
      let radius = Math.sqrt(radiusSq);
      if (resolution > 1) {
        radius /= 1 - 1 / resolution;
        const texelSizeX = 2 * radius / resolutionX;
        const texelSizeY = 2 * radius / resolutionY;
        _center.x = Math.round(_center.x / texelSizeX) * texelSizeX;
        _center.y = Math.round(_center.y / texelSizeY) * texelSizeY;
      }
      _center.z = globalMaxZ + shadowNear;
      _center.applyMatrix4(_lightOrientationMatrix);
      const cascadeCamera = this._cameras[i];
      cascadeCamera.position.copy(_center);
      cascadeCamera.quaternion.setFromRotationMatrix(_lightOrientationMatrix);
      cascadeCamera.left = -radius;
      cascadeCamera.right = radius;
      cascadeCamera.top = radius;
      cascadeCamera.bottom = -radius;
      cascadeCamera.near = shadowNear;
      cascadeCamera.far = globalMaxZ - minZ + 2 * shadowNear;
      cascadeCamera.coordinateSystem = camera.coordinateSystem;
      cascadeCamera._reversedDepth = camera.reversedDepth;
      cascadeCamera.updateProjectionMatrix();
      cascadeCamera.updateMatrixWorld();
      this._updateMatrix(cascadeCamera, this._matrices[i], this._frustums[i], this._viewports[i]);
    }
  }
}
