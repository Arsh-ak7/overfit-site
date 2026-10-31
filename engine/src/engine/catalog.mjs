// The allow-list. Agents can only pick from these instruments and parameter ranges.
// "synth" voices are generated procedurally (no samples, no licence questions).
// "sample" voices use CC0 one-shots from the Versilian Community Sample Library.

export const INSTRUMENTS = {
  // synthesized drums: atoms must be x (hit) or X (accent)
  kick: { kind: 'drum', src: 'synth', desc: 'electronic kick, pitch-swept sine' },
  snare: { kind: 'drum', src: 'synth', desc: 'electronic snare, noise + tone' },
  hat: { kind: 'drum', src: 'synth', desc: 'closed hi-hat, bright noise' },
  openhat: { kind: 'drum', src: 'synth', desc: 'open hi-hat, longer noise' },
  clap: { kind: 'drum', src: 'synth', desc: 'electronic clap, three noise bursts' },
  rim: { kind: 'drum', src: 'synth', desc: 'short wooden click' },
  noise: {
    kind: 'drum',
    src: 'synth',
    desc: 'filtered noise swell for risers and texture; length follows step size x decay',
  },
  // synthesized pitched voices: atoms must be notes like c3, eb2, f#4
  bass: { kind: 'pitch', src: 'synth', range: [24, 60], desc: 'saw bass through a low-pass' },
  sub: { kind: 'pitch', src: 'synth', range: [24, 52], desc: 'pure sine sub bass' },
  acid: { kind: 'pitch', src: 'synth', range: [28, 64], desc: 'resonant squelchy saw' },
  pluck: { kind: 'pitch', src: 'synth', range: [40, 88], desc: 'short bright pluck' },
  pad: { kind: 'pitch', src: 'synth', range: [36, 84], desc: 'slow detuned saw pad' },
  lead: { kind: 'pitch', src: 'synth', range: [48, 96], desc: 'square-wave lead' },
  bell: { kind: 'pitch', src: 'synth', range: [48, 100], desc: 'FM bell' },
  // CC0 samples (VCSL)
  marimba: { kind: 'pitch', src: 'sample', range: [29, 96], desc: 'acoustic marimba (VCSL, CC0)' },
  kalimba: { kind: 'pitch', src: 'sample', range: [45, 81], desc: 'Kenyan kalimba (VCSL, CC0)' },
  glock: { kind: 'pitch', src: 'sample', range: [60, 108], desc: 'glockenspiel (VCSL, CC0)' },
  s_kick: { kind: 'drum', src: 'sample', desc: 'acoustic bass drum (VCSL, CC0)' },
  s_snare: { kind: 'drum', src: 'sample', desc: 'acoustic snare (VCSL, CC0)' },
  s_hat: { kind: 'drum', src: 'sample', desc: 'acoustic closed hi-hat (VCSL, CC0)' },
  s_clap: { kind: 'drum', src: 'sample', desc: 'real hand claps (VCSL, CC0)' },
};

// Sample files on disk, relative to assets/samples/vcsl. Pitched sets are keyed by note.
export const SAMPLE_SETS = {
  marimba: { dir: 'marimba', notes: ['F1', 'C2', 'G2', 'B2', 'F3', 'C4', 'G4', 'B4', 'F5', 'C6'] },
  kalimba: { dir: 'kalimba', notes: ['B2', 'C#3', 'D#3', 'F#3', 'G#3', 'B3', 'C#4', 'D#4', 'F#4', 'A4', 'B4'] },
  glock: { dir: 'glock', notes: ['G4', 'C5', 'G5', 'C6', 'G#6', 'C7'] },
  s_kick: { dir: 'bassdrum', hits: ['rr1'] },
  s_snare: { dir: 'snare', hits: ['rr1', 'rr2'] },
  s_hat: { dir: 'hat', hits: ['rr1', 'rr2'] },
  s_clap: { dir: 'clap', hits: ['rr1', 'rr2', 'rr3', 'rr4'] },
};

export function sampleFiles() {
  const out = [];
  for (const [inst, s] of Object.entries(SAMPLE_SETS)) {
    for (const n of s.notes || s.hits) out.push({ inst, key: n, path: `${s.dir}/${n}.wav` });
  }
  return out;
}

// Layer parameters: [min, max, default]
export const PARAMS = {
  gain: [0, 1, 0.7],
  pan: [-1, 1, 0],
  lpf: [80, 18000, 18000],
  hpf: [20, 4000, 20],
  decay: [0.05, 4, 1], // multiplies note length (step size)
  delay: [0, 0.7, 0], // send level to a tempo-synced delay
  reverb: [0, 0.8, 0], // send level to the room
};
export const DELAY_TIMES = [0.25, 0.375, 0.5, 0.75, 1]; // in beats
export const DEFAULT_DELAY_TIME = 0.75;

export const SONG_LIMITS = {
  bpm: [60, 180],
  swing: [0, 0.3],
  maxSections: 10,
  barsPerSection: [1, 16],
  maxBars: 64,
  maxLayers: 6, // the density cap
  maxVariants: 4,
  idRe: /^[a-z][a-z0-9_]{0,23}$/,
  sectionRe: /^[a-z][a-z0-9_]{0,15}$/,
};
