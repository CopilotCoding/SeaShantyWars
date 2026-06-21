import { PerspectiveCamera, Vec3 } from './engine.js';

// Spherical first-person camera: yaw/pitch in the player's local tangent frame,
// with a parallel-transported "north" so look direction stays continuous as the
// player walks over the planet's poles. Adapted from PlanetVoxel/camera.js.
export class Camera {
  constructor(renderer, signal) {
    this.renderer = renderer;
    this.camera = new PerspectiveCamera(renderer.device, {
      fov: 75 * Math.PI / 180,
      aspect: window.innerWidth / window.innerHeight,
      near: 0.3,
      far: 2000,
    });
    this.yaw   = 0;
    this.pitch = 0;
    this._fwd     = new Vec3(0, 0, -1);
    this._right   = new Vec3(1, 0, 0);
    this._up      = new Vec3(0, 1, 0);
    this._lookDir = new Vec3(0, 0, -1);
    this._north   = new Vec3(0, 0, -1);
    this._smoothAltitude = null;
    this.eyeHeight = 1.55; // eye at head height above the player's feet

    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.camera.setViewport(0, 0, window.innerWidth, window.innerHeight);
      renderer.setSize(window.innerWidth, window.innerHeight);
    }, { signal });
  }

  rotate(dx, dy) {
    this.yaw   += dx * 0.002;
    this.pitch -= dy * 0.002;
    this.pitch  = Math.max(-Math.PI / 2 + 0.05, Math.min(Math.PI / 2 - 0.05, this.pitch));
  }

  // up: the local "up" (planet-radial for on-foot; ship-up when standing on a
  // deck later). smoothAlt: whether to smooth the radial eye height (good for
  // terrain, off for ships which have their own motion).
  update(playerPos, playerUp, smoothAlt = true) {
    const up = playerUp.clone().normalize();
    this._up.copy(up);

    this._north.addScaledVector(up, -this._north.dot(up));
    if (this._north.lengthSq() < 1e-8) {
      const arb = Math.abs(up.x) < 0.9 ? new Vec3(1, 0, 0) : new Vec3(0, 0, 1);
      this._north.crossVectors(up, arb);
    }
    this._north.normalize();

    const baseRight = new Vec3().crossVectors(this._north, up).normalize();
    const baseFwd   = this._north.clone();

    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    const yawFwd   = baseFwd.clone().multiplyScalar(cy).addScaledVector(baseRight, sy);
    const yawRight = baseRight.clone().multiplyScalar(cy).addScaledVector(baseFwd.clone().negate(), sy);

    this._fwd.copy(yawFwd);
    this._right.copy(yawRight);

    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    this._lookDir.copy(yawFwd).multiplyScalar(cp).addScaledVector(up, sp).normalize();

    const eyePos = playerPos.clone().addScaledVector(up, this.eyeHeight);

    if (smoothAlt) {
      const altitude = eyePos.length();
      if (this._smoothAltitude === null) this._smoothAltitude = altitude;
      this._smoothAltitude += (altitude - this._smoothAltitude) * 0.3;
      eyePos.setLength(this._smoothAltitude);
    }

    // Screen shake: jitter the eye position along the local right/up axes by a
    // decaying random amount. addShake() bumps _shake; it decays over time.
    if (this._shake > 0.0001) {
      const s = this._shake;
      const jx = (Math.random() * 2 - 1) * s;
      const jy = (Math.random() * 2 - 1) * s;
      eyePos.addScaledVector(this._right, jx).addScaledVector(up, jy);
    }

    this.camera.position = eyePos;
    this.camera.up = up;
    this.camera.target = eyePos.clone().add(this._lookDir);
    this.camera.update();
  }

  // Free-orbit HELM camera with zoom. Full 360° yaw + free pitch around the ship;
  // scroll changes `helmDist` (0 = first person at the helm looking forward, up
  // to far third-person). `helmZoom(delta)` is fed from the wheel each frame.
  helmZoom(delta) {
    if (this._helmDist === undefined) this._helmDist = 1; // 0..1 (0=first person)
    // Scroll UP (delta<0) zooms IN (toward first person); scroll DOWN zooms out.
    this._helmDist = Math.max(0, Math.min(1, this._helmDist + delta * 0.0012));
  }

  updateHelm(ship) {
    if (this._helmDist === undefined) this._helmDist = 1;
    const up = ship.up.clone().normalize();
    const fwd = ship.forward.clone();
    const right = ship.right.clone();
    const len = ship.spec.length;

    // Orbit direction from yaw (full 360° around up) + pitch. Pitch can go well
    // BELOW the horizon (negative) so you can drop the camera under the waterline
    // to peek at the hull, and high overhead — clamped just shy of the poles.
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    const pitch = Math.max(-1.45, Math.min(1.45, this.pitch + 0.35));
    // Horizontal orbit dir (in the ship's tangent plane).
    let orbit = fwd.clone().multiplyScalar(-cy).addScaledVector(right, sy);
    orbit.addScaledVector(up, -orbit.dot(up));
    if (orbit.lengthSq() < 1e-6) orbit = right.clone();
    orbit.normalize();

    // Distance + height scale with the zoom level. At t=0 the camera is right at
    // the helm (first person); at t=1 it's a wide third-person.
    const t = this._helmDist;
    const dist = t * (len * 1.2 + 9);
    const height = 1.6 + t * (len * 0.45 + 5);

    let eyePos;
    if (t < 0.06) {
      // First person: stand at the helm at HEAD height above the DECK (the deck
      // sits above the waterline that ship.position is at, so add deck + eye).
      const deckY = (ship.deckLocalY ? ship.deckLocalY() : 1.5);
      eyePos = ship.position.clone()
        .addScaledVector(fwd, -len * 0.30)        // helm is aft
        .addScaledVector(up, deckY + 1.6);        // deck height + eye height
    } else {
      eyePos = ship.position.clone()
        .addScaledVector(orbit, dist * Math.cos(pitch))
        .addScaledVector(up, height + dist * Math.sin(pitch));
    }

    if (this._shake > 0.0001) {
      const s = this._shake;
      eyePos.addScaledVector(right, (Math.random()*2-1)*s).addScaledVector(up, (Math.random()*2-1)*s);
    }

    // First person looks forward along the aim (yaw/pitch); third person looks at
    // the ship (a touch ahead of center so you see over the bow).
    let target;
    if (t < 0.06) {
      // Aim direction from yaw/pitch in the ship frame.
      const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
      const aim = fwd.clone().multiplyScalar(cy).addScaledVector(right, -sy)
        .multiplyScalar(cp).addScaledVector(up, sp).normalize();
      target = eyePos.clone().add(aim);
    } else {
      target = ship.position.clone().addScaledVector(fwd, len * 0.15).addScaledVector(up, 1.5);
    }

    this._lookDir.copy(target).sub(eyePos).normalize();
    this._fwd.copy(fwd); this._right.copy(right); this._up.copy(up);
    this.camera.position = eyePos;
    this.camera.up = up;
    this.camera.target = target;
    this.camera.update();
  }

  // Add a screen-shake impulse (world units of jitter amplitude). Stacks; the
  // strongest wins. Call decayShake(dt) each frame.
  addShake(amount) { this._shake = Math.max(this._shake || 0, amount); }
  decayShake(dt) { if (this._shake) this._shake = Math.max(0, this._shake - dt * (this._shake * 4 + 0.6)); }

  getForwardDir() { return this._fwd.clone(); }
  getRightDir()   { return this._right.clone(); }
  getLookDir()    { return this._lookDir.clone(); }

  getRayFromCenter() {
    return { origin: this.camera.position.clone(), direction: this._lookDir.clone() };
  }
}
