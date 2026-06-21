import {
  Group, Mesh, Vec3, Quat, quatFromBasis,
  BasicMaterial, LambertMaterial, geometryFromData, boxData,
} from '../engine.js';
import { SEA_LEVEL } from '../constants.js';
import { sampleOceanHeight } from '../ocean.js';
import { buildHull } from './hull.js';

// A ship: a rigid wooden hull (built in local ship space by buildHull) that
// floats on the wavy ocean and sails over the sphere. Buoyancy samples the wave
// surface at four points under the hull each frame so the boat bobs, pitches
// (bow/stern), and rolls (port/starboard) with the swell. Sailing moves a
// heading direction around the planet; the local frame is rebuilt from the
// ship's surface position + heading.
//
// Coordinate model:
//   - `dir`     : unit vector = the ship's position direction on the planet.
//   - up        : dir (radial).
//   - `heading` : a unit tangent vector (in the plane perpendicular to up) the
//                 bow points along. Steering rotates it about up.
//   - position  : dir * (SEA_LEVEL + waveHeight) + bob.
export class Ship {
  constructor(scene, ocean, specKey = 'sloop', startDir = null, planet = null, opts = {}) {
    this.scene = scene;
    this.ocean = ocean;
    this.planet = planet; // optional — enables running-aground collision
    this.name = opts.name || 'The Rusty Wench';
    this.faction = opts.faction || 'player'; // 'player' | 'enemy'

    const { group, spec, sailMeshes, flagMesh, cannons } = buildHull(scene.device, specKey, {
      sailColor: opts.sailColor,
      flagColor: opts.flagColor,
    });
    this.group = group;
    this.spec = spec;
    this.sailMeshes = sailMeshes;
    this.flagMesh = flagMesh;
    this.cannons = cannons || []; // [{ localPos, side }]
    scene.add(group);

    // Combat state.
    this.hp = spec.hp;
    this.maxHp = spec.hp;
    this.sunk = false;
    this._reload = 0; // seconds until the broadside can fire again

    // Place on the sphere. Default: a bit out to sea from the north pole.
    this.dir = (startDir ? startDir.clone() : new Vec3(0.15, 1, 0.1)).normalize();
    // Heading: an arbitrary tangent to start (pointing "east"-ish).
    this.heading = new Vec3();
    this._tangent(this.dir, this.heading);

    this.speed = 0;            // current forward speed (world units/sec)
    this.sailRaised = 0;       // 0..1 how much sail is set (throttle)
    this.rudder = 0;           // -1..1 steering input (smoothed)
    this._smoothUp = this.dir.clone();
    this._smoothPitch = 0;
    this._smoothRoll = 0;

    this.position = new Vec3();
    this.up = this.dir.clone();
    this.forward = this.heading.clone();
    this.right = new Vec3();

    this._tmpQ = new Quat();

    // ---- Collision body (axis-aligned boxes in LOCAL ship space) ----
    // These define the SOLID parts the player physics collides against, turning
    // the ship into "moving terrain": a deck slab to stand on + four bulwark
    // walls so you can't walk off the sides. Each box is {min:[x,y,z], max:[...]}.
    this.colliders = buildShipColliders(spec);
    // Previous-frame transform, to compute platform velocity at a point.
    this._prevPos = new Vec3();
    this._prevQ = new Quat();
    this._hasPrev = false;

    this.update(0); // place it immediately
  }

  // An arbitrary unit tangent at direction d (used to seed heading).
  _tangent(d, out) {
    const arb = Math.abs(d.y) < 0.9 ? new Vec3(0, 1, 0) : new Vec3(1, 0, 0);
    out.crossVectors(arb, d).normalize();
    return out;
  }

  // ---- Cannons ----
  // Fire the broadside on `side` (+1 starboard, -1 port). Returns an array of
  // { pos, dir } world muzzle origins + fire directions (outward + a little up),
  // or [] if reloading / sunk / no cannons on that side. Caller spawns the
  // cannonballs and the muzzle effects.
  fireBroadside(side) {
    if (this.sunk || this._reload > 0) return [];
    const shots = [];
    for (const c of this.cannons) {
      if (c.side !== side) continue;
      const pos = this.localToWorld(c.localPos, new Vec3());
      // Outward = side * shipRight, plus a slight upward arc.
      const dir = this.right.clone().multiplyScalar(side)
        .addScaledVector(this.up, 0.06).normalize();
      shots.push({ pos, dir });
    }
    if (shots.length) this._reload = 2.6; // broadside reload time
    return shots;
  }

