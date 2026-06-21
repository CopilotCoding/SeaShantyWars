import { Mesh, Group, LambertMaterial, BasicMaterial, geometryFromData, boxData, Vec3 } from '../engine.js';

// A small blocky CREW figure that stands on a ship's deck and fights boarders.
// Built from a stack of colored boxes (head/torso/hips/legs/arms + a weapon),
// mirroring the chest's Group-of-boxes approach in loot.js — so it gets a model
// matrix for free via the Group transform and rides the deck like the chest.
//
// `kind` is 'melee' (cutlass) or 'ranged' (musket). `palette` tints the coat so
// a faction's crew read at a glance (navy blue, pirate red-brown, etc).

const PAL = {
  // coat, trim, skin, hat
  pirate:   { coat: 0x6e2f2f, trim: 0x2a1a12, skin: 0xc69a73, hat: 0x1d1410 },
  military: { coat: 0x27406b, trim: 0xb8902f, skin: 0xc69a73, hat: 0x14233f },
  merchant: { coat: 0x6a5a36, trim: 0x3a2f1c, skin: 0xc69a73, hat: 0x4a3c24 },
  civilian: { coat: 0x8a8470, trim: 0x4a463a, skin: 0xc69a73, hat: 0x5a5446 },
};
// Captains wear a finer, richer coat with gold trim and a grander hat. Keyed by
// faction so a pirate captain reads differently from a naval one.
const CAPTAIN_PAL = {
  pirate:   { coat: 0x7a1f1f, trim: 0xe8c24a, skin: 0xc69a73, hat: 0x120c0a, plume: 0xb33b3b, feather: 0xf0e3c0 },
  military: { coat: 0x1d2f5e, trim: 0xf0cf66, skin: 0xc69a73, hat: 0x101b36, plume: 0xe8c24a, feather: 0xffffff },
  merchant: { coat: 0x5a4824, trim: 0xe8c24a, skin: 0xc69a73, hat: 0x2e2412, plume: 0x8a6a2a, feather: 0xe8dcc0 },
  civilian: { coat: 0x6a6450, trim: 0xc8b070, skin: 0xc69a73, hat: 0x3a342a, plume: 0x9a8a5a, feather: 0xeee6cc },
};

function box(device, size, color, x, y, z) {
  const m = new Mesh(geometryFromData(device, boxData(size)), new LambertMaterial({ color }));
  m.position.set(x, y, z);
  return m;
}
function brightBox(device, size, color, x, y, z) {
  const m = new Mesh(geometryFromData(device, boxData(size)), new BasicMaterial({ color }));
  m.position.set(x, y, z);
  return m;
}

