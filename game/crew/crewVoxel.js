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

function box(device, size, color, x, y, z) {
  const m = new Mesh(geometryFromData(device, boxData(size)), new LambertMaterial({ color }));
  m.position.set(x, y, z);
  return m;
}

// Build a crew figure Group. Origin at the FEET (y=0), facing +Z. ~1.8 units
// tall to match the player's capsule. Returns the Group with `_swingArm` (the
// weapon arm, for a melee swing animation) and `_muzzle` (local muzzle point
// for ranged fire) attached.
export function buildCrewMesh(device, crewType = 'pirate', kind = 'melee') {
  const p = PAL[crewType] || PAL.pirate;
  const g = new Group();
  g.frustumCulled = false;

  // Legs (two stubby boxes).
  g.add(box(device, [0.26, 0.7, 0.3], p.trim, -0.16, 0.35, 0));
  g.add(box(device, [0.26, 0.7, 0.3], p.trim,  0.16, 0.35, 0));
  // Hips / belt.
  g.add(box(device, [0.62, 0.2, 0.36], 0x2a1a10, 0, 0.78, 0));
  // Torso (coat).
  g.add(box(device, [0.6, 0.7, 0.36], p.coat, 0, 1.22, 0));
  // Shoulder line / collar trim.
  g.add(box(device, [0.66, 0.14, 0.4], p.trim, 0, 1.5, 0));
  // Head.
  g.add(box(device, [0.34, 0.34, 0.34], p.skin, 0, 1.78, 0));
  // Hat (tricorn-ish slab).
  g.add(box(device, [0.5, 0.14, 0.5], p.hat, 0, 1.98, 0));

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
