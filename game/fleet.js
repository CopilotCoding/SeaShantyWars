import { Vec3 } from './engine.js';
import { VoxelShip as Ship } from './ship/voxelShip.js';
import { ShipAI } from './ai.js';
import { rollLoot } from './crews.js';
import { CrewParty } from './crew/crewParty.js';
import { SHIP_SPECS } from './ship/hull.js';

// A LIVING SEA: spawns and maintains a handful of enemy ships of varied crew
// types around the ocean, each with its own AI, all registered as combat
// targets. When a ship is sunk/captured (or looted and left), it's retired and
// a fresh one spawns elsewhere after a delay, so there's always prey + danger.

const SHIP_NAMES = [
  'The Black Verse', 'The Widow’s Cry', 'The Morning Star', 'The Salt Wraith',
  'The Gilded Maw', 'The Bonny Lass', 'The Tempest', 'The Drowned Crown',
  'The Iron Tide', 'The Rogue’s Wager', 'The Pale Albatross', 'The Stormcrow',
];
// Which hull classes each faction can sail, ordered weakest -> strongest. The
// fleet picks from a window of this list based on the player's current ship tier
// (see _pickSpec), so as you upgrade, tougher variants of each faction appear.
const SPEC_BY_CREW = {
  civilian: ['cutter', 'sloop', 'schooner'],
  merchant: ['sloop', 'schooner', 'brig', 'frigate', 'galleon'],
  // Pirates field a full range INCLUDING heavy hulls (a dread pirate galleon /
  // man-o-war) so they can stand up to the navy.
  pirate:   ['cutter', 'sloop', 'schooner', 'brig', 'frigate', 'galleon', 'manowar'],
  military: ['schooner', 'brig', 'frigate', 'galleon', 'manowar'],
};
// Weighted crew pool: a WARRING sea. PIRATES are the most common (they rule these
// waters), navy hunts them, with a minority of civilian/merchant prey to plunder.
const CREW_POOL = [
  'civilian', 'merchant', 'merchant',                       // some prey
  'pirate', 'pirate', 'pirate', 'pirate', 'pirate',         // pirates dominate the sea
  'military', 'military', 'military',                       // navy hunting them
];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

export class Fleet {
  // playerShip: the player's ship (AI targets it + combat target). isOpenSea/
  // findOpenWater: spawn-location helpers from main. combat: the Combat system.
  constructor(scene, ocean, planet, playerShip, combat, helpers, opts = {}) {
    this.scene = scene; this.ocean = ocean; this.planet = planet;
    this.playerShip = playerShip; this.combat = combat;
    this.isOpenSea = helpers.isOpenSea; this.findOpenWater = helpers.findOpenWater;
    this.maxShips = opts.maxShips || 3;
    this.ships = [];     // active enemy ships
    this.owned = [];     // ships the player has CAPTURED (still float + collide)
    this.ais = new Map();// ship -> ShipAI
    this.parties = new Map(); // ship -> CrewParty (defenders on its deck)
    this._respawnTimer = 0;
    this._usedNames = new Set();

    // Spawn the starting fleet, all at a safe distance (no spawn-camping).
    for (let i = 0; i < this.maxShips; i++) this._spawnOne();
  }

  _freshName() {
    const avail = SHIP_NAMES.filter(n => !this._usedNames.has(n));
    const name = avail.length ? pick(avail) : pick(SHIP_NAMES);
    this._usedNames.add(name);
    return name;
  }

  // The player's current ship tier (0..6), used to scale enemy strength.
  _playerTier() {
    const s = this.playerShip;
    const spec = s && s.spec;
    return spec && spec.tier != null ? spec.tier : 1;
  }

  // Pick a hull for a faction, biased toward the PLAYER's tier so enemies scale
  // with the player's ship. We aim a target tier a touch ABOVE the player's
  // (so there's always a step-up to fight for), then pick the class in the
  // faction's list whose tier is nearest a randomized target — giving a spread
  // around the current difficulty rather than always the exact same hull.
  _pickSpec(crew) {
    const list = SPEC_BY_CREW[crew] || ['brig'];
    const pt = this._playerTier();
    // Target tier: around the player's, leaning slightly higher, with spread.
    const target = pt + 0.5 + (Math.random() * 2 - 1) * 1.6; // ±~1.6 tiers
    let best = list[0], bestD = Infinity;
    for (const key of list) {
      const t = SHIP_SPECS[key] ? SHIP_SPECS[key].tier : 3;
      const d = Math.abs(t - target);
      if (d < bestD) { bestD = d; best = key; }
    }
    return best;
  }

