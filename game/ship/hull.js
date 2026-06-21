import {
  Mesh, Group, LambertMaterial, BasicMaterial, geometryFromData,
  boxData, cylinderData, Vec3,
} from '../engine.js';

// Builds a wooden ship as a Group of meshes in LOCAL SHIP SPACE:
//   +X = starboard (right beam), +Y = up, +Z = bow (forward).
// Local origin sits at the waterline, mid-ship. The Ship class transforms this
// whole group as a rigid body so the boat floats/sails/rocks as one unit.
//
// Geometry is intentionally simple/blocky (it reads as "wooden voxel ship") and
// cheap — boxes + a couple cylinders. A `spec` lets us make different ship
// classes (sloop/brig/galleon) by scaling the same parts. Decks/bulwarks form a
// walkable, fall-proof floor+walls the player can stand on (M2 walk-on-deck).

const WOOD       = 0x6b4a2c;
const WOOD_DARK  = 0x52381f;
const WOOD_LIGHT = 0x8a6438;
const DECK_COL   = 0x9c7b4a;
const SAIL_COL   = 0xe8e0cc;
const TRIM_COL   = 0x3a2a18;

// Ship classes, smallest/weakest to largest/strongest. `tier` orders them for
// difficulty scaling (the fleet spawns tougher hulls as the player's ship tier
// rises). The voxel builder is fully parametric off length/beam/masts/
// cannonsPerSide, so adding a class here is all that's needed for it to mesh,
// arm, and sail.
// `deckY` is the FREEBOARD — how high the main deck sits above the waterline
// (ships ride high out of the water). `cannonsPerSide` is the UPPER-deck battery;
// `lowerGunsPerSide` adds a second gun row down at the waterline (lower gun deck).
export const SHIP_SPECS = {
  // --- Tier 0: tiny & fast scouts ---
  cutter: {
    name: 'Cutter', tier: 0, length: 11, beam: 4.4, depth: 2.6, deckY: 2.4,
    mastH: 9, masts: [{ z: 0.5 }], crew: 3, hp: 220, speed: 1.15,
    cannonsPerSide: 2, lowerGunsPerSide: 0,
  },
  // --- Tier 1: small single-masted ---
  sloop: {
    name: 'Sloop', tier: 1, length: 14, beam: 5.2, depth: 3.0, deckY: 2.8,
    mastH: 11, masts: [{ z: 0.5 }], crew: 4, hp: 320, speed: 1.0,
    cannonsPerSide: 2, lowerGunsPerSide: 2,
  },
  // --- Tier 2: nimble two-master ---
  schooner: {
    name: 'Schooner', tier: 2, length: 17, beam: 5.8, depth: 3.2, deckY: 3.1,
    mastH: 13, masts: [{ z: 3 }, { z: -3 }], crew: 6, hp: 440, speed: 1.02,
    cannonsPerSide: 3, lowerGunsPerSide: 2,
  },
  // --- Tier 3: workhorse two-master ---
  brig: {
    name: 'Brig', tier: 3, length: 20, beam: 6.6, depth: 3.6, deckY: 3.5,
    mastH: 14, masts: [{ z: 3 }, { z: -4 }], crew: 8, hp: 580, speed: 0.92,
    cannonsPerSide: 4, lowerGunsPerSide: 3,
  },
  // --- Tier 4: heavy three-master warship ---
  frigate: {
    name: 'Frigate', tier: 4, length: 24, beam: 7.4, depth: 4.0, deckY: 3.9,
    mastH: 16, masts: [{ z: 6 }, { z: -1 }, { z: -7 }], crew: 11, hp: 820, speed: 0.86,
    cannonsPerSide: 5, lowerGunsPerSide: 4,
  },
  // --- Tier 5: fat treasure/war galleon ---
  galleon: {
    name: 'Galleon', tier: 5, length: 28, beam: 8.4, depth: 4.4, deckY: 4.3,
    mastH: 18, masts: [{ z: 7 }, { z: -1 }, { z: -8 }], crew: 14, hp: 1050, speed: 0.8,
    cannonsPerSide: 6, lowerGunsPerSide: 5,
  },
  // --- Tier 6: the dreaded ship of the line ---
  manowar: {
    name: 'Man-o-War', tier: 6, length: 34, beam: 9.8, depth: 5.0, deckY: 4.8,
    mastH: 21, masts: [{ z: 10 }, { z: 2 }, { z: -6 }, { z: -12 }], crew: 22, hp: 1700, speed: 0.74,
    cannonsPerSide: 8, lowerGunsPerSide: 7,
  },
};

