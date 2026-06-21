DROP YOUR SEA SHANTY RECORDINGS IN THIS FOLDER
==============================================

The game auto-loads real shanty recordings from here. Any track without a file
falls back to the built-in synth. Files can be .ogg, .mp3, or .wav — just match
one of the base names below (no extension needed in the name list; the loader
tries all three extensions).

WHICH FILES THE GAME LOOKS FOR
------------------------------
Sailing (calm, drifting at sea) — any of:
    sail.ogg            (a catch-all; if present it's used for sailing)
    drunken-sailor.*    Drunken Sailor
    haul-away-joe.*     Haul Away Joe
    south-australia.*   Bound for South Australia
    a-roving.*          A-Roving
    santiana.*          Santiana
    rio-grande.*        Rio Grande
  (Multiple present = a random playlist for sailing.)

Battle (combat) — any of:
    battle.*            (catch-all)
    blow-the-man-down.* Blow the Man Down
    drunken-sailor.*    (reused)
    santiana.*          (reused)

Menu screen — any of:
    menu.*  /  spanish-ladies.*  /  shenandoah.*

Cove / home base — any of:
    cove.*  /  shenandoah.*  /  leave-her-johnny.*

The simplest setup: drop ONE file named  sail.ogg  (or sail.mp3) and it plays
while you sail. Add more named files for variety + battle/menu/cove tracks.

WHERE TO GET FREE, PUBLIC-DOMAIN, CENTURIES-OLD SHANTIES
-------------------------------------------------------
These tunes are traditional/public-domain; look for clearly PD or CC0 recordings:
  • Internet Archive  — https://archive.org   (search "sea shanty" / "chanty";
        filter to Public Domain; lots of 1900s–1920s recordings are PD)
  • Wikimedia Commons — https://commons.wikimedia.org/wiki/Category:Sea_shanties
  • Musopen          — https://musopen.org   (public-domain audio)

Good PD shanty TUNES: Drunken Sailor, Leave Her Johnny, Blow the Man Down,
Haul Away Joe, Shenandoah, Spanish Ladies, A-Roving, Santiana, Rio Grande,
Bound for South Australia.

NOTE on "Wellerman": the TUNE is old/public-domain, but most modern viral
recordings are copyrighted — only use a clearly public-domain rendition.

After adding files, hard-reload the game. Open the browser console (F12) — it
logs "[shanties] loaded <file> for <track>" for each one it finds, or a note
that it's falling back to the synth.
