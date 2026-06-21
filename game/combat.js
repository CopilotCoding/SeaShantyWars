import { Mesh, Group, BasicMaterial, LambertMaterial, geometryFromData, sphereData, Vec3 } from './engine.js';
import { SEA_LEVEL, GRAVITY } from './constants.js';

// Cannonball / broadside combat. Manages a pool of ballistic cannonballs: spawn
// from a ship's muzzles, integrate under spherical gravity, and on impact with a
// target ship apply damage + blow a visible hull hole; on impact with the sea,
// splash. Muzzle smoke puffs are short-lived sprites.
//
// Kept renderer-light: a handful of reused sphere meshes for balls + puffs.

const BALL_SPEED = 60;     // initial muzzle speed (world units/s)
const BALL_R = 0.35;
const BALL_LIFE = 6;       // seconds before a ball despawns
const HIT_DAMAGE = 18;     // hull damage per cannonball
const BLAST_RADIUS = 1.2;  // a near-DIRECT hit: the ball must actually strike them

export class Combat {
  constructor(scene, ocean) {
    this.scene = scene;
    this.ocean = ocean;
    this.balls = [];   // active cannonballs
    this.puffs = [];   // smoke/splash puffs
    this.targets = []; // ships that can be hit (set by main)
    this._ballGeo = geometryFromData(scene.device, sphereData(BALL_R, 8, 8));
    this._puffGeo = geometryFromData(scene.device, sphereData(0.6, 6, 6));
  }

  // Fire a ship's broadside on `side` (+1 starboard / -1 port). Spawns a ball +
  // muzzle puff per cannon. Returns the number of shots fired (0 if reloading).
  fireBroadside(ship, side, audio) {
    return this._launch(ship, ship.fireBroadside(side), audio);
  }

  // Fire a single manned cannon.
  fireCannon(ship, cannon, audio) {
    return this._launch(ship, ship.fireCannon(cannon), audio);
  }

  _launch(ship, shots, audio) {
    for (const s of shots) {
      this._spawnBall(s.pos, s.dir.clone().multiplyScalar(BALL_SPEED), ship);
      // Muzzle flash (brief, bright) + a big lingering black-powder smoke bank.
      this._spawnPuff(s.pos, s.dir, 0xffcf6e, 0.12, { peakOpacity: 0.8, baseScale: 0.7 });
      this._spawnSmokeCloud(s.pos, s.dir);
    }
    // Cannon report originates at the firing ship — pass its position so the
    // boom is attenuated by distance from the listener (spatial audio).
    if (shots.length && audio) audio.playCannon(shots[0].pos || ship.position);
    return shots.length;
  }

  _spawnBall(pos, vel, ownerShip) {
    let m = this._ballPool && this._ballPool.pop();
    if (!m) m = new Mesh(this._ballGeo, new LambertMaterial({ color: 0x18181a }));
    m.visible = true;
    m.position.copy(pos);
    this.scene.add(m);
    this.balls.push({ mesh: m, pos: pos.clone(), vel: vel.clone(), life: BALL_LIFE, owner: ownerShip });
  }

  _spawnPuff(pos, dir, color, life, opts = {}) {
    // Soft cap: in a big fleet battle the smoke can balloon — retire the oldest
    // puffs so we never run unbounded.
    if (this.puffs.length > 320) {
      const old = this.puffs.shift();
      if (old && old.mesh) this.scene.remove(old.mesh);
    }
    const m = new Mesh(this._puffGeo, new BasicMaterial({ color, transparent: true, opacity: 0.7, depthWrite: false }));
    m.position.copy(pos);
    if (dir) m.position.addScaledVector(dir, 0.6);
    const base = opts.baseScale || 1;
    m.scale.set(base, base, base);
    this.scene.add(m);
    this.puffs.push({
      mesh: m, life, maxLife: life, grow: 1 + Math.random(),
      baseScale: base,
      peakOpacity: opts.peakOpacity ?? 0.7,
      expand: opts.expand ?? 1.5,        // how much it grows over its life
      rise: opts.rise ?? 1.5,            // vertical drift speed
      // A bit of lateral drift so a cloud billows rather than rising in a column.
      driftV: opts.drift || null,
    });
  }

