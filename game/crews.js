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
// A ship's "faction" for AI purposes is its crewType; the PLAYER is its OWN
// faction ('player'), starting NEUTRAL with everyone (see reputation below).
// NPC-vs-NPC rules:
//   military : attacks pirates. Friendly to civilian/merchant/military.
//   civilian/merchant : attacks pirates — but they FLEE (handled in AI).
//   pirate   : attacks EVERYONE, including other pirates.
export function factionOf(ship) {
  if (!ship) return null;
  if (ship.faction === 'player') return 'player';
  return ship.crewType || 'pirate';
}

// ---- REPUTATION ----
// The player starts NEUTRAL (0) with each faction. Attacking ships of a faction
// drops your standing with them and raises it with their RIVALS. When your
// standing with a faction falls below HOSTILE_REP, they turn on you; above
// FRIENDLY_REP they treat you as an ally and won't fire first.
const FACTIONS = ['pirate', 'military', 'merchant', 'civilian'];
export const reputation = { pirate: 0, military: 0, merchant: 0, civilian: 0 };
const REP_MIN = -100, REP_MAX = 100;
export const HOSTILE_REP = -25;   // at/below this, the faction attacks you
const FRIENDLY_REP = 25;          // at/above this, they consider you an ally

// Who gains when you attack a given faction (their rivals approve). Hunting
// pirates pleases everyone lawful; preying on civilians/merchants pleases pirates
// and angers the navy; fighting navy pleases pirates.
const RIVALS = {
  pirate:   ['military', 'merchant', 'civilian'], // everyone lawful likes pirate-hunters
  military: ['pirate'],                           // only pirates cheer navy losses
  merchant: ['pirate'],
  civilian: ['pirate'],
};

const clampRep = (v) => Math.max(REP_MIN, Math.min(REP_MAX, v));

// Record the player attacking a ship of `victimFaction` (a hit / kill). Drops rep
// with that faction and nudges up their rivals'. `weight` scales the swing.
export function playerAttacked(victimFaction, weight = 1) {
  if (!FACTIONS.includes(victimFaction)) return;
  reputation[victimFaction] = clampRep(reputation[victimFaction] - 6 * weight);
  for (const r of (RIVALS[victimFaction] || [])) {
    if (r === victimFaction) continue;
    reputation[r] = clampRep(reputation[r] + 2 * weight);
  }
  // The NAVY protects the innocent: preying on civilians/merchants angers them
  // directly (on top of the rival bonus pirates get for the same act).
  if (victimFaction === 'civilian' || victimFaction === 'merchant') {
    reputation.military = clampRep(reputation.military - 5 * weight);
  }
}

export function repWith(faction) { return reputation[faction] ?? 0; }
export function factionStanding(faction) {
  const r = repWith(faction);
  if (r <= HOSTILE_REP) return 'hostile';
  if (r >= FRIENDLY_REP) return 'allied';
  return 'neutral';
}

export function isHostile(aFaction, bFaction) {
  if (!aFaction || !bFaction) return false;
  // Player involved: hostility is driven by REPUTATION, not fixed faction rules.
  if (aFaction === 'player') return repWith(bFaction) <= HOSTILE_REP;   // do I attack them?
  if (bFaction === 'player') return repWith(aFaction) <= HOSTILE_REP;   // do they attack me?
  // NPC vs NPC: the classic rules.
  if (aFaction === 'pirate') return true;          // pirates attack anyone (even pirates)
  return bFaction === 'pirate';                    // lawful factions hate pirates
}

// Civilians & merchants are PREY — they flee rather than hunt.
export function isPrey(faction) {
  return faction === 'civilian' || faction === 'merchant';
}

// ---- Crew complement: how many defenders stand on the deck, and their mix of
// melee (cutlass) vs ranged (musket) fighters. Scales with BOTH the faction
// (tougher crews resist harder) AND the ship's SIZE (a man-o-war's deck is a
// wall of men; a cutter has a handful). `spec` is the ship's SHIP_SPECS entry.
export function crewComplement(crewTypeKey, spec = null) {
  const ct = CREW_TYPES[crewTypeKey] || CREW_TYPES.merchant;
  // Faction base: how willing they are to fight (1..7 from fightChance).
  const factionBase = 1 + ct.fightChance * 6;
  // Ship-size factor from the hull's nominal crew (sloop≈4 -> ~1.0, manowar≈22
  // -> ~3.5). Bigger decks field proportionally more defenders.
  const sizeFactor = spec && spec.crew ? Math.max(0.6, spec.crew / 5) : 1;
  // Final count, capped so even a man-o-war's deck stays winnable on foot.
  const count = Math.max(0, Math.min(16, Math.round(factionBase * sizeFactor)));
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
