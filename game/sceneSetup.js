import {
  createDevice, SceneRenderer, Scene, Fog, Mesh, Group,
  AmbientLight, PointLight, BasicMaterial, PointsMaterial,
  Geometry, sphereData, geometryFromData, Vec3,
} from './engine.js';
import { PLANET_RADIUS, SEA_LEVEL, SKY_RADIUS } from './constants.js';

// Builds the renderer, scene, sky/stars, lighting rig (ambient + sun) and the
// atmosphere glow shell. Returns what the main loop needs to drive the
// day/night cycle. Mirrors PlanetVoxel/game/sceneSetup.js, retuned for a bright
// ocean world (blue sky-ish fog, a warm sun over the sea).
export async function setupScene() {
  const canvas = document.createElement('canvas');
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  document.body.insertBefore(canvas, document.body.firstChild);

  const device = await createDevice();
  const renderer = new SceneRenderer(device, canvas, { antialias: true });
  renderer.domElement = canvas;

  const scene = new Scene();
  scene.device = device;
  scene.background.setHex(0x8fc3e8);          // bright sky horizon
  scene.fog = new Fog(0x8fc3e8, 320, 760);    // hazy sea horizon

  // Stars (only visible on the night side / high up). Far points shell.
  const starVerts = [];
  for (let i = 0; i < 4000; i++) {
    const rr = SKY_RADIUS * 2.2 + Math.random() * 400;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    starVerts.push(
      rr * Math.sin(phi) * Math.cos(theta),
      rr * Math.sin(phi) * Math.sin(theta),
      rr * Math.cos(phi),
    );
  }
  const starGeo = new Geometry(device, { attributes: { position: { format: 'float32x3', data: new Float32Array(starVerts) } } });
  const stars = new Mesh(starGeo, new PointsMaterial({ color: 0xffffff, size: 1.4, depthWrite: false }));
  stars.frustumCulled = false;
  scene.add(stars);

  // Sun shadow map across the whole planet (terrain + ships cast/receive).
  renderer.enableShadows({
    size: 2048,
    bounds: {
      min: [-PLANET_RADIUS - 60, -PLANET_RADIUS - 60, -PLANET_RADIUS - 60],
      max: [ PLANET_RADIUS + 60,  PLANET_RADIUS + 60,  PLANET_RADIUS + 60],
    },
  });

  const ambientLight = new AmbientLight(0x6688aa, 0.35); // soft sky fill
  scene.add(ambientLight);

  const sunLight = new PointLight(0xfff2d8, 2.0, 0, 0);   // warm sun, no falloff
  scene.add(sunLight);

  const SUN_RADIUS = 34;
  const SUN_ORBIT = SKY_RADIUS * 3.2;

  const sunCoreMesh = new Group();
  sunCoreMesh.frustumCulled = false;
  const core = new Mesh(geometryFromData(device, sphereData(SUN_RADIUS, 20, 20)),
    new BasicMaterial({ color: 0xfff6e0, fog: false, castShadow: false }));
  core.frustumCulled = false;
  sunCoreMesh.add(core);
  const c1 = new Mesh(geometryFromData(device, sphereData(SUN_RADIUS * 1.6, 20, 20)),
    new BasicMaterial({ color: 0xffe6b0, transparent: true, opacity: 0.14, blending: 'additive', depthWrite: false, fog: false, castShadow: false }));
  c1.frustumCulled = false;
  sunCoreMesh.add(c1);
  scene.add(sunCoreMesh);

  const SUN_PERIOD = 240; // a leisurely day

  // Atmosphere glow — BackSide shell viewed from inside.
  const atmosMesh = new Mesh(
    geometryFromData(device, sphereData(SKY_RADIUS, 32, 32)),
    new BasicMaterial({ color: 0x6fa8d8, transparent: true, opacity: 0.10, side: 'back', blending: 'additive', depthWrite: false, castShadow: false }),
  );
  atmosMesh.frustumCulled = false;
  scene.add(atmosMesh);

  return {
    renderer, scene, device,
    ambientLight, sunLight, sunCoreMesh, atmosMesh,
    SUN_ORBIT, SUN_PERIOD,
  };
}

export function placeSun(sunCoreMesh, sunAngle, SUN_ORBIT) {
  const tilt = Math.PI / 6;
  sunCoreMesh.position.set(
    Math.cos(sunAngle) * SUN_ORBIT,
    Math.sin(sunAngle) * Math.sin(tilt) * SUN_ORBIT,
    Math.sin(sunAngle) * Math.cos(tilt) * SUN_ORBIT,
  );
}
