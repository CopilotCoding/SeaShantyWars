import { Vec3 } from './engine.js';
import { SEA_LEVEL } from './constants.js';
import { factionOf, isHostile, isPrey } from './crews.js';

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// ============================================================================
//  CONTEXT STEERING  (the standard, robust way games do boat/agent navigation
//  — Andrew Fray, "Context Steering: Behaviour-Driven Steering at the Macro
//  Scale", Game AI Pro 2). Instead of a reactive "turn-away" hack with escape
//  state machines (which oscillate and pin in coves), we build two maps over a
//  ring of N candidate headings around the ship:
//
//    * INTEREST map  — how much we WANT to travel each direction (toward a
//                      target, away from a threat, or keep our heading).
//    * DANGER map    — how blocked each direction is by shoals/land, probed
//                      from the actual seafloor the ship grounds on.
//
//  We then MASK out any slot whose danger exceeds a small threshold (and bleed
//  danger into neighbouring slots so we don't skim a coastline), and among the
//  surviving slots pick the one with the highest interest. We steer the rudder
//  toward that heading. This is a single pass per frame — no latches, no
//  reverse/forward oscillation, and it naturally rounds headlands and escapes
//  concave bays because a fully-blocked forward arc still leaves open slots
//  behind the ship to turn into.
// ============================================================================

const SLOTS = 16;                 // candidate headings around the compass
const SLOT_DIRS = [];             // unit (cosθ, sinθ) per slot, θ = forward+...
for (let i = 0; i < SLOTS; i++) {
  const a = (i / SLOTS) * Math.PI * 2;
  SLOT_DIRS.push([Math.cos(a), Math.sin(a)]);
}

export class ShipAI {
  constructor(ship, getShips, combat, planet = null) {
    this.ship = ship;
    this.getShips = getShips;
    this.combat = combat;
    this.planet = planet;
    this._fireCd = 0;
    this.engageRange = 75;
    this.standoff = 34;
    // Reusable per-frame scratch so we don't churn the GC every tick.
    this._interest = new Float32Array(SLOTS);
    this._danger = new Float32Array(SLOTS);
    // Slowly-varying patrol heading bias so an idle ship wanders smoothly.
    this._wander = Math.random() * Math.PI * 2;
  }

  // Nearest ship this one is hostile to (and that's alive/afloat).
  _findTarget() {
    const me = this.ship;
    const myFac = factionOf(me);
    let best = null, bestD = this.engageRange * this.engageRange * 1.6;
    for (const s of this.getShips()) {
      if (s === me || s.sunk || s.captured) continue;
      if (!isHostile(myFac, factionOf(s))) continue;
      const d = s.position.clone().sub(me.position).lengthSq();
      if (d < bestD) { bestD = d; best = s; }
    }
    return best;
  }

  // ---- DANGER MAP -----------------------------------------------------------
  // For each slot direction (in the ship's tangent plane), march outward and
  // find how soon the seafloor rises above the keel (the SAME shoal condition
  // the ship actually grounds on). Nearer hazard => higher danger for that slot.
  // The danger then BLEEDS into adjacent slots so the ship gives headlands a
  // wide berth instead of clipping them.
  _buildDanger(right, fwd, up) {
    const planet = this.planet;
    const danger = this._danger;
    danger.fill(0);
    if (!planet) return;
    const ship = this.ship;
    const SEA_R = SEA_LEVEL;
    // Keel radius: terrain rising to/above this grounds the ship.
    const keelR = SEA_LEVEL - ship.spec.depth * 0.55 - 5;
    // Look further the faster we go (more stopping distance), but always at
    // least a few ship-lengths so we react in time.
    const maxLook = ship.spec.length * 2.5 + 40 + Math.abs(ship.speed) * 4;
    const step = Math.max(5, ship.spec.length * 0.5);

    const raw = this._interest; // borrow as scratch for raw per-slot danger
    raw.fill(0);
    const d = new Vec3();
    const slotDir = new Vec3();
    for (let i = 0; i < SLOTS; i++) {
      const [c, s] = SLOT_DIRS[i];
      // Heading for this slot = forward rotated by the slot angle, in plane.
      slotDir.copy(fwd).multiplyScalar(c).addScaledVector(right, s);
      let hitAt = Infinity;
      for (let f = step; f <= maxLook; f += step) {
        d.copy(up).addScaledVector(slotDir, f / SEA_R); // shoalAt normalizes
        if (planet.shoalAt(d, keelR)) { hitAt = f; break; }
      }
      // 0 (clear) .. 1 (hazard right on the bow). Quadratic so far-off land
      // barely registers but near land dominates.
      if (hitAt !== Infinity) {
        const t = 1 - hitAt / maxLook;
        raw[i] = clamp(t * t, 0, 1);
      }
    }
    // Bleed each slot's danger into its neighbours (wider berth around capes).
    for (let i = 0; i < SLOTS; i++) {
      const v = raw[i];
      if (v <= 0) continue;
      danger[i] = Math.max(danger[i], v);
      const l = (i - 1 + SLOTS) % SLOTS, r = (i + 1) % SLOTS;
      const ll = (i - 2 + SLOTS) % SLOTS, rr = (i + 2) % SLOTS;
      danger[l] = Math.max(danger[l], v * 0.75);
      danger[r] = Math.max(danger[r], v * 0.75);
      danger[ll] = Math.max(danger[ll], v * 0.45);
      danger[rr] = Math.max(danger[rr], v * 0.45);
    }
  }

