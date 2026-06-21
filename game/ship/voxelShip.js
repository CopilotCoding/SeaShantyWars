import {
  Mesh, ShaderMaterial, Geometry, Group, Vec3, Quat, quatFromBasis, mat4,
} from '../engine.js';
import { SEA_LEVEL } from '../constants.js';
import { sampleOceanHeight } from '../ocean.js';
import { SHIP_SPECS } from './hull.js';
import { buildChestMesh, openChestMesh } from '../loot.js';

// FULLY-VOXEL ship. The ship is a 3D grid of cube voxels in SHIP-LOCAL space,
// transformed as a rigid body (position + quaternion). A cannonball carves a
// sphere of voxels out of the grid, leaving a real cubic HOLE you can see
// through and walk into; the grid re-meshes only when it changes (on damage),
// never per frame.
//
// Local frame: +X = starboard, +Y = up (origin at the waterline), +Z = bow.
// Voxel (i,j,k) center maps to local position via gridToLocal().

const VS = 0.6; // voxel size (world units per cell)
const GRAVITY_DEBRIS = 14; // fall accel for toppled mast debris

// Block material ids -> RGB (vertex colors). 0 = empty.
const BLOCK = {
  EMPTY: 0,
  WOOD: 1, WOOD_DARK: 2, WOOD_LIGHT: 3, DECK: 4, RAIL: 5, MAST: 6, TRIM: 7,
  CANNON: 8, SAIL: 9, SAIL2: 10, FLAG: 11, SKULL: 12,
};
// Base palette. Sail/flag colors are overridden per-ship at mesh time (see
// _rebuildMesh / the dynamic color map), so these are just defaults.
const BLOCK_RGB = {
  1: [0.42, 0.29, 0.17],  // wood
  2: [0.32, 0.22, 0.12],  // wood dark
  3: [0.54, 0.39, 0.22],  // wood light
  4: [0.61, 0.48, 0.29],  // deck
  5: [0.40, 0.27, 0.15],  // rail
  6: [0.30, 0.20, 0.11],  // mast
  7: [0.23, 0.16, 0.09],  // trim/dark
  8: [0.10, 0.10, 0.11],  // cannon (near-black iron)
  9: [0.90, 0.86, 0.74],  // sail (cloth) — overridden per ship
  10:[0.78, 0.74, 0.62],  // sail shade — overridden per ship
  11:[0.12, 0.12, 0.13],  // flag — overridden per ship
  12:[0.92, 0.90, 0.82],  // skull (pale)
};

function hexToRgb(hex) {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}

// ---- Voxel grid container ----
class VoxelGrid {
  constructor(nx, ny, nz) {
    this.nx = nx; this.ny = ny; this.nz = nz;
    this.data = new Uint8Array(nx * ny * nz);
  }
  idx(i, j, k) { return (k * this.ny + j) * this.nx + i; }
  inBounds(i, j, k) { return i >= 0 && i < this.nx && j >= 0 && j < this.ny && k >= 0 && k < this.nz; }
  get(i, j, k) { return this.inBounds(i, j, k) ? this.data[this.idx(i, j, k)] : 0; }
  set(i, j, k, v) { if (this.inBounds(i, j, k)) this.data[this.idx(i, j, k)] = v; }
  solid(i, j, k) { return this.get(i, j, k) !== 0; }
}

