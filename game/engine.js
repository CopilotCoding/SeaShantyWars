// Single re-export of the webgpu.js engine surface Sea Shanty Wars uses. Every
// game module imports renderer/scene/math types from here, so there's one place
// that names the engine dependency (and one relative path to get wrong, not a
// dozen). The engine lives in a sibling folder: ../webgpu.js relative to this
// game/ directory.

export { createDevice } from '../webgpu.js/src/device/Device.js';
export { SceneRenderer } from '../webgpu.js/src/scene/SceneRenderer.js';
export { Scene, Fog } from '../webgpu.js/src/scene/Scene.js';
export { Mesh, Group } from '../webgpu.js/src/scene/Mesh.js';
export { Node } from '../webgpu.js/src/scene/Node.js';
export { Color } from '../webgpu.js/src/scene/Color.js';
export { AmbientLight, PointLight, DirectionalLight } from '../webgpu.js/src/scene/lights.js';
export { LambertMaterial, BasicMaterial, PointsMaterial, ShaderMaterial } from '../webgpu.js/src/scene/materials.js';

export { PerspectiveCamera } from '../webgpu.js/src/camera/PerspectiveCamera.js';
export { OrthographicCamera } from '../webgpu.js/src/camera/OrthographicCamera.js';

export { Geometry } from '../webgpu.js/src/geometry/Geometry.js';
export {
  boxData, cylinderData, coneData, sphereData, octahedronData, dodecahedronData,
  tubeData, geometryFromData, computeVertexNormals,
} from '../webgpu.js/src/geometry/primitives.js';

export { Vec3 } from '../webgpu.js/src/math/vec3.js';
export { Quat, fromBasis as quatFromBasis } from '../webgpu.js/src/math/quat.js';
export * as mat4 from '../webgpu.js/src/math/mat4.js';
