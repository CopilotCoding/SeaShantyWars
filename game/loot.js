import { Mesh, Group, BasicMaterial, LambertMaterial, geometryFromData, boxData, cylinderData, Vec3 } from './engine.js';

// A ship's STEERING WHEEL: a wooden ring with spokes that stick out past the rim
// (the classic ship's-wheel handles), mounted on a short binnacle post. Built as
// a Group so the ship can mount it at the helm and SPIN it with the rudder.
// `_wheel` is the spinning part (rim+spokes); rotate it about local Z.
export function buildHelmWheel(device) {
  const g = new Group();
  g.frustumCulled = false;
  // Binnacle post under the wheel.
  const post = new Mesh(geometryFromData(device, boxData([0.3, 1.1, 0.3])),
    new LambertMaterial({ color: 0x3a2814 }));
  post.position.set(0, 0.55, 0);
  g.add(post);
  // The spinning wheel sub-group, standing vertical (axis along +Z / fore-aft).
  const wheel = new Group();
  wheel.position.set(0, 1.25, 0);
  const RIM = 0.62;
  // Rim: a ring approximated by short box segments around a circle.
  const seg = 12;
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    const bar = new Mesh(geometryFromData(device, boxData([0.16, 0.16, 0.12])),
      new LambertMaterial({ color: 0x5a3d22 }));
    bar.position.set(Math.cos(a) * RIM, Math.sin(a) * RIM, 0);
    bar.quaternion.setFromAxisAngle(new Vec3(0, 0, 1), a);
    wheel.add(bar);
  }
  // Spokes + handles sticking out past the rim.
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const spoke = new Mesh(geometryFromData(device, boxData([0.1, RIM * 2.2, 0.1])),
      new LambertMaterial({ color: 0x6b4a2c }));
    spoke.quaternion.setFromAxisAngle(new Vec3(0, 0, 1), a);
    wheel.add(spoke);
  }
  // Hub.
  const hub = new Mesh(geometryFromData(device, cylinderData(0.18, 0.18, 0.2, 8)),
    new LambertMaterial({ color: 0x2a1c0e }));
  hub.quaternion.setFromAxisAngle(new Vec3(1, 0, 0), Math.PI / 2); // lay flat along Z
  wheel.add(hub);
  g.add(wheel);
  g._wheel = wheel;
  return g;
}

// A physical treasure chest that sits on a ship's deck. It's a SEPARATE little
// mesh (not part of the voxel hull), so it can be opened/emptied cleanly and
// can't be blown apart by a stray cannonball. The owning ship positions it each
// frame via its transform (chestLocal -> world), so it rides the deck.

export function buildChestMesh(device) {
  const g = new Group();
  g.frustumCulled = false;
  const body = new Mesh(geometryFromData(device, boxData([1.4, 0.9, 1.0])),
    new LambertMaterial({ color: 0x5a3b1c }));
  body.position.set(0, 0.45, 0);
  g.add(body);
  // Lid — pivots up when opened (we just lift/tilt it).
  const lid = new Group();
  const lidMesh = new Mesh(geometryFromData(device, boxData([1.5, 0.35, 1.1])),
    new LambertMaterial({ color: 0x7a5226 }));
  lidMesh.position.set(0, 0.18, 0);
  lid.add(lidMesh);
  lid.position.set(0, 0.9, -0.5); // hinge at the back top edge
  g.add(lid);
  g._lid = lid;
  // Gold band.
  const band = new Mesh(geometryFromData(device, boxData([1.5, 0.16, 1.08])),
    new LambertMaterial({ color: 0xe8c24a }));
  band.position.set(0, 0.55, 0);
  g.add(band);
  // Gold glint inside (shown when open).
  const glint = new Mesh(geometryFromData(device, boxData([1.05, 0.35, 0.65])),
    new BasicMaterial({ color: 0xffe27a }));
  glint.position.set(0, 0.55, 0);
  glint.visible = false;
  g.add(glint);
  g._glint = glint;
  return g;
}

// Open a chest mesh (lift/tilt the lid, reveal the glint).
export function openChestMesh(g) {
  if (!g) return;
  if (g._lid) g._lid.quaternion.setFromAxisAngle(new Vec3(1, 0, 0), -1.2); // lid flips back
  if (g._glint) g._glint.visible = true;
}
