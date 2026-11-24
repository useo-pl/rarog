/**
 * The Claude Code version gate of the proof rule: on which releases a session counts the `channel` rule,
 * per request kind (main thread, subagent requests). The base is the package constant
 * {@link CONSENT_CHANNEL_MEASURED_CLI}: releases up to its `cli` except the exact releases in its `excluded`. The
 * canary file `<dataDir>/consent-canary.json` adds exact releases on which the canary command measured the contract
 * (`pass`) and takes away releases where it failed (`fail`).
 *
 * This module reads the file through the regular-file gate (`safe-read.ts`) and never writes it; the gate with
 * its log line is `createConsentProofGate` in `observe.ts`. Any doubt about the file gives the package base alone,
 * never more: no file, not a regular file (a symlink included), a mode other than `0600`, over
 * {@link CONSENT_CANARY_MAX_BYTES}, not JSON, a `format` other than 1, or a field outside the contract.
 */
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { compareCliVersions } from '../../../cli-version.ts';
import { readRegularFileSync } from '../../../safe-read.ts';
import { CONSENT_CHANNEL_MEASURED_CLI } from '../hook/contract.ts';
import type { ConsentProofRule } from './contract.ts';

/** The canary file in the data directory. */
export const CONSENT_CANARY_FILENAME = 'consent-canary.json';
/** The only `format` the server reads. */
export const CONSENT_CANARY_FORMAT = 1;
/** The only mode the server accepts: the file is written by the owner's canary command alone. */
export const CONSENT_CANARY_MODE = 0o600;
/** A larger file is ignored (one entry is about 100 bytes). */
export const CONSENT_CANARY_MAX_BYTES = 256 * 1024;

/** The result of one request kind on one release. */
export const CONSENT_CANARY_RESULTS = ['pass', 'fail', 'unmeasured'] as const;
export type ConsentCanaryResult = (typeof CONSENT_CANARY_RESULTS)[number];

/** Results of one release; a kind missing from the file entry is `unmeasured`. */
export interface ConsentCanaryEntry {
  readonly main: ConsentCanaryResult;
  readonly subagents: ConsentCanaryResult;
}

/** Why a file present under the name gives nothing: `mode-<octal>`, `io-<code>` or a fixed reason. */
export type ConsentCanaryIgnored =
  | 'not-regular' | 'too-large' | 'not-json' | 'format' | 'shape' | `mode-${string}` | `io-${string}`;

/** One read of the canary file. */
export type ConsentCanaryRead =
  | { readonly kind: 'absent' }
  | { readonly kind: 'ignored'; readonly why: ConsentCanaryIgnored }
  /** Exact releases from the file (keys as written, compared as strings). */
  | { readonly kind: 'read'; readonly versions: ReadonlyMap<string, ConsentCanaryEntry> };

export const CONSENT_CANARY_ABSENT: ConsentCanaryRead = { kind: 'absent' };

/** Proof rules of one session observation: main-thread requests and subagent requests. */
export interface ConsentProofRules {
  readonly main: ConsentProofRule;
  readonly subagents: ConsentProofRule;
}

export const CONSENT_SCREEN_RULES: ConsentProofRules = { main: 'screen', subagents: 'screen' };

/** The release shape of the CLI process registry (`cli-version.ts`); another string is an unknown release. */
const CLI_VERSION_SHAPE = /^\d{1,4}\.\d{1,5}\.\d{1,6}$/u;

const ignored = (why: ConsentCanaryIgnored): ConsentCanaryRead => ({ kind: 'ignored', why });

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function resultOf(value: unknown): ConsentCanaryResult | null {
  if (value === undefined) return 'unmeasured';
  return (CONSENT_CANARY_RESULTS as readonly unknown[]).includes(value) ? value as ConsentCanaryResult : null;
}

/**
 * The file text as one read: `{ format: 1, versions: { "<release>": { main?, subagents?, … } } }`. Other fields of
 * the top level and of an entry (`at`, `cases`) are not read. One field outside the contract (a release key outside
 * the shape, a result outside {@link CONSENT_CANARY_RESULTS}, an entry that is not an object) ignores the whole file.
 */
export function parseConsentCanary(text: string): ConsentCanaryRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return ignored('not-json');
  }
  if (!isObject(parsed)) return ignored('shape');
  if (parsed.format !== CONSENT_CANARY_FORMAT) return ignored('format');
  if (!isObject(parsed.versions)) return ignored('shape');
  const versions = new Map<string, ConsentCanaryEntry>();
  for (const [version, entry] of Object.entries(parsed.versions)) {
    if (!CLI_VERSION_SHAPE.test(version) || !isObject(entry)) return ignored('shape');
    const main = resultOf(entry.main);
    const subagents = resultOf(entry.subagents);
    if (main === null || subagents === null) return ignored('shape');
    versions.set(version, { main, subagents });
  }
  return { kind: 'read', versions };
}