// Build the block layout for a ship spec into a VoxelGrid + the offsets needed
// to map grid cells <-> ship-local coordinates.
function buildVoxelLayout(spec) {
  const { length: L, beam: B, depth: D, deckY, mastH, masts } = spec;
  // Grid dims (+padding) covering keel (-D) up to mast tops.
  const nx = Math.ceil(B / VS) + 2;
  const topY = deckY + mastH + 1.0;
  const ny = Math.ceil((topY + D) / VS) + 2;
  const nz = Math.ceil(L / VS) + 2;
  const grid = new VoxelGrid(nx, ny, nz);

  // Grid->local mapping: center the grid on X and Z; Y origin (waterline) sits
  // at jWater so cell j maps to local y = (j - jWater) * VS.
  const iCenter = (nx - 1) / 2;
  const kCenter = (nz - 1) / 2;
  const jWater = Math.round(D / VS) + 1; // cells below this are underwater hull
  const g2l = (i, j, k) => new Vec3((i - iCenter) * VS, (j - jWater) * VS, (k - kCenter) * VS);
  const l2g = (x, y, z) => [
    Math.round(x / VS + iCenter),
    Math.round(y / VS + jWater),
    Math.round(z / VS + kCenter),
  ];

  const halfB = B / 2, halfL = L / 2;
  const deckJ = Math.round(deckY / VS) + jWater;
  const railTopJ = deckJ + Math.round(1.1 / VS);
  const keelJ = jWater - Math.round(D / VS);

  // ---- Hull: for each (i,k) column, fill a vertical run from keel up to deck if
  // this column is inside the boat's tapered footprint at that height. We build a
  // SHELL: only the outer ring of each level is solid (walls), plus a solid
  // bottom, so the interior is hollow (walkable below deck later).
  for (let j = keelJ; j <= deckJ; j++) {
    const y = (j - jWater) * VS;
    // Beam/length taper: narrow + pointy near the keel, full by the waterline.
    const f01 = Math.min(1, Math.max(0, (y + D) / (D + deckY)));
    const beamCurve = Math.pow(Math.min(1, f01 / 0.55), 0.8);
    const halfBx = (0.18 + 0.82 * beamCurve) * halfB;
    const halfLz = (0.62 + 0.38 * beamCurve) * halfL;
    for (let i = 0; i < nx; i++) {
      for (let k = 0; k < nz; k++) {
        const p = g2l(i, j, k);
        // Pointed bow/stern: shrink allowed beam toward the ends (elliptical).
        const zFrac = Math.abs(p.z) / Math.max(halfLz, 0.001);
        if (zFrac > 1) continue;
        const beamHere = halfBx * Math.sqrt(Math.max(0, 1 - zFrac * zFrac * 0.7));
        const inside = Math.abs(p.x) <= beamHere && Math.abs(p.z) <= halfLz;
        if (!inside) continue;
        // Shell: solid if near the outer edge of this level OR at the very bottom
        // (so the hull is a watertight bowl, hollow inside).
        const edge = (Math.abs(p.x) >= beamHere - VS * 1.1) ||
                     (Math.abs(p.z) >= halfLz - VS * 1.1) ||
                     (j <= keelJ + 1);
        if (edge) {
          const shade = (j + i) % 3;
          grid.set(i, j, k, shade === 0 ? BLOCK.WOOD_DARK : (shade === 1 ? BLOCK.WOOD : BLOCK.WOOD_LIGHT));
        }
      }
    }
  }

  // ---- Deck: a solid floor plane at deckJ across the hull footprint.
  {
    const j = deckJ;
    const y = (j - jWater) * VS;
    const f01 = Math.min(1, Math.max(0, (y + D) / (D + deckY)));
    const beamCurve = Math.pow(Math.min(1, f01 / 0.55), 0.8);
    const halfBx = (0.18 + 0.82 * beamCurve) * halfB;
    const halfLz = (0.62 + 0.38 * beamCurve) * halfL;
    for (let i = 0; i < nx; i++)
    for (let k = 0; k < nz; k++) {
      const p = g2l(i, j, k);
      const zFrac = Math.abs(p.z) / Math.max(halfLz, 0.001);
      if (zFrac > 1) continue;
      const beamHere = halfBx * Math.sqrt(Math.max(0, 1 - zFrac * zFrac * 0.7));
      if (Math.abs(p.x) <= beamHere - VS * 0.5 && Math.abs(p.z) <= halfLz - VS * 0.5) {
        grid.set(i, j, k, BLOCK.DECK);
      }
    }
  }

  // ---- Bulwarks: a 2-cell-high rail wall around the deck rim, with a gap on the
  // starboard side amidships (boarding ladder).
  for (let j = deckJ + 1; j <= deckJ + Math.round(1.1 / VS); j++) {
    const y = (j - jWater) * VS;
    const f01 = Math.min(1, Math.max(0, (deckY + D) / (D + deckY)));
    const beamCurve = Math.pow(Math.min(1, f01 / 0.55), 0.8);
    const halfBx = (0.18 + 0.82 * beamCurve) * halfB;
    const halfLz = (0.62 + 0.38 * beamCurve) * halfL;
    for (let i = 0; i < nx; i++)
    for (let k = 0; k < nz; k++) {
      const p = g2l(i, j, k);
      const zFrac = Math.abs(p.z) / Math.max(halfLz, 0.001);
      if (zFrac > 1) continue;
      const beamHere = halfBx * Math.sqrt(Math.max(0, 1 - zFrac * zFrac * 0.7));
      const onRim = (Math.abs(p.x) >= beamHere - VS * 1.2 || Math.abs(p.z) >= halfLz - VS * 1.2)
        && Math.abs(p.x) <= beamHere && Math.abs(p.z) <= halfLz;
      if (!onRim) continue;
      // Starboard ladder gap: skip rail where x>0 and |z| small.
      const ladderGap = p.x > 0 && Math.abs(p.z) < 1.2;
      if (ladderGap) continue;
      grid.set(i, j, k, BLOCK.RAIL);
    }
  }

  // ---- Masts: vertical columns from the deck up to mastH.
  const mastInfo = []; // { mi, mk, baseJ, topJ } per mast, for topple detection
  for (let mIdx = 0; mIdx < masts.length; mIdx++) {
    const m = masts[mIdx];
    const [mi, , mk] = l2g(0, 0, m.z);
    const topJ = deckJ + Math.round(mastH / VS);
    mastInfo.push({ mi, mk, baseJ: deckJ, topJ });
    for (let j = deckJ; j <= topJ; j++) {
      grid.set(mi, j, mk, BLOCK.MAST);
    }
    // A yardarm (horizontal spar) near the top.
    const yardJ = deckJ + Math.round(mastH * 0.72 / VS);
    const yardHalf = Math.round((B * 0.6) / VS);
    for (let di = -yardHalf; di <= yardHalf; di++) grid.set(mi + di, yardJ, mk, BLOCK.MAST);

    // ---- Sail: a sheet of cloth blocks hanging from the yardarm, given a gentle
    // BILLOW by bowing the middle rows forward (+Z) so it reads as filled canvas,
    // not a flat board. Destructible like everything else (cannonballs shred it).
    const sailTopJ = yardJ - 1;
    const sailH = Math.max(3, Math.round(mastH * 0.42 / VS));
    const sailHalf = yardHalf - 1;
    for (let row = 0; row < sailH; row++) {
      const j = sailTopJ - row;
      // Billow amount: peaks in the vertical middle of the sail.
      const vMid = 1 - Math.abs((row / (sailH - 1)) - 0.5) * 2; // 0..1..0
      for (let di = -sailHalf; di <= sailHalf; di++) {
        // Horizontal billow: peaks at center of the yard.
        const hMid = 1 - Math.abs(di / Math.max(sailHalf, 1));
        let bow = Math.round(vMid * hMid * 1.6); // forward offset in cells
        const kk = mk + bow;
        // NEVER overwrite the MAST column with cloth. If this sail cell lands on
        // the mast (di=0 & bow=0), nudge it forward 1 cell so the mast column
        // stays continuous — otherwise the mast reads as "severed" at the sail
        // and topples on the FIRST hit anywhere (the sails-snap bug).
        if (mi + di === mi && kk === mk) continue; // skip the exact mast cell
        if (grid.get(mi + di, j, kk) === BLOCK.MAST) continue; // don't clobber mast
        const shade = (di + row) % 2 ? BLOCK.SAIL2 : BLOCK.SAIL;
        grid.set(mi + di, j, kk, shade);
      }
    }

    // ---- Flag at the masthead of the tallest (first) mast: a small pennant with
    // a pale skull blotch, flying toward the stern (-Z).
    if (mIdx === 0) {
      const flagJ = topJ;
      for (let dz = 1; dz <= Math.round(2.0 / VS); dz++) {
        for (let dj = 0; dj <= 1; dj++) {
          grid.set(mi, flagJ - dj, mk - dz, BLOCK.FLAG);
        }
      }
      // Skull blotch (one pale block) in the flag's middle.
      grid.set(mi, flagJ, mk - 2, BLOCK.SKULL);
    }
  }

  // ---- Cannon blocks: a black iron barrel sitting ON the deck at the rail,
  // poking out through the bulwark. The barrel occupies the OUTER cells by the
  // rail; the gunner stands one cell INBOARD on clear deck (see
  // _buildCannons/cannonStandWorld, which must match these z positions).
  const cannonZs = [];
  {
    const nPerSide = spec.cannonsPerSide || 0;
    const cannonJ = deckJ + 1; // one cell above the deck surface
    // Cannons live in the FORWARD part of the deck so the aftmost gun clears the
    // helm/wheel (at z = -L*0.32). Centered slightly forward (+Z) with a tighter
    // spread; the rearmost cannon ends up around z = -L*0.18, forward of the helm.
    const spread = L * 0.56, center = L * 0.10;
    for (let c = 0; c < nPerSide; c++) {
      const z = (nPerSide === 1) ? center : center + ((c / (nPerSide - 1)) - 0.5) * spread;
      cannonZs.push(z);
    }
    for (const side of [1, -1]) {
      for (const z of cannonZs) {
        // Outer barrel cell = right at the rail (halfB - ~1 cell), poking out.
        const railCellX = side * (halfB - VS * 1.2);
        const [bi, , bk] = l2g(railCellX, (cannonJ - jWater) * VS, z);
        grid.set(bi, cannonJ, bk, BLOCK.CANNON);          // barrel base on deck
        grid.set(bi + side, cannonJ, bk, BLOCK.CANNON);   // barrel tip through rail
      }
    }
  }

  return { grid, g2l, l2g, jWater, deckJ, railTopJ, iCenter, kCenter,
    deckYLocal: (deckJ - jWater) * VS, cannonZs, halfB, mastInfo };
}