  // Apply damage; returns true if this hit sinks the ship.
  damage(amount) {
    if (this.sunk) return false;
    this.hp = Math.max(0, this.hp - amount);
    if (this.hp <= 0) { this.sunk = true; return true; }
    return false;
  }

  // Blow a visible HOLE in the hull at a world impact point. We add a small
  // charred/dark disc + a black inner box in SHIP-LOCAL space (so it rides with
  // the ship) — a blocky "cannonball hole" that reads against the wood.
  addHole(worldPos, worldNormal) {
    if (!this._holeGroup) {
      this._holeGroup = new Group();
      this.group.add(this._holeGroup);
    }
    const l = this.worldToLocal(worldPos, new Vec3());
    // Black inner cavity (recessed into the hull a touch).
    const inner = new Mesh(
      geometryFromData(this.scene.device, boxData([0.9, 0.9, 0.9])),
      new BasicMaterial({ color: 0x0a0a0a }),
    );
    inner.position.set(l.x, l.y, l.z);
    this._holeGroup.add(inner);
    // Charred splinter ring (dark brown), slightly larger, offset outboard.
    const ring = new Mesh(
      geometryFromData(this.scene.device, boxData([1.3, 1.3, 0.25])),
      new LambertMaterial({ color: 0x241509 }),
    );
    // Orient the ring to face outward along the local normal.
    const ln = this.worldDirToLocal(worldNormal, new Vec3()).normalize();
    ring.position.set(l.x + ln.x * 0.2, l.y + ln.y * 0.2, l.z + ln.z * 0.2);
    this._holeGroup.add(ring);
    this.holes = (this.holes || 0) + 1;
  }

  // World direction -> ship-local direction (inverse of localDirToWorld).
  worldDirToLocal(d, out = new Vec3()) {
    return out.set(d.dot(this.right), d.dot(this.up), d.dot(this.forward));
  }

  // Begin sinking: the ship tilts and slips beneath the waves over a few
  // seconds, then is removed. `update()` drives the actual descent.
  beginSinking() {
    if (this._sinking) return;
    this._sinking = true;
    this._sinkT = 0;
  }

  // Steering/throttle input (called from the sailing controller).
  setControls({ rudder = 0, sailDelta = 0 } = {}) {
    this.rudder += (rudder - this.rudder) * 0.1;
    this.sailRaised = Math.max(0, Math.min(1, this.sailRaised + sailDelta));
  }

  // World position of a local-space deck point (for standing the player on deck).
  localToWorld(local, out = new Vec3()) {
    // Rotate local by orientation, then translate by ship position.
    out.copy(local).applyQuaternion(this._tmpQ).add(this.position);
    return out;
  }

  // Inverse: world point -> ship-local coordinates (X=beam, Y=up, Z=fwd).
  worldToLocal(world, out = new Vec3()) {
    out.copy(world).sub(this.position);
    // Project onto the (right, up, forward) basis.
    const x = out.dot(this.right);
    const y = out.dot(this.up);
    const z = out.dot(this.forward);
    return out.set(x, y, z);
  }

  // Transform a LOCAL direction (x=right, y=up, z=fwd) to a world direction.
  localDirToWorld(lx, ly, lz, out = new Vec3()) {
    return out.set(0, 0, 0)
      .addScaledVector(this.right, lx)
      .addScaledVector(this.up, ly)
      .addScaledVector(this.forward, lz);
  }

  // Collide a sphere (player) at world `pt` with radius `rad` against the ship's
  // local collision boxes. Returns the minimum-translation world `push` to move
  // the sphere out of the deepest box it overlaps, plus the world `normal` of
  // that push, or null if not touching. This is the "moving terrain" the player
  // physics resolves against — no special deck logic needed.
  collide(pt, rad, outPush = new Vec3(), outNormal = new Vec3()) {
    const l = this.worldToLocal(pt, new Vec3());
    let best = null;
    for (const b of this.colliders) {
      // Closest point on the (expanded by rad) box to l. If l is inside the
      // expanded box, compute per-axis penetration and pick the smallest.
      const minX = b.min[0] - rad, maxX = b.max[0] + rad;
      const minY = b.min[1] - rad, maxY = b.max[1] + rad;
      const minZ = b.min[2] - rad, maxZ = b.max[2] + rad;
      if (l.x < minX || l.x > maxX || l.y < minY || l.y > maxY || l.z < minZ || l.z > maxZ) continue;
      // Penetration depth to each face; push out along the min one.
      const pxp = maxX - l.x, pxn = l.x - minX;
      const pyp = maxY - l.y, pyn = l.y - minY;
      const pzp = maxZ - l.z, pzn = l.z - minZ;
      const cand = [
        { d: pxp, n: [ 1, 0, 0] }, { d: pxn, n: [-1, 0, 0] },
        { d: pyp, n: [ 0, 1, 0] }, { d: pyn, n: [ 0,-1, 0] },
        { d: pzp, n: [ 0, 0, 1] }, { d: pzn, n: [ 0, 0,-1] },
      ];
      let m = cand[0];
      for (const c of cand) if (c.d < m.d) m = c;
      if (!best || m.d < best.d) best = m;
    }
    if (!best) return null;
    // World push = local normal * depth, rotated into world via the basis.
    this.localDirToWorld(best.n[0], best.n[1], best.n[2], outNormal).normalize();
    outPush.copy(outNormal).multiplyScalar(best.d);
    return { push: outPush, normal: outNormal, depth: best.d };
  }

