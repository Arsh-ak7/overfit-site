/**
 * Turn rules. Pure functions: given the current state and one submission, return
 * the resulting song or throw. Nothing here touches disk.
 *
 * The rules come from the build plan's "rules that force conflict": validator
 * steps, not encouragement. Error messages are read by agents, so each one says
 * what to fix.
 *
 * @typedef {import('../types.mjs').Song} Song
 * @typedef {import('../types.mjs').Submission} Submission
 * @typedef {import('../types.mjs').TurnKind} TurnKind
 * @typedef {import('./projection.mjs').SessionState} SessionState
 * @typedef {{ kind: TurnKind, target: string|null, note: string, intent: string, op: string,
 *             submitted: Submission, songAfter: Song, pruned: string[] }} TurnResult
 */
import { SONG_LIMITS } from '../engine/catalog.mjs';
import { validateLayer, validateSong, validateStructure } from '../engine/validate.mjs';
import { RuleError } from '../errors.mjs';

export const NOTE_LENGTH = Object.freeze([20, 400]);
export const INTENT_LENGTH = Object.freeze([10, 600]);
const SUBMISSION_FIELDS = new Set(['op', 'layer', 'id', 'structure', 'note', 'intent']);
const STRUCTURE_FIELDS = new Set(['bpm', 'swing', 'sections', 'title']);
const OPENS_WITH_PRAISE = /^\s*(great|nice|love|loving|awesome|amazing|perfect|beautiful|cool|wow|sick|fire)\b/i;

const clone = (value) => structuredClone(value);
const sameJSON = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** The form every session starts from. The arranger may change it. */
export function initialSong(title, bpm) {
  const song = {
    title,
    bpm,
    swing: 0,
    sections: [
      { name: 'intro', bars: 8 },
      { name: 'groove', bars: 16 },
      { name: 'break', bars: 8 },
      { name: 'peak', bars: 16 },
      { name: 'outro', bars: 8 },
    ],
    layers: [],
  };
  validateStructure(song);
  return song;
}

/**
 * Destructive quota, "one turn in four must delete or replace": if none of the
 * last three accepted turns was destructive, the next one has to be.
 * @param {{ kind: TurnKind }[]} turns
 */
export function needsDestructive(turns) {
  if (turns.length < 3) return false;
  return !turns.slice(-3).some((t) => t.kind === 'delete' || t.kind === 'replace');
}

function checkTurnOrder(state, agentName) {
  if (!state.meta.cast.agents.some((a) => a.name === agentName)) throw new RuleError(`unknown agent '${agentName}'`);
  if (state.finalized) throw new RuleError('session is finalized');
  if (state.nextAgent === null) throw new RuleError('all rounds are used up');
  if (state.nextAgent !== agentName) throw new RuleError(`it is ${state.nextAgent}'s turn, not ${agentName}'s`);
}

function checkShape(submission) {
  if (!submission || typeof submission !== 'object' || Array.isArray(submission)) {
    throw new RuleError('submission must be a JSON object');
  }
  for (const key of Object.keys(submission)) {
    if (!SUBMISSION_FIELDS.has(key)) throw new RuleError(`unknown submission field '${key}' (one operation per turn)`);
  }
}

/** Public note and private intent. @returns {{ note: string, intent: string }} */
function checkNotes(state, submission) {
  const note = (submission.note ?? '').trim();
  const intent = (submission.intent ?? '').trim();
  if (note.length < NOTE_LENGTH[0] || note.length > NOTE_LENGTH[1]) {
    throw new RuleError(`note (public, to the band) must be ${NOTE_LENGTH.join('-')} characters`);
  }
  if (OPENS_WITH_PRAISE.test(note)) {
    throw new RuleError("note can't open with praise; say what you changed and which part or bandmate it answers");
  }
  if (intent.length < INTENT_LENGTH[0] || intent.length > INTENT_LENGTH[1]) {
    throw new RuleError(`intent (private confession booth) must be ${INTENT_LENGTH.join('-')} characters`);
  }
  // After the first turn, a note must point at something concrete that already exists.
  if (state.turns.length > 0) {
    const refs = [
      ...state.song.layers.map((l) => l.id),
      ...new Set(state.song.sections.map((s) => s.name)),
      ...state.meta.cast.agents.map((a) => a.name),
    ];
    const words = new Set(note.toLowerCase().split(/[^a-z0-9_]+/));
    if (!refs.some((r) => words.has(r.toLowerCase()))) {
      throw new RuleError(
        `note must name a concrete prior thing it responds to: a layer id, section or bandmate (${refs.join(', ')})`,
      );
    }
  }
  return { note, intent };
}

const sectionNamesOf = (song) => [...new Set(song.sections.map((s) => s.name))];