// ---- Face-culled mesher: emit a quad only where a solid voxel faces empty ----
const FACES = [
  { n: [ 1, 0, 0], du: [0, 1, 0], dv: [0, 0, 1] }, // +X
  { n: [-1, 0, 0], du: [0, 0, 1], dv: [0, 1, 0] }, // -X
  { n: [ 0, 1, 0], du: [0, 0, 1], dv: [1, 0, 0] }, // +Y
  { n: [ 0,-1, 0], du: [1, 0, 0], dv: [0, 0, 1] }, // -Y
  { n: [ 0, 0, 1], du: [1, 0, 0], dv: [0, 1, 0] }, // +Z
  { n: [ 0, 0,-1], du: [0, 1, 0], dv: [1, 0, 0] }, // -Z
];

function meshGrid(device, grid, g2l, rgbMap = BLOCK_RGB) {
  const pos = [], nrm = [], col = [];
  const h = VS / 2;
  for (let k = 0; k < grid.nz; k++)
  for (let j = 0; j < grid.ny; j++)
  for (let i = 0; i < grid.nx; i++) {
    const v = grid.get(i, j, k);
    if (v === 0) continue;
    const rgb = rgbMap[v] || rgbMap[1] || BLOCK_RGB[1];
    const c = g2l(i, j, k); // local center
    for (const f of FACES) {
      // Only emit the face if the neighbor in normal dir is empty.
      if (grid.solid(i + f.n[0], j + f.n[1], k + f.n[2])) continue;
      // Face center = center + n*h; build a quad from du/dv axes scaled by h.
      const cx = c.x + f.n[0] * h, cy = c.y + f.n[1] * h, cz = c.z + f.n[2] * h;
      const ux = f.du[0]*h, uy = f.du[1]*h, uz = f.du[2]*h;
      const vx = f.dv[0]*h, vy = f.dv[1]*h, vz = f.dv[2]*h;
      // 4 corners
      const c0 = [cx - ux - vx, cy - uy - vy, cz - uz - vz];
      const c1 = [cx + ux - vx, cy + uy - vy, cz + uz - vz];
      const c2 = [cx + ux + vx, cy + uy + vy, cz + uz + vz];
      const c3 = [cx - ux + vx, cy - uy + vy, cz - uz + vz];
      // two triangles (c0,c1,c2)(c0,c2,c3)
      for (const corner of [c0, c1, c2, c0, c2, c3]) {
        pos.push(corner[0], corner[1], corner[2]);
        nrm.push(f.n[0], f.n[1], f.n[2]);
        col.push(rgb[0], rgb[1], rgb[2]);
      }
    }
  }
  if (pos.length === 0) return null;
  return new Geometry(device, {
    attributes: {
      position: { format: 'float32x3', data: new Float32Array(pos) },
      normal:   { format: 'float32x3', data: new Float32Array(nrm) },
      color:    { format: 'float32x3', data: new Float32Array(col) },
    },
  });
}

// ---- WGSL: vertex-colored, model-matrix from the app uniform (group 1) ----
const VOXEL_WGSL = /* wgsl */ `
struct Camera {
  viewMatrix: mat4x4f,
  projectionMatrix: mat4x4f,
  frustumPlanes: array<vec4f, 6>,
  viewport: vec4f,
};
struct U {
  model: mat4x4f,
  sunDir: vec4f,     // xyz sun dir (normalized, from planet toward sun), w = ambient
  fogColor: vec4f,   // rgb + enabled
  fogParams: vec4f,  // near, far, _, _
};
@group(0) @binding(0) var<uniform> camera: Camera;
@group(1) @binding(0) var<uniform> u: U;

struct VOut {
  @builtin(position) position: vec4f,
  @location(0) color: vec3f,
  @location(1) normal: vec3f,
  @location(2) worldPos: vec3f,
  @location(3) viewDepth: f32,
};

@vertex
fn vertexMain(@location(0) p: vec3f, @location(1) n: vec3f, @location(2) color: vec3f) -> VOut {
  var o: VOut;
  let world = u.model * vec4f(p, 1.0);
  o.worldPos = world.xyz;
  // Rotate the normal by the model matrix (no non-uniform scale, so upper-left
  // 3x3 is fine).
  o.normal = normalize((u.model * vec4f(n, 0.0)).xyz);
  o.color = color;
  let view = camera.viewMatrix * world;
  o.viewDepth = -view.z;
  o.position = camera.projectionMatrix * view;
  return o;
}

@fragment
fn fragmentMain(i: VOut) -> @location(0) vec4f {
  let n = normalize(i.normal);
  let sunDir = normalize(u.sunDir.xyz);
  let ndl = max(dot(n, sunDir), 0.0);
  let ambient = u.sunDir.w;
  let light = ambient + (1.0 - ambient) * ndl;
  var rgb = i.color * light;
  // Hit flash: briefly blend toward white when struck (fogParams.z = flash 0..1).
  let flash = u.fogParams.z;
  rgb = mix(rgb, vec3f(1.0, 0.85, 0.6), flash * 0.7);
  if (u.fogColor.w > 0.5) {
    let f = clamp((i.viewDepth - u.fogParams.x) / max(u.fogParams.y - u.fogParams.x, 0.0001), 0.0, 1.0);
    rgb = mix(rgb, u.fogColor.rgb, f);
  }
  return vec4f(rgb, 1.0);
}
`;

