import { Vec3, quatFromBasis } from '../engine.js';
import { buildCrewMesh } from './crewVoxel.js';

// One defending crew member standing on a ship's deck. It rides the deck (via
// the ship's platform velocity), moves in the deck's tangent plane toward the
// boarding player, and attacks: MELEE crew close to cutlass range and swing;
// RANGED crew hold off and fire musket shots. Each has hp and dies when shot or
// cut down by the player. Pure logic + a Group mesh positioned each frame.
//
// Positions are kept in WORLD space but constrained to the deck footprint so the
// figure can't walk off the hull. The owning CrewParty supplies the ship.

const MELEE_RANGE = 1.7;     // cutlass reach
const RANGED_STANDOFF = 7;   // muskets hold ~this far
const MOVE_SPEED = 2.6;      // deck shuffle speed

export class CrewMember {
  // ship: the VoxelShip this crew defends. localXZ: spawn spot on the deck
  // (deck-local x,z). kind: 'melee' | 'ranged'. crewType: faction (for color).
  constructor(scene, ship, localXZ, kind, crewType, captain = false) {
    this.scene = scene;
    this.ship = ship;
    this.kind = kind;
    this.crewType = crewType;
    this.captain = captain;
    // Captains are the toughest hands aboard — markedly more hp than regular crew.
    this.hp = captain ? 80 : (kind === 'ranged' ? 24 : 34);
    this.dead = false;
    this._attackCd = 0;
    this._swing = 0;       // melee swing animation phase (1 -> 0)
    this._localXZ = { x: localXZ.x, z: localXZ.z }; // current deck-local foot spot

    this.mesh = buildCrewMesh(scene.device, crewType, kind, captain);
    scene.add(this.mesh);
    this.position = new Vec3();   // world feet position (updated each frame)
    this._worldFromLocal();
  }

  // Current world foot position from the deck-local spot.
  _worldFromLocal() {
    const deckY = this.ship.deckLocalY();
    this.ship.localToWorld(new Vec3(this._localXZ.x, deckY, this._localXZ.z), this.position);
  }

  // Clamp a deck-local x,z to stay on the hull footprint (with a small inset).
  _clampToDeck(x, z) {
    const inset = 0.5;
    const hx = this.ship.spec.beam * 0.5 - inset;
    const hz = this.ship.spec.length * 0.5 - inset;
    return { x: Math.max(-hx, Math.min(hx, x)), z: Math.max(-hz, Math.min(hz, z)) };
  }

  // Drive this crew member. `player` is the on-foot player; `dealDamage(n,src)`
  // applies damage to the player; `combat`/`audio` for musket fire + SFX.
  // Returns nothing; sets this.dead when hp <= 0.
  update(dt, player, ctx) {
    if (this.dead) return;
    // Crew abandon a sinking/sunk ship (go down with her — just vanish).
    if (this.ship.sunk || this.ship._sinking) { this.dead = true; this._hide(); return; }
    if (this.hp <= 0) { this.dead = true; this._hide(); return; }
    if (this._attackCd > 0) this._attackCd -= dt;
    if (this._stagger > 0) this._stagger -= dt; // recovering from a parry

    // Resolve a mid-swing melee hit (deferred so the blade visibly connects).
    // Done in-update (not setTimeout) so it can't fire while paused.
    if (this._pendingHit > 0) {
      this._pendingHit -= dt;
      if (this._pendingHit <= 0) this._landMelee(player, ctx);
    }

    const ship = this.ship;

    // Where is the player, in this ship's deck-local frame?
    const pLocal = ship.worldToLocal(player.position, new Vec3());
    // Only engage a player who is actually ON this deck (aboard). Otherwise the
    // crew just holds station (idle guard).
    const playerAboard = player.onShip === ship &&
      Math.abs(pLocal.x) < ship.spec.beam * 0.5 + 1 &&
      Math.abs(pLocal.z) < ship.spec.length * 0.5 + 1;

    let tx = this._localXZ.x, tz = this._localXZ.z;
    if (playerAboard) {
      const dx = pLocal.x - this._localXZ.x;
      const dz = pLocal.z - this._localXZ.z;
      const distToPlayer = Math.hypot(dx, dz);
      if (this.kind === 'melee') {
        // Close to cutlass range, then swing. Staggered (just parried) crew can't
        // advance or swing for a beat.
        if (this._stagger > 0) {
          // hold — recovering
        } else if (distToPlayer > MELEE_RANGE * 0.7) {
          const inv = MOVE_SPEED * dt / (distToPlayer || 1);
          tx += dx * inv; tz += dz * inv;
        } else if (this._attackCd <= 0) {
          this._meleeSwing(player, ctx);
        }
      } else {
        // Ranged: get ONE musket shot off, then DRAW STEEL — a muzzle-loader takes
        // an age to reload, so after firing they switch to the cutlass and charge.
        if (this._firedMusket) {
          // Now a swordsman: close and swing (same as melee crew).
          if (this._stagger > 0) {
            // recovering
          } else if (distToPlayer > MELEE_RANGE * 0.7) {
            const inv = MOVE_SPEED * dt / (distToPlayer || 1);
            tx += dx * inv; tz += dz * inv;
          } else if (this._attackCd <= 0) {
            this._meleeSwing(player, ctx);
          }
        } else {
          // Hold standoff until they get their one shot off.
          if (distToPlayer < RANGED_STANDOFF * 0.7) {
            const inv = MOVE_SPEED * dt / (distToPlayer || 1);
            tx -= dx * inv; tz -= dz * inv;
          } else if (distToPlayer > RANGED_STANDOFF * 1.4) {
            const inv = MOVE_SPEED * 0.7 * dt / (distToPlayer || 1);
            tx += dx * inv; tz += dz * inv;
          }
          if (this._attackCd <= 0 && distToPlayer < RANGED_STANDOFF * 2) {
            this._musketFire(player, ctx);
            this._firedMusket = true; // spent — draw the cutlass from here on
          }
        }
      }
      // Face the player.
      this._faceLocal = Math.atan2(dx, dz);
    }

    const c = this._clampToDeck(tx, tz);
    this._localXZ.x = c.x; this._localXZ.z = c.z;
    this._worldFromLocal();

    // --- Pose the mesh: stand at the world foot spot, orient to the deck up +
    //     facing direction, animate a melee swing. ---
    this.mesh.position.copy(this.position);
    // Orient the figure: its local +Y to the ship's up, +Z to the facing dir.
    const up = ship.up.clone();
    const fwd = this._facingWorld(up);
    const r = new Vec3().crossVectors(up, fwd).normalize();   // +X (starboard)
    const q = quatFromBasis(
      [r.x, r.y, r.z], [up.x, up.y, up.z], [fwd.x, fwd.y, fwd.z]);
    this.mesh.quaternion.set(q[0], q[1], q[2], q[3]);

    // Arm pose: during WINDUP (_pendingHit) the blade rises back (telegraph the
    // incoming blow so the player can read & parry it); then it CHOPS forward as
    // the swing follows through (_swing decays).
    const arm = this.mesh._swingArm;
    if (arm) {
      let angle = 0;
      if (this._pendingHit > 0) {
        // 0.3s windup: arm rotates BACK (positive) to a cocked position.
        const wind = 1 - Math.max(0, this._pendingHit) / 0.3; // 0 -> 1
        angle = 0.9 * wind; // raise back up to ~0.9 rad
      } else if (this._swing > 0) {
        this._swing = Math.max(0, this._swing - dt * 7);
        // Chop down through the front (negative).
        angle = -1.4 * this._swing;
      }
      arm.quaternion.setFromAxisAngle(new Vec3(1, 0, 0), angle);
    }
  }

