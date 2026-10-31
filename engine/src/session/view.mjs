/**
 * What an agent is allowed to see on its turn, as plain text. This is the whole of
 * an agent's world: its character sheet, the rules, the current score, the last
 * two bandmate notes and, in the "hearing" condition, Ledger's report. Private
 * intents and the full chat are deliberately absent (limited peer exposure).
 *
 * @typedef {import('./projection.mjs').SessionState} SessionState
 */
import { DELAY_TIMES, INSTRUMENTS, PARAMS, SONG_LIMITS } from '../engine/catalog.mjs';
import { INTENT_LENGTH, NOTE_LENGTH } from './rules.mjs';

const pct = (x) => Math.round(x * 100);
const moveLabel = (t) => `[${t.kind}${t.target ? ` ${t.target}` : ''}]`;

/** One-screen summary of a hearing report. */
export function formatReport(report) {
  if (!report) return '(nothing to hear yet: no layers)';
  const m = report.mix;
  const lines = [
    `Mix: peak ${m.peak_dbfs} dBFS, loudness ${m.loudness_rms_dbfs} dBFS RMS, centroid ${m.spectral_centroid_hz} Hz, stereo width ${m.stereo_width}`,
    `Energy by band: ${Object.entries(m.band_energy_share)
      .map(([band, share]) => `${band} ${pct(share)}%`)
      .join(', ')}`,
    `Heard tempo ${m.tempo_heard_bpm} bpm; heard key ${m.key_heard} (confidence ${m.key_confidence}, margin ${m.key_margin})`,
    `Sections (loudness dB / onsets per bar): ${m.sections.map((s) => `${s.name} ${s.loudness_db}/${s.onsets_per_bar}`).join(' | ')}`,
  ];
  for (const l of report.layers) {
    const overlap = l.most_overlaps_with ? `, spectrum ${pct(l.overlap)}% like '${l.most_overlaps_with}'` : '';
    lines.push(
      `  layer ${l.id} (${l.instrument}, ${l.owner}): ${l.level_db_vs_mix} dB vs mix while playing, mostly ${l.main_band}, active ${pct(l.active_fraction)}% of the song${overlap}`,
    );
  }
  lines.push(`Ledger flags: ${report.ledger.flags.length ? report.ledger.flags.join(' ') : 'none'}`);
  if (report.ledger.cut_one_thing) lines.push(`Ledger would cut: ${report.ledger.cut_one_thing}`);
  return lines.join('\n');
}

function formatHistory(history) {
  if (!history.length) return 'none yet';
  const rows = history
    .slice(-3)
    .map((h) => `- ${h.session}: ${h.bpm} bpm, heard as ${h.key_heard}, instruments ${h.instruments.join(', ')}`);
  return `${rows.join('\n')}\nTry not to repeat these defaults.`;
}

const PATTERN_HELP = [
  '  "a b c d" four equal steps | "~" rest | "[a b]" fit inside one step | "<a b c>" one per bar, cycling',
  '  "a*3" repeat inside its step | "a?" plays on about half the bars | "a,b,c" at the same time (inside [ ] for chords) | "a:0.4" velocity 0-1',
  '  Drums take x (hit) or X (accent). Pitched instruments take notes like c3, eb2, f#4 (octave 4 = middle C).',
  '  Example: "x ~ [x x] ~", "<[c3,eb3,g3] [ab2,c3,eb3]>", "[c4 eb4] g4*2 ~ bb3:0.5"',
];

/**
 * @param {SessionState} state
 * @param {string} agentName
 * @param {{ runId: string, history: object[] }} context
 */
