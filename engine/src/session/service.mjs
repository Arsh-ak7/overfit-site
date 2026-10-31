/**
 * Session use-cases: create, show, take a turn, finalize. The CLI and tests call
 * these; they compose the log, projection, rules, view and render pipeline.
 */
import fs from 'node:fs';
import path from 'node:path';
import { isSubmissionError } from '../errors.mjs';
import { PATHS } from '../paths.mjs';
import { appendEvent, readLog, runDir, runExists } from './log.mjs';
import { produceAndHear, renderAndHear } from './pipeline.mjs';
import { project } from './projection.mjs';
import { applyTurnV2, seedSong } from './rules-v2.mjs';
import { applyTurn, initialSong } from './rules.mjs';
import { agentViewV2 } from './view-v2.mjs';
import { agentView } from './view.mjs';

const REPAIR_TURNS = 3;
const isV2 = (state) => state.meta.scoreVersion === 2;

const CONDITIONS = new Set(['hearing', 'deaf']);

export const loadState = (runId) => project(readLog(runId));

export function readHistory() {
  return fs.existsSync(PATHS.history) ? JSON.parse(fs.readFileSync(PATHS.history, 'utf8')) : [];
}

/** @param {string} name e.g. "overfit" @returns {import('../types.mjs').Cast} */
export function loadCast(name) {
  return JSON.parse(fs.readFileSync(path.join(PATHS.casts, `${name}.json`), 'utf8'));
}

/**
 * @param {string} runId
 * @param {{ cast: import('../types.mjs').Cast, condition: string, rounds: number, bpm: number,
 *           brief?: string, forbiddenBpm?: [number, number] }} options
 */
const GUEST_NAME = /^[A-Z][A-Za-z0-9 _-]{1,23}$/;
const GUEST_TEXT_MAX = 160;
const HAS_LINK = /https?:\/\/|www\.|\.(com|net|org|io|ai|xyz)\b/i;

/**
 * Seat guest characters (other people's agents) in a band. Each guest replaces the
 * house character that owns the same territory, keeps that territory, and brings
 * its own name and personality. Text is length-limited and may not contain links.
 * @param {import('../types.mjs').Cast} cast
 * @param {{ seat: string, name: string, role?: string, taste: string, anti_taste: string, flaw: string }[]} guests
 */
export function seatGuests(cast, guests = []) {
  const seated = structuredClone(cast);
  const names = new Set(seated.agents.map((a) => a.name));
  for (const guest of guests) {
    const index = seated.agents.findIndex((a) => a.territories.includes(guest.seat));
    if (index < 0) {
      throw new Error(`No '${guest.seat}' seat in ${cast.band}; seats are harmony, rhythm and arrangement.`);
    }
    if (seated.agents[index].guest) throw new Error(`The ${guest.seat} seat already has a guest.`);
    if (!GUEST_NAME.test(guest.name ?? '')) {
      throw new Error('Guest names start with a capital letter: 2-24 letters, digits, spaces, _ or -.');
    }
    names.delete(seated.agents[index].name);
    if (names.has(guest.name)) throw new Error(`'${guest.name}' is already in the band.`);
    for (const field of ['taste', 'anti_taste', 'flaw']) {
      const text = String(guest[field] ?? '').trim();
      if (text.length < 3 || text.length > GUEST_TEXT_MAX) {
        throw new Error(`Guest ${field} must be 3-${GUEST_TEXT_MAX} characters.`);
      }
      if (HAS_LINK.test(text)) throw new Error(`Guest ${field} can't contain links.`);
    }
    seated.agents[index] = {
      name: guest.name,
      role: String(guest.role ?? seated.agents[index].role).slice(0, 40),
      territories: seated.agents[index].territories,
      taste: guest.taste.trim(),
      anti_taste: guest.anti_taste.trim(),
      flaw: guest.flaw.trim(),
      guest: true,
    };
    names.add(guest.name);
  }
  return seated;
}

export function createSession(
  runId,
  { cast, condition, rounds, bpm, brief = '', forbiddenBpm, score = 1, genre, key, mode },
) {
  if (runExists(runId)) throw new Error(`Run '${runId}' already exists.`);
  if (!CONDITIONS.has(condition)) throw new Error(`condition must be one of: ${[...CONDITIONS].join(', ')}`);
  if (!Number.isInteger(rounds) || rounds < 1) throw new Error('rounds must be a positive integer');
  const initial = score === 2 ? seedSong({ title: runId, genre, key, mode, bpm }) : initialSong(runId, bpm);
  return appendEvent(runId, 'session.created', 'operator', {
    cast,
    condition,
    rounds,
    brief,
    scoreVersion: score,
    forbidden: forbiddenBpm ? { bpm: forbiddenBpm } : {},
    initialSong: initial,
  });
}

export function describeForAgent(runId, agentName, { submitHint } = {}) {
  const state = loadState(runId);
  return isV2(state)
    ? agentViewV2(state, agentName, { runId, submitHint })
    : agentView(state, agentName, { runId, history: readHistory() });
}

/**
 * Validate a submission, log the outcome, and render if it was accepted.
 * Submission errors are logged as turn.rejected and returned, not thrown, so the
 * agent can read the reason and try again.
 * With { render: false } the move is logged but not rendered; call renderTurnNumber
 * later (the agent connector does this in the background, since a render takes minutes).
 * @returns {Promise<{ accepted: true, turn: number, kind: string, target: string|null, render: object|null, pruned: string[] }
 *                  | { accepted: false, reason: string }>}
 */
