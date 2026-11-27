/**
 * The provenance suffix of a Rarog pane label: `rt:<code>` for a terminal, `rc:<code><code>` for a
 * Claude pane, hex values written in Crockford base32 (lowercase, most significant bit first, the
 * last character padded with zero bits). Pure functions over strings, the writers and the closed
 * patterns side by side. What the values mean (terminal id, project key, tab label trace) lives in
 * `herdr/provenance.ts`, which reads and writes every pane label through this module.
 */

/** Crockford base32 in lowercase: digits and letters without `i`, `l`, `o`, `u`. */
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const CODE_CHAR = '[0-9a-hjkmnp-tv-z]';
const HEX_RE = /^[0-9a-f]+$/;

/** Hex digits of a terminal id and of a tab label trace. */
const TERM_ID_HEX = 16;
const TRACE_HEX = 8;
/** Characters of a project key code: the first 35 bits of the 64-bit key. */
export const PROJECT_KEY_CODE_LENGTH = 7;
const KEY_CODE_RE = new RegExp(`^${CODE_CHAR}{${String(PROJECT_KEY_CODE_LENGTH)}}$`);

/** Between the description and the suffix. */
const SEPARATOR = ' · ';

/** Characters of a code for `hexLength` hex digits: whole 5-bit characters. */
function codeLength(hexLength: number): number {
  return Math.ceil((hexLength * 4) / 5);
}

/** Lowercase hex → code; the last character is padded with zero bits. */
export function encodeHex(hex: string): string {
  if (!HEX_RE.test(hex)) throw new Error('Label code input is not lowercase hex.');
  const length = codeLength(hex.length);
  let value = BigInt(`0x${hex}`) << BigInt(length * 5 - hex.length * 4);
  const chars: string[] = [];
  for (let i = 0; i < length; i += 1) {
    chars.unshift(ALPHABET.charAt(Number(value & 31n)));
    value >>= 5n;
  }
  return chars.join('');
}

/**
 * Code → `hexLength` lowercase hex digits, or `null` for a code of another length, a character
 * outside the alphabet or padding bits other than zero (so a value has exactly one code).
 */
export function decodeCode(code: string, hexLength: number): string | null {
  const length = codeLength(hexLength);
  if (code.length !== length) return null;
  let value = 0n;
  for (const char of code) {
    const digit = ALPHABET.indexOf(char);
    if (digit < 0) return null;
    value = (value << 5n) | BigInt(digit);
  }
  const padding = BigInt(length * 5 - hexLength * 4);
  if ((value & ((1n << padding) - 1n)) !== 0n) return null;
  return (value >> padding).toString(16).padStart(hexLength, '0');
}

/** The code of a 16-hex project key as a Claude label carries it. */
export function keyCodeOf(key: string): string {
  return encodeHex(key).slice(0, PROJECT_KEY_CODE_LENGTH);
}

/** `rt:<13 characters>` — the whole terminal id, lossless. */
export function termLabelSuffix(id: string): string {
  if (id.length !== TERM_ID_HEX) throw new Error('Terminal id is not 16 hex digits.');
  return `rt:${encodeHex(id)}`;
}

/** `rc:<7 characters of the key><7 characters of the trace>` — the trace is lossless. */
export function claudeLabelSuffix(keyCode: string, trace: string): string {
  if (!KEY_CODE_RE.test(keyCode)) throw new Error('Project key code is not 7 label code characters.');
  if (trace.length !== TRACE_HEX) throw new Error('Tab label trace is not 8 hex digits.');
  return `rc:${keyCode}${encodeHex(trace)}`;
}

/** A captured description is valid when absent (bare format) or not blank. */
export function descriptionOk(description: string | undefined): boolean {
  return description === undefined || /\S/u.test(description);
}

/** `<description> · <suffix>`, or the bare suffix when the description is empty. */
export function joinLabel(description: string, suffix: string): string {
  return description === '' ? suffix : `${description}${SEPARATOR}${suffix}`;
}

/*
 * Closed patterns anchored at the end, with an optional leading description. The description is
 * captured and checked in code (at least one non-whitespace character), so a separator alone
 * stays foreign; one greedy group keeps the match linear on long labels.
 */
const TERM_LABEL_RE = new RegExp(`^(?:(.+)${SEPARATOR})?rt:(${CODE_CHAR}{${String(codeLength(TERM_ID_HEX))}})$`);
const CLAUDE_LABEL_RE = new RegExp(
  `^(?:(.+)${SEPARATOR})?rc:(${CODE_CHAR}{${String(PROJECT_KEY_CODE_LENGTH)}})`
  + `(${CODE_CHAR}{${String(codeLength(TRACE_HEX))}})$`,
);

/** The suffix read from a pane label: the terminal id and the trace back in hex, the key as its code. */
export type LabelSuffix =
  | { kind: 'term'; id: string }
  | { kind: 'claude'; keyCode: string; trace: string };

/** A pane label in the current format → its suffix, or `null` for anything outside the patterns. */
export function readLabelSuffix(label: string): LabelSuffix | null {
  const term = TERM_LABEL_RE.exec(label);
  if (term?.[2] !== undefined) {
    const id = descriptionOk(term[1]) ? decodeCode(term[2], TERM_ID_HEX) : null;
    return id === null ? null : { kind: 'term', id };
  }
  const claude = CLAUDE_LABEL_RE.exec(label);
  if (claude?.[2] !== undefined && claude[3] !== undefined) {
    const trace = descriptionOk(claude[1]) ? decodeCode(claude[3], TRACE_HEX) : null;
    return trace === null ? null : { kind: 'claude', keyCode: claude[2], trace };
  }
  return null;
}
