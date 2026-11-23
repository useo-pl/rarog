/**
 * Consent canary push: one banner with the consent canary result of a Claude Code release and the main-thread rule
 * that holds after it (`buildConsentCanaryContent`): "passed"; "failed" or "not measured", with the Allow button only
 * while the dialog is on screen; or "not measured" with the Allow button also without it on a release the package
 * measured. The canary command on the owner's Mac writes `<dataDir>/consent-canary.json`, which the proof rule's
 * version gate reads (`layer1/version-gate.ts`); this module reads the same file through the caller's reader and never
 * writes it. It evaluates on every full read of the installed Claude Code release (`bootstrap/versions.ts`), without
 * a timer of its own, and sends through the same APNs sink as `version-changed`.
 *
 * Rules:
 *
 * - The push carries the release and its main-thread result (`main`) only. A release whose `main` differs from the
 *   last pushed one (a new entry, `unmeasured` → `pass`, `pass` → `fail`, …) gets one push; the same result from
 *   a new run gets none. The `subagents` result does not count.
 * - The body follows the gate's rule for that release and result (`consentProofRuleOf` with the configured rule),
 *   never "unchanged": a `fail` takes `channel` away also from a release that passed before or that the package
 *   measured.
 * - The pushed results live in `<dataDir>/consent-canary-pushed.json` (`{format: 1, pushed: {"<release>": "<main>"}}`,
 *   `0o600`, tmp+rename), written BEFORE the send: a restart never repeats a push, and a failed send or no receiver
 *   is not retried. A failed write sends nothing; the next read writes and sends.
 * - No pushed file (the first start) takes the current entries as pushed, without a push or a line; a file of another
 *   shape does the same with one line. A release that leaves the canary file leaves the pushed file too, so a new
 *   entry for it pushes again.
 * - A canary file the gate ignores (mode, type, size, shape) changes nothing; no canary file counts as no entries.
 * - Never throws. Reads, writes and sends go on one chain, in order.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { compareCliVersions } from '../cli-version.ts';
import type { ConsentProofRule } from '../herdr/dialogs/layer1/contract.ts';
import { CONSENT_CANARY_RESULTS, consentProofRuleOf } from '../herdr/dialogs/layer1/version-gate.ts';
import type { ConsentCanaryRead, ConsentCanaryResult } from '../herdr/dialogs/layer1/version-gate.ts';
import { readRegularFile } from '../safe-read.ts';
import { buildConsentCanaryContent } from './content.ts';
import type { PushContent, SendOutcome } from './content.ts';

/** Name of the state file in `dataDir`. */
export const CONSENT_CANARY_PUSHED_FILENAME = 'consent-canary-pushed.json';

/** Version of the state file. */
const FORMAT = 1;

/** Read ceiling of the state file, the same as the canary file's: one entry per release it lists. */
const PUSHED_MAX_BYTES = 256 * 1024;

/** The release shape of the canary file (`layer1/version-gate.ts`). */
const RELEASE_RE = /^\d{1,4}\.\d{1,5}\.\d{1,6}$/u;

const PREFIX = 'consent-canary:';

export interface ConsentCanaryPushOptions {
  readonly dataDir: string;
  /** One read of the canary file (`createConsentCanaryFile(dataDir).read`). */
  readonly readCanary: () => ConsentCanaryRead;
  /** The configured proof rule (`RAROG_CONSENT_PROOF`), the same the version gate gets. */
  readonly consentProof: ConsentProofRule;
  /** Push to the devices (`ApnsSink.send`); without an APNs channel the caller answers `no-receiver`. */
  readonly send: (content: PushContent) => Promise<SendOutcome>;
  readonly log: (line: string) => void;
}

export interface ConsentCanaryPush {
  /** One evaluation of the canary file. Never throws; the work goes onto one chain. */
  check(): void;
  /** Resolves when everything checked so far is done (tests). */
  idle(): Promise<void>;
}

type Results = ReadonlyMap<string, ConsentCanaryResult>;

const isResult = (value: unknown): value is ConsentCanaryResult =>
  (CONSENT_CANARY_RESULTS as readonly unknown[]).includes(value);

