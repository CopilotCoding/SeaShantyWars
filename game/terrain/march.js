import { PLANET_RADIUS, SEA_LEVEL, CHUNK_SIZE, ISO_LEVEL, MATERIAL_LIST } from '../constants.js';
import { density } from './density.js';

// Smooth island color ramp by height above the waterline (world units). Returns
// [r,g,b]. Blends sand -> grass -> rock -> snow with soft transitions so islands
// read as natural terrain instead of hard color bands. Underwater darkens.
const C = {
  deepFloor: [0.18, 0.20, 0.16],
  sand:      [0.86, 0.78, 0.55],
  grass:     [0.32, 0.50, 0.24],
  grassDark: [0.24, 0.40, 0.20],
  rock:      [0.46, 0.43, 0.39],
  snow:      [0.92, 0.94, 0.98],
};
function mix3(a, b, t) {
  return [a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t, a[2]+(b[2]-a[2])*t];
}
function smooth(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
function islandColor(elev, jitter) {
  // elev: height above SEA_LEVEL (negative = underwater). jitter: small per-vertex
  // noise [-1,1] to break up the bands so coastlines aren't perfect rings.
  const e = elev + jitter * 1.4;
  if (e < -1.5) {
    // submerged seafloor -> darker with depth
    return mix3(C.sand, C.deepFloor, smooth(-1.5, -16, e));
  }
  // beach sand near the waterline
  let col = C.sand;
  col = mix3(col, mix3(C.grass, C.grassDark, smooth(3, 14, e)), smooth(1.0, 4.0, e));
  col = mix3(col, C.rock, smooth(13, 22, e));
  col = mix3(col, C.snow, smooth(26, 34, e));
  return col;
}

// Marching-cubes meshing for a single chunk's cached density/material arrays.
// Pure function of chunk data + noise/overrides (needed for the sky-access
// raycast, which samples density() at points outside this chunk) — no THREE
// dependency, so it can run on the main thread or inside a Web Worker without
// pulling in the renderer.
//
// Returns { positions, colors, skyAccess } typed arrays, or null if the chunk
// contains no surface (caller wraps these into a BufferGeometry).
export function marchChunk(noiseSet, overrides, chunk) {
  if (typeof edgeTable === 'undefined' || typeof triTable === 'undefined') return null;

  const { cx, cy, cz } = chunk;
  const N = CHUNK_SIZE + 1;
  const dens = chunk.densities;
  const mats = chunk.materials;

  // Precompute per-material RGB from the color integer — no THREE.Color in hot loop
  const matRGB = MATERIAL_LIST.map(m => [
    ((m.color >> 16) & 0xff) / 255,
    ((m.color >> 8)  & 0xff) / 255,
    ( m.color        & 0xff) / 255,
  ]);
  // (Surface color now comes from a smooth height ramp per vertex — see
  // islandColor() in interp; no per-chunk biome tint needed.)

  // Pre-size output arrays for speed
  const posArr = [];
  const colArr = [];
  const skyArr = [];

  // Reusable edge vertex storage: [x, y, z, r, g, b, skyAccess] per edge
  const ev = new Float32Array(12 * 7);

  for (let lz = 0; lz < CHUNK_SIZE; lz++)
  for (let ly = 0; ly < CHUNK_SIZE; ly++)
  for (let lx = 0; lx < CHUNK_SIZE; lx++) {
    const i000 = lz*N*N + ly*N + lx;
    const d0 = dens[i000];
    const d1 = dens[i000 + 1];
    const d2 = dens[i000 + N + 1];
    const d3 = dens[i000 + N];
    const d4 = dens[i000 + N*N];
    const d5 = dens[i000 + N*N + 1];
    const d6 = dens[i000 + N*N + N + 1];
    const d7 = dens[i000 + N*N + N];

    let ci = 0;
    if (d0 < ISO_LEVEL) ci |= 1;
    if (d1 < ISO_LEVEL) ci |= 2;
    if (d2 < ISO_LEVEL) ci |= 4;
    if (d3 < ISO_LEVEL) ci |= 8;
    if (d4 < ISO_LEVEL) ci |= 16;
    if (d5 < ISO_LEVEL) ci |= 32;
    if (d6 < ISO_LEVEL) ci |= 64;
    if (d7 < ISO_LEVEL) ci |= 128;

    const E = edgeTable[ci];
    if (E === 0) continue;

    const wx0 = cx * CHUNK_SIZE + lx;
    const wy0 = cy * CHUNK_SIZE + ly;
    const wz0 = cz * CHUNK_SIZE + lz;

    // Inline interpolation — writes directly into ev[]
    const interp = (slot, ax, ay, az, bx, by, bz, va, vb, matA, matB) => {
      // Clamp to [0,1]: the iso-crossing is always BETWEEN the two corners. When
      // va≈vb (near-flat density across the edge) the raw t can blow up far
      // outside [0,1], flinging the vertex to a huge radius — which the
      // height-based color ramp then reads as a high-elevation snow cap, showing
      // as sparse white triangles on the seafloor. Clamping fixes it.
      let t = (ISO_LEVEL - va) / (vb - va + 0.0001);
      t = t < 0 ? 0 : (t > 1 ? 1 : t);
      const px = ax + t * (bx - ax);
      const py = ay + t * (by - ay);
      const pz = az + t * (bz - az);
      const matId = t < 0.5 ? matA : matB;
      const r = Math.sqrt(px*px + py*py + pz*pz);
      // Sky access: shoot ray outward from vertex — solid above = underground
      const ir = r > 0.001 ? 1/r : 1;
      const ux = px*ir, uy = py*ir, uz = pz*ir;
      let sky = 1.0;
      for (let d = 2; d <= 28; d += 3) {
        if (density(noiseSet, overrides, px + ux*d, py + uy*d, pz + uz*d) > ISO_LEVEL) { sky = 0.0; break; }
      }

      // Color: smooth height-based island ramp at/near the surface (sky-lit),
      // but the discrete ORE material color underground (so mined veins show).
      // matId 3..6 = coal/iron/gold/gem (see constants); show those as ore.
      const isOre = matId >= 3 && matId <= 6;
      let cr, cg, cb;
      if (isOre && sky < 0.5) {
        const rgb = matRGB[matId] || matRGB[0];
        cr = rgb[0]; cg = rgb[1]; cb = rgb[2];
      } else {
        // Cheap per-vertex jitter in [-1,1] from a position hash.
        const hsh = Math.sin(px * 12.9898 + py * 78.233 + pz * 37.719) * 43758.5453;
        const jitter = (hsh - Math.floor(hsh)) * 2 - 1;
        const col = islandColor(r - SEA_LEVEL, jitter);
        cr = col[0]; cg = col[1]; cb = col[2];
      }
      const s = slot * 7;
      ev[s]   = px; ev[s+1] = py; ev[s+2] = pz;
      ev[s+3] = cr; ev[s+4] = cg; ev[s+5] = cb;
      ev[s+6] = sky;
    };

    const m = (lx2, ly2, lz2) => mats[(lz+lz2)*N*N + (ly+ly2)*N + (lx+lx2)];

    if (E & 1)    interp(0,  wx0,wy0,wz0,       wx0+1,wy0,wz0,   d0,d1, m(0,0,0),m(1,0,0));
    if (E & 2)    interp(1,  wx0+1,wy0,wz0,     wx0+1,wy0+1,wz0, d1,d2, m(1,0,0),m(1,1,0));
    if (E & 4)    interp(2,  wx0+1,wy0+1,wz0,   wx0,wy0+1,wz0,   d2,d3, m(1,1,0),m(0,1,0));
    if (E & 8)    interp(3,  wx0,wy0+1,wz0,     wx0,wy0,wz0,     d3,d0, m(0,1,0),m(0,0,0));
    if (E & 16)   interp(4,  wx0,wy0,wz0+1,     wx0+1,wy0,wz0+1, d4,d5, m(0,0,1),m(1,0,1));
    if (E & 32)   interp(5,  wx0+1,wy0,wz0+1,   wx0+1,wy0+1,wz0+1,d5,d6,m(1,0,1),m(1,1,1));
    if (E & 64)   interp(6,  wx0+1,wy0+1,wz0+1, wx0,wy0+1,wz0+1, d6,d7, m(1,1,1),m(0,1,1));
    if (E & 128)  interp(7,  wx0,wy0+1,wz0+1,   wx0,wy0,wz0+1,   d7,d4, m(0,1,1),m(0,0,1));
    if (E & 256)  interp(8,  wx0,wy0,wz0,       wx0,wy0,wz0+1,   d0,d4, m(0,0,0),m(0,0,1));
    if (E & 512)  interp(9,  wx0+1,wy0,wz0,     wx0+1,wy0,wz0+1, d1,d5, m(1,0,0),m(1,0,1));
    if (E & 1024) interp(10, wx0+1,wy0+1,wz0,   wx0+1,wy0+1,wz0+1,d2,d6,m(1,1,0),m(1,1,1));
    if (E & 2048) interp(11, wx0,wy0+1,wz0,     wx0,wy0+1,wz0+1, d3,d7, m(0,1,0),m(0,1,1));

    const tb = ci * 16;
    for (let t = 0; t < 16; t += 3) {
      const i0 = triTable[tb + t];
      if (i0 === -1) break;
      const i1 = triTable[tb + t + 1];
      const i2 = triTable[tb + t + 2];
      const s0=i0*7, s1=i1*7, s2=i2*7;
      posArr.push(ev[s0],ev[s0+1],ev[s0+2], ev[s1],ev[s1+1],ev[s1+2], ev[s2],ev[s2+1],ev[s2+2]);
      colArr.push(ev[s0+3],ev[s0+4],ev[s0+5], ev[s1+3],ev[s1+4],ev[s1+5], ev[s2+3],ev[s2+4],ev[s2+5]);
      skyArr.push(ev[s0+6], ev[s1+6], ev[s2+6]);
    }
  }

  if (posArr.length === 0) return null;
  return {
    positions: new Float32Array(posArr),
    colors: new Float32Array(colArr),
    skyAccess: new Float32Array(skyArr),
  };
}
