import { Mesh, LambertMaterial, geometryFromData, cylinderData, Vec3 } from './engine.js';
import {
  PLAYER_SPEED, JUMP_FORCE, GRAVITY, SWIM_SPEED, SEA_LEVEL,
} from './constants.js';
import { pushOutOfSolid, snapToGround } from './player/collision.js';

// On-foot player for Sea Shanty Wars. Spherical gravity toward the planet
// center; walks on islands (voxel collision, reused from PlanetVoxel) and
// swims/bobs when in the ocean. Sailing a ship is a separate controller added
// in a later milestone; this is the "deckhand on land / swimmer in the drink".
export class Player {
  constructor(scene, planet, ocean) {
    this.scene  = scene;
    this.planet = planet;
    this.ocean  = ocean;
    // Ships the player can stand on / collide with (set by main). Ships are
    // "moving terrain": the player physics resolves against them exactly like
    // the planet, so walking the deck, jumping off, and climbing aboard are all
    // just normal movement — no special deck mode.
    this.ships  = [];
    this.onShip = null; // the ship we're currently standing on, or null

    // Spawn standing on the nearest island surface, found below.
    this.position  = new Vec3(0, SEA_LEVEL + 30, 0);
    this.up        = new Vec3(0, 1, 0);
    this._velVert  = 0;
    this._velH     = new Vec3();
    this.grounded  = false;
    this.inWater   = false;
    this.velocity  = new Vec3();

    this.mesh = new Mesh(
      geometryFromData(scene.device, cylinderData(0.28, 0.28, 1.0, 8)),
      new LambertMaterial({ color: 0x6b4a2f }),
    );
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  // Place the player on the nearest dry land at spawn (search outward radially
  // from a good guess, falling back to floating at sea level).
  spawnOnLand() {
    // Try a handful of directions; pick the first that's an island above water.
    const dirs = [];
    for (let i = 0; i < 200; i++) {
      const v = new Vec3(
        Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1,
      );
      if (v.lengthSq() < 0.01) continue;
      dirs.push(v.normalize());
    }
    for (const d of dirs) {
      const surf = this.planet.findSurface(d.clone().multiplyScalar(SEA_LEVEL + 20));
      if (surf.length() > SEA_LEVEL + 1.0) {
        this.position.copy(surf).addScaledVector(d, 1.0);
        this.up.copy(d);
        return true;
      }
    }
    // No land found nearby — bob at the surface.
    const d = new Vec3(0, 1, 0);
    this.position.copy(this.ocean.surfacePoint(d)).addScaledVector(d, 0.5);
    this.up.copy(d);
    return false;
  }

  update(dt, input, camera) {
    const planet = this.planet;
    const pos = this.position;

    this.up.copy(pos).normalize();
    const up = this.up;
    const fwd = camera.getForwardDir();
    const right = camera.getRightDir();

    // Are we in the water? Compare our radius to the local wave surface.
    const r = pos.length();
    const waveSurfaceR = this.ocean ? SEA_LEVEL + this.ocean.heightAt(up) : SEA_LEVEL;
    this.inWater = r < waveSurfaceR - 0.2;
    const submerged = r < waveSurfaceR - 1.0;

    // ---- Climbing the boarding ladder ----
    // If we're at a ship's ladder and holding forward/jump, climb up it: gain
    // upward velocity and a gentle inboard pull so we crest the rail gap onto
    // the deck. The ship-collision pass then lands us on the deck. This is the
    // only way back aboard from the water — handled here as plain movement.
    let climbing = false;
    const wantClimb = input.isDown('KeyW') || input.isDown('ArrowUp') || input.isDown('Space');
    if (wantClimb) {
      for (const ship of this.ships) {
        if (ship.atLadder && ship.atLadder(pos)) {
          climbing = true;
          this.inWater = false;
          // Climb STRAIGHT UP the webbing first; only pull INBOARD once you've
          // risen to the rail/deck height so you crest onto the deck. Pulling
          // inboard while still low shoved you THROUGH the thin hull wall (the
          // phase-through). The pull is also gentle so collision can keep up.
          const lp = ship.worldToLocal(pos, new Vec3());
          const deckY = ship.deckLocalY ? ship.deckLocalY() : 1.5;
          if (lp.y > deckY - 0.6) {              // near/above the rail top
            pos.addScaledVector(ship.right, -1.4 * dt);
          }
          break;
        }
      }
    }

    // Horizontal movement input projected onto the tangent plane.
    const moveVec = new Vec3();
    if (input.isDown('KeyW') || input.isDown('ArrowUp'))    moveVec.addScaledVector(fwd,  1);
    if (input.isDown('KeyS') || input.isDown('ArrowDown'))  moveVec.addScaledVector(fwd, -1);
    if (input.isDown('KeyA') || input.isDown('ArrowLeft'))  moveVec.addScaledVector(right,-1);
    if (input.isDown('KeyD') || input.isDown('ArrowRight')) moveVec.addScaledVector(right, 1);

    const speed = this.inWater ? SWIM_SPEED : PLAYER_SPEED;
    if (moveVec.lengthSq() > 0.001) {
      moveVec.projectOnPlane(up).normalize().multiplyScalar(speed);
      this._velH.lerp(moveVec, this.inWater ? 0.08 : 0.18);
    } else {
      this._velH.multiplyScalar(this.inWater ? 0.85 : 0.7);
      if (this._velH.lengthSq() < 0.0004) this._velH.set(0, 0, 0);
    }

    if (climbing) {
      // --- Climbing a ladder: steady upward ascent, gravity suspended ---
      this._velVert = 5.0; // m/s up the ladder
      this.grounded = false;
    } else if (this.inWater) {
      // --- Swimming / buoyancy ---
      // The player is slightly buoyant: a GENTLE restoring force toward the
      // surface plus water drag, so left alone they slowly bob up to float at
      // the waterline. But Shift (dive) easily overcomes it, so you can swim
      // down many meters and explore the seafloor.
      const floatTargetR = waveSurfaceR - 0.5;  // resting float line (head above water)
      const dr = floatTargetR - r;
      const diving = input.isDown('ShiftLeft') || input.isDown('ShiftRight');
      const ascending = input.isDown('Space');

      // Gentle passive buoyancy — only meaningful when not actively diving, and
      // weaker the deeper you are (so the seafloor is reachable and you don't
      // get yanked up from depth).
      const depth = Math.max(0, waveSurfaceR - r);
      const buoyancy = diving ? 0.4 : 2.2;       // much softer than before
      this._velVert += dr * buoyancy * dt;
      this._velVert *= Math.pow(0.12, dt);       // water drag (less aggressive)

      // Active vertical swim.
      if (ascending) this._velVert += 9 * dt;
      if (diving)    this._velVert -= 11 * dt;

      // Clamp swim speed so it feels like water, not flying.
      const maxSwim = 6;
      if (this._velVert >  maxSwim) this._velVert =  maxSwim;
      if (this._velVert < -maxSwim) this._velVert = -maxSwim;
      this.grounded = false;
    } else {
      // --- On land ---
      if (this._velH.length() > PLAYER_SPEED) this._velH.normalize().multiplyScalar(PLAYER_SPEED);
      if (this.grounded) {
        this._velVert = 0;
        if (input.isDown('Space')) { this._velVert = JUMP_FORCE; this.grounded = false; }
      } else {
        this._velVert -= GRAVITY * dt;
      }
    }

    // Integrate.
    pos.addScaledVector(this._velH, dt);
    pos.addScaledVector(up, this._velVert * dt);

    // Terrain collision (works the same on islands; underwater seafloor too).
    pushOutOfSolid(this, planet, up);
    if (!this.inWater && (this.grounded || this._velVert < 0)) {
      snapToGround(this, planet, up);
    } else if (!this.inWater) {
      this.grounded = false;
    }

    // ---- Ship collision (ships are moving terrain) ----
    this._collideShips(dt, up);

    this.velocity.copy(this._velH).addScaledVector(up, this._velVert);
    this.mesh.position.copy(pos);
  }

  // Resolve the player against every ship's collision body. Standing on a deck
  // sets grounded and rides the ship (platform velocity); walls block walking
  // off. Pure physics — no deck modes.
  //
  // Two things this gets right:
  //  1) STICKING: every frame, if the player is on/just above a ship's deck, we
  //     move them by that deck point's platform displacement BEFORE resolving —
  //     decided geometrically (not a stale latch), so you never get left behind
  //     as the ship sails or rocks.
  //  2) NO TUNNELING: collision is resolved in several iterations, against probe
  //     spheres at feet/knees/waist/chest/head, so a fast move can't slip past a
  //     thin rail between two probes or in one frame.
  _collideShips(dt, up) {
    const RAD = 0.34;
    // The LOWEST probe sits at hY == RAD so its sphere BOTTOM is exactly at the
    // feet plane — resting on a deck then lands the feet ON the deck surface
    // instead of floating ~0.25u above it (which made the eye tower over crew).
    const PROBES = [RAD, 0.7, 1.2, 1.6]; // heights along the body
    let landedOn = null;
    for (const ship of this.ships) {
      // Quick reject: far from the ship.
      const reach = ship.spec.length * 0.75 + 3;
      if (this.position.clone().sub(ship.position).lengthSq() > reach * reach) continue;

      // --- Ride the deck (sticking) + stable on-ship detection ---
      // If the player is standing on (or just above) this ship's deck footprint,
      // carry them along with the deck's motion this frame, and mark them as
      // ON this ship. This proximity test is STABLE frame-to-frame (unlike the
      // penetration test below), so onShip/grounded don't flicker while resting
      // on the deck.
      const standing = ship.deckPointBelow(this.position);
      if (standing) {
        const dr = this.position.length() - standing.length();
        if (dr > -0.4 && dr < 1.2) { // at/near deck height
          const pv = ship.platformVelocityAt(this.position, dt, new Vec3());
          this.position.addScaledVector(pv, dt);
          landedOn = ship;
          if (this._velVert <= 0.01) {
            this.grounded = true;
          }
        }
      }

      // --- Resolve penetration (no tunneling) ---
      // A few iterations so pushes don't fight each other and fast moves are
      // fully resolved.
      for (let iter = 0; iter < 3; iter++) {
        let any = false;
        for (const hY of PROBES) {
          const probe = this.position.clone().addScaledVector(up, hY);
          const hit = ship.collide(probe, RAD, new Vec3(), new Vec3());
          if (!hit) continue;
          any = true;
          this.position.addScaledVector(hit.normal, hit.depth);
          const vDotN = this._velH.dot(hit.normal);
          if (vDotN < 0) this._velH.addScaledVector(hit.normal, -vDotN);
          if (hit.normal.dot(ship.up) > 0.6) {
            if (this._velVert < 0) this._velVert = 0;
            this.grounded = true;
            landedOn = ship;
          } else if (this._velVert > 0 && hit.normal.dot(ship.up) < -0.6) {
            this._velVert = 0;
          }
        }
        if (!any) break;
      }

      // --- Seat the feet ON THE DECK, not on top of the bulwark rail ---
      // The rail is a 2-cell wall around the deck rim; the penetration probes
      // would stand you ON TOP of it (~1.2u up), so your eye towered over the
      // crew. If you're over the deck footprint and at/above deck height, pull
      // the feet DOWN to the deck surface (along the ship's up, so no sideways
      // shift), clamped to a small step per frame so it's smooth, never up.
      if (standing) {
        const sUp = ship.up;
        const aboveDeck = this.position.clone().sub(standing).dot(sUp); // >0 = above deck
        if (aboveDeck > 0.04 && aboveDeck < 1.6 && this._velVert <= 0.01) {
          const step = Math.min(aboveDeck, Math.max(aboveDeck * Math.min(1, dt * 18), 6 * dt));
          this.position.addScaledVector(sUp, -step);
          this.grounded = true;
          landedOn = ship;
        }
      }
    }
    this.onShip = landedOn;
  }
}
