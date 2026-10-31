/**
 * Turn rules for score v2 sessions. Pure: (state, agent, submission) -> result or throw.
 *
 * Each turn is one tool call: { tool, args, note, intent }. Agents own territories:
 *   key, progressions, chords, lead, counter -> the "harmony" territory
 *   drums, bass, swing                       -> the "rhythm" territory
 *   bpm, sections, transitions, sounds, mix  -> the "arrangement" territory
 * The cast sheet maps each agent to territories. Destructive turns must really
 * delete something (a part, a section, a progression, or a part from a section):
 * the spike showed "rewrite" satisfies a softer quota every time.
 */
import { RuleError, ValidationError } from '../errors.mjs';
import { analyze } from '../score/analyze.mjs';
import { derive } from '../score/derive.mjs';
import { GENRES, PROGRESSIONS } from '../score/library.mjs';
import { validateSongV2 } from '../score/schema.mjs';

export const TERRITORY_OF_ROLE = Object.freeze({
  chords: 'harmony',
  lead: 'harmony',
  counter: 'harmony',
  drums: 'rhythm',
  bass: 'rhythm',
  fx: 'arrangement',
});

export const TOOLS = Object.freeze([
  'set_song',
  'set_progression',
  'delete_progression',
  'put_part',
  'delete_part',
  'put_section',
  'delete_section',
  'set_play',
]);

const DESTRUCTIVE = new Set(['delete_part', 'delete_section', 'delete_progression']);
const NOTE_LENGTH = [20, 400];
const INTENT_LENGTH = [10, 600];
// Public text on a public show: no links, so no spam or phishing in notes.
const HAS_LINK = /https?:\/\/|www\.|\.(com|net|org|io|ai|xyz)\b/i;
const OPENS_WITH_PRAISE = /^\s*(great|nice|love|loving|awesome|amazing|perfect|beautiful|cool|wow|sick|fire)\b/i;

