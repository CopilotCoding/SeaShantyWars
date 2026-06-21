import { Geometry, computeVertexNormals } from '../engine.js';

export { marchChunk } from './march.js';

// Wraps marchChunk()'s typed arrays into an engine Geometry. Main-thread only —
// Web Workers use marchChunk() directly from march.js and send the raw typed
// arrays back for the main thread to wrap.
//
// The terrain shader (terrain/terrainShader.js) reads attributes in the order
// position, normal, color, skyAccess. Normals are computed here from the
// non-indexed positions (matching the original computeVertexNormals()).
export function buildGeometry(device, meshData) {
  if (!meshData) return null;
  const normals = computeVertexNormals(meshData.positions);
  return new Geometry(device, {
    attributes: {
      position:  { format: 'float32x3', data: meshData.positions },
      normal:    { format: 'float32x3', data: normals },
      color:     { format: 'float32x3', data: meshData.colors },
      skyAccess: { format: 'float32',   data: meshData.skyAccess },
    },
  });
}
