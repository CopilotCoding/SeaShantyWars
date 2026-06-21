import { Mesh, ShaderMaterial, Vec3 } from './engine.js';
import { PLANET_RADIUS, SEA_LEVEL, TERRAIN_AMPLITUDE, CHUNK_SIZE, ISO_LEVEL } from './constants.js';
import { createNoiseSet, density as densityField, getMaterial as materialField, getBiome as biomeField } from './terrain/density.js';
import { marchChunk, buildGeometry } from './terrain/mesher.js';
import { terrainWGSL, packTerrainUniforms, TERRAIN_UNIFORM_SIZE } from './terrain/terrainShader.js';
import { mine, mineFast, raise, lower, flatten } from './terrain/editor.js';
import { ChunkWorkerPool } from './terrain/workerPool.js';

// Marching cubes lookup tables are loaded globally as edgeTable / triTable
// via the CDN fetch in main.js before this module runs.

function chunkKey(cx, cy, cz) { return `${cx},${cy},${cz}`; }

export class Planet {
  constructor(scene, seed) {
    this.scene = scene;
    this.seed = seed;
    this.noiseSet = createNoiseSet(seed);
    this.chunks = new Map();
    this.meshes = new Map();
    this.dirtyChunks = new Set();
    // Sparse map of mined voxel overrides: "x,y,z" -> delta subtracted
    this._mineOverrides = new Map();
    // Sparse map of voxels whose override represents a constant-radius shell
    // (set by raise/lower/flatten): "x,y,z" -> targetR. Lets density() return
    // a smooth sphere-shell function of the *continuous* query radius for
    // these voxels, instead of a flat per-voxel delta — see density().
    this._shellTargetR = new Map();
    // Worker pool for off-main-thread chunk generation/meshing — used for
    // the initial planet build and for remeshing chunks after edits, so
    // neither the loading screen nor gameplay ever blocks on this work.
    this.workerPool = new ChunkWorkerPool(seed);
    // Chunks currently in-flight to a worker, so they aren't requested twice.
    this._meshingInFlight = new Set();
    // Terrain material: the game's custom WGSL shader (terrain/terrainShader.js)
    // run through the engine's generic ShaderMaterial. The .uniforms object
    // keeps the { value } shape the main loop mutates each frame; updateUniforms
    // packs it into the GPU buffer.
    const uniforms = {
      sunPosition:      { value: new Vec3() },
      sunIntensity:     { value: 1.2 },
      lanternPosition:  { value: new Vec3() },
      lanternIntensity: { value: 0.0 },
      lanternRange:     { value: 1.0 },
      ambientIntensity: { value: 0.03 },
      fog:              { value: null }, // { color:{r,g,b}, near, far }, set from scene fog
    };
    this.material = new ShaderMaterial({
      wgsl: terrainWGSL,
      attributes: ['position', 'normal', 'color', 'skyAccess'],
      uniformSize: TERRAIN_UNIFORM_SIZE,
      updateUniforms: (view) => packTerrainUniforms(view, uniforms),
      side: 'front',
      merge: true, // all chunks share one geometry stream → one draw call
      receiveShadow: true, // terrain samples the sun shadow map (group 2)
      castShadow: true,    // terrain casts into the sun shadow map
    });
    this.material.uniforms = uniforms;
    this._buildInitialChunks();
  }

  // Bundles the override maps into the shape terrain/density.js and
  // terrain/editor.js expect.
  get _overrides() {
    return { mineOverrides: this._mineOverrides, shellTargetR: this._shellTargetR };
  }

