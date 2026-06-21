// Sea Shanty Wars music + SFX. Two sources, per the design:
//   1) SYNTHESIZED shanties — original procedurally-composed sea shanties via
//      the Web Audio API (always works offline, no files needed).
//   2) FILE OVERRIDE — if real recordings exist under game/audio/shanties/,
//      they play instead of the synth for that track. Drop public-domain
//      shanty .ogg/.mp3 files in there (see manifest below) and they take over.
//
// A "track" is a musical intent: 'sail' (drifting at sea), 'battle' (combat),
// 'cove' (home base), 'menu'. The manager cross-fades between tracks.

// ===========================================================================
// REAL SHANTY RECORDINGS — drop your public-domain audio files into
//   game/audio/shanties/
// using ANY of the base names below. The loader tries .ogg, .mp3 and .wav for
// each, so just match the base name (e.g. "drunken-sailor.mp3"). Any track with
// no file falls back to the synth. Multiple files for one intent = a playlist.
//
// Where to get genuine centuries-old, public-domain shanty recordings (free):
//  • archive.org (Internet Archive) — search "sea shanty" / "chanty"; filter to
//    Public Domain. Many 1900s–1920s cylinder/78rpm recordings are PD.
//  • Wikimedia Commons (commons.wikimedia.org) — "Category:Sea shanties" has
//    PD/CC audio (e.g. historic recordings, public-domain renditions).
//  • musopen.org — public-domain recordings.
// Good PD shanty TUNES to look for (all old/traditional): Drunken Sailor,
// Leave Her Johnny, Blow the Man Down, Haul Away Joe, Shenandoah, Spanish
// Ladies, A-Roving, Santiana, Rio Grande, Bound for South Australia.
// (Note: "Wellerman" the TUNE is old/PD, but specific modern recordings are NOT
// — use a clearly public-domain rendition.)
// ===========================================================================

// Per intent: base names (no extension) to look for. The loader tries each name
// with .ogg/.mp3/.wav. Includes BOTH the short names AND the original long
// Internet-Archive track filenames, so files work whether or not you renamed
// them. First found per name wins; multiple per intent = a playlist.
const A = {
  blow:    ['blow-the-man-down', '01 - Blow the Man Down - Leonard Warren - Tom Scott'],
  rio:     ['rio-grande', '02 - Rio Grande - Leonard Warren - Tom Scott - Morris Levine'],
  shen:    ['shenandoah', '04 - Shenandoah - Leonard Warren - Tom Scott - Morris Levine'],
  haul:    ['haul-away-joe', '05 - Haul-A-Way, Joe - Leonard Warren - Tom Scott'],
  drunk:   ['drunken-sailor', '07 - The Drunken Sailor - Leonard Warren - Tom Scott'],
  rove:    ["a-roving", "08 - A-Rovin' - Leonard Warren - Tom Scott - Morris Levine"],
};
const FILE_MANIFEST = {
  menu:   ['menu', ...A.shen, ...A.rio],
  cove:   ['cove', ...A.shen, ...A.rove],
  sail:   ['sail', ...A.drunk, ...A.haul, ...A.rove, ...A.rio],
  battle: ['battle', ...A.blow, ...A.drunk],
};
const AUDIO_EXTS = ['mp3', 'ogg', 'wav'];
const SHANTY_DIR = 'audio/shanties/';

// ---- Music theory: a few original shanty melodies in scale-degree form ----
// Degrees are indices into a D minor / dorian-ish scale; rhythm is in beats.
// These are ORIGINAL note sequences (not transcriptions of any specific song),
// written to feel like a shanty: stepwise, lilting, in a swung 6/8.
const SCALE = [0, 2, 3, 5, 7, 8, 10, 12, 14, 15, 17]; // semitone offsets (natural minor + extensions)
const ROOT_HZ = 146.83; // D3

function deg(d) {
  // Map a (possibly out-of-range / negative) scale degree to a frequency.
  const octave = Math.floor(d / 7);
  const idx = ((d % 7) + 7) % 7;
  const semis = SCALE[idx] + octave * 12;
  return ROOT_HZ * Math.pow(2, semis / 12);
}