// Build a crew figure Group. Origin at the FEET (y=0), facing +Z. ~1.8 units
// tall to match the player's capsule. Returns the Group with `_swingArm` (the
// weapon arm, for a melee swing animation) and `_muzzle` (local muzzle point
// for ranged fire) attached.
export function buildCrewMesh(device, crewType = 'pirate', kind = 'melee', captain = false) {
  const p = captain ? (CAPTAIN_PAL[crewType] || CAPTAIN_PAL.pirate) : (PAL[crewType] || PAL.pirate);
  const g = new Group();
  g.frustumCulled = false;

  // Legs (two stubby boxes).
  g.add(box(device, [0.26, 0.7, 0.3], p.trim, -0.16, 0.35, 0));
  g.add(box(device, [0.26, 0.7, 0.3], p.trim,  0.16, 0.35, 0));
  // Hips / belt — captains get a gold sash.
  g.add(box(device, [0.62, 0.2, 0.36], captain ? p.trim : 0x2a1a10, 0, 0.78, 0));
  // Torso (coat).
  g.add(box(device, [0.6, 0.7, 0.36], p.coat, 0, 1.22, 0));
  // Shoulder line / collar trim.
  g.add(box(device, [0.66, 0.14, 0.4], p.trim, 0, 1.5, 0));
  // Head.
  g.add(box(device, [0.34, 0.34, 0.34], p.skin, 0, 1.78, 0));

  if (captain) {
    // ---- CAPTAIN: a grand plumed BICORNE worn athwart, gold epaulettes, a coat
    // trim stripe, and a slightly taller bearing. Reads as "the boss" at a glance.
    // Coat lapels (gold facings down the front).
    g.add(box(device, [0.12, 0.6, 0.02], p.trim, -0.16, 1.22, 0.19));
    g.add(box(device, [0.12, 0.6, 0.02], p.trim,  0.16, 1.22, 0.19));
    // Epaulettes (gold shoulder pads).
    g.add(box(device, [0.22, 0.12, 0.26], p.trim, -0.42, 1.52, 0.02));
    g.add(box(device, [0.22, 0.12, 0.26], p.trim,  0.42, 1.52, 0.02));
    // Bicorne hat: two raised peaks fore & aft + a brim, in the hat colour.
    g.add(box(device, [0.46, 0.1, 0.62], p.hat, 0, 2.0, 0));          // brim
    g.add(box(device, [0.4, 0.34, 0.18], p.hat, 0, 2.16, 0.26));      // front peak
    g.add(box(device, [0.4, 0.34, 0.18], p.hat, 0, 2.16, -0.26));     // rear peak
    g.add(box(device, [0.4, 0.16, 0.5], p.hat, 0, 2.18, 0));          // crown ridge
    // Gold cockade + a tall feather plume rising from the front.
    g.add(box(device, [0.14, 0.14, 0.14], p.trim, 0, 2.24, 0.34));
    g.add(brightBox(device, [0.08, 0.5, 0.08], p.plume, 0, 2.5, 0.3));   // plume shaft
    g.add(brightBox(device, [0.16, 0.22, 0.12], p.feather, 0, 2.78, 0.3)); // feather tip
  } else {
    // Regular crew: a plain tricorn slab.
    g.add(box(device, [0.5, 0.14, 0.5], p.hat, 0, 1.98, 0));
  }

  // Off arm (static).
  g.add(box(device, [0.18, 0.6, 0.2], p.coat, -0.4, 1.25, 0.02));

  // Weapon arm — pivots for a melee swing. Built as a sub-group hinged at the
  // shoulder so we can rotate the whole arm+weapon together.
  const arm = new Group();
  arm.position.set(0.4, 1.5, 0.04); // shoulder
  const upperArm = box(device, [0.18, 0.6, 0.2], p.coat, 0, -0.3, 0.0);
  arm.add(upperArm);
  let muzzleLocal;
  if (kind === 'ranged') {
    // Musket: a long thin barrel held forward.
    const barrel = new Mesh(geometryFromData(device, boxData([0.1, 0.1, 1.3])),
      new LambertMaterial({ color: 0x2b2b30 }));
    barrel.position.set(0, -0.5, 0.6);
    arm.add(barrel);
    const stock = box(device, [0.12, 0.16, 0.5], 0x4a3320, 0, -0.5, 0.05);
    arm.add(stock);
    muzzleLocal = new Vec3(0, -0.5, 1.25); // tip of the barrel, in arm space
  } else {
    // Cutlass: a bright blade.
    const blade = new Mesh(geometryFromData(device, boxData([0.08, 0.9, 0.12])),
      new BasicMaterial({ color: 0xd9dde2 }));
    blade.position.set(0, -0.95, 0.1);
    arm.add(blade);
    const guard = box(device, [0.22, 0.1, 0.22], 0xb8902f, 0, -0.5, 0.1);
    arm.add(guard);
    muzzleLocal = new Vec3(0, -1.3, 0.1);
  }
  g.add(arm);
  g._swingArm = arm;
  g._muzzleLocal = muzzleLocal; // in ARM space; world muzzle = arm.localToWorld
  g._kind = kind;
  return g;
}
