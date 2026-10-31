/**
 * Score format v2: a bar-grid song in which chords, sections and roles are
 * first-class. Agents make the decisions (key, progression, styles, motifs,
 * which parts play where); src/score/derive.mjs turns them into notes.
 *
 * {
 *   version: 2, title, genre, key: "A", mode: "minor", bpm, swing: 50-66 (%),
 *   progressions: { main: { chords: ["i","VI","III","VII"], barsPerChord: 1|2|4 } },
 *   parts: { <id>: Part },
 *   sections: [ { name, bars, progression, energy: 1-5, play: ["drums", "hook:octave_up"],
 *                 transition?: "riser"|"snare_roll"|"sweep"|"gap", automate?: [{ part, param: "cutoff", from, to }] } ],
 * }
 *
 * Part (all roles): { role, sound: palette id, mix?: { gain (dB), pan, reverb, delay, duck (dB of sidechain) } }
 *   drums:   { groove: GROOVES name | { voice: "16 slots" }, fill?: FILLS name, fillEvery?: 4|8|16 }
 *   bass:    { style: one of BASS_STYLES }
 *   chords:  { voicing: "pad"|"stabs"|"arp", rhythm?: "16 slots" (stabs), arp?: "up"|"down"|"updown", rate?: 8|16 }
 *   lead / counter: { motif: ["16 tokens per bar", ...], octave?: 3-6, fit?: "chord"|"scale" }
 *     tokens: scale degrees 1-7 with optional b/# and ' or , for octaves; "." rest; "-" hold
 *   fx: placed by transitions; no fields of its own
 *
 * Variants (after a colon in `play`): drums: nokick, minimal, busy; lead/counter: octave_up, octave_down,
 * sparse, answer; chords: filtered, sustain; bass: sustain, octave_up.
 */
import { ValidationError } from '../errors.mjs';
import { FILLS, GENRES, GROOVES, PROGRESSIONS } from './library.mjs';
import palette from './palette.json' with { type: 'json' };
import { degreeToMidi, MODES, parseChord } from './theory.mjs';

export const ROLES = Object.freeze(['drums', 'bass', 'chords', 'lead', 'counter', 'fx']);
export const BASS_STYLES = Object.freeze([
  'root8ths',
  'offbeat',
  'rolling16',
  'sustain',
  'root_fifth',
  'octave_pump',
  'walking',
]);
export const VARIANTS = Object.freeze({
  drums: ['nokick', 'minimal', 'busy'],
  bass: ['sustain', 'octave_up'],
  chords: ['filtered', 'sustain'],
  lead: ['octave_up', 'octave_down', 'sparse', 'answer'],
  counter: ['octave_up', 'octave_down', 'sparse', 'answer'],
  fx: [],
});
export const TRANSITIONS = Object.freeze(['riser', 'snare_roll', 'sweep', 'gap']);
export const LIMITS = Object.freeze({
  parts: 8,
  activePerSection: 6, // the density cap: drums count as one part
  sections: 16,
  totalBars: 200,
  motifBars: 4,
});

const ID = /^[a-z][a-z0-9_]{0,23}$/;
const SLOTS = /^[xXg.]{16}$/;
const TOKEN = /^(?:\.|-|[b#]?[1-7][',]*)$/;

const fail = (message) => {
  throw new ValidationError(message);
};
const inRange = (value, lo, hi, what) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < lo || value > hi) {
    fail(`${what} must be a number from ${lo} to ${hi}`);
  }
};

/** Palette sound ids suitable for a role. */
export const soundsFor = (role) =>
  Object.entries(palette.sounds)
    .filter(([, s]) => s.role === role || (role === 'counter' && s.role === 'lead'))
    .map(([id]) => id);

