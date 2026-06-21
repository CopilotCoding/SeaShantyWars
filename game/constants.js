// Sea Shanty Wars — world constants. An ocean world: a big voxel planet (real
// destructible marching-cubes terrain, reused from PlanetVoxel) whose surface
// mostly sits BELOW a fixed sea-level radius, so the ocean covers it and only
// the terrain peaks rise above the waterline as islands.

export const PLANET_RADIUS = 220;   // mean solid-terrain radius — bigger than the mining game's 180
export const SEA_LEVEL     = 226;   // ocean surface radius. Terrain above => island; below => seafloor.
export const SKY_RADIUS    = 300;   // atmosphere glow shell
export const ATMOSPHERE_RADIUS = 280;

export const CHUNK_SIZE = 16;
export const ISO_LEVEL  = 0.5;

// How tall island terrain can rise above the seafloor baseline (used by the
// ocean-world density tuning in terrain/density.js).
export const TERRAIN_AMPLITUDE = 30;

export const MINE_RADIUS = 3.5;
export const MINE_RANGE  = 18;

// Player (on-foot) movement — spherical gravity toward planet center.
export const PLAYER_HEIGHT = 1.8;
export const PLAYER_SPEED  = 8;
export const JUMP_FORCE    = 9;
export const GRAVITY       = 20;
export const SWIM_SPEED    = 5;

export const DEFAULT_SEED = 1815;

// Ocean wave appearance/feel — shared by the WGSL ocean shader and the CPU-side
// buoyancy sampler so ships float on the SAME surface the player sees.
export const WAVE = {
  trains: [
    { amplitude: 0.55, wavelength: 26, speed: 5.0, steepness: 0.5,  angle: 0.4 },
    { amplitude: 0.38, wavelength: 16, speed: 4.2, steepness: 0.45, angle: 2.1 },
    { amplitude: 0.24, wavelength: 9.5, speed: 3.4, steepness: 0.4, angle: 4.0 },
    { amplitude: 0.14, wavelength: 5.5, speed: 2.8, steepness: 0.35, angle: 5.3 },
  ],
};

// ---- Terrain material palette (reused by the marching-cubes density/material
// system). Ocean-themed: sand near the waterline, grass/rock/snow on islands,
// plus some treasure-ish deep materials kept for flavor + future mining. The
// `id` field is the index stored per-voxel; colors drive vertex colors.
export const MATERIALS = {
  SAND:    { id: 0, name: 'Sand',      color: 0xD8C48C, basePrice: 0.1 },
  ROCK:    { id: 1, name: 'Rock',      color: 0x7C7468, basePrice: 0.1 },
  CLAY:    { id: 2, name: 'Clay',      color: 0x9A6E4C, basePrice: 1 },
  COAL:    { id: 3, name: 'Coal',      color: 0x2A2A2A, basePrice: 1 },
  IRON:    { id: 4, name: 'Iron Ore',  color: 0xA85636, basePrice: 2 },
  GOLD:    { id: 5, name: 'Gold Vein', color: 0xE6C24A, basePrice: 12 },
  GEM:     { id: 6, name: 'Gemstone',  color: 0x2BE0B0, basePrice: 30 },
  GRASS:   { id: 7, name: 'Grass',     color: 0x4E7A38, basePrice: 0.1 },
  SNOW:    { id: 8, name: 'Snow',      color: 0xEDF0F6, basePrice: 0.1 },
};
export const MATERIAL_LIST = Object.values(MATERIALS);

// Biome surface tints — kept simple/island-flavored. getBiome picks one per
// region; march.js blends it with the per-voxel material color.
export const BIOME_COLORS = [
  { name: 'Tropic Isle', surface: 0x4E7A38, rock: 0x6B5E45 },
  { name: 'Sandbar',     surface: 0xD8C48C, rock: 0x8C7A55 },
  { name: 'Rocky Reef',  surface: 0x6E6A60, rock: 0x4C4A44 },
  { name: 'Frost Cape',  surface: 0xCFE0E8, rock: 0x7E8A90 },
];
