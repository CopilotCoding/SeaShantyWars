import { Vec3 } from './engine.js';
import { VoxelShip as Ship } from './ship/voxelShip.js';
import { ShipAI } from './ai.js';
import { rollLoot } from './crews.js';
import { CrewParty } from './crew/crewParty.js';

// A LIVING SEA: spawns and maintains a handful of enemy ships of varied crew
// types around the ocean, each with its own AI, all registered as combat
// targets. When a ship is sunk/captured (or looted and left), it's retired and
// a fresh one spawns elsewhere after a delay, so there's always prey + danger.

const SHIP_NAMES = [
  'The Black Verse', 'The Widow’s Cry', 'The Morning Star', 'The Salt Wraith',
  'The Gilded Maw', 'The Bonny Lass', 'The Tempest', 'The Drowned Crown',
  'The Iron Tide', 'The Rogue’s Wager', 'The Pale Albatross', 'The Stormcrow',
];
const SPEC_BY_CREW = {
  civilian: ['sloop'],
  merchant: ['sloop', 'brig'],   // mostly small traders; brig occasionally
  pirate:   ['sloop', 'brig'],
  military: ['brig'],            // navy = the tough fight, but not a galleon spam
};
// Weighted crew pool: a WARRING sea — mostly pirates (raid everyone) and navy
// (hunt the pirates), with a minority of civilian/merchant prey to plunder. This
// keeps NPC-vs-NPC battles constant. Galleons only show as the occasional rare
// big-score (see _spawnOne).
const CREW_POOL = [
  'civilian', 'merchant', 'merchant',           // some prey to hunt/plunder
  'pirate', 'pirate', 'pirate',                 // lots of raiders (attack everyone)
  'military', 'military', 'military',            // strong navy presence to fight them
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

  // Spawn one enemy ship in open water, at a safe distance from the player.
  _spawnOne() {
    if (this.ships.length >= this.maxShips) return;
    const dir = this._spawnDir();
    if (!dir) return;
    const crew = pick(CREW_POOL);
    // 10% chance a merchant/navy is a fat GALLEON (a rare risky big-score).
    let specKey = pick(SPEC_BY_CREW[crew] || ['brig']);
    if ((crew === 'merchant' || crew === 'military') && Math.random() < 0.1) specKey = 'galleon';
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

  // The crew party defending a given ship (or null).
  partyOf(ship) { return this.parties.get(ship) || null; }

  _disposeParty(ship) {
    const p = this.parties.get(ship);
    if (p) { p.dispose(); this.parties.delete(ship); }
  }

  // Every ship in the world the AI should consider (player + fleet).
  _allShips() {
    const out = this.ships.slice();
    out.push(this.playerShip);
    return out;
  }

  _spawnDir() {
    const base = this.playerShip.position.clone().normalize();
    const SEA_R = 226;
    // Angular offset from the player -> world distance ≈ angle * SEA_R.
    // Spawn well away so ships sail INTO view rather than camping the spawn:
    //   minimum ~90 units, up to ~180. (angle 0.4 rad ≈ 90 units.)
    const minAng = 0.4, maxAng = 0.8;
    const t1 = new Vec3(0,1,0).cross(base); if (t1.lengthSq()<0.01) t1.set(1,0,0); t1.normalize();
    const t2 = new Vec3().crossVectors(base, t1).normalize();
    for (let tries = 0; tries < 60; tries++) {
      const a = minAng + Math.random() * (maxAng - minAng);
      const ang = Math.random() * Math.PI * 2;
      const d = base.clone().addScaledVector(t1, Math.cos(ang) * a).addScaledVector(t2, Math.sin(ang) * a).normalize();
      if (!this.isOpenSea(this.planet, d, 8)) continue;
      const wp = d.clone().multiplyScalar(SEA_R);
      // Don't spawn near the player OR clustered on another enemy.
      if (wp.clone().sub(this.playerShip.position).length() < 80) continue;
      let tooClose = false;
      for (const s of this.ships) if (s.position.clone().sub(wp).length() < 60) { tooClose = true; break; }
      if (!tooClose) return d;
    }
    return this.findOpenWater(this.planet);
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
      const gone = (s.sunk && s._removed) || (s.looted && s.surrendered &&
        s.position.clone().sub(this.playerShip.position).length() > 120);
      if (gone) {
        if (s.sunk && s._removed && s.mesh) this.scene.remove(s.mesh);
        if (s.chestMesh) this.scene.remove(s.chestMesh);
        this.combat.targets = this.combat.targets.filter(t => t !== s);
        this.ais.delete(s);
        this._disposeParty(s);
        this.ships.splice(i, 1);
      }
    }

    // Clean up owned (captured) ships that have sunk.
    for (let i = this.owned.length - 1; i >= 0; i--) {
      const s = this.owned[i];
      if (s.sunk && s._removed) {
        if (s.mesh) this.scene.remove(s.mesh);
        if (s.chestMesh) this.scene.remove(s.chestMesh);
        this.combat.targets = this.combat.targets.filter(t => t !== s);
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