// Uniform layout: mat4 (16) + 3 vec4 (12) = 28 floats = 112 bytes.
const VOXEL_UNIFORM_SIZE = 112;

// ---- The VoxelShip ----
export class VoxelShip {
  constructor(scene, ocean, specKey = 'sloop', startDir = null, planet = null, opts = {}) {
    this.scene = scene;
    this.ocean = ocean;
    this.planet = planet;
    this.name = opts.name || 'The Rusty Wench';
    this.faction = opts.faction || 'player';
    // Crew + loot (set for enemy ships). crewType decides surrender vs fight;
    // loot is the reward for BOARDING a disabled-but-afloat ship.
    this.crewType = opts.crewType || null;
    this.loot = opts.loot || null;     // { gold, desc } or null
    this.disabled = false;             // dead in the water (surrendered / dismasted)
    this.surrendered = false;
    this.captured = false;
    this.looted = false;

    const spec = SHIP_SPECS[specKey] || SHIP_SPECS.sloop;
    this.spec = spec;
    this.VS = VS;

    const layout = buildVoxelLayout(spec);
    this.grid = layout.grid;
    this._g2l = layout.g2l;
    this._l2g = layout.l2g;
    // Mast tracking for toppling: each gets a `standing` flag.
    this.masts = (layout.mastInfo || []).map(m => ({ ...m, standing: true }));
    this._debris = []; // falling mast debris pieces
    this.deckYLocal = layout.deckYLocal;
    this._layout = layout;

    // Per-ship color map: clone the base palette and override sail/flag with the
    // ship's identity colors (sailColor / flagColor).
    this._rgb = Object.assign({}, BLOCK_RGB);
    if (opts.sailColor !== undefined) {
      const s = hexToRgb(opts.sailColor);
      this._rgb[BLOCK.SAIL]  = s;
      this._rgb[BLOCK.SAIL2] = [s[0]*0.82, s[1]*0.82, s[2]*0.82];
    }
    if (opts.flagColor !== undefined) this._rgb[BLOCK.FLAG] = hexToRgb(opts.flagColor);

    // Sun/fog uniforms driven from the main loop.
    this.sunDir = new Vec3(0, 1, 0);
    this.ambient = 0.35;
    this.fog = null;

    // ---- Physics / sailing state (mirrors the box Ship) ----
    this.dir = (startDir ? startDir.clone() : new Vec3(0.15, 1, 0.1)).normalize();
    this.heading = new Vec3();
    this._tangent(this.dir, this.heading);
    this.speed = 0;
    this.sailRaised = 0;
    this.rudder = 0;
    this._smoothPitch = 0;
    this._smoothRoll = 0;

    this.position = this.dir.clone().multiplyScalar(SEA_LEVEL);
    this.up = this.dir.clone();
    this.forward = this.heading.clone();
    this.right = new Vec3();
    this.quaternion = new Quat();

    // Combat.
    this.hp = spec.hp; this.maxHp = spec.hp;
    this.sunk = false; this._reload = 0;
    this._sinking = false; this._sinkT = 0; this._removed = false;
    this.flash = 0; // hit-flash amount (0..1), decays in update()

    // Previous transform for platform velocity (deck-riding).
    this._prevPos = new Vec3();
    this._prevQ = new Quat();
    this._hasPrev = false;

    // Cannon muzzles (local) derived from the deck edges.
    this.cannons = this._buildCannons();

    // Model matrix (rebuilt each frame from position+quaternion).
    this._model = mat4.identity();

    const self = this;
    this.material = new ShaderMaterial({
      wgsl: VOXEL_WGSL,
      attributes: ['position', 'normal', 'color'],
      uniformSize: VOXEL_UNIFORM_SIZE,
      updateUniforms: (view) => {
        view.set(self._model, 0);
        const s = self.sunDir;
        view[16] = s.x; view[17] = s.y; view[18] = s.z; view[19] = self.ambient;
        const fog = self.fog;
        view[20] = fog ? fog.color.r : 0; view[21] = fog ? fog.color.g : 0; view[22] = fog ? fog.color.b : 0; view[23] = fog ? 1 : 0;
        view[24] = fog ? fog.near : 0; view[25] = fog ? fog.far : 1; view[26] = self.flash || 0; view[27] = 0;
      },
      side: 'front',
      castShadow: true,
      receiveShadow: false,
    });

    this.mesh = null;
    this._rebuildMesh();

    // ---- Treasure chest on deck (enemy ships with loot). A separate mesh that
    // rides the deck via the ship transform; the player walks up to it and opens
    // it. Sits aft of midships on the deck, off to one side of the helm.
    if (this.loot) {
      this.chestLocal = new Vec3(this.spec.beam * 0.18, this.deckLocalY() + 0.05, -this.spec.length * 0.12);
      this.chestMesh = buildChestMesh(scene.device);
      scene.add(this.chestMesh);
      this.chestOpen = false;
    }
  }

  _rebuildMesh() {
    if (this.mesh) { this.scene.remove(this.mesh); if (this.mesh.geometry) this.mesh.geometry.destroy?.(); }
    const geo = meshGrid(this.scene.device, this.grid, this._g2l, this._rgb);
    if (!geo) { this.mesh = null; return; }
    const mesh = new Mesh(geo, this.material);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
    this.mesh = mesh;
  }

  // Rebuild the model matrix from position + quaternion.
  _updateModel() {
    mat4.fromTranslationRotationScale(
      [this.position.x, this.position.y, this.position.z],
      [this.quaternion.x, this.quaternion.y, this.quaternion.z, this.quaternion.w],
      [1, 1, 1],
      this._model,
    );
  }

