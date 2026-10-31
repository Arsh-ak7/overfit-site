/**
 * Allow-list validation. Everything an agent submits passes through here before
 * it can reach the renderer. Throws ValidationError with a message the agent can act on.
 */
import { PatternError, ValidationError } from '../errors.mjs';
import { DELAY_TIMES, INSTRUMENTS, PARAMS, SONG_LIMITS } from './catalog.mjs';
import { atomsOf, noteToMidi, parse } from './pattern.mjs';

const LAYER_KEYS = new Set([
  'id',
  'owner',
  'instrument',
  'pattern',
  'variants',
  'in',
  ...Object.keys(PARAMS),
  'delayTime',
]);

function checkPattern(src, inst, where) {
  let tree;
  try {
    tree = parse(src);
  } catch (e) {
    if (e instanceof PatternError) throw new ValidationError(`${where}: ${e.message}`);
    throw e;
  }
  const meta = INSTRUMENTS[inst];
  for (const a of atomsOf(tree)) {
    if (meta.kind === 'drum') {
      if (a !== 'x' && a !== 'X') {
        throw new ValidationError(`${where}: drum instrument '${inst}' only takes x or X hits, got '${a}'`);
      }
    } else {
      const m = noteToMidi(a);
      if (m === null) throw new ValidationError(`${where}: '${a}' is not a note (use names like c3, eb2, f#4)`);
      const [lo, hi] = meta.range;
      if (m < lo || m > hi) {
        throw new ValidationError(`${where}: note '${a}' is outside ${inst}'s range (MIDI ${lo}-${hi})`);
      }
    }
  }
  return tree;
}

export function validateLayer(layer, sectionNames) {
  if (!layer || typeof layer !== 'object' || Array.isArray(layer)) throw new ValidationError('layer must be an object');
  for (const k of Object.keys(layer)) if (!LAYER_KEYS.has(k)) throw new ValidationError(`unknown layer field '${k}'`);
  if (!SONG_LIMITS.idRe.test(layer.id || '')) {
    throw new ValidationError(`layer id '${layer.id}' must match ${SONG_LIMITS.idRe}`);
  }
  if (!INSTRUMENTS[layer.instrument]) {
    throw new ValidationError(
      `unknown instrument '${layer.instrument}'. Allowed: ${Object.keys(INSTRUMENTS).join(', ')}`,
    );
  }
  checkPattern(layer.pattern, layer.instrument, `layer ${layer.id} pattern`);
  if (layer.variants !== undefined) {
    if (typeof layer.variants !== 'object' || Array.isArray(layer.variants)) {
      throw new ValidationError('variants must be an object {section: pattern}');
    }
    const ks = Object.keys(layer.variants);
    if (ks.length > SONG_LIMITS.maxVariants) {
      throw new ValidationError(`at most ${SONG_LIMITS.maxVariants} variants per layer`);
    }
    for (const s of ks) {
      if (!sectionNames.includes(s)) throw new ValidationError(`variant for unknown section '${s}'`);
      checkPattern(layer.variants[s], layer.instrument, `layer ${layer.id} variant ${s}`);
    }
  }
  if (layer.in !== undefined && layer.in !== 'all') {
    if (!Array.isArray(layer.in) || !layer.in.length) {
      throw new ValidationError(`'in' must be "all" or a non-empty list of section names`);
    }
    for (const s of layer.in) {
      if (!sectionNames.includes(s)) throw new ValidationError(`layer ${layer.id} plays in unknown section '${s}'`);
    }
  }
  for (const [k, [lo, hi]] of Object.entries(PARAMS)) {
    if (layer[k] === undefined) continue;
    if (typeof layer[k] !== 'number' || !Number.isFinite(layer[k]) || layer[k] < lo || layer[k] > hi) {
      throw new ValidationError(`${k} must be a number in ${lo}..${hi}`);
    }
  }
  if (layer.delayTime !== undefined && !DELAY_TIMES.includes(layer.delayTime)) {
    throw new ValidationError(`delayTime must be one of ${DELAY_TIMES.join(', ')} (beats)`);
  }
  return true;
}

export function validateStructure(st) {
  const L = SONG_LIMITS;
  if (typeof st.bpm !== 'number' || st.bpm < L.bpm[0] || st.bpm > L.bpm[1]) {
    throw new ValidationError(`bpm must be ${L.bpm[0]}..${L.bpm[1]}`);
  }
  if (st.swing !== undefined && (typeof st.swing !== 'number' || st.swing < L.swing[0] || st.swing > L.swing[1])) {
    throw new ValidationError(`swing must be ${L.swing[0]}..${L.swing[1]}`);
  }
  if (!Array.isArray(st.sections) || !st.sections.length) {
    throw new ValidationError('sections must be a non-empty list');
  }
  if (st.sections.length > L.maxSections) throw new ValidationError(`at most ${L.maxSections} sections`);
  let bars = 0;
  for (const s of st.sections) {
    if (!s || !L.sectionRe.test(s.name || '')) {
      throw new ValidationError(`section name '${s && s.name}' must match ${L.sectionRe}`);
    }
    if (!Number.isInteger(s.bars) || s.bars < L.barsPerSection[0] || s.bars > L.barsPerSection[1]) {
      throw new ValidationError(`section ${s.name}: bars must be an integer ${L.barsPerSection.join('..')}`);
    }
    bars += s.bars;
  }
  if (bars > L.maxBars) throw new ValidationError(`song is ${bars} bars; maximum is ${L.maxBars}`);
  // Repeated section names are allowed (verse, chorus, verse) and share variants.
  return true;
}

export function validateSong(song) {
  validateStructure(song);
  const names = [...new Set(song.sections.map((s) => s.name))];
  if (!Array.isArray(song.layers)) throw new ValidationError('layers must be a list');
  if (song.layers.length > SONG_LIMITS.maxLayers) {
    throw new ValidationError(`at most ${SONG_LIMITS.maxLayers} layers (density cap)`);
  }
  const ids = new Set();
  for (const l of song.layers) {
    validateLayer(l, names);
    if (ids.has(l.id)) throw new ValidationError(`duplicate layer id '${l.id}'`);
    ids.add(l.id);
  }
  return true;
}