// Melodies: [degree, beats]. A rest is degree === null.
const MELODIES = {
  sail: [
    [4,1],[3,0.5],[2,0.5],[3,1],[4,1], [5,1],[4,0.5],[3,0.5],[2,2],
    [2,1],[3,0.5],[4,0.5],[5,1],[4,1], [3,1],[2,0.5],[1,0.5],[2,2],
    [4,1],[5,0.5],[6,0.5],[7,1],[6,1], [5,1],[4,0.5],[3,0.5],[4,2],
    [2,1],[1,1],[0,1],[2,1], [4,2],[3,2],
  ],
  battle: [
    [4,0.5],[4,0.5],[5,0.5],[4,0.5],[2,1],[2,1],
    [3,0.5],[3,0.5],[4,0.5],[3,0.5],[1,1],[1,1],
    [4,0.5],[5,0.5],[6,0.5],[7,0.5],[8,1],[7,1],
    [6,0.5],[5,0.5],[4,0.5],[3,0.5],[4,2],
  ],
  cove: [
    [2,1.5],[3,0.5],[4,1],[4,1], [5,1.5],[4,0.5],[3,2],
    [4,1.5],[5,0.5],[6,1],[5,1], [4,1.5],[3,0.5],[2,2],
  ],
  menu: [
    [4,2],[5,1],[4,1], [3,2],[2,2],
    [4,2],[6,1],[5,1], [4,2],[4,2],
  ],
};

// Tempo (beats/sec) and feel per track.
const TRACK_FEEL = {
  sail:   { bpm: 96,  swing: 0.18, lead: 'accordion', drum: 'soft' },
  battle: { bpm: 132, swing: 0.06, lead: 'fiddle',    drum: 'march' },
  cove:   { bpm: 80,  swing: 0.22, lead: 'concertina',drum: 'soft' },
  menu:   { bpm: 88,  swing: 0.16, lead: 'accordion', drum: 'none' },
};

export class Shanties {
  constructor() {
    this._ctx = null;
    this._ready = false;
    this._master = null;
    this._musicGain = null;
    this._sfxGain = null;
    this._currentTrack = null;
    this._fileBuffers = {};   // track -> AudioBuffer (decoded recording) if present
    this._synthState = null;  // scheduler state for the synth loop
    this._musicEnabled = true;
    this._initOnInteraction();
  }

  _initOnInteraction() {
    const init = async () => {
      if (this._ready) return;
      this._ctx = new (window.AudioContext || window.webkitAudioContext)();
      this._master = this._ctx.createGain();
      this._master.gain.value = 0.75; // a bit louder overall (SFX were too meek)
      this._master.connect(this._ctx.destination);
      this._musicGain = this._ctx.createGain();
      this._musicGain.gain.value = 0.0;
      this._musicGain.connect(this._master);
      this._sfxGain = this._ctx.createGain();
      this._sfxGain.gain.value = 0.9;
      this._sfxGain.connect(this._master);
      this._ready = true;
      window.removeEventListener('click', init);
      window.removeEventListener('keydown', init);
      // Try loading any real recordings in the background (optional override).
      this._loadFiles();
      // If a track was requested before audio unlocked, start it now.
      if (this._pendingTrack) this.playTrack(this._pendingTrack);
    };
    window.addEventListener('click', init, { once: false });
    window.addEventListener('keydown', init, { once: false });
  }

