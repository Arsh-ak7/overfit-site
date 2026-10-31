/**
 * Song renderer. Environment-agnostic: the same module runs in Node
 * (node-web-audio-api) and in a browser, so the two can be compared.
 *
 * Rendering is two passes:
 *  1. Everything up to the master bus (voices, channel filters, delay, reverb) is
 *     linear, so it's rendered in short chunks of bars and summed. Chunking keeps
 *     each audio graph small; with one long graph, finished voices pile up and long
 *     songs render in quadratic time. Notes start on whole samples computed from
 *     song time, so the sum is bit-identical to a single pass (see tests).
 *  2. The non-linear master chain (glue compressor, limiter, soft clip) runs once
 *     over the summed buffer.
 *
 * @typedef {import('../types.mjs').Song} Song
 * @typedef {import('../types.mjs').Layer} Layer
 * @typedef {{ OfflineAudioContext: typeof OfflineAudioContext,
 *             getSample: (ctx: BaseAudioContext, instrument: string, key: string) => Promise<AudioBuffer> }} RenderEnv
 * @typedef {{ sampleRate?: number, solo?: string, mute?: string[], tail?: number, chunkBars?: number }} RenderOptions
 */
import { parse, query, noteToMidi, midiToHz, hash01 } from './pattern.mjs';
import { INSTRUMENTS, PARAMS, SAMPLE_SETS, DEFAULT_DELAY_TIME } from './catalog.mjs';
import { createVoices } from './voices.mjs';

const DEFAULT_SAMPLE_RATE = 44100;
const DEFAULT_TAIL_SEC = 3;
// 8 is what every logged run used; changing it shifts output at float-rounding level,
// which would break bit-exact re-renders of past sessions.
const DEFAULT_CHUNK_BARS = 8;
const PRE_ROLL_SEC = 0.05;
const MAX_CHUNK_TAIL_SEC = 16;
const DELAY_FEEDBACK = 0.38;
const REVERB_SEC = 2.2;
const SEED = 12345;

/** @param {Layer} layer @param {keyof typeof PARAMS} key */
const param = (layer, key) => layer[key] ?? PARAMS[key][2];

/** @param {Song} song */
export const songBars = (song) => song.sections.reduce((n, s) => n + s.bars, 0);

/** @param {Song} song */
export const barSeconds = (song) => 240 / song.bpm;

/** @param {Song} song */
export const songSeconds = (song, tail = DEFAULT_TAIL_SEC) => songBars(song) * barSeconds(song) + tail;

function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Noise and reverb impulse, regenerated identically in every context. */
function createSharedBuffers(ctx) {
  const sr = ctx.sampleRate;
  const rng = mulberry32(SEED);
  const noise = ctx.createBuffer(1, sr * 2, sr);
  const nd = noise.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = rng() * 2 - 1;
  const irLength = Math.floor(sr * REVERB_SEC);
  const impulse = ctx.createBuffer(2, irLength, sr);
  for (let c = 0; c < 2; c++) {
    const d = impulse.getChannelData(c);
    for (let i = 0; i < irLength; i++) d[i] = (rng() * 2 - 1) * Math.pow(1 - i / irLength, 3.2);
  }
  return { noise, impulse };
}

/** Seconds of audio a chunk can ring on after its last bar: notes + delay + reverb. */
function chunkTailSeconds(song, layers) {
  const beat = 60 / song.bpm;
  const bar = 4 * beat;
  let ring = 0.5;
  let fx = 0;
  for (const l of layers) {
    const d = param(l, 'decay');
    const isSample = INSTRUMENTS[l.instrument].src === 'sample';
    ring = Math.max(ring, bar * d + 0.8, isSample ? 4 : 0, l.instrument === 'bell' ? 1.2 * d : 0);
    // 0.38^9 is about -38 dB: inaudible under the mix
    if (param(l, 'delay') > 0) fx = Math.max(fx, 9 * (l.delayTime ?? DEFAULT_DELAY_TIME) * beat);
    if (param(l, 'reverb') > 0) fx = Math.max(fx, REVERB_SEC + 0.1);
  }
  return Math.min(ring + fx, MAX_CHUNK_TAIL_SEC);
}

function nearestSample(notes, midi) {
  let best = null;
  for (const key of notes) {
    const m = noteToMidi(key);
    if (!best || Math.abs(m - midi) < Math.abs(best.midi - midi)) best = { key, midi: m };
  }
  return best;
}

