// Crew types + loot. A ship's crew type decides how it behaves when boarded:
// civilians/merchants surrender easily (easy loot), pirates/military fight back.
// (Crew melee combat is a later layer; for now `fightChance` gates a stubbed
// surrender vs. resist.) Loot is the reward for boarding an AFLOAT, disabled
// ship — NOT for sinking it (sinking loses the loot).

export const CREW_TYPES = {
  civilian: {
    name: 'Civilians',  color: 0x9fb8c8, fightChance: 0.0,
    lootGold: [20, 80],   lootDesc: 'meagre coin',
  },
  merchant: {
    name: 'Merchants',  color: 0xc8a85a, fightChance: 0.1,
    lootGold: [120, 400], lootDesc: 'a fat cargo of goods',
  },
  pirate: {
    name: 'Pirates',    color: 0x7a3b3b, fightChance: 0.7,
    lootGold: [80, 260],  lootDesc: 'plundered spoils',
  },
  military: {
    name: 'Navy',       color: 0x3b5a7a, fightChance: 1.0,
    lootGold: [60, 200],  lootDesc: 'a war chest',
  },
};

let _seed = 0xC0FFEE;
function rng() {
  _seed = (_seed * 1664525 + 1013904223) >>> 0;
  return _seed / 4294967296;
}

// Roll a loot bundle for a crew type: gold (+ a few flavor items later).
export function rollLoot(crewTypeKey) {
  const ct = CREW_TYPES[crewTypeKey] || CREW_TYPES.merchant;
  const [lo, hi] = ct.lootGold;
  const gold = Math.round(lo + rng() * (hi - lo));
  return { gold, desc: ct.lootDesc };
}

export function crewColor(crewTypeKey) {
  return (CREW_TYPES[crewTypeKey] || CREW_TYPES.merchant).color;
}

// ---- Faction hostility ----
// A ship's "faction" for AI purposes is its crewType; the PLAYER counts as a
// 'pirate'. isHostile(a, b) = does a want to attack b?
//   military : attacks pirates (+player). Friendly to civilian/merchant/military.
//   civilian/merchant : attacks pirates (+player) — but they FLEE (handled in AI).
//   pirate   : attacks EVERYONE, including other pirates.
export function factionOf(ship) {
  if (!ship) return null;
  if (ship.faction === 'player') return 'pirate'; // the player is a pirate
  return ship.crewType || 'pirate';
}

export function isHostile(aFaction, bFaction) {
  if (!aFaction || !bFaction) return false;
  if (aFaction === 'pirate') return true;          // pirates attack anyone (even pirates)
  // military / civilian / merchant: hostile only to pirates.
  return bFaction === 'pirate';
}

// Civilians & merchants are PREY — they flee rather than hunt.
export function isPrey(faction) {
  return faction === 'civilian' || faction === 'merchant';
}

// ---- Crew complement: how many defenders stand on the deck, and their mix of
// melee (cutlass) vs ranged (musket) fighters. Tougher factions field more, and
// more aggressive, crew. Civilians barely resist; navy decks are a wall of men.
export function crewComplement(crewTypeKey) {
  const ct = CREW_TYPES[crewTypeKey] || CREW_TYPES.merchant;
  // Base count scales with fightChance; melee/ranged split varies by faction.
  const count = Math.max(0, Math.round(1 + ct.fightChance * 6)); // 1..7
  // Navy/pirate field more musketmen; merchants mostly a few melee bodies.
  const rangedFrac = crewTypeKey === 'military' ? 0.5
                   : crewTypeKey === 'pirate'   ? 0.4
                   : 0.2;
  const ranged = Math.round(count * rangedFrac);
  return { count, ranged, melee: count - ranged };
}

export function crewName(crewTypeKey) {
  return (CREW_TYPES[crewTypeKey] || CREW_TYPES.merchant).name;
}
