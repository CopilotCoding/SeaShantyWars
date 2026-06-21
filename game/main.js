import { DEFAULT_SEED, SEA_LEVEL } from './constants.js';
import { Planet } from './planet.js';
import { Ocean } from './ocean.js';
import { Player } from './player.js';
import { Camera } from './camera.js';
import { Input } from './input.js';
import { Shanties } from './audio/shanties.js';
import { setupScene, placeSun } from './sceneSetup.js';
import { VoxelShip as Ship } from './ship/voxelShip.js';
import { SHIP_SPECS } from './ship/hull.js';
import { Combat } from './combat.js';
import { Fleet } from './fleet.js';
import { Cove } from './cove.js';
import { buildCrewMesh } from './crew/crewVoxel.js';
import { Vec3, quatFromBasis } from './engine.js';

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
  // A visible VOXEL BODY for the player (a pirate with a cutlass), shown while on
  // foot so you see yourself + your weapon. Hidden at the helm/cannon (you ARE
  // the ship then). Reuses the crew figure builder for a matching look.
  const playerBody = buildCrewMesh(scene.device, 'pirate', 'melee');
  playerBody.visible = false;
  scene.add(playerBody);
  let _playerSwing = 0; // cutlass swing anim phase (1 -> 0) for the body

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

  // Your home PIRATE COVE — placed in a sheltered spot near your start. Sail home
  // to repair / store / sell / buy ships. A sky beacon marks it from afar.
  const cove = new Cove(scene, planet, ocean, shipDir);
  // The cove is a SANCTUARY — no enemies spawn within this radius of it.
  fleet.setSafeZone(cove.position, 130);
  let _atCove = false;        // true while the cove menu is open
  let _coveVisited = false;   // latched on arrival; cleared when you leave the radius

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
  // Plunder economy: gold you CARRY (on your person — lost if you die at sea,
  // banked when you reach your cove) vs gold STORED safe at the cove. Spending
  // at the cove (repair/buy) draws from the combined purse; selling/banking adds
  // to stored. Carried resets to 0 on death or on docking (it's deposited).
  let gold = 0;            // carried
  let goldStored = 0;      // banked at the cove

  // ---- Player health (for boarding combat) ----
  // No always-on bar: health is shown as a RED VIGNETTE that closes in (eats
  // further from the edges, darker) the lower your health is. A Tab-only HUD
  // line shows the number. A brief extra pulse layers on top when hit.
  const PLAYER_MAX_HP = 100;
  let playerHp = PLAYER_MAX_HP;
  let _hitPulse = 0;     // short red spike on taking a hit (decays)
  let _dead = false, _deathT = 0, _drowned = false;
  let _attackCd = 0, _reloadCd = 0; // cutlass swing / pistol reload cooldowns
  // ---- Breath / drowning ----
  // You can only tread water so long before you go under. The breath meter drains
  // while you're swimming (in the water, not aboard a ship or ashore) and refills
  // on deck/land. Empty = you drown (death + respawn). Realistic: get to a hull.
  const SWIM_SECONDS = 120;    // 2 minutes of swimming before drowning
  let breath = SWIM_SECONDS;
  const _vignetteEl = document.getElementById('health-vignette');
  const _breathEl = document.getElementById('breath-vignette');
  const _breathWarnEl = document.getElementById('breath-warn');
  const _healthValEl = document.getElementById('health-val');
  const _coveArrowEl = document.getElementById('cove-arrow');
  const _coveDistEl = document.getElementById('cove-dist');
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

  // An open-water spawn direction that is ALSO clear of every other ship, so a
  // fresh hull doesn't appear on top of an enemy (and you don't respawn inside
  // one). Tries open-water picks until one is far from all current ships.
  function clearShipSpawnDir() {
    const others = [...fleet.ships, ...fleet.owned].filter(shipAfloat);
    const SEA_R = SEA_LEVEL;
    for (let tries = 0; tries < 40; tries++) {
      const d = findOpenWater(planet);
      const wp = d.clone().multiplyScalar(SEA_R);
      let clear = true;
      for (const s of others) {
        if (wp.clone().sub(s.position).length() < 40) { clear = false; break; }
      }
      if (clear) return d;
    }
    return findOpenWater(planet); // give up — at least it's open water
  }

  // Build a fresh STARTER sloop at open water (clear of other ships) and make it
  // the player's new home ship: registered as a combat target + collision body.
  // Used when the player dies with no vessel left to their name (a clean restart).
  function makeStarterShip() {
    // Drop the old husk's mesh if it's still hanging around.
    if (ship && ship.mesh) scene.remove(ship.mesh);
    if (ship && ship.chestMesh) scene.remove(ship.chestMesh);
    combat.targets = combat.targets.filter(t => t !== ship);

    // A lost-everything restart launches you from your COVE (a safe harbour),
    // not random open sea — so you always come back at home base.
    const dir = cove.dir.clone();
    const fresh = new Ship(scene, ocean, 'sloop', dir, planet, {
      name: 'The Rusty Wench', faction: 'player',
      sailColor: 0xb33b3b, flagColor: 0x161616,
    });
    // Settle the ship: run a few update steps so its transform, buoyancy and
    // collision body are fully established BEFORE we stand the player on it.
    for (let i = 0; i < 4; i++) fresh.update(0.016);
    ship = fresh;
    combat.targets.push(ship);
    fleet.setPlayerShip(ship); // so ship-to-ship collision tracks the new hull
    player.ships = [ship, ...(fleet ? fleet.owned.filter(shipAfloat) : [])];
    return ship;
  }

  // Respawn after death. No permadeath: you wash up and try again. If your home
  // ship still floats (or you hold a captured ship), you're stood back on HER
  // deck; if you have NO ship left, a fresh starter sloop is launched for you.
  function respawnPlayer() {
    _dead = false; _drowned = false; playerHp = PLAYER_MAX_HP; _hitPulse = 0;
    breath = SWIM_SECONDS; // catch your breath on respawn
    controlMode = 'foot'; mannedCannon = null;
    if (gold > 0) { flashToast(`You lost ${gold} carried gold when you fell.`); gold = 0; }

    let home = pickRespawnShip();
    let freshStart = false;
    if (!home) { home = makeStarterShip(); freshStart = true; }
    ship = home;            // adopt this as the home ship
    activeShip = home;
    fleet.setPlayerShip(home);

    // Stand the player squarely ON HER DECK (toward the bow, off the mast
    // column) rather than in the water — so collision is solid immediately and
    // you can never wake up inside an adjacent enemy hull.
    home.update(0); // ensure transform current
    player.position.copy(home.localToWorld(
      new Vec3(0, home.deckLocalY() + 1.0, home.spec.length * 0.2)));
    player.up.copy(home.up);
    player.onShip = home;
    player.ships = [home, ...(fleet ? fleet.owned.filter(shipAfloat) : []),
      ...fleet.ships].filter((s, i, a) => a.indexOf(s) === i);
    player.velocity.set(0, 0, 0);
    flashToast(freshStart
      ? 'Your last ship lost — you wake aboard a fresh sloop. Sail again!'
      : 'You were cut down — you come to on your own deck.');
  }

  // ============================ PIRATE COVE ECONOMY ========================
  // Ships you've DOCKED at the cove (stored fleet). Each is a real Ship whose
  // mesh is hidden while stored; "sail out" swaps it in as your active ship.
  const storedShips = [];
  // Base value per class; sell = a fraction scaled by condition; buy = full.
  const SHIP_BASE_VALUE = { sloop: 300, brig: 900, galleon: 2400 };
  const shipCondition = (s) => Math.max(0, Math.min(1, s.hp / s.maxHp));
  const sellPrice = (s) => Math.round(SHIP_BASE_VALUE[s.specKey || 'sloop'] * (0.35 + 0.4 * shipCondition(s)));
  const buyPrice  = (key) => SHIP_BASE_VALUE[key];
  // Repair cost = gold per missing hull point, a touch more for bigger hulls.
  const repairCost = (s) => Math.round((s.maxHp - s.hp) * 1.5);
  // Spending at the cove draws from STORED first, then carried.
  const totalGold = () => goldStored + gold;
  function spend(n) {
    if (totalGold() < n) return false;
    const fromStored = Math.min(goldStored, n);
    goldStored -= fromStored;
    gold -= (n - fromStored);
    return true;
  }

  const coveMenuEl = document.getElementById('cove-menu');
  const coveBodyEl = document.getElementById('cove-body');
  const coveGoldEl = document.getElementById('cove-gold');
  let _coveTab = 'repair';

  function openCoveMenu() {
    if (coveMenuEl.style.display === 'flex') return;
    coveMenuEl.style.display = 'flex';
    if (input.pointerLocked) document.exitPointerLock();
    flashToast('You sail into your cove.');
    if (audio.playUi) audio.playUi();
    renderCove();
  }
  function closeCoveMenu() {
    coveMenuEl.style.display = 'none';
  }

  // Bring a stored/captured ship into service as your active home ship, and dock
  // the current one in its place (so you always sail out in exactly one ship).
  function sailOutIn(newShip) {
    // Dock the current active ship (hide it, park at cove) unless it's sinking.
    const cur = ship;
    if (cur && shipAfloat(cur) && cur !== newShip) {
      dockShip(cur);
    }
    // Un-dock the chosen ship.
    const di = storedShips.indexOf(newShip);
    if (di >= 0) storedShips.splice(di, 1);
    // Remove from fleet.owned if it was a captured prize floating in the world.
    if (fleet.owned) { const oi = fleet.owned.indexOf(newShip); if (oi >= 0) fleet.owned.splice(oi, 1); }
    newShip.faction = 'player';
    if (newShip.mesh) newShip.mesh.visible = true;
    if (newShip.wheelMesh) newShip.wheelMesh.visible = true;
    // Place her at the cove dock, afloat.
    newShip.dir.copy(cove.dir);
    newShip.position.copy(cove.position);
    newShip.update(0);
    if (!combat.targets.includes(newShip)) combat.targets.push(newShip);
    ship = newShip; activeShip = newShip;
    fleet.setPlayerShip(ship); // ship-to-ship collision tracks your new vessel
    flashToast(`You take command of ${newShip.name}.`);
  }

  // Park a ship at the cove: hide its mesh, remove from world lists, store it.
  function dockShip(s) {
    if (s.mesh) s.mesh.visible = false;
    if (s.chestMesh) s.chestMesh.visible = false;
    if (s.wheelMesh) s.wheelMesh.visible = false;
    if (s._towed) { s._towed = false; s._towSettle = 0; const ti = _towed.indexOf(s); if (ti >= 0) _towed.splice(ti, 1); }
    combat.targets = combat.targets.filter(t => t !== s);
    if (fleet.owned) { const oi = fleet.owned.indexOf(s); if (oi >= 0) fleet.owned.splice(oi, 1); }
    if (!storedShips.includes(s)) storedShips.push(s);
  }

  function renderCove() {
    coveGoldEl.innerHTML = `Stored: <b>${goldStored}g</b>　·　Carried: <b>${gold}g</b>`;
    document.querySelectorAll('.cove-tab').forEach(b =>
      b.classList.toggle('active', b.dataset.tab === _coveTab));
    coveBodyEl.innerHTML = '';
    const row = (html, btnLabel, onClick, disabled) => {
      const r = document.createElement('div'); r.className = 'cove-row';
      r.innerHTML = html;
      const b = document.createElement('button'); b.className = 'btn'; b.textContent = btnLabel;
      if (disabled) { b.disabled = true; b.style.opacity = '0.45'; b.style.cursor = 'default'; }
      else b.onclick = () => { onClick(); renderCove(); };
      r.appendChild(b); coveBodyEl.appendChild(r);
    };
    const empty = (msg) => { const e = document.createElement('div'); e.id = 'cove-empty'; e.textContent = msg; coveBodyEl.appendChild(e); };

    if (_coveTab === 'repair') {
      // Repair the active ship + any docked ship that's damaged.
      const all = [ship, ...storedShips].filter(shipAfloat);
      let any = false;
      for (const s of all) {
        const cost = repairCost(s);
        if (cost <= 0) continue;
        any = true;
        const pct = Math.round(shipCondition(s) * 100);
        row(`<span class="name"><b>${s.name}</b> · ${s.spec.name}<br><span class="meta">hull ${pct}% · repair ${cost}g</span></span>`,
          `Repair (${cost}g)`, () => {
            if (!spend(cost)) { flashToast('Not enough gold to repair.'); return; }
            s.hp = s.maxHp;
            if (s.recommission) s.recommission(); // un-disable if she was crippled
            if (audio.playSell) audio.playSell();
            flashToast(`${s.name} repaired to full.`);
          }, totalGold() < cost);
      }
      if (!any) empty('All your ships are in fine fettle.');
    } else if (_coveTab === 'store') {
      // Your fleet: the active ship + docked ships. Sail out in any.
      const active = ship;
      const r = document.createElement('div'); r.className = 'cove-row';
      r.innerHTML = `<span class="name"><b>${active.name}</b> · ${active.spec.name} <span class="meta">(at the helm)</span></span>`;
      coveBodyEl.appendChild(r);
      if (!storedShips.length) { empty('No other ships docked. Tow captures home to store them.'); }
      for (const s of [...storedShips]) {
        const pct = Math.round(shipCondition(s) * 100);
        row(`<span class="name"><b>${s.name}</b> · ${s.spec.name}<br><span class="meta">docked · hull ${pct}%</span></span>`,
          'Sail out', () => sailOutIn(s));
      }
    } else if (_coveTab === 'sell') {
      if (!storedShips.length) { empty('No docked ships to sell. (You can\'t sell the ship you\'re standing on.)'); }
      for (const s of [...storedShips]) {
        const price = sellPrice(s);
        row(`<span class="name"><b>${s.name}</b> · ${s.spec.name}<br><span class="meta">hull ${Math.round(shipCondition(s)*100)}% · sells for ${price}g</span></span>`,
          `Sell (${price}g)`, () => {
            goldStored += price; // banked at the cove
            const i = storedShips.indexOf(s); if (i >= 0) storedShips.splice(i, 1);
            if (s.mesh) scene.remove(s.mesh);
            if (s.chestMesh) scene.remove(s.chestMesh);
            if (s.wheelMesh) scene.remove(s.wheelMesh);
            if (audio.playSell) audio.playSell();
            flashToast(`Sold ${s.name} for ${price} gold.`);
          });
      }
    } else if (_coveTab === 'buy') {
      for (const key of ['sloop', 'brig', 'galleon']) {
        const spec = SHIP_SPECS[key]; const price = buyPrice(key);
        row(`<span class="name"><b>${spec.name}</b><br><span class="meta">${spec.hp} hull · ${spec.cannonsPerSide*2} guns · ${price}g</span></span>`,
          `Buy (${price}g)`, () => {
            if (!spend(price)) { flashToast('Not enough gold.'); return; }
            const bought = new Ship(scene, ocean, key, cove.dir, planet, {
              name: randomShipName(), faction: 'player',
              sailColor: 0xb33b3b, flagColor: 0x161616,
            });
            for (let i = 0; i < 3; i++) bought.update(0.016);
            dockShip(bought); // parked at the cove, ready to sail out
            if (audio.playSell) audio.playSell();
            flashToast(`Bought a ${spec.name}! She's docked — sail out from "Your Fleet".`);
          }, totalGold() < price);
      }
    }
  }

  // Cove menu wiring (tabs + leave button).
  document.querySelectorAll('.cove-tab').forEach(b =>
    b.addEventListener('click', () => { _coveTab = b.dataset.tab; renderCove(); }));
  document.getElementById('cove-leave-btn').addEventListener('click', () => {
    // Close the menu and DON'T reopen until you sail out & back (the _coveVisited
    // latch, set on arrival, stays true until you leave the radius).
    _atCove = false; closeCoveMenu();
    if (renderer.domElement && !input.pointerLocked) input.requestPointerLock(renderer.domElement);
  });

  // Pose + show the player's voxel body (with cutlass). Visible while on FOOT and
  // at the HELM in third-person; hidden in first-person (it'd fill the screen)
  // and while manning a gun. Stands at the player's feet, faces the look/heading
  // direction, and plays the cutlass swing animation.
  function posePlayerBody(dt) {
    const up = player.up.clone().normalize();
    // Facing: at the helm use the ship's bow; on foot use the camera look dir.
    let fwd;
    if (controlMode === 'helm' && activeShip) fwd = activeShip.forward.clone();
    else fwd = camera.getForwardDir().clone();
    fwd.addScaledVector(up, -fwd.dot(up));            // flatten to the deck plane
    if (fwd.lengthSq() < 1e-5) fwd = new Vec3(0, 0, 1);
    fwd.normalize();
    const right = new Vec3().crossVectors(up, fwd).normalize();

    // Visibility rules.
    const helmFP = controlMode === 'helm' && (camera._helmDist ?? 1) < 0.18; // zoomed to first person
    const show = controlMode === 'foot' || (controlMode === 'helm' && !helmFP);
    playerBody.visible = show;
    if (!show) return;

    playerBody.position.copy(player.position);
    const q = quatFromBasis([right.x, right.y, right.z], [up.x, up.y, up.z], [fwd.x, fwd.y, fwd.z]);
    playerBody.quaternion.set(q[0], q[1], q[2], q[3]);

    // Cutlass swing animation (driven by _playerSwing, set when you attack).
    const arm = playerBody._swingArm;
    if (arm) {
      if (_playerSwing > 0) _playerSwing = Math.max(0, _playerSwing - dt * 7);
      // Sweep ACROSS the front (yaw the whole arm) for the wide-arc feel.
      const a = Math.sin((1 - _playerSwing) * Math.PI); // 0..1..0
      arm.quaternion.setFromAxisAngle(new Vec3(0, 1, 0), -1.2 * _playerSwing + 0.2);
      void a;
    }
  }

  // A throwaway pirate-y name for bought ships.
  function randomShipName() {
    const a = ['Black', 'Crimson', 'Salt', 'Gilded', 'Rogue', 'Storm', 'Iron', 'Bonny'];
    const b = ['Maw', 'Wager', 'Lass', 'Tide', 'Wraith', 'Crown', 'Verse', 'Gale'];
    return `The ${a[Math.floor(Math.random()*a.length)]} ${b[Math.floor(Math.random()*b.length)]}`;
  }

  // ============================== TOWING ==================================
  // Captured prizes trail behind your ship on a tow line so you can drag them
  // home. Each towed ship is pulled toward a point a fixed distance ASTERN of the
  // ship ahead of it in the chain (a spring-follow with a hard clamp so it can't
  // snap/teleport). They keep their AI off (they're in fleet.owned) and just get
  // positioned here. Reaching the cove auto-docks them.
  const _towed = []; // captured ships under tow, in chain order (nearest first)

  function startTow(s) {
    if (_towed.includes(s)) return;
    // Towed ships shouldn't try to sail; the fleet already furls owned sails.
    s.sailRaised = 0; s.speed = 0; s.reverse = false;
    s._towed = true;
    // Suppress her collision briefly while she swings into line behind the tug,
    // so hitching doesn't shove your ship. updateTow clears it once she's settled
    // (or after a short timeout), after which collision is live again.
    s._towSettle = 2.5;
    _towed.push(s);
  }
  function dropTow(s) {
    const i = _towed.indexOf(s);
    if (i >= 0) _towed.splice(i, 1);
    s._towed = false; s._towSettle = 0;
  }

  // [T] handler: hitch or cut loose the nearest CAPTURED ship. Works from the
  // helm or on foot — you just have to be near her (or aboard her). Captured
  // ships are faction 'player' and live in fleet.owned; we never tow the ship
  // you're currently sailing.
  function toggleTowNearest() {
    const me = activeShip || ship;
    const ref = (controlMode === 'foot') ? player.position : me.position;
    // First: if we're already towing something, the closest towed ship is cut.
    let best = null, bestD = Infinity;
    const candidates = (fleet.owned || []).filter(s =>
      s !== me && shipAfloat(s));
    // Also allow hitching the ship you're literally standing on.
    if (player.onShip && player.onShip !== me && player.onShip.faction === 'player'
        && shipAfloat(player.onShip) && !candidates.includes(player.onShip)) {
      candidates.push(player.onShip);
    }
    for (const s of candidates) {
      const d = s.position.clone().sub(ref).length();
      // Generous reach so you don't have to be pixel-perfect alongside.
      if (d < s.spec.length * 0.6 + 30 && d < bestD) { bestD = d; best = s; }
    }
    if (!best) { flashToast('No captured ship nearby to tow. Capture one first ([C]).'); return; }
    if (_towed.includes(best)) { dropTow(best); flashToast(`Cut ${best.name} loose.`); }
    else { startTow(best); flashToast(`${best.name} hitched — drag her to your cove.`); }
  }

  function updateTow(dt) {
    if (!_towed.length) return;
    let lead = activeShip || ship;     // the ship doing the pulling
    for (const t of _towed) {
      if (!shipAfloat(t)) { dropTow(t); continue; }
      // Target point: astern of `lead` by (half its length + a gap + half tow's).
      const gap = lead.spec.length * 0.5 + 6 + t.spec.length * 0.5;
      const astern = lead.forward.clone().multiplyScalar(-1);
      const target = lead.position.clone().addScaledVector(astern, gap);
      target.setLength(SEA_LEVEL);     // keep on the sea surface
      // Spring toward the target, clamped so a fast tug can't teleport the prize.
      const toTarget = target.clone().sub(t.position);
      const dist = toTarget.length();
      const step = Math.min(dist, dist * Math.min(1, dt * 2.5) + lead.speed * dt);
      if (dist > 1e-3) t.position.addScaledVector(toTarget.multiplyScalar(1 / dist), step);
      t.position.setLength(SEA_LEVEL);
      t.dir.copy(t.position).normalize();
      // Settle window: collision stays off until she's roughly in line behind the
      // tug (or the timer lapses), then it switches back on.
      if (t._towSettle > 0) {
        t._towSettle -= dt;
        if (dist < t.spec.beam * 1.2) t._towSettle = 0; // arrived in the slot
      }
      // Point the prize's bow along the tow direction (toward the lead).
      const towDir = lead.position.clone().sub(t.position);
      towDir.addScaledVector(t.dir, -towDir.dot(t.dir)); // project to tangent
      if (towDir.lengthSq() > 1e-5) t.heading.copy(towDir.normalize());
      lead = t; // the next ship trails THIS one (a proper chain)
    }
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
    // Docked at the cove with the menu open: freeze the world (browse in peace).
    if (_atCove) dt = 0;

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
        if (input.consumeKey('KeyT')) toggleTowNearest(); // hitch/cut the nearest prize
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
          // ---- Cutlass: a fast, WIDE SWEEP that catches every crewman in a ~120°
          // arc in front of you. Any of them caught MID-SWING is PARRIED (a clash,
          // their blow cancelled, no damage to you); the rest are cut. So a single
          // sweep can block multiple incoming blades and wound several foes at once.
          if (input.consumeClick() && _attackCd <= 0) {
            _attackCd = 0.28; camera.addShake(0.12); _playerSwing = 1; // faster swings + anim
            const origin = player.position.clone().addScaledVector(player.up, 0.9); // chest height
            const dir = camera.getForwardDir().clone();
            dir.addScaledVector(player.up, -dir.dot(player.up)); // flatten to deck plane
            if (dir.lengthSq() > 1e-5) dir.normalize();
            const SWEEP_REACH = 3.0, SWEEP_HALF = Math.PI * 0.5; // ~100° each side feels generous
            const inArc = party.aliveInArc(origin, dir, SWEEP_REACH, SWEEP_HALF);
            let parried = 0, struck = 0, anyKill = false;
            for (const m of inArc) {
              if (m.isSwinging && m.isSwinging()) {
                m.parried();          // CLASH — block their blow, no trade
                parried++;
              } else {
                if (m.hurt(24 + Math.random() * 10)) anyKill = true;
                struck++;
              }
            }
            // Sound: a ringing clash if we parried anyone, else a cutting hit / a
            // whiff if we caught nothing.
            if (parried && audio.playClash) audio.playClash(player.position);
            else if (struck && audio.playHit) audio.playHit(player.position);
            else if (audio.playClash) audio.playClash(player.position); // swoosh-ish
            if (anyKill && party.cleared()) flashToast(`${onShip.name}'s deck is yours! Press [C] to take her.`);
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
            // She's yours and drifts free — sail her yourself, or press [T] to
            // hitch a tow line and drag her home to your cove. (No auto-hitch:
            // it used to yank your ship around on every capture.)
            flashToast(`Captured ${enemy.name}! Take her helm, or [T] to tow her home.`
              + (g ? ` (+${g} gold from her hold.)` : ''));
            if (audio.playSell) audio.playSell();
          }
        }
      }
      // [T] on foot: hitch/unhitch the nearest captured ship (you don't have to
      // be standing on her — just near her).
      if (input.pointerLocked && !paused && input.consumeKey('KeyT')) toggleTowNearest();
      ship.setControls({ rudder: 0, sailDelta: 0 });
      runPlayerPhysics = true;
    }

    // The player's HOME ship updates here UNLESS the fleet already owns/updates
    // it (a captured ship adopted as home after losing the original) — otherwise
    // it'd be integrated twice and move at double speed.
    const homeInFleet = fleet.owned && fleet.owned.includes(ship);
    if (!homeInFleet) ship.update(dt);
    if (_dead && _drowned) {
      // DROWNING: drag the body under the surface (overrides buoyancy) while the
      // death delay plays out, then respawn. The screen darkens via the
      // underwater overlay below. No controls.
      const downAxis = player.position.clone().normalize();
      player.position.addScaledVector(downAxis, -2.2 * dt); // sink steadily
      player.up.copy(downAxis);
      player.onShip = null; player.grounded = false;
      camera.update(player.position, player.up, true);
    } else if (runPlayerPhysics) {
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
    posePlayerBody(dt); // show your voxel pirate body + cutlass

    // Enemy ships + projectiles.
    // AI decides controls/firing, THEN the enemy ship integrates them.
    // The living sea: AI + ship updates + respawns for the whole fleet.
    // Tell the fleet which captured ship the player is actively steering, so it
    // doesn't force that one's sails down.
    fleet.update(dt, audio, paused, activeShip !== ship ? activeShip : null,
      { player, dealDamage: damagePlayer });
    combat.update(dt);
    cove.update(dt, now / 1000);
    updateTow(dt); // drag captured prizes along behind you

    // ---- Cove arrival: when your active ship glides into the cove radius, dock.
    // Opens the cove menu ONCE. After you cast off it will NOT reopen until you
    // sail back OUT of the radius and return — `_coveVisited` latches that, fixing
    // the "menu reopens every second while parked" spam.
    const coveRef = activeShip || ship;
    const nearCove = coveRef && cove.playerNear(coveRef.position);
    if (nearCove) {
      // Towed prizes that have arrived auto-moor (generous radius so you don't
      // have to nose right up to the dock).
      for (const t of [..._towed]) {
        if (cove.distanceTo(t.position) < cove.dockRadius + 40) {
          dropTow(t); dockShip(t);
          flashToast(`${t.name} is moored at your cove.`);
        }
      }
      // Arriving banks your carried gold (safe at the cove).
      if (!_coveVisited && gold > 0) {
        goldStored += gold;
        flashToast(`Banked ${gold} gold at your cove.`);
        gold = 0;
      }
    } else {
      _coveVisited = false; // left the radius — a future arrival opens the menu again
    }
    if (nearCove && !_atCove && !_coveVisited) {
      _atCove = true;
      _coveVisited = true; // don't auto-reopen until we leave & come back
      openCoveMenu();
    } else if (!nearCove && _atCove) {
      _atCove = false;
      closeCoveMenu();
    }

    // Hit pulse decays; death triggers a brief delay then respawn.
    if (_hitPulse > 0) _hitPulse = Math.max(0, _hitPulse - dt * 1.5);
    if (_dead) { _deathT += dt; if (_deathT > 4.5) respawnPlayer(); }
    else {
      // ---- Breath / drowning ----
      // Breath only RECOVERS when you're genuinely safe: standing on a ship's
      // deck OR ashore on land. While you're out at sea — whether your head is
      // under, at the surface, or you bobbed/jumped into the AIR over the water —
      // your breath does NOT refill (it drains in the water, and just HOLDS while
      // briefly airborne over the sea). This stops you cheesing it by hopping
      // above the surface for a frame. Reach a hull or shore before it runs out.
      const safe = player.onShip || (player.grounded && !player.inWater);
      if (safe) {
        breath = Math.min(SWIM_SECONDS, breath + dt * 4); // catch your breath
      } else if (player.inWater) {
        breath -= dt;                                     // swimming — drains
        if (breath <= 0) {
          breath = 0; _drowned = true; playerHp = 0; _dead = true; _deathT = 0;
          if (audio.playSplash) audio.playSplash(player.position);
          camera.addShake(0.5);
          flashToast('You slip beneath the waves — drowned!');
        }
      }
      // (else: airborne over the sea — breath holds, neither drains nor refills)
    }
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

    // ---- Breath vignette: a blue closing-in tint as air runs low. Only really
    // shows in the last ~20s of breath; pulses + warns near empty. ----
    if (_breathEl) {
      const bfrac = breath / SWIM_SECONDS;               // 1 full .. 0 empty
      const low = Math.max(0, 1 - bfrac / 0.4);          // 0 until <40% air, ramps to 1 at empty
      const inner = Math.round(95 - low * 70);           // centre closes in
      // Pulse faster as it gets desperate.
      const pulse = low > 0 ? (0.12 * low) * (0.6 + 0.4 * Math.sin(now / 1000 * (4 + low * 8))) : 0;
      const alpha = Math.min(0.85, low * 0.7 + pulse);
      _breathEl.style.setProperty('--bv-inner', inner + '%');
      _breathEl.style.setProperty('--bv-alpha', alpha.toFixed(3));
      if (_breathWarnEl) _breathWarnEl.style.opacity = (breath < 12 && !_dead) ? '1' : '0';
    }

    // ---- Cove compass: an arrow that points toward home + the distance, so you
    // can always steer back. The bearing is the cove direction relative to where
    // the camera is looking, projected onto the local tangent plane.
    if (_coveArrowEl && _coveDistEl) {
      const from = (activeShip || ship).position;
      const dist = Math.round(cove.distanceTo(from));
      const up = from.clone().normalize();
      // Direction to the cove, in the tangent plane at the player.
      const toCove = cove.position.clone().sub(from);
      toCove.addScaledVector(up, -toCove.dot(up));
      // Camera look + right, also tangent-projected.
      const look = camera.getForwardDir().clone(); look.addScaledVector(up, -look.dot(up));
      const right = new Vec3().crossVectors(up, look);
      let glyph = '•';
      if (toCove.lengthSq() > 1e-4 && look.lengthSq() > 1e-4) {
        toCove.normalize(); look.normalize(); right.normalize();
        const ang = Math.atan2(toCove.dot(right), toCove.dot(look)); // 0 = ahead
        const deg = ang * 180 / Math.PI;
        glyph = Math.abs(deg) < 22 ? '↑' : Math.abs(deg) > 158 ? '↓'
          : deg >= 22 && deg < 68 ? '↗' : deg >= 68 && deg < 112 ? '→'
          : deg >= 112 ? '↘' : deg <= -22 && deg > -68 ? '↖'
          : deg <= -68 && deg > -112 ? '←' : '↙';
      }
      _coveArrowEl.textContent = glyph;
      _coveDistEl.textContent = dist < cove.dockRadius ? 'home' : `${dist}u`;
    }


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
      let op = underwater ? Math.min(0.9, 0.5 + eyeDepth * 0.04) : band * 0.5;
      // DROWNING: everything goes dark and murky — the overlay deepens toward
      // near-black as you sink and your vision fades out before respawning.
      if (_dead && _drowned) op = Math.max(op, Math.min(0.98, 0.55 + _deathT * 0.12));
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

    // Gold line (Tab-gated like the rest of the HUD): carried gold + what's
    // banked at your cove. No target/enemy readout — kept deliberately minimal.
    if (combatEl) {
      combatEl.innerHTML = `🪙 <b>${gold}g</b> carried　·　🏴‍☠️ <b>${goldStored}g</b> at cove`;
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
          parts.push(`⚔ ${crewLeft} defending · [LMB] cutlass sweep (parries!) · [RMB] pistol`);
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
      // A running bearing/distance to your cove so you can always find home.
      const coveDist = Math.round(cove.distanceTo((activeShip || ship).position));
      const coveTag = ` · 🏴‍☠️ cove ${coveDist}u`;
      const towTag = _towed.length ? ` · towing ${_towed.length} ([T] cut loose)` : '';
      if (controlMode === 'helm' && activeShip) {
        statusEl.textContent = `⎈ At the helm of ${activeShip.name} · sail ${Math.round(activeShip.sailRaised*100)}% · ${Math.abs(activeShip.speed).toFixed(1)} kn${towTag}${coveTag}`;
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