/** Each op mutates `song` (a private copy) and returns what kind of turn it was. */
const OPERATIONS = {
  add(song, submission, agent) {
    const layer = submission.layer;
    if (!layer) throw new RuleError("op 'add' needs a 'layer'");
    if (song.layers.length >= SONG_LIMITS.maxLayers) {
      throw new RuleError(`density cap: already ${SONG_LIMITS.maxLayers} layers; delete or replace one instead`);
    }
    if (song.layers.some((l) => l.id === layer.id)) throw new RuleError(`layer '${layer.id}' exists; use op 'change'`);
    const added = { ...layer, owner: agent.name };
    validateLayer(added, sectionNamesOf(song));
    song.layers.push(added);
    return { kind: 'add', target: added.id };
  },

  change(song, submission, agent) {
    const layer = submission.layer;
    if (!layer) throw new RuleError("op 'change' needs a full 'layer' (with the same id)");
    const index = song.layers.findIndex((l) => l.id === layer.id);
    if (index < 0) throw new RuleError(`no layer '${layer.id}' to change`);
    const old = song.layers[index];
    // Rewriting what a layer plays takes it over; tweaking its mix doesn't.
    const isReplace =
      old.instrument !== layer.instrument ||
      old.pattern !== layer.pattern ||
      !sameJSON(old.variants ?? {}, layer.variants ?? {});
    const changed = { ...layer, owner: isReplace ? agent.name : old.owner };
    validateLayer(changed, sectionNamesOf(song));
    if (sameJSON({ ...old, owner: 0 }, { ...changed, owner: 0 })) throw new RuleError('that change does nothing');
    song.layers[index] = changed;
    return { kind: isReplace ? 'replace' : 'edit', target: changed.id };
  },

  delete(song, submission) {
    const index = song.layers.findIndex((l) => l.id === submission.id);
    if (index < 0) throw new RuleError(`no layer '${submission.id}' to delete`);
    song.layers.splice(index, 1);
    return { kind: 'delete', target: submission.id };
  },

  structure(song, submission, agent, state) {
    if (!agent.can_structure) throw new RuleError(`only the arranger can change structure; ${agent.name} can't`);
    const change = submission.structure;
    if (!change) throw new RuleError("op 'structure' needs 'structure': {bpm, swing, sections}");
    for (const key of Object.keys(change)) {
      if (!STRUCTURE_FIELDS.has(key)) throw new RuleError(`unknown structure field '${key}'`);
    }
    const before = clone(song);
    song.bpm = change.bpm ?? song.bpm;
    song.swing = change.swing ?? song.swing;
    song.sections = change.sections ?? song.sections;
    song.title = change.title ?? song.title;
    validateStructure(song);

    const forbidden = state.meta.forbidden?.bpm;
    if (forbidden && song.bpm >= forbidden[0] && song.bpm <= forbidden[1]) {
      throw new RuleError(`novelty rule: bpm ${forbidden[0]}-${forbidden[1]} is forbidden for this song`);
    }

    // Drop references to sections that no longer exist, and report each one.
    const pruned = [];
    const names = new Set(song.sections.map((s) => s.name));
    for (const layer of song.layers) {
      if (Array.isArray(layer.in)) {
        const kept = layer.in.filter((s) => names.has(s));
        if (kept.length !== layer.in.length) {
          pruned.push(`${layer.id}.in lost ${layer.in.filter((s) => !names.has(s)).join(',')}`);
        }
        if (kept.length) layer.in = kept;
        else {
          delete layer.in;
          pruned.push(`${layer.id} now plays in all sections`);
        }
      }
      for (const section of Object.keys(layer.variants ?? {})) {
        if (!names.has(section)) {
          delete layer.variants[section];
          pruned.push(`${layer.id} variant '${section}' dropped`);
        }
      }
    }
    if (sameJSON(before, song)) throw new RuleError('that structure change does nothing');
    return { kind: 'structure', target: null, pruned };
  },
};

/**
 * Apply one submission to the current state.
 * @param {SessionState} state
 * @param {string} agentName
 * @param {Submission} submission
 * @returns {TurnResult}
 * @throws {RuleError|import('../errors.mjs').ValidationError}
 */
export function applyTurn(state, agentName, submission) {
  checkTurnOrder(state, agentName);
  checkShape(submission);
  const { note, intent } = checkNotes(state, submission);

  const operation = Object.hasOwn(OPERATIONS, submission.op) ? OPERATIONS[submission.op] : null;
  if (!operation) throw new RuleError('op must be one of add, change, delete, structure');
  const agent = state.meta.cast.agents.find((a) => a.name === agentName);
  const song = clone(state.song);
  const { kind, target, pruned = [] } = operation(song, submission, agent, state);

  if (state.destructiveRequired && kind !== 'delete' && kind !== 'replace') {
    throw new RuleError(
      "destructive quota: none of the last three turns deleted or replaced a part, so this turn must 'delete' a layer or 'change' one's instrument/pattern",
    );
  }
  validateSong(song);
  return { kind, target, note, intent, op: submission.op, submitted: submission, songAfter: song, pruned };
}
