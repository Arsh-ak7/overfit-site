/**
 * Turn a v2 song (the agents' decisions) into a performance: every note of every
 * part, in beats, plus the chord timeline, kick times for sidechain, and
 * automation. Deterministic: the same song always yields the same performance.
 *
 * @typedef {{ t: number, d: number, m: number, v: number }} Note   start beat, length in beats, MIDI note, velocity 1-127
 * @typedef {{ role: string, sound: string, mix: object, notes: Note[] }} Track
 * @typedef {{ bpm: number, totalBeats: number, sections: object[], chords: object[], tracks: Record<string, Track>,
 *             kicks: number[], fills: number[], automation: object[] }} Performance   fills: start beats of drum-fill bars
 */
import { hash01 } from '../engine/pattern.mjs';
import { FILLS, GROOVES } from './library.mjs';
import { motifTokens, validateSongV2 } from './schema.mjs';
import { degreeToMidi, nearestPitchIn, parseChord, pitchAtOrAbove, voiceLead } from './theory.mjs';

const STEP = 0.25; // one 16th note, in beats
const BAR = 4; // beats per bar (4/4 only)

/** General MIDI drum notes for each groove voice. */
export const DRUM_NOTES = Object.freeze({
  kick: 36,
  rim: 37,
  snare: 38,
  clap: 39,
  ch: 42,
  oh: 46,
  tom_lo: 45,
  tom_mid: 47,
  tom_hi: 50,
  crash: 49,
  ride: 51,
  perc: 75, // claves
});
const SLOT_VELOCITY = { X: 118, x: 98, g: 42 };

const clampVel = (v) => Math.max(1, Math.min(127, Math.round(v)));

/** Deterministic humanizing: small velocity and timing variation per note. */
function humanize(seed, t, v, { velocity = 8, timing = 0.012 } = {}) {
  const dv = (hash01(seed, 'v', t.toFixed(4)) - 0.5) * 2 * velocity;
  const dt = (hash01(seed, 't', t.toFixed(4)) - 0.5) * 2 * timing;
  return { t: Math.max(0, t + dt), v: clampVel(v + dv) };
}

/** Swing: delay every second 16th by (swing% - 50) / 50 of a 16th. */
const swingOffset = (step, swing) => (step % 2 === 1 ? ((swing - 50) / 50) * STEP : 0);

function parsePlay(entry) {
  const [id, variant] = String(entry).split(':');
  return { id, variant };
}

/** Chord timeline for one section: which chord sounds at each bar. */
function sectionChords(song, section, startBeat) {
  const prog = song.progressions[section.progression];
  const per = prog.barsPerChord ?? 1;
  const out = [];
  for (let bar = 0; bar < section.bars; bar += per) {
    const symbol = prog.chords[Math.floor(bar / per) % prog.chords.length];
    const chord = parseChord(symbol, song.key, song.mode);
    out.push({ t: startBeat + bar * BAR, d: Math.min(per, section.bars - bar) * BAR, ...chord });
  }
  return out;
}

const chordAt = (chords, t) => chords.find((c) => t >= c.t - 1e-9 && t < c.t + c.d - 1e-9) ?? chords.at(-1);

// ---------------------------------------------------------------- drums

function drumBar(part, variant, isFillBar) {
  const groove = typeof part.groove === 'string' ? GROOVES[part.groove] : part.groove;
  let voices = Object.fromEntries(Object.entries(groove).filter(([k]) => k !== 'genres'));
  if (variant === 'nokick') delete voices.kick;
  if (variant === 'minimal') {
    voices = Object.fromEntries(Object.entries(voices).filter(([k]) => ['kick', 'ch'].includes(k)));
  }
  if (variant === 'busy' && voices.ch) voices.ch = voices.ch.replace(/\./g, 'g');
  if (isFillBar && part.fill) voices = { ...voices, ...FILLS[part.fill] };
  return voices;
}

