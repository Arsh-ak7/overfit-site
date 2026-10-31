/**
 * The public league: bring-your-own-agent play through pull requests.
 *
 * A league session is plain data in the public repository, so anyone can take part
 * with nothing but a GitHub account and their own agent. Nobody runs a server and
 * nobody pays for a model: every seat is a guest, played by the person who claimed it.
 *
 *   league/<session>/session.json            band, genre, key, tempo, rounds, brief
 *   league/<session>/seats/<seat>.json       a guest character and the GitHub login playing it
 *   league/<session>/moves/<NNN>.json        one move: { as, tool, args, note, intent }
 *
 * The data is replayed through the same rules as every other session, from scratch,
 * every time. That makes a pull request easy to judge: the replay must succeed, and the
 * pull request may only add one thing (a session, a seat or the next move) that its
 * author is allowed to add.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { GENRES } from '../score/library.mjs';
import { appendEvent, runDir } from '../session/log.mjs';
import {
  createSession,
  finalizeSession,
  loadCast,
  loadState,
  renderTurnNumber,
  seatGuests,
  submitTurn,
} from '../session/service.mjs';

export class LeagueError extends Error {
  name = 'LeagueError';
}

export const LIMITS = Object.freeze({
  fileBytes: 8 * 1024,
  rounds: 8,
  openSessionsPerPlayer: 2,
  repairTurns: 3,
});

const BANDS = { overfit: 'overfit-v2', 'dead-air': 'dead-air' };
const SEATS = ['harmony', 'rhythm', 'arrangement'];
const SESSION_ID = /^[a-z0-9][a-z0-9-]{2,30}$/;
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^[A-Z][A-Za-z0-9 _-]{1,23}$/;
const HAS_LINK = /https?:\/\/|www\.|\.(com|net|org|io|ai|xyz)\b/i;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const noLinks = (s) => !HAS_LINK.test(s);
const login = z.string().regex(GITHUB_LOGIN, 'must be a GitHub login');

const SessionFile = z.strictObject({
  band: z.enum(Object.keys(BANDS)),
  name: z.string().regex(NAME, 'band names start with a capital letter: 2-24 letters, digits, spaces, _ or -'),
  genre: z.enum(Object.keys(GENRES)),
  key: z.string().regex(/^[A-G][#b]?$/),
  mode: z.enum(['minor', 'major', 'dorian', 'mixolydian', 'phrygian']),
  bpm: z.number().int().min(60).max(180),
  rounds: z.number().int().min(1).max(LIMITS.rounds),
  brief: z.string().max(400).refine(noLinks, 'no links').default(''),
  opened_by: login,
});

const SeatFile = z.strictObject({
  player: login,
  name: z.string(),
  role: z.string().max(40).optional(),
  taste: z.string(),
  anti_taste: z.string(),
  flaw: z.string(),
});

const MoveFile = z.strictObject({
  as: z.string(),
  tool: z.string(),
  args: z.record(z.string(), z.unknown()),
  note: z.string(),
  intent: z.string(),
});

const PATTERNS = [
  { kind: 'session', re: /^league\/([a-z0-9-]+)\/session\.json$/ },
  { kind: 'seat', re: /^league\/([a-z0-9-]+)\/seats\/(harmony|rhythm|arrangement)\.json$/ },
  { kind: 'move', re: /^league\/([a-z0-9-]+)\/moves\/(\d{3})\.json$/ },
];

/** What a repository path is, or null when it isn't a league data file. */
export function classifyPath(file) {
  for (const { kind, re } of PATTERNS) {
    const m = re.exec(file);
    if (m && SESSION_ID.test(m[1])) {
      return {
        kind,
        session: m[1],
        seat: kind === 'seat' ? m[2] : undefined,
        number: kind === 'move' ? Number(m[2]) : undefined,
      };
    }
  }
  return null;
}

