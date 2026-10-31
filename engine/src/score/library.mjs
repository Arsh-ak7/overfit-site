/**
 * Curated musical libraries agents choose from: chord progressions, drum grooves
 * and genre profiles. Choosing from these is one visible decision; agents may
 * also write their own progressions and drum lines.
 *
 * Sources for the defaults: docs/making-ai-songs-sound-proper.md and
 * docs/research/songcraft/songcraft-rules.md. Thresholds are starting heuristics.
 */

/** Named chord loops. `modes` lists the modes the numerals assume. */
export const PROGRESSIONS = Object.freeze({
  epic_minor: { chords: ['i', 'VI', 'III', 'VII'], modes: ['minor'], note: 'the stock EDM/trance loop' },
  dark_drive: { chords: ['i', 'VII', 'VI', 'VII'], modes: ['minor'], note: 'rocking minor loop' },
  minor_lament: { chords: ['i', 'VI', 'iv', 'v'], modes: ['minor'], note: 'melancholic, all diatonic' },
  minor_lift: { chords: ['i', 'iv', 'VI', 'V'], modes: ['minor'], note: 'harmonic-minor V pulls home' },
  minor_pop: { chords: ['vi', 'IV', 'I', 'V'], modes: ['major'], note: 'the pop loop starting on the minor chord' },
  axis: { chords: ['I', 'V', 'vi', 'IV'], modes: ['major'], note: 'the most common pop loop' },
  doo_wop: { chords: ['I', 'vi', 'IV', 'V'], modes: ['major'], note: '50s loop, bright' },
  royal_road: { chords: ['IVmaj7', 'V7', 'iii7', 'vi'], modes: ['major'], note: 'J-pop/future bass favourite' },
  jazzy_251: { chords: ['ii7', 'V7', 'Imaj7', 'vi7'], modes: ['major'], note: 'lo-fi and jazz turnaround' },
  lofi_drift: { chords: ['IVmaj7', 'iii7', 'ii7', 'Imaj7'], modes: ['major'], note: 'descending lo-fi loop' },
  dorian_vamp: { chords: ['i7', 'IV7'], modes: ['dorian'], note: 'two-chord groove, deep house' },
  mixo_rock: { chords: ['I', 'bVII', 'IV', 'I'], modes: ['mixolydian', 'major'], note: 'anthemic, borrowed bVII' },
  phrygian_tension: { chords: ['i', 'bII', 'i', 'VII'], modes: ['phrygian', 'minor'], note: 'dark techno tension' },
  one_chord_drone: {
    chords: ['i'],
    modes: ['minor', 'dorian', 'phrygian'],
    note: 'hypnotic techno: harmony by bass and texture',
  },
  suspended_float: { chords: ['Isus2', 'IV', 'vi', 'Vsus4'], modes: ['major'], note: 'airy, ambient-friendly' },
});

/**
 * Drum grooves: one bar per voice as 16 slots. x = hit, X = accent, g = ghost, . = rest.
 * Voices map to General MIDI drum notes in the renderer.
 */
