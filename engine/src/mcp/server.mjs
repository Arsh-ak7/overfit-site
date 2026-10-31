/**
 * Bring your own agent: an MCP server that lets any MCP-capable agent (Claude,
 * ChatGPT, Cursor, ...) sit in a band seat and play by the same rules as the
 * house characters. It's a thin layer over src/session/service.mjs, so it can't
 * do anything the rules don't allow.
 *
 * Moves are accepted immediately and rendered in the background (a render takes
 * about two minutes; many MCP clients time out after one). Renders for a session
 * run one at a time, in turn order.
 */
import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { GENRES } from '../score/library.mjs';
import { runDir, runExists } from '../session/log.mjs';
import {
  createSession,
  describeForAgent,
  finalizeSession,
  loadCast,
  loadState,
  renderTurnNumber,
  seatGuests,
  submitTurn,
} from '../session/service.mjs';
import { PATHS } from '../paths.mjs';

const BANDS = { overfit: 'overfit-v2', 'dead-air': 'dead-air' };
const SEATS = ['harmony', 'rhythm', 'arrangement'];

const HOW_TO_PLAY = `Synthlings: AI bands write instrumental electronic music together, one move at a time.

How a session works
1. start_session picks a band, genre, key and tempo, and seats your agent (and any friends' agents) as guest characters. Each band has three seats:
   - harmony: key, chord progressions, chord parts, the hook and counter-melodies
   - rhythm: drums, bass and swing
   - arrangement: tempo, song form, transitions, and every part's sound and mix
   Seats without a guest are played by the house character, so someone has to play them: your agent can play several seats.
2. Take turns in order. Call get_turn to see the rules, tools, libraries, the current song and what's still failing, then make_move with exactly one tool call.
3. The judge checks every song. The quality floor (tempo, key, chosen chords, sections, length, a change every 16 bars) must pass. Everything else is a genre convention (a lead, bass on the root, melody on chord tones, a build into each peak...) that a character may break on purpose: add "breaks": [{"rule", "because"}] to a move. Each character has 2 wildcards per song, and viewers see the reason.
4. Moves render in the background; listen returns the latest audio files. finish_song renders the master when you're done.

Rules that matter: one move per turn, only inside your seat's territory, a public note that names what it responds to, a private intent (viewers see it, bandmates don't), no links in any text, and after the build phase one turn in four must remove something.`;

const text = (value) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 1) }],
});
const failure = (message) => ({ content: [{ type: 'text', text: message }], isError: true });

/** Background render queue, one chain per session. */
function createRenderQueue() {
  const chains = new Map();
  const status = new Map();
  return {
    enqueue(runId, turn) {
      status.set(runId, { rendering: turn });
      const next = (chains.get(runId) ?? Promise.resolve())
        .then(() => renderTurnNumber(runId, turn))
        .then(
          () => status.set(runId, { rendered: turn }),
          (error) => status.set(runId, { error: `turn ${turn}: ${error.message}` }),
        );
      chains.set(runId, next);
      return next;
    },
    status: (runId) => status.get(runId) ?? null,
    idle: (runId) => chains.get(runId) ?? Promise.resolve(),
  };
}

function sessionSummary(runId) {
  const state = loadState(runId);
  const total = state.meta.rounds * state.meta.cast.agents.length + (state.extraTurns ?? 0);
  return {
    session: runId,
    band: state.meta.cast.band,
    genre: state.song.genre,
    bpm: state.song.bpm,
    seats: state.meta.cast.agents.map((a) => `${a.name} (${a.territories.join(', ')}${a.guest ? ', guest' : ''})`),
    turn: `${state.turns.length} of ${total}`,
    next: state.nextAgent,
    finished: Boolean(state.finalized),
    judge: state.turns.at(-1)?.validator ?? null,
  };
}

/**
 * @param {{ idPrefix?: string }} [options] idPrefix: prefix for new session ids (tests use it)
 */
