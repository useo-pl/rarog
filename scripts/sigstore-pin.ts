/**
 * Does Sigstore still issue release certificates under the authority `rarog update` pins (`fulcioAuthority` in
 * `server/src/cli/update-provenance.ts`)? `rarog update` refuses every provenance whose signing certificate another
 * authority issued, so a new Fulcio certificate has to show here before releases are signed under it.
 *
 *   pnpm exec tsx scripts/sigstore-pin.ts <trusted_root.json>
 *
 * The file is Sigstore's trust root: one JSON object, or one per line (`gh attestation trusted-root` prints the public
 * instance and GitHub's). The script neither fetches it nor checks a signature on it.
 *
 * The pin is active when the chain of one authority starts with the pinned certificate (the certificate that issues
 * the signing certificates), that authority is valid at this moment and has no end date, the pinned certificate has
 * not expired, and no other authority of the same Fulcio (`uri`) that has not ended starts after it. Exit codes:
 * 0 active; 1 no authority issues under the pin, or it is not valid at this moment; 2 bad invocation or a file that is
 * no trust root; 3 Sigstore moves to another certificate (an end date on the pinned authority, or a newer authority
 * beside it).
 */
import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fulcioAuthority } from '../server/src/cli/update-provenance.ts';
import { isMainModule } from './lib/is-main.mjs';

/** What the trust root says about the pinned certificate. */
export type PinCheck =
  | { readonly kind: 'active'; readonly since: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'inactive' | 'moving' | 'unreadable'; readonly reason: string };

/** One certificate authority of a trust root, its times as written and in milliseconds. */
interface Authority {
  readonly uri: string;
  readonly chain: readonly Buffer[];
  readonly start: string;
  readonly startMs: number;
  readonly end?: string;
  readonly endMs?: number;
}

const USAGE = 'usage: pnpm exec tsx scripts/sigstore-pin.ts <trusted_root.json>';

/** The exit code of each {@link PinCheck} kind. */
const EXIT: Readonly<Record<PinCheck['kind'], number>> = {
  active: 0, missing: 1, inactive: 1, unreadable: 2, moving: 3,
};

/** What the pin does to `rarog update` and what to do about it, for every outcome but `active`. */
const REFUSES = 'rarog update refuses every release signed under another authority; pin the new intermediate'
  + ' (FULCIO_INTERMEDIATE in server/src/cli/update-provenance.ts) and name it in the notes of the release';
const MOVES = 'Sigstore moves to another certificate; pin the new intermediate (FULCIO_INTERMEDIATE in'
  + ' server/src/cli/update-provenance.ts) and name it in the notes of the release before releases are signed under'
  + ' it, or rarog update refuses them';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** An RFC 3339 time in milliseconds; `null` for anything else. */
