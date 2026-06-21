SEA SHANTY WARS — MUSIC FOLDER
==============================

The game's soundtrack is real, public-domain sea shanty recordings, loaded from
this folder. If a recording is missing the game falls back to a built-in
synthesised shanty, so there is always music. Supported formats: .mp3, .ogg, .wav.

Files included: the complete Leonard Warren "Sea Shanties" album
(RCA Victor, 1948 — public domain in the US):
    01 - Blow the Man Down
    02 - Rio Grande
    03 - The Drummer and the Cook
    04 - Shenandoah
    05 - Haul-A-Way, Joe
    06 - Low Lands
    07 - The Drunken Sailor
    08 - A-Rovin'


HOW LOADING WORKS
-----------------
On startup the game discovers audio three ways, in order:

  1. manifest.json  — if this folder contains a manifest.json (a JSON array of
     filenames), exactly those files are loaded. This is the most reliable method
     and works on any web server.

  2. Directory listing — if the server exposes a directory index for this folder
     (python's http.server, nginx autoindex, etc.), every .mp3/.ogg/.wav link in
     the listing is picked up automatically.

  3. Built-in name list — a set of known track names (the Warren album above,
     under both short names like "drunken-sailor" and the original archive.org
     filenames) is always tried, so the shipped files load even with no listing.

Anything discovered beyond the known album is added to the sailing playlist.


ADDING YOUR OWN SHANTIES
------------------------
Drop any .mp3/.ogg/.wav into this folder. If your server has a directory listing
they load automatically; otherwise add their filenames to manifest.json, e.g.:

    [
      "drunken-sailor.mp3",
      "low-lands.mp3",
      "my-extra-shanty.ogg"
    ]

Then hard-reload the game. The browser console (F12) logs each file as it loads
("[shanties] loaded ... ") and notes any auto-discovered extras.


HOW TRACKS ARE USED
-------------------
  Sailing  — the whole album cycles song to song while you're at sea. Any extra
             files you add join this rotation.
  Battle   — Blow the Man Down, The Drunken Sailor, Haul-A-Way Joe, Rio Grande.
  Menu     — Shenandoah, Rio Grande, Low Lands.
  Cove     — Shenandoah, A-Rovin', The Drummer and the Cook.
Toggle the music with the "shanties" checkbox in the HUD (press Tab to show it).


SOURCING MORE PUBLIC-DOMAIN SHANTIES
------------------------------------
These tunes are traditional and public domain; look for clearly PD or CC0
recordings (always check each file's licence):
  - Internet Archive   https://archive.org   (search "sea shanty"/"chanty",
                        filter to Public Domain — many 1900s-1920s recordings)
  - Wikimedia Commons   https://commons.wikimedia.org/wiki/Category:Audio_files_of_sea_shanties
  - Musopen            https://musopen.org

Good PD shanty tunes to look for: Drunken Sailor, Leave Her Johnny, Blow the Man
Down, Haul Away Joe, Shenandoah, Spanish Ladies, A-Roving, Santiana, Rio Grande,
Bound for South Australia.

Note on "The Wellerman": the tune is old and public domain, but most modern viral
recordings are copyrighted — only use a clearly public-domain rendition.
