# Real public-domain shanties — download & drop in here

I can't download binary audio into the project, but here are the direct URLs.
**Right-click → Save As** each link into THIS folder (`game/audio/shanties/`).

**Auto-load:** you no longer have to match a name list. Anything you drop in here
is auto-discovered and added to the sailing playlist, IF your server exposes a
directory listing (python `http.server`, nginx autoindex, etc.). If it doesn't,
either (a) keep the exact target filenames below — they're in the game's lookup —
or (b) create a `manifest.json` here listing your filenames (see the bottom).

Hard-reload after adding; check the console (F12) for `[shanties] loaded …` and
`[shanties] auto-discovered …`.

## Full set — Leonard Warren, "Sea Shanties", RCA Victor 1948 (78rpm, US public domain)
Internet Archive item:
https://archive.org/details/78_rio-grande_leonard-warren-tom-scott-morris-levine_gbia0036362

All 8 tracks of the album (you already have 01,02,04,05,07,08 — the **missing two
are 03 and 06**):

| Save as (target filename)   | Download URL |
|-----------------------------|--------------|
| `blow-the-man-down.mp3`     | https://archive.org/download/78_rio-grande_leonard-warren-tom-scott-morris-levine_gbia0036362/01%20-%20Blow%20the%20Man%20Down%20-%20Leonard%20Warren%20-%20Tom%20Scott.mp3 |
| `rio-grande.mp3`            | https://archive.org/download/78_rio-grande_leonard-warren-tom-scott-morris-levine_gbia0036362/02%20-%20Rio%20Grande%20-%20Leonard%20Warren%20-%20Tom%20Scott%20-%20Morris%20Levine.mp3 |
| `drummer-and-cook.mp3` ⬅NEW | https://archive.org/download/78_rio-grande_leonard-warren-tom-scott-morris-levine_gbia0036362/03%20-%20The%20Drummer%20and%20the%20Cook%20-%20Leonard%20Warren%20-%20Tom%20Scott.mp3 |
| `shenandoah.mp3`           | https://archive.org/download/78_rio-grande_leonard-warren-tom-scott-morris-levine_gbia0036362/04%20-%20Shenandoah%20-%20Leonard%20Warren%20-%20Tom%20Scott%20-%20Morris%20Levine.mp3 |
| `haul-away-joe.mp3`        | https://archive.org/download/78_rio-grande_leonard-warren-tom-scott-morris-levine_gbia0036362/05%20-%20Haul-A-Way%2C%20Joe%20-%20Leonard%20Warren%20-%20Tom%20Scott.mp3 |
| `low-lands.mp3` ⬅NEW       | https://archive.org/download/78_rio-grande_leonard-warren-tom-scott-morris-levine_gbia0036362/06%20-%20Low%20Lands%20-%20Leonard%20Warren%20-%20Tom%20Scott.mp3 |
| `drunken-sailor.mp3`      | https://archive.org/download/78_rio-grande_leonard-warren-tom-scott-morris-levine_gbia0036362/07%20-%20The%20Drunken%20Sailor%20-%20Leonard%20Warren%20-%20Tom%20Scott.mp3 |
| `a-roving.mp3`            | https://archive.org/download/78_rio-grande_leonard-warren-tom-scott-morris-levine_gbia0036362/08%20-%20A-Rovin%27%20-%20Leonard%20Warren%20-%20Tom%20Scott%20-%20Morris%20Levine.mp3 |

(If the `03`/`06` exact URLs 404, open the IA item page above and grab the real
file links from the "SHOW ALL" files list — IA filenames vary slightly per item.)

## More public-domain shanty sources (for real variety — drop in any you like)
With auto-load on, ANY file you add joins the playlist. Good hunting grounds:

- **Internet Archive** — search ["sea shanty" / "chanty", filter Public Domain](https://archive.org/search?query=sea+shanty&and[]=licenseurl%3A%22*publicdomain*%22).
  Many 1900s–1920s cylinder/78rpm recordings are PD.
- **IA "Sea Shanties" collection**: https://archive.org/details/20210129-sea-shanties
- **Wikimedia Commons — sea shanty audio**:
  https://commons.wikimedia.org/wiki/Category:Audio_files_of_sea_shanties
  (e.g. `Haul Away Joe`, `Blow the Man Down`, `Spanish Ladies`, `Shenandoah` —
  check each file's licence; prefer PD or CC-BY and credit in your README.)
- **Musopen** (public-domain recordings): https://musopen.org
- **Public Domain Review** (sheet music + some audio): https://publicdomainreview.org

Classic PD shanty TUNES worth searching for: Drunken Sailor, Leave Her Johnny,
Blow the Man Down, Haul Away Joe, Shenandoah, Spanish Ladies, A-Roving, Santiana,
Rio Grande, Bound for South Australia, Spanish Ladies, The Wellerman (tune is PD;
use a clearly-PD rendition, not a modern copyrighted recording).

## How the game uses them
- All album tracks cycle as **sailing** music (the playlist advances song to song).
- `blow-the-man-down` / `drunken-sailor` / `haul-away-joe` / `rio-grande` → also **battle**.
- `shenandoah` / `a-roving` / `drummer-and-cook` → **menu / cove**.
- Anything you add via auto-load joins the **sailing** rotation.
- Anything missing falls back to the built-in synth.

## Optional: manifest.json (guarantees auto-load on any server)
If your server has no directory listing, create a file `manifest.json` in this
folder containing a JSON array of your audio filenames, e.g.:

```json
[
  "drunken-sailor.mp3",
  "low-lands.mp3",
  "my-extra-shanty.ogg"
]
```

The game reads it first and loads exactly those files.