/** Parse untrusted JSON: size-limited, and no keys that could reach an object prototype. */
function readJson(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile()) throw new LeagueError(`${file} must be a plain file, not a link or folder.`);
  if (stat.size > LIMITS.fileBytes) {
    throw new LeagueError(`${file} is ${stat.size} bytes; the limit is ${LIMITS.fileBytes}.`);
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'), (key, value) => {
      if (FORBIDDEN_KEYS.has(key)) throw new LeagueError(`'${key}' isn't allowed as a key.`);
      return value;
    });
  } catch (error) {
    if (error instanceof LeagueError) throw new LeagueError(`${file}: ${error.message}`);
    throw new LeagueError(`${file} isn't valid JSON: ${error.message}`);
  }
}

function parse(schema, file) {
  const result = schema.safeParse(readJson(file));
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(file)'}: ${i.message}`).join('; ');
    throw new LeagueError(`${file}: ${issues}`);
  }
  return result.data;
}

/** Read one session's files. Every file in the folder must be a known league file. */
export function readSession(root, id) {
  if (!SESSION_ID.test(id)) {
    throw new LeagueError(`'${id}' isn't a valid session id: 3-31 lower-case letters, digits and -.`);
  }
  const dir = path.join(root, 'league', id);
  for (const file of walk(dir)) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    if (!classifyPath(rel)) {
      throw new LeagueError(`${rel} isn't a league file. Allowed: session.json, seats/<seat>.json, moves/NNN.json.`);
    }
  }
  const session = parse(SessionFile, path.join(dir, 'session.json'));
  const [low, high] = GENRES[session.genre].bpm;
  if (session.bpm < low || session.bpm > high) {
    throw new LeagueError(
      `league/${id}/session.json: ${session.genre} runs at ${low}-${high} BPM, not ${session.bpm}.`,
    );
  }
  const seats = {};
  for (const seat of SEATS) {
    const file = path.join(dir, 'seats', `${seat}.json`);
    if (fs.existsSync(file)) seats[seat] = parse(SeatFile, file);
  }
  const movesDir = path.join(dir, 'moves');
  const moveFiles = fs.existsSync(movesDir) ? fs.readdirSync(movesDir).sort() : [];
  const moves = moveFiles.map((f, i) => {
    if (f !== `${String(i + 1).padStart(3, '0')}.json`) {
      throw new LeagueError(
        `league/${id}/moves: expected ${String(i + 1).padStart(3, '0')}.json, found ${f}. Moves are numbered 001, 002, ... with no gaps.`,
      );
    }
    return parse(MoveFile, path.join(movesDir, f));
  });
  return { id, session, seats, moves };
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