  // World velocity of the ship's surface at world point `pt` (how fast that bit
  // of deck is moving this frame) — so a player standing on it rides along.
  platformVelocityAt(pt, dt, out = new Vec3()) {
    if (!this._hasPrev || dt <= 0) return out.set(0, 0, 0);
    // Where was this same LOCAL point last frame? local = worldToLocal now;
    // prevWorld = prevPos + prevQ * local.
    const local = this.worldToLocal(pt, new Vec3());
    const prevWorld = local.clone().applyQuaternion(this._prevQ).add(this._prevPos);
    return out.copy(pt).sub(prevWorld).multiplyScalar(1 / dt);
  }

  // The local-space point where the helmsman stands (near the stern, on deck).
  helmLocal() {
    return new Vec3(0, this.spec.deckY + 0.05, -this.spec.length * 0.32);
  }

  // World position of the helm (player stands here while sailing).
  helmWorld(out = new Vec3()) { return this.localToWorld(this.helmLocal(), out); }

  // Is `worldPos` standing near the HELM (the wheel, aft on deck)? Used to offer
  // the "take the helm" prompt. The player must already be on the deck.
  canBoardFrom(worldPos) {
    const l = this.worldToLocal(worldPos, new Vec3());
    const helm = this.helmLocal();
    const dx = l.x - helm.x, dz = l.z - helm.z;
    const nearWheel = Math.hypot(dx, dz) < 3.2;
    const onDeckHeight = l.y > this.deckLocalY() - 1.0 && l.y < this.deckLocalY() + 3.0;
    return nearWheel && onDeckHeight;
  }

  // Deck top Y in ship-local space (the walkable floor height).
  deckLocalY() { return this.spec.deckY + 0.3; }

  // Is `worldPos` at the boarding ladder (starboard side, amidships gap)? If so
  // the player can climb up it out of the water. Returns true within the climb
  // volume on the outboard starboard face.
  atLadder(worldPos) {
    const l = this.worldToLocal(worldPos, new Vec3());
    const hx = this.spec.beam / 2;
    const nearStarboardFace = l.x > hx - 0.7 && l.x < hx + 1.2;
    const inGapZ = Math.abs(l.z) < 1.5;
    const climbableY = l.y > -2.2 && l.y < this.deckLocalY() + 0.4;
    return nearStarboardFace && inGapZ && climbableY;
  }

  // If `worldPos` is over the deck footprint, returns the WORLD position of the
  // deck surface directly "below" it (along ship-up), else null. Lets the player
  // controller stand the player on the moving deck.
  deckPointBelow(worldPos) {
    const l = this.worldToLocal(worldPos, new Vec3());
    const inset = 0.45; // stay inside the bulwarks
    if (Math.abs(l.x) > this.spec.beam * 0.5 - inset) return null;
    if (Math.abs(l.z) > this.spec.length * 0.5 - inset) return null;
    // Snap to deck surface height, keep x/z.
    const deckLocal = new Vec3(l.x, this.deckLocalY(), l.z);
    return this.localToWorld(deckLocal, new Vec3());
  }