  async _loadFiles() {
    this._filesLoading = true; // suppress the synth while recordings decode
    const loadedNames = new Set(); // don't load the same base name twice
    // Load the CURRENTLY-PLAYING track's files FIRST so the real song starts
    // ASAP (no full synth loop first). Order the manifest with current track up top.
    const order = Object.entries(FILE_MANIFEST).sort(
      ([t]) => (t === this._currentTrack ? -1 : 1));
    for (const [track, names] of order) {
      for (const name of names) {
        // Try each extension for this base name; first that exists wins.
        for (const ext of AUDIO_EXTS) {
          // Encode the filename (spaces, commas, apostrophes in the IA track
          // names) but keep the directory path slashes intact.
          const url = `${SHANTY_DIR}${encodeURIComponent(name)}.${ext}`;
          if (loadedNames.has(url)) {
            // already decoded under another track — reuse the buffer
          }
          try {
            const res = await fetch(url);
            if (!res.ok) continue; // 404 etc — try next ext/name silently
            const buf = await res.arrayBuffer();
            // decodeAudioData can be promise OR callback style depending on
            // browser; wrap so both work and errors surface.
            const decoded = await new Promise((resolve, reject) => {
              const p = this._ctx.decodeAudioData(buf, resolve, reject);
              if (p && p.then) p.then(resolve, reject);
            });
            const firstForTrack = !this._fileBuffers[track] || this._fileBuffers[track].length === 0;
            if (!this._fileBuffers[track]) this._fileBuffers[track] = [];
            this._fileBuffers[track].push(decoded);
            loadedNames.add(url);
            console.log(`[shanties] loaded ${decodeURIComponent(url)} for "${track}"`);
            // If this is the FIRST recording for the track that's currently
            // playing (on synth), swap to it immediately — no full synth loop.
            if (firstForTrack && track === this._currentTrack) {
              this.playTrack(track, true);
            }
            break; // got this name — don't try other extensions
          } catch (err) {
            console.warn(`[shanties] failed ${decodeURIComponent(url)}:`, err && err.message || err);
          }
        }
      }
    }
    this._filesLoading = false;
    const total = Object.values(this._fileBuffers).reduce((n, a) => n + a.length, 0);
    if (total === 0) {
      console.log('[shanties] no recordings found in audio/shanties/ — using synth. Drop .ogg/.mp3 files there.');
      // Nothing loaded — make sure SOMETHING plays (synth) for the current track.
      if (this._currentTrack && !this._fileSource) this._startSynth(this._currentTrack);
    } else if (this._currentTrack && (this._fileBuffers[this._currentTrack] || []).length && !this._fileSource) {
      this.playTrack(this._currentTrack, true);
    }
  }

  setMusicEnabled(on) {
    this._musicEnabled = on;
    if (!this._ready) return;
    const g = this._musicGain.gain;
    g.cancelScheduledValues(this._ctx.currentTime);
    g.linearRampToValueAtTime(on ? 0.5 : 0.0, this._ctx.currentTime + 0.6);
  }

  // Switch the active music track with a short cross-fade.
  playTrack(track, force = false) {
    if (!this._ready) { this._pendingTrack = track; return; }
    if (track === this._currentTrack && !force) return;
    this._currentTrack = track;

    const g = this._musicGain.gain;
    g.cancelScheduledValues(this._ctx.currentTime);
    g.setValueAtTime(g.value, this._ctx.currentTime);
    g.linearRampToValueAtTime(this._musicEnabled ? 0.5 : 0.0, this._ctx.currentTime + 1.0);

    this._stopSources();

    const files = this._fileBuffers[track];
    if (files && files.length) {
      // Start the PLAYLIST at a random track; it advances on each end.
      this._playlistTrack = track;
      this._playlistIdx = Math.floor(Math.random() * files.length);
      this._playPlaylist();
    } else if (this._filesLoading) {
      // Files for this track may still be decoding — DON'T start the synth (it'd
      // play a whole loop first). Wait briefly; _loadFiles re-calls playTrack
      // when buffers arrive. Fall back to synth only if loading finishes empty.
      // (a short safety timer in case no files ever load for this track)
      clearTimeout(this._synthFallbackT);
      this._synthFallbackT = setTimeout(() => {
        if (this._currentTrack === track && !(this._fileBuffers[track] || []).length) this._startSynth(track);
      }, 4000);
    } else {
      this._startSynth(track);
    }
  }

  _stopSources() {
    if (this._fileSource) { try { this._fileSource.onended = null; this._fileSource.stop(); } catch (_) {} this._fileSource = null; }
    if (this._synthState) { this._synthState.stopped = true; this._synthState = null; }
    clearTimeout(this._synthFallbackT);
  }