  // Spawn one enemy ship in open water, at a safe distance from the player.
  _spawnOne() {
    if (this.ships.length >= this.maxShips) return;
    const dir = this._spawnDir();
    if (!dir) return;
    const crew = pick(CREW_POOL);
    // Pick a hull scaled to the player's current ship tier (stronger player =>
    // stronger enemies). A rare chance any merchant/navy fields their heaviest.
    let specKey = this._pickSpec(crew);
    if ((crew === 'merchant' || crew === 'military') && Math.random() < 0.12) {
      const list = SPEC_BY_CREW[crew];
      specKey = list[list.length - 1]; // their top-of-line (galleon / man-o-war)
    }
    // Sail color: pirates black, navy navy-blue, merchant warm, civilian pale.
    const sailColor = { pirate: 0x222226, military: 0x2b3a5a, merchant: 0x6a5a36, civilian: 0xb8b29a }[crew] || 0x2b2b2b;
    const ship = new Ship(this.scene, this.ocean, specKey, dir, this.planet, {
      name: this._freshName(), faction: 'enemy',
      sailColor, flagColor: crew === 'pirate' ? 0x111111 : 0x333333,
      crewType: crew, loot: rollLoot(crew),
    });
    ship.update(0);
    this.ships.push(ship);
    this.combat.targets.push(ship);
    // The AI sees ALL ships (player + every fleet ship) to pick hostile targets,
    // and the planet for terrain avoidance.
    this.ais.set(ship, new ShipAI(ship, () => this._allShips(), this.combat, this.planet));
    // Defenders on her deck (you must clear them to capture her).
    this.parties.set(ship, new CrewParty(this.scene, ship));
  }

  // Point the fleet at the player's CURRENT home ship. Must be called whenever
  // the home ship is replaced (a fresh starter sloop) or swapped (sailing out a
  // captured/stored ship), so AI targeting, spawn-distance, and SHIP-TO-SHIP
  // COLLISION all track the vessel you're actually in — otherwise the new ship
  // is invisible to the collision resolver (other ships sail right through it).
  setPlayerShip(s) { if (s) this.playerShip = s; }

  // Mark a world position as a SAFE ZONE (the player's cove): no enemy will spawn
  // within `radius` of it, so home stays a sanctuary.
  setSafeZone(worldPos, radius = 120) {
    this._safeZone = { pos: worldPos.clone(), radius };
    // Evict any ALREADY-spawned ships sitting inside the new safe zone (the
    // starting fleet spawns before the cove exists) — relocate them out to a
    // fresh spawn spot so home starts clear.
    for (const s of this.ships) {
      if (this._inSafeZone(s.position)) {
        const d = this._spawnDir();
        if (d) { s.dir.copy(d); s.position.copy(d).multiplyScalar(226); s.update(0); }
      }
    }
  }
  _inSafeZone(wp) {
    return this._safeZone && wp.clone().sub(this._safeZone.pos).length() < this._safeZone.radius;
  }

  // The crew party defending a given ship (or null).
  partyOf(ship) { return this.parties.get(ship) || null; }

  _disposeParty(ship) {
    const p = this.parties.get(ship);
    if (p) { p.dispose(); this.parties.delete(ship); }
  }

  // Fully remove a ship from the world: its meshes, combat target, AI and crew.
  _removeShip(s) {
    if (s.mesh) this.scene.remove(s.mesh);
    if (s.chestMesh) this.scene.remove(s.chestMesh);
    if (s.wheelMesh) this.scene.remove(s.wheelMesh);
    if (s.factionFlag) this.scene.remove(s.factionFlag);
    if (s._debris) for (const d of s._debris) if (d.mesh) this.scene.remove(d.mesh);
    this.combat.targets = this.combat.targets.filter(t => t !== s);
    this.ais.delete(s);
    this._disposeParty(s);
  }

  // Every ship in the world the AI should consider (player + fleet).
  _allShips() {
    // Enemy fleet + ALL of the player's ships (current hull + any captured/owned
    // ones), so the AI sees and engages whichever vessel you're actually sailing
    // after a ship swap — and treats your captured prizes as hostile too.
    const out = this.ships.slice();
    if (this.playerShip && !out.includes(this.playerShip)) out.push(this.playerShip);
    for (const o of this.owned) if (!out.includes(o)) out.push(o);
    return out;
  }

