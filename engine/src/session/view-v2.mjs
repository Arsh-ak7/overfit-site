/**
 * What an agent sees on its turn in a score-v2 session, as plain text. It includes
 * the tools, the libraries to choose from, the validator's verdict and, in the
 * "hearing" condition, Ledger's report on the last render. Bandmates' private
 * intents are never shown.
 */
import { BASS_STYLES, LIMITS, TRANSITIONS, VARIANTS, soundsFor } from '../score/schema.mjs';
import { FILLS, GENRES, GROOVES, PROGRESSIONS } from '../score/library.mjs';
import palette from '../score/palette.json' with { type: 'json' };
import { analyze } from '../score/analyze.mjs';
import { derive } from '../score/derive.mjs';
import { TERRITORY_OF_ROLE, WILDCARDS_PER_CHARACTER } from './rules-v2.mjs';

const TERRITORY_TEXT = {
  harmony: 'key and mode, chord progressions, chord parts (pads, stabs, arps), the hook (lead) and counter-melodies',
  rhythm: 'drums, bass and swing',
  arrangement:
    "tempo, the song form (sections, energy, transitions, automation), which part plays where, and every part's sound and mix",
};

const pct = (x) => `${Math.round(x * 100)}%`;

function hearingText(render) {
  if (!render) return '(nothing rendered yet)';
  if (render.silent) return '(silence: no part plays anywhere yet)';
  if (render.error) return '(the last render failed on our side; no report this turn)';
  const m = render.report.mix;
  const lines = [
    `Master: ${render.master.lufs} LUFS, true peak ${render.master.true_peak_db} dB; heard tempo ${m.tempo_heard_bpm} BPM, heard key ${m.key_heard}`,
    `Energy by band: ${Object.entries(m.band_energy_share)
      .map(([b, v]) => `${b} ${pct(v)}`)
      .join(', ')}`,
    `Section loudness (dB): ${m.sections.map((s) => `${s.name} ${s.loudness_db}`).join(' | ')}`,
    `Ledger: ${render.report.ledger.flags.length ? render.report.ledger.flags.join(' ') : 'no mix problems flagged.'}`,
  ];
  return lines.join('\n');
}

const TOOL_HELP = `Send ONE tool call per turn: {"tool": "...", "args": {...}, "note": "public, 20-400 chars", "intent": "private, 10-600 chars"}
  set_song         {"key":"A","mode":"minor"} (harmony) | {"bpm":128} (arrangement) | {"swing":54} (rhythm) | {"title":"..."}
  set_progression  {"name":"main","library":"epic_minor","barsPerChord":2}  or  {"name":"lift","chords":["iv","VI","III","v"],"barsPerChord":1}
  delete_progression {"name":"lift"}
  put_part         {"id":"hook","part":{"role":"lead","sound":"lead.supersaw","motif":["1 . . 3 - . 5 . 4 . 3 . 1 - . ."],"octave":4,"mix":{"reverb":0.3,"delay":0.2,"duck":3}}}
                   {"id":"bass","part":{"role":"bass","sound":"bass.rolling","style":"rolling16","mix":{"duck":6}}}
                   {"id":"drums","part":{"role":"drums","sound":"drums.909","groove":"techno_driving","fill":"snare_roll","fillEvery":8}}
                   {"id":"stabs","part":{"role":"chords","sound":"stab.pluck","voicing":"stabs","rhythm":"...x..x...x..x.."}}
  delete_part      {"id":"stabs"}  (also removes it from every section)
  put_section      {"section":{"name":"drop","bars":16,"progression":"main","energy":5,"play":["drums","bass","hook"],"transition":"riser"},"at":3}
  delete_section   {"name":"build2"}
  set_play         {"section":"drop","add":["hook:octave_up"],"remove":["pad"]}   (section: a name, a list of names, or "*")`;

const MOTIF_HELP = `Motifs: each bar is exactly 16 space-separated slots (16th notes). Slots are scale degrees 1-7 of the key
(b3, #4 for alterations; 5' one octave up, 5, one octave down), "." for rest, "-" to hold the previous note.
With fit "chord" (default), on-beat notes snap to the current chord, so the hook always sits on the harmony.`;

/**
 * @param {import('./projection.mjs').SessionState} state
 * @param {string} agentName
 * @param {{ runId: string }} context
 */