  _facingWorld(up) {
    const ship = this.ship;
    const f = ship.forward.clone();
    const r = ship.right.clone();
    const a = this._faceLocal || 0;
    // world facing = forward*cos(a) + right*sin(a), projected to tangent plane.
    const out = f.multiplyScalar(Math.cos(a)).addScaledVector(r, Math.sin(a));
    out.addScaledVector(up, -out.dot(up));
    if (out.lengthSq() < 1e-6) out.copy(ship.forward);
    return out.normalize();
  }

  _meleeSwing(player, ctx) {
    this._attackCd = 0.85;     // faster, more frantic exchanges
    this._swing = 1;
    // A readable WINDUP telegraph: the blade rises for ~0.3s before the blow
    // lands. This is the window in which the player can PARRY it with a sweep.
    this._pendingHit = 0.3;
  }

  // Is this crew member mid-swing with a blow about to land? (Used by the player
  // to PARRY: a player swing that catches an attacker in this window clashes
  // instead of trading damage.)
  isSwinging() { return !this.dead && this._pendingHit > 0; }

  // The player parried/blocked this swing: cancel the pending blow and stagger.
  parried() {
    this._pendingHit = 0;
    this._swing = 0.6;          // recoil pose
    this._attackCd = Math.max(this._attackCd, 0.6); // knocked off balance
    this._stagger = 0.35;       // briefly can't advance
  }

  // The swing connects: damage the player if still in cutlass range + aboard.
  _landMelee(player, ctx) {
    if (this.dead) return;
    const pLocal = this.ship.worldToLocal(player.position, new Vec3());
    const d = Math.hypot(pLocal.x - this._localXZ.x, pLocal.z - this._localXZ.z);
    if (d < MELEE_RANGE && player.onShip === this.ship) {
      ctx.dealDamage(9 + Math.random() * 4, this);
      if (ctx.audio && ctx.audio.playHurt) ctx.audio.playHurt();
    }
  }

  _musketFire(player, ctx) {
    this._attackCd = 2.0 + Math.random() * 1.0;
    // Hit chance falls off with distance + a base spread. Muzzle flash + report.
    const muzzle = this.position.clone().addScaledVector(this.ship.up, 1.4);
    if (ctx.combat && ctx.combat.spawnTracer) {
      ctx.combat.spawnTracer(muzzle, player.position.clone().addScaledVector(this.ship.up, 1.2));
    }
    if (ctx.audio && ctx.audio.playMusket) ctx.audio.playMusket(this.position);
    const pLocal = this.ship.worldToLocal(player.position, new Vec3());
    const d = Math.hypot(pLocal.x - this._localXZ.x, pLocal.z - this._localXZ.z);
    const hitChance = Math.max(0.15, 0.85 - d * 0.05);
    if (Math.random() < hitChance && player.onShip === this.ship) {
      ctx.dealDamage(11 + Math.random() * 6, this);
    }
  }

  // Take damage from the player's weapon. Returns true if this killed them.
  hurt(n) {
    if (this.dead) return false;
    this.hp -= n;
    if (this.hp <= 0) { this.dead = true; this._hide(); return true; }
    return false;
  }

  _hide() { if (this.mesh) this.mesh.visible = false; }
  remove() { if (this.mesh) { this.scene.remove(this.mesh); this.mesh = null; } }
}