  // ---- Frame / transform helpers ----
  _tangent(d, out) {
    const arb = Math.abs(d.y) < 0.9 ? new Vec3(0, 1, 0) : new Vec3(1, 0, 0);
    out.crossVectors(arb, d).normalize();
    return out;
  }
  localToWorld(local, out = new Vec3()) {
    return out.copy(local).applyQuaternion(this.quaternion).add(this.position);
  }
  worldToLocal(world, out = new Vec3()) {
    out.copy(world).sub(this.position);
    return out.set(out.dot(this.right), out.dot(this.up), out.dot(this.forward));
  }
  localDirToWorld(lx, ly, lz, out = new Vec3()) {
    return out.set(0, 0, 0)
      .addScaledVector(this.right, lx).addScaledVector(this.up, ly).addScaledVector(this.forward, lz);
  }
  worldDirToLocal(d, out = new Vec3()) {
    return out.set(d.dot(this.right), d.dot(this.up), d.dot(this.forward));
  }
  deckLocalY() { return this.deckYLocal + VS * 0.5; }

  // ---- Controls / helm / boarding (same API as box Ship) ----
  setControls({ rudder = 0, sailDelta = 0 } = {}) {
    this.rudder += (rudder - this.rudder) * 0.1;
    this.sailRaised = Math.max(0, Math.min(1, this.sailRaised + sailDelta));
  }
  helmLocal() { return new Vec3(0, this.deckLocalY() + 0.05, -this.spec.length * 0.32); }
  helmWorld(out = new Vec3()) { return this.localToWorld(this.helmLocal(), out); }
  canBoardFrom(worldPos) {
    const l = this.worldToLocal(worldPos, new Vec3());
    const helm = this.helmLocal();
    const nearWheel = Math.hypot(l.x - helm.x, l.z - helm.z) < 3.2;
    const onDeck = l.y > this.deckLocalY() - 1.0 && l.y < this.deckLocalY() + 3.0;
    return nearWheel && onDeck;
  }
  atLadder(worldPos) {
    const l = this.worldToLocal(worldPos, new Vec3());
    const hx = this.spec.beam / 2;
    return (l.x > hx - 0.7 && l.x < hx + 1.2) && Math.abs(l.z) < 1.5
      && l.y > -2.2 && l.y < this.deckLocalY() + 0.4;
  }
  deckPointBelow(worldPos) {
    const l = this.worldToLocal(worldPos, new Vec3());
    const inset = 0.45;
    if (Math.abs(l.x) > this.spec.beam * 0.5 - inset) return null;
    if (Math.abs(l.z) > this.spec.length * 0.5 - inset) return null;
    return this.localToWorld(new Vec3(l.x, this.deckLocalY(), l.z), new Vec3());
  }
  platformVelocityAt(pt, dt, out = new Vec3()) {
    if (!this._hasPrev || dt <= 0) return out.set(0, 0, 0);
    const local = this.worldToLocal(pt, new Vec3());
    const prevWorld = local.clone().applyQuaternion(this._prevQ).add(this._prevPos);
    return out.copy(pt).sub(prevWorld).multiplyScalar(1 / dt);
  }

  // ---- Voxel-grid collision: query the actual blocks, so blown-open holes are
  // walk-through. Returns { push, normal, depth } in WORLD space, or null. ----
  collide(pt, rad, outPush = new Vec3(), outNormal = new Vec3()) {
    const l = this.worldToLocal(pt, new Vec3());
    // Find the nearest solid voxel cell overlapping the sphere.
    const [ci, cj, ck] = this._l2g(l.x, l.y, l.z);
    const reach = Math.ceil((rad + VS) / VS);
    let best = null;
    for (let dj = -reach; dj <= reach; dj++)
    for (let dk = -reach; dk <= reach; dk++)
    for (let di = -reach; di <= reach; di++) {
      const i = ci + di, j = cj + dj, k = ck + dk;
      const v = this.grid.get(i, j, k);
      // Cloth (sails/flag) is NON-COLLIDING — you walk under/through it.
      if (v === 0 || v === BLOCK.SAIL || v === BLOCK.SAIL2 || v === BLOCK.FLAG || v === BLOCK.SKULL) continue;
      const c = this._g2l(i, j, k);            // voxel center (local)
      const h = VS / 2 + rad;
      const dx = l.x - c.x, dy = l.y - c.y, dz = l.z - c.z;
      if (Math.abs(dx) > h || Math.abs(dy) > h || Math.abs(dz) > h) continue;
      // Penetration on each axis; smallest = push direction.
      const px = h - Math.abs(dx), py = h - Math.abs(dy), pz = h - Math.abs(dz);
      let depth, nx = 0, ny = 0, nz = 0;
      if (px <= py && px <= pz) { depth = px; nx = Math.sign(dx) || 1; }
      else if (py <= pz)        { depth = py; ny = Math.sign(dy) || 1; }
      else                      { depth = pz; nz = Math.sign(dz) || 1; }
      if (!best || depth < best.depth) best = { depth, nx, ny, nz };
    }
    if (!best) return null;
    this.localDirToWorld(best.nx, best.ny, best.nz, outNormal).normalize();
    outPush.copy(outNormal).multiplyScalar(best.depth);
    return { push: outPush, normal: outNormal, depth: best.depth };
  }

  // ---- Cannons ----
  // Each cannon is { localPos, side, reload } with its OWN reload timer (ticked
  // in update()). Cannons sit just inside the bulwark so you can walk up and man
  // one. A cannon only fires when its reload is 0.
  _buildCannons() {
    const cannons = [];
    const hx = this.spec.beam / 2;
    const deckY = this.deckLocalY();
    // Use the SAME z positions the layout placed cannon blocks at.
    const zs = this._layout.cannonZs || [];
    const barrelX = hx - VS * 1.2;         // gun sits at the rail (matches blocks)
    const standX = hx - VS * 2.6;          // gunner stands well inboard on clear deck
    for (const side of [1, -1]) {
      for (const z of zs) {
        cannons.push({
          side, z, reload: 0,
          barrelLocal: new Vec3(side * barrelX, deckY + VS, z),
          standLocal:  new Vec3(side * standX,  deckY + 0.05, z),
        });
      }
    }
    return cannons;
  }

  // Tick cannon reloads (called from update()).
  _tickCannons(dt) {
    for (const c of this.cannons) if (c.reload > 0) c.reload = Math.max(0, c.reload - dt);
  }

