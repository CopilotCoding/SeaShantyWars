import { Mesh, ShaderMaterial, Geometry, Vec3 } from './engine.js';
import { SEA_LEVEL, WAVE } from './constants.js';

// The ocean: a sphere shell at SEA_LEVEL whose surface is displaced by a sum of
// Gerstner wave trains, animated in a custom WGSL vertex shader. A matching
// CPU-side sampler (sampleOcean) evaluates the SAME wave field so ships float on
// exactly the surface the player sees.
//
// Wave model (per train): on the planet's tangent plane at a vertex, each train
// has a 2D direction (built from `angle` in a stable local tangent frame), a
// wavenumber k = 2π/wavelength, a phase speed, an amplitude, and a Gerstner
// "steepness" Q that pinches crests. We displace mostly radially (the visible
// up/down swell) plus a little tangential Gerstner sharpening.

const TRAINS = WAVE.trains;
const NUM = TRAINS.length;

// Each wave train gets a FIXED GLOBAL 3D direction (a unit vector), spread
// around so different trains travel different ways across the planet. Using a
// fixed global direction (instead of a per-vertex tangent direction) is what
// makes the waves actually ROLL across the sphere as coherent traveling bands —
// a per-vertex tangent basis flips as it sweeps the sphere and averages out into
// a uniform up/down heave (the bug). Derived deterministically from `angle` on
// a tilted great circle so they're varied but stable.
const WAVE_DIRS = TRAINS.map((w, i) => {
  const a = w.angle;
  const tilt = 0.5 + i * 0.35;
  const v = new Vec3(Math.cos(a), Math.sin(tilt) * 0.6, Math.sin(a));
  return v.normalize();
});

// CPU evaluation of the radial wave displacement (world units) at unit dir `d`
// and time `t`. Returns the height offset added to SEA_LEVEL along `d`.
// Used for buoyancy. MUST stay in lockstep with the WGSL waveHeight() below.
// Swell field — MUST match the WGSL swellField() exactly.
function swellFieldJS(x, y, z, t) {
  const px = x * 4.0, py = y * 4.0, pz = z * 4.0;
  return Math.sin(px * 1.7 + t * 0.07) * 0.6
       + Math.sin(py * 2.3 - t * 0.05 + 1.7) * 0.45
       + Math.sin((px + pz) * 1.1 + t * 0.04 + 4.0) * 0.5
       + Math.sin((py - pz) * 2.9 + 2.5) * 0.35
       + Math.sin((px - py) * 3.7 + t * 0.09) * 0.3;
}
function norm3(x, y, z) { const l = Math.hypot(x, y, z) || 1; return [x/l, y/l, z/l]; }

export function sampleOceanHeight(d, t) {
  const dir = d.clone().normalize();
  const s = swellFieldJS(dir.x, dir.y, dir.z, t);
  const s2 = swellFieldJS(dir.x*2.1+5, dir.y*2.1+5, dir.z*2.1+5, t*1.3);
  const swell = Math.max(0.1, Math.min(1.6, 0.45 + (s * 0.5 + s2 * 0.25)));
  let h = 0;
  for (let i = 0; i < NUM; i++) {
    const w = TRAINS[i];
    const k = (Math.PI * 2) / w.wavelength;
    const g0 = WAVE_DIRS[i];
    const g = norm3(g0.x + dir.x * (s*0.18) + s2*0.1, g0.y + dir.y * (s*0.18) + s2*0.1, g0.z + dir.z * (s*0.18) + s2*0.1);
    const phase = k * SEA_LEVEL * (dir.x*g[0] + dir.y*g[1] + dir.z*g[2]) - w.speed * k * t + s * 1.7;
    h += w.amplitude * Math.cos(phase);
  }
  const c1 = norm3(0.8, 0.3, -0.5), c2 = norm3(-0.4, 0.6, 0.7);
  const chop = Math.sin(SEA_LEVEL * (dir.x*c1[0]+dir.y*c1[1]+dir.z*c1[2]) * 0.9 - t * 6.0)
             * Math.sin(SEA_LEVEL * (dir.x*c2[0]+dir.y*c2[1]+dir.z*c2[2]) * 1.1 + t * 5.0) * 0.18;
  return (h + chop) * swell;
}

// Surface point + approximate normal for buoyancy/orientation. Returns world
// position on the wavy ocean for direction d at time t.
export function oceanSurfacePoint(d, t) {
  const dir = d.clone().normalize();
  const h = sampleOceanHeight(dir, t);
  return dir.multiplyScalar(SEA_LEVEL + h);
}

