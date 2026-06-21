import { Vec3 } from '../engine.js';
import { CrewMember } from './crewMember.js';
import { crewComplement } from '../crews.js';

// The defending CREW of one ship: a small party of voxel figures scattered on
// the deck. Spawns from the ship's crewComplement (count + melee/ranged mix),
// updates each member when the player is aboard, and reports when the deck is
// CLEARED (all defenders down) — which is what unlocks capture.
//
// Civilians have ~1 weak hand; navy decks are a wall of musketmen + cutlasses.

export class CrewParty {
  constructor(scene, ship) {
    this.scene = scene;
    this.ship = ship;
    this.members = [];
    this._spawn();
  }

  _spawn() {
    const { melee, ranged } = crewComplement(this.ship.crewType);
    const beam = this.ship.spec.beam, length = this.ship.spec.length;
    // Scatter crew across the deck: ranged toward the stern/rails, melee forward
    // (so they rush boarders). A simple jittered grid keeps them spread out.
    const place = (kind, biasZ) => {
      const x = (Math.random() * 2 - 1) * (beam * 0.32);
      const z = biasZ + (Math.random() * 2 - 1) * (length * 0.18);
      this.members.push(new CrewMember(this.scene, this.ship, { x, z }, kind, this.ship.crewType));
    };
    for (let i = 0; i < melee; i++)  place('melee',  length * 0.08);
    for (let i = 0; i < ranged; i++) place('ranged', -length * 0.22);
  }

  // True if no defender is left standing.
  cleared() {
    for (const m of this.members) if (!m.dead) return false;
    return true;
  }

  aliveCount() {
    let n = 0;
    for (const m of this.members) if (!m.dead) n++;
    return n;
  }

  // The nearest LIVING crew member to a world point, within `maxDist`. Used by
  // the player's weapons to pick a target. Returns { member, dist } or null.
  nearestAlive(worldPos, maxDist = Infinity) {
    let best = null, bestD = maxDist;
    for (const m of this.members) {
      if (m.dead) continue;
      const d = m.position.clone().sub(worldPos).length();
      if (d < bestD) { bestD = d; best = m; }
    }
    return best ? { member: best, dist: bestD } : null;
  }

  // Every LIVING crew member within `range` of `origin` AND within `halfAngle`
  // (radians) of the `dir` you're facing — i.e. caught in a forward sword sweep.
  // `dir` should be a unit vector. Members are measured at chest height so a
  // ground-tracked foot position still registers. Returns an array of members.
  aliveInArc(origin, dir, range, halfAngle) {
    const out = [];
    const cosHalf = Math.cos(halfAngle);
    for (const m of this.members) {
      if (m.dead) continue;
      const to = m.position.clone().sub(origin);
      const dist = to.length();
      if (dist > range || dist < 1e-3) continue;
      to.multiplyScalar(1 / dist);
      if (to.dot(dir) >= cosHalf) out.push(m);
    }
    return out;
  }

  update(dt, player, ctx) {
    for (const m of this.members) m.update(dt, player, ctx);
  }

  // Remove all meshes (ship sunk / captured / despawned).
  dispose() {
    for (const m of this.members) m.remove();
    this.members.length = 0;
  }
}