export function agentView(state, agentName, { runId, history }) {
  const { meta } = state;
  const me = meta.cast.agents.find((a) => a.name === agentName);
  if (!me) throw new Error(`Unknown agent '${agentName}'.`);
  const mates = meta.cast.agents
    .filter((a) => a !== me)
    .map((a) => `${a.name} (${a.role})`)
    .join(', ');
  const totalTurns = meta.rounds * meta.cast.agents.length;
  const lastNotes =
    state.turns
      .filter((t) => t.agent !== agentName)
      .slice(-2)
      .map((t) => `- ${t.agent} ${moveLabel(t)}: "${t.note}"`)
      .join('\n') || '- (no notes yet)';
  const myLast = state.turns.findLast((t) => t.agent === agentName);
  const instruments = Object.entries(INSTRUMENTS)
    .map(([k, v]) => `  ${k}: ${v.kind === 'drum' ? 'hits x/X' : `notes, MIDI ${v.range[0]}-${v.range[1]}`}. ${v.desc}`)
    .join('\n');
  const params = Object.entries(PARAMS)
    .map(([k, [lo, hi, d]]) => `${k} ${lo}..${hi} (default ${d})`)
    .join('; ');
  const whoseTurn = state.nextAgent === agentName ? 'It is YOUR turn.' : `It is ${state.nextAgent}'s turn, not yours.`;

  return [
    `# You are ${me.name}, the ${me.role} of ${meta.cast.band} (${meta.cast.scene}).`,
    `Taste: ${me.taste}. Anti-taste: ${me.anti_taste}. Your flaw (play it, don't announce it): ${me.flaw}.`,
    `Bandmates: ${mates}. You are an AI and the band knows it; never claim to be human.`,
    `Brief: ${meta.brief || '(none)'}`,
    '',
    `## Turn ${state.turns.length + 1} of ${totalTurns} (round ${state.round} of ${meta.rounds}). ${whoseTurn}`,
    state.destructiveRequired &&
      "**This turn must be destructive**: delete a layer, or change a layer's instrument or pattern (destructive quota: one turn in four).",
    myLast && `Your last move: ${moveLabel(myLast)} "${myLast.note}"`,
    '',
    '## Rules (enforced by the validator, not suggestions)',
    `- Exactly one operation: add a layer, change one layer, delete one layer${me.can_structure ? ', or change structure (bpm, swing, sections)' : ''}.`,
    `- Density cap: at most ${SONG_LIMITS.maxLayers} layers. Adding means someone else's part may have to go.`,
    `- Public note (${NOTE_LENGTH.join('-')} chars) must name the layer id, section or bandmate it responds to. No opening with praise.`,
    `- Private intent (${INTENT_LENGTH.join('-')} chars) goes in the confession booth: viewers see it, bandmates do not.`,
    "- Anyone may change or delete anyone's layer. Changing a layer's instrument or pattern takes it over (you become owner).",
    `- Song limits: bpm ${SONG_LIMITS.bpm.join('-')}, max ${SONG_LIMITS.maxBars} bars, ${SONG_LIMITS.maxSections} sections, 1-16 bars each. 1 bar = 1 pattern cycle.`,
    meta.forbidden?.bpm && `- Novelty rule for this song: bpm ${meta.forbidden.bpm.join('-')} is forbidden.`,
    '',
    '## Pattern syntax (one string = one bar)',
    ...PATTERN_HELP,
    '',
    '## Instruments',
    instruments,
    `## Layer fields: id (a-z0-9_), instrument, pattern, optional variants {section: pattern} (max ${SONG_LIMITS.maxVariants}), optional in: [section names] or "all", ${params}; delayTime one of ${DELAY_TIMES.join(', ')} beats.`,
    '',
    '## Current song',
    `\`\`\`json\n${JSON.stringify(state.song, null, 1)}\n\`\`\``,
    '',
    '## Latest notes from bandmates (you only see the last two)',
    lastNotes,
    '',
    ...(meta.condition === 'hearing'
      ? [
          "## What the last render sounded like (Ledger's DSP report; numbers, not taste)",
          formatReport(state.renders.at(-1)?.report),
          '',
        ]
      : []),
    '## Recently used in earlier songs',
    formatHistory(history),
    '',
    '## How to submit',
    `Write one JSON object to a file and run: node bin/music.mjs session turn ${runId} --agent ${agentName} --file <file>`,
    '{"op":"add"|"change"|"delete"|"structure", "layer":{...full layer...} (add/change), "id":"layer_id" (delete), "structure":{"bpm":..,"swing":..,"sections":[{"name":..,"bars":..}]} (structure), "note":"public", "intent":"private"}',
  ]
    .filter((line) => line !== false && line !== undefined && line !== null)
    .join('\n');
}
