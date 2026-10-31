/**
 * Append-only, hash-chained event log, one JSON object per line.
 *
 * Each event's hash is sha256 over its body (everything but `hash`) with keys in
 * the order seq, ts, prev, type, agent, data. `prev` links to the previous hash,
 * so editing any past line breaks every hash after it. Changing the body layout
 * would invalidate existing logs: don't.
 *
 * @typedef {import('../types.mjs').LogEvent} LogEvent
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { LogIntegrityError } from '../errors.mjs';
import { PATHS } from '../paths.mjs';

const RUN_ID = /^[a-z0-9][a-z0-9_-]{0,40}$/;
const GENESIS = 'genesis';

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

/** Directory holding everything for one run (log, audio, summaries). */
export function runDir(id) {
  if (!RUN_ID.test(id)) throw new Error(`Invalid run id '${id}': use lower-case letters, digits, - and _.`);
  return path.join(PATHS.runs, id);
}

const logPath = (id) => path.join(runDir(id), 'events.jsonl');

export const runExists = (id) => fs.existsSync(logPath(id));

/**
 * Read and verify a run's log.
 * @returns {LogEvent[]}
 * @throws {LogIntegrityError} when any link in the chain fails
 */
export function readLog(id) {
  if (!runExists(id)) throw new Error(`No run named '${id}'.`);
  const events = fs
    .readFileSync(logPath(id), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  let prev = GENESIS;
  for (const event of events) {
    const { hash, ...body } = event;
    if (body.prev !== prev || sha256(JSON.stringify(body)) !== hash) {
      throw new LogIntegrityError(`Event log for '${id}' fails verification at seq ${event.seq}.`);
    }
    prev = hash;
  }
  return events;
}

/**
 * Append one event and return it.
 * @param {string} id @param {string} type @param {string} agent @param {unknown} data
 * @returns {LogEvent}
 */
export function appendEvent(id, type, agent, data) {
  fs.mkdirSync(runDir(id), { recursive: true });
  const events = runExists(id) ? readLog(id) : [];
  const last = events.at(-1);
  const body = {
    seq: events.length,
    ts: new Date().toISOString(),
    prev: last ? last.hash : GENESIS,
    type,
    agent,
    data,
  };
  const event = { ...body, hash: sha256(JSON.stringify(body)) };
  fs.appendFileSync(logPath(id), `${JSON.stringify(event)}\n`);
  return event;
}