function deriveDrums(id, part, variant, section, start, song, fills) {
  const notes = [];
  const fillEvery = variant === 'busy' ? 4 : (part.fillEvery ?? 8);
  for (let bar = 0; bar < section.bars; bar++) {
    const isFillBar = (bar + 1) % fillEvery === 0 || bar === section.bars - 1;
    const fillHere = isFillBar && section.bars >= 4 && Boolean(part.fill);
    if (fillHere) fills.push(start + bar * BAR);
    const voices = drumBar(part, variant, fillHere);
    for (const [voice, pattern] of Object.entries(voices)) {
      for (let step = 0; step < 16; step++) {
        const slot = pattern[step];
        if (slot === '.') continue;
        const t0 = start + bar * BAR + step * STEP + swingOffset(step, song.swing ?? 50);
        const isKick = voice === 'kick';
        const h = isKick
          ? { t: t0, v: SLOT_VELOCITY[slot] }
          : humanize(`${id}:${voice}`, t0, SLOT_VELOCITY[slot], { velocity: 10, timing: 0.01 });
        notes.push({ t: h.t, d: STEP, m: DRUM_NOTES[voice], v: h.v, voice });
      }
    }
  }
  return notes;
}

// ---------------------------------------------------------------- bass

const BASS_FLOOR = 28; // E1

function deriveBass(id, part, variant, chords, song) {
  const style = variant === 'sustain' ? 'sustain' : part.style;
  const lift = variant === 'octave_up' ? 12 : 0;
  const notes = [];
  for (const c of chords) {
    const root = pitchAtOrAbove(c.rootPc, BASS_FLOOR) + lift;
    const fifth = root + 7;
    const steps = Math.round(c.d / STEP);
    const add = (step, len, m, v) => {
      const t0 = c.t + step * STEP + swingOffset(step, song.swing ?? 50);
      const h = humanize(id, t0, v, { velocity: 6, timing: 0.004 });
      notes.push({ t: h.t, d: len * STEP, m, v: h.v });
    };
    for (let s = 0; s < steps; s++) {
      const inBeat = s % 4;
      switch (style) {
        case 'root8ths':
          if (s % 2 === 0) add(s, 1.8, root, inBeat === 0 ? 104 : 88);
          break;
        case 'offbeat':
          if (inBeat === 2) add(s, 1.6, root, 100);
          break;
        case 'rolling16':
          if (inBeat !== 0) {
            add(s, 0.9, inBeat === 2 ? root + 12 * (s % 16 === 14 ? 1 : 0) : root, inBeat === 2 ? 102 : 80);
          }
          break;
        case 'sustain':
          if (s % 16 === 0) add(s, Math.min(16, steps - s) - 0.2, root, 96);
          break;
        case 'root_fifth':
          if (s % 16 === 0) add(s, 3.6, root, 104);
          else if (s % 16 === 8) add(s, 3.6, fifth, 92);
          else if (s % 16 === 14) add(s, 1.6, root + 12, 80);
          break;
        case 'octave_pump':
          if (s % 2 === 0) add(s, 1.6, s % 4 === 0 ? root : root + 12, s % 4 === 0 ? 104 : 90);
          break;
        case 'walking': {
          if (s % 4 !== 0) break;
          const beat = s / 4;
          const tones = [root, pitchAtOrAbove(c.pcs[1] ?? c.rootPc, root), pitchAtOrAbove(c.pcs[2] ?? c.rootPc, root)];
          const isLastBeat = s + 4 >= steps;
          const next = chords[chords.indexOf(c) + 1];
          const m = isLastBeat && next ? pitchAtOrAbove(next.rootPc, BASS_FLOOR) + lift - 1 : tones[beat % 3];
          add(s, 3.6, m, beat === 0 ? 100 : 86);
          break;
        }
        default:
          break;
      }
    }
  }
  return notes;
}

// ---------------------------------------------------------------- chords

const DEFAULT_STABS = '...x..x...x..x..';