/** State file → pushed results; `null` = a file of another shape. */
function parsePushed(text: string): Map<string, ConsentCanaryResult> | null {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const pushed = record['pushed'];
  if (record['format'] !== FORMAT || typeof pushed !== 'object' || pushed === null || Array.isArray(pushed)) {
    return null;
  }
  const out = new Map<string, ConsentCanaryResult>();
  for (const [release, result] of Object.entries(pushed)) {
    if (!RELEASE_RE.test(release) || !isResult(result)) return null;
    out.set(release, result);
  }
  return out;
}

/** File system error code for the log line (no path, no content). */
const codeOf = (err: unknown): string => {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' ? code : 'error';
};

export function createConsentCanaryPush(options: ConsentCanaryPushOptions): ConsentCanaryPush {
  const file = join(options.dataDir, CONSENT_CANARY_PUSHED_FILENAME);
  /** Results already pushed; `null` = the state file not read yet. */
  let pushed: Results | null = null;
  let chain: Promise<void> = Promise.resolve();

  /** The stored results; `null` = none to trust (no file, or one line for a file of another shape). */
  const load = async (): Promise<Results | null> => {
    let text: string | null;
    try {
      // File gate: a FIFO, a device or a symlink under this name is an unreadable file, not a hung read.
      const read = await readRegularFile(file, { maxBytes: PUSHED_MAX_BYTES, followSymlink: false });
      text = read === null || read.truncated ? null : read.bytes.toString('utf8');
    } catch (err) {
      if (codeOf(err) === 'ENOENT') return null;
      text = null;
    }
    const parsed = text === null ? null : parsePushed(text);
    if (parsed === null) {
      options.log(`${PREFIX} ${CONSENT_CANARY_PUSHED_FILENAME} unreadable — starting over without a push`);
    }
    return parsed;
  };

  /** `false` = not written (one line); the caller keeps the old state and tries again at the next read. */
  const write = async (results: Results): Promise<boolean> => {
    const body = `${JSON.stringify({ format: FORMAT, pushed: Object.fromEntries(results) })}\n`;
    const tmp = join(options.dataDir, `.${CONSENT_CANARY_PUSHED_FILENAME}.${randomBytes(6).toString('hex')}.tmp`);
    try {
      await mkdir(options.dataDir, { recursive: true, mode: 0o700 });
      await writeFile(tmp, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(tmp, file);
      return true;
    } catch (err) {
      await unlink(tmp).catch(() => undefined);
      options.log(`${PREFIX} ${CONSENT_CANARY_PUSHED_FILENAME} not written (${codeOf(err)})`);
      return false;
    }
  };

  const evaluate = async (): Promise<void> => {
    const canary = options.readCanary();
    if (canary.kind === 'ignored') return;
    const current = new Map<string, ConsentCanaryResult>();
    if (canary.kind === 'read') {
      for (const [release, entry] of canary.versions) current.set(release, entry.main);
    }
    if (pushed === null) {
      const stored = await load();
      if (stored === null) {
        // The first start, or a broken file: what the canary file says now counts as pushed.
        if (await write(current)) pushed = current;
        return;
      }
      pushed = stored;
    }
    const before = pushed;
    const changes = [...current]
      .filter(([release, result]) => before.get(release) !== result)
      .sort(([a], [b]) => compareCliVersions(a, b));
    const dropped = [...before.keys()].some((release) => !current.has(release));
    if (changes.length === 0 && !dropped) return;
    // The record goes first: a restart after this point never sends the same result again.
    if (!(await write(current))) return;
    pushed = current;
    for (const [release, result] of changes) {
      let outcome: SendOutcome;
      try {
        const rule = consentProofRuleOf(options.consentProof, release, result);
        outcome = await options.send(buildConsentCanaryContent(release, result, rule));
      } catch {
        outcome = 'failed';
      }
      options.log(`${PREFIX} Claude Code ${release} main=${result} (push: ${outcome})`);
    }
  };

  return {
    check() {
      chain = chain.then(evaluate).catch((err: unknown) => {
        options.log(`${PREFIX} internal error — ${(err as Error).message}`);
      });
    },
    idle: () => chain,
  };
}