  update(dt) {
    const ocean = this.ocean;
    const up = this.dir.clone(); // radial up

    if (this._reload > 0) this._reload = Math.max(0, this._reload - dt);

    // Snapshot the transform BEFORE moving, so platformVelocityAt() can measure
    // how far each bit of deck moved this frame (for riding the deck).
    this._prevPos.copy(this.position);
    this._prevQ.copy(this._tmpQ);
    this._hasPrev = true;

    // --- Sailing: advance heading position around the sphere ---
    // Rudder turns the heading about the up axis. Negated so D (rudder +1) turns
    // the bow to starboard (right) as expected.
    if (this.rudder !== 0) {
      const ang = -this.rudder * 0.6 * dt * (0.4 + this.speed * 0.08);
      rotateAboutAxis(this.heading, up, ang);
    }
    // Re-orthonormalize heading against up (numerical drift + as we move).
    this.heading.addScaledVector(up, -this.heading.dot(up));
    if (this.heading.lengthSq() < 1e-6) this._tangent(up, this.heading);
    this.heading.normalize();

    // Throttle toward sail setting; simple drag.
    const maxSpeed = 14 * this.spec.speed;
    const target = this.sailRaised * maxSpeed;
    this.speed += (target - this.speed) * Math.min(1, dt * 0.6);

    // Move the ship's surface direction FORWARD along the heading by arc length.
    // Rotating `dir` about axis (up × heading) by +arc tilts dir toward heading
    // (right-hand rule) — i.e. the ship advances bow-first. (Was negated, which
    // sailed it backwards.)
    if (this.speed !== 0) {
      const arc = (this.speed * dt) / SEA_LEVEL; // angle = distance / radius
      const moveAxis = new Vec3().crossVectors(up, this.heading).normalize();
      const prevDir = this.dir.clone();
      rotateAboutAxis(this.dir, moveAxis, arc);
      this.dir.normalize();

      // Run-aground collision: if the terrain at the new position rises above
      // the keel's draft depth (i.e. shallow enough to ground the hull), revert
      // the move and stop. Sample a point a bit ahead of the bow too so we don't
      // drive the prow into a beach.
      if (this.planet) {
        const draft = this.spec.depth * 0.55;
        const keelR = SEA_LEVEL - draft;
        const bowDir = this.dir.clone()
          .addScaledVector(this.heading, (this.spec.length * 0.5) / SEA_LEVEL)
          .normalize();
        const groundHere = this.planet.surfaceRadius(this.dir) > keelR;
        const groundBow  = this.planet.surfaceRadius(bowDir)   > keelR;
        if (groundHere || groundBow) {
          this.dir.copy(prevDir);     // can't advance into land
          this.speed = 0;
          this.sailRaised *= 0.5;     // sails luff when you hit the shore
          this._aground = true;
        } else {
          this._aground = false;
        }
      }
    }

    // --- Buoyancy: sample the wave surface under the hull at 4 points ---
    const t = ocean.time;
    const upN = this.dir.clone();              // refreshed radial up
    const fwd = this.heading.clone();
    fwd.addScaledVector(upN, -fwd.dot(upN)).normalize();
    const rightV = new Vec3().crossVectors(upN, fwd).normalize();

    const halfL = this.spec.length * 0.5;
    const halfB = this.spec.beam * 0.5;
    // Four sample directions (bow, stern, port, starboard) as small angular
    // offsets from the center direction along fwd/right.
    const sampleDir = (alongFwd, alongRight) => {
      const d = upN.clone()
        .addScaledVector(fwd, alongFwd / SEA_LEVEL)
        .addScaledVector(rightV, alongRight / SEA_LEVEL)
        .normalize();
      return SEA_LEVEL + sampleOceanHeight(d, t);
    };
    const rBow   = sampleDir( halfL, 0);
    const rStern = sampleDir(-halfL, 0);
    const rPort  = sampleDir(0, -halfB);
    const rStar  = sampleDir(0,  halfB);
    const rCenter = SEA_LEVEL + sampleOceanHeight(upN, t);

    // The hull's LOCAL ORIGIN (y=0) is the waterline by construction, so the
    // ride radius is basically the wave surface — only a small draft so the keel
    // dips a little into the water, not the whole lower hull.
    const draft = this.spec.depth * 0.12;
    let ridR = rCenter - draft; // radius the local origin (waterline) floats at

    // Sinking: slide beneath the waves over ~6s with a heavy list, then mark for
    // removal. Disable propulsion while going down.
    let sinkRoll = 0;
    if (this._sinking) {
      this._sinkT += dt;
      this.speed = 0; this.sailRaised = 0;
      const f = Math.min(1, this._sinkT / 6);
      ridR -= f * (this.spec.depth + 6);    // settle down past the keel depth
      sinkRoll = f * 0.9;                    // list hard to one side
      if (this._sinkT > 7 && !this._removed) {
        this._removed = true;
        this.group.visible = false;
      }
    }

    // Pitch (bow vs stern) and roll (port vs star) from the height differences,
    // converted to small tilt angles. Smoothed so the boat rocks, not jitters.
    const pitch = Math.atan2(rBow - rStern, this.spec.length);
    const roll  = Math.atan2(rStar - rPort, this.spec.beam) + sinkRoll;
    this._smoothPitch += (pitch - this._smoothPitch) * Math.min(1, dt * 4);
    this._smoothRoll  += (roll  - this._smoothRoll)  * Math.min(1, dt * 4);

    // --- Build orientation: tilt the (right,up,fwd) basis by pitch & roll ---
    const tiltedUp = upN.clone();
    const tiltedFwd = fwd.clone();
    const tiltedRight = rightV.clone();
    // pitch: rotate up/fwd about right axis
    rotateAboutAxis(tiltedUp,  rightV, -this._smoothPitch);
    rotateAboutAxis(tiltedFwd, rightV, -this._smoothPitch);
    // roll: rotate up/right about fwd axis
    rotateAboutAxis(tiltedUp,    tiltedFwd, this._smoothRoll);
    rotateAboutAxis(tiltedRight, tiltedFwd, this._smoothRoll);

    // Position: ride the wave surface.
    this.position.copy(upN).multiplyScalar(ridR);

    // Cache exposed frame for the camera/player-on-deck.
    this.up.copy(tiltedUp);
    this.forward.copy(tiltedFwd);
    this.right.copy(tiltedRight);

    // Orientation quaternion from the tilted basis (columns = right, up, fwd).
    const q = quatFromBasis(
      [tiltedRight.x, tiltedRight.y, tiltedRight.z],
      [tiltedUp.x, tiltedUp.y, tiltedUp.z],
      [tiltedFwd.x, tiltedFwd.y, tiltedFwd.z],
    );
    this._tmpQ.set(q[0], q[1], q[2], q[3]);
    this.group.quaternion.copy(this._tmpQ);
    this.group.position.copy(this.position);
  }
}