function deriveChords(id, part, variant, chords, song, previousVoicing) {
  const voicing = variant === 'sustain' ? 'pad' : part.voicing;
  const notes = [];
  let prev = previousVoicing;
  for (const c of chords) {
    const voiced = voiceLead(c.pcs, prev, { low: 52, high: 76, voices: Math.max(3, Math.min(4, c.pcs.length + 1)) });
    prev = voiced;
    const steps = Math.round(c.d / STEP);
    if (voicing === 'pad') {
      for (const m of voiced) notes.push({ t: c.t, d: c.d - 0.05, m, v: 84 });
      continue;
    }
    if (voicing === 'stabs') {
      const rhythm = part.rhythm ?? DEFAULT_STABS;
      for (let s = 0; s < steps; s++) {
        if (rhythm[s % 16] === '.') continue;
        const t0 = c.t + s * STEP + swingOffset(s, song.swing ?? 50);
        const h = humanize(id, t0, rhythm[s % 16] === 'X' ? 112 : 96, { velocity: 8, timing: 0.006 });
        for (const m of voiced) notes.push({ t: h.t, d: STEP * 1.5, m, v: h.v });
      }
      continue;
    }
    // arpeggio over two octaves of the voicing
    const rate = part.rate ?? 16;
    const stepLen = rate === 16 ? 1 : 2;
    const pool = [...voiced, ...voiced.map((m) => m + 12)];
    const order =
      part.arp === 'down'
        ? [...pool].reverse()
        : part.arp === 'updown'
          ? [...pool, ...pool.slice(1, -1).reverse()]
          : pool;
    for (let s = 0, i = 0; s < steps; s += stepLen, i++) {
      const t0 = c.t + s * STEP + swingOffset(s, song.swing ?? 50);
      const h = humanize(id, t0, i % 4 === 0 ? 100 : 84, { velocity: 8, timing: 0.004 });
      notes.push({ t: h.t, d: stepLen * STEP * 0.9, m: order[i % order.length], v: h.v });
    }
  }
  return { notes, last: prev };
}

// ---------------------------------------------------------------- melody

const STRONG_STEPS = new Set([0, 4, 8, 12]);

function deriveMotif(id, part, variant, section, start, chords, song, role) {
  const bars = part.motif.map((bar, i) => motifTokens(bar, `part '${id}' motif bar ${i + 1}`));
  let octave = part.octave ?? (role === 'counter' ? 4 : 5);
  if (variant === 'octave_up') octave += 1;
  if (variant === 'octave_down') octave -= 1;
  const fit = part.fit ?? 'chord';
  const notes = [];
  let open = null; // note currently being held by "-"
  for (let bar = 0; bar < section.bars; bar++) {
    const tokens = bars[bar % bars.length];
    // "answer" plays the motif's second half only; "sparse" keeps strong beats only
    for (let step = 0; step < 16; step++) {
      const tok = tokens[step];
      const t0 = start + bar * BAR + step * STEP;
      if (tok === '-') {
        if (open) open.d += STEP;
        continue;
      }
      open = null;
      if (tok === '.') continue;
      if (variant === 'answer' && step < 8) continue;
      if (variant === 'sparse' && !STRONG_STEPS.has(step)) continue;
      let m = degreeToMidi(tok, song.key, song.mode, octave);
      if (fit === 'chord' && STRONG_STEPS.has(step)) m = nearestPitchIn(m, chordAt(chords, t0).pcs);
      const strong = STRONG_STEPS.has(step);
      const h = humanize(id, t0 + swingOffset(step, song.swing ?? 50), strong ? 100 : 86, {
        velocity: 6,
        timing: 0.006,
      });
      open = { t: h.t, d: STEP * 0.95, m, v: h.v };
      notes.push(open);
    }
  }
  return notes;
}

// ---------------------------------------------------------------- transitions

