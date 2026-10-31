/**
 * Rebuild a session's state from its event log. The song is never stored on its
 * own: it's always the result of folding accepted turns, so every note in it has
 * provenance.
 *
 * @typedef {import('../types.mjs').LogEvent} LogEvent
 * @typedef {import('../types.mjs').Song} Song
 * @typedef {object} SessionState
 * @property {any} meta                 the session.created payload (cast, rounds, brief, ...)
 * @property {Song} song                current song
 * @property {any[]} turns              accepted turns, oldest first (without songAfter)
 * @property {any[]} rejected           rejected submissions
 * @property {any[]} renders            render + hearing results
 * @property {any|null} finalized       session.finalized payload, if any
 * @property {string|null} nextAgent    whose turn it is, or null when rounds are used up
 * @property {number} round             1-based current round
 * @property {boolean} destructiveRequired
 */
import { needsDelete } from './rules-v2.mjs';
import { needsDestructive } from './rules.mjs';

/**
 * @param {LogEvent[]} events
 * @returns {SessionState}
 */
export function project(events) {
  const [created, ...rest] = events;
  if (created?.type !== 'session.created') throw new Error('An event log must start with session.created.');

  const state = {
    meta: created.data,
    song: structuredClone(created.data.initialSong),
    turns: [],
    rejected: [],
    renders: [],
    finalized: null,
    extraTurns: 0,
  };
  for (const event of rest) {
    switch (event.type) {
      case 'turn.accepted': {
        const { songAfter, ...turn } = event.data;
        state.song = structuredClone(songAfter);
        state.turns.push({ seq: event.seq, agent: event.agent, ...turn });
        break;
      }
      case 'turn.rejected':
        state.rejected.push({ seq: event.seq, agent: event.agent, ...event.data });
        break;
      case 'render':
        state.renders.push({ seq: event.seq, ...event.data });
        break;
      case 'session.finalized':
        state.finalized = event.data;
        break;
      case 'session.repair_opened':
        state.extraTurns += event.data.turns;
        break;
      default:
        throw new Error(`Unknown event type '${event.type}' at seq ${event.seq}.`);
    }
  }

  const order = state.meta.cast.agents.map((a) => a.name);
  const taken = state.turns.length;
  const v2 = state.meta.scoreVersion === 2;
  const budget = state.meta.rounds * order.length + state.extraTurns;
  return {
    ...state,
    nextAgent: taken >= budget ? null : order[taken % order.length],
    round: Math.floor(taken / order.length) + 1,
    destructiveRequired: v2 ? false : needsDestructive(state.turns),
    deleteRequired: v2 ? needsDelete(state.turns) : false,
  };
}