  // Muzzle world position + outward fire direction for a cannon.
  _cannonShot(c) {
    // Muzzle is just outboard of the barrel, clear of the rail.
    const muzzleLocal = c.barrelLocal.clone().addScaledVector(new Vec3(c.side, 0, 0), 1.2);
    const pos = this.localToWorld(muzzleLocal, new Vec3());
    const dir = this.right.clone().multiplyScalar(c.side).addScaledVector(this.up, 0.06).normalize();
    return { pos, dir };
  }

  // Fire ONE cannon (used when manning an individual gun). Returns [{pos,dir}] or
  // [] if reloading/sunk.
  fireCannon(cannon) {
    if (this.sunk || !cannon || cannon.reload > 0) return [];
    cannon.reload = 3.0; // per-cannon reload
    return [this._cannonShot(cannon)];
  }

  // Fire the whole broadside on `side` — every cannon on that side that's
  // loaded fires (skips ones still reloading). Per-cannon reload.
  fireBroadside(side) {
    if (this.sunk) return [];
    const shots = [];
    for (const c of this.cannons) {
      if (c.side !== side || c.reload > 0) continue;
      shots.push(this._cannonShot(c));
      c.reload = 3.0;
    }
    return shots;
  }

  // The cannon nearest to a world position, if within manning range (so the
  // player can walk up to a gun and press E to man it). Returns the cannon or null.
  cannonNear(worldPos, maxDist = 2.6) {
    const l = this.worldToLocal(worldPos, new Vec3());
    let best = null, bestD = maxDist * maxDist;
    for (const c of this.cannons) {
      const dx = l.x - c.standLocal.x, dz = l.z - c.standLocal.z; // distance on deck
      const d = dx*dx + dz*dz;
      if (d < bestD) { bestD = d; best = c; }
    }
    return best;
  }

  // World stand position for a manned cannon (where the player stands while
  // firing — on clear deck inboard of the gun, so collision doesn't shove them).
  cannonStandWorld(cannon, out = new Vec3()) {
    return this.localToWorld(cannon.standLocal, out);
  }

  // ---- Damage: carve a sphere of voxels out of the grid + re-mesh ----
  // Returns 'sunk' if this hit sank her, 'surrender' if it crippled her into
  // surrender, or false otherwise. A ship SURRENDERS at low HP (stays afloat,
  // boardable — that's the point); only an OVERKILL to 0 HP actually sinks her
  // (loot lost). Once surrendered, further hull hits push toward sinking.
  damage(amount) {
    if (this.sunk) return false;
    this.hp = Math.max(0, this.hp - amount);
    if (this.hp <= 0) { this.sunk = true; return 'sunk'; }
    // Surrender threshold (only for crewed enemy ships, not the player's). 30%
    // gives margin so you don't accidentally SINK (and lose the loot) of a ship
    // you meant to disable.
    if (!this.surrendered && this.faction === 'enemy' && this.hp <= this.maxHp * 0.30) {
      this.surrender();
      return 'surrender';
    }
    return false;
  }

  // Ship gives up: dead in the water, sails struck, white flag. Stays afloat and
  // boardable. (Dismasting also calls setDisabled which leads here.)
  surrender() {
    if (this.surrendered) return;
    this.surrendered = true;
    this.disabled = true;
    this.sailRaised = 0;
    this.speed = 0;
    this._raiseWhiteFlag();
  }
  setDisabled() {           // dead in the water (e.g. dismasted) but not surrendered
    this.disabled = true;
    this.sailRaised = 0;
    this.speed = 0;
  }

  // Recolor the jolly-roger flag to WHITE (surrender). The flag uses BLOCK.FLAG
  // + BLOCK.SKULL; just override their colors in this ship's palette and re-mesh.
  _raiseWhiteFlag() {
    this._rgb[BLOCK.FLAG] = [0.95, 0.95, 0.95];
    this._rgb[BLOCK.SKULL] = [0.85, 0.85, 0.85];
    this._rebuildMesh();
  }
  // World impact -> remove voxels within radiusCells (cell units) of the point.
  carveSphere(worldPos, radiusCells = 2) {
    const l = this.worldToLocal(worldPos, new Vec3());
    const [ci, cj, ck] = this._l2g(l.x, l.y, l.z);
    const r = Math.ceil(radiusCells);
    let removed = 0;
    for (let dj = -r; dj <= r; dj++)
    for (let dk = -r; dk <= r; dk++)
    for (let di = -r; di <= r; di++) {
      if (di*di + dj*dj + dk*dk > radiusCells * radiusCells) continue;
      const i = ci + di, j = cj + dj, k = ck + dk;
      if (this.grid.solid(i, j, k)) { this.grid.set(i, j, k, 0); removed++; }
    }
    if (removed) { this._rebuildMesh(); this._checkMasts(); }
    return removed;
  }

  // After hull damage, check each standing mast: find the LOWEST gap in its
  // column (the break point). Everything ABOVE that gap topples — so a hit
  // anywhere up the mast snaps it there and the section above falls.
  _checkMasts() {
    for (const m of this.masts) {
      if (!m.standing) continue;
      // Scan the mast column from JUST ABOVE the deck up to the top. Find the
      // lowest MISSING mast cell that STILL HAS mast above it — that's a genuine
      // break (a cannonball cut the mast there). Topple everything above it.
      // (We start at baseJ+1 because the deck cell shares baseJ and isn't a
      // reliable mast cell — scanning from there caused EVERY hull hit to read
      // a false "break at the base" and topple the sails.)
      const start = m.baseJ + 1;
      let breakJ = -1;
      for (let j = start; j <= m.topJ; j++) {
        if (this.grid.get(m.mi, j, m.mk) !== BLOCK.MAST) {
          // gap at j — is there mast above it?
          let mastAbove = false;
          for (let jj = j + 1; jj <= m.topJ; jj++) {
            if (this.grid.get(m.mi, jj, m.mk) === BLOCK.MAST) { mastAbove = true; break; }
          }
          if (mastAbove) { breakJ = j; break; }
        }
      }
      if (breakJ >= 0) this._toppleMast(m, breakJ);
    }
    // Lost the means to sail? Disabled if all masts are down OR essentially all
    // the SAIL CLOTH has been shot away (no canvas = no way to make way).
    if (!this.disabled && !this.canStillSail()) this.setDisabled();
  }

