// The game's marching-cubes terrain shader, in WGSL — a direct port of the
// original Three.js GLSL ShaderMaterial. This is GAME content (its specific
// sun/lantern/skyAccess/day-night lighting model), supplied to the engine's
// generic ShaderMaterial; the engine knows nothing about what it computes.
//
// Vertex attributes (in this order): position, normal, color, skyAccess.
// Camera at @group(0) @binding(0); the terrain uniform block at @group(1).
//
// Uniform layout (TERRAIN_UNIFORM_SIZE bytes), packed by packTerrainUniforms:
//   sunPosition.xyz + sunIntensity        (vec4)
//   lanternPosition.xyz + lanternIntensity(vec4)
//   lanternRange, ambientIntensity, fogNear, fogFar (vec4)
//   fogColor.rgb + fogEnabled             (vec4)
export const TERRAIN_UNIFORM_SIZE = 64;

export const terrainWGSL = /* wgsl */ `
struct Camera {
  viewMatrix: mat4x4f,
  projectionMatrix: mat4x4f,
  frustumPlanes: array<vec4f, 6>,
  viewport: vec4f,
};
struct U {
  sunPosition: vec4f,
  lanternPosition: vec4f,
  params: vec4f,    // lanternRange, ambientIntensity, fogNear, fogFar
  fogColor: vec4f,  // rgb + enabled
};
@group(0) @binding(0) var<uniform> camera: Camera;
@group(1) @binding(0) var<uniform> u: U;

// Sun shadow map (group 2) — supplied by SceneRenderer when shadows are enabled
// and this material has receiveShadow:true. lightDirEnabled.w gates it.
struct ShadowParams { lightViewProj: mat4x4f, lightDirEnabled: vec4f, };
@group(2) @binding(0) var<uniform> shadow: ShadowParams;
@group(2) @binding(1) var shadowMap: texture_depth_2d;
@group(2) @binding(2) var shadowSampler: sampler_comparison;

// 3x3 PCF directional shadow factor in [0,1] (1 = lit). Returns 1.0 when
// shadows are disabled or the point is outside the shadow frustum.
//
// The shadow map covers the WHOLE PLANET, so its texels are large (~0.2 world
// units each) and a plain depth bias can't keep the surface from shadowing
// itself — that self-shadowing is the "waves of light" acne. Two fixes:
//   1) NORMAL OFFSET: push the sample point a couple of texels along the surface
//      normal before projecting, so the surface lifts off its own shadow.
//   2) a generous slope-scaled depth bias on top.
fn sunShadow(worldPos: vec3f, n: vec3f) -> f32 {
  if (shadow.lightDirEnabled.w < 0.5) { return 1.0; }
  let L = normalize(-shadow.lightDirEnabled.xyz);
  let ndl = max(dot(n, L), 0.0);

  // Normal-offset: shift along the normal, scaled up as the surface grazes the
  // light (where acne is worst). ~0.6 world units handles the coarse texels.
  let normalOffset = 0.6 * (1.0 - ndl) + 0.15;
  let p = worldPos + n * normalOffset;

  let clip = shadow.lightViewProj * vec4f(p, 1.0);
  if (clip.w <= 0.0) { return 1.0; }
  let ndc = clip.xyz / clip.w;
  if (ndc.x < -1.0 || ndc.x > 1.0 || ndc.y < -1.0 || ndc.y > 1.0 || ndc.z < 0.0 || ndc.z > 1.0) { return 1.0; }
  let uv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);

  // Slope-scaled depth bias in NDC-z. Large because one texel spans a big slab
  // of ground over a ~400-unit depth range.
  let bias = clamp(0.0008 + 0.004 * (1.0 - ndl), 0.0008, 0.005);
  let refDepth = ndc.z - bias;

  let dim = vec2f(textureDimensions(shadowMap, 0));
  let texel = 1.0 / dim;
  var sum = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      sum = sum + textureSampleCompareLevel(shadowMap, shadowSampler, uv + vec2f(f32(x), f32(y)) * texel, refDepth);
    }
  }
  return sum / 9.0;
}

struct VOut {
  @builtin(position) position: vec4f,
  @location(0) color: vec3f,
  @location(1) normal: vec3f,
  @location(2) worldPos: vec3f,
  @location(3) skyAccess: f32,
  @location(4) viewDepth: f32,
};

// Terrain meshes have identity model transforms (vertices are already in world
// space), so all chunks share one geometry stream and are drawn in a single
// call — no per-object world matrix or instance id needed.
@vertex
fn vertexMain(
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) color: vec3f,
  @location(3) skyAccess: f32,
) -> VOut {
  var o: VOut;
  o.color = color;
  o.skyAccess = skyAccess;
  o.normal = normalize(normal);
  o.worldPos = position; // terrain mesh has identity model matrix
  let view = camera.viewMatrix * vec4f(position, 1.0);
  o.position = camera.projectionMatrix * view;
  o.viewDepth = -view.z;
  return o;
}

@fragment
fn fragmentMain(i: VOut) -> @location(0) vec4f {
  let n = normalize(i.normal);
  let sunIntensity = u.sunPosition.w;
  let lanternIntensity = u.lanternPosition.w;
  let lanternRange = u.params.x;
  let ambientIntensity = u.params.y;

  // Sun — gated by a flattened hemisphere day/night term so the whole day side
  // is lit, not just the sub-solar point. Directional shadowing now comes from
  // the real shadow map (sunShadow); skyAccess is NO LONGER multiplied here (it
  // would double-darken). skyAccess is repurposed below as ambient occlusion.
  let sunDir = normalize(u.sunPosition.xyz - i.worldPos);
  let sunDot = max(0.0, dot(n, sunDir));
  let hemisphereDot = pow(max(0.0, dot(normalize(i.worldPos), sunDir)), 0.35);
  let shadowFactor = sunShadow(i.worldPos, n);
  let sunContribI = sunDot * hemisphereDot * sunIntensity * shadowFactor;
  let sunContrib = sunContribI * vec3f(1.0, 0.97, 0.88);

  // Lantern — tight quadratic falloff plus an angle-independent fill.
  let lDir = u.lanternPosition.xyz - i.worldPos;
  let lDist = length(lDir);
  let lDot = max(0.0, dot(n, normalize(lDir)));
  let lScaled = lDist / lanternRange;
  let lAtten = lanternIntensity / (1.0 + lScaled * lScaled * 0.18);
  let lFill = lAtten * 0.45;
  let lanternContrib = (lDot * lAtten + lFill) * vec3f(1.0, 0.80, 0.47);

  // Ambient occlusion from skyAccess: enclosed areas (cave mouths, crevices)
  // have low sky access and read darker, even where the coarse sun shadow map
  // can't resolve them. Applied to ambient + as a gentle overall AO multiplier;
  // the lantern stays unoccluded so it still lights up dark interiors.
  let ao = mix(0.35, 1.0, clamp(i.skyAccess, 0.0, 1.0));
  let light = vec3f(ambientIntensity) * ao + sunContrib * ao + lanternContrib;
  var rgb = i.color * light;

  if (u.fogColor.w > 0.5) {
    let f = clamp((i.viewDepth - u.params.z) / max(u.params.w - u.params.z, 0.0001), 0.0, 1.0);
    rgb = mix(rgb, u.fogColor.rgb, f);
  }
  return vec4f(rgb, 1.0);
}
`;

// Packs the material's `uniforms` object into the Float32Array view the engine
// hands updateUniforms(). Uniform values use the { value } wrapper shape (so
// game code can keep doing material.uniforms.sunPosition.value.copy(...)).
export function packTerrainUniforms(view, u) {
  const g = (n, d) => (u[n] ? u[n].value : d);
  const sp = u.sunPosition.value;
  const lp = u.lanternPosition.value;
  const fog = u.fog ? u.fog.value : null; // { color:{r,g,b}, near, far } or null
  view[0] = sp.x; view[1] = sp.y; view[2] = sp.z; view[3] = g('sunIntensity', 1);
  view[4] = lp.x; view[5] = lp.y; view[6] = lp.z; view[7] = g('lanternIntensity', 0);
  view[8] = g('lanternRange', 1); view[9] = g('ambientIntensity', 0.03);
  view[10] = fog ? fog.near : 0; view[11] = fog ? fog.far : 1;
  view[12] = fog ? fog.color.r : 0; view[13] = fog ? fog.color.g : 0; view[14] = fog ? fog.color.b : 0; view[15] = fog ? 1 : 0;
}