/** Split a motif bar into its 16 tokens, or explain what's wrong. */
export function motifTokens(bar, where) {
  const tokens = String(bar).trim().split(/\s+/);
  if (tokens.length !== 16) fail(`${where} has ${tokens.length} slots; each bar needs exactly 16 (use . for rests)`);
  for (const t of tokens) if (!TOKEN.test(t)) fail(`${where}: '${t}' isn't a degree (1-7, b3, 5', 2,), '.' or '-'`);
  return tokens;
}

function validatePart(id, part, song) {
  const where = `part '${id}'`;
  if (!ID.test(id)) fail(`${where}: ids are lower-case letters, digits and _`);
  if (!ROLES.includes(part.role)) fail(`${where}: role must be one of ${ROLES.join(', ')}`);
  const sound = palette.sounds[part.sound];
  if (!sound) fail(`${where}: sound '${part.sound}' isn't in the palette (try ${soundsFor(part.role).join(', ')})`);
  if (part.mix) {
    const { gain = 0, pan = 0, reverb = 0, delay = 0, duck = 0 } = part.mix;
    inRange(gain, -24, 6, `${where} mix.gain (dB)`);
    inRange(pan, -1, 1, `${where} mix.pan`);
    inRange(reverb, 0, 1, `${where} mix.reverb`);
    inRange(delay, 0, 1, `${where} mix.delay`);
    inRange(duck, 0, 12, `${where} mix.duck (dB)`);
  }
  switch (part.role) {
    case 'drums': {
      if (typeof part.groove === 'string') {
        if (!GROOVES[part.groove]) {
          fail(`${where}: groove must be one of ${Object.keys(GROOVES).join(', ')} or your own`);
        }
      } else if (part.groove && typeof part.groove === 'object') {
        for (const [voice, pattern] of Object.entries(part.groove)) {
          if (voice === 'genres') continue;
          if (!SLOTS.test(pattern)) fail(`${where}: ${voice} pattern needs 16 slots of x, X, g or .`);
        }
      } else fail(`${where}: needs a groove`);
      if (part.fill !== undefined && !FILLS[part.fill]) {
        fail(`${where}: fill must be one of ${Object.keys(FILLS).join(', ')}`);
      }
      if (part.fillEvery !== undefined && ![4, 8, 16].includes(part.fillEvery)) {
        fail(`${where}: fillEvery is 4, 8 or 16 bars`);
      }
      break;
    }
    case 'bass':
      if (!BASS_STYLES.includes(part.style)) fail(`${where}: style must be one of ${BASS_STYLES.join(', ')}`);
      break;
    case 'chords':
      if (!['pad', 'stabs', 'arp'].includes(part.voicing)) fail(`${where}: voicing must be pad, stabs or arp`);
      if (part.rhythm !== undefined && !SLOTS.test(part.rhythm)) fail(`${where}: rhythm needs 16 slots of x or .`);
      if (part.arp !== undefined && !['up', 'down', 'updown'].includes(part.arp)) {
        fail(`${where}: arp is up, down or updown`);
      }
      if (part.rate !== undefined && ![8, 16].includes(part.rate)) fail(`${where}: rate is 8 or 16`);
      break;
    case 'lead':
    case 'counter': {
      if (!Array.isArray(part.motif) || part.motif.length < 1 || part.motif.length > LIMITS.motifBars) {
        fail(`${where}: motif is a list of 1-${LIMITS.motifBars} bars, each 16 tokens`);
      }
      part.motif.forEach((bar, i) => motifTokens(bar, `${where} motif bar ${i + 1}`));
      if (part.octave !== undefined) inRange(part.octave, 3, 6, `${where} octave`);
      if (part.fit !== undefined && !['chord', 'scale'].includes(part.fit)) fail(`${where}: fit is chord or scale`);
      // every degree must resolve to a playable note
      for (const bar of part.motif) {
        for (const t of bar.trim().split(/\s+/)) {
          if (t !== '.' && t !== '-') degreeToMidi(t, song.key, song.mode, part.octave ?? 4);
        }
      }
      break;
    }
    default:
      break;
  }
}

