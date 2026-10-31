/**
 * Music theory primitives: keys, modes, scale degrees, Roman-numeral chords and
 * voice leading. Pure functions over MIDI numbers; no I/O, browser-safe.
 */
import { ValidationError } from '../errors.mjs';

const PITCH_CLASS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
export const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

/** Semitone offsets of each mode's seven degrees. */
export const MODES = Object.freeze({
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
});

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

/** "A", "F#", "Bb" -> pitch class 0-11. */
export function keyPitchClass(key) {
  const m = /^([A-G])([#b]?)$/.exec(key ?? '');
  if (!m) throw new ValidationError(`key '${key}' must be a note name like A, F#, Bb`);
  return (PITCH_CLASS[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12) % 12;
}

export function scaleOf(key, mode) {
  if (!MODES[mode]) throw new ValidationError(`mode '${mode}' must be one of ${Object.keys(MODES).join(', ')}`);
  const root = keyPitchClass(key);
  return MODES[mode].map((s) => (root + s) % 12);
}

/** Pitch classes of the key's scale, as a Set. */
export const scaleSet = (key, mode) => new Set(scaleOf(key, mode));

/**
 * Parse a Roman-numeral chord relative to a key.
 * Grammar: [b|#]? numeral (case = quality: upper major, lower minor) [°|dim|+]? [7|maj7|sus2|sus4]? [/bass-degree]?
 * Examples: i, VI, bVII, V7, ii°, IVmaj7, vsus4.
 * @returns {{ symbol: string, rootPc: number, pcs: number[], diatonic: boolean, bassPc: number }}
 */
export function parseChord(symbol, key, mode) {
  const m = /^([b#]?)(VII|VI|V|IV|III|II|I|vii|vi|v|iv|iii|ii|i)(°|dim|\+)?(maj7|7|sus2|sus4)?$/.exec(symbol ?? '');
  if (!m) {
    throw new ValidationError(
      `chord '${symbol}' isn't a Roman numeral like i, VI, bVII, V7, ii°, IVmaj7 (upper case major, lower case minor)`,
    );
  }
  const [, accidental, numeral, quality, extension] = m;
  const degree = ROMAN.indexOf(numeral.toUpperCase());
  const scale = scaleOf(key, mode);
  // Roman numerals name degrees of the major scale on the tonic; a flat lowers it.
  const tonic = keyPitchClass(key);
  const majorDegree = (tonic + MODES.major[degree]) % 12;
  const shift = accidental === 'b' ? -1 : accidental === '#' ? 1 : 0;
  // In minor-family modes, use the mode's own degree for unaltered numerals
  // (so VI in A minor is F, not F#), which is how producers read them.
  const rootPc = accidental ? (majorDegree + shift + 12) % 12 : scale[degree];
  const isMinor = numeral === numeral.toLowerCase();
  let intervals;
  if (quality === '°' || quality === 'dim') intervals = [0, 3, 6];
  else if (quality === '+') intervals = [0, 4, 8];
  else intervals = isMinor ? [0, 3, 7] : [0, 4, 7];
  if (extension === 'sus2') intervals = [0, 2, 7];
  if (extension === 'sus4') intervals = [0, 5, 7];
  // A plain 7 is a flat seventh in every quality: dominant, minor or half-diminished.
  if (extension === '7') intervals = [...intervals, 10];
  if (extension === 'maj7') intervals = [...intervals, 11];
  const pcs = intervals.map((i) => (rootPc + i) % 12);
  const inScale = new Set(scale);
  return { symbol, rootPc, pcs, diatonic: pcs.every((pc) => inScale.has(pc)), bassPc: rootPc };
}

/**
 * A scale-degree token -> MIDI note. Tokens: "1".."7", optional b/# prefix,
 * then any number of ' (octave up) or , (octave down). Degree 1 at `baseOctave`.
 */
export function degreeToMidi(token, key, mode, baseOctave = 4) {
  const m = /^([b#]?)([1-7])([',]*)$/.exec(token);
  if (!m) throw new ValidationError(`'${token}' isn't a scale degree like 1, 5, b7, 3', 5,`);
  const scale = MODES[mode];
  const shift = m[1] === 'b' ? -1 : m[1] === '#' ? 1 : 0;
  const octave = [...m[3]].reduce((o, c) => o + (c === "'" ? 1 : -1), 0);
  return 12 * (baseOctave + 1) + keyPitchClass(key) + scale[Number(m[2]) - 1] + shift + 12 * octave;
}

/** Nearest MIDI note with a pitch class in `pcs`, preferring the lower on ties. */
export function nearestPitchIn(midi, pcs) {
  for (let d = 0; d <= 6; d++) {
    if (pcs.includes((((midi - d) % 12) + 12) % 12)) return midi - d;
    if (pcs.includes((midi + d) % 12)) return midi + d;
  }
  return midi;
}

/** Lowest MIDI note >= `floor` with pitch class `pc`. */
export const pitchAtOrAbove = (pc, floor) => floor + ((pc - (floor % 12) + 12) % 12);

/**
 * Voice a chord in a register, keeping common tones and moving each voice as
 * little as possible from `previous` (simple greedy voice leading).
 * @param {number[]} pcs chord pitch classes
 * @param {number[]|null} previous previous voicing (MIDI), or null
 * @param {{ low: number, high: number, voices: number }} range
 */
export function voiceLead(pcs, previous, { low = 52, high = 76, voices = 4 } = {}) {
  const candidates = [];
  for (let n = low; n <= high; n++) if (pcs.includes(n % 12)) candidates.push(n);
  if (!previous || !previous.length) {
    // Close position from the lowest chord tone at or above `low`.
    const start = pitchAtOrAbove(pcs[0], low);
    const voicing = [];
    for (let i = 0; voicing.length < voices; i++) {
      const pc = pcs[i % pcs.length];
      const prev = voicing.at(-1) ?? start - 1;
      voicing.push(pitchAtOrAbove(pc, prev + 1));
    }
    return voicing;
  }
  const used = new Set();
  const voicing = previous.slice(0, voices).map((p) => {
    let best = null;
    for (const c of candidates) {
      if (used.has(c)) continue;
      if (best === null || Math.abs(c - p) < Math.abs(best - p)) best = c;
    }
    used.add(best);
    return best;
  });
  // Make sure every chord tone is present at least once when voices allow.
  const present = new Set(voicing.map((n) => n % 12));
  for (const pc of pcs) {
    if (present.has(pc) || voicing.length < pcs.length) continue;
    // replace the voice whose pitch class is doubled most, nearest to target
    const counts = {};
    voicing.forEach((n) => (counts[n % 12] = (counts[n % 12] ?? 0) + 1));
    const idx = voicing.findIndex((n) => counts[n % 12] > 1);
    if (idx >= 0) {
      voicing[idx] = nearestPitchIn(voicing[idx], [pc]);
      present.add(pc);
    }
  }
  return voicing.sort((a, b) => a - b);
}

export const midiName = (m) => `${NOTE_NAMES[m % 12]}${Math.floor(m / 12) - 1}`;