export const GROOVES = Object.freeze({
  house_classic: {
    kick: 'x...x...x...x...',
    clap: '....x.......x...',
    ch: 'x.g.x.g.x.g.x.g.',
    oh: '..x...x...x...x.',
    genres: ['house'],
  },
  techno_driving: {
    kick: 'X...x...X...x...',
    clap: '....x.......x...',
    ch: 'xgxgxgxgxgxgxgxg',
    oh: '..x...x...x...x.',
    rim: '...x..x....x.x..',
    genres: ['techno'],
  },
  techno_minimal: {
    kick: 'x...x...x...x...',
    rim: '..x.......x..x..',
    ch: '..x...x...x...x.',
    genres: ['techno'],
  },
  techno_rolling: {
    kick: 'x...x...x...x...',
    ch: 'gxgxgxgxgxgxgxgx',
    oh: '..x...x...x...x.',
    perc: 'x..x..x..x..x.x.',
    clap: '....x.......x...',
    genres: ['techno'],
  },
  synthpop_backbeat: {
    kick: 'x.......x.x.....',
    snare: '....x.......x...',
    ch: 'x.x.x.x.x.x.x.x.',
    genres: ['synthpop'],
  },
  synthpop_four: {
    kick: 'x...x...x...x...',
    snare: '....x.......x...',
    ch: '..x...x...x...x.',
    clap: '....x.......x...',
    genres: ['synthpop', 'house'],
  },
  halftime: {
    kick: 'x.........x.....',
    snare: '........x.......',
    ch: 'x.x.x.x.x.xxx.x.',
    genres: ['synthpop', 'lofi'],
  },
  boom_bap: {
    kick: 'x.....x...x.....',
    snare: '....x.......x...',
    ch: 'x.x.x.x.x.x.x.x.',
    genres: ['lofi'],
  },
  breakbeat: {
    kick: 'x.........x.x...',
    snare: '....x..g.g..x...',
    ch: 'x.x.x.x.x.x.x.x.',
    genres: ['synthpop', 'techno'],
  },
  dnb_two_step: {
    kick: 'x.........x.....',
    snare: '....x.......x...',
    ch: 'x.x.x.x.x.x.x.x.',
    genres: ['dnb'],
  },
  dnb_roller: {
    kick: 'x.......x.x.....',
    snare: '....x..g....x..g',
    ch: 'xgxgxgxgxgxgxgxg',
    oh: '..............x.',
    genres: ['dnb'],
  },
  ambient_pulse: {
    kick: 'x.......x.......',
    ch: '......x.......x.',
    genres: ['ambient'],
  },
});

/** Fill played on the last bar of a phrase (per voice; replaces the groove's voice in that bar). */
export const FILLS = Object.freeze({
  snare_roll: { snare: '........x.x.xxxx' },
  clap_build: { clap: '....x.....x.x.xx' },
  tom_run: { tom_hi: '........xx......', tom_mid: '..........xx....', tom_lo: '............xxxx' },
  hat_open: { oh: '..x...x...x...xx' },
  kick_drop: { kick: 'x...x...x.......' },
});

/** Genre profiles: ranges and rule thresholds. Durations in seconds. */
export const GENRES = Object.freeze({
  techno: {
    bpm: [128, 150],
    swing: [50, 54],
    modes: ['minor', 'phrygian', 'dorian'],
    sectionBars: [8, 12, 16, 32],
    duration: [180, 420],
    drumsRequired: true,
    peakMin: 5,
    introMax: 3,
    hookBy: 32,
  },
  house: {
    bpm: [120, 132],
    swing: [50, 58],
    modes: ['minor', 'dorian', 'major'],
    sectionBars: [8, 16, 32],
    duration: [180, 360],
    drumsRequired: true,
    peakMin: 5,
    introMax: 3,
    hookBy: 32,
  },
  synthpop: {
    bpm: [100, 130],
    swing: [50, 54],
    modes: ['major', 'minor', 'mixolydian'],
    sectionBars: [4, 8, 16],
    duration: [150, 240],
    drumsRequired: true,
    peakMin: 5,
    introMax: 3,
    hookBy: 8,
  },
  lofi: {
    bpm: [70, 92],
    swing: [55, 62],
    modes: ['major', 'dorian', 'minor'],
    sectionBars: [4, 8, 16],
    duration: [120, 210],
    drumsRequired: true,
    peakMin: 4,
    introMax: 3,
    hookBy: 8,
  },
  dnb: {
    bpm: [165, 178],
    swing: [50, 54],
    modes: ['minor', 'dorian', 'phrygian'],
    sectionBars: [8, 16, 32],
    duration: [150, 330],
    drumsRequired: true,
    peakMin: 5,
    introMax: 3,
    hookBy: 32,
  },
  ambient: {
    bpm: [60, 100],
    swing: [50, 54],
    modes: ['major', 'minor', 'dorian', 'mixolydian'],
    sectionBars: [8, 16, 32],
    duration: [150, 360],
    drumsRequired: false,
    peakMin: 3,
    introMax: 2,
    hookBy: 64,
  },
});

/** Section names that count as the song's high point, and as its low point. */
export const PEAK_SECTIONS = new Set(['drop', 'peak', 'chorus', 'climax']);
export const LOW_SECTIONS = new Set(['break', 'breakdown', 'bridge']);
