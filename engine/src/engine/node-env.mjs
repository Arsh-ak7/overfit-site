/** Node bindings for the renderer: sample loading from disk and WAV/MP3 output. */
import fs from 'node:fs';
import path from 'node:path';
import { OfflineAudioContext } from 'node-web-audio-api';
import { PATHS } from '../paths.mjs';
import { encodeMp3 } from '../util/ffmpeg.mjs';
import { SAMPLE_SETS } from './catalog.mjs';
import { renderSong } from './render.mjs';
import { validateSong } from './validate.mjs';
import { encodeWav } from './wav.mjs';

const fileCache = new Map();

/** @type {import('./render.mjs').RenderEnv} */
export const nodeEnv = {
  OfflineAudioContext,
  async getSample(ctx, instrument, key) {
    const file = path.join(PATHS.samples, SAMPLE_SETS[instrument].dir, `${key}.wav`);
    if (!fileCache.has(file)) fileCache.set(file, fs.readFileSync(file));
    const bytes = fileCache.get(file);
    return ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  },
};

/**
 * Validate, render and write a song to disk.
 * @param {import('../types.mjs').Song} song
 * @param {string} wavPath
 * @param {import('./render.mjs').RenderOptions & { mp3?: boolean }} [options]
 */
export async function renderToFile(song, wavPath, options = {}) {
  validateSong(song);
  const started = performance.now();
  const { buffer, seconds, notes } = await renderSong(song, nodeEnv, options);
  const renderMs = Math.round(performance.now() - started);
  fs.mkdirSync(path.dirname(wavPath), { recursive: true });
  fs.writeFileSync(wavPath, encodeWav(buffer));
  let mp3Path = null;
  if (options.mp3) {
    mp3Path = wavPath.replace(/\.wav$/, '.mp3');
    encodeMp3(wavPath, mp3Path);
  }
  return { wavPath, mp3Path, seconds, notes, renderMs };
}