  _spawnDir() {
    const base = this.playerShip.position.clone().normalize();
    const SEA_R = 226;
    // Angular offset from the player -> world distance ≈ angle * SEA_R. Spawn
    // well away in a WIDE ring (angle 0.5..1.3 rad ≈ 110..290u) so a big fleet
    // has room to spread out and ships sail INTO view rather than on top of you.
    const MIN_PLAYER_DIST = 110; // hard minimum — NEVER spawn closer than this
    const minAng = 0.5, maxAng = 1.3;
    const t1 = new Vec3(0,1,0).cross(base); if (t1.lengthSq()<0.01) t1.set(1,0,0); t1.normalize();
    const t2 = new Vec3().crossVectors(base, t1).normalize();
    // Pass 1: ideal spot — far from player, not clustered, not in the cove zone.
    // Pass 2 (fallback): relax the anti-cluster spacing but KEEP the player
    // distance + safe-zone rules, so we never spawn a ship in your lap.
    for (let pass = 0; pass < 2; pass++) {
      const minSpacing = pass === 0 ? 70 : 24;
      for (let tries = 0; tries < 120; tries++) {
        const a = minAng + Math.random() * (maxAng - minAng);
        const ang = Math.random() * Math.PI * 2;
        const d = base.clone().addScaledVector(t1, Math.cos(ang) * a).addScaledVector(t2, Math.sin(ang) * a).normalize();
        if (!this.isOpenSea(this.planet, d, 8)) continue;
        const wp = d.clone().multiplyScalar(SEA_R);
        if (this._inSafeZone(wp)) continue;                                   // cove sanctuary
        if (wp.clone().sub(this.playerShip.position).length() < MIN_PLAYER_DIST) continue; // never near you
        let tooClose = false;
        for (const s of this.ships) if (s.position.clone().sub(wp).length() < minSpacing) { tooClose = true; break; }
        if (!tooClose) return d;
      }
    }
    return null; // couldn't place safely this tick — _spawnOne skips it
  }

  // The enemy ship nearest the player (for HUD targeting). Null if none.
  nearest() {
    let best = null, bestD = Infinity;
    for (const s of this.ships) {
      if (s._removed) continue;
      const d = s.position.clone().sub(this.playerShip.position).lengthSq();
      if (d < bestD) { bestD = d; best = s; }
    }
    return best;
  }

  update(dt, audio, paused, playerSteering = null, boarding = null) {
    if (!paused) {
      for (const s of this.ships) {
        const ai = this.ais.get(s);
        if (ai) ai.update(dt, audio);
      }
    }
    for (const s of this.ships) s.update(dt);

    // ---- Defending crew ----
    // Update each ship's deck defenders. They only actively fight when the
    // player is aboard THAT ship (the member checks player.onShip), so this is
    // cheap for the rest of the fleet. `boarding` supplies the player + a
    // dealDamage(n) callback from main.
    if (!paused && boarding && boarding.player) {
      const ctx = { dealDamage: boarding.dealDamage, combat: this.combat, audio };
      for (const [s, party] of this.parties) party.update(dt, boarding.player, ctx);
    }
    // Captured ships keep floating + collidable. The one the PLAYER is steering
    // (`playerSteering`) is left alone (main.js drives its controls); the rest
    // drift dead in the water.
    for (const s of this.owned) {
      if (s !== playerSteering) s.setControls({ rudder: 0, sailDelta: -1 });
      s.update(dt);
    }

    // Retire enemy ships: sunk husks removed; CAPTURED ones move to `owned`
    // (stay in the world, still float + collide, AND stay in combat.targets so
    // they can still be HIT — friendly fire applies to your own fleet too, so a
    // captured ship can be damaged/sunk like any other). Just stop their AI.
    for (let i = this.ships.length - 1; i >= 0; i--) {
      const s = this.ships[i];
      if (s.captured) {
        this.ais.delete(s);          // no longer an AI enemy...
        this._disposeParty(s);       // her crew is yours / overboard now
        this.ships.splice(i, 1);
        this.owned.push(s);          // ...but stays in combat.targets (still hittable)
        continue;
      }
      // WRECK CLEANUP: a useless wreck — a DISABLED (dismasted / sailless) hull
      // that's NEITHER captured NOR under tow — counts down a 60s scuttle timer,
      // then despawns so dead hulks don't litter the sea. A merely SURRENDERED but
      // still-seaworthy ship is a valid prize and is left alone (not a wreck). A
      // fully-sunk husk is removed the moment its sink animation finishes.
      // disabled-but-NOT-surrendered = a dismasted/sailless derelict (a true
      // wreck). surrendered ships are also `disabled` but are valid prizes, so we
      // exclude them.
      const isWreck = !s.captured && !s._towed && s.disabled && !s.surrendered;
      if (isWreck) s._wreckT = (s._wreckT || 0) + dt; else s._wreckT = 0;
      const gone = (s.sunk && s._removed) || (isWreck && s._wreckT > 60);
      if (gone) {
        this._removeShip(s);
        this.ships.splice(i, 1);
      }
    }

    // Clean up owned (captured) ships that have sunk.
    for (let i = this.owned.length - 1; i >= 0; i--) {
      const s = this.owned[i];
      if (s.sunk && s._removed) {
        this._removeShip(s);
        this.owned.splice(i, 1);
      }
    }

    // Ships bump each other.
    this._resolveShipCollisions(dt);

    // Respawn to keep the sea populated. With a big fleet, refill faster (and a
    // couple at a time when well below cap) so a chaotic battle that thins the
    // ranks recovers quickly instead of slowly draining the sea to empty.
    if (this.ships.length < this.maxShips) {
      this._respawnTimer -= dt;
      if (this._respawnTimer <= 0) {
        const deficit = this.maxShips - this.ships.length;
        const batch = Math.min(deficit, deficit > 4 ? 3 : 1);
        for (let i = 0; i < batch; i++) this._spawnOne();
        this._respawnTimer = 5;
      }
    }
  }

