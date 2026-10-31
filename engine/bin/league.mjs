#!/usr/bin/env node
/**
 * The pull-request league. See docs/league.md in the public repository.
 *
 *   league status [--root DIR]                    replay every session and print where each one stands
 *   league view <session> --as <Name> [--root]    what that character sees on its turn (paste it to your agent)
 *   league check --author LOGIN --changes FILE    judge one pull request (FILE: `git diff --name-status` output)
 *   league apply --out DIR [--no-render]          after a merge: render new moves and write DIR/league.json
 *
 * Replays go to a throwaway folder unless MUSIC_RUNS_DIR is set.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

if (!process.env.MUSIC_RUNS_DIR) process.env.MUSIC_RUNS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'league-'));
const league = await import('../src/league/league.mjs');
const { describeForAgent } = await import('../src/session/service.mjs');

const USAGE = `league status [--root DIR]
league view <session> --as <Name> [--root DIR]
league check --author LOGIN --changes FILE [--root DIR]
league apply --out DIR [--root DIR] [--no-render]`;

/** Append markdown to the GitHub Actions job summary, when there is one. */
function report(markdown) {
  console.log(markdown);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}

function nextStep(s) {
  if (s.open_seats.length) return `waiting for seats: ${s.open_seats.join(', ')}`;
  if (s.complete) return 'complete';
  return `next: ${s.next} (@${s.next_player}), move ${String(s.moves + 1).padStart(3, '0')}`;
}

const table = (statuses) =>
  [
    '| Session | Band | Moves | Judge | Status |',
    '| --- | --- | --- | --- | --- |',
    ...statuses.map(
      (s) =>
        `| ${s.session} | ${s.band} | ${s.moves}/${s.total_moves} | ${s.judge ? (s.judge.pass ? 'passes' : `${s.judge.failing.length} failing`) : '-'} | ${nextStep(s)} |`,
    ),
  ].join('\n');

const commands = {
  async status(args) {
    const { values } = parseArgs({ args, options: { root: { type: 'string', default: '.' } } });
    console.log(table(await league.checkLeague(path.resolve(values.root))));
  },

  async view(args) {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: { root: { type: 'string', default: '.' }, as: { type: 'string' } },
    });
    const [id] = positionals;
    if (!id || !values.as) throw new Error(`usage: ${USAGE.split('\n')[1]}`);
    const replay = await league.replaySession(path.resolve(values.root), id);
    const n = String(replay.state.turns.length + 1).padStart(3, '0');
    console.log(
      describeForAgent(replay.runId, values.as, {
        submitHint: `Reply with one JSON object: { "as": "${values.as}", "tool": ..., "args": {...}, "note": ..., "intent": ... }. It goes in league/${id}/moves/${n}.json, in a pull request of its own.`,
      }),
    );
  },

  async check(args) {
    const { values } = parseArgs({
      args,
      options: { root: { type: 'string', default: '.' }, author: { type: 'string' }, changes: { type: 'string' } },
    });
    const changes = fs
      .readFileSync(values.changes, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [status, ...paths] = line.split('\t');
        return { status: status[0], path: paths.at(-1) };
      });
    try {
      const { summary, statuses } = await league.checkChange(path.resolve(values.root), {
        author: values.author,
        changes,
      });
      report(`### ✅ League check passed\n\nThis pull request ${summary}.\n\n${table(statuses)}`);
    } catch (error) {
      if (!(error instanceof league.LeagueError)) throw error;
      report(`### ❌ League check failed\n\n${error.message}`);
      return 1;
    }
  },

  async apply(args) {
    const { values } = parseArgs({
      args,
      options: {
        root: { type: 'string', default: '.' },
        out: { type: 'string' },
        'no-render': { type: 'boolean', default: false },
      },
    });
    if (!values.out) throw new Error('--out is required');
    const feed = await league.applyLeague(path.resolve(values.root), {
      outDir: path.resolve(values.out),
      render: !values['no-render'],
      log: (line) => console.error(line),
    });
    console.log(table(feed));
  },
};

const [command, ...rest] = process.argv.slice(2);
if (!Object.hasOwn(commands, command ?? '')) {
  console.error(USAGE);
  process.exitCode = 2;
} else {
  try {
    process.exitCode = (await commands[command](rest)) ?? 0;
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
}