export async function submitTurn(runId, agentName, submission, { render: shouldRender = true } = {}) {
  const state = loadState(runId);
  let result;
  try {
    result = isV2(state) ? applyTurnV2(state, agentName, submission) : applyTurn(state, agentName, submission);
  } catch (error) {
    if (!isSubmissionError(error)) throw error;
    appendEvent(runId, 'turn.rejected', agentName, { reason: error.message, submitted: submission });
    return { accepted: false, reason: error.message };
  }
  appendEvent(runId, 'turn.accepted', agentName, result);
  const turn = state.turns.length + 1;
  const render = shouldRender ? await renderTurn(runId, state, turn, result.songAfter) : null;
  return {
    accepted: true,
    turn,
    kind: result.kind ?? result.tool,
    target: result.target ?? result.summary,
    render,
    pruned: result.pruned ?? [],
    validator: render?.validator ?? result.validator,
  };
}

/**
 * Render a turn and log the result. A renderer failure is our bug, not the agent's:
 * it's logged as a render error (so the log stays consistent) and rethrown.
 */
async function renderTurn(runId, state, turn, song) {
  const label = `turn_${String(turn).padStart(2, '0')}`;
  try {
    const render = isV2(state) ? await produceAndHear(runId, label, song) : await renderAndHear(runId, label, song);
    appendEvent(runId, 'render', 'renderer', { turn, ...render });
    return render;
  } catch (error) {
    appendEvent(runId, 'render', 'renderer', { turn, label, error: String(error.message ?? error).slice(0, 2000) });
    throw error;
  }
}

/** Render the song exactly as it stood after accepted turn n (1-based). */
export async function renderTurnNumber(runId, n) {
  const events = readLog(runId);
  const accepted = events.filter((e) => e.type === 'turn.accepted');
  if (n < 1 || n > accepted.length) throw new Error(`Run '${runId}' has no turn ${n}.`);
  return renderTurn(runId, project(events), n, accepted[n - 1].data.songAfter);
}

/** Re-render the latest accepted turn, e.g. after fixing a renderer bug. */
export async function rerenderLatest(runId) {
  const state = loadState(runId);
  if (!state.turns.length) throw new Error(`Run '${runId}' has no turns to render.`);
  return renderTurn(runId, state, state.turns.length, state.song);
}

function summarize(runId, state, render) {
  const byKind = {};
  for (const t of state.turns) byKind[t.kind] = (byKind[t.kind] ?? 0) + 1;
  const added = new Set(state.turns.filter((t) => t.kind === 'add').map((t) => t.target));
  return {
    session: runId,
    condition: state.meta.condition,
    rounds: state.meta.rounds,
    accepted_turns: state.turns.length,
    rejected_submissions: state.rejected.length,
    by_kind: byKind,
    layers_final: state.song.layers.map((l) => `${l.id}:${l.instrument}:${l.owner}`),
    layers_added: added.size,
    layers_surviving_from_adds: state.song.layers.filter((l) => added.has(l.id)).length,
    render_ms_per_turn: state.renders.map((r) => r.timing_ms.total),
    final: {
      audio_seconds: render.audio_seconds,
      timing_ms: render.timing_ms,
      ledger: render.report?.ledger,
      key_heard: render.report?.mix.key_heard,
    },
  };
}

/** Render the final master, write the summary files and append to history. */
export async function finalizeSession(runId) {
  const state = loadState(runId);
  if (state.finalized) throw new Error(`Run '${runId}' is already finalized.`);
  if (isV2(state)) return finalizeV2(runId, state);
  const render = await renderAndHear(runId, 'final', state.song, { final: true });
  const summary = summarize(runId, state, render);
  appendEvent(runId, 'session.finalized', 'operator', { summary, render });

  const dir = runDir(runId);
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 1));
  fs.writeFileSync(path.join(dir, 'song.json'), JSON.stringify(state.song, null, 1));
  const history = readHistory();
  history.push({
    session: runId,
    bpm: state.song.bpm,
    key_heard: render.report?.mix.key_heard,
    instruments: [...new Set(state.song.layers.map((l) => l.instrument))],
  });
  fs.writeFileSync(PATHS.history, JSON.stringify(history, null, 1));
  return summary;
}

/**
 * v2: the validator is the referee. A failing song gets REPAIR_TURNS more turns
 * (once); after that it is finalized anyway, with the failures on record.
 */
async function finalizeV2(runId, state) {
  const render = await produceAndHear(runId, 'final', state.song, { final: true });
  const repairs = state.extraTurns > 0;
  if (!render.validator.pass && !repairs) {
    appendEvent(runId, 'session.repair_opened', 'operator', { turns: REPAIR_TURNS, failing: render.validator.failing });
    return { finalized: false, repairTurns: REPAIR_TURNS, failing: render.validator.failing };
  }
  const byTool = {};
  for (const t of state.turns) byTool[t.tool] = (byTool[t.tool] ?? 0) + 1;
  const summary = {
    session: runId,
    condition: state.meta.condition,
    accepted_turns: state.turns.length,
    rejected_submissions: state.rejected.length,
    deletes: state.turns.filter((t) => t.destructive).length,
    by_tool: byTool,
    parts_final: Object.entries(state.song.parts).map(([id, p]) => `${id}:${p.role}:${p.sound}`),
    validator: render.validator,
    master: render.master,
    render_ms_per_turn: state.renders.map((r) => r.timing_ms.total),
    final: { audio_seconds: render.audio_seconds, timing_ms: render.timing_ms },
  };
  appendEvent(runId, 'session.finalized', 'operator', { summary, render });
  const dir = runDir(runId);
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 1));
  fs.writeFileSync(path.join(dir, 'song.json'), JSON.stringify(state.song, null, 1));
  return { finalized: true, ...summary };
}
