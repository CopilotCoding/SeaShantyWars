import { DEFAULT_SEED, SEA_LEVEL } from './constants.js';
import { Planet } from './planet.js';
import { Ocean } from './ocean.js';
import { Player } from './player.js';
import { Camera } from './camera.js';
import { Input } from './input.js';
import { Shanties } from './audio/shanties.js';
import { setupScene, placeSun } from './sceneSetup.js';
import { VoxelShip as Ship } from './ship/voxelShip.js';
import { Combat } from './combat.js';
import { Fleet } from './fleet.js';
import { Vec3 } from './engine.js';

// Marching-cubes lookup tables (edgeTable/triTable) load as globals via a
// classic <script>, the same way PlanetVoxel does. Workers load their own copy
// via importScripts.
async function loadMarchingCubes(onProgress) {
  onProgress('Loading marching cubes lookup tables...', 0.05);
  await new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = './marching-cubes.js';
    script.onload = resolve;
    script.onerror = () => reject(new Error('Failed to load marching-cubes.js'));
    document.head.appendChild(script);
  });
  if (typeof edgeTable === 'undefined' || typeof triTable === 'undefined') {
    throw new Error('edgeTable / triTable not defined after loading marching-cubes.js');
  }
}

async function startGame(seed) {
  document.getElementById('main-menu').style.display = 'none';
  document.getElementById('loading-screen').style.display = 'flex';
  const loadBar = document.getElementById('loading-bar-fill');
  const loadText = document.getElementById('loading-text');
  const setProgress = (msg, pct) => { loadText.textContent = msg; loadBar.style.width = (pct * 100) + '%'; };

  await loadMarchingCubes(setProgress);
  setProgress('Setting up renderer...', 0.12);

  const {
    renderer, scene, ambientLight, sunLight, sunCoreMesh, atmosMesh,
    SUN_ORBIT, SUN_PERIOD,
  } = await setupScene();

  let sunAngle = Math.PI / 3;
  placeSun(sunCoreMesh, sunAngle, SUN_ORBIT);

  const sessionAbort = new AbortController();
  const { signal } = sessionAbort;

  const audio = new Shanties();
  const input = new Input(signal);
  const camera = new Camera(renderer, signal);

  setProgress(`Generating ocean planet (seed ${seed})...`, 0.18);
  const planet = new Planet(scene, seed);
  await planet.buildInitialChunksAsync((frac) => {
    setProgress(`Generating islands & seafloor... ${Math.floor(frac * 100)}%`, 0.18 + frac * 0.62);
  });

  setProgress('Raising the seas...', 0.84);
  const ocean = new Ocean(scene);

  const player = new Player(scene, planet, ocean);

  // Spawn the ship in OPEN water (deep sea with deep water all around it, so it's
  // not a landlocked lagoon), then spawn the player on its deck. Starting at sea
  // on your own boat guarantees an escapable, on-theme spawn.
  setProgress('Launching your sloop...', 0.94);
  const shipDir = findOpenWater(planet);
  // `ship` is the player's HOME ship. It's a `let` (not const) because if it's
  // sunk and the player dies with no other vessel, we replace it with a fresh
  // starter sloop (see respawnPlayer / makeStarterShip).
  let ship = new Ship(scene, ocean, 'sloop', shipDir, planet, {
    name: 'The Rusty Wench', faction: 'player',
    sailColor: 0xb33b3b, flagColor: 0x161616, // crimson sails, black jolly roger
  });
  ship.update(0); // place it so we can read deck position

  // The player collides with this ship as moving terrain.
  player.ships = [ship];
  // Spawn standing on the deck, OFF-CENTER toward the bow so we don't start
  // inside the (centered) mast column.
  player.position.copy(ship.localToWorld(new Vec3(0, ship.deckLocalY() + 1.0, ship.spec.length * 0.2)));
  player.up.copy(ship.up);
  player.onShip = ship;

  setProgress('Rivals sail the seas...', 0.97);
  // Combat: cannonballs + hull damage. The player ship is always a target.
  const combat = new Combat(scene, ocean);
  combat.targets = [ship];
  // Juice on every cannonball hit. The sea is full of NPC-vs-NPC battles now, so
  // only react with shake/sound to hits ON the player's ship or near the camera;
  // distant faction battles get the flash + (for sink/surrender) a toast only.
  combat.onHit = (hitShip, worldPos, result) => {
    const nearPlayer = worldPos.clone().sub(camera.camera.position).length() < 60;
    // Sound is now spatial (attenuated by distance from the listener), so we can
    // always play it — distant faction battles come through faint, not silent.
    if (audio.playHit) audio.playHit(worldPos);
    // Screen shake stays gated to the player's own ship / very close hits.
    if (hitShip === ship) camera.addShake(0.6);
    else if (nearPlayer)  camera.addShake(0.18);
    if (hitShip.flashHit) hitShip.flashHit();
    if (result === 'sunk') {
      if (audio.playSplash) audio.playSplash(worldPos);
      if (hitShip === ship) flashToast(`Your ship is going down!`);
      else flashToast(`${hitShip.name} sinks beneath the waves!`);
    } else if (result === 'surrender') {
      flashToast(`${hitShip.name} strikes her colours!`);
    }
  };

  // A LIVING SEA: a fleet of varied enemy ships of different FACTIONS that sail,
  // fight EACH OTHER (navy hunts pirates, civilians flee, pirates raid all), and
  // respawn — plus you, a pirate everyone lawful wants dead.
  const fleet = new Fleet(scene, ocean, planet, ship, combat,
    { isOpenSea, findOpenWater }, { maxShips: 16 });
  // `enemy` is the nearest enemy each frame (HUD/boarding target).
  let enemy = fleet.nearest() || fleet.ships[0];

  setProgress('Hoist the colours!', 1.0);
  await new Promise(r => setTimeout(r, 250));

  document.getElementById('loading-screen').style.display = 'none';
  document.getElementById('ui-root').style.display = 'block';
  audio.playTrack('sail');
  setTimeout(() => flashToast('Click to look · [Tab] toggle HUD · [E] take the helm'), 400);

  renderer.domElement.addEventListener('click', () => {
    if (!input.pointerLocked) input.requestPointerLock(renderer.domElement);
  });
  renderer.domElement.addEventListener('contextmenu', e => e.preventDefault());

  // Pause.
  let paused = false;
  const pauseMenu = document.getElementById('pause-menu');
  function setPaused(v) {
    paused = v;
    pauseMenu.style.display = v ? 'flex' : 'none';
    if (v && input.pointerLocked) document.exitPointerLock();
  }
  document.getElementById('pause-resume-btn').addEventListener('click', () => setPaused(false));
  window.addEventListener('keydown', e => {
    if (e.code === 'KeyP') setPaused(!paused);
    // [Tab] toggles the persistent HUD readouts (minimal UI: off by default).
    if (e.code === 'Tab') { e.preventDefault(); document.body.classList.toggle('hud-on'); }
  }, { signal });
  document.getElementById('music-toggle').addEventListener('change', e => audio.setMusicEnabled(e.target.checked));

  // Transient on-screen message (plunder, capture, etc).
  let toastTimer = 0;
  function flashToast(msg) {
    const el = document.getElementById('toast');
    if (el) { el.textContent = msg; el.style.opacity = '1'; }
    toastTimer = 3.0;
  }

  // Control mode: 'foot' = walk/swim/deck, 'helm' = steering the wheel,
  // 'gun' = manning a single cannon. mannedCannon = the cannon in 'gun' mode.
  let controlMode = 'foot';
  let mannedCannon = null;
  // The ship the player is currently steering (home ship, or a captured one).
  let activeShip = ship;
  // For fading the helm/gun action hint after a few seconds in that mode.
  let _lastMode = 'foot', _modeShownT = 0;
  // Plunder: the player's gold (the point of boarding/looting enemy ships).
  let gold = 0;

  // ---- Player health (for boarding combat) ----
  // No always-on bar: health is shown as a RED VIGNETTE that closes in (eats
  // further from the edges, darker) the lower your health is. A Tab-only HUD
  // line shows the number. A brief extra pulse layers on top when hit.
  const PLAYER_MAX_HP = 100;
  let playerHp = PLAYER_MAX_HP;
  let _hitPulse = 0;     // short red spike on taking a hit (decays)
  let _dead = false, _deathT = 0;
  let _adriftT = 0; // time spent with no ship afloat (triggers a fresh sloop)
  let _attackCd = 0, _reloadCd = 0; // cutlass swing / pistol reload cooldowns
  const _vignetteEl = document.getElementById('health-vignette');
  const _healthValEl = document.getElementById('health-val');
  // Apply damage to the player (called by enemy crew / cannonballs). Handles
  // death + the hit pulse + sound.
  function damagePlayer(n) {
    if (_dead || n <= 0) return;
    playerHp = Math.max(0, playerHp - n);
    _hitPulse = Math.min(1, _hitPulse + n / 25);
    if (audio.playHurt) audio.playHurt();
    camera.addShake(0.25);
    if (playerHp <= 0) { _dead = true; _deathT = 0; }
  }
  // True if a ship is still a usable vessel (afloat, not sunk/sinking/removed).
  function shipAfloat(s) { return s && !s.sunk && !s._sinking && !s._removed; }

  // The vessel the player should respawn onto: their home ship if it's still
  // afloat, else any captured ship still afloat, else null (need a fresh one).
  function pickRespawnShip() {
    if (shipAfloat(ship)) return ship;
    if (fleet && fleet.owned) {
      for (const s of fleet.owned) if (shipAfloat(s)) return s;
    }
    return null;
  }

  // Build a fresh STARTER sloop at open water and make it the player's new home
  // ship: registered as a combat target + collision body. Used when the player
  // dies with no vessel left to their name (a clean restart, not a game over).
  function makeStarterShip() {
    // Drop the old husk's mesh if it's still hanging around.
    if (ship && ship.mesh) scene.remove(ship.mesh);
    if (ship && ship.chestMesh) scene.remove(ship.chestMesh);
    combat.targets = combat.targets.filter(t => t !== ship);

    const dir = findOpenWater(planet);
    const fresh = new Ship(scene, ocean, 'sloop', dir, planet, {
      name: 'The Rusty Wench', faction: 'player',
      sailColor: 0xb33b3b, flagColor: 0x161616,
    });
    fresh.update(0);
    ship = fresh;
    combat.targets.push(ship);
    // Keep the player's collision list pointed at the current home ship (plus
    // any captured ships still afloat).
    player.ships = [ship, ...(fleet ? fleet.owned.filter(shipAfloat) : [])];
    return ship;
  }

  // Respawn after death. No permadeath: you wash up and try again. If your home
  // ship still floats (or you hold a captured ship), you're dropped beside her;
  // if you have NO ship left, a fresh starter sloop is launched for you.
  function respawnPlayer() {
    _dead = false; playerHp = PLAYER_MAX_HP; _hitPulse = 0;
    controlMode = 'foot'; mannedCannon = null;

    let home = pickRespawnShip();
    let freshStart = false;
    if (!home) { home = makeStarterShip(); freshStart = true; }
    ship = home;            // adopt this as the home ship
    activeShip = home;

    // Drop in the sea a short way off her beam, then climb aboard.
    const off = home.right.clone().multiplyScalar(8).addScaledVector(home.up, 1);
    player.position.copy(home.position).add(off);
    player.position.setLength(SEA_LEVEL + 0.5);
    player.velocity.set(0, 0, 0);
    flashToast(freshStart
      ? 'Your last ship lost — you wash up aboard a fresh sloop. Sail again!'
      : 'You were cut down — washed back to the surface.');
  }

  // A cannonball only hurts someone it DIRECTLY strikes — no big splash. We test
  // against each body's center (feet + ~0.9m up) so a ball at chest height counts
  // as a hit even though positions are tracked at the feet.
  combat.onImpact = (hitShip, worldPos, radius) => {
    const bodyHit = (footPos, up) => {
      const center = footPos.clone().addScaledVector(up, 0.9); // mid-torso
      return center.sub(worldPos).length() <= radius;
    };
    // Direct hit on enemy crew.
    for (const party of fleet.parties.values()) {
      for (const m of party.members) {
        if (m.dead) continue;
        if (bodyHit(m.position, m.ship.up)) m.hurt(60); // a direct ball is fatal
      }
    }
    // Direct hit on the player.
    if (!_dead && bodyHit(player.position, player.up)) {
      damagePlayer(45 + Math.random() * 25);
    }
  };

  let lastTime = performance.now();
  let startupFade = 0;
  let stopped = false;

  function loop() {
    if (stopped) return;
    requestAnimationFrame(loop);
    const now = performance.now();
    let dt = Math.min((now - lastTime) / 1000, 0.1);
    lastTime = now;
    if (paused) dt = 0;

    camera.decayShake(dt);

    // Day/night.
    sunAngle += (Math.PI * 2 / SUN_PERIOD) * dt;
    placeSun(sunCoreMesh, sunAngle, SUN_ORBIT);
    sunLight.position.copy(sunCoreMesh.position);
    const sunDir = sunCoreMesh.position.clone().normalize();
    renderer.setShadowLight([-sunDir.x, -sunDir.y, -sunDir.z]);

    // Day factor at the player (for lighting / sky brightness).
    const playerDir = player.position.clone().normalize();
    const dayDot = sunDir.dot(playerDir);
    startupFade = Math.min(1, startupFade + dt / 1.0);
    const dayBright = Math.max(0, dayDot);

    sunLight.intensity = (0.6 + 1.4 * dayBright) * startupFade;
    ambientLight.intensity = (0.12 + 0.28 * dayBright) * startupFade;

    // Drive terrain shader uniforms (sun + fog).
    const u = planet.material.uniforms;
    u.sunPosition.value.copy(sunCoreMesh.position);
    u.sunIntensity.value = (0.7 + 0.8 * dayBright) * startupFade;
    u.ambientIntensity.value = (0.18 + 0.2 * dayBright) * startupFade;
    u.lanternIntensity.value = 0;

    // Feed sun direction + fog to the voxel ships (their shader has its own
    // lighting uniform). Sun dir points from the ship toward the sun.
    const shipAmbient = (0.32 + 0.2 * dayBright) * startupFade;
    const shipFog = scene.fog ? { color: scene.fog.color, near: scene.fog.near, far: scene.fog.far } : null;
    for (const s of [ship, enemy]) {
      s.sunDir.copy(sunDir);
      s.ambient = shipAmbient;
      s.fog = shipFog;
    }

    // Mouse look always rotates the camera.
    const md = input.consumeMouseDelta();
    if (input.pointerLocked) camera.rotate(md.x, md.y);

    // Ocean first (so ship buoyancy samples this frame's wave surface), then the
    // ship (so the player can stand on the post-update deck), then the player.
    ocean.update(dt, sunDir, camera.camera.position,
      scene.fog ? { color: scene.fog.color, near: scene.fog.near, far: scene.fog.far } : null);

    // ---- Boarding: keep the player's own ship + EVERY nearby enemy in the
    // player's collidable ships, so you can swim up to any hull and walk/jump
    // aboard. `enemy` = the ship you're standing on, else the nearest (HUD +
    // boarding-action target).
    const collideShips = [ship];
    for (const e of [...fleet.ships, ...fleet.owned]) {
      if (e === ship) continue;
      const pd = player.position.clone().sub(e.position).length();
      if (pd < e.spec.length * 0.75 + 8 || player.onShip === e) collideShips.push(e);
    }
    player.ships = collideShips;
    // Update the HUD/boarding target: the enemy you're aboard, else the nearest.
    if (player.onShip && player.onShip !== ship && fleet.ships.includes(player.onShip)) {
      enemy = player.onShip;
    } else {
      enemy = fleet.nearest() || enemy;
    }
    const onEnemy = player.onShip === enemy && enemy !== ship && enemy != null;
    const alongside = enemy && ship.position.clone().sub(enemy.position).length()
      < (ship.spec.beam + enemy.spec.beam) * 0.5 + 4.0;

    // ---- Control mode: 'foot' (walk/swim/deck) or 'helm' (steering) ----
    // The ship ALWAYS updates (it floats/sails regardless of mode). The player
    // collides with it as moving terrain — walking the deck, jumping off, and
    // climbing aboard are all just normal player physics, no special-casing.
    // Can take the helm when standing on this ship near the wheel. (The HUD
    // status line shows the "[E] at the wheel to steer" hint — no separate
    // on-screen prompt needed.)
    // Context interactions while on foot: take the helm (near the wheel) OR man
    // a cannon (near a gun).
    // A ship you OWN (your home ship or any captured one) — you can take its
    // helm / man its guns. The "active" ship is whichever owned ship you're
    // currently steering (set when you take a helm).
    const isOwned = (s) => s === ship || (s && s.faction === 'player');
    const onOwnedDeck = controlMode === 'foot' && isOwned(player.onShip) && !player.onShip.sunk;
    const canTakeHelm = onOwnedDeck && player.onShip.canBoardFrom(player.position);
    // Don't offer a cannon when you're in the helm zone (helm takes priority).
    const nearCannon = (onOwnedDeck && !canTakeHelm)
      ? player.onShip.cannonNear(player.position) : null;

    let rudder = 0, sailDelta = 0;
    let runPlayerPhysics = false;
    if (controlMode === 'helm' && activeShip) {
      // ---- At the captain's wheel: steer, and LMB/RMB broadsides ----
      if (input.pointerLocked && !paused) {
        if (input.isDown('KeyA') || input.isDown('ArrowLeft'))  rudder -= 1;
        if (input.isDown('KeyD') || input.isDown('ArrowRight')) rudder += 1;
        if (input.isDown('KeyW') || input.isDown('ArrowUp'))    sailDelta += dt * 0.6;
        if (input.isDown('KeyS') || input.isDown('ArrowDown'))  sailDelta -= dt * 0.6;
        if (input.consumeKey('KeyE')) controlMode = 'foot';
        if (input.consumeClick())      { if (combat.fireBroadside(activeShip,  1, audio)) camera.addShake(0.35); } // LMB = left
        if (input.consumeRightClick()) { if (combat.fireBroadside(activeShip, -1, audio)) camera.addShake(0.35); } // RMB = right
        const scroll = input.consumeScroll();
        if (scroll !== 0) camera.helmZoom(scroll); // scroll to zoom (all the way to first person)
      }
      activeShip.setControls({ rudder, sailDelta });
    } else if (controlMode === 'gun' && activeShip) {
      // ---- Manning a single cannon: LMB fires THIS gun; E steps off ----
      if (input.pointerLocked && !paused) {
        if (input.consumeKey('KeyE')) { controlMode = 'foot'; mannedCannon = null; }
        else if (input.consumeClick()) { if (combat.fireCannon(activeShip, mannedCannon, audio)) camera.addShake(0.22); }
      }
      activeShip.setControls({ rudder: 0, sailDelta: 0 });
    } else {
      // ---- On foot ----
      if (input.pointerLocked && !paused && input.consumeKey('KeyE')) {
        if (canTakeHelm) { controlMode = 'helm'; activeShip = player.onShip; }
        else if (nearCannon) { controlMode = 'gun'; activeShip = player.onShip; mannedCannon = nearCannon; }
      }
      // ---- On-foot weapons: LMB = cutlass (melee arc), RMB = pistol (ranged) ----
      // They strike the nearest LIVING enemy crew member on whatever deck you're
      // standing on. Cutlass is short-range + cooldown; pistol reaches further.
      if (input.pointerLocked && !paused && !_dead) {
        const onShip = player.onShip;
        const party = onShip ? fleet.partyOf(onShip) : null;
        if (party) {
          if (_attackCd > 0) _attackCd -= dt;
          if (_reloadCd > 0) _reloadCd -= dt;
          // Aim point: just in front of the player along the look direction.
          const aim = player.position.clone().addScaledVector(camera.getForwardDir(), 1.0);
          if (input.consumeClick() && _attackCd <= 0) {
            _attackCd = 0.5; camera.addShake(0.12);
            const hit = party.nearestAlive(aim, 2.6); // cutlass reach
            if (audio.playClash) audio.playClash(player.position);
            if (hit) {
              const killed = hit.member.hurt(26 + Math.random() * 10);
              if (audio.playHit) audio.playHit(hit.member.position);
              if (killed && party.cleared()) flashToast(`${onShip.name}'s deck is yours! Press [C] to take her.`);
            }
          }
          if (input.consumeRightClick() && _reloadCd <= 0) {
            _reloadCd = 1.6; camera.addShake(0.18);
            const muzzle = player.position.clone().addScaledVector(player.up, 1.3);
            const tip = muzzle.clone().addScaledVector(camera.getForwardDir(), 14);
            if (combat.spawnTracer) combat.spawnTracer(muzzle, tip);
            if (audio.playMusket) audio.playMusket(player.position);
            const hit = party.nearestAlive(aim, 16); // pistol range
            if (hit) {
              const killed = hit.member.hurt(40 + Math.random() * 20);
              if (killed && party.cleared()) flashToast(`${onShip.name}'s deck is yours! Press [C] to take her.`);
            }
          }
        }
      }
      // Boarding actions on the ENEMY deck: F (at chest) plunder, C capture.
      if (input.pointerLocked && !paused && enemy && player.onShip === enemy && enemy !== ship && !enemy.sunk) {
        if (input.consumeKey('KeyF') && enemy.nearChest && enemy.nearChest(player.position)) {
          const g = enemy.openChest();
          if (g) { gold += g; flashToast(`+${g} gold — plundered ${enemy.loot.desc}!`); if (audio.playSell) audio.playSell(); }
        }
        if (input.consumeKey('KeyC') && !enemy.captured) {
          // Capture only once her deck is CLEARED of resisting crew. Civilians
          // have ~1 weak hand; a navy deck is a real fight.
          const party = fleet.partyOf(enemy);
          if (party && !party.cleared()) {
            flashToast(`Her crew still fights! Cut down all ${party.aliveCount()} defenders first.`);
          } else {
            enemy.captured = true;
            enemy.faction = 'player';
            // Re-crew the prize: if she still has masts + canvas she can sail
            // again under your flag (clears the surrendered/disabled lock). A
            // truly dismasted hull stays a derelict you can only tow/abandon.
            const sailable = enemy.recommission ? enemy.recommission() : true;
            const g = enemy.openChest ? enemy.openChest() : 0;
            if (g) gold += g;
            flashToast(`Captured ${enemy.name}!`
              + (g ? ` +${g} gold from her hold.` : '')
              + (sailable ? ' Take her helm and sail!' : ' (Dismasted — she\'ll not sail.)'));
            if (audio.playSell) audio.playSell();
          }
        }
      }
      ship.setControls({ rudder: 0, sailDelta: 0 });
      runPlayerPhysics = true;
    }

    // The player's HOME ship updates here UNLESS the fleet already owns/updates
    // it (a captured ship adopted as home after losing the original) — otherwise
    // it'd be integrated twice and move at double speed.
    const homeInFleet = fleet.owned && fleet.owned.includes(ship);
    if (!homeInFleet) ship.update(dt);
    if (runPlayerPhysics) {
      if (input.pointerLocked && !paused) player.update(dt, input, camera);
      input.consumeClick(); input.consumeRightClick();
      camera.update(player.position, player.up, player.onShip ? false : true);
    } else if (controlMode === 'helm' && activeShip) {
      player.position.copy(activeShip.helmWorld());
      player.up.copy(activeShip.up);
      player.onShip = activeShip;
      camera.updateHelm(activeShip); // third-person view behind the ship
    } else if (controlMode === 'gun' && activeShip && mannedCannon) {
      player.position.copy(activeShip.cannonStandWorld(mannedCannon));
      player.up.copy(activeShip.up);
      player.onShip = activeShip;
      camera.update(player.position, player.up, false);
    }
    player.mesh.visible = false;

    // Enemy ships + projectiles.
    // AI decides controls/firing, THEN the enemy ship integrates them.
    // The living sea: AI + ship updates + respawns for the whole fleet.
    // Tell the fleet which captured ship the player is actively steering, so it
    // doesn't force that one's sails down.
    fleet.update(dt, audio, paused, activeShip !== ship ? activeShip : null,
      { player, dealDamage: damagePlayer });
    combat.update(dt);

    // Hit pulse decays; death triggers a brief delay then respawn.
    if (_hitPulse > 0) _hitPulse = Math.max(0, _hitPulse - dt * 1.5);
    if (_dead) { _deathT += dt; if (_deathT > 2.0) respawnPlayer(); }
    // Stranded safety net: if you're NOT dead but have no vessel left afloat
    // (your ship sank under you and you hold no captured ship), you're adrift —
    // give it a moment, then launch a fresh starter sloop so you're never stuck
    // swimming the open sea forever.
    else if (!pickRespawnShip()) {
      _adriftT += dt;
      if (_adriftT > 4.0) { respawnPlayer(); _adriftT = 0; } // launches a fresh sloop
    } else { _adriftT = 0; }
    // Drive the red vignette: the less health, the further it closes in (smaller
    // clear centre) and the darker the ring. Dead = full red. A hit pulse adds a
    // momentary darkening on top.
    if (_vignetteEl) {
      const frac = _dead ? 0 : playerHp / PLAYER_MAX_HP;     // 1 healthy .. 0 dead
      const hurt = 1 - frac;                                  // 0 healthy .. 1 dead
      // Clear centre shrinks from 92% (healthy) to ~18% (near death).
      const inner = Math.round(92 - hurt * 74);
      // Ring darkness ramps up as health falls, plus the hit pulse.
      const alpha = Math.min(0.92, hurt * 0.8 + _hitPulse * 0.5);
      _vignetteEl.style.setProperty('--hv-inner', inner + '%');
      _vignetteEl.style.setProperty('--hv-alpha', alpha.toFixed(3));
    }
    if (_healthValEl) _healthValEl.textContent = Math.ceil(playerHp).toString();


    // Underwater: tint the screen + tighten fog when the CAMERA EYE is at/below
    // the wave surface. The overlay starts fading in JUST ABOVE the surface
    // (transition band from +0.6 down) so the razor-thin moment the eye is
    // exactly at the waterline — where the ocean shell clips and you'd briefly
    // "see everything" — is always covered by the tint. >0 eyeDepth = submerged.
    const eye = camera.camera.position;
    // Spatial audio listener = the camera eye, so SFX volume falls off with
    // distance (a battle across the sea is faint, one alongside you is loud).
    if (audio.setListener) audio.setListener(eye);
    const eyeDir = eye.clone().normalize();
    const eyeWaveR = SEA_LEVEL + ocean.heightAt(eyeDir);
    const eyeDepth = eyeWaveR - eye.length();           // >0 means submerged
    const underwater = eyeDepth > 0;
    const uoverlay = document.getElementById('underwater-overlay');
    if (uoverlay) {
      // Ramp from 0 at +0.6 above surface to ~0.5 at the surface, then deeper.
      const band = Math.min(1, Math.max(0, (eyeDepth + 0.6) / 0.6)); // 0..1 across the boundary
      const op = underwater ? Math.min(0.9, 0.5 + eyeDepth * 0.04) : band * 0.5;
      uoverlay.style.opacity = op.toString();
    }

    // Murky underwater fog vs. clear-air horizon fog. Switch a touch BEFORE the
    // surface too, so the boundary band is murky, not crystal clear.
    if (scene.fog) {
      if (eyeDepth > -0.4) { scene.fog.color.setHex(0x10527a); scene.fog.near = 2; scene.fog.far = 38; }
      else                 { scene.fog.color.setHex(0x8fc3e8); scene.fog.near = 320; scene.fog.far = 760; }
      u.fog.value = { color: scene.fog.color, near: scene.fog.near, far: scene.fog.far };
    }

    // Keep terrain meshing flowing if any chunks are dirty (none yet in M1).
    planet.meshChunksDirty();

    // ---- HUD: three NON-OVERLAPPING lanes ----
    //   combat-line (top)   = enemy/combat state only (no action hints)
    //   action-prompt (mid) = exactly ONE context action ([E]/click), hidden if none
    //   status-line (bottom)= what you're doing / where you are (no action hints)
    const combatEl = document.getElementById('combat-line');
    const actionEl = document.getElementById('action-prompt');
    const statusEl = document.getElementById('status-line');

    // Combat line: nearest enemy state + your gold.
    if (combatEl) {
      const enemyTxt = !enemy ? '⚓ open seas'
        : enemy.captured ? `🏴 ${enemy.name} (yours)`
        : enemy.surrendered ? `🏳️ ${enemy.name} — surrendered! board her`
        : `🎯 ${enemy.name} (${enemy.crewType || '?'}) · hull ${Math.round(100 * enemy.hp / enemy.maxHp)}%`;
      combatEl.innerHTML = `${enemyTxt}　·　<b>🪙 ${gold} gold</b>`;
    }

    // Action prompt: a single context hint, mutually exclusive. The helm/gun
    // control hints FADE OUT a few seconds after entering that mode (you don't
    // need a permanent reminder while sailing); contextual prompts (board/chest/
    // take-wheel) keep showing since they're momentary by nature.
    if (controlMode !== _lastMode) { _lastMode = controlMode; _modeShownT = 0; }
    _modeShownT += dt;
    if (actionEl) {
      let action = '';
      let persistent = true; // contextual prompts persist; helm/gun fade
      if (enemy && player.onShip === enemy && enemy !== ship && !enemy.sunk) {
        const party = fleet.partyOf(enemy);
        const crewLeft = party ? party.aliveCount() : 0;
        const parts = [];
        if (crewLeft > 0) {
          // Crew still defending — fight them first.
          parts.push(`⚔ ${crewLeft} crew defending · [LMB] cutlass · [RMB] pistol`);
        } else {
          if (enemy.nearChest && enemy.nearChest(player.position)) parts.push('[F] open the chest');
          else if (enemy.loot && !enemy.looted) parts.push('find her chest →');
          if (!enemy.captured) parts.push('[C] capture the ship');
        }
        action = parts.join(' · ') || 'Her hold is empty';
      }
      else if (controlMode === 'helm') { action = '[LMB] fire left · [RMB] fire right · [E] leave wheel'; persistent = false; }
      else if (controlMode === 'gun')  { action = '[LMB] fire cannon · [E] step away'; persistent = false; }
      else if (canTakeHelm)            action = '[E] take the wheel';
      else if (nearCannon)             action = '[E] man this cannon';
      else if (alongside && !onEnemy && enemy)  action = 'Alongside! Walk across to board ' + enemy.name;
      // Fade the helm/gun hint after 4s in that mode.
      const show = action && (persistent || _modeShownT < 4);
      actionEl.textContent = action;
      actionEl.style.display = show ? 'block' : 'none';
    }

    // Toast fade.
    if (toastTimer > 0) {
      toastTimer -= dt;
      const tel = document.getElementById('toast');
      if (tel && toastTimer <= 0) tel.style.opacity = '0';
    }

    // Status line: where you are / what you're doing.
    if (statusEl) {
      if (controlMode === 'helm' && activeShip) {
        statusEl.textContent = `⎈ At the helm of ${activeShip.name} · sail ${Math.round(activeShip.sailRaised*100)}% · ${Math.abs(activeShip.speed).toFixed(1)} kn`;
      } else if (controlMode === 'gun' && activeShip) {
        statusEl.textContent = `💥 Manning a cannon aboard ${activeShip.name}`;
      } else if (player.onShip) {
        statusEl.textContent = `⚓ Aboard ${player.onShip.name}`;
      } else if (player.inWater) {
        statusEl.textContent = `🌊 In the water · depth ${(SEA_LEVEL - player.position.length()).toFixed(1)}`;
      } else {
        statusEl.textContent = player.grounded ? '🏝️ Ashore' : '↓ In the air';
      }
    }

    renderer.render(scene, camera.camera, { frame: ++frameId });
  }
  let frameId = 0;

  loop();
}