  // ---- INTEREST MAP ---------------------------------------------------------
  // Write a gradient of interest peaking in `desire` (a tangent-plane unit dir),
  // ramping down with the dot product, across all slots. `weight` scales it.
  _addInterest(desire, weight, right, fwd) {
    if (!desire || desire.lengthSq() < 1e-6) return;
    const interest = this._interest;
    for (let i = 0; i < SLOTS; i++) {
      const [c, s] = SLOT_DIRS[i];
      // Slot heading's dot with the desired direction.
      const dot = c * desire.dot(fwd) + s * desire.dot(right);
      if (dot > 0) interest[i] += dot * dot * weight; // forward-biased
    }
  }

  update(dt, audio) {
    const ship = this.ship;
    if (ship.sunk || ship.disabled || ship.surrendered || ship.captured) {
      ship.setControls({ rudder: 0, sailDelta: -1 });
      ship.reverse = false;
      return;
    }
    if (this._fireCd > 0) this._fireCd -= dt;

    const up = ship.dir.clone();
    const fwd = ship.heading.clone();
    const right = new Vec3().crossVectors(up, fwd).normalize();

    // --- Build the danger map first (it's the same regardless of intent). ---
    this._buildDanger(right, fwd, up);
    const danger = this._danger;
    const interest = this._interest;
    interest.fill(0);

    const target = this._findTarget();
    const prey = isPrey(factionOf(ship));
    let wantSail = 0.7;
    let combatSide = 0;     // which broadside to ready (set when hunting)

    if (target) {
      const toTarget = target.position.clone().sub(ship.position);
      const dist = toTarget.length();
      const dirTo = toTarget.addScaledVector(up, -toTarget.dot(up));
      if (dirTo.lengthSq() > 1e-6) dirTo.normalize();
      const rightDot = dirTo.dot(right);

      if (prey) {
        // FLEE: interest points directly AWAY from the threat.
        this._addInterest(dirTo.clone().multiplyScalar(-1), 3, right, fwd);
        wantSail = 1.0;
        // Fire only if cornered (threat close & roughly abeam).
        if (dist < this.standoff * 1.2 && Math.abs(rightDot) > 0.5) combatSide = rightDot >= 0 ? 1 : -1;
      } else if (dist > this.standoff * 1.25) {
        // HUNT — approach: interest toward the target.
        this._addInterest(dirTo, 3, right, fwd);
        wantSail = 0.75;
      } else {
        // HUNT — broadside: we want our SIDE facing the target. Bias interest
        // perpendicular to the bearing (whichever beam is closer) so we orbit
        // and present guns rather than ram bow-first.
        const beam = right.clone().multiplyScalar(rightDot >= 0 ? -1 : 1);
        this._addInterest(beam, 2.5, right, fwd);
        this._addInterest(dirTo, 0.8, right, fwd); // stay near
        wantSail = 0.4;
        if (Math.abs(rightDot) > 0.45) combatSide = rightDot >= 0 ? 1 : -1;
      }
    } else {
      // No hostiles: wander. Keep our heading with a slow drift so we explore
      // open water instead of spinning.
      this._wander += (Math.random() - 0.5) * dt * 0.6;
      const w = fwd.clone().multiplyScalar(Math.cos(this._wander * 0.3) * 0.3 + 1)
                .addScaledVector(right, Math.sin(this._wander) * 0.4);
      if (w.lengthSq() > 1e-6) w.normalize();
      this._addInterest(w, 1.5, right, fwd);
      this._addInterest(fwd, 1.0, right, fwd); // keep moving forward
      wantSail = 0.55;
    }

    // --- COMBINE: subtract danger, mask the blocked slots, pick the best. ---
    // A slot that's dangerous is removed from consideration entirely; among the
    // survivors we take the highest interest. If EVERYTHING is dangerous (boxed
    // in), fall back to the least-dangerous slot.
    const MASK = 0.35;
    let bestSlot = -1, bestScore = -Infinity;
    let safestSlot = 0, safestDanger = Infinity;
    for (let i = 0; i < SLOTS; i++) {
      if (danger[i] < safestDanger) { safestDanger = danger[i]; safestSlot = i; }
      if (danger[i] >= MASK) continue;            // masked out
      const score = interest[i] - danger[i] * 2;  // penalise mild danger too
      if (score > bestScore) { bestScore = score; bestSlot = i; }
    }
    const chosen = bestSlot >= 0 ? bestSlot : safestSlot;
    const boxedIn = bestSlot < 0;

    // The chosen heading as a tangent-plane unit vector.
    const [cc, ss] = SLOT_DIRS[chosen];
    const goDir = fwd.clone().multiplyScalar(cc).addScaledVector(right, ss);
    if (goDir.lengthSq() > 1e-6) goDir.normalize();

    // Steer toward goDir. rudder = -rightComponent turns the bow that way
    // (the ship rotates heading by -rudder about up; see voxelShip.update).
    const goRight = goDir.dot(right);
    const goFwd = goDir.dot(fwd);
    let rudder = clamp(-goRight * 2.5, -1, 1);
    // If the chosen heading is BEHIND us (sharp turn or boxed in), commit to a
    // full-rudder turn toward whichever side it lies on.
    const sharpTurn = goFwd < 0.35;
    if (sharpTurn) rudder = clamp(-Math.sign(goRight || 1), -1, 1);

    // Sail: ease off when turning hard or when danger is near, so the ship has
    // room to come about instead of barrelling into the shore mid-turn.
    const dangerAhead = danger[chosen] + Math.max(danger[(chosen + 1) % SLOTS], danger[(chosen - 1 + SLOTS) % SLOTS]);
    // Danger straight ahead of our CURRENT bow (slot 0) — the thing we'd ram if
    // we keep going. This is what should brake us, not the chosen-slot danger.
    const dangerFwd = danger[0];
    if (dangerAhead > 0.15) wantSail = Math.min(wantSail, 0.45);
    if (Math.abs(rudder) > 0.8) wantSail = Math.min(wantSail, 0.45);
    // Coming about: nearly stop forward way so the turn happens in place rather
    // than carrying us into the shore the bow is still pointed at.
    if (sharpTurn) wantSail = Math.min(wantSail, 0.2);

    // Reverse-assist when the bow is pressed toward shore (danger dead ahead)
    // and we must turn far to find open water. Backing down lets the bow swing
    // off the obstacle instead of grinding along it. Triggers on a hard turn
    // into near-bow danger, OR when fully boxed in — not just at a dead stop.
    if ((dangerFwd > 0.5 && sharpTurn) || (boxedIn && goFwd < 0)) {
      ship.reverse = true;
      ship.speed = -5;
      ship.setControls({ rudder, sailDelta: -dt }); // furl sail while backing
      return;
    }
    ship.reverse = false;

    const sailDelta = clamp(wantSail - ship.sailRaised, -1, 1) * dt * 0.8;
    ship.setControls({ rudder, sailDelta });

    // --- Fire if a broadside is lined up and in range. ---
    if (combatSide !== 0 && this._fireCd <= 0 && target) {
      const dist = target.position.clone().sub(ship.position).length();
      const canFire = prey ? dist < this.standoff * 1.2 : dist < this.engageRange;
      if (canFire && this.combat.fireBroadside(ship, combatSide, audio)) {
        this._fireCd = prey ? 6 : 4.5;
      }
    }
  }
}