export function createMusicServer({ idPrefix = 'byoa' } = {}) {
  const server = new McpServer({ name: 'synthlings', version: '0.1.0' });
  const queue = createRenderQueue();

  server.registerTool(
    'how_to_play',
    {
      title: 'How to play',
      description: 'Explains seats, turns, the judge and the rules. Read this first.',
      inputSchema: {},
    },
    async () => text(HOW_TO_PLAY),
  );

  server.registerTool(
    'list_bands',
    {
      title: 'List bands and genres',
      description: 'The house bands you can sit in, their characters and seats, and the genres with tempo ranges.',
      inputSchema: {},
    },
    async () =>
      text({
        bands: Object.fromEntries(
          Object.entries(BANDS).map(([id, cast]) => {
            const c = loadCast(cast);
            return [
              id,
              {
                band: c.band,
                scene: c.scene,
                seats: c.agents.map((a) => ({ seat: a.territories[0], house: a.name, taste: a.taste })),
              },
            ];
          }),
        ),
        genres: Object.fromEntries(Object.entries(GENRES).map(([g, p]) => [g, { bpm: p.bpm, modes: p.modes }])),
      }),
  );

  server.registerTool(
    'start_session',
    {
      title: 'Start a session',
      description: 'Start a new song with a band. Seat your agent as a guest character in one or more seats.',
      inputSchema: {
        band: z.enum(Object.keys(BANDS)),
        genre: z.enum(Object.keys(GENRES)),
        key: z
          .string()
          .regex(/^[A-G][#b]?$/)
          .describe('Tonic, e.g. A, F#, Bb'),
        mode: z.enum(['minor', 'major', 'dorian', 'mixolydian', 'phrygian']),
        bpm: z.number().int().min(60).max(180),
        brief: z.string().max(400).optional(),
        rounds: z.number().int().min(1).max(10).optional().describe('Each round is one turn per seat; default 7'),
        guests: z
          .array(
            z.object({
              seat: z.enum(SEATS),
              name: z.string(),
              role: z.string().max(40).optional(),
              taste: z.string(),
              anti_taste: z.string(),
              flaw: z.string(),
            }),
          )
          .max(3)
          .describe('Your characters. Each replaces the house character in that seat.'),
      },
    },
    async ({ band, genre, key, mode, bpm, brief, rounds = 7, guests }) => {
      try {
        const cast = seatGuests(loadCast(BANDS[band]), guests);
        const runId = `${idPrefix}-${band}-${Date.now().toString(36)}`;
        createSession(runId, {
          cast,
          condition: 'hearing',
          rounds,
          bpm,
          brief: brief ?? '',
          score: 2,
          genre,
          key,
          mode,
        });
        return text({
          started: runId,
          ...sessionSummary(runId),
          next_step: 'Call get_turn as the agent named in "next".',
        });
      } catch (error) {
        return failure(error.message);
      }
    },
  );

  server.registerTool(
    'list_sessions',
    {
      title: 'List sessions',
      description: 'Sessions on this machine: band, turn, whose turn it is, finished or not.',
      inputSchema: {},
    },
    async () => {
      if (!fs.existsSync(PATHS.runs)) return text([]);
      const ids = fs.readdirSync(PATHS.runs).filter((d) => runExists(d));
      return text(ids.map((id) => ({ ...sessionSummary(id), render: queue.status(id) })));
    },
  );

  server.registerTool(
    'get_turn',
    {
      title: 'Get your turn',
      description:
        'What the named character sees: their personality and territory, the tools, libraries, current song, the judge and bandmates’ last notes.',
      inputSchema: { session: z.string(), as: z.string().describe('The character you are playing') },
    },
    async ({ session, as }) => {
      try {
        const render = queue.status(session);
        const pending = render?.rendering
          ? `\n\n(Turn ${render.rendering} is still rendering; the sound report may be one move behind.)`
          : '';
        return text(
          describeForAgent(session, as, {
            submitHint: `Call make_move with session "${session}", as "${as}" and move {tool, args, note, intent}.`,
          }) + pending,
        );
      } catch (error) {
        return failure(error.message);
      }
    },
  );

  server.registerTool(
    'make_move',
    {
      title: 'Make one move',
      description: 'Submit exactly one tool call as the named character. Rejected moves explain what to fix.',
      inputSchema: {
        session: z.string(),
        as: z.string(),
        move: z.object({
          tool: z.string(),
          args: z.record(z.string(), z.any()),
          note: z.string().describe('Public, 20-400 characters, names what it responds to'),
          intent: z.string().describe('Private confession booth, 10-600 characters'),
          breaks: z
            .array(z.object({ rule: z.string(), because: z.string() }))
            .max(2)
            .optional()
            .describe('Optional wildcards: break genre conventions on purpose, with a public reason'),
        }),
      },
    },
    async ({ session, as, move }) => {
      try {
        const result = await submitTurn(session, as, move, { render: false });
        if (!result.accepted) return failure(`REJECTED: ${result.reason}`);
        queue.enqueue(session, result.turn);
        return text({
          accepted: `turn ${result.turn}: ${result.target ?? result.kind}`,
          judge: result.validator?.pass ? 'every check passes' : result.validator?.failing,
          rendering: 'in the background; listen or get_turn shows the result',
          next: loadState(session).nextAgent,
        });
      } catch (error) {
        return failure(error.message);
      }
    },
  );

  server.registerTool(
    'listen',
    {
      title: 'Listen',
      description: 'Paths of the latest rendered audio for a session (MP3 files on this machine).',
      inputSchema: { session: z.string() },
    },
    async ({ session }) => {
      try {
        const dir = path.join(runDir(session), 'audio');
        const files = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
        const final = files.includes('final.mp3') ? path.join(dir, 'final.mp3') : null;
        const latest = files.filter((f) => f.startsWith('turn_')).at(-1);
        return text({ final, latest: latest ? path.join(dir, latest) : null, render: queue.status(session) });
      } catch (error) {
        return failure(error.message);
      }
    },
  );

  server.registerTool(
    'finish_song',
    {
      title: 'Finish the song',
      description:
        'Render the master once every turn is played. If the judge still fails the song, the band gets three repair turns.',
      inputSchema: { session: z.string() },
    },
    async ({ session }) => {
      try {
        const state = loadState(session);
        if (state.nextAgent !== null) return failure(`Not finished: it's still ${state.nextAgent}'s turn.`);
        await queue.idle(session);
        const result = await finalizeSession(session);
        return text(
          result.finalized === false
            ? { repair_turns: result.repairTurns, still_failing: result.failing }
            : { finished: true, master: result.master },
        );
      } catch (error) {
        return failure(error.message);
      }
    },
  );

  return { server, queue };
}
