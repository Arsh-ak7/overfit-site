/**
 * Every filesystem location the spike uses, resolved once from the package root.
 * Nothing else in the codebase builds paths from `import.meta.url`.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// MUSIC_RUNS_DIR lets tests write sessions somewhere disposable.
const RUNS = process.env.MUSIC_RUNS_DIR ? path.resolve(process.env.MUSIC_RUNS_DIR) : path.join(ROOT, 'runs');

export const PATHS = Object.freeze({
  root: ROOT,
  samples: path.join(ROOT, 'assets', 'samples', 'vcsl'),
  casts: path.join(ROOT, 'assets', 'cast'),
  runs: RUNS,
  history: path.join(RUNS, 'history.json'),
  results: path.join(ROOT, 'results'),
  out: path.join(ROOT, 'out'),
  hearScript: path.join(ROOT, 'src', 'hearing', 'hear.py'),
  studioScript: path.join(ROOT, 'src', 'studio', 'render.py'),
});
