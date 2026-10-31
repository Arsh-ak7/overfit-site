/**
 * Render + hear: turn a song into audio files and Ledger's DSP report.
 *
 * Working files (WAV mix and stems) go to out/<run>/<label>/ and are disposable.
 * Kept files (MP3 previews and the final) go to runs/<run>/audio/.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { renderToFile } from '../engine/node-env.mjs';
import { analyze } from '../score/analyze.mjs';
import { derive } from '../score/derive.mjs';
import { PATHS } from '../paths.mjs';
import { encodeMp3 } from '../util/ffmpeg.mjs';
import { runDir } from './log.mjs';

const STEM_SAMPLE_RATE = 22050; // analysis only; halves stem render time

/** Run src/hearing/hear.py and parse its JSON report. */
function hear(songPath, mixPath, stemDir) {
  const args = ['-I', PATHS.hearScript, songPath, mixPath];
  if (stemDir) args.push(stemDir);
  return JSON.parse(execFileSync('python3', args, { maxBuffer: 1 << 24 }).toString());
}

/**
 * @param {string} runId
 * @param {string} label            e.g. "turn_03" or "final"
 * @param {import('../types.mjs').Song} song
 * @param {{ final?: boolean }} [options] final: keep a full-quality MP3 instead of a preview
 * @returns {Promise<object>} the payload logged as a `render` event
 */
export async function renderAndHear(runId, label, song, { final = false } = {}) {
  const work = path.join(PATHS.out, runId, label);
  fs.mkdirSync(work, { recursive: true });
  const started = Date.now();

  const mix = await renderToFile(song, path.join(work, 'mix.wav'));

  let stemsMs = 0;
  let hearingMs = 0;
  let report = null;
  if (song.layers.length) {
    const stemDir = path.join(work, 'stems');
    const stemsStarted = Date.now();
    for (const layer of song.layers) {
      await renderToFile(song, path.join(stemDir, `${layer.id}.wav`), { solo: layer.id, sampleRate: STEM_SAMPLE_RATE });
    }
    stemsMs = Date.now() - stemsStarted;

    const songPath = path.join(work, 'song.json');
    fs.writeFileSync(songPath, JSON.stringify(song));
    const hearingStarted = Date.now();
    report = hear(songPath, mix.wavPath, stemDir);
    hearingMs = Date.now() - hearingStarted;
  }

  const audioDir = path.join(runDir(runId), 'audio');
  fs.mkdirSync(audioDir, { recursive: true });
  const kept = path.join(audioDir, final ? 'final.mp3' : `${label}.mp3`);
  encodeMp3(mix.wavPath, kept, final ? 'master' : 'preview');

  return {
    label,
    file: path.relative(runDir(runId), kept),
    audio_seconds: Math.round(mix.seconds * 10) / 10,
    events: mix.notes,
    timing_ms: { mix: mix.renderMs, stems: stemsMs, hearing: hearingMs, total: Date.now() - started },
    report,
  };
}

// ---------------------------------------------------------------- score v2

/** Derive, render with the studio, master, hear and validate a v2 song. */
export async function produceAndHear(runId, label, song, { final = false } = {}) {
  const work = path.join(PATHS.out, runId, label);
  fs.mkdirSync(work, { recursive: true });
  const started = Date.now();

  const performance = derive(song);
  const validator = analyze(performance, song);
  const verdict = {
    pass: validator.pass,
    failing: validator.hard.filter((r) => !r.ok && !r.broken).map((r) => r.message),
    broken: validator.broken.map(({ rule, by, because }) => ({ rule, by, because })),
    soft: validator.soft.filter((r) => !r.ok).map((r) => r.message),
  };
  if (!Object.values(performance.tracks).some((t) => t.notes.length)) {
    return { label, file: null, silent: true, timing_ms: { total: Date.now() - started }, validator: verdict };
  }
  const perfPath = path.join(work, 'performance.json');
  fs.writeFileSync(perfPath, JSON.stringify(performance));
  const studio = JSON.parse(
    execFileSync('python3', ['-I', PATHS.studioScript, perfPath, work], { maxBuffer: 1 << 24 })
      .toString()
      .trim()
      .split('\n')
      .at(-1),
  );
  const masterPath = path.join(work, 'master.wav');

  const songPath = path.join(work, 'song.json');
  fs.writeFileSync(
    songPath,
    JSON.stringify({ bpm: song.bpm, sections: song.sections.map(({ name, bars }) => ({ name, bars })) }),
  );
  const hearingStarted = Date.now();
  const report = hear(songPath, masterPath, null);
  const hearingMs = Date.now() - hearingStarted;

  const audioDir = path.join(runDir(runId), 'audio');
  fs.mkdirSync(audioDir, { recursive: true });
  const kept = path.join(audioDir, final ? 'final.mp3' : `${label}.mp3`);
  encodeMp3(masterPath, kept, final ? 'master' : 'preview');

  return {
    label,
    file: path.relative(runDir(runId), kept),
    audio_seconds: studio.seconds,
    timing_ms: { studio: Math.round(studio.timing_s.total * 1000), hearing: hearingMs, total: Date.now() - started },
    master: studio.master,
    report,
    validator: verdict,
  };
}
