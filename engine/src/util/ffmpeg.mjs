/** Thin wrapper around the ffmpeg binary for MP3 encoding. */
import { execFileSync } from 'node:child_process';

const PROFILES = Object.freeze({
  /** Stereo VBR, for finished songs. */
  master: ['-codec:a', 'libmp3lame', '-q:a', '2'],
  /** Mono 32 kbps, for per-turn previews: small enough to keep every one. */
  preview: ['-ac', '1', '-ar', '22050', '-codec:a', 'libmp3lame', '-b:a', '32k'],
});

/**
 * @param {string} input  path to a WAV file
 * @param {string} output path of the MP3 to write
 * @param {keyof typeof PROFILES} profile
 */
export function encodeMp3(input, output, profile = 'master') {
  execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-y', '-i', input, ...PROFILES[profile], output]);
}
