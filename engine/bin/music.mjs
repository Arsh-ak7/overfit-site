#!/usr/bin/env node
/**
 * The spike's single command-line entry point.
 *
 *   music session new <run> [--cast overfit] [--condition hearing|deaf] [--rounds 4] [--bpm 138]
 *                           [--brief TEXT] [--forbid-bpm 120-128]
 *                           [--score 2 --genre techno --key A --mode minor]   (score v2: tool-call turns)
 *   music session state <run> --agent NAME     what that agent sees on its turn
 *   music session turn <run> --agent NAME --file move.json
 *   music session finalize <run>
 *   music session verify <run>
 *   music session rerender <run>                 render the latest turn again (after a renderer fix)
 *   music render <song.json> <out.wav> [--mp3] [--solo LAYER] [--sample-rate N]   (v1 songs)
 *   music produce <song.json> <out-dir>                                          (v2 songs: studio render)
 *
 * Exit codes: 0 ok, 1 rejected turn or failure, 2 usage error.
 */
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { renderToFile } from '../src/engine/node-env.mjs';
import { PATHS } from '../src/paths.mjs';
import { analyze } from '../src/score/analyze.mjs';
import { derive } from '../src/score/derive.mjs';
import { readLog } from '../src/session/log.mjs';
import {
  createSession,
  describeForAgent,
  finalizeSession,
  loadCast,
  rerenderLatest,
  submitTurn,
} from '../src/session/service.mjs';

const USAGE = fs
  .readFileSync(new URL(import.meta.url), 'utf8')
  .split('*/')[0]
  .split('\n')
  .filter((l) => l.startsWith(' *'))
  .map((l) => l.slice(3))
  .join('\n');

class UsageError extends Error {}

function parse(args, options, positionals) {
  const { values, positionals: got } = parseArgs({ args, options, allowPositionals: true, strict: true });
  if (got.length !== positionals) {
    throw new UsageError(`expected ${positionals} positional argument(s), got ${got.length}`);
  }
  return { values, positionals: got };
}

function requireOption(values, name) {
  if (values[name] === undefined) throw new UsageError(`--${name} is required`);
  return values[name];
}

const sessionCommands = {
  new(args) {
    const {
      values,
      positionals: [run],
    } = parse(
      args,
      {
        cast: { type: 'string', default: 'overfit' },
        condition: { type: 'string', default: 'hearing' },
        rounds: { type: 'string', default: '4' },
        bpm: { type: 'string', default: '138' },
        brief: { type: 'string', default: '' },
        'forbid-bpm': { type: 'string' },
        score: { type: 'string', default: '1' },
        genre: { type: 'string', default: 'techno' },
        key: { type: 'string', default: 'A' },
        mode: { type: 'string', default: 'minor' },
      },
      1,
    );
    const forbid = values['forbid-bpm'];
    const event = createSession(run, {
      cast: loadCast(values.cast),
      condition: values.condition,
      rounds: Number(values.rounds),
      bpm: Number(values.bpm),
      brief: values.brief,
      forbiddenBpm: forbid ? forbid.split('-').map(Number) : undefined,
      score: Number(values.score),
      genre: values.genre,
      key: values.key,
      mode: values.mode,
    });
    console.log(`Created run ${run} (seq ${event.seq}).`);
  },

  state(args) {
    const {
      values,
      positionals: [run],
    } = parse(args, { agent: { type: 'string' } }, 1);
    console.log(describeForAgent(run, requireOption(values, 'agent')));
  },

  async turn(args) {
    const {
      values,
      positionals: [run],
    } = parse(args, { agent: { type: 'string' }, file: { type: 'string' } }, 1);
    const agent = requireOption(values, 'agent');
    let submission;
    try {
      submission = JSON.parse(fs.readFileSync(requireOption(values, 'file'), 'utf8'));
    } catch (error) {
      if (error instanceof UsageError) throw error;
      console.log(`REJECTED: could not read JSON: ${error.message}`);
      return 1;
    }
    const result = await submitTurn(run, agent, submission);
    if (!result.accepted) {
      console.log(`REJECTED: ${result.reason}\nFix it and submit again.`);
      return 1;
    }
    const { turn, kind, target, render, pruned, validator } = result;
    const rendered = render.silent
      ? 'Nothing plays yet, so there is no audio to render.'
      : `Rendered ${render.audio_seconds}s of audio in ${(render.timing_ms.total / 1000).toFixed(1)}s.`;
    console.log(`ACCEPTED turn ${turn} (${kind}${target ? `: ${target}` : ''}). ${rendered}`);
    if (pruned.length) console.log(`Structure side effects: ${pruned.join('; ')}`);
    if (validator) {
      console.log(
        validator.pass
          ? 'Validator: every hard rule passes.'
          : `Validator still failing:\n- ${validator.failing.join('\n- ')}`,
      );
    }
  },

  async finalize(args) {
    const {
      positionals: [run],
    } = parse(args, {}, 1);
    console.log(JSON.stringify(await finalizeSession(run), null, 1));
  },

  async rerender(args) {
    const {
      positionals: [run],
    } = parse(args, {}, 1);
    const render = await rerenderLatest(run);
    console.log(JSON.stringify({ label: render.label, seconds: render.audio_seconds, validator: render.validator }));
  },

  verify(args) {
    const {
      positionals: [run],
    } = parse(args, {}, 1);
    console.log(`ok: ${readLog(run).length} events, chain intact`);
  },
};

const commands = {
  async produce(args) {
    const {
      positionals: [songFile, outDir],
    } = parse(args, {}, 2);
    const song = JSON.parse(fs.readFileSync(songFile, 'utf8'));
    const performance = derive(song);
    const verdict = analyze(performance, song);
    fs.mkdirSync(outDir, { recursive: true });
    const perfPath = path.join(outDir, 'performance.json');
    fs.writeFileSync(perfPath, JSON.stringify(performance));
    const studio = execFileSync('python3', ['-I', PATHS.studioScript, perfPath, outDir], { maxBuffer: 1 << 24 });
    console.log(
      JSON.stringify({ validator: { pass: verdict.pass, summary: verdict.summary }, studio: JSON.parse(studio) }),
    );
  },

  async session([sub, ...args]) {
    if (!Object.hasOwn(sessionCommands, sub)) throw new UsageError(`unknown session command '${sub ?? ''}'`);
    return sessionCommands[sub](args);
  },

  async render(args) {
    const {
      values,
      positionals: [songFile, outWav],
    } = parse(
      args,
      { mp3: { type: 'boolean', default: false }, solo: { type: 'string' }, 'sample-rate': { type: 'string' } },
      2,
    );
    const song = JSON.parse(fs.readFileSync(songFile, 'utf8'));
    const result = await renderToFile(song, outWav, {
      mp3: values.mp3,
      solo: values.solo,
      sampleRate: values['sample-rate'] ? Number(values['sample-rate']) : undefined,
    });
    console.log(JSON.stringify(result));
  },
};

async function main([command, ...args]) {
  if (!command || command === '--help' || command === 'help') {
    console.log(USAGE);
    return 0;
  }
  if (!Object.hasOwn(commands, command)) throw new UsageError(`unknown command '${command}'`);
  return (await commands[command](args)) ?? 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    if (error instanceof UsageError || error?.code?.startsWith?.('ERR_PARSE_ARGS')) {
      console.error(`Usage error: ${error.message}\n\n${USAGE}`);
      process.exitCode = 2;
    } else {
      console.error(`Error: ${error.message}`);
      process.exitCode = 1;
    }
  },
);