const oceanWGSL = /* wgsl */ `
struct Camera {
  viewMatrix: mat4x4f,
  projectionMatrix: mat4x4f,
  frustumPlanes: array<vec4f, 6>,
  viewport: vec4f,
};
struct U {
  sunDir: vec4f,       // xyz sun direction (from planet toward sun), w time
  params: vec4f,       // seaLevel, fogNear, fogFar, fogEnabled
  fogColor: vec4f,     // rgb + unused
  camPos: vec4f,       // xyz camera world pos
};
@group(0) @binding(0) var<uniform> camera: Camera;
@group(1) @binding(0) var<uniform> u: U;

// Per-train wave constants, baked in at build time as fixed-size arrays. Each
// train has a FIXED GLOBAL direction (gx,gy,gz) so waves roll across the sphere
// as coherent traveling bands (see WAVE_DIRS in the JS above).
const amp = array<f32, ${NUM}>(${TRAINS.map(w => fmt(w.amplitude)).join(', ')});
const wln = array<f32, ${NUM}>(${TRAINS.map(w => fmt(w.wavelength)).join(', ')});
const spd = array<f32, ${NUM}>(${TRAINS.map(w => fmt(w.speed)).join(', ')});
const gx = array<f32, ${NUM}>(${WAVE_DIRS.map(v => fmt(v.x)).join(', ')});
const gy = array<f32, ${NUM}>(${WAVE_DIRS.map(v => fmt(v.y)).join(', ')});
const gz = array<f32, ${NUM}>(${WAVE_DIRS.map(v => fmt(v.z)).join(', ')});

// Stable tangent basis at a unit direction (for the finite-difference normal).
struct Tangents { t1: vec3f, t2: vec3f, };
fn tangentBasis(n: vec3f) -> Tangents {
  var refv = vec3f(0.0, 1.0, 0.0);
  if (abs(n.y) >= 0.99) { refv = vec3f(1.0, 0.0, 0.0); }
  let t1 = normalize(cross(refv, n));
  let t2 = normalize(cross(n, t1));
  return Tangents(t1, t2);
}

// Low-frequency drifting field used to break up the otherwise-perfect wave grid.
// Must match the JS swellField() exactly.
fn swellField(dir: vec3f, t: f32) -> f32 {
  let p = dir * 4.0;
  return sin(p.x * 1.7 + t * 0.07) * 0.6
       + sin(p.y * 2.3 - t * 0.05 + 1.7) * 0.45
       + sin((p.x + p.z) * 1.1 + t * 0.04 + 4.0) * 0.5
       + sin((p.y - p.z) * 2.9 + 2.5) * 0.35
       + sin((p.x - p.y) * 3.7 + t * 0.09) * 0.3;
}

// Radial wave height at surface point (unit dir) and time. Matches the CPU
// sampleOceanHeight() exactly. To kill the "perfect grid" look:
//  - a strong spatial SWELL factor (choppy vs calm regions),
//  - per-position DIRECTIONAL JITTER (bend the wave dirs so crests aren't
//    straight parallel lines), and
//  - an extra fast small-scale CHOP term.
fn waveHeight(dir: vec3f, t: f32, seaLevel: f32) -> f32 {
  let s = swellField(dir, t);
  let s2 = swellField(dir * 2.1 + vec3f(5.0), t * 1.3);
  let swell = clamp(0.45 + (s * 0.5 + s2 * 0.25), 0.1, 1.6);
  var h = 0.0;
  for (var i = 0u; i < ${NUM}u; i = i + 1u) {
    let k = 6.28318530718 / wln[i];
    // Jitter the wave direction per-position so crests bend (not parallel lines).
    var g = vec3f(gx[i], gy[i], gz[i]);
    g = normalize(g + dir * (s * 0.18) + vec3f(s2 * 0.1));
    let phase = k * seaLevel * dot(dir, g) - spd[i] * k * t + s * 1.7;
    h = h + amp[i] * cos(phase);
  }
  // Small-scale chop on top (short wavelength, low amplitude) modulated by swell.
  let chop = sin(seaLevel * dot(dir, normalize(vec3f(0.8, 0.3, -0.5))) * 0.9 - t * 6.0)
           * sin(seaLevel * dot(dir, normalize(vec3f(-0.4, 0.6, 0.7))) * 1.1 + t * 5.0)
           * 0.18;
  return (h + chop) * swell;
}

// Sum of all wave amplitudes — the maximum possible crest height. Used to
// normalize the crest factor for foam.
const MAX_AMP = ${TRAINS.reduce((s, w) => s + w.amplitude, 0).toFixed(3)};

struct VOut {
  @builtin(position) position: vec4f,
  @location(0) worldPos: vec3f,
  @location(1) normal: vec3f,
  @location(2) viewDepth: f32,
  @location(3) crest: f32,   // 0..1 how near a wave crest this vertex is
};

@vertex
fn vertexMain(@location(0) p: vec3f, @location(1) n: vec3f, @location(2) uv: vec2f) -> VOut {
  var o: VOut;
  let seaLevel = u.params.x;
  let t = u.sunDir.w;
  let dir = normalize(p);
  let h = waveHeight(dir, t, seaLevel);
  let world = dir * (seaLevel + h);
  // Crest factor: how close this point's wave height is to the max crest.
  o.crest = clamp(h / max(MAX_AMP, 0.001), 0.0, 1.0);

  // Perturbed normal via finite differences along two tangent dirs. eps is an
  // angular step; ~0.015 rad ≈ 3.4 world units at this radius, enough to span a
  // fraction of the shortest wavelength so wave slopes shade as rolling swell.
  let tb = tangentBasis(dir);
  let eps = 0.015;
  let da = normalize(dir + tb.t1 * eps);
  let db = normalize(dir + tb.t2 * eps);
  let pa = da * (seaLevel + waveHeight(da, t, seaLevel));
  let pb = db * (seaLevel + waveHeight(db, t, seaLevel));
  var nrm = normalize(cross(pa - world, pb - world));
  if (dot(nrm, dir) < 0.0) { nrm = -nrm; }

  o.worldPos = world;
  o.normal = nrm;
  let view = camera.viewMatrix * vec4f(world, 1.0);
  o.viewDepth = -view.z;
  o.position = camera.projectionMatrix * view;
  return o;
}

@fragment
fn fragmentMain(i: VOut) -> @location(0) vec4f {
  var n = normalize(i.normal);
  let radial = normalize(i.worldPos);
  let viewDir = normalize(u.camPos.xyz - i.worldPos);
  // camAbove: camera farther from planet center than this fragment (looking
  // down at the top of the water) vs. underwater looking up.
  let camAbove = length(u.camPos.xyz) > length(i.worldPos);
  // Ensure n faces outward (radially), then flip to face the viewer's side.
  if (dot(n, radial) < 0.0) { n = -n; }
  let sunDir = normalize(u.sunDir.xyz);

  // Day/night hemisphere term: water on the sun side is lit.
  let hemi = clamp(dot(normalize(i.worldPos), sunDir) + 0.25, 0.0, 1.0);

  // Deep vs shallow water color, modulated by view angle (fresnel).
  let deep = vec3f(0.02, 0.12, 0.22);
  let shallow = vec3f(0.06, 0.32, 0.42);
  let fres = pow(1.0 - max(dot(n, viewDir), 0.0), 3.0);
  var col = mix(deep, shallow, clamp(dot(n, viewDir), 0.0, 1.0));
  col = mix(col, vec3f(0.45, 0.62, 0.72), fres * 0.6);

  // Diffuse sun.
  let ndl = max(dot(n, sunDir), 0.0);
  col = col * (0.25 + 0.9 * ndl * hemi);

  // Specular, foam + whitecaps ONLY when viewing the top from above. Looking
  // up/through the surface from underwater, the bright highlight would render as
  // sparse white triangles over the seafloor (the "white patches" bug).
  var foamAmt = 0.0;
  if (camAbove) {
    let halfv = normalize(sunDir + viewDir);
    let spec = pow(max(dot(n, halfv), 0.0), 90.0) * hemi;
    col += vec3f(1.0, 0.96, 0.85) * spec * 1.4;

    // Whitecaps: foam caps the upper portion of waves. Driven mainly by the
    // crest factor (how high this point rides on its wave) with a low threshold
    // so foam actually appears; surface steepness ADDS extra foam on wave faces
    // rather than gating it out.
    let steep = 1.0 - clamp(dot(n, normalize(i.worldPos)), 0.0, 1.0);
    let crestFoam = smoothstep(0.35, 0.85, i.crest);
    let steepFoam = smoothstep(0.02, 0.10, steep) * 0.5;
    let edge = smoothstep(0.75, 1.0, fres) * 0.2;
    foamAmt = clamp(crestFoam * 0.85 + steepFoam * crestFoam + edge, 0.0, 1.0);
    col = mix(col, vec3f(0.93, 0.96, 0.98) * (0.55 + 0.45 * hemi), foamAmt);
  }

  // Fog
  if (u.fogColor.w > 0.5 || u.params.w > 0.5) {
    let f = clamp((i.viewDepth - u.params.y) / max(u.params.z - u.params.y, 0.0001), 0.0, 1.0);
    col = mix(col, u.fogColor.rgb, f);
  }
  return vec4f(col, 1.0);
}
`;