/** Validate a v2 song. Throws ValidationError with an agent-readable message. */
export function validateSongV2(song) {
  if (!song || song.version !== 2) fail('song.version must be 2');
  const genre = GENRES[song.genre];
  if (!genre) fail(`genre must be one of ${Object.keys(GENRES).join(', ')}`);
  if (!MODES[song.mode]) fail(`mode must be one of ${Object.keys(MODES).join(', ')}`);
  parseChord('I', song.key, song.mode); // validates the key
  inRange(song.bpm, 60, 180, 'bpm');
  inRange(song.swing ?? 50, 50, 66, 'swing (%)');

  const progressions = song.progressions ?? {};
  if (!Object.keys(progressions).length) fail('define at least one progression');
  for (const [name, p] of Object.entries(progressions)) {
    if (!ID.test(name)) fail(`progression '${name}': names are lower-case letters, digits and _`);
    if (!Array.isArray(p.chords) || p.chords.length < 1 || p.chords.length > 8) {
      fail(`progression '${name}' needs 1-8 chords`);
    }
    if (![1, 2, 4].includes(p.barsPerChord ?? 1)) fail(`progression '${name}': barsPerChord is 1, 2 or 4`);
    p.chords.forEach((c) => parseChord(c, song.key, song.mode));
  }

  const parts = song.parts ?? {};
  const ids = Object.keys(parts);
  if (ids.length > LIMITS.parts) fail(`at most ${LIMITS.parts} parts`);
  for (const id of ids) validatePart(id, parts[id], song);

  if (!Array.isArray(song.sections) || !song.sections.length) fail('add at least one section');
  if (song.sections.length > LIMITS.sections) fail(`at most ${LIMITS.sections} sections`);
  let total = 0;
  song.sections.forEach((s, i) => {
    const where = `section ${i + 1} ('${s.name}')`;
    if (!ID.test(s.name ?? '')) fail(`${where}: names are lower-case letters, digits and _`);
    if (!Number.isInteger(s.bars) || s.bars < 1 || s.bars > 32) fail(`${where}: bars must be 1-32`);
    if (!progressions[s.progression]) fail(`${where}: progression '${s.progression}' isn't defined`);
    inRange(s.energy ?? 3, 1, 5, `${where} energy`);
    if (!Array.isArray(s.play)) fail(`${where}: play is a list of part ids`);
    const active = new Set();
    for (const entry of s.play) {
      const [id, variant] = String(entry).split(':');
      if (!parts[id]) fail(`${where}: no part '${id}'`);
      if (variant !== undefined && !VARIANTS[parts[id].role].includes(variant)) {
        fail(
          `${where}: '${variant}' isn't a variant of a ${parts[id].role} part (try ${VARIANTS[parts[id].role].join(', ') || 'none'})`,
        );
      }
      active.add(id);
    }
    if (active.size > LIMITS.activePerSection) {
      fail(`${where}: ${active.size} parts playing; the density cap is ${LIMITS.activePerSection}, so drop one`);
    }
    if (s.transition !== undefined && !TRANSITIONS.includes(s.transition)) {
      fail(`${where}: transition must be one of ${TRANSITIONS.join(', ')}`);
    }
    for (const a of s.automate ?? []) {
      if (!parts[a.part]) fail(`${where}: automation targets unknown part '${a.part}'`);
      if (a.param !== 'cutoff') fail(`${where}: only 'cutoff' automation is supported`);
      inRange(a.from, 0, 1, `${where} automation from`);
      inRange(a.to, 0, 1, `${where} automation to`);
    }
    total += s.bars;
  });
  if (total > LIMITS.totalBars) fail(`song is ${total} bars; the limit is ${LIMITS.totalBars}`);
  return true;
}

/** Copy a library progression into a song-ready object. */
export const libraryProgression = (name, barsPerChord = 1) => {
  const p = PROGRESSIONS[name];
  if (!p) fail(`no library progression '${name}'`);
  return { chords: [...p.chords], barsPerChord };
};