/** The canary file of one data directory, read again only after it changes. */
export interface ConsentCanaryFile {
  /**
   * The current read. `lstat` at every call checks the type and the mode; the content is parsed again only when
   * the inode, the size, the `mtime` or the `ctime` changed since the last parse (`ctime` also moves when a write
   * keeps the size and puts the `mtime` back).
   */
  read(): ConsentCanaryRead;
}

function errnoOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z]{2,16}$/u.test(code) ? code : 'unknown';
}

export function createConsentCanaryFile(dataDir: string): ConsentCanaryFile {
  const path = join(dataDir, CONSENT_CANARY_FILENAME);
  let memory: { readonly stamp: string; readonly read: ConsentCanaryRead } | null = null;
  return {
    read() {
      let info;
      try {
        info = lstatSync(path, { bigint: true });
      } catch (error) {
        memory = null;
        const code = errnoOf(error);
        return code === 'ENOENT' ? CONSENT_CANARY_ABSENT : ignored(`io-${code}`);
      }
      if (!info.isFile()) return ignored('not-regular');
      const mode = Number(info.mode & 0o777n);
      if (mode !== CONSENT_CANARY_MODE) return ignored(`mode-${mode.toString(8)}`);
      const stamp = `${String(info.ino)}:${String(info.size)}:${String(info.mtimeNs)}:${String(info.ctimeNs)}`;
      if (memory?.stamp === stamp) return memory.read;
      let bytes;
      try {
        bytes = readRegularFileSync(path, { maxBytes: CONSENT_CANARY_MAX_BYTES, followSymlink: false });
      } catch (error) {
        return ignored(`io-${errnoOf(error)}`);
      }
      if (bytes === null) return ignored('not-regular');
      const read = bytes.truncated ? ignored('too-large') : parseConsentCanary(bytes.bytes.toString('utf8'));
      memory = { stamp, read };
      return read;
    },
  };
}

/**
 * The rule of one request kind on release `cliVersion` with the canary result `result` of that release and kind
 * (`null` = no entry, or no file read). First matching row wins:
 *
 * 1. configuration `screen` (`RAROG_CONSENT_PROOF`), or the release unknown (no single process of the session in the
 *    registry read, a string outside the release shape) → `screen`;
 * 2. `fail` → `screen`;
 * 3. the release in the package base (not above `cli` of {@link CONSENT_CHANNEL_MEASURED_CLI}, not in its
 *    `excluded`) → `channel`;
 * 4. `pass` → `channel`, also on an excluded release;
 * 5. the rest (`unmeasured`, no entry) → `screen`.
 *
 * MCP tools stay at `screen` in the request rule (`consentKeyRule`, `consentHiddenKeyRule` in `proof.ts`).
 */
export function consentProofRuleOf(
  configured: ConsentProofRule, cliVersion: string | undefined, result: ConsentCanaryResult | null,
): ConsentProofRule {
  if (configured !== 'channel' || cliVersion === undefined || !CLI_VERSION_SHAPE.test(cliVersion)) return 'screen';
  if (result === 'fail') return 'screen';
  if (inPackageBase(cliVersion)) return 'channel';
  return result === 'pass' ? 'channel' : 'screen';
}

/** Whether release `cliVersion` (in the release shape) is covered by {@link CONSENT_CHANNEL_MEASURED_CLI}. */
function inPackageBase(cliVersion: string): boolean {
  const { cli, excluded } = CONSENT_CHANNEL_MEASURED_CLI;
  return compareCliVersions(cliVersion, cli) <= 0
    && !excluded.some((release) => compareCliVersions(cliVersion, release) === 0);
}

/** The entry of release `cliVersion` in the read; `null` = none (no file read, no exact entry). */
export function consentCanaryEntry(
  canary: ConsentCanaryRead, cliVersion: string | undefined,
): ConsentCanaryEntry | null {
  if (canary.kind !== 'read' || cliVersion === undefined) return null;
  return canary.versions.get(cliVersion) ?? null;
}

/** {@link consentProofRuleOf} for both request kinds from one read of the canary file. */
export function consentProofRules(
  configured: ConsentProofRule, cliVersion: string | undefined, canary: ConsentCanaryRead,
): ConsentProofRules {
  const entry = consentCanaryEntry(canary, cliVersion);
  return {
    main: consentProofRuleOf(configured, cliVersion, entry?.main ?? null),
    subagents: consentProofRuleOf(configured, cliVersion, entry?.subagents ?? null),
  };
}

/** What the canary file said about release `cliVersion`, for the gate's log line (no content of the file). */
export function consentCanaryNote(canary: ConsentCanaryRead, cliVersion: string): string {
  if (canary.kind === 'absent') return 'no canary file';
  if (canary.kind === 'ignored') return `canary file ignored: ${canary.why}`;
  const entry = consentCanaryEntry(canary, cliVersion);
  return entry === null ? 'canary file: no entry' : `canary file: main=${entry.main}, subagents=${entry.subagents}`;
}