export function agentViewV2(state, agentName, { runId, submitHint }) {
  const { meta, song } = state;
  const me = meta.cast.agents.find((a) => a.name === agentName);
  if (!me) throw new Error(`Unknown agent '${agentName}'.`);
  const mates = meta.cast.agents
    .filter((a) => a !== me)
    .map((a) => `${a.name} (${a.role}: ${a.territories.join(', ')})`)
    .join('; ');
  const lastNotes =
    state.turns
      .filter((t) => t.agent !== agentName)
      .slice(-2)
      .map((t) => `- ${t.agent} [${t.tool}: ${t.summary}]: "${t.note}"`)
      .join('\n') || '- (no notes yet)';
  const myLast = state.turns.findLast((t) => t.agent === agentName);
  const lastRender = state.renders.findLast((r) => !r.error) ?? state.renders.at(-1);
  const validator = lastRender?.validator ?? state.turns.at(-1)?.validator;
  const genre = GENRES[song.genre];
  const myRoles = Object.entries(TERRITORY_OF_ROLE)
    .filter(([, t]) => me.territories.includes(t))
    .map(([role]) => role);
  const sounds = (me.territories.includes('arrangement') ? Object.keys(TERRITORY_OF_ROLE) : myRoles)
    .flatMap((role) => soundsFor(role).map((id) => `  ${id} (${role}): ${palette.sounds[id].desc}`))
    .filter((v, i, a) => a.indexOf(v) === i)
    .join('\n');
  const total = meta.rounds * meta.cast.agents.length + (state.extraTurns ?? 0);
  const whose = state.nextAgent === agentName ? 'It is YOUR turn.' : `It is ${state.nextAgent}'s turn, not yours.`;

  return [
    `# You are ${me.name}, the ${me.role} of ${meta.cast.band} (${meta.cast.scene}).`,
    `Taste: ${me.taste}. Anti-taste: ${me.anti_taste}. Your flaw (play it, don't announce it): ${me.flaw}.`,
    `You control: ${me.territories.map((t) => TERRITORY_TEXT[t]).join('; ')}.`,
    `Bandmates: ${mates}. You are an AI and the band knows it; never claim to be human.`,
    `Brief: ${meta.brief || '(none)'}`,
    '',
    `## Turn ${state.turns.length + 1} of ${total}. ${whose}`,
    state.deleteRequired &&
      '**This turn must remove something**: delete a part, section or progression, or take a part out of a section with set_play remove (delete quota: one turn in four). A move that fixes a failing judge check also counts.',
    myLast && `Your last move: [${myLast.tool}: ${myLast.summary}] "${myLast.note}"`,
    '',
    '## The judge. The song cannot finish until every check passes or is broken on purpose',
    validator ? judgeLines(song) : '- (not checked yet)',
    '',
    `## Wildcards: you may break a convention on purpose (${WILDCARDS_PER_CHARACTER} per character per song, ${WILDCARDS_PER_CHARACTER - (song.breaks ?? []).filter((b) => b.by === agentName).length} left for you)`,
    'Add to any move: "breaks": [{"rule": "<convention id>", "because": "<public reason, 10-200 chars>"}]. The judge then records the break instead of failing the song, and viewers see your reason. Only conventions can be broken, never the floor. Break a convention when it makes the song better, not to dodge work.',
    (song.breaks ?? []).length
      ? (song.breaks ?? []).map((b) => `- ${b.rule} broken by ${b.by}: "${b.because}"`).join('\n')
      : '- (no conventions broken yet)',
    '',
    '## Rules',
    `- One tool call per turn, inside your territory. At most ${LIMITS.activePerSection} parts play in any section (drums count as one).`,
    "- A part is silent until it's in a section's play list. You can place or remove your own parts with set_play (several sections at once); the arranger can place anyone's.",
    '- Public note must name the part, section, progression or bandmate it responds to. No opening with praise.',
    '- Private intent goes to the confession booth: viewers see it, bandmates never do.',
    `- ${song.genre}: ${genre.bpm.join('-')} BPM, swing ${genre.swing.join('-')}%, sections of ${[4, ...genre.sectionBars].join('/')} bars, ${Math.round(genre.duration[0] / 60)}-${Math.round(genre.duration[1] / 60)} minutes.`,
    '',
    '## Tools',
    TOOL_HELP,
    '',
    MOTIF_HELP,
    '',
    '## Libraries',
    `Progressions: ${Object.entries(PROGRESSIONS)
      .map(([k, v]) => `${k} (${v.chords.join(' ')}; ${v.modes.join('/')})`)
      .join('; ')}`,
    `Grooves: ${Object.keys(GROOVES).join(', ')}. Fills: ${Object.keys(FILLS).join(', ')}.`,
    `Bass styles: ${BASS_STYLES.join(', ')}. Chord voicings: pad, stabs (with a 16-slot rhythm), arp (up/down/updown, rate 8 or 16).`,
    `Variants for play lists: ${Object.entries(VARIANTS)
      .filter(([, v]) => v.length)
      .map(([role, v]) => `${role}: ${v.join('/')}`)
      .join('; ')}. Transitions into a section: ${TRANSITIONS.join(', ')}.`,
    'Sounds you can choose:',
    sounds,
    '',
    '## Current song',
    `\`\`\`json\n${JSON.stringify(song)}\n\`\`\``,
    '',
    '## Latest notes from bandmates (you only see the last two)',
    lastNotes,
    '',
    ...(meta.condition === 'hearing'
      ? ["## What the last render sounded like (Ledger's DSP report; numbers, not taste)", hearingText(lastRender), '']
      : []),
    '## How to submit',
    submitHint ??
      `Write the JSON to a file and run: node bin/music.mjs session turn ${runId} --agent ${agentName} --file <file>`,
  ]
    .filter((line) => line !== false && line !== undefined && line !== null)
    .join('\n');
}

/** Every failing check with its id, and whether it's the floor or a breakable convention. */
function judgeLines(song) {
  const v = analyze(derive(song), song);
  const failing = v.hard.filter((r) => !r.ok && !r.broken);
  if (!failing.length) {
    return `All ${v.hard.length} checks pass${v.broken.length ? ` (${v.broken.length} broken on purpose)` : ''}.`;
  }
  return failing
    .map((r) => `- [${r.id}, ${r.kind === 'floor' ? 'floor: must pass' : 'convention: breakable'}] ${r.message}`)
    .join('\n');
}