  // Plain-object snapshot of the override maps for postMessage to workers
  // (Maps clone fine via structured clone, but plain objects are smaller
  // and avoid relying on that across older browser versions).
  //
  // If cx/cy/cz are given, only entries whose voxel falls within that
  // chunk's density grid (+1 voxel margin, since marchChunk samples a
  // (CHUNK_SIZE+1)^3 grid and edits can spill into a neighbouring chunk's
  // grid at shared boundary voxels) are included. Sending the FULL global
  // override maps on every remesh request was the bottleneck: with many
  // extractors continuously mining, these maps grow to cover the whole
  // planet, and postMessage has to structured-clone that entire blob for
  // every dirty chunk — that's the multi-second visual remesh lag (the
  // collider updates instantly because mineFast patches this.chunks
  // in-place on the main thread, no postMessage involved).
  _overridesPlain(cx = null, cy = null, cz = null) {
    if (cx === null) {
      return {
        mineOverrides: Object.fromEntries(this._mineOverrides),
        shellTargetR: Object.fromEntries(this._shellTargetR),
      };
    }
    const lo0 = -1;
    const hi = CHUNK_SIZE + 1;
    const minX = cx * CHUNK_SIZE + lo0, maxX = cx * CHUNK_SIZE + hi;
    const minY = cy * CHUNK_SIZE + lo0, maxY = cy * CHUNK_SIZE + hi;
    const minZ = cz * CHUNK_SIZE + lo0, maxZ = cz * CHUNK_SIZE + hi;
    const inRange = (key) => {
      const [vx, vy, vz] = key.split(',').map(Number);
      return vx >= minX && vx <= maxX && vy >= minY && vy <= maxY && vz >= minZ && vz <= maxZ;
    };
    const mineOverrides = {};
    for (const [key, val] of this._mineOverrides) if (inRange(key)) mineOverrides[key] = val;
    const shellTargetR = {};
    for (const [key, val] of this._shellTargetR) if (inRange(key)) shellTargetR[key] = val;
    return { mineOverrides, shellTargetR };
  }

  // Scalar field: positive inside planet, negative outside
  density(x, y, z) {
    return densityField(this.noiseSet, this._overrides, x, y, z);
  }

  // Material at a given world position
  getMaterial(x, y, z) {
    return materialField(this.noiseSet, x, y, z);
  }

  getBiome(nx, ny, nz) {
    return biomeField(this.noiseSet, nx, ny, nz);
  }

  worldToChunk(x, y, z) {
    return [Math.floor(x / CHUNK_SIZE), Math.floor(y / CHUNK_SIZE), Math.floor(z / CHUNK_SIZE)];
  }

  getChunkData(cx, cy, cz) {
    const key = chunkKey(cx, cy, cz);
    if (this.chunks.has(key)) return this.chunks.get(key);
    const data = this._generateChunk(cx, cy, cz);
    this.chunks.set(key, data);
    return data;
  }

  _generateChunk(cx, cy, cz) {
    const n = CHUNK_SIZE + 1;
    const densities = new Float32Array(n * n * n);
    const materials = new Uint8Array(n * n * n);
    for (let lz = 0; lz < n; lz++) {
      for (let ly = 0; ly < n; ly++) {
        for (let lx = 0; lx < n; lx++) {
          const wx = cx * CHUNK_SIZE + lx;
          const wy = cy * CHUNK_SIZE + ly;
          const wz = cz * CHUNK_SIZE + lz;
          const idx = lz * n * n + ly * n + lx;
          densities[idx] = this.density(wx, wy, wz);
          materials[idx] = this.getMaterial(wx, wy, wz).id;
        }
      }
    }
    return { densities, materials, cx, cy, cz };
  }