  // Play the current playlist entry; when it ends, advance to the NEXT track in
  // the list (cycling) so the same song doesn't repeat forever.
  _playPlaylist() {
    const files = this._fileBuffers[this._playlistTrack] || [];
    if (!files.length) { this._startSynth(this._playlistTrack); return; }
    this._playlistIdx = this._playlistIdx % files.length;
    const buffer = files[this._playlistIdx];
    const src = this._ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = false; // play once, then advance
    src.connect(this._musicGain);
    src.onended = () => {
      if (this._fileSource !== src) return; // superseded by a track change
      this._playlistIdx = (this._playlistIdx + 1) % files.length;
      // If there's only one file, this just replays it (still better than a
      // gapless loop forever — but with several it cycles through them).
      this._playPlaylist();
    };
    src.start();
    this._fileSource = src;
  }

  // ---- Procedural shanty synthesis ----
  _startSynth(track) {
    const feel = TRACK_FEEL[track] || TRACK_FEEL.sail;
    const melody = MELODIES[track] || MELODIES.sail;
    const beat = 60 / feel.bpm;
    const state = { stopped: false, idx: 0, nextTime: this._ctx.currentTime + 0.08, bar: 0 };
    this._synthState = state;

    const schedule = () => {
      if (state.stopped) return;
      const ctx = this._ctx;
      // Schedule ahead ~0.4s worth of notes.
      while (state.nextTime < ctx.currentTime + 0.4) {
        const [d, beats] = melody[state.idx % melody.length];
        const dur = beats * beat;
        const swung = (state.idx % 2 === 1) ? feel.swing * beat : 0;
        const t = state.nextTime + swung;
        if (d !== null) {
          this._voice(feel.lead, deg(d), t, dur * 0.95);
          // Harmony a third below on strong beats.
          if (beats >= 1) this._voice(feel.lead, deg(d - 2), t, dur * 0.9, 0.4);
          // Bass root on the downbeat of each phrase.
          if (state.idx % 4 === 0) this._voice('bass', deg(-7), t, beat * 1.5, 0.7);
        }
        // Drum.
        if (feel.drum !== 'none') this._drum(feel.drum, state.idx, t);
        state.nextTime += dur;
        state.idx++;
      }
      state.timer = setTimeout(schedule, 120);
    };
    schedule();
  }

  // A single melodic note with an instrument-ish timbre.
  _voice(kind, freq, t, dur, gainMul = 1.0) {
    const ctx = this._ctx;
    const out = ctx.createGain();
    out.connect(this._musicGain);
    // ADSR.
    const peak = 0.16 * gainMul;
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(peak, t + 0.03);
    out.gain.setValueAtTime(peak, t + dur * 0.6);
    out.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    // Reed/accordion-ish: two detuned saws through a lowpass; fiddle: a brighter
    // sawtooth with vibrato; concertina: triangle + slight detune; bass: sine.
    const mkOsc = (type, detune) => {
      const o = ctx.createOscillator();
      o.type = type; o.frequency.value = freq; o.detune.value = detune;
      return o;
    };
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = kind === 'fiddle' ? 3200 : 1600;
    filter.connect(out);

    let oscs = [];
    if (kind === 'accordion' || kind === 'concertina') {
      oscs = [mkOsc(kind === 'accordion' ? 'sawtooth' : 'triangle', -6), mkOsc('sawtooth', 7)];
    } else if (kind === 'fiddle') {
      oscs = [mkOsc('sawtooth', 0)];
      // vibrato
      const lfo = ctx.createOscillator(); lfo.frequency.value = 5.5;
      const lfoG = ctx.createGain(); lfoG.gain.value = 4;
      lfo.connect(lfoG); lfoG.connect(oscs[0].detune); lfo.start(t); lfo.stop(t + dur);
    } else { // bass
      oscs = [mkOsc('sine', 0)];
    }
    for (const o of oscs) { o.connect(filter); o.start(t); o.stop(t + dur + 0.02); }
  }

