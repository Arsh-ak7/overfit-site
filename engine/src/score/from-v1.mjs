/**
 * Adapter: turn a spike-era (v1, pattern-language) song into a Performance so the
 * v2 validator can grade it. v1 songs declare no key, mode or chords, so those
 * checks fail by construction, which is the point: it shows why they sounded thin.
 */
import { INSTRUMENTS } from '../engine/catalog.mjs';
import { noteToMidi, parse, query } from '../engine/pattern.mjs';
import { DRUM_NOTES } from './derive.mjs';

const BAR = 4;

/** v1 instrument -> v2 role. */
function roleOf(instrument) {
  const meta = INSTRUMENTS[instrument];
  if (meta.kind === 'drum') return instrument === 'noise' ? 'fx' : 'drums';
  if (['bass', 'sub', 'acid'].includes(instrument)) return 'bass';
  if (instrument === 'pad') return 'chords';
  return 'lead';
}

const V1_DRUM_NOTE = {
  kick: 'kick',
  s_kick: 'kick',
  snare: 'snare',
  s_snare: 'snare',
  hat: 'ch',
  s_hat: 'ch',
  openhat: 'oh',
  clap: 'clap',
  s_clap: 'clap',
  rim: 'rim',
};

/** @param {import('../types.mjs').Song} song a v1 song */
export function fromV1(song, { genre = 'techno' } = {}) {
  const tracks = {};
  const sections = [];
  let bar = 0;
  for (const section of song.sections) {
    sections.push({ name: section.name, startBeat: bar * BAR, bars: section.bars, energy: 3, play: [] });
    for (const layer of song.layers) {
      const playsHere = layer.in === undefined || layer.in === 'all' || layer.in.includes(section.name);
      if (!playsHere) continue;
      const role = roleOf(layer.instrument);
      const track = (tracks[layer.id] ??= { role, sound: layer.instrument, mix: {}, notes: [] });
      const tree = parse(layer.variants?.[section.name] ?? layer.pattern);
      for (let b = 0; b < section.bars; b++) {
        for (const ev of query(tree, bar + b, layer.id)) {
          const m = role === 'drums' ? DRUM_NOTES[V1_DRUM_NOTE[layer.instrument]] : noteToMidi(ev.v);
          track.notes.push({ t: (bar + b + ev.start) * BAR, d: ev.dur * BAR, m: m ?? 60, v: Math.round(ev.vel * 127) });
        }
      }
    }
    bar += section.bars;
  }
  const kicks = Object.values(tracks)
    .filter((t) => t.role === 'drums')
    .flatMap((t) => t.notes.filter((n) => n.m === DRUM_NOTES.kick).map((n) => n.t));
  return {
    title: song.title,
    genre,
    key: null,
    mode: null,
    bpm: song.bpm,
    totalBeats: bar * BAR,
    sections,
    chords: [],
    tracks,
    kicks,
    automation: [],
  };
}