/** Gain -> high-pass -> low-pass -> pan, with optional delay and reverb sends. */
function createChannelStrip(ctx, layer, beat, bus, reverbIn) {
  const input = ctx.createGain();
  input.gain.value = param(layer, 'gain');
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = param(layer, 'hpf');
  hp.Q.value = 0.7;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = param(layer, 'lpf');
  lp.Q.value = 0.7;
  const pan = ctx.createStereoPanner();
  pan.pan.value = param(layer, 'pan');
  input.connect(hp);
  hp.connect(lp);
  lp.connect(pan);
  pan.connect(bus);

  if (param(layer, 'reverb') > 0) {
    const send = ctx.createGain();
    send.gain.value = param(layer, 'reverb');
    pan.connect(send);
    send.connect(reverbIn);
  }
  if (param(layer, 'delay') > 0) {
    const send = ctx.createGain();
    send.gain.value = param(layer, 'delay');
    const delay = ctx.createDelay(4);
    delay.delayTime.value = (layer.delayTime ?? DEFAULT_DELAY_TIME) * beat;
    const feedback = ctx.createGain();
    feedback.gain.value = DELAY_FEEDBACK;
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 3500;
    pan.connect(send);
    send.connect(delay);
    delay.connect(tone);
    tone.connect(feedback);
    feedback.connect(delay);
    tone.connect(bus);
  }
  return input;
}

function playSample(ctx, dest, meta, buffer, rate, t, velocity, decay) {
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.playbackRate.value = rate;
  const g = ctx.createGain();
  const natural = buffer.duration / rate;
  const wanted = meta.kind === 'drum' ? natural * Math.min(1, decay) + 0.02 : 0.15 + 1.6 * decay;
  const end = t + Math.min(natural, wanted);
  g.gain.setValueAtTime(velocity * 0.9, t);
  g.gain.setValueAtTime(velocity * 0.9, Math.max(t, end - 0.03));
  g.gain.linearRampToValueAtTime(0, end);
  src.connect(g);
  g.connect(dest);
  src.start(t);
  src.stop(end + 0.01);
}

/** Does `layer` play in `sectionName`? */
const playsIn = (layer, sectionName) => layer.in === undefined || layer.in === 'all' || layer.in.includes(sectionName);

/**
 * Render bars [fromBar, toBar) of the pre-master bus and add them into `bus`.
 * @returns {Promise<number>} number of notes scheduled
 */
async function renderChunk({ song, env, sampleRate: sr, layers, samples, fromBar, toBar, bus }) {
  const beat = 60 / song.bpm;
  const bar = 4 * beat;
  // Chunk-local time 0 is song time `offsetSamples / sr`, a whole sample.
  const offsetSamples = Math.round(fromBar * bar * sr);
  const length = (toBar - fromBar) * bar + PRE_ROLL_SEC + chunkTailSeconds(song, layers);
  const ctx = new env.OfflineAudioContext(2, Math.ceil(length * sr), sr);
  const shared = createSharedBuffers(ctx);

  const out = ctx.createGain();
  out.gain.value = 0.8;
  out.connect(ctx.destination);
  const reverb = ctx.createConvolver();
  reverb.normalize = true;
  reverb.buffer = shared.impulse;
  const reverbReturn = ctx.createGain();
  reverbReturn.gain.value = 0.55;
  reverb.connect(reverbReturn);
  reverbReturn.connect(out);
  const voices = createVoices(ctx, shared.noise);
  const swing = song.swing || 0;
  let notes = 0;

  for (const layer of layers) {
    const meta = INSTRUMENTS[layer.instrument];
    const strip = createChannelStrip(ctx, layer, beat, out, reverb);
    const trees = { default: parse(layer.pattern) };
    for (const [section, pattern] of Object.entries(layer.variants ?? {})) trees[section] = parse(pattern);
    const decay = param(layer, 'decay');

    let barIndex = 0;
    for (const section of song.sections) {
      const active = playsIn(layer, section.name);
      for (let b = 0; b < section.bars; b++, barIndex++) {
        if (!active || barIndex < fromBar || barIndex >= toBar) continue;
        const events = query(trees[section.name] ?? trees.default, barIndex, layer.id);
        events.forEach((ev, eventIndex) => {
          let start = ev.start;
          const pos16 = start * 16;
          const onOdd16th = Math.abs(pos16 - Math.round(pos16)) < 1e-6 && Math.round(pos16) % 2 === 1;
          if (swing && onOdd16th) start += swing / 16;
          const t = (Math.round((barIndex * bar + start * bar + PRE_ROLL_SEC) * sr) - offsetSamples) / sr;
          const len = ev.dur * bar * decay;

          if (meta.src === 'synth') {
            const freq = meta.kind === 'pitch' ? midiToHz(noteToMidi(ev.v)) : 0;
            voices.setNoiseSeed(hash01(layer.id, barIndex, eventIndex));
            voices[layer.instrument](strip, t, freq, ev.vel, len, decay);
          } else {
            const set = SAMPLE_SETS[layer.instrument];
            let buffer;
            let rate = 1;
            if (set.notes) {
              const midi = noteToMidi(ev.v);
              const nearest = nearestSample(set.notes, midi);
              buffer = samples[layer.instrument][nearest.key];
              rate = Math.pow(2, (midi - nearest.midi) / 12);
            } else {
              // Round-robin keyed on position only, so chunking can't change it.
              buffer = samples[layer.instrument][set.hits[(barIndex * 7 + eventIndex) % set.hits.length]];
            }
            playSample(ctx, strip, meta, buffer, rate, t, ev.vel, decay);
          }
          notes++;
        });
      }
    }
  }

  const rendered = await ctx.startRendering();
  for (let c = 0; c < 2; c++) {
    const src = rendered.getChannelData(c);
    const dst = bus[c];
    const n = Math.min(src.length, dst.length - offsetSamples);
    for (let i = 0; i < n; i++) dst[offsetSamples + i] += src[i];
  }
  return notes;
}

