import { PLANET_RADIUS, SEA_LEVEL, TERRAIN_AMPLITUDE, ISO_LEVEL, MATERIAL_LIST, BIOME_COLORS } from '../constants.js';
import { SeededNoise } from '../noise.js';

// Pure terrain scalar-field generation: density(), getMaterial(), getBiome().
// Depends only on a seed and noise generators — no THREE, no chunk/mesh
// state — so it can run unmodified on the main thread or inside a Web Worker.

export function createNoiseSet(seed) {
  return {
    noise:  new SeededNoise(seed),
    noise2: new SeededNoise(seed ^ 0xDEADBEEF),
    noise3: new SeededNoise(seed ^ 0xCAFEBABE),
  };
}

// Scalar field: positive inside planet, negative outside.
// `overrides`: { mineOverrides: Map("x,y,z"->delta), shellTargetR: Map("x,y,z"->targetR) }
export function density(noiseSet, overrides, x, y, z) {
  const { noise, noise2, noise3 } = noiseSet;
  const ix = Math.round(x), iy = Math.round(y), iz = Math.round(z);
  const r = Math.sqrt(x*x + y*y + z*z);

  // Voxels touched by raise/lower/flatten store the constant-radius shell
  // they were leveled to. The mesh only ever samples integer (ix,iy,iz)
  // points, where the override-based formula below is exact — but the
  // player's collision probes query *continuous* (x,y,z) positions. At
  // those points the raw terrain noise (which varies by up to ±28 over a
  // single voxel) would otherwise leak back in, since the override is a
  // flat per-voxel delta subtracted from a continuously-varying base field.
  // That created huge per-cell density swings the player's collider could
  // catch on, producing large hops while walking on tool-flattened ground.
  // Returning a pure function of the continuous radius here instead makes
  // the shell perfectly smooth between voxel centers, matching the flat
  // mesh exactly.
  const shellKey = `${ix},${iy},${iz}`;
  const targetR = overrides.shellTargetR.get(shellKey);
  if (targetR !== undefined) return ISO_LEVEL + (targetR - r);

  const nx = x / PLANET_RADIUS, ny = y / PLANET_RADIUS, nz = z / PLANET_RADIUS;

  // Base sphere
  let d = PLANET_RADIUS - r;

  // ---- Ocean-world terrain shaping ----
  // Instead of symmetric noise around the baseline, drive elevation from a
  // continent/land mask so the world is mostly submerged seafloor with islands
  // rising above the waterline. SEA_LEVEL is PLANET_RADIUS + 6 (see constants),
  // so terrain must clear +6 here to be dry land.
  //
  // continents: low-frequency mask defining big landmasses; detail: higher
  // frequency adding island clusters + coastline crinkle.
  const continents = noise.fbm01(nx * 1.25, ny * 1.25, nz * 1.25, 4);
  const detail     = noise2.fbm01(nx * 3.0 + 4.0, ny * 3.0, nz * 3.0 - 2.0, 3);
  // Weight continents more heavily so islands are broad rounded landmasses with
  // a little coastline crinkle, not jagged high-frequency spikes.
  const mask = continents * 0.80 + detail * 0.20;

  // The land mask empirically spans ~0.33..0.70 over the sphere (measured), so
  // a threshold near 0.52 puts roughly the top third above water as islands.
  // Divide by the remaining headroom (~0.18) so the highest mask reaches ~1,
  // then a gentle power sharpens coastlines.
  const SEA_THRESH = 0.52;
  const shaped = Math.pow(Math.min(1, Math.max(0, (mask - SEA_THRESH) / 0.18)), 1.2);

  // Land rises well above the waterline (SEA_LEVEL is PLANET_RADIUS + 6), so an
  // island peaks ~30+ units above sea: clearly dry land, beaches, hills.
  const landMargin = (SEA_LEVEL - PLANET_RADIUS); // baseline->sea gap (6)
  const landRise = shaped * (landMargin + 8 + TERRAIN_AMPLITUDE); // up to ~44 above baseline

  // Open ocean: seafloor sits a bit below the baseline so the water has depth.
  // Fades out as land rises so coastlines meet the water smoothly.
  const seafloor = -(landMargin + 4 + noise2.fbm01(nx * 2.4 + 11, ny * 2.4, nz * 2.4, 3) * 12);
  d += landRise + (1 - Math.min(1, shaped * 3)) * seafloor;

  // NO CAVE TUNNELS in Sea Shanty Wars — the original PlanetVoxel carved a
  // tunnel network that punched holes through island surfaces (cave mouths),
  // which read as "invisible patches" you could see straight into. Islands here
  // are solid. (Cannonball/mining holes are added explicitly via overrides.)

  // Apply mining overrides (sparse)
  const key = `${ix},${iy},${iz}`;
  const ov = overrides.mineOverrides.get(key);
  if (ov !== undefined) d -= ov;

  return d;
}

// Material at a given world position. Ocean-world palette: surface tinted by
// height relative to SEA_LEVEL (sand at the waterline -> grass -> rock -> snow),
// with deep ore/treasure veins kept underground for mining flavor.
// MATERIAL_LIST indices: 0 SAND,1 ROCK,2 CLAY,3 COAL,4 IRON,5 GOLD,6 GEM,7 GRASS,8 SNOW
export function getMaterial(noiseSet, x, y, z) {
  const { noise2, noise3 } = noiseSet;
  const r = Math.sqrt(x*x + y*y + z*z);
  const nx = x / PLANET_RADIUS, ny = y / PLANET_RADIUS, nz = z / PLANET_RADIUS;

  // Elevation relative to the waterline (negative = underwater seafloor).
  const elev = r - SEA_LEVEL;
  // Depth below the *local surface* drives ore veins. Approximate by distance
  // beneath the baseline radius — deeper inside the planet = rarer materials.
  const depthFrac = Math.max(0, Math.min(1, (PLANET_RADIUS - r) / PLANET_RADIUS));

  // Ore/treasure veins (only meaningfully deep underground).
  const vein1 = noise2.fbm01(nx * 12, ny * 12, nz * 12, 3);
  const vein2 = noise3.fbm01(nx * 9 + 7, ny * 9 + 7, nz * 9 + 7, 3);
  if (depthFrac > 0.55 && vein1 > 0.72) return MATERIAL_LIST[6]; // Gemstone
  if (depthFrac > 0.40 && vein2 > 0.70) return MATERIAL_LIST[5]; // Gold Vein
  if (depthFrac > 0.18 && vein1 > 0.62) return MATERIAL_LIST[4]; // Iron Ore
  if (depthFrac > 0.12 && vein2 > 0.60) return MATERIAL_LIST[3]; // Coal

  // Surface tint by height above/below the waterline.
  if (elev < -2)  return MATERIAL_LIST[2]; // submerged seafloor -> clay/mud
  if (elev < 1.5) return MATERIAL_LIST[0]; // beach sand near waterline
  if (elev < 12)  return MATERIAL_LIST[7]; // grassy island
  if (elev < 24)  return MATERIAL_LIST[1]; // rocky highlands
  return MATERIAL_LIST[8];                 // snow caps
}

export function getBiome(noiseSet, nx, ny, nz) {
  const b = noiseSet.noise.fbm01(nx * 1.5, ny * 1.5, nz * 1.5, 3);
  return BIOME_COLORS[Math.floor(b * BIOME_COLORS.length) % BIOME_COLORS.length];
}