  _buildInitialChunks() {
    // Mesh a spherical SHELL of chunks covering the full terrain extent: from
    // the deepest seafloor up to the tallest island peak. The ocean world's
    // islands rise well above SEA_LEVEL, so the old PLANET_RADIUS+2-chunk cap
    // left tall island tops un-meshed (invisible patches). MAX_TERRAIN_R is the
    // highest any surface can reach (SEA_LEVEL + full land rise) plus a chunk of
    // margin; MIN_TERRAIN_R is below the deepest seafloor.
    // Highest any surface reaches = SEA_LEVEL + full land rise; lowest = deepest
    // seafloor. Only mesh chunks whose cell can straddle that thin surface band
    // (plus a chunk of margin each side for the marching grid). A chunk's center
    // is within a half-diagonal (~CHUNK_SIZE) of any voxel it owns.
    const MAX_TERRAIN_R = SEA_LEVEL + (SEA_LEVEL - PLANET_RADIUS) + 8 + TERRAIN_AMPLITUDE; // ~270
    const MIN_TERRAIN_R = PLANET_RADIUS - 22;  // just below the deepest seafloor (~201)
    const MARGIN = CHUNK_SIZE * 0.5; // tight guard so no surface cell is missed
    const r = Math.ceil((MAX_TERRAIN_R + MARGIN) / CHUNK_SIZE) + 1;
    const build = [];
    for (let cx = -r; cx <= r; cx++)
    for (let cy = -r; cy <= r; cy++)
    for (let cz = -r; cz <= r; cz++) {
      const wx = cx * CHUNK_SIZE + CHUNK_SIZE/2;
      const wy = cy * CHUNK_SIZE + CHUNK_SIZE/2;
      const wz = cz * CHUNK_SIZE + CHUNK_SIZE/2;
      const dist = Math.sqrt(wx*wx + wy*wy + wz*wz);
      if (dist > MIN_TERRAIN_R - MARGIN && dist < MAX_TERRAIN_R + MARGIN) {
        build.push([cx, cy, cz]);
      }
    }
    this._chunksToGenerate = build;
    this._genIndex = 0;
  }

  // Generates and meshes every initial chunk via the worker pool, applying
  // results to the scene as they arrive. Calls onProgress(fraction) as
  // chunks complete. Resolves once all initial chunks are in the scene.
  // Runs entirely off the main thread aside from applying finished meshes,
  // so the loading screen stays responsive throughout.
  async buildInitialChunksAsync(onProgress) {
    const list = this._chunksToGenerate;
    if (!list) { onProgress(1); return; }
    const total = list.length;
    let done = 0;
    const overridesObj = this._overridesPlain();

    await Promise.all(list.map(async ([cx, cy, cz]) => {
      const key = chunkKey(cx, cy, cz);
      const result = await this.workerPool.meshChunk(cx, cy, cz, overridesObj);
      this.chunks.set(key, { densities: result.densities, materials: result.materials, cx, cy, cz });
      this._applyMeshResult(key, result.meshData);
      done++;
      onProgress(done / total);
    }));

    this._chunksToGenerate = null;
  }

  // timeLimitMs: stop meshing after this many ms (prevents frame spikes during play).
  // Dispatches dirty chunks to the worker pool (capped to avoid flooding the
  // queue) and applies finished meshes to the scene as they resolve —
  // remeshing after edits never blocks the main thread.
  meshChunksDirty(timeLimitMs = 6) {
    if (this.dirtyChunks.size === 0) return;
    const t0 = performance.now();
    const maxInFlight = this.workerPool.size * 2;
    for (const key of this.dirtyChunks) {
      if (performance.now() - t0 > timeLimitMs) break;
      if (this._meshingInFlight.has(key)) continue;
      if (this._meshingInFlight.size >= maxInFlight) break;
      const [cx, cy, cz] = key.split(',').map(Number);
      this.dirtyChunks.delete(key);
      this._meshingInFlight.add(key);
      // Per-chunk filtered overrides — see _overridesPlain() comment. Sending
      // only the edits relevant to this chunk (instead of every edit on the
      // whole planet) is what fixes the visual remesh lag with many
      // extractors continuously mining.
      const overridesObj = this._overridesPlain(cx, cy, cz);
      this.workerPool.meshChunk(cx, cy, cz, overridesObj).then(result => {
        this._meshingInFlight.delete(key);
        // Keep the cached density/material arrays in sync so collision
        // queries and future edits see the same data the mesh was built
        // from (the chunk may have been edited again before this resolved —
        // applyVoxelOverride already patches individual voxels in-place, so
        // only refresh if we don't already have a (possibly newer) entry).
        if (!this.chunks.has(key)) {
          this.chunks.set(key, { densities: result.densities, materials: result.materials, cx, cy, cz });
        }
        this._applyMeshResult(key, result.meshData);
      });
    }
  }