/** Glue compressor -> limiter -> soft clip -> output trim (peak near -1 dBFS). */
async function master(env, bus, sr) {
  const length = bus[0].length;
  const ctx = new env.OfflineAudioContext(2, length, sr);
  const input = ctx.createBuffer(2, length, sr);
  input.getChannelData(0).set(bus[0]);
  input.getChannelData(1).set(bus[1]);
  const src = ctx.createBufferSource();
  src.buffer = input;

  const glue = ctx.createDynamicsCompressor();
  glue.threshold.value = -16;
  glue.ratio.value = 3;
  glue.attack.value = 0.01;
  glue.release.value = 0.2;
  glue.knee.value = 6;
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -2;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.08;
  limiter.knee.value = 0;
  const clip = ctx.createWaveShaper();
  const curve = new Float32Array(2049);
  for (let i = 0; i < curve.length; i++) curve[i] = Math.tanh(1.6 * (i / 1024 - 1)) / Math.tanh(1.6);
  clip.curve = curve;
  const trim = ctx.createGain();
  trim.gain.value = 0.89;

  src.connect(glue);
  glue.connect(limiter);
  limiter.connect(clip);
  clip.connect(trim);
  trim.connect(ctx.destination);
  src.start(0);
  return ctx.startRendering();
}

async function loadSamples(env, layers, sr) {
  const decodeCtx = new env.OfflineAudioContext(2, 128, sr);
  const samples = {};
  for (const layer of layers) {
    if (INSTRUMENTS[layer.instrument].src !== 'sample' || samples[layer.instrument]) continue;
    const set = SAMPLE_SETS[layer.instrument];
    samples[layer.instrument] = {};
    for (const key of set.notes ?? set.hits) {
      samples[layer.instrument][key] = await env.getSample(decodeCtx, layer.instrument, key);
    }
  }
  return samples;
}

/**
 * Render a validated song.
 * @param {Song} song
 * @param {RenderEnv} env
 * @param {RenderOptions} [options]
 * @returns {Promise<{ buffer: AudioBuffer, seconds: number, notes: number }>}
 */
export async function renderSong(song, env, options = {}) {
  const sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const seconds = songSeconds(song, options.tail ?? DEFAULT_TAIL_SEC);
  const totalBars = songBars(song);
  const chunkBars = options.chunkBars === 0 ? totalBars : (options.chunkBars ?? DEFAULT_CHUNK_BARS);
  const layers = song.layers.filter((l) =>
    options.solo ? l.id === options.solo : !(options.mute ?? []).includes(l.id),
  );
  const samples = await loadSamples(env, layers, sampleRate);

  const totalSamples = Math.ceil(seconds * sampleRate);
  const bus = [new Float32Array(totalSamples), new Float32Array(totalSamples)];
  let notes = 0;
  for (let fromBar = 0; fromBar < totalBars; fromBar += chunkBars) {
    const toBar = Math.min(totalBars, fromBar + chunkBars);
    notes += await renderChunk({ song, env, sampleRate, layers, samples, fromBar, toBar, bus });
  }
  return { buffer: await master(env, bus, sampleRate), seconds, notes };
}
