/**
 * The validator gates and the plain-language analysis agents read.
 *
 * Works on a Performance (from derive() or fromV1()), so it can grade both new
 * songs and the spike's old ones. Hard rules block a song from being finished;
 * soft rules warn. Every threshold is a starting heuristic from
 * docs/making-ai-songs-sound-proper.md, to be calibrated against listeners.
 */
import { DRUM_NOTES } from './derive.mjs';
import { GENRES, LOW_SECTIONS, PEAK_SECTIONS } from './library.mjs';

const BAR = 4;
const CLOSED_HAT = DRUM_NOTES.ch;
const KICK = DRUM_NOTES.kick;

const pct = (x) => `${Math.round(x * 100)}%`;
const list = (items) =>
  items.length <= 2 ? items.join(' and ') : `${items.slice(0, 3).join(', ')}${items.length > 3 ? ' and more' : ''}`;
const barOf = (t) => Math.floor(t / BAR) + 1; // 1-based for people
const fmtTime = (beats, bpm) => {
  const s = Math.round((beats * 60) / bpm);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Tracks with any note in [t0, t1). */
function activeTracks(perf, t0, t1) {
  return Object.entries(perf.tracks)
    .filter(([, tr]) => tr.notes.some((n) => n.t >= t0 && n.t < t1))
    .map(([id]) => id);
}

const tracksByRole = (perf, role) => Object.entries(perf.tracks).filter(([, tr]) => tr.role === role);

/** Section roles: intro/outro by position, peak and low by name or energy. */
function classifySections(perf) {
  const sections = perf.sections.map((s, i) => ({
    ...s,
    index: i,
    t0: s.startBeat,
    t1: s.startBeat + s.bars * BAR,
    isIntro: i === 0,
    isOutro: i === perf.sections.length - 1 && perf.sections.length > 1,
  }));
  const body = sections.filter((s) => !s.isIntro && !s.isOutro);
  const maxEnergy = Math.max(...sections.map((s) => s.energy ?? 3));
  for (const s of sections) {
    s.isPeak =
      PEAK_SECTIONS.has(s.name) || (!s.isIntro && !s.isOutro && (s.energy ?? 3) === maxEnergy && maxEnergy >= 4);
    s.isLow = LOW_SECTIONS.has(s.name);
  }
  return { sections, body };
}

function rule(list, id, ok, message, detail) {
  list.push({ id, ok, message: ok ? null : message, detail });
}

/**
 * The quality floor: no song finishes without these. Every other hard rule is a
 * convention of the genre, which a character may break on purpose (see CONVENTIONS
 * and song.breaks): the judge then records the break and its reason instead of failing.
 */
export const FLOOR = new Set(['tempo', 'key', 'chords_chosen', 'sections', 'duration', 'keeps_changing']);
export const isConvention = (id) => !FLOOR.has(id);

/**
 * @param {import('./derive.mjs').Performance} perf
 * @param {{ genre?: string, swing?: number }} [song] declared song fields, when available
 */
export function analyze(perf, song = {}) {
  const genreName = song.genre ?? perf.genre ?? 'techno';
  const genre = GENRES[genreName];
  const hard = [];
  const soft = [];
  const { sections, body } = classifySections(perf);
  const seconds = (perf.totalBeats * 60) / perf.bpm;

  // ---- declaration
  rule(
    hard,
    'tempo',
    perf.bpm >= genre.bpm[0] && perf.bpm <= genre.bpm[1],
    `${perf.bpm} BPM is outside the ${genreName} range of ${genre.bpm.join('-')}.`,
  );
  rule(
    hard,
    'key',
    Boolean(perf.key && perf.mode),
    'The song never declares a key and mode, so nothing can be in or out of key.',
  );

  // ---- required roles, measured over the body of the song
  const bodyBars = body.reduce((n, s) => n + s.bars, 0) || sections.reduce((n, s) => n + s.bars, 0);
  const span = body.length ? body : sections;
  const coverage = (role) => {
    const ids = new Set(tracksByRole(perf, role).map(([id]) => id));
    if (!ids.size) return 0;
    let covered = 0;
    for (const s of span) {
      for (let b = 0; b < s.bars; b++) {
        const t0 = s.t0 + b * BAR;
        if ([...ids].some((id) => perf.tracks[id].notes.some((n) => n.t < t0 + BAR && n.t + n.d > t0))) covered++;
      }
    }
    return covered / bodyBars;
  };
  const roleCoverage = Object.fromEntries(['drums', 'bass', 'chords', 'lead'].map((r) => [r, coverage(r)]));
  for (const role of ['bass', 'chords']) {
    rule(
      hard,
      `has_${role}`,
      roleCoverage[role] >= 0.5,
      roleCoverage[role] === 0
        ? `There is no ${role === 'chords' ? 'chord part' : 'bassline'} at all. Every song needs one.`
        : `The ${role === 'chords' ? 'chords' : 'bass'} play in only ${pct(roleCoverage[role])} of the main sections; they need at least half.`,
    );
  }
  rule(hard, 'has_lead', roleCoverage.lead > 0, 'There is no hook or lead line.');
  if (genre.drumsRequired) rule(hard, 'has_drums', roleCoverage.drums > 0, `A ${genreName} track needs drums.`);

  // ---- harmony
  const chords = perf.chords ?? [];
  if (chords.length) {
    const diatonic = chords.filter((c) => c.diatonic).length / chords.length;
    rule(hard, 'diatonic', diatonic >= 0.9, `Only ${pct(diatonic)} of chords are in key; keep at least 90% diatonic.`);
  } else {
    rule(
      hard,
      'progression',
      false,
      'The song has no chord progression, so the bass and melody have nothing to follow.',
    );
  }

  // ---- chords actually chosen (v2 seed songs start with a placeholder)
  const progressions = song.progressions ?? {};
  const placeholders = (song.sections ?? [])
    .filter((sec) => progressions[sec.progression]?.placeholder)
    .map((sec) => sec.name);
  if (song.progressions) {
    rule(
      hard,
      'chords_chosen',
      placeholders.length === 0,
      `Nobody has chosen the chords yet: ${list(placeholders)} still use the starting placeholder progression.`,
    );
    const distinct = new Set(chords.map((c) => c.symbol));
    if (genreName !== 'techno') {
      rule(
        soft,
        'harmony_moves',
        distinct.size >= 2,
        `The harmony never moves: the whole song sits on ${[...distinct][0] ?? 'one chord'}.`,
      );
    }
  }

  // ---- bass on the root
  const bassTracks = tracksByRole(perf, 'bass');
  if (chords.length && bassTracks.length) {
    let checked = 0;
    let onRoot = 0;
    const misses = [];
    for (const c of chords) {
      const first = bassTracks
        .flatMap(([, tr]) => tr.notes)
        .filter((n) => n.t >= c.t - 0.02 && n.t < c.t + c.d)
        .sort((a, b) => a.t - b.t)[0];
      if (!first) continue;
      checked++;
      if (first.m % 12 === c.rootPc) onRoot++;
      else if (misses.length < 3) misses.push(barOf(c.t));
    }
    if (checked) {
      rule(
        hard,
        'bass_root',
        onRoot / checked >= 0.9,
        `The bass starts on the chord's root in only ${pct(onRoot / checked)} of chord changes (bars ${misses.join(', ')}...); aim for 90%.`,
      );
    }
  }

  // ---- melody on chord tones
  const leadNotes = tracksByRole(perf, 'lead').flatMap(([, tr]) => tr.notes);
  if (chords.length && leadNotes.length) {
    // on-beat notes: within a few hundredths of a beat of a quarter-note position (humanizing nudges them)
    const strong = leadNotes.filter((n) => Math.abs(n.t - Math.round(n.t)) < 0.05);
    let fit = 0;
    for (const n of strong) {
      const c = chords.find((ch) => n.t >= ch.t - 0.05 && n.t < ch.t + ch.d);
      if (c && c.pcs.includes(n.m % 12)) fit++;
    }
    if (strong.length) {
      rule(
        hard,
        'melody_fits',
        fit / strong.length >= 0.7,
        `Only ${pct(fit / strong.length)} of the hook's on-beat notes are chord tones; aim for 70% so it sits on the harmony.`,
      );
    }
  }

  // ---- form
  rule(
    hard,
    'sections',
    sections.length >= 4,
    `Only ${sections.length} sections. A song needs at least 4 (intro, main, contrast, ending).`,
  );
  const allowedBars = new Set([4, ...genre.sectionBars]);
  const oddSections = sections.filter((s) => !allowedBars.has(s.bars));
  rule(
    hard,
    'phrase_lengths',
    oddSections.length === 0,
    `Section lengths should be ${[...allowedBars].join(', ')} bars; ${oddSections.map((s) => `'${s.name}' is ${s.bars}`).join(', ')}.`,
  );
  rule(
    hard,
    'duration',
    seconds >= genre.duration[0] && seconds <= genre.duration[1],
    `The song lasts ${fmtTime(perf.totalBeats, perf.bpm)}; a ${genreName} track should run ${fmtTime((genre.duration[0] * perf.bpm) / 60, perf.bpm)}-${fmtTime((genre.duration[1] * perf.bpm) / 60, perf.bpm)}.`,
  );

  // ---- change over time: compare consecutive 8-bar windows. A window "changes" if
  // its parts, their density or register, the section variants or automation differ
  // from the previous one, or if the previous window ended on a drum fill.
  const playAt = (t) => perf.sections.find((s) => t >= s.startBeat && t < s.startBeat + s.bars * BAR)?.play ?? [];
  const windows = [];
  for (let t = 0; t < perf.totalBeats; t += 8 * BAR) {
    const ids = activeTracks(perf, t, t + 8 * BAR).sort();
    const shape = ids.map((id) => {
      const ns = perf.tracks[id].notes.filter((x) => x.t >= t && x.t < t + 8 * BAR);
      const register = Math.round(ns.reduce((a, n) => a + n.m, 0) / ns.length / 6);
      return `${Math.round(Math.log2(ns.length + 1) * 2)}@${register}`;
    });
    const automated = (perf.automation ?? []).some((a) => a.t0 < t + 8 * BAR && a.t1 > t);
    const endsOnFill = (perf.fills ?? []).some((f) => f >= t + 7 * BAR && f < t + 8 * BAR);
    windows.push({ t, endsOnFill, key: `${ids.join(',')}|${shape.join(',')}|${automated}|${playAt(t).join(',')}` });
  }
  const introEnd = sections[0] ? sections[0].t1 : 0;
  const stale = [];
  for (let i = 1; i < windows.length; i++) {
    if (windows[i].t < introEnd) continue;
    if (windows[i].key === windows[i - 1].key && !windows[i - 1].endsOnFill) stale.push(barOf(windows[i - 1].t));
  }
  rule(
    hard,
    'keeps_changing',
    stale.length === 0,
    `Nothing changes for 16 bars starting at bar ${stale.slice(0, 3).join(', bar ')}. Add, drop or vary a part, or put a fill at bar 8.`,
  );

  // ---- energy shape
  const count = (s) => activeTracks(perf, s.t0, s.t1).filter((id) => !id.startsWith('_')).length;
  const peaks = sections.filter((s) => s.isPeak);
  const lowest = body.length ? Math.min(...body.map(count)) : 0;
  if (peaks.length) {
    const peakSize = Math.max(...peaks.map(count));
    rule(
      hard,
      'peak_size',
      peakSize >= genre.peakMin && peakSize >= lowest + 2,
      `The biggest section has only ${peakSize} parts playing (need ${genre.peakMin}+, and 2 more than the quietest section's ${lowest}).`,
    );
  } else {
    rule(
      hard,
      'has_peak',
      false,
      'No section is marked as the high point (name it drop, peak or chorus, or give it energy 4-5).',
    );
  }
  if (sections[0]) {
    const intro = count(sections[0]);
    rule(
      hard,
      'intro_size',
      intro <= genre.introMax,
      `The intro starts with ${intro} parts; start with ${genre.introMax} or fewer and build.`,
    );
  }
  for (const s of sections.filter((x) => x.isLow)) {
    const kickIn = Object.values(perf.tracks).some((tr) =>
      tr.notes.some((n) => n.m === KICK && tr.role === 'drums' && n.t >= s.t0 && n.t < s.t1),
    );
    const drop = peaks.length ? Math.max(...peaks.map(count)) - count(s) : 2;
    rule(
      hard,
      `breakdown_${s.name}`,
      !kickIn || drop >= 2,
      `The '${s.name}' keeps the kick and nearly everything else; a breakdown should drop the kick or at least two parts.`,
    );
  }

  // ---- transitions into each peak
  for (const s of peaks) {
    // only entering a peak from a quieter section needs announcing
    if (s.index === 0 || sections[s.index - 1].isPeak) continue;
    const t = s.t0;
    const device = Object.values(perf.tracks).some(
      (tr) =>
        (tr.role === 'fx' && tr.notes.some((n) => n.t < t && n.t + n.d >= t - 0.5)) ||
        tr.notes.some((n) => n.m === DRUM_NOTES.crash && Math.abs(n.t - t) < 0.05),
    );
    rule(
      hard,
      `transition_${s.name}`,
      device,
      `Nothing announces the '${s.name}' at bar ${barOf(t)}; add a riser, snare roll, sweep or gap before it.`,
    );
  }

  // ---- soft rules
  const firstLead = leadNotes.length ? Math.min(...leadNotes.map((n) => n.t)) : Infinity;
  rule(
    soft,
    'hook_early',
    barOf(firstLead) <= genre.hookBy,
    `The hook first appears at bar ${barOf(firstLead)}; in ${genreName} it should arrive by bar ${genre.hookBy}.`,
  );
  const hats = Object.values(perf.tracks).flatMap((tr) => tr.notes.filter((n) => n.m === CLOSED_HAT));
  if (hats.length > 8) {
    const mean = hats.reduce((a, n) => a + n.v, 0) / hats.length;
    const sd = Math.sqrt(hats.reduce((a, n) => a + (n.v - mean) ** 2, 0) / hats.length);
    rule(
      soft,
      'hat_dynamics',
      sd >= 8,
      `The hi-hats all hit at the same volume (spread ${sd.toFixed(1)}); vary them so the groove breathes.`,
    );
  }
  if (song.swing !== undefined) {
    rule(
      soft,
      'swing',
      song.swing >= genre.swing[0] && song.swing <= genre.swing[1],
      `Swing ${song.swing}% is unusual for ${genreName} (${genre.swing.join('-')}%).`,
    );
  }
  if (leadNotes.length) {
    const ms = leadNotes.map((n) => n.m);
    const range = Math.max(...ms) - Math.min(...ms);
    rule(soft, 'lead_range', range <= 24, `The lead spans ${range} semitones; keep phrases within about two octaves.`);
  }

  // A failing convention that a character broke on purpose doesn't fail the song.
  const breaks = new Map((song.breaks ?? []).map((b) => [b.rule, b]));
  for (const r of hard) {
    r.kind = FLOOR.has(r.id) ? 'floor' : 'convention';
    if (!r.ok && r.kind === 'convention' && breaks.has(r.id)) {
      const { by, because } = breaks.get(r.id);
      r.broken = { by, because };
    }
  }
  const failed = hard.filter((r) => !r.ok && !r.broken);
  const broken = hard.filter((r) => r.broken).map((r) => ({ rule: r.id, ...r.broken, message: r.message }));
  return {
    pass: failed.length === 0,
    hard,
    soft,
    broken,
    stats: { seconds: Math.round(seconds), bars: perf.totalBeats / BAR, sections: sections.length, roleCoverage },
    summary: failed.length
      ? `Not finished: ${failed.length} rule${failed.length > 1 ? 's' : ''} failing. ${failed.map((r) => r.message).join(' ')}`
      : `All ${hard.length} hard rules pass${broken.length ? ` (${broken.length} broken on purpose)` : ''}.${
          soft.some((r) => !r.ok)
            ? ` Notes: ${soft
                .filter((r) => !r.ok)
                .map((r) => r.message)
                .join(' ')}`
            : ''
        }`,
  };
}