function box(device, sx, sy, sz, color, pos, opts = {}) {
  const m = new Mesh(geometryFromData(device, boxData([sx, sy, sz])),
    new LambertMaterial({ color, ...opts }));
  m.position.set(pos[0], pos[1], pos[2]);
  return m;
}

// Returns { group, spec, sailMeshes, flagMesh }. `opts.sailColor` tints the
// sails (per-ship identity); `opts.flagColor` the jolly-roger field.
export function buildHull(device, specKey = 'sloop', opts = {}) {
  const spec = SHIP_SPECS[specKey] || SHIP_SPECS.sloop;
  const { length: L, beam: B, depth: D, deckY } = spec;
  const sailColor = opts.sailColor ?? SAIL_COL;
  const flagColor = opts.flagColor ?? 0x1a1a1a;
  const g = new Group();
  const sailMeshes = [];

  const hx = B / 2, hz = L / 2;

  // Vertical layout (local Y):
  //   keel bottom = -D ,  waterline = 0 ,  deck = deckY ,  rail top = deckY+railH
  // The hull is ONE CONTINUOUS solid shell of stacked layers from the keel all
  // the way up to the deck — no gap at the waterline (the earlier bug). Lower
  // layers narrow toward the keel and shorten toward bow/stern for a boat shape;
  // upper layers are full-beam so the deck sits flush on solid sides.
  const railH = 1.1;
  const deckThick = 0.3;
  // The solid hull stops just BELOW the deck so the deck cap sits cleanly on top
  // (no coplanar faces => no z-fighting). The deck's TOP is at deckTop.
  const deckTop = deckY + 0.3;
  const hullTop = deckTop - deckThick - 0.05; // hull ends below the deck's underside
  const layers = 10;
  const bottom = -D, span = hullTop - bottom;
  for (let i = 0; i < layers; i++) {
    // Each layer occupies [yLo, yHi); they BUTT exactly (no overlap) so no
    // coplanar side faces fight (the z-fighting bug).
    const yLo = bottom + (i / layers) * span;
    const yHi = bottom + ((i + 1) / layers) * span;
    const yc = (yLo + yHi) * 0.5;
    const h = yHi - yLo;
    // f01: 0 at keel bottom, 1 at hull top. Beam follows a smooth curve that's
    // a NARROW V at the keel and widens to full beam by the waterline — so the
    // bottom is a tapered keel, not a cube. ends (Z) also pinch low down.
    const f01 = (yc - bottom) / span;
    const beamCurve = Math.pow(Math.min(1, f01 / 0.55), 0.8); // 0..1 by mid-hull
    const taperX = 0.18 + 0.82 * beamCurve;  // keel ~18% beam, full up top
    const taperZ = 0.62 + 0.38 * beamCurve;  // pointed ends near keel
    const col = i < 3 ? WOOD_DARK : (i % 2 ? WOOD : WOOD_LIGHT);
    g.add(box(device, B * taperX, h, L * taperZ, col, [0, yc, 0]));
  }

  // ---- Pointed bow wedge (a prow) at +Z for a sharper silhouette.
  const prow = box(device, B * 0.4, span * 0.7, L * 0.14, WOOD,
    [0, bottom + span * 0.55, hz + L * 0.04]);
  g.add(prow);

  // ---- Deck: the walkable flat floor capping the hull. Its TOP sits at
  // deckTop, ABOVE the hull (which ends at hullTop), so no faces are coplanar.
  g.add(box(device, B * 0.96, deckThick, L * 0.98, DECK_COL, [0, deckTop - deckThick / 2, 0]));

  // ---- Bulwarks (solid railings) standing on the deck edge so you can't walk
  // off. These sit ABOVE the deck (deckY..deckY+railH). The STARBOARD rail has a
  // gap amidships for the boarding ladder (so you can climb back aboard).
  const railT = 0.35;
  const railY = deckTop + railH / 2; // rails stand ON the deck top
  const gapHalf = 1.1; // half-width of the boarding gap (in Z)
  // Starboard split into fore & aft segments, leaving a gap around z=0.
  const starLenFore = (hz - gapHalf);
  g.add(box(device, railT, railH, starLenFore, WOOD, [ hx - railT/2, railY,  (gapHalf + hz) / 2]));
  g.add(box(device, railT, railH, starLenFore, WOOD, [ hx - railT/2, railY, -(gapHalf + hz) / 2]));
  // Port + bow + stern: solid.
  g.add(box(device, railT, railH, L * 0.98, WOOD, [-hx + railT/2, railY, 0]));
  g.add(box(device, B * 0.96, railH, railT, WOOD, [0, railY,  hz - railT/2]));
  g.add(box(device, B * 0.96, railH, railT, WOOD, [0, railY, -hz + railT/2]));

  // ---- Boarding ladder / rope net on the starboard side at the gap. Visual:
  // two vertical ropes + rungs spanning from below the waterline up to the deck.
  const ladderX = hx + 0.04;
  const ladderTop = deckY + 0.2, ladderBot = -1.6;
  const ladderH = ladderTop - ladderBot, ladderYc = (ladderTop + ladderBot) / 2;
  const ropeCol = 0x6b5836;
  for (const zo of [-0.5, 0.5]) {
    g.add(box(device, 0.08, ladderH, 0.08, ropeCol, [ladderX, ladderYc, zo]));
  }
  const rungs = Math.max(4, Math.round(ladderH / 0.5));
  for (let i = 0; i <= rungs; i++) {
    const yy = ladderBot + (i / rungs) * ladderH;
    g.add(box(device, 0.14, 0.07, 1.2, ropeCol, [ladderX, yy, 0]));
  }

  // ---- Stern castle (a raised aft deck) for galleons/brigs — a chunky block.
  if (spec.masts.length >= 2) {
    const castH = 1.6;
    g.add(box(device, B * 0.8, castH, L * 0.2, WOOD_DARK, [0, deckY + castH/2, -hz + L * 0.12]));
    g.add(box(device, B * 0.78, 0.25, L * 0.2, DECK_COL, [0, deckY + castH + 0.1, -hz + L * 0.12]));
  }

  // ---- Masts + sails.
  for (const m of spec.masts) {
    const mast = new Mesh(
      geometryFromData(device, cylinderData(0.22, 0.28, spec.mastH, 8)),
      new LambertMaterial({ color: WOOD_DARK }),
    );
    mast.position.set(0, deckY + spec.mastH / 2, m.z);
    g.add(mast);

    // Yardarm (horizontal spar) + a rectangular sail hung below it.
    const yardY = deckY + spec.mastH * 0.7;
    const yard = new Mesh(
      geometryFromData(device, cylinderData(0.14, 0.14, B * 1.25, 6)),
      new LambertMaterial({ color: WOOD_DARK }),
    );
    yard.quaternion.setFromAxisAngle(new Vec3(0, 0, 1), Math.PI / 2); // lie along X
    yard.position.set(0, yardY, m.z);
    g.add(yard);

    const sailW = B * 1.15, sailH = spec.mastH * 0.5;
    const sail = new Mesh(
      geometryFromData(device, boxData([sailW, sailH, 0.12])),
      new LambertMaterial({ color: sailColor, side: 'double' }),
    );
    sail.position.set(0, yardY - sailH / 2 - 0.2, m.z);
    g.add(sail);
    sailMeshes.push(sail);
  }

  // ---- Jolly-roger flag at the top of the tallest (first) mast. A short pole +
  // a dark pennant; flagMesh is returned so the main loop can flutter it.
  let flagMesh = null;
  if (spec.masts.length) {
    const mz = spec.masts[0].z;
    const flagTop = deckY + spec.mastH + 0.2;
    const flagW = 2.2, flagH = 1.3;
    flagMesh = new Mesh(
      geometryFromData(device, boxData([flagW, flagH, 0.06])),
      new LambertMaterial({ color: flagColor, side: 'double' }),
    );
    // Flag flies off the mast top toward the stern (-Z), centered on its luff.
    flagMesh.position.set(0, flagTop, mz - flagW / 2 - 0.2);
    flagMesh.quaternion.setFromAxisAngle(new Vec3(0, 1, 0), Math.PI / 2); // span along Z
    g.add(flagMesh);
    // A skull blotch on the flag (a pale square) so it reads as a jolly roger.
    const skull = new Mesh(
      geometryFromData(device, boxData([0.5, 0.5, 0.02])),
      new LambertMaterial({ color: 0xe8e2d0, side: 'double' }),
    );
    skull.quaternion.copy(flagMesh.quaternion);
    skull.position.set(0.04, flagTop, mz - flagW / 2 - 0.2);
    g.add(skull);
  }

  // ---- Bowsprit (angled spar off the bow).
  const bowsprit = new Mesh(
    geometryFromData(device, cylinderData(0.16, 0.2, L * 0.4, 6)),
    new LambertMaterial({ color: WOOD }),
  );
  bowsprit.quaternion.setFromAxisAngle(new Vec3(1, 0, 0), Math.PI / 2.6);
  bowsprit.position.set(0, deckY + 0.6, hz + L * 0.12);
  g.add(bowsprit);

  // ---- Cannons: a row along each side, poking out through the bulwark. Each is
  // a dark cylinder (barrel) on a small carriage. We record each cannon's local
  // MUZZLE position + outward side so the Ship can fire broadsides from them.
  const cannons = [];
  const nPerSide = spec.cannonsPerSide || 0;
  const cannonY = deckTop + 0.35;
  const barrelLen = 1.1, barrelR = 0.16;
  for (const side of [1, -1]) {            // +1 starboard, -1 port
    for (let i = 0; i < nPerSide; i++) {
      const z = (nPerSide === 1) ? 0
        : ((i / (nPerSide - 1)) - 0.5) * (L * 0.7);
      const baseX = side * (hx - 0.35);
      // Carriage block.
      g.add(box(device, 0.5, 0.35, 0.6, TRIM_COL, [baseX - side * 0.1, cannonY - 0.1, z]));
      // Barrel — a cylinder lying along the ship's X (beam), poking outboard.
      const barrel = new Mesh(
        geometryFromData(device, cylinderData(barrelR, barrelR * 1.2, barrelLen, 8)),
        new LambertMaterial({ color: 0x2b2b2e }),
      );
      barrel.quaternion.setFromAxisAngle(new Vec3(0, 0, 1), Math.PI / 2); // lie along X
      barrel.position.set(baseX + side * (barrelLen * 0.25), cannonY, z);
      g.add(barrel);
      // Muzzle a bit beyond the barrel tip, the firing origin.
      cannons.push({
        localPos: new Vec3(baseX + side * (barrelLen * 0.5 + 0.2), cannonY, z),
        side, // outward direction is side * shipRight
      });
    }
  }

  return { group: g, spec, sailMeshes, flagMesh, cannons };
}