// True if `dir` is over open sea: deep water at the spot AND a clear water ring
// around it (so a ship spawned there isn't inside/touching an island).
function isOpenSea(planet, dir, minDepth = 6) {
  if (planet.isLand(dir)) return false;
  if (SEA_LEVEL - planet.surfaceRadius(dir) < minDepth) return false;
  const t1 = new Vec3(0,1,0).cross(dir); if (t1.lengthSq() < 0.01) t1.set(1,0,0); t1.normalize();
  const t2 = new Vec3().crossVectors(dir, t1).normalize();
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    const rd = dir.clone().addScaledVector(t1, Math.cos(a) * 0.06).addScaledVector(t2, Math.sin(a) * 0.06).normalize();
    if (planet.isLand(rd)) return false;
  }
  return true;
}

// Find a direction over OPEN ocean: deep water at the spot AND deep water in a
// ring around it (so it's not a small lagoon or right against a coast). Returns
// a unit Vec3 direction. Scores many random directions and returns the best.
function findOpenWater(planet) {
  let best = null, bestScore = -Infinity;
  const ringAngles = 6;
  for (let i = 0; i < 400; i++) {
    const d = new Vec3(Math.random()*2-1, Math.random()*2-1, Math.random()*2-1);
    if (d.lengthSq() < 0.01) continue;
    d.normalize();
    if (planet.isLand(d)) continue;
    // Depth here (how far below sea level the seafloor is).
    const depthHere = SEA_LEVEL - planet.surfaceRadius(d);
    if (depthHere < 6) continue; // too shallow / near shore
    // Check a ring of nearby directions are also open water.
    const t1 = new Vec3(0,1,0).cross(d); if (t1.lengthSq()<0.01) t1.set(1,0,0); t1.normalize();
    const t2 = new Vec3().crossVectors(d, t1).normalize();
    let minRingDepth = Infinity, openCount = 0;
    for (let k = 0; k < ringAngles; k++) {
      const a = (k / ringAngles) * Math.PI * 2;
      const rd = d.clone()
        .addScaledVector(t1, Math.cos(a) * 0.10)
        .addScaledVector(t2, Math.sin(a) * 0.10)
        .normalize();
      const rDepth = SEA_LEVEL - planet.surfaceRadius(rd);
      if (rDepth > 3) openCount++;
      minRingDepth = Math.min(minRingDepth, rDepth);
    }
    if (openCount < ringAngles) continue; // some ring point is land -> near coast
    const score = depthHere + minRingDepth;
    if (score > bestScore) { bestScore = score; best = d.clone(); }
  }
  return best || new Vec3(0.1, 1, 0.15).normalize();
}

// ---- Menu ----
function initMenu() {
  const seedInput = document.getElementById('seed-input');
  document.getElementById('set-sail-btn').addEventListener('click', () => {
    let seed = parseInt(seedInput.value.trim());
    if (isNaN(seed)) seed = DEFAULT_SEED;
    startGame(seed).catch(e => {
      document.getElementById('main-menu').style.display = 'none';
      document.getElementById('loading-screen').style.display = 'flex';
      document.getElementById('loading-text').textContent = 'Error: ' + e.message;
      console.error(e);
    });
  });
}

initMenu();