  // Wraps a worker's meshData into a Geometry and swaps it into the scene.
  _applyMeshResult(key, meshData) {
    const geo = buildGeometry(this.scene.device, meshData);
    if (!geo) {
      const old = this.meshes.get(key);
      if (old) { this.scene.remove(old); old.geometry.destroy(); this.meshes.delete(key); }
      return;
    }
    const old = this.meshes.get(key);
    if (old) { this.scene.remove(old); old.geometry.destroy(); }
    const mesh = new Mesh(geo, this.material);
    this.scene.add(mesh);
    this.meshes.set(key, mesh);
  }

  // Synchronous main-thread remesh — used as a fallback (e.g. dispose/edge
  // cases) where waiting on a worker round-trip isn't appropriate.
  _remeshChunkSync(cx, cy, cz) {
    const key = chunkKey(cx, cy, cz);
    const chunk = this.getChunkData(cx, cy, cz);
    const meshData = marchChunk(this.noiseSet, this._overrides, chunk);
    this._applyMeshResult(key, meshData);
  }

  // ---- Terrain editing tools ----

  get _editCtx() {
    return {
      noiseSet: this.noiseSet,
      overrides: this._overrides,
      chunks: this.chunks,
      dirtyChunks: this.dirtyChunks,
    };
  }

  // Deform terrain — mine a sphere at world position
  mine(wx, wy, wz, radius, onCollect) {
    return mine(this._editCtx, wx, wy, wz, radius, onCollect);
  }

  // Optimized mine variant used only by automated Extractor buildings —
  // see terrain/editor.js mineFast() for details.
  mineFast(wx, wy, wz, radius, onCollect) {
    return mineFast(this._editCtx, wx, wy, wz, radius, onCollect);
  }

  // Raise terrain toward a constant-radius shell — see terrain/editor.js
  raise(wx, wy, wz, radius, onConsume, planeR = null) {
    return raise(this._editCtx, wx, wy, wz, radius, onConsume, planeR);
  }

  // Lower terrain toward a constant-radius shell — see terrain/editor.js
  lower(wx, wy, wz, radius, onCollect, planeR = null) {
    return lower(this._editCtx, wx, wy, wz, radius, onCollect, planeR);
  }

  // Level terrain toward a constant-radius shell — see terrain/editor.js
  flatten(wx, wy, wz, radius, onCollect, planeR = null) {
    return flatten(this._editCtx, wx, wy, wz, radius, onCollect, planeR);
  }

  // ---- Raycasting / queries ----

  // Raycast against planet surface — returns { point, normal, distance } or null
  raycast(origin, direction, maxDist = 200) {
    const step = 0.4;
    let prevD = this.density(origin.x, origin.y, origin.z) - ISO_LEVEL;
    for (let t = step; t < maxDist; t += step) {
      const px = origin.x + direction.x * t;
      const py = origin.y + direction.y * t;
      const pz = origin.z + direction.z * t;
      const d = this.density(px, py, pz) - ISO_LEVEL;
      if (prevD > 0 && d <= 0 || prevD <= 0 && d > 0) {
        // Binary search refinement
        let lo = t - step, hi = t;
        for (let i = 0; i < 8; i++) {
          const mid = (lo + hi) * 0.5;
          const mx = origin.x + direction.x * mid;
          const my = origin.y + direction.y * mid;
          const mz = origin.z + direction.z * mid;
          if (this.density(mx, my, mz) > ISO_LEVEL) lo = mid; else hi = mid;
        }
        const ft = (lo + hi) * 0.5;
        const point = new Vec3(
          origin.x + direction.x * ft,
          origin.y + direction.y * ft,
          origin.z + direction.z * ft
        );
        const eps = 0.1;
        const normal = new Vec3(
          this.density(point.x + eps, point.y, point.z) - this.density(point.x - eps, point.y, point.z),
          this.density(point.x, point.y + eps, point.z) - this.density(point.x, point.y - eps, point.z),
          this.density(point.x, point.y, point.z + eps) - this.density(point.x, point.y, point.z - eps)
        ).normalize();
        return { point, normal, distance: ft };
      }
      prevD = d;
    }
    return null;
  }

