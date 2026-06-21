# Sea shanty recordings — download links

The game plays real public-domain sea shanties from this folder. The complete
**Leonard Warren "Sea Shanties"** album (RCA Victor, 1948 — public domain in the
US) is included. These links are the source for re-downloading any track;
**right-click → Save As** into this folder (`game/audio/shanties/`).

## Auto-loading
Files in this folder load automatically when the server exposes a directory
listing (python's `http.server`, nginx autoindex, etc.). If it doesn't, either
keep the exact target filenames below (they're in the game's built-in name list)
or list your files in `manifest.json` (see the bottom of this file). After adding
files, hard-reload the game; the browser console (F12) logs each one.

## Leonard Warren — "Sea Shanties" (RCA Victor, 1948)
Internet Archive item:
https://archive.org/details/78_rio-grande_leonard-warren-tom-scott-morris-levine_gbia0036362

| Save as (target filename)   | Download URL |
|-----------------------------|--------------|
| `blow-the-man-down.mp3`     | https://archive.org/download/78_rio-grande_leonard-warren-tom-scott-morris-levine_gbia0036362/01%20-%20Blow%20the%20Man%20Down%20-%20Leonard%20Warren%20-%20Tom%20Scott.mp3 |
| `rio-grande.mp3`            | https://archive.org/download/78_rio-grande_leonard-warren-tom-scott-morris-levine_gbia0036362/02%20-%20Rio%20Grande%20-%20Leonard%20Warren%20-%20Tom%20Scott%20-%20Morris%20Levine.mp3 |
| `03 - The Drummer and the Cook - Leonard Warren.mp3` | https://archive.org/download/78_rio-grande_leonard-warren-tom-scott-morris-levine_gbia0036362/03%20-%20The%20Drummer%20and%20the%20Cook%20-%20Leonard%20Warren%20-%20Tom%20Scott.mp3 |
| `shenandoah.mp3`           | https://archive.org/download/78_rio-grande_leonard-warren-tom-scott-morris-levine_gbia0036362/04%20-%20Shenandoah%20-%20Leonard%20Warren%20-%20Tom%20Scott%20-%20Morris%20Levine.mp3 |
| `haul-away-joe.mp3`        | https://archive.org/download/78_rio-grande_leonard-warren-tom-scott-morris-levine_gbia0036362/05%20-%20Haul-A-Way%2C%20Joe%20-%20Leonard%20Warren%20-%20Tom%20Scott.mp3 |
| `06 - Low Lands - Leonard Warren - Tom Scott - Morris Levine.mp3` | https://archive.org/download/78_rio-grande_leonard-warren-tom-scott-morris-levine_gbia0036362/06%20-%20Low%20Lands%20-%20Leonard%20Warren%20-%20Tom%20Scott.mp3 |
| `drunken-sailor.mp3`      | https://archive.org/download/78_rio-grande_leonard-warren-tom-scott-morris-levine_gbia0036362/07%20-%20The%20Drunken%20Sailor%20-%20Leonard%20Warren%20-%20Tom%20Scott.mp3 |
| `a-roving.mp3`            | https://archive.org/download/78_rio-grande_leonard-warren-tom-scott-morris-levine_gbia0036362/08%20-%20A-Rovin%27%20-%20Leonard%20Warren%20-%20Tom%20Scott%20-%20Morris%20Levine.mp3 |

If a download URL 404s, open the Internet Archive item page above, click **SHOW
ALL** in the files list, and grab the current link — archive.org filenames vary
slightly per item.

## More public-domain shanties
Any audio file dropped in this folder joins the sailing playlist. Good sources
(check each file's licence — prefer Public Domain or CC0):

- **Internet Archive** — search ["sea shanty"/"chanty", filtered to Public
  Domain](https://archive.org/search?query=sea+shanty). Many 1900s–1920s
  cylinder and 78rpm recordings are public domain.
- **Wikimedia Commons** — https://commons.wikimedia.org/wiki/Category:Audio_files_of_sea_shanties
- **Musopen** — https://musopen.org

Classic public-domain tunes worth searching for: Drunken Sailor, Leave Her
Johnny, Blow the Man Down, Haul Away Joe, Shenandoah, Spanish Ladies, A-Roving,
Santiana, Rio Grande, Bound for South Australia. (The Wellerman tune is public
domain, but most modern recordings of it are not — use a clearly PD rendition.)

## How the game uses the tracks
- **Sailing** — the whole album cycles song to song; added files join this rotation.
- **Battle** — Blow the Man Down, The Drunken Sailor, Haul-A-Way Joe, Rio Grande.
- **Menu** — Shenandoah, Rio Grande, Low Lands.
- **Cove** — Shenandoah, A-Rovin', The Drummer and the Cook.
- Any missing track falls back to the built-in synth.

## manifest.json (guarantees loading on any server)
If your server has no directory listing, create `manifest.json` in this folder
listing your audio filenames:

```json
[
  "drunken-sailor.mp3",
  "low-lands.mp3",
  "my-extra-shanty.ogg"
]
```

The game reads it first and loads exactly those files.