function fmt(x) { return Number.isInteger(x) ? x.toFixed(1) : String(x); }

export class Ocean {
  constructor(scene) {
    this.scene = scene;
    this.time = 0;
    this.uniforms = {
      sunDir: new Vec3(0, 1, 0),
      camPos: new Vec3(),
      fog: null, // { color:{r,g,b}, near, far }
    };

    const device = scene.device;
    const geo = buildOceanSphere(device, SEA_LEVEL, 100);

    const self = this;
    const mat = new ShaderMaterial({
      wgsl: oceanWGSL,
      attributes: ['position', 'normal', 'uv'],
      uniformSize: 64, // 4 vec4
      updateUniforms: (view) => {
        const sd = self.uniforms.sunDir;
        view[0] = sd.x; view[1] = sd.y; view[2] = sd.z; view[3] = self.time;
        const fog = self.uniforms.fog;
        view[4] = SEA_LEVEL;
        view[5] = fog ? fog.near : 0;
        view[6] = fog ? fog.far : 1;
        view[7] = fog ? 1 : 0;
        view[8] = fog ? fog.color.r : 0; view[9] = fog ? fog.color.g : 0; view[10] = fog ? fog.color.b : 0; view[11] = fog ? 1 : 0;
        const cp = self.uniforms.camPos;
        view[12] = cp.x; view[13] = cp.y; view[14] = cp.z; view[15] = 0;
      },
      // Double-sided: the ocean is a closed shell, and a single cube-sphere's
      // 6 faces don't all wind CCW-from-outside — back-face culling would eat
      // whole patches (the "invisible ocean, see-through to the bottom" bug).
      side: 'double',
      castShadow: false,
      receiveShadow: false,
      // OPAQUE water: clean and reads as a proper sea. (Translucent water was
      // tried but a double-sided self-overlapping transparent shell causes
      // front/back blend banding + ship-sorting issues on this renderer — not
      // worth the rabbit hole. The opaque look is better.)
      depthWrite: true,
    });
    this.material = mat;

    const mesh = new Mesh(geo, mat);
    mesh.frustumCulled = false;
    scene.add(mesh);
    this.mesh = mesh;
  }

