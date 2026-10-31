/**
 * Error types. Callers branch on the class, never on message text.
 *
 * - PatternError:    a pattern string can't be parsed.
 * - ValidationError: a song or layer breaks the allow-list (instruments, ranges, limits).
 * - RuleError:       a turn breaks a session rule (turn order, notes, quotas).
 * - LogIntegrityError: the hash chain of an event log doesn't verify.
 *
 * The first three are "the agent's fault" and are shown back to the agent so it can
 * fix its submission. LogIntegrityError means storage was tampered with and is fatal.
 */
export class PatternError extends Error {
  name = 'PatternError';
}

export class ValidationError extends Error {
  name = 'ValidationError';
}

export class RuleError extends Error {
  name = 'RuleError';
}

export class LogIntegrityError extends Error {
  name = 'LogIntegrityError';
}

/** @param {unknown} e @returns {boolean} true when the error should be reported to the submitting agent. */
export const isSubmissionError = (e) =>
  e instanceof PatternError || e instanceof ValidationError || e instanceof RuleError;
