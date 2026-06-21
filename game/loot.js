import { Mesh, Group, BasicMaterial, LambertMaterial, geometryFromData, boxData, Vec3 } from './engine.js';

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
