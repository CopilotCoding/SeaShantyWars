import { Mesh, Group, LambertMaterial, BasicMaterial, geometryFromData, boxData, cylinderData, Vec3, quatFromBasis } from './engine.js';
import { SEA_LEVEL } from './constants.js';

// THE PIRATE COVE — your one fixed home base. Found at world-gen in a sheltered
// spot (deep enough to sail into, tucked against an island so it reads as a
// hideout). It has a visible wooden DOCK on the water plus a tall sky BEACON so
// you can always find your way home, and a generous arrival radius. Sailing into
// it opens the cove menu (repair / store / sell / buy) — wired in main.js.
//
// Placement: we want water that is deep enough to enter but has LAND nearby (a
// cove, not the open sea). We scan directions, score by "navigable water with a
// coastline close by", and take the best near the player's start.

export class Cove {
  constructor(scene, planet, ocean, nearDir) {
    this.scene = scene;
    this.planet = planet;
    this.ocean = ocean;
    this.dockRadius = 26;   // sail within this of the cove to "arrive"
    this.dir = this._findSite(nearDir);          // unit direction of the cove
    this.position = this.dir.clone().multiplyScalar(SEA_LEVEL);
    this._build();
  }

  // Find a sheltered cove direction near `nearDir`: navigable water (deep enough)
  // with land close by on at least one side. Falls back to the start direction.
  _findSite(nearDir) {
    const base = (nearDir || new Vec3(0, 1, 0)).clone().normalize();
    const t1 = new Vec3(0, 1, 0).cross(base); if (t1.lengthSq() < 0.01) t1.set(1, 0, 0); t1.normalize();
    const t2 = new Vec3().crossVectors(base, t1).normalize();
    let best = null, bestScore = -Infinity;
    for (let i = 0; i < 600; i++) {
      // Search a ring fairly close to the player's start (angular ~0.05..0.5 rad).
      const a = 0.05 + Math.random() * 0.45;
      const ang = Math.random() * Math.PI * 2;
      const d = base.clone()
        .addScaledVector(t1, Math.cos(ang) * a)
        .addScaledVector(t2, Math.sin(ang) * a)
        .normalize();
      const depth = SEA_LEVEL - this.planet.surfaceRadius(d);
      if (depth < 5 || depth > 28) continue;       // navigable but not abyssal
      if (this.planet.isLand(d)) continue;          // must be water at the spot
      // Count nearby LAND directions (we want a coastline hugging the cove).
      const e1 = new Vec3(0, 1, 0).cross(d); if (e1.lengthSq() < 0.01) e1.set(1, 0, 0); e1.normalize();
      const e2 = new Vec3().crossVectors(d, e1).normalize();
      let landNear = 0, waterNear = 0;
      for (let k = 0; k < 12; k++) {
        const th = (k / 12) * Math.PI * 2;
        const rd = d.clone().addScaledVector(e1, Math.cos(th) * 0.04).addScaledVector(e2, Math.sin(th) * 0.04).normalize();
        if (this.planet.isLand(rd)) landNear++; else waterNear++;
      }
      // Want SOME land (shelter) but not be boxed in (need a way in).
      if (landNear < 2 || waterNear < 4) continue;
      // Prefer near the player start, with land on a few sides.
      const closeness = base.dot(d);               // 1 = right at start
      const score = closeness * 2 + landNear * 0.3 + Math.min(depth, 14) * 0.1;
      if (score > bestScore) { bestScore = score; best = d.clone(); }
    }
    if (best) return best;
    // Fallback: no sheltered spot found — at least pick the nearest plain OPEN
    // WATER to the start (never land, so the cove can't end up on a hill).
    for (let i = 0; i < 400; i++) {
      const a = 0.05 + Math.random() * 0.6, ang = Math.random() * Math.PI * 2;
      const d = base.clone().addScaledVector(t1, Math.cos(ang) * a).addScaledVector(t2, Math.sin(ang) * a).normalize();
      const depth = SEA_LEVEL - this.planet.surfaceRadius(d);
      if (!this.planet.isLand(d) && depth >= 5 && depth <= 28) return d;
    }
    return base.clone();
  }