export function listSessions(root) {
  const dir = path.join(root, 'league');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

export const runIdFor = (id) => `league-${id}`;

/** The band's cast: the house template with every seat filled by its guest. */
function castFor({ session, seats }) {
  const guests = SEATS.filter((s) => seats[s]).map((seat) => {
    const { player: _player, ...character } = seats[seat];
    return { seat, ...character };
  });
  try {
    return { ...seatGuests(loadCast(BANDS[session.band]), guests), band: session.name };
  } catch (error) {
    throw new LeagueError(error.message);
  }
}

/**
 * Replay a session through the rules into a fresh event log. Throws LeagueError on
 * the first move the rules reject, with the rules' own reason.
 * @returns {{ runId: string, state: object, waitingForSeats: string[] }}
 */
export async function replaySession(root, id) {
  const data = readSession(root, id);
  const missing = SEATS.filter((s) => !data.seats[s]);
  const cast = castFor(data);
  const runId = runIdFor(id);
  if (missing.length && data.moves.length) {
    throw new LeagueError(
      `league/${id}: moves can't start until every seat is taken (still open: ${missing.join(', ')}).`,
    );
  }

  fs.rmSync(path.join(runDir(runId), 'events.jsonl'), { force: true });
  const { session } = data;
  createSession(runId, {
    cast,
    condition: 'hearing',
    rounds: session.rounds,
    bpm: session.bpm,
    brief: session.brief,
    score: 2,
    genre: session.genre,
    key: session.key,
    mode: session.mode,
  });

  for (const [i, move] of data.moves.entries()) {
    const file = `league/${id}/moves/${String(i + 1).padStart(3, '0')}.json`;
    const { as, ...submission } = move;
    const result = await submitTurn(runId, as, submission, { render: false });
    if (!result.accepted) throw new LeagueError(`${file} was rejected by the rules: ${result.reason}`);
    openRepairsIfNeeded(runId, result.validator);
  }
  return { runId, data, state: loadState(runId), waitingForSeats: missing };
}

/**
 * When the last regular turn is played and the judge still fails the song, the band
 * gets three repair turns, once. Done here (not at render time) so replays agree.
 */
function openRepairsIfNeeded(runId, validator) {
  const state = loadState(runId);
  if (state.nextAgent === null && state.extraTurns === 0 && validator && !validator.pass) {
    appendEvent(runId, 'session.repair_opened', 'league', { turns: LIMITS.repairTurns, failing: validator.failing });
  }
}

/** Who plays which character, so a move can be checked against its pull request author. */
const playerOf = (data, character) => Object.values(data.seats).find((s) => s.name === character)?.player;

export function sessionStatus({ data, state, waitingForSeats }) {
  const last = state.turns.at(-1);
  return {
    session: data.id,
    band: data.session.name,
    genre: data.session.genre,
    key: `${data.session.key} ${data.session.mode}`,
    bpm: data.session.bpm,
    seats: Object.fromEntries(
      SEATS.map((s) => [s, data.seats[s] ? { name: data.seats[s].name, player: data.seats[s].player } : null]),
    ),
    open_seats: waitingForSeats,
    moves: state.turns.length,
    total_moves: state.meta.rounds * 3 + state.extraTurns,
    next: waitingForSeats.length ? null : state.nextAgent,
    next_player: waitingForSeats.length || !state.nextAgent ? null : playerOf(data, state.nextAgent),
    judge: last?.validator ?? null,
    complete: !waitingForSeats.length && state.nextAgent === null,
  };
}

/** Replay every session. Throws on the first problem. */
export async function checkLeague(root) {
  const statuses = [];
  for (const id of listSessions(root)) statuses.push(sessionStatus(await replaySession(root, id)));
  return statuses;
}

/**
 * Check one pull request's change set. `changes` is `git diff --name-status` output
 * as [{ status, path }]. The rules:
 *   - only league data files, only added (history is never edited or deleted)
 *   - one thing per pull request: a new session (optionally with seats), one seat, or one move
 *   - the author must be the session's opener, the seat's player, or the moving character's player
 *   - after the change the whole league must still replay
 * @returns {Promise<{ summary: string, statuses: object[] }>}
 */
export async function checkChange(root, { author, changes }) {
  if (!GITHUB_LOGIN.test(author ?? '')) throw new LeagueError('Unknown pull request author.');
  if (!changes.length) throw new LeagueError('This pull request changes nothing.');
  // Maintenance (code, workflows, Dependabot) isn't a league move: nothing to judge here,
  // and branch protection still requires the maintainer's review. Mixed pull requests fail below.
  if (!changes.some((c) => c.path.startsWith('league/'))) {
    return {
      summary:
        "doesn't touch the league, so there's nothing to judge. It needs the maintainer's review like any code change",
      statuses: await checkLeague(root),
    };
  }
  const files = changes.map(({ status, path: file }) => {
    const info = classifyPath(file);
    if (!info) {
      throw new LeagueError(
        `${file}: pull requests may only add league files (league/<session>/session.json, seats/<seat>.json or moves/NNN.json). Changes to code, workflows or the site go through the maintainer.`,
      );
    }
    if (status !== 'A') {
      throw new LeagueError(
        `${file}: league history is append-only, so files can be added but not changed, renamed or deleted.`,
      );
    }
    return { file, ...info };
  });
  const sessions = new Set(files.map((f) => f.session));
  if (sessions.size !== 1) throw new LeagueError('One session per pull request, please.');
  const [id] = sessions;
  const kinds = files.map((f) => f.kind);
  const opening = kinds.includes('session');
  if (opening ? kinds.some((k) => k === 'move') : files.length !== 1) {
    throw new LeagueError(
      'One thing per pull request: open a session (you may claim seats in the same pull request), claim one seat, or make one move.',
    );
  }

  const statuses = await checkLeague(root);
  const data = readSession(root, id);
  const ownSeats = (author_) =>
    files
      .filter((x) => x.kind === 'seat')
      .forEach((f) => {
        if (data.seats[f.seat].player !== author_) {
          throw new LeagueError(`${f.file}: you can only claim seats for yourself (player must be '${author_}').`);
        }
      });
  const busy = statuses.filter(
    (s) => !s.complete && s.session !== id && Object.values(s.seats).some((x) => x?.player === author),
  );
  const tooBusy = () => {
    if (busy.length >= LIMITS.openSessionsPerPlayer) {
      throw new LeagueError(`You're already playing in ${busy.length} unfinished sessions; finish one first.`);
    }
  };
  let summary;
  if (opening) {
    if (data.session.opened_by !== author) {
      throw new LeagueError(
        `session.json says opened_by '${data.session.opened_by}', but this pull request is from '${author}'.`,
      );
    }
    ownSeats(author);
    tooBusy();
    summary = `opens '${id}' (${data.session.name}, ${data.session.genre} at ${data.session.bpm} BPM)`;
  } else if (kinds[0] === 'seat') {
    if (data.moves.length) throw new LeagueError('This session has started; seats are closed.');
    ownSeats(author);
    tooBusy();
    const { seat } = files[0];
    summary = `${author} takes the ${seat} seat in '${id}' as ${data.seats[seat].name}`;
  } else {
    if (files[0].number !== data.moves.length) {
      throw new LeagueError(
        `Moves are added one at a time, in order: the next move here is ${String(data.moves.length).padStart(3, '0')}.json.`,
      );
    }
    const move = data.moves.at(-1);
    const player = playerOf(data, move.as);
    if (player !== author) throw new LeagueError(`${move.as} is played by '${player ?? 'nobody'}', not '${author}'.`);
    summary = `${move.as} (${author}) plays ${move.tool} in '${id}'`;
  }
  return { summary, statuses };
}

/**
 * After a merge: replay every session, render the newest move of each (and the
 * master once a song is complete) into outDir/<session>/, and write outDir/league.json.
 * Existing audio is kept, so a re-run only renders what's new.
 */
export async function applyLeague(root, { outDir, render = true, log = () => {} }) {
  const feed = [];
  for (const id of listSessions(root)) {
    const replay = await replaySession(root, id);
    const status = sessionStatus(replay);
    const dir = path.join(outDir, id);
    fs.mkdirSync(dir, { recursive: true });
    const audio = {};
    const n = replay.state.turns.length;
    if (render && n) {
      const name = `turn_${String(n).padStart(3, '0')}.mp3`;
      if (!fs.existsSync(path.join(dir, name))) {
        log(`rendering ${id} move ${n}`);
        const r = await renderTurnNumber(replay.runId, n);
        if (r.file) {
          // Keep only the newest preview, so the public repository doesn't grow with every move.
          for (const old of fs.readdirSync(dir).filter((f) => f.startsWith('turn_'))) fs.rmSync(path.join(dir, old));
          fs.copyFileSync(path.join(runDir(replay.runId), r.file), path.join(dir, name));
        }
      }
    }
    if (render && status.complete && !fs.existsSync(path.join(dir, 'final.mp3'))) {
      log(`mastering ${id}`);
      const result = await finalizeSession(replay.runId);
      if (result.finalized !== false) {
        fs.copyFileSync(path.join(runDir(replay.runId), 'audio', 'final.mp3'), path.join(dir, 'final.mp3'));
      }
    }
    for (const f of fs
      .readdirSync(dir)
      .filter((x) => x.endsWith('.mp3'))
      .sort()) {
      audio[f.replace('.mp3', '')] = `${id}/${f}`;
    }
    feed.push({
      ...status,
      brief: replay.data.session.brief,
      characters: replay.state.meta.cast.agents.map(({ name, role, territories, taste, anti_taste, flaw }) => ({
        name,
        role,
        seat: territories[0],
        taste,
        anti_taste,
        flaw,
      })),
      log: replay.state.turns.map((t, i) => ({
        move: i + 1,
        by: t.agent,
        tool: t.tool,
        summary: t.summary,
        note: t.note,
        intent: t.intent,
        judge: t.validator,
      })),
      audio,
    });
  }
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, 'league.json'),
    `${JSON.stringify({ updated: new Date().toISOString(), sessions: feed }, null, 1)}\n`,
  );
  return feed;
}
