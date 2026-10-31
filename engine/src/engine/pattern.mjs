/**
 * A small, original mini-notation for rhythmic patterns. It borrows the idea of
 * Tidal/Strudel mini-notation but shares no code with them (Strudel is AGPL).
 * Patterns are parsed into a tree and queried; nothing is ever evaluated.
 */
import { PatternError } from '../errors.mjs';

// Syntax (one pattern string = one bar / "cycle"):
//   a b c d      four equal steps
//   ~            rest
//   [a b]        a group that fits inside one step
//   <a b c>      alternation: one item per bar, cycling (bar 0 -> a, bar 1 -> b ...)
//   a*3          repeat inside its step (a a a squeezed into one step)
//   a?           plays on roughly half of the bars, chosen deterministically
//   a,b,c        inside [ ] or at top level: play at the same time (chords / stacks)
//   a:0.4        velocity 0..1 (default 0.8; X = accented drum hit = 1.0)

export const LIMITS = {
  maxChars: 240,
  maxDepth: 4,
  maxAtoms: 96,
  maxRepeat: 16,
  maxEventsPerBar: 64,
};

export { PatternError };

function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if ('[]<>,'.includes(c)) {
      out.push({ t: c, pos: i });
      i++;
      continue;
    }
    if (c === '*') {
      const m = /^\*(\d{1,2})/.exec(src.slice(i));
      if (!m) throw new PatternError(`'*' must be followed by a number at ${i}`);
      out.push({ t: '*', n: Number(m[1]), pos: i });
      i += m[0].length;
      continue;
    }
    if (c === '?') {
      out.push({ t: '?', pos: i });
      i++;
      continue;
    }
    const m = /^[A-Za-z0-9#~._:-]+/.exec(src.slice(i));
    if (!m) throw new PatternError(`unexpected character '${c}' at ${i}`);
    out.push({ t: 'atom', v: m[0], pos: i });
    i += m[0].length;
  }
  return out;
}

export function parse(src) {
  if (typeof src !== 'string') throw new PatternError('pattern must be a string');
  if (src.length > LIMITS.maxChars) throw new PatternError(`pattern longer than ${LIMITS.maxChars} chars`);
  const toks = tokenize(src);
  let p = 0,
    atoms = 0;
  const peek = () => toks[p];

  function parseStack(depth, closer) {
    if (depth > LIMITS.maxDepth) throw new PatternError(`nesting deeper than ${LIMITS.maxDepth}`);
    const seqs = [parseSeq(depth, closer)];
    while (peek() && peek().t === ',') {
      p++;
      seqs.push(parseSeq(depth, closer));
    }
    return seqs.length === 1 ? seqs[0] : { k: 'stack', items: seqs };
  }
  function parseSeq(depth, closer) {
    const items = [];
    while (peek() && peek().t !== ',' && peek().t !== closer) {
      if (closer === null && (peek().t === ']' || peek().t === '>')) throw new PatternError(`unmatched '${peek().t}'`);
      items.push(parseStep(depth));
    }
    if (!items.length) throw new PatternError('empty sequence');
    return { k: 'seq', items };
  }
  function parseStep(depth) {
    const tok = toks[p++];
    let node;
    if (tok.t === '[') {
      node = parseStack(depth + 1, ']');
      if (!peek() || peek().t !== ']') throw new PatternError(`missing ']' for '[' at ${tok.pos}`);
      p++;
    } else if (tok.t === '<') {
      const inner = parseSeq(depth + 1, '>');
      if (!peek() || peek().t !== '>') throw new PatternError(`missing '>' for '<' at ${tok.pos}`);
      p++;
      node = { k: 'alt', items: inner.items };
    } else if (tok.t === 'atom') {
      atoms++;
      if (atoms > LIMITS.maxAtoms) throw new PatternError(`more than ${LIMITS.maxAtoms} notes/hits`);
      node = parseAtom(tok);
    } else {
      throw new PatternError(`unexpected '${tok.t}' at ${tok.pos}`);
    }
    while (peek() && (peek().t === '*' || peek().t === '?')) {
      const m = toks[p++];
      if (m.t === '*') {
        if (m.n < 1 || m.n > LIMITS.maxRepeat) throw new PatternError(`*${m.n} out of range 1-${LIMITS.maxRepeat}`);
        node = { k: 'rep', n: m.n, item: node };
      } else node = { k: 'maybe', item: node, id: m.pos };
    }
    return node;
  }
  function parseAtom(tok) {
    const v = tok.v;
    if (v === '~') return { k: 'rest' };
    const [name, vel, extra] = v.split(':');
    if (extra !== undefined) throw new PatternError(`bad token '${v}'`);
    let velocity = name === 'X' ? 1.0 : 0.8;
    if (vel !== undefined) {
      velocity = Number(vel);
      if (!Number.isFinite(velocity) || velocity < 0 || velocity > 1) {
        throw new PatternError(`velocity in '${v}' must be 0..1`);
      }
    }
    return { k: 'atom', v: name, vel: velocity, pos: tok.pos };
  }

  const tree = parseStack(0, null);
  if (p !== toks.length) throw new PatternError(`unexpected '${toks[p].t}' at ${toks[p].pos}`);
  return tree;
}

// Deterministic hash -> [0,1)
export function hash01(...parts) {
  let h = 2166136261;
  for (const ch of parts.join('|')) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

// Returns events for one bar: {start, dur} as fractions of the bar, plus value + velocity.
export function query(tree, bar, seed = '') {
  const out = [];
  (function walk(node, start, span) {
    switch (node.k) {
      case 'rest':
        return;
      case 'atom':
        out.push({ start, dur: span, v: node.v, vel: node.vel });
        return;
      case 'seq': {
        const step = span / node.items.length;
        node.items.forEach((it, i) => walk(it, start + i * step, step));
        return;
      }
      case 'stack':
        node.items.forEach((it) => walk(it, start, span));
        return;
      case 'alt':
        walk(node.items[((bar % node.items.length) + node.items.length) % node.items.length], start, span);
        return;
      case 'rep': {
        const step = span / node.n;
        for (let i = 0; i < node.n; i++) walk(node.item, start + i * step, step);
        return;
      }
      case 'maybe':
        if (hash01(seed, node.id, bar, start.toFixed(6)) < 0.5) walk(node.item, start, span);
        return;
    }
  })(tree, 0, 1);
  if (out.length > LIMITS.maxEventsPerBar) {
    throw new PatternError(`more than ${LIMITS.maxEventsPerBar} events in bar ${bar}`);
  }
  return out.sort((a, b) => a.start - b.start);
}

export function atomsOf(tree) {
  const out = [];
  (function walk(n) {
    if (n.k === 'atom') out.push(n.v);
    else if (n.items) n.items.forEach(walk);
    else if (n.item) walk(n.item);
  })(tree);
  return out;
}

const NOTE_RE = /^([a-gA-G])(#|b|s)?(-?\d)$/;
const PC = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
export function noteToMidi(s) {
  const m = NOTE_RE.exec(s);
  if (!m) return null;
  let n = PC[m[1].toLowerCase()];
  if (m[2] === '#' || m[2] === 's') n += 1;
  if (m[2] === 'b') n -= 1;
  const midi = (Number(m[3]) + 1) * 12 + n;
  return midi >= 12 && midi <= 120 ? midi : null;
}
export const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);