  _build() {
    const device = this.scene.device;
    const g = new Group();
    g.frustumCulled = false;

    // Orient the dock to the local surface: up = radial, and a tangent for layout.
    const up = this.dir.clone();
    const t1 = new Vec3(0, 1, 0).cross(up); if (t1.lengthSq() < 0.01) t1.set(1, 0, 0); t1.normalize();

    // ---- Floating dock: a plank platform just above the waterline ----
    const dock = new Mesh(geometryFromData(device, boxData([10, 0.6, 5])),
      new LambertMaterial({ color: 0x5a3d22 }));
    dock.position.set(0, 0.4, 0);
    g.add(dock);
    // A couple of pilings.
    for (const x of [-4, 4]) for (const z of [-2, 2]) {
      const p = new Mesh(geometryFromData(device, cylinderData(0.35, 0.35, 3, 6)),
        new LambertMaterial({ color: 0x3a2814 }));
      p.position.set(x, -0.8, z);
      g.add(p);
    }
    // A little shack on the dock (the shipwright / store).
    const shack = new Mesh(geometryFromData(device, boxData([3.4, 2.6, 3])),
      new LambertMaterial({ color: 0x6b4a2c }));
    shack.position.set(-2.6, 2.0, 0);
    g.add(shack);
    const roof = new Mesh(geometryFromData(device, boxData([4, 0.5, 3.6])),
      new LambertMaterial({ color: 0x402a16 }));
    roof.position.set(-2.6, 3.5, 0);
    g.add(roof);

    // ---- A tall BEACON so you can always find home: a pole + glowing lantern,
    // plus a high banner pennant. The lantern uses BasicMaterial so it stays
    // bright (unlit) like a flame. ----
    const pole = new Mesh(geometryFromData(device, cylinderData(0.25, 0.25, 12, 6)),
      new LambertMaterial({ color: 0x2a1c0e }));
    pole.position.set(3.5, 6, 0);
    g.add(pole);
    const lantern = new Mesh(geometryFromData(device, boxData([1.1, 1.4, 1.1])),
      new BasicMaterial({ color: 0xffcf5c }));
    lantern.position.set(3.5, 12.4, 0);
    g.add(lantern);
    this._lantern = lantern;
    // A red pirate pennant up high (very visible from afar).
    const flag = new Mesh(geometryFromData(device, boxData([0.1, 1.2, 2.2])),
      new BasicMaterial({ color: 0x9a2222 }));
    flag.position.set(3.5, 10.5, 1.3);
    g.add(flag);

    // ---- A SKY MARKER: a bright vertical beam high above the cove, always
    // visible over the horizon so you can steer home from anywhere. ----
    const beam = new Mesh(geometryFromData(device, boxData([1.2, 60, 1.2])),
      new BasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.28, depthWrite: false }));
    beam.position.set(0, 32, 0);
    g.add(beam);
    this._beam = beam;

    // Seat the whole group at the cove, oriented to the planet surface.
    g.position.copy(this.position);
    // Orient local +Y to `up` (radial). Build a quaternion from the basis.
    const right = t1.clone();
    const fwd = new Vec3().crossVectors(right, up).normalize();
    const q = quatFromBasis(
      [right.x, right.y, right.z], [up.x, up.y, up.z], [fwd.x, fwd.y, fwd.z]);
    g.quaternion.set(q[0], q[1], q[2], q[3]);
    this.scene.add(g);
    this.group = g;
  }

  // Is a world position within the cove's arrival radius (on the water plane)?
  playerNear(worldPos) {
    return worldPos.clone().sub(this.position).length() < this.dockRadius;
  }

  // Distance from a world position to the cove (for HUD compass/among others).
  distanceTo(worldPos) { return worldPos.clone().sub(this.position).length(); }

  // Gentle idle animation (flicker the lantern/beacon). Call each frame.
  update(dt, t) {
    if (this._lantern) {
      const f = 0.85 + Math.sin(t * 6) * 0.1 + Math.random() * 0.05;
      this._lantern.scale.set(f, f, f);
    }
  }
}