  _drum(style, idx, t) {
    const ctx = this._ctx;
    // Kick on beats, plus a hand-clap-ish noise on offbeats for 'march'.
    const isDown = idx % 2 === 0;
    if (isDown) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine'; o.frequency.setValueAtTime(120, t);
      o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
      g.gain.setValueAtTime(0.5, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
      o.connect(g); g.connect(this._musicGain);
      o.start(t); o.stop(t + 0.18);
    }
    if (style === 'march' && !isDown) {
      this._noise(t, 0.04, 0.18, 2400, { bus: 'music' });
    }
  }

  // Filtered noise burst. `opts.bus` selects the destination ('sfx' default,
  // 'music' for the drum machine). `opts.type`/`opts.Q` shape the filter.
  _noise(t, dur, gainVal, filterFreq, opts = {}) {
    const ctx = this._ctx;
    const n = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < n; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource(); src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = opts.type || 'bandpass'; f.frequency.value = filterFreq; f.Q.value = opts.Q ?? 1.5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gainVal, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    const dest = opts.dest || (opts.bus === 'music' ? this._musicGain : this._sfxGain);
    src.connect(f); f.connect(g); g.connect(dest);
    src.start(t);
    return g;
  }

  // ---- Spatial audio: distance-based volume falloff ----
  // main.js calls setListener() each frame with the camera position. SFX that
  // pass a world position are attenuated by distance so a battle across the sea
  // is faint and one alongside you is loud — instead of everything at full blast.
  setListener(pos) { this._listenerPos = pos; }

  // A per-shot gain node attenuated by how far `worldPos` is from the listener.
  // Inverse-distance falloff with a near-field plateau (ref) and a hard cutoff
  // (max). Returns a GainNode connected to _sfxGain, or null if out of range.
  _spatialNode(worldPos, peak = 1) {
    if (!this._ready) return null;
    let att = 1;
    if (worldPos && this._listenerPos) {
      const dx = worldPos.x - this._listenerPos.x;
      const dy = worldPos.y - this._listenerPos.y;
      const dz = worldPos.z - this._listenerPos.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const REF = 14, MAX = 240; // full volume within REF, silent past MAX
      if (d >= MAX) return null;
      att = REF / Math.max(REF, d);          // 1 at the source, ~0.06 at MAX
      att *= Math.max(0, 1 - d / MAX);        // smooth fade to zero at MAX
    }
    const g = this._ctx.createGain();
    g.gain.value = peak * att;
    g.connect(this._sfxGain);
    return g;
  }

  // ---- One-shot SFX ----
  // `dest` overrides the destination (used to route through a spatial node);
  // `t0` lets a caller schedule the tone (default now). Optional pitch glide to
  // `endFreq` over the duration for a "sweep" (cannon boom body, etc).
  _sfxTone(freq, type, dur, gainVal, { detune = 0, dest = null, t0 = null, endFreq = null } = {}) {
    if (!this._ready) return;
    const ctx = this._ctx;
    const t = t0 ?? ctx.currentTime;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gainVal, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    g.connect(dest || this._sfxGain);
    const o = ctx.createOscillator();
    o.type = type; o.detune.value = detune;
    o.frequency.setValueAtTime(freq, t);
    if (endFreq) o.frequency.exponentialRampToValueAtTime(endFreq, t + dur);
    o.connect(g); o.start(t); o.stop(t + dur);
  }

  playSplash(worldPos) {
    const node = this._spatialNode(worldPos, 1);
    if (!node) return;
    this._noise(this._ctx.currentTime, 0.35, 0.45, 900, { dest: node });
    this._noise(this._ctx.currentTime, 0.5, 0.2, 280, { dest: node, type: 'lowpass' });
  }