  // Does the ship still have the means to make way: at least one standing mast
  // AND enough sail cloth left? Used both to disable a battered ship and to
  // decide whether a CAPTURED prize can be re-crewed and sailed.
  canStillSail() {
    const anyMastStanding = this.masts.some(m => m.standing);
    if (!anyMastStanding) return false;
    let sailCells = 0;
    const data = this.grid.data;
    for (let i = 0; i < data.length; i++) {
      if (data[i] === BLOCK.SAIL || data[i] === BLOCK.SAIL2) { if (++sailCells > 6) return true; }
    }
    return sailCells > 6;
  }

  // Put a captured prize back into service: a ship that merely SURRENDERED (crew
  // gave up, but masts/sails intact) can be re-crewed and sailed by the player.
  // A genuinely dismasted hull stays dead in the water. Returns true if she can
  // now sail.
  recommission() {
    if (!this.canStillSail()) return false; // no canvas — stays a derelict
    this.disabled = false;
    this.surrendered = false;
    return true;
  }

  // Topple a mast from `fromJ` upward: collect its remaining voxels above the
  // break into a falling debris piece, clear them from the ship grid, re-mesh.
  _toppleMast(m, fromJ) {
    m.standing = false;
    const cells = [];
    const yardHalf = Math.round((this.spec.beam * 0.6) / VS) + 1;
    const dkRange = yardHalf + 3; // extra +Z reach to catch the billowed sail cells
    for (let j = fromJ; j <= m.topJ + 1; j++)
    for (let di = -yardHalf; di <= yardHalf; di++)
    for (let dk = -dkRange; dk <= dkRange; dk++) {
      const i = m.mi + di, k = m.mk + dk;
      const v = this.grid.get(i, j, k);
      if (v === BLOCK.MAST || v === BLOCK.SAIL || v === BLOCK.SAIL2 || v === BLOCK.FLAG || v === BLOCK.SKULL) {
        cells.push({ i, j, k, v });
        this.grid.set(i, j, k, 0);
      }
    }
    if (cells.length === 0) return;
    this._rebuildMesh();

    // Build a debris mesh in ship-local space from the collected cells.
    const sub = new VoxelGrid(this.grid.nx, this.grid.ny, this.grid.nz);
    for (const c of cells) sub.set(c.i, c.j, c.k, c.v);
    const geo = meshGrid(this.scene.device, sub, this._g2l, this._rgb);
    if (!geo) return;

    // The debris needs its OWN model matrix (the ship material's shader reads
    // u.model = the SHIP's transform). So give the debris a dedicated
    // ShaderMaterial whose updateUniforms feeds the debris's own falling model.
    const d = {
      pos: this.position.clone(),
      quat: this.quaternion.clone(),
      vel: this.up.clone().multiplyScalar(1.5).addScaledVector(this.right, (Math.random()*2-1)*2),
      spin: (Math.random()*2-1) * 1.6,
      spinAxis: this.forward.clone(),
      life: 6,
      _model: mat4.identity(),
    };
    const self = this;
    const mat = new ShaderMaterial({
      wgsl: VOXEL_WGSL,
      attributes: ['position', 'normal', 'color'],
      uniformSize: VOXEL_UNIFORM_SIZE,
      updateUniforms: (view) => {
        view.set(d._model, 0);
        const s = self.sunDir;
        view[16] = s.x; view[17] = s.y; view[18] = s.z; view[19] = self.ambient;
        const fog = self.fog;
        view[20] = fog ? fog.color.r : 0; view[21] = fog ? fog.color.g : 0; view[22] = fog ? fog.color.b : 0; view[23] = fog ? 1 : 0;
        view[24] = fog ? fog.near : 0; view[25] = fog ? fog.far : 1; view[26] = 0; view[27] = 0;
      },
      side: 'front', castShadow: true, receiveShadow: false,
    });
    const mesh = new Mesh(geo, mat);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
    d.mesh = mesh; d.mat = mat;
    this._debris.push(d);
  }

  beginSinking() { if (!this._sinking) { this._sinking = true; this._sinkT = 0; } }
  flashHit() { this.flash = 1; }

  // Update falling mast debris (gravity, tip-over spin, splash-fade). The mesh is
  // positioned via its own model matrix (d._model) fed through its material.
  _updateDebris(dt) {
    for (let i = this._debris.length - 1; i >= 0; i--) {
      const d = this._debris[i];
      d.life -= dt;
      const up = d.pos.clone().normalize();
      d.vel.addScaledVector(up, -GRAVITY_DEBRIS * dt);
      d.pos.addScaledVector(d.vel, dt);
      const tq = new Quat().setFromAxisAngle(d.spinAxis, d.spin * dt);
      d.quat.multiply(tq);
      mat4.fromTranslationRotationScale(
        [d.pos.x, d.pos.y, d.pos.z],
        [d.quat.x, d.quat.y, d.quat.z, d.quat.w],
        [1, 1, 1], d._model);
      if (d.pos.length() <= SEA_LEVEL - 1.5 || d.life <= 0) {
        this.scene.remove(d.mesh);
        this._debris.splice(i, 1);
      }
    }
  }

