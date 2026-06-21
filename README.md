# ⚓ Sea Shanty Wars

A voxel pirate game on a tiny round ocean planet. Sail a destructible wooden
ship across a curving sea dotted with islands; duel faction NPC vessels with
broadside cannon fire that blows real holes in hulls and topples masts; then
board the survivors and fight their crew hand-to-hand to steal the ship out from
under them — all to a soundtrack of genuine century-old sea shanties.

Built on a custom WebGPU engine (`webgpu.js/`) with GPU-driven rendering, a
marching-cubes voxel planet, and Gerstner-wave oceans.

---

## Requirements

- **A WebGPU-capable browser**: Chrome/Edge 113+ (best), or Firefox Nightly with
  WebGPU enabled. (If you see a black screen and a WebGPU error in the console,
  your browser/GPU doesn't have WebGPU — update or switch browser.)
- **A local web server.** The game uses ES modules + WebGPU, which browsers will
  NOT load from a `file://` path. You must serve it over `http://`.
- No build step, no npm install — it's plain ES modules served as static files.

## Run it

From the project root (`SeaShantyWars/`), start any static server, then open the
game's `index.html` through that server.

**Python (built in on most systems):**
```sh
python -m http.server 8731
```
Then open: <http://localhost:8731/game/index.html>

**Node (if you have it):**
```sh
npx serve -l 8731 .
# or:  npx http-server -p 8731 .
```
Then open: <http://localhost:8731/game/index.html>

**VS Code:** the "Live Server" extension works too — right-click
`game/index.html` → *Open with Live Server*.

> Tip: a server that shows a **directory listing** (like `python -m http.server`)
> lets the game auto-discover any extra shanty files you drop in (see Music).

On the menu, optionally type a **world seed** (same seed = same ocean/islands),
then hit **⚓ Set Sail**. Click the canvas to capture the mouse and look around.

---

## Controls

| Input | Action |
|------:|--------|
| **W A S D** | Move on foot (deck/land) · swim in water |
| **Space** | Jump · swim up · climb a ship's boarding ladder |
| **Shift** | Dive (swim down) |
| **Mouse** | Look (click the canvas first to capture the cursor) |
| **E** | Take the wheel (at the helm) · man a cannon (by a gun) · step off |
| **W / S** (at helm) | Raise / lower sails |
| **A / D** (at helm) | Steer |
| **LMB / RMB** (at helm) | Fire left / right broadside |
| **LMB** (manning a cannon) | Fire that single cannon |
| **LMB** (on foot) | Cutlass sweep — a fast wide arc that hits/parries every foe in front |
| **RMB** (on foot) | Pistol shot (ranged) |
| **F** (boarding, at a chest) | Open/plunder the treasure chest |
| **C** (boarding) | Capture the ship — *only once her deck is cleared of crew* |
| **T** (at helm) | Cut loose a ship you're towing |
| **Scroll** (at helm) | Zoom camera (all the way into first person) |
| **Tab** | Toggle the HUD readouts (title, health, music, status) |
| **P** | Pause |

## How to play

1. **Sail out.** Take the wheel (**E**), raise sail (**W**), steer (**A/D**).
   The sea is full of faction ships that fight *each other*: navy hunts pirates,
   pirates raid everyone, merchants and civilians flee. Sail into a battle.
2. **Fight.** Pull alongside an enemy and fire a broadside (**LMB/RMB**).
   Cannonballs punch real holes, snap masts (no masts = she can't sail), and a
   battered ship may **surrender**. Sink her and you lose her loot, so…
3. **Board.** Come alongside, walk across onto her deck. Her crew defends —
   cutlass-rushers and musketmen (a navy deck is a real fight; a civilian boat
   barely resists). Cut them down with **LMB**, shoot with **RMB**. Mind your
   health: the screen reddens and closes in as you're hurt; at zero you wash up
   on your own deck again.
4. **Plunder & capture.** Clear the deck, then **F** to crack her chest for gold,
   or **C** to capture the ship. A captured prize is automatically **taken under
   tow** behind you — drag her home (or **T** at the helm to cut her loose and
   sail her yourself).
5. **Sail to your cove.** A sky beacon marks your home cove (the HUD shows the
   distance). Sail into it and the **cove menu** opens: **Repair** your ships,
   manage **Your Fleet** (dock ships and pick which to sail out in), **Sell**
   docked ships for gold, or visit the **Shipwright** to buy a sloop, brig, or
   galleon. Towed prizes auto-moor when you arrive.

You can never be permanently stranded: lose all your ships and a fresh starter
sloop is launched for you.

## Music

The soundtrack is **real public-domain sea shanties** (Leonard Warren, RCA Victor
1948). The included files live in `game/audio/shanties/`; the playlist cycles
through them while you sail. If files are missing, the game falls back to a
built-in synthesised shanty so there's always music.

**Add more shanties:** drop any `.mp3` / `.ogg` / `.wav` into
`game/audio/shanties/`. If your server exposes a directory listing they're
auto-discovered; otherwise list them in `game/audio/shanties/manifest.json`.
See `game/audio/shanties/DOWNLOAD-THESE.md` for direct download links to the full
album and other public-domain sources.

Toggle music with the **shanties** checkbox in the HUD (**Tab** to show it).

---

## Project layout

```
game/                 the game
  index.html          entry point — open THIS through your server
  main.js             bootstrap + main loop + player/respawn/boarding glue
  planet.js           marching-cubes voxel ocean planet
  ocean.js            Gerstner-wave sea (GPU shader + matching CPU height sampler)
  ship/voxelShip.js   fully-voxel destructible ship (carveable hull, masts, cannons)
  ai.js               enemy ship navigation (CONTEXT STEERING) + combat AI
  fleet.js            the living sea: spawns/maintains the faction fleet
  crews.js            factions, hostility rules, loot, crew complements
  crew/               on-deck defending crew (voxel figures, melee/ranged AI)
  combat.js           cannonballs, hull damage, smoke, musket VFX
  camera.js           foot + helm cameras (orbit, zoom-to-first-person)
  audio/shanties.js   music (real recordings + synth fallback) and spatial SFX
  player.js           on-foot player (spherical gravity, ship-as-moving-terrain)
webgpu.js/            the custom WebGPU rendering engine (retained scene graph)
PlanetVoxel/          the original voxel-planet project this game reuses tech from
```

## Troubleshooting

- **Black screen / "WebGPU not supported":** use Chrome/Edge 113+ or enable
  WebGPU in your browser; make sure you're on `http://localhost`, not `file://`.
- **404s for `main.js` / modules:** you opened `index.html` directly instead of
  through the server, or from the wrong path. Use
  `http://localhost:PORT/game/index.html`.
- **No music, only the synth:** the audio files aren't being found — check the
  console (F12) for `[shanties]` logs and see
  `game/audio/shanties/DOWNLOAD-THESE.md`.
- **Stutter in big battles:** lots of ships + smoke. Tell the dev (or lower the
  fleet size in `main.js`, the `maxShips` option to `new Fleet(...)`).