  // A big BLACK-POWDER SMOKE CLOUD off a firing broadside: many overlapping grey
  // puffs that BALLOON outward and linger for seconds, drifting up and to
  // leeward — like the great banks of smoke in old naval-battle paintings.
  _spawnSmokeCloud(pos, dir) {
    const n = 7 + Math.floor(Math.random() * 4); // 7–10 puffs per gun cluster
    for (let i = 0; i < n; i++) {
      // Scatter the puffs around the muzzle, biased outboard along the gun line.
      const jitter = new Vec3(
        (Math.random() * 2 - 1) * 1.4,
        (Math.random() * 2 - 1) * 1.0,
        (Math.random() * 2 - 1) * 1.4,
      );
      const p = pos.clone().addScaledVector(dir, 0.8 + Math.random() * 2.5).add(jitter);
      // Greys from dark powder-smoke to pale, varied per puff.
      const g = 0.32 + Math.random() * 0.4;
      const color = (Math.round(g * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(g * 255);
      // Lateral drift mostly outboard + a touch random, so the bank rolls away.
      const drift = dir.clone().multiplyScalar(1.2 + Math.random() * 1.5)
        .add(new Vec3((Math.random() * 2 - 1) * 0.8, 0, (Math.random() * 2 - 1) * 0.8));
      this._spawnPuff(p, null, color, 3.5 + Math.random() * 2.5, {
        baseScale: 2.2 + Math.random() * 2.0,  // big to start
        peakOpacity: 0.55,
        expand: 3.5 + Math.random() * 2,        // balloon outward
        rise: 0.5 + Math.random() * 0.6,        // slow lazy rise
        drift,
      });
    }
  }

  // A musket shot's VFX: a bright muzzle flash at `from` and a thin smoke trail
  // toward `to`. Cheap — a couple of short-lived puffs (no ballistic ball; the
  // hit is resolved by the crew's hit-roll, not a projectile).
  spawnTracer(from, to) {
    const dir = to.clone().sub(from);
    const len = dir.length();
    if (len > 1e-3) dir.multiplyScalar(1 / len);
    // Muzzle flash.
    this._spawnPuff(from, dir, 0xffd27a, 0.12);
    // A few smoke wisps along the line of fire.
    for (let f = 1.5; f < len; f += Math.max(2, len / 5)) {
      this._spawnPuff(from.clone().addScaledVector(dir, f), null, 0x9a9a9a, 0.35);
    }
  }

  update(dt) {
    // ---- Cannonballs ----
    for (let i = this.balls.length - 1; i >= 0; i--) {
      const b = this.balls[i];
      b.life -= dt;
      // Spherical gravity toward planet center.
      const up = b.pos.clone().normalize();
      b.vel.addScaledVector(up, -GRAVITY * dt);
      b.pos.addScaledVector(b.vel, dt);
      b.mesh.position.copy(b.pos);

      let dead = b.life <= 0;

      // Hit the sea?
      const r = b.pos.length();
      const seaR = SEA_LEVEL + this.ocean.heightAt(up);
      if (!dead && r <= seaR) {
        this._spawnPuff(up.clone().multiplyScalar(seaR), null, 0xbfd8e6, 0.6);
        dead = true;
      }

      // Hit a target ship?
      if (!dead) {
        for (const ship of this.targets) {
          if (ship === b.owner || ship.sunk) continue;
          const hit = ship.collide(b.pos, BALL_R, new Vec3(), new Vec3());
          if (hit) {
            this._onHullHit(ship, b.pos.clone(), hit.normal.clone());
            dead = true;
            break;
          }
        }
      }

      if (dead) {
        this.scene.remove(b.mesh);
        b.mesh.visible = false;
        (this._ballPool || (this._ballPool = [])).push(b.mesh);
        this.balls.splice(i, 1);
      }
    }

    // ---- Puffs (smoke/splash) fade + rise + grow ----
    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const p = this.puffs[i];
      p.life -= dt;
      const f = Math.max(0, p.life / p.maxLife); // 1 fresh -> 0 gone
      // Smoke fades IN briefly then OUT, so a big cloud doesn't pop to full alpha.
      const fadeIn = Math.min(1, (1 - f) * 6);   // ramps up over the first ~1/6
      p.mesh.material.opacity = f * fadeIn * p.peakOpacity;
      const s = p.baseScale * (1 + (1 - f) * p.grow * p.expand);
      p.mesh.scale.set(s, s, s);
      // Drift upward (away from planet center) + optional lateral billow.
      p.mesh.position.addScaledVector(p.mesh.position.clone().normalize(), dt * p.rise);
      if (p.driftV) p.mesh.position.addScaledVector(p.driftV, dt);
      if (p.life <= 0) { this.scene.remove(p.mesh); this.puffs.splice(i, 1); }
    }
  }

  // A cannonball struck a ship's hull: carve a REAL voxel hole, damage it,
  // splinter puff. Voxel ships expose carveSphere(); fall back to addHole for
  // any legacy box ship.
  _onHullHit(ship, worldPos, normal) {
    // Splinter burst (several puffs) for a meaty hit.
    this._spawnPuff(worldPos, null, 0x6b4a2c, 0.5);
    this._spawnPuff(worldPos, normal, 0x8a6438, 0.4);
    if (ship.carveSphere) ship.carveSphere(worldPos, 2.2);
    else if (ship.addHole) ship.addHole(worldPos, normal);
    const result = ship.damage(HIT_DAMAGE); // 'sunk' | 'surrender' | false
    if (this.onHit) this.onHit(ship, worldPos, result);
    // A direct hit on a person at the impact point wounds them too — cannonballs
    // are lethal to crew/player, not just timber. (Near-direct only, no splash.)
    if (this.onImpact) this.onImpact(ship, worldPos, BLAST_RADIUS);
    if (result === 'sunk') ship.beginSinking();
  }
}