// Local-space solid boxes the player collides with. Mirrors hull.js's deck +
// bulwark layout. Keep these in sync with the visual hull. The starboard rail
// has a GAP amidships for the boarding ladder (so you can climb back aboard).
function buildShipColliders(spec) {
  const { length: L, beam: B, deckY } = spec;
  const hx = B / 2, hz = L / 2;
  // Collision rails are TALLER and THICKER than the visual rail so a fast move
  // can't punch through them or pop over the top (no tunneling). They extend
  // well above the visual rail and inward.
  const railH = 2.4, railT = 0.9;
  const deckTop = deckY + 0.3;     // walkable surface height (matches deck cap top)
  const gapHalf = 1.1;
  const boxes = [];
  const add = (cx, cy, cz, sx, sy, sz) => boxes.push({
    min: [cx - sx/2, cy - sy/2, cz - sz/2],
    max: [cx + sx/2, cy + sy/2, cz + sz/2],
  });
  // Deck slab: a thick solid block whose TOP is the floor (extends down into the
  // hull so you can't fall through; you stand on its top face).
  add(0, deckTop - 1.0, 0, B * 0.9, 2.0, L * 0.92);
  // Starboard rail: two segments leaving a boarding gap around z=0.
  const starLenFore = (hz - gapHalf);
  add( hx - railT/2, deckTop + railH/2,  (gapHalf + hz) / 2, railT, railH, starLenFore);
  add( hx - railT/2, deckTop + railH/2, -(gapHalf + hz) / 2, railT, railH, starLenFore);
  // Port + bow + stern: solid bulwarks.
  add(-hx + railT/2, deckTop + railH/2, 0, railT, railH, L * 0.96);
  add(0, deckTop + railH/2,  hz - railT/2, B * 0.9, railH, railT);
  add(0, deckTop + railH/2, -hz + railT/2, B * 0.9, railH, railT);
  return boxes;
}

// Rotate vector v about a unit axis by angle (in place), Rodrigues' formula.
function rotateAboutAxis(v, axis, angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  const dot = v.x * axis.x + v.y * axis.y + v.z * axis.z;
  // v*cos + (axis×v)*sin + axis*(axis·v)*(1-c)
  const cx = axis.y * v.z - axis.z * v.y;
  const cy = axis.z * v.x - axis.x * v.z;
  const cz = axis.x * v.y - axis.y * v.x;
  v.x = v.x * c + cx * s + axis.x * dot * (1 - c);
  v.y = v.y * c + cy * s + axis.y * dot * (1 - c);
  v.z = v.z * c + cz * s + axis.z * dot * (1 - c);
  return v;
}