function timeOf(value: unknown): number | null {
  if (typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** The trust roots in `text`: one JSON value, or one per non-empty line; `null` when it is neither. */
function trustRoots(text: string): unknown[] | null {
  try {
    return [JSON.parse(text) as unknown];
  } catch {
    // Several roots, one per line.
  }
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  if (lines.length === 0) return null;
  try {
    return lines.map((line) => JSON.parse(line) as unknown);
  } catch {
    return null;
  }
}

/** One authority entry of a trust root, or what is wrong with it. */
function authorityOf(entry: unknown): Authority | string {
  if (!isRecord(entry) || typeof entry.uri !== 'string' || !/^[\x21-\x7e]{1,200}$/u.test(entry.uri)) {
    return 'a certificate authority has no readable uri';
  }
  const { uri } = entry;
  const certificates = isRecord(entry.certChain) ? entry.certChain.certificates : undefined;
  if (!Array.isArray(certificates) || certificates.length === 0
    || !certificates.every((one: unknown) => isRecord(one) && typeof one.rawBytes === 'string')) {
    return `an authority of ${uri} has no certificate chain`;
  }
  const chain = (certificates as { rawBytes: string }[]).map((one) => Buffer.from(one.rawBytes, 'base64'));
  const validFor = isRecord(entry.validFor) ? entry.validFor : {};
  const startMs = timeOf(validFor.start);
  const endMs = validFor.end === undefined ? undefined : timeOf(validFor.end);
  if (startMs === null || endMs === null) return `an authority of ${uri} has no readable validFor`;
  const start = validFor.start as string;
  return endMs === undefined ? { uri, chain, start, startMs }
    : { uri, chain, start, startMs, end: validFor.end as string, endMs };
}

/** Every certificate authority of the trust roots in `text`, or what is wrong with the file. */
function authoritiesOf(text: string): Authority[] | string {
  const roots = trustRoots(text);
  if (roots === null) return 'it is not JSON';
  const all: Authority[] = [];
  for (const root of roots) {
    if (!isRecord(root) || !Array.isArray(root.certificateAuthorities)) return 'it has no certificateAuthorities';
    for (const entry of root.certificateAuthorities as unknown[]) {
      const authority = authorityOf(entry);
      if (typeof authority === 'string') return authority;
      all.push(authority);
    }
  }
  return all.length === 0 ? 'it lists no certificate authority' : all;
}

/** The end of the certificate `der` in milliseconds; `null` when it is no readable certificate. */
function certificateEnd(der: Buffer): number | null {
  try {
    const ms = Date.parse(new X509Certificate(der).validTo);
    return Number.isNaN(ms) ? null : ms;
  } catch {
    return null;
  }
}

/** What the trust root `text` says about the pinned certificate `pin` (DER) at `now`. */
export function checkPin(text: string, pin: Buffer, now: Date): PinCheck {
  const authorities = authoritiesOf(text);
  if (typeof authorities === 'string') return { kind: 'unreadable', reason: authorities };
  const pinned = authorities.find((authority) => authority.chain[0]?.equals(pin) === true);
  if (pinned === undefined) return { kind: 'missing' };
  const at = now.getTime();
  if (pinned.startMs > at) return { kind: 'inactive', reason: `the pinned authority starts on ${pinned.start}` };
  if (pinned.endMs !== undefined && pinned.endMs <= at) {
    return { kind: 'inactive', reason: `the pinned authority ended on ${pinned.end ?? ''}` };
  }
  const expires = certificateEnd(pin);
  if (expires === null) return { kind: 'unreadable', reason: 'the pinned certificate is not readable' };
  if (expires <= at) {
    return { kind: 'inactive', reason: `the pinned certificate expired on ${new Date(expires).toISOString()}` };
  }
  if (pinned.end !== undefined) return { kind: 'moving', reason: `the pinned authority ends on ${pinned.end}` };
  const [newer] = authorities
    .filter((one) => one !== pinned && one.uri === pinned.uri && one.startMs > pinned.startMs
      && (one.endMs === undefined || one.endMs > at))
    .sort((a, b) => a.startMs - b.startMs);
  if (newer !== undefined) {
    return { kind: 'moving', reason: `another authority of ${newer.uri} starts on ${newer.start}` };
  }
  return { kind: 'active', since: pinned.start };
}

/** The command: one trust root file, one line of output, the exit code of {@link EXIT}. */
export function main(argv: readonly string[], out: (line: string) => void, now = new Date()): number {
  const [file] = argv;
  if (argv.length !== 1 || file === undefined || file.startsWith('-')) {
    out(USAGE);
    return 2;
  }
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    out(`sigstore-pin: cannot read ${file} (${(error as NodeJS.ErrnoException).code ?? 'error'}); ${USAGE}`);
    return 2;
  }
  const check = checkPin(text, fulcioAuthority(), now);
  switch (check.kind) {
    case 'active':
      out(`sigstore-pin: the pinned Sigstore certificate authority is active (since ${check.since}); rarog update`
        + ' accepts releases signed under it');
      break;
    case 'missing':
      out(`sigstore-pin: no certificate authority in ${file} issues under the pinned certificate; ${REFUSES}`);
      break;
    case 'inactive':
      out(`sigstore-pin: ${check.reason}; ${REFUSES}`);
      break;
    case 'moving':
      out(`sigstore-pin: ${check.reason}; ${MOVES}`);
      break;
    case 'unreadable':
      out(`sigstore-pin: ${file} is no Sigstore trust root: ${check.reason}`);
      break;
  }
  return EXIT[check.kind];
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2), (line) => { process.stdout.write(`${line}\n`); });
}