  // ---- Per-frame physics: sailing + buoyancy + orientation (ported) ----
  update(dt) {
    const ocean = this.ocean;
    const up = this.dir.clone();
    this._tickCannons(dt);
    if (this.flash > 0) this.flash = Math.max(0, this.flash - dt * 4);
    if (this._debris.length) this._updateDebris(dt);

    // Snapshot transform before moving (platform velocity).
    this._prevPos.copy(this.position);
    this._prevQ.copy(this.quaternion);
    this._hasPrev = true;

    // Sailing: turn heading, advance along it.
    if (this.rudder !== 0) {
      const ang = -this.rudder * 0.6 * dt * (0.4 + this.speed * 0.08);
      rotateAboutAxis(this.heading, up, ang);
    }
    this.heading.addScaledVector(up, -this.heading.dot(up));
    if (this.heading.lengthSq() < 1e-6) this._tangent(up, this.heading);
    this.heading.normalize();

    // Dismasted / disabled ships CAN'T SAIL — no masts means no canvas means no
    // way to make way. Force sails furled and coast to a stop. (`reverse` is the
    // AI's grounding-escape and bypasses this.)
    if (this.disabled && !this.reverse) {
      this.sailRaised = 0;
      this.speed *= Math.pow(0.4, dt); // drift to a halt
    }

    const maxSpeed = 14 * this.spec.speed;
    // Normal sailing eases speed toward the sail setting. While REVERSING (set by
    // the AI to back off a grounding), keep the commanded negative speed.
    if (!this.reverse && !this.disabled) {
      this.speed += (this.sailRaised * maxSpeed - this.speed) * Math.min(1, dt * 0.6);
    }

    if (this.speed !== 0) {
      const arc = (this.speed * dt) / SEA_LEVEL;
      const moveAxis = new Vec3().crossVectors(up, this.heading).normalize();
      const prevDir = this.dir.clone();
      rotateAboutAxis(this.dir, moveAxis, arc);
      this.dir.normalize();
      if (this.planet) {
        const draft = this.spec.depth * 0.55;
        const keelR = SEA_LEVEL - draft;
        // Check the END that's LEADING (bow when forward, stern when reversing).
        const lead = this.speed >= 0 ? 0.5 : -0.5;
        const leadDir = this.dir.clone().addScaledVector(this.heading, (this.spec.length * lead) / SEA_LEVEL).normalize();
        const groundCtr = this.planet.surfaceRadius(this.dir) > keelR;
        const groundLead = this.planet.surfaceRadius(leadDir) > keelR;
        if (groundCtr || groundLead) {
          // Allow the move ONLY if it heads into DEEPER water than where we are
          // (so reversing off a sandbar isn't blocked); otherwise revert.
          const prevSurf = this.planet.surfaceRadius(prevDir);
          const newSurf = this.planet.surfaceRadius(this.dir);
          if (newSurf >= prevSurf) {
            this.dir.copy(prevDir);
            if (!this.reverse) { this.speed = 0; this.sailRaised *= 0.5; }
            this._aground = true;
          } else { this._aground = false; } // moving toward deeper water — let it
        } else this._aground = false;
      }
    }

    // Buoyancy: sample 4 points + center.
    const t = ocean ? ocean.time : 0;
    const upN = this.dir.clone();
    const fwd = this.heading.clone();
    fwd.addScaledVector(upN, -fwd.dot(upN)).normalize();
    const rightV = new Vec3().crossVectors(upN, fwd).normalize();
    const halfL = this.spec.length * 0.5, halfB = this.spec.beam * 0.5;
    const sampleDir = (af, ar) => SEA_LEVEL + sampleOceanHeight(
      upN.clone().addScaledVector(fwd, af / SEA_LEVEL).addScaledVector(rightV, ar / SEA_LEVEL).normalize(), t);
    const rBow = sampleDir(halfL, 0), rStern = sampleDir(-halfL, 0);
    const rPort = sampleDir(0, -halfB), rStar = sampleDir(0, halfB);
    const rCenter = SEA_LEVEL + sampleOceanHeight(upN, t);

    const draft = this.spec.depth * 0.12;
    let ridR = rCenter - draft;
    let sinkRoll = 0;
    if (this._sinking) {
      this._sinkT += dt; this.speed = 0; this.sailRaised = 0;
      const f = Math.min(1, this._sinkT / 6);
      ridR -= f * (this.spec.depth + 6);
      sinkRoll = f * 0.9;
      if (this._sinkT > 7 && !this._removed) { this._removed = true; if (this.mesh) this.mesh.visible = false; }
    }

    const pitch = Math.atan2(rBow - rStern, this.spec.length);
    const roll = Math.atan2(rStar - rPort, this.spec.beam) + sinkRoll;
    this._smoothPitch += (pitch - this._smoothPitch) * Math.min(1, dt * 4);
    this._smoothRoll += (roll - this._smoothRoll) * Math.min(1, dt * 4);

    const tiltedUp = upN.clone(), tiltedFwd = fwd.clone(), tiltedRight = rightV.clone();
    rotateAboutAxis(tiltedUp, rightV, -this._smoothPitch);
    rotateAboutAxis(tiltedFwd, rightV, -this._smoothPitch);
    rotateAboutAxis(tiltedUp, tiltedFwd, this._smoothRoll);
    rotateAboutAxis(tiltedRight, tiltedFwd, this._smoothRoll);

    this.position.copy(upN).multiplyScalar(ridR);
    this.up.copy(tiltedUp); this.forward.copy(tiltedFwd); this.right.copy(tiltedRight);

    const q = quatFromBasis(
      [tiltedRight.x, tiltedRight.y, tiltedRight.z],
      [tiltedUp.x, tiltedUp.y, tiltedUp.z],
      [tiltedFwd.x, tiltedFwd.y, tiltedFwd.z],
    );
    this.quaternion.set(q[0], q[1], q[2], q[3]);
    this._updateModel();

    // Ride the chest on the deck (follows the ship transform).
    if (this.chestMesh) {
      this.chestMesh.visible = !this._removed;
      this.localToWorld(this.chestLocal, this.chestMesh.position);
      this.chestMesh.quaternion.copy(this.quaternion);
    }
  }

  // World position of the deck chest, or null if none/taken.
  chestWorld(out = new Vec3()) {
    if (!this.chestMesh) return null;
    return this.localToWorld(this.chestLocal, out);
  }
  // Is `worldPos` within reach of the (unopened) chest?
  nearChest(worldPos, maxDist = 2.6) {
    if (!this.chestMesh || this.chestOpen || !this.loot || this.looted) return false;
    const cw = this.localToWorld(this.chestLocal, new Vec3());
    return cw.sub(worldPos).length() < maxDist;
  }
  // Open the chest: returns the gold taken (0 if already taken).
  openChest() {
    if (!this.loot || this.looted) return 0;
    this.looted = true;
    this.chestOpen = true;
    openChestMesh(this.chestMesh);
    return this.loot.gold;
  }
}

// Rotate vector v about a unit axis by angle (in place), Rodrigues' formula.
function rotateAboutAxis(v, axis, angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  const dot = v.x * axis.x + v.y * axis.y + v.z * axis.z;
  const cx = axis.y * v.z - axis.z * v.y;
  const cy = axis.z * v.x - axis.x * v.z;
  const cz = axis.x * v.y - axis.y * v.x;
  v.x = v.x * c + cx * s + axis.x * dot * (1 - c);
  v.y = v.y * c + cy * s + axis.y * dot * (1 - c);
  v.z = v.z * c + cz * s + axis.z * dot * (1 - c);
  return v;
}