function applyTransitions(song, sections, tracks, automation) {
  const drumsId = Object.keys(song.parts).find((id) => song.parts[id].role === 'drums');
  sections.forEach((s, i) => {
    const kind = song.sections[i].transition;
    if (!kind || i === 0) return;
    const prev = sections[i - 1];
    const prevEnd = prev.startBeat + prev.bars * BAR;
    const lead = Math.min(8, prev.bars) * BAR; // device length in beats
    const fx = (name, sound) => (tracks[name] ??= { role: 'fx', sound, mix: { gain: -6, reverb: 0.4 }, notes: [] });
    if (kind === 'riser') {
      fx('_riser', 'fx.riser').notes.push({ t: prevEnd - lead, d: lead, m: 60, v: 100 });
    }
    if (kind === 'sweep') {
      for (const [id, tr] of Object.entries(tracks)) {
        if (tr.role === 'chords' || tr.role === 'lead') {
          automation.push({ part: id, param: 'cutoff', t0: prevEnd - lead, t1: prevEnd, from: 0.25, to: 1 });
        }
      }
      fx('_riser', 'fx.riser').notes.push({ t: prevEnd - lead / 2, d: lead / 2, m: 60, v: 80 });
    }
    if (kind === 'snare_roll' && drumsId) {
      const roll =
        tracks[drumsId] ??
        (tracks[drumsId] = {
          role: 'drums',
          sound: song.parts[drumsId].sound,
          mix: song.parts[drumsId].mix ?? {},
          notes: [],
        });
      // one bar of 16th-note snares, crescendo into the downbeat
      for (let k = 0; k < 16; k++) {
        roll.notes.push({
          t: prevEnd - BAR + k * STEP,
          d: STEP,
          m: DRUM_NOTES.snare,
          v: clampVel(50 + k * 4),
          voice: 'snare',
        });
      }
    }
    if (kind === 'gap') {
      for (const tr of Object.values(tracks)) {
        tr.notes = tr.notes.filter((n) => !(n.t >= prevEnd - 1 && n.t < prevEnd));
        for (const n of tr.notes) if (n.t < prevEnd - 1 && n.t + n.d > prevEnd - 1) n.d = prevEnd - 1 - n.t;
      }
    }
    // every transition lands on an impact: crash on the new section's downbeat
    const target = drumsId
      ? (tracks[drumsId] ??= {
          role: 'drums',
          sound: song.parts[drumsId].sound,
          mix: song.parts[drumsId].mix ?? {},
          notes: [],
        })
      : fx('_impact', 'drums.909');
    target.notes.push({ t: s.startBeat, d: 2, m: DRUM_NOTES.crash, v: 110, voice: 'crash' });
  });
}

/**
 * @param {object} song v2 song (validated here)
 * @returns {Performance}
 */
export function derive(song) {
  validateSongV2(song);
  const tracks = {};
  const automation = [];
  const allChords = [];
  const sections = [];
  const chordState = {};
  const fills = [];
  let start = 0;

  for (const section of song.sections) {
    const chords = sectionChords(song, section, start);
    allChords.push(...chords);
    sections.push({
      name: section.name,
      startBeat: start,
      bars: section.bars,
      energy: section.energy ?? 3,
      play: section.play,
    });
    const energyScale = 0.85 + 0.05 * (section.energy ?? 3);

    for (const entry of section.play) {
      const { id, variant } = parsePlay(entry);
      const part = song.parts[id];
      const track = (tracks[id] ??= { role: part.role, sound: part.sound, mix: part.mix ?? {}, notes: [] });
      let notes = [];
      if (part.role === 'drums') notes = deriveDrums(id, part, variant, section, start, song, fills);
      else if (part.role === 'bass') notes = deriveBass(id, part, variant, chords, song);
      else if (part.role === 'chords') {
        const out = deriveChords(id, part, variant, chords, song, chordState[id]);
        chordState[id] = out.last;
        notes = out.notes;
        if (variant === 'filtered') {
          automation.push({ part: id, param: 'cutoff', t0: start, t1: start + section.bars * BAR, from: 0.2, to: 0.6 });
        }
      } else if (part.role === 'lead' || part.role === 'counter') {
        notes = deriveMotif(id, part, variant, section, start, chords, song, part.role);
      }
      for (const n of notes) n.v = clampVel(n.v * energyScale);
      track.notes.push(...notes);
    }
    for (const a of section.automate ?? []) {
      automation.push({
        part: a.part,
        param: a.param,
        t0: start,
        t1: start + section.bars * BAR,
        from: a.from,
        to: a.to,
      });
    }
    start += section.bars * BAR;
  }

  applyTransitions(song, sections, tracks, automation);
  for (const tr of Object.values(tracks)) tr.notes.sort((a, b) => a.t - b.t || a.m - b.m);
  const kicks = Object.values(tracks)
    .filter((tr) => tr.role === 'drums')
    .flatMap((tr) => tr.notes.filter((n) => n.m === DRUM_NOTES.kick).map((n) => n.t));

  return {
    title: song.title,
    genre: song.genre,
    key: song.key,
    mode: song.mode,
    bpm: song.bpm,
    totalBeats: start,
    sections,
    chords: allChords.map(({ t, d, symbol, pcs, rootPc, diatonic }) => ({ t, d, symbol, pcs, rootPc, diatonic })),
    tracks,
    kicks: kicks.sort((a, b) => a - b),
    fills: [...new Set(fills)].sort((a, b) => a - b),
    automation,
  };
}