  surfaceNormal(pos) {
    const eps = 0.5;
    const n = new Vec3(
      this.density(pos.x+eps, pos.y, pos.z) - this.density(pos.x-eps, pos.y, pos.z),
      this.density(pos.x, pos.y+eps, pos.z) - this.density(pos.x, pos.y-eps, pos.z),
      this.density(pos.x, pos.y, pos.z+eps) - this.density(pos.x, pos.y, pos.z-eps)
    );
    if (n.lengthSq() < 0.0001) return pos.clone().normalize();
    return n.normalize();
  }

  // Find surface point above a world position (binary search along radius direction)
  findSurface(pos, searchUp = 10, searchDown = 30) {
    const dir = pos.clone().normalize();
    const r = pos.length();
    // Search outward from deep to surface
    let lo = r - searchDown, hi = r + searchUp;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) * 0.5;
      const p = dir.clone().multiplyScalar(mid);
      if (this.density(p.x, p.y, p.z) > ISO_LEVEL) lo = mid; else hi = mid;
    }
    return dir.clone().multiplyScalar((lo + hi) * 0.5);
  }

  // Surface (solid-terrain) radius along a unit direction — binary search the
  // density iso-crossing across the whole terrain band. Used to tell land from
  // open sea (and to place coves/ships).
  surfaceRadius(dir) {
    let lo = SEA_LEVEL - 40, hi = SEA_LEVEL + 60;
    // Ensure lo is inside solid and hi is outside; if not, just search the band.
    for (let i = 0; i < 26; i++) {
      const mid = (lo + hi) * 0.5;
      const p = dir.clone().multiplyScalar(mid);
      if (this.density(p.x, p.y, p.z) > ISO_LEVEL) lo = mid; else hi = mid;
    }
    return (lo + hi) * 0.5;
  }

  // True if the terrain at this direction rises above the waterline (an island).
  isLand(dir) {
    return this.surfaceRadius(dir.clone().normalize()) > SEA_LEVEL + 0.5;
  }

  // CHEAP shoal test for AI navigation: is the seafloor at/above `keelR` in this
  // direction? A single density sample at the keel radius — no binary search —
  // so the AI can probe a whole fan of headings every frame affordably. `dir`
  // need not be normalized. Returns true when the ship would ground here.
  shoalAt(dir, keelR) {
    const inv = 1 / Math.hypot(dir.x, dir.y, dir.z);
    const x = dir.x * inv * keelR, y = dir.y * inv * keelR, z = dir.z * inv * keelR;
    return this.density(x, y, z) > ISO_LEVEL;
  }

  isInsidePlanet(pos) {
    return this.density(pos.x, pos.y, pos.z) > 0;
  }

  getMaterialAt(x, y, z) {
    return this.getMaterial(x, y, z);
  }

  // Get chunk-aligned voxel density for building placement check
  isSolidNear(pos, radius = 1.5) {
    for (let dx = -radius; dx <= radius; dx += radius)
    for (let dy = -radius; dy <= radius; dy += radius)
    for (let dz = -radius; dz <= radius; dz += radius) {
      if (this.density(pos.x+dx, pos.y+dy, pos.z+dz) > ISO_LEVEL) return true;
    }
    return false;
  }

  dispose() {
    for (const [, mesh] of this.meshes) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
    }
    this.meshes.clear();
    this.workerPool.dispose();
  }
}