const clone = (v) => structuredClone(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** The starting song for a genre: a standard form with nothing playing yet. */
export function seedSong({ title, genre, key, mode, bpm }) {
  const profile = GENRES[genre];
  if (!profile) throw new ValidationError(`genre must be one of ${Object.keys(GENRES).join(', ')}`);
  const forms = {
    techno: [
      ['intro', 16],
      ['groove', 16],
      ['build', 8],
      ['drop', 16],
      ['drop_b', 16],
      ['breakdown', 16],
      ['build2', 8],
      ['peak', 16],
      ['peak_b', 16],
      ['outro', 16],
    ],
    house: [
      ['intro', 16],
      ['groove', 16],
      ['build', 8],
      ['drop', 16],
      ['drop_b', 16],
      ['breakdown', 16],
      ['peak', 16],
      ['outro', 16],
    ],
    dnb: [
      ['intro', 16],
      ['groove', 16],
      ['build', 8],
      ['drop', 16],
      ['drop_b', 16],
      ['breakdown', 16],
      ['build2', 8],
      ['peak', 16],
      ['peak_b', 16],
      ['outro', 16],
    ],
    synthpop: [
      ['intro', 8],
      ['verse', 16],
      ['chorus', 8],
      ['verse2', 16],
      ['chorus2', 8],
      ['bridge', 8],
      ['chorus3', 16],
      ['outro', 8],
    ],
    lofi: [
      ['intro', 4],
      ['a', 16],
      ['b', 8],
      ['a2', 16],
      ['bridge', 8],
      ['a3', 16],
      ['outro', 4],
    ],
    ambient: [
      ['intro', 16],
      ['rise', 16],
      ['peak', 16],
      ['breakdown', 16],
      ['peak_b', 16],
      ['outro', 16],
    ],
  };
  const song = {
    version: 2,
    title,
    genre,
    key,
    mode,
    bpm,
    swing: profile.swing[0],
    // a placeholder: the referee fails the song until the harmony owner chooses real chords
    progressions: { main: { chords: ['i'], barsPerChord: 1, placeholder: true } },
    parts: {},
    sections: forms[genre].map(([name, bars]) => ({
      name,
      bars,
      progression: 'main',
      energy: ['intro', 'outro'].includes(name)
        ? 1
        : /drop|peak|chorus/.test(name)
          ? 5
          : /build|rise/.test(name)
            ? 4
            : 2,
      play: [],
    })),
  };
  if (mode === 'major') song.progressions.main.chords = ['I'];
  validateSongV2(song);
  return song;
}

/** Turns before the delete quota starts, so the band can build something first. */
export const BUILD_TURNS = 6;

/** Real-delete quota: after the build phase, if none of the last three turns removed something, this one must. */
export const needsDelete = (turns) => turns.length >= BUILD_TURNS + 3 && !turns.slice(-3).some((t) => t.destructive);

function territoriesOf(state, agentName) {
  const agent = state.meta.cast.agents.find((a) => a.name === agentName);
  if (!agent) throw new RuleError(`unknown agent '${agentName}'`);
  return new Set(agent.territories ?? []);
}

function assertOwns(owns, territory, what) {
  if (!owns.has(territory)) throw new RuleError(`${what} belongs to the ${territory} territory, which isn't yours`);
}

function checkNotes(state, song, submission) {
  const note = (submission.note ?? '').trim();
  const intent = (submission.intent ?? '').trim();
  if (note.length < NOTE_LENGTH[0] || note.length > NOTE_LENGTH[1]) {
    throw new RuleError(`note (public, to the band) must be ${NOTE_LENGTH.join('-')} characters`);
  }
  if (OPENS_WITH_PRAISE.test(note)) throw new RuleError("note can't open with praise; say what you changed and why");
  if (HAS_LINK.test(note) || HAS_LINK.test(intent)) {
    throw new RuleError("notes and intents can't contain links or web addresses");
  }
  if (intent.length < INTENT_LENGTH[0] || intent.length > INTENT_LENGTH[1]) {
    throw new RuleError(`intent (private confession booth) must be ${INTENT_LENGTH.join('-')} characters`);
  }
  if (state.turns.length > 0) {
    const refs = [
      ...Object.keys(song.parts),
      ...song.sections.map((s) => s.name),
      ...Object.keys(song.progressions),
      ...state.meta.cast.agents.map((a) => a.name),
    ];
    const words = new Set(note.toLowerCase().split(/[^a-z0-9_]+/));
    if (!refs.some((r) => words.has(r.toLowerCase()))) {
      throw new RuleError(
        `note must name what it responds to: a part, section, progression or bandmate (${refs.join(', ')})`,
      );
    }
  }
  return { note, intent };
}

const TOOL_HANDLERS = {
  set_song(song, args, owns) {
    const allowed = { key: 'harmony', mode: 'harmony', swing: 'rhythm', bpm: 'arrangement', title: null };
    for (const [field, value] of Object.entries(args)) {
      if (!(field in allowed)) {
        throw new RuleError(`set_song can change ${Object.keys(allowed).join(', ')}, not '${field}'`);
      }
      if (allowed[field]) assertOwns(owns, allowed[field], `the song's ${field}`);
      song[field] = value;
    }
    return { summary: `set ${Object.keys(args).join(', ')}` };
  },

  set_progression(song, args, owns) {
    assertOwns(owns, 'harmony', 'progressions');
    const { name, chords, library, barsPerChord = 1 } = args;
    if (library) {
      if (!PROGRESSIONS[library]) {
        throw new RuleError(`no library progression '${library}' (see the list in your view)`);
      }
      song.progressions[name] = { chords: [...PROGRESSIONS[library].chords], barsPerChord };
    } else {
      song.progressions[name] = { chords, barsPerChord };
    }
    return { summary: `progression ${name}: ${song.progressions[name].chords.join(' ')}` };
  },

  delete_progression(song, args, owns) {
    assertOwns(owns, 'harmony', 'progressions');
    if (!song.progressions[args.name]) throw new RuleError(`no progression '${args.name}'`);
    const users = song.sections.filter((s) => s.progression === args.name).map((s) => s.name);
    if (users.length) {
      throw new RuleError(`sections ${users.join(', ')} still use '${args.name}'; point them elsewhere first`);
    }
    delete song.progressions[args.name];
    return { summary: `deleted progression ${args.name}` };
  },

  put_part(song, args, owns) {
    const { id, part } = args;
    if (!part || typeof part !== 'object') throw new RuleError('put_part needs { id, part: {...} }');
    const existing = song.parts[id];
    const territory = TERRITORY_OF_ROLE[part.role];
    if (!territory) throw new RuleError(`role must be one of ${Object.keys(TERRITORY_OF_ROLE).join(', ')}`);
    const onlySoundOrMix =
      existing && same({ ...existing, sound: 0, mix: 0 }, { ...part, sound: 0, mix: 0 }) && !same(existing, part);
    if (onlySoundOrMix && owns.has('arrangement')) {
      song.parts[id] = part;
      return { summary: `re-voiced ${id}` };
    }
    assertOwns(owns, territory, `a ${part.role} part`);
    if (existing && existing.role !== part.role) {
      throw new RuleError(`'${id}' is a ${existing.role} part; pick a new id`);
    }
    song.parts[id] = part;
    return { summary: `${existing ? 'rewrote' : 'added'} ${id}` };
  },

  delete_part(song, args, owns) {
    const part = song.parts[args.id];
    if (!part) throw new RuleError(`no part '${args.id}'`);
    if (!owns.has('arrangement')) assertOwns(owns, TERRITORY_OF_ROLE[part.role], `the ${part.role} part '${args.id}'`);
    delete song.parts[args.id];
    for (const s of song.sections) s.play = s.play.filter((p) => p.split(':')[0] !== args.id);
    for (const s of song.sections) if (s.automate) s.automate = s.automate.filter((a) => a.part !== args.id);
    return { summary: `deleted ${args.id}` };
  },

  put_section(song, args, owns) {
    assertOwns(owns, 'arrangement', 'the song form');
    const { section, at } = args;
    if (!section?.name) {
      throw new RuleError('put_section needs { section: { name, bars, progression, energy, play, ... }, at? }');
    }
    const index = song.sections.findIndex((s) => s.name === section.name);
    if (index >= 0) song.sections[index] = section;
    else song.sections.splice(at ?? song.sections.length, 0, section);
    return { summary: `${index >= 0 ? 'reshaped' : 'added'} section ${section.name}` };
  },

  delete_section(song, args, owns) {
    assertOwns(owns, 'arrangement', 'the song form');
    const before = song.sections.length;
    song.sections = song.sections.filter((s) => s.name !== args.name);
    if (song.sections.length === before) throw new RuleError(`no section '${args.name}'`);
    return { summary: `deleted section ${args.name}` };
  },

  set_play(song, args, owns) {
    const { section: name, add = [], remove = [] } = args;
    const names = Array.isArray(name) ? name : [name];
    const targets = names.includes('*') ? song.sections : song.sections.filter((s) => names.includes(s.name));
    const missing = names.filter((n) => n !== '*' && !song.sections.some((s) => s.name === n));
    if (missing.length || !targets.length) {
      throw new RuleError(
        `no section '${missing[0] ?? name}' (give a name, a list of names, or "*" for every section)`,
      );
    }
    for (const entry of [...add, ...remove]) {
      const id = String(entry).split(':')[0];
      if (!song.parts[id]) throw new RuleError(`no part '${id}'`);
      if (!owns.has('arrangement')) assertOwns(owns, TERRITORY_OF_ROLE[song.parts[id].role], `when '${id}' plays`);
    }
    let removed = 0;
    for (const s of targets) {
      const drop = new Set(remove.map(String));
      const kept = s.play.filter((p) => !drop.has(p) && !drop.has(p.split(':')[0]));
      removed += s.play.length - kept.length;
      // adding "hook:octave_up" replaces any other variant of hook in that section
      const addIds = new Set(add.map((e) => String(e).split(':')[0]));
      s.play = [...kept.filter((p) => !addIds.has(p.split(':')[0])), ...add.map(String)];
    }
    return { summary: `${names.join(',')}: +${add.join(',') || '-'} -${remove.join(',') || '-'}`, removed };
  },
};

/**
 * @returns {{ tool: string, args: object, summary: string, destructive: boolean, note: string, intent: string,
 *             submitted: object, songAfter: object, validator: object }}
 */
export function applyTurnV2(state, agentName, submission) {
  if (state.finalized) throw new RuleError('session is finalized');
  if (state.nextAgent === null) throw new RuleError('all turns are used up');
  if (state.nextAgent !== agentName) throw new RuleError(`it is ${state.nextAgent}'s turn, not ${agentName}'s`);
  if (!submission || typeof submission !== 'object') throw new RuleError('submission must be a JSON object');
  for (const key of Object.keys(submission)) {
    if (!['tool', 'args', 'note', 'intent'].includes(key)) {
      throw new RuleError(`unknown field '${key}': send { tool, args, note, intent }`);
    }
  }
  if (!TOOLS.includes(submission.tool)) throw new RuleError(`tool must be one of ${TOOLS.join(', ')}`);
  const owns = territoriesOf(state, agentName);
  const { note, intent } = checkNotes(state, state.song, submission);

  const song = clone(state.song);
  const outcome = TOOL_HANDLERS[submission.tool](song, submission.args ?? {}, owns);
  const destructive = DESTRUCTIVE.has(submission.tool) || (outcome.removed ?? 0) > 0;
  if (state.deleteRequired && !destructive) {
    throw new RuleError(
      'delete quota: none of the last three turns removed anything, so this turn must delete a part, section or progression, or take a part out of a section (set_play remove)',
    );
  }
  if (same(song, state.song)) throw new RuleError('that move changes nothing');
  validateSongV2(song);
  const validator = analyze(derive(song), song);
  return {
    tool: submission.tool,
    args: submission.args ?? {},
    summary: outcome.summary,
    destructive,
    note,
    intent,
    submitted: submission,
    songAfter: song,
    validator: { pass: validator.pass, failing: validator.hard.filter((r) => !r.ok).map((r) => r.message) },
  };
}