  // A proper cannon BOOM: a sharp transient crack, a punchy low-mid body that
  // pitch-drops, and a long sub-bass rumble tail — layered through a spatial
  // node so distance softens it. Small random pitch jitter so repeated shots
  // don't sound mechanically identical.
  playCannon(worldPos) {
    const node = this._spatialNode(worldPos, 1.0);
    if (!node) return;
    const ctx = this._ctx, t = ctx.currentTime;
    const j = 0.9 + Math.random() * 0.2; // ±10% pitch jitter
    // 1) Transient crack — very short bright noise click for the "attack".
    this._noise(t, 0.05, 0.9, 2200, { dest: node, type: 'highpass', Q: 0.7 });
    // 2) Body — loud low noise burst (the muzzle blast), pitch falling.
    this._noise(t, 0.45, 1.0, 320 * j, { dest: node, type: 'lowpass', Q: 0.8 });
    // 3) Punch — a sine that drops from ~140Hz to ~38Hz: the chest-thump.
    this._sfxTone(140 * j, 'sine', 0.4, 0.9, { dest: node, t0: t, endFreq: 38 });
    // 4) Rumble tail — a longer, quieter sub that lingers like an echo.
    this._sfxTone(60 * j, 'sine', 0.8, 0.45, { dest: node, t0: t + 0.04, endFreq: 30 });
    this._noise(t + 0.05, 0.7, 0.3, 160, { dest: node, type: 'lowpass' });
  }

  // Cannonball striking wood: a sharp splintery crack + a low thud + boom,
  // attenuated by distance from the listener.
  playHit(worldPos) {
    const node = this._spatialNode(worldPos, 1.0);
    if (!node) return;
    const t = this._ctx.currentTime;
    this._noise(t, 0.16, 0.7, 1700, { dest: node, type: 'highpass', Q: 0.8 }); // splinter crack
    this._sfxTone(120, 'square', 0.12, 0.5, { dest: node, t0: t, endFreq: 70 }); // wood thud
    this._sfxTone(50, 'sine', 0.28, 0.5, { dest: node, t0: t, endFreq: 32 });    // low boom
  }
  // Coin chime for plundering loot / capturing a ship — a bright ascending
  // arpeggio (cha-ching!).
  playSell() {
    if (!this._ready) return;
    const t0 = this._ctx.currentTime;
    [784, 1047, 1319].forEach((f, i) => {
      const g = this._ctx.createGain();
      g.gain.setValueAtTime(0.25, t0 + i * 0.07);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + i * 0.07 + 0.25);
      g.connect(this._sfxGain || this._master);
      const o = this._ctx.createOscillator();
      o.type = 'triangle'; o.frequency.value = f;
      o.connect(g); o.start(t0 + i * 0.07); o.stop(t0 + i * 0.07 + 0.26);
    });
  }
  // Musket shot: a sharp high crack + a short low pop, spatialised.
  playMusket(worldPos) {
    const node = this._spatialNode(worldPos, 0.9);
    if (!node) return;
    const t = this._ctx.currentTime, j = 0.9 + Math.random() * 0.2;
    this._noise(t, 0.06, 0.9, 3200 * j, { dest: node, type: 'highpass', Q: 0.7 });
    this._noise(t, 0.18, 0.5, 600, { dest: node, type: 'lowpass' });
    this._sfxTone(180 * j, 'square', 0.08, 0.4, { dest: node, t0: t, endFreq: 90 });
  }
  // Cutlass clash / cut: a metallic shrrr, spatialised.
  playClash(worldPos) {
    const node = this._spatialNode(worldPos, 0.8);
    if (!node) return;
    const t = this._ctx.currentTime;
    this._noise(t, 0.12, 0.6, 4200, { dest: node, type: 'bandpass', Q: 4 });
    this._sfxTone(900, 'triangle', 0.1, 0.25, { dest: node, t0: t, endFreq: 1600 });
  }
  // Player hurt: a dull thud + low groan cue (non-spatial — it's happening to YOU).
  playHurt() {
    if (!this._ready) return;
    const t = this._ctx.currentTime;
    this._noise(t, 0.2, 0.6, 300, { type: 'lowpass' });
    this._sfxTone(140, 'sine', 0.25, 0.5, { t0: t, endFreq: 70 });
  }

  playUi() { this._sfxTone(523, 'sine', 0.08, 0.25); } // UI: non-spatial, full volume
}