  update(dt, sunDir, camPos, fog) {
    this.time += dt;
    if (sunDir) this.uniforms.sunDir.copy(sunDir);
    if (camPos) this.uniforms.camPos.copy(camPos);
    if (fog !== undefined) this.uniforms.fog = fog;
  }

  // Buoyancy helpers (CPU), driven by the same time as the shader.
  heightAt(dir) { return sampleOceanHeight(dir, this.time); }
  surfacePoint(dir) { return oceanSurfacePoint(dir, this.time); }
}

// A cube-sphere at the given radius, as NON-INDEXED triangle soup — the engine's
// per-mesh ShaderMaterial draw path uses draw(vertexCount) and ignores index
// buffers, so we expand each quad into two triangles here. The shader recomputes
// positions/normals from the wave field, so we only need direction; normal/uv
// are placeholders (radial / zero).
function buildOceanSphere(device, radius, res) {
  const faceAxes = [
    { o: [ 1, 0, 0], u: [0, 0,-1], v: [0, 1, 0] },
    { o: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
    { o: [ 0, 1, 0], u: [1, 0, 0], v: [0, 0, 1] },
    { o: [ 0,-1, 0], u: [1, 0, 0], v: [0, 0,-1] },
    { o: [ 0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
    { o: [ 0, 0,-1], u: [-1,0, 0], v: [0, 1, 0] },
  ];
  const pos = [];
  const tmp = new Vec3();
  const dirAt = (f, ix, iy) => {
    const u = (ix / res) * 2 - 1;
    const v = (iy / res) * 2 - 1;
    return tmp.set(
      f.o[0] + f.u[0]*u + f.v[0]*v,
      f.o[1] + f.u[1]*u + f.v[1]*v,
      f.o[2] + f.u[2]*u + f.v[2]*v,
    ).normalize().clone();
  };
  for (const f of faceAxes) {
    for (let iy = 0; iy < res; iy++) {
      for (let ix = 0; ix < res; ix++) {
        const a = dirAt(f, ix, iy);
        const b = dirAt(f, ix + 1, iy);
        const c = dirAt(f, ix, iy + 1);
        const d = dirAt(f, ix + 1, iy + 1);
        // Two triangles (a,c,b) (b,c,d), CCW seen from outside.
        for (const p of [a, c, b, b, c, d]) {
          pos.push(p.x * radius, p.y * radius, p.z * radius);
        }
      }
    }
  }
  const positions = new Float32Array(pos);
  const nrm = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i+1], z = positions[i+2];
    const l = Math.hypot(x, y, z) || 1;
    nrm[i] = x/l; nrm[i+1] = y/l; nrm[i+2] = z/l;
  }
  const uv = new Float32Array((positions.length / 3) * 2);
  return new Geometry(device, {
    attributes: {
      position: { format: 'float32x3', data: positions },
      normal:   { format: 'float32x3', data: nrm },
      uv:       { format: 'float32x2', data: uv },
    },
  });
}