  // Push overlapping ships apart so they BUMP properly. Ships are long+thin, so
  // a single circle is wrong (half-length over-repels; beam-radius lets them
  // slide INTO each other end-to-end). Model each ship as a CAPSULE — a segment
  // along its keel (±~40% length) with radius ≈ half-beam — and resolve the
  // closest points between the two segments. The player ship is included.
  _resolveShipCollisions(dt) {
    const all = [this.playerShip, ...this.ships, ...this.owned];
    const halfLen = (s) => s.spec.length * 0.40;
    const radius  = (s) => s.spec.beam * 0.55;
    for (let a = 0; a < all.length; a++) {
      for (let b = a + 1; b < all.length; b++) {
        const A = all[a], B = all[b];
        if (A.sunk || B.sunk) continue;
        // TOWED ships never collide with anything (they're deliberately tethered
        // close behind the tug and positioned by updateTow). Letting them collide
        // would have the trailing prize bump and STALL the ship pulling it — which
        // read as "can't move while towing". They simply trail along instead.
        if (A._towed || B._towed) continue;
        // Each ship's keel segment endpoints (bow & stern) in world space.
        const a0 = A.position.clone().addScaledVector(A.forward,  halfLen(A));
        const a1 = A.position.clone().addScaledVector(A.forward, -halfLen(A));
        const b0 = B.position.clone().addScaledVector(B.forward,  halfLen(B));
        const b1 = B.position.clone().addScaledVector(B.forward, -halfLen(B));
        const [pA, pB] = closestPointsSegSeg(a0, a1, b0, b1);
        const delta = pB.clone().sub(pA);
        const dist = delta.length();
        const minDist = radius(A) + radius(B);
        if (dist >= minDist || dist < 1e-4) continue;
        // Gently separate the overlapping hulls — NO speed cancel (ships keep
        // their momentum and slide along each other). Clamp the per-frame push so
        // it can't teleport a ship when two are deeply overlapping.
        const n = delta.multiplyScalar(1 / dist); // contact normal, A -> B
        const sep = Math.min((minDist - dist) * 0.5, 0.6); // cap the nudge
        A.position.addScaledVector(n, -sep); A.position.setLength(A.position.length());
        B.position.addScaledVector(n,  sep); B.position.setLength(B.position.length());
        A.dir.copy(A.position).normalize();
        B.dir.copy(B.position).normalize();
      }
    }
  }
}

// Closest points between two 3D line segments [p1,q1] and [p2,q2].
// Returns [cA, cB] (Vec3). Standard clamped-parametric solution.
function closestPointsSegSeg(p1, q1, p2, q2) {
  const d1 = q1.clone().sub(p1);
  const d2 = q2.clone().sub(p2);
  const r = p1.clone().sub(p2);
  const a = d1.dot(d1), e = d2.dot(d2), f = d2.dot(r);
  let s, tt;
  if (a <= 1e-8 && e <= 1e-8) { s = 0; tt = 0; }
  else if (a <= 1e-8) { s = 0; tt = clamp01(f / e); }
  else {
    const c = d1.dot(r);
    if (e <= 1e-8) { tt = 0; s = clamp01(-c / a); }
    else {
      const bb = d1.dot(d2);
      const denom = a * e - bb * bb;
      s = denom > 1e-8 ? clamp01((bb * f - c * e) / denom) : 0;
      tt = (bb * s + f) / e;
      if (tt < 0) { tt = 0; s = clamp01(-c / a); }
      else if (tt > 1) { tt = 1; s = clamp01((bb - c) / a); }
    }
  }
  const cA = p1.clone().addScaledVector(d1, s);
  const cB = p2.clone().addScaledVector(d2, tt);
  return [cA, cB];
}
function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }
