/**
 * Synthesized instruments. Each voice schedules Web Audio nodes for one note.
 *
 * Voice signature: (dest, time, freqHz, velocity, lengthSec, decayMul) => void
 *   dest       node the voice connects into (the layer's channel strip)
 *   time       start time in the context's clock, already sample-aligned
 *   freqHz     pitch for pitched voices; ignored by drums
 *   velocity   0..1
 *   lengthSec  step length x decay, used by sustained voices
 *   decayMul   the layer's decay parameter, used by percussive voices
 */

const SILENT = 0.0005;

/** Attack, then exponential decay. @returns {number} time the envelope is finished */
function envDecay(param, t, peak, decay, attack = 0.002) {
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(peak, t + attack);
  param.exponentialRampToValueAtTime(SILENT, t + attack + decay);
  return t + attack + decay + 0.01;
}

/** Attack, hold for the note length, linear release. @returns {number} end time */
function envHold(param, t, peak, len, attack, release) {
  const a = Math.min(attack, len * 0.9);
  const holdEnd = t + Math.max(a, len);
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(peak, t + a);
  param.setValueAtTime(peak, holdEnd);
  param.linearRampToValueAtTime(0, holdEnd + release);
  return holdEnd + release + 0.01;
}

/**
 * @param {BaseAudioContext} ctx
 * @param {AudioBuffer} noiseBuffer shared white noise, generated from a fixed seed
 */
export function createVoices(ctx, noiseBuffer) {
  const sr = ctx.sampleRate;
  // Set per note by the scheduler, so a noise hit reads the same slice of the
  // noise buffer however the song is chunked.
  let noiseSeed = 0;

  const gain = (dest) => {
    const g = ctx.createGain();
    g.gain.value = 0;
    g.connect(dest);
    return g;
  };
  const filter = (type, freq, q, dest) => {
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    f.connect(dest);
    return f;
  };
  const osc = (type, freq, t, end, dest, detune = 0) => {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    o.detune.setValueAtTime(detune, t);
    o.connect(dest);
    o.start(t);
    o.stop(end);
    return o;
  };
  const noise = (t, end, dest) => {
    const s = ctx.createBufferSource();
    s.buffer = noiseBuffer;
    s.connect(dest);
    const offset = Math.round(noiseSeed * (noiseBuffer.duration - 1) * sr) / sr;
    s.start(Math.round(t * sr) / sr, offset);
    s.stop(end);
  };

  return {
    /** @param {number} seed in [0, 1) */
    setNoiseSeed(seed) {
      noiseSeed = seed;
    },

    kick(dest, t, _f, v, _len, d) {
      const body = gain(dest);
      const end = envDecay(body.gain, t, v, 0.42 * d, 0.001);
      osc('sine', 160, t, end, body).frequency.exponentialRampToValueAtTime(46, t + 0.11);
      const click = gain(dest);
      const clickEnd = envDecay(click.gain, t, v * 0.3, 0.012, 0.0005);
      osc('square', 1400, t, clickEnd, filter('lowpass', 3000, 0.7, click));
    },

    snare(dest, t, _f, v, _len, d) {
      const rattle = gain(dest);
      noise(t, envDecay(rattle.gain, t, v * 0.7, 0.17 * d), filter('bandpass', 1900, 0.7, rattle));
      const tone = gain(dest);
      osc('triangle', 185, t, envDecay(tone.gain, t, v * 0.45, 0.07 * d), tone);
    },

    hat(dest, t, _f, v, _len, d) {
      const g = gain(dest);
      noise(t, envDecay(g.gain, t, v * 0.8, 0.05 * d), filter('highpass', 7500, 0.7, g));
    },

    openhat(dest, t, _f, v, _len, d) {
      const g = gain(dest);
      noise(t, envDecay(g.gain, t, v * 0.6, 0.32 * d), filter('highpass', 6500, 0.7, g));
    },

    clap(dest, t, _f, v, _len, d) {
      const g = gain(dest);
      const bp = filter('bandpass', 1150, 1.1, g);
      const p = g.gain;
      p.setValueAtTime(0, t);
      for (let i = 0; i < 3; i++) {
        p.setValueAtTime(v * 0.7, t + i * 0.011);
        p.exponentialRampToValueAtTime(0.05, t + i * 0.011 + 0.009);
      }
      p.setValueAtTime(v * 0.6, t + 0.033);
      p.exponentialRampToValueAtTime(SILENT, t + 0.033 + 0.15 * d);
      noise(t, t + 0.2 + 0.15 * d, bp);
    },

    rim(dest, t, _f, v, _len, d) {
      const g = gain(dest);
      osc('triangle', 1650, t, envDecay(g.gain, t, v * 0.5, 0.03 * d, 0.0005), filter('bandpass', 1700, 2, g));
    },

    noise(dest, t, _f, v, len) {
      const g = gain(dest);
      const L = Math.max(0.05, len);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(v * 0.35, t + L);
      g.gain.linearRampToValueAtTime(0, t + L + 0.04);
      const bp = filter('bandpass', 400, 1.2, g);
      bp.frequency.setValueAtTime(400, t);
      bp.frequency.exponentialRampToValueAtTime(7000, t + L);
      noise(t, t + L + 0.05, bp);
    },

    bass(dest, t, f, v, len) {
      const g = gain(dest);
      const end = envHold(g.gain, t, v * 0.42, len, 0.004, 0.05);
      const lp = filter('lowpass', 1400, 2, g);
      lp.frequency.setValueAtTime(1400, t);
      lp.frequency.exponentialRampToValueAtTime(300, t + 0.18);
      osc('sawtooth', f, t, end, lp);
    },

    sub(dest, t, f, v, len) {
      const g = gain(dest);
      osc('sine', f, t, envHold(g.gain, t, v * 0.6, len, 0.006, 0.06), g);
    },

    acid(dest, t, f, v, len) {
      const g = gain(dest);
      const end = envHold(g.gain, t, v * 0.3, len, 0.003, 0.04);
      const lp = filter('lowpass', 2600, 11, g);
      lp.frequency.setValueAtTime(2600 * (0.5 + v), t);
      lp.frequency.exponentialRampToValueAtTime(260, t + 0.22);
      osc('sawtooth', f, t, end, lp);
    },

    pluck(dest, t, f, v, _len, d) {
      const g = gain(dest);
      const end = envDecay(g.gain, t, v * 0.3, 0.28 * d, 0.002);
      const lp = filter('lowpass', 4200, 1, g);
      lp.frequency.setValueAtTime(4200, t);
      lp.frequency.exponentialRampToValueAtTime(600, t + 0.16);
      osc('sawtooth', f, t, end, lp, -7);
      osc('sawtooth', f, t, end, lp, 7);
    },

    pad(dest, t, f, v, len) {
      const g = gain(dest);
      const end = envHold(g.gain, t, v * 0.13, len, Math.min(0.45, len / 3), 0.7);
      const lp = filter('lowpass', 1800, 0.6, g);
      for (const cents of [-11, 0, 11]) osc('sawtooth', f, t, end, lp, cents);
    },

    lead(dest, t, f, v, len) {
      const g = gain(dest);
      const end = envHold(g.gain, t, v * 0.16, len, 0.01, 0.08);
      const lp = filter('lowpass', 3400, 1, g);
      osc('square', f, t, end, lp);
      osc('square', f, t, end, lp, 6);
    },

    bell(dest, t, f, v, _len, d) {
      const g = gain(dest);
      const end = envDecay(g.gain, t, v * 0.28, 1.1 * d, 0.002);
      const carrier = osc('sine', f, t, end, g);
      const depth = ctx.createGain();
      depth.gain.setValueAtTime(f * 2.2, t);
      depth.gain.exponentialRampToValueAtTime(f * 0.05, t + 0.6 * d);
      depth.connect(carrier.frequency);
      osc('sine', f * 3.5, t, end, depth);
    },
  };
}
