/**
 * Shared JSDoc types. This module exports no runtime values.
 *
 * @typedef {object} Section
 * @property {string} name  lower-case id, e.g. "groove"; may repeat in a song
 * @property {number} bars  1..16
 *
 * @typedef {object} Layer
 * @property {string} id
 * @property {string} instrument            a key of INSTRUMENTS
 * @property {string} pattern               mini-notation for one bar
 * @property {Record<string,string>} [variants]  per-section pattern overrides
 * @property {string[]|'all'} [in]          sections the layer plays in (default: all)
 * @property {string} [owner]               agent who last wrote the pattern
 * @property {number} [gain]
 * @property {number} [pan]
 * @property {number} [lpf]
 * @property {number} [hpf]
 * @property {number} [decay]
 * @property {number} [delay]
 * @property {number} [reverb]
 * @property {number} [delayTime]           in beats
 *
 * @typedef {object} Song
 * @property {string} [title]
 * @property {number} bpm
 * @property {number} [swing]
 * @property {Section[]} sections
 * @property {Layer[]} layers
 *
 * @typedef {object} Agent
 * @property {string} name
 * @property {string} role
 * @property {string} taste
 * @property {string} anti_taste
 * @property {string} flaw
 * @property {boolean} can_structure
 *
 * @typedef {object} Cast
 * @property {string} band
 * @property {string} scene
 * @property {Agent[]} agents
 *
 * @typedef {'add'|'change'|'delete'|'structure'} Op
 * @typedef {'add'|'edit'|'replace'|'delete'|'structure'} TurnKind
 *
 * @typedef {object} Submission  what an agent sends for one turn
 * @property {Op} op
 * @property {Layer} [layer]
 * @property {string} [id]
 * @property {Partial<Song>} [structure]
 * @property {string} note    public, to the band
 * @property {string} intent  private, for viewers only
 *
 * @typedef {object} LogEvent
 * @property {number} seq
 * @property {string} ts
 * @property {string} prev   hash of the previous event, or "genesis"
 * @property {string} type   session.created | turn.accepted | turn.rejected | render | session.finalized
 * @property {string} agent
 * @property {any} data
 * @property {string} hash
 */
export {};
