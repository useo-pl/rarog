/**
 * The CLI version gate of the proof rule with the canary file (`layer1/version-gate.ts`).
 *
 * Sentences this file guards:
 *
 * - the table of the rule per release V and request kind R (main thread, subagents), first matching row wins:
 *   `RAROG_CONSENT_PROOF=screen` or an MCP tool → `screen`; an entry of V with R = `fail` → `screen`; V not above the
 *   package constant and not on its exclusion list → `channel`; an entry of V with R = `pass` → `channel`; anything
 *   else (no entry, `unmeasured`, no file, a file that is not read) → `screen`; only exact releases from the file
 *   count;
 * - the package base per release, without a canary file and with the canary results it stands on: the measured
 *   release and the passed releases under it → `channel`, the excluded release and the release above → `screen`;
 * - any doubt about `<dataDir>/consent-canary.json` (not JSON, another format or shape, mode other than `0600`, not
 *   a regular file, a symlink, over the size cap) gives the package base, never more;
 * - the file is read again after it changes (memory by inode, size, `mtime` and `ctime`), so a new entry changes the
 *   rule of a live session without a restart;
 * - the gate logs one line when the rule of a session changes, and none for the package base;
 * - main thread `channel` and subagents `screen` in the same session observation;
 * - after a change of a kind's rule to `screen` no proof taken under `channel` gives that kind the approve button
 *   or a signature: neither an observation that ends later, nor a decision without a new observation, nor a change
 *   during the `deciding` write;
 * - a hidden proof keeps the rule of its own request: the full `screen` proof of a background MCP request stays after
 *   the subagents' change to `screen`;
 * - the rules now (`current`) are `screen` for both kinds before a session's first observation and after an
 *   observation with an unknown release.
 *
 * Dumps and the canary file lie in a test data dir; the cycle (answer files in memory), secret registry, gate and
 * observation are real, `ps` and the clock are stubs.
 */
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../src/herdr/dialogs/hook/canon.ts';
import { CONSENT_CHANNEL_MEASURED_CLI, HOOK_PENDING_DIRNAME } from '../src/herdr/dialogs/hook/contract.ts';
import type { HookCallDump } from '../src/herdr/dialogs/hook/contract.ts';
import type { ConsentCardView } from '../src/herdr/dialogs/layer1/cards.ts';
import { CONSENT_SECRET_BYTES } from '../src/herdr/dialogs/layer1/contract.ts';
import { createConsentCycle } from '../src/herdr/dialogs/layer1/cycle.ts';
import type { ConsentCycle, ConsentCycleIo } from '../src/herdr/dialogs/layer1/cycle.ts';
import {
  createConsentProofGate, createConsentTopLoss, observeConsentSession,
} from '../src/herdr/dialogs/layer1/observe.ts';
import type { ConsentProofGate } from '../src/herdr/dialogs/layer1/observe.ts';
import { consentHiddenKeyRule, consentKeyRule } from '../src/herdr/dialogs/layer1/proof.ts';
import type { ConsentSubagentFile } from '../src/herdr/dialogs/layer1/proof.ts';
import { createConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import type { ConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import { consentCardSha256 } from '../src/herdr/dialogs/layer1/sign.ts';
import type { ConsentScreenRead } from '../src/herdr/dialogs/layer1/top.ts';
import {
  CONSENT_CANARY_ABSENT, CONSENT_CANARY_FILENAME, CONSENT_CANARY_MAX_BYTES, createConsentCanaryFile,
  consentProofRules,
} from '../src/herdr/dialogs/layer1/version-gate.ts';
import type { ConsentCanaryRead, ConsentProofRules } from '../src/herdr/dialogs/layer1/version-gate.ts';
import type { RegistryEvidence } from '../src/herdr/dialogs/shadow/evidence.ts';
import type { ProcessLiveness } from '../src/herdr/dialogs/shadow/liveness.ts';
import { memoryIo } from './helpers/consent-memory-io.ts';

const SESSION = '00000000-0000-4000-9000-0000000030a1';
const OTHER_SESSION = '00000000-0000-4000-9000-0000000030a2';
const PROMPT = '00000000-0000-4000-9000-0000000030b1';
const AGENT = 'a5c0ffee0123456789';
const OTHER_AGENT = 'b6d1ffee0123456789';

const MEASURED = CONSENT_CHANNEL_MEASURED_CLI.cli;

/** A release `steps` patch versions above the measured one. */
function above(steps: number): string {
  const [major, minor, patch] = MEASURED.split('.').map(Number);
  return `${String(major)}.${String(minor)}.${String((patch ?? 0) + steps)}`;
}

const NEWER = above(1);
const NEWEST = above(2);
const OLDER = '2.1.300';

let clock = Date.parse('2026-11-14T12:00:00.000Z');
const now = (): number => clock;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rarog-gate-'));
  dirs.push(dir);
  return dir;
}

const canaryPath = (dir: string): string => join(dir, CONSENT_CANARY_FILENAME);

type Result = 'pass' | 'fail' | 'unmeasured';

/** The file as the canary command writes it: format 1, one entry per release, mode `0600`. */
function canaryText(versions: Record<string, { main?: Result; subagents?: Result }>): string {
  const entries = Object.fromEntries(Object.entries(versions).map(([version, entry]) => [version, {
    at: '2026-11-15T08:00:00Z', ...entry, cases: 11,
  }]));
  return `${JSON.stringify({ format: 1, versions: entries })}\n`;
}

function writeCanary(dir: string, text: string, mode = 0o600): void {
  writeFileSync(canaryPath(dir), text, { mode });
  chmodSync(canaryPath(dir), mode);
}

const waitingOn = (cliVersion: string | undefined, at = clock): RegistryEvidence =>
  ({ kind: 'waiting', dialog: 'permission', at, ...(cliVersion === undefined ? {} : { cliVersion }) });

const rules = (main: 'channel' | 'screen', subagents: 'channel' | 'screen'): ConsentProofRules => ({ main, subagents });
const BOTH_CHANNEL = rules('channel', 'channel');
const BOTH_SCREEN = rules('screen', 'screen');

/** One read of a fresh data dir with the file `text` (mode `mode`). */
function readOf(text: string, mode = 0o600): ConsentCanaryRead {
  const dir = dataDir();
  writeCanary(dir, text, mode);
  return createConsentCanaryFile(dir).read();
}

describe('canary file read', () => {
  it('no file → absent; a valid file → its exact releases; an entry without `subagents` → `unmeasured`', () => {
    const dir = dataDir();
    expect(createConsentCanaryFile(dir).read()).toEqual(CONSENT_CANARY_ABSENT);
    const read = readOf(canaryText({ [NEWER]: { main: 'pass', subagents: 'fail' }, [NEWEST]: { main: 'pass' } }));
    expect(read.kind).toBe('read');
    if (read.kind !== 'read') return;
    expect([...read.versions]).toEqual([
      [NEWER, { main: 'pass', subagents: 'fail' }],
      [NEWEST, { main: 'pass', subagents: 'unmeasured' }],
    ]);
  });

  it.each([
    ['not JSON', '{"format": 1, "versions": {', 'not-json'],
    ['another format', JSON.stringify({ format: 2, versions: {} }), 'format'],
    ['no format', JSON.stringify({ versions: {} }), 'format'],
    ['versions as a list', JSON.stringify({ format: 1, versions: [] }), 'shape'],
    ['top level as a list', JSON.stringify([]), 'shape'],
    ['a value outside the contract', JSON.stringify({ format: 1, versions: { [NEWER]: { main: 'PASS' } } }), 'shape'],
    ['a key outside the release shape', JSON.stringify({ format: 1, versions: { latest: { main: 'pass' } } }),
      'shape'],
    ['an entry that is not an object', JSON.stringify({ format: 1, versions: { [NEWER]: 'pass' } }), 'shape'],
  ])('%s → ignored (%s)', (_name, text, why) => {
    expect(readOf(text)).toEqual({ kind: 'ignored', why });
  });

  it.each([[0o644, 'mode-644'], [0o640, 'mode-640'], [0o400, 'mode-400'], [0o700, 'mode-700']])(
    'mode %o → ignored', (mode, why) => {
      expect(readOf(canaryText({ [NEWER]: { main: 'pass', subagents: 'pass' } }), mode))
        .toEqual({ kind: 'ignored', why });
    },
  );

  it('a symlink to a valid file, a directory under the name and a file over the cap → ignored', () => {
    const dir = dataDir();
    const target = join(dir, 'elsewhere.json');
    writeFileSync(target, canaryText({ [NEWER]: { main: 'pass', subagents: 'pass' } }), { mode: 0o600 });
    symlinkSync(target, canaryPath(dir));
    expect(createConsentCanaryFile(dir).read()).toEqual({ kind: 'ignored', why: 'not-regular' });
    const other = dataDir();
    mkdirSync(canaryPath(other));
    expect(createConsentCanaryFile(other).read()).toEqual({ kind: 'ignored', why: 'not-regular' });
    const padding = ' '.repeat(CONSENT_CANARY_MAX_BYTES);
    const padded = `${canaryText({ [NEWER]: { main: 'pass', subagents: 'pass' } })}${padding}`;
    expect(readOf(padded)).toEqual({ kind: 'ignored', why: 'too-large' });
  });

  it('an unchanged file is not parsed again; a rewritten file is read at the next call; a mode change counts at once',
    () => {
      const dir = dataDir();
      writeCanary(dir, canaryText({ [NEWER]: { main: 'unmeasured', subagents: 'unmeasured' } }));
      const file = createConsentCanaryFile(dir);
      const first = file.read();
      expect(file.read()).toBe(first);
      writeCanary(dir, canaryText({ [NEWER]: { main: 'pass', subagents: 'unmeasured' } }));
      utimesSync(canaryPath(dir), new Date(clock + 5_000), new Date(clock + 5_000));
      const second = file.read();
      expect(second.kind === 'read' ? second.versions.get(NEWER) : null)
        .toEqual({ main: 'pass', subagents: 'unmeasured' });
      chmodSync(canaryPath(dir), 0o644);
      expect(file.read()).toEqual({ kind: 'ignored', why: 'mode-644' });
      chmodSync(canaryPath(dir), 0o600);
      expect(file.read()).toEqual(second);
    });

  it('a rewrite of the same size with the `mtime` put back is read too (the `ctime` moves)', () => {
    const dir = dataDir();
    const fixed = new Date(Date.parse('2026-11-14T10:00:00.000Z'));
    writeCanary(dir, canaryText({ [NEWER]: { main: 'fail', subagents: 'fail' } }));
    utimesSync(canaryPath(dir), fixed, fixed);
    const file = createConsentCanaryFile(dir);
    expect(consentProofRules('channel', NEWER, file.read())).toEqual(BOTH_SCREEN);
    writeCanary(dir, canaryText({ [NEWER]: { main: 'pass', subagents: 'pass' } }));
    utimesSync(canaryPath(dir), fixed, fixed);
    expect(consentProofRules('channel', NEWER, file.read())).toEqual(BOTH_CHANNEL);
  });
});

describe('table "canary file": rule per release and request kind', () => {
  const read = (versions: Record<string, { main?: Result; subagents?: Result }>): ConsentCanaryRead =>
    readOf(canaryText(versions));

  it('`RAROG_CONSENT_PROOF=screen` → `screen`, also on a measured release and with a `pass` entry', () => {
    expect(consentProofRules('screen', MEASURED, CONSENT_CANARY_ABSENT)).toEqual(BOTH_SCREEN);
    expect(consentProofRules('screen', NEWER, read({ [NEWER]: { main: 'pass', subagents: 'pass' } })))
      .toEqual(BOTH_SCREEN);
  });

  it('an MCP tool → `screen` on a passed release, main thread and subagent', () => {
    const passed = consentProofRules('channel', NEWER, read({ [NEWER]: { main: 'pass', subagents: 'pass' } }));
    expect(passed).toEqual(BOTH_CHANNEL);
    expect(consentKeyRule(passed.main, { toolName: 'mcp__docs__guide' })).toBe('screen');
    expect(consentHiddenKeyRule(passed.subagents, { toolName: 'mcp__docs__guide' })).toBe('screen');
    expect(consentKeyRule(passed.main, { toolName: 'Write' })).toBe('channel');
    expect(consentHiddenKeyRule(passed.subagents, { toolName: 'Bash' })).toBe('channel');
  });

  it('an entry with `fail` → `screen` for that kind, also on the measured release', () => {
    expect(consentProofRules('channel', MEASURED, read({ [MEASURED]: { main: 'fail', subagents: 'pass' } })))
      .toEqual(rules('screen', 'channel'));
    expect(consentProofRules('channel', OLDER, read({ [OLDER]: { main: 'pass', subagents: 'fail' } })))
      .toEqual(rules('channel', 'screen'));
    expect(consentProofRules('channel', NEWER, read({ [NEWER]: { main: 'fail', subagents: 'pass' } })))
      .toEqual(rules('screen', 'channel'));
  });

  it('a release not above the package constant → `channel` without a file, without an entry and with `unmeasured`',
    () => {
      expect(consentProofRules('channel', MEASURED, CONSENT_CANARY_ABSENT)).toEqual(BOTH_CHANNEL);
      expect(consentProofRules('channel', OLDER, CONSENT_CANARY_ABSENT)).toEqual(BOTH_CHANNEL);
      expect(consentProofRules('channel', MEASURED, read({ [NEWER]: { main: 'pass' } }))).toEqual(BOTH_CHANNEL);
      expect(consentProofRules('channel', MEASURED, read({ [MEASURED]: { main: 'unmeasured' } })))
        .toEqual(BOTH_CHANNEL);
    });

  it('a release above the constant: `pass` → `channel` for that kind only', () => {
    expect(consentProofRules('channel', NEWER, read({ [NEWER]: { main: 'pass', subagents: 'unmeasured' } })))
      .toEqual(rules('channel', 'screen'));
    expect(consentProofRules('channel', NEWER, read({ [NEWER]: { main: 'pass', subagents: 'pass' } })))
      .toEqual(BOTH_CHANNEL);
  });

  it('the rest → `screen`: no entry, `unmeasured`, no file, an ignored file, an unknown release; an intermediate'
    + ' release does not inherit a later `pass`', () => {
    expect(consentProofRules('channel', NEWER, CONSENT_CANARY_ABSENT)).toEqual(BOTH_SCREEN);
    expect(consentProofRules('channel', NEWER, read({ [NEWER]: { main: 'unmeasured', subagents: 'unmeasured' } })))
      .toEqual(BOTH_SCREEN);
    expect(consentProofRules('channel', NEWER, read({ [NEWEST]: { main: 'pass', subagents: 'pass' } })))
      .toEqual(BOTH_SCREEN);
    expect(consentProofRules('channel', NEWER, { kind: 'ignored', why: 'mode-644' })).toEqual(BOTH_SCREEN);
    expect(consentProofRules('channel', undefined, read({ [NEWER]: { main: 'pass', subagents: 'pass' } })))
      .toEqual(BOTH_SCREEN);
    expect(consentProofRules('channel', 'next', CONSENT_CANARY_ABSENT)).toEqual(BOTH_SCREEN);
  });

  it('an ignored file gives the package base, never more: a `pass` above the constant and a `fail` on it are both'
    + ' dropped', () => {
    const text = canaryText({ [NEWER]: { main: 'pass', subagents: 'pass' }, [MEASURED]: { main: 'fail' } });
    const loose = readOf(text, 0o644);
    expect(loose).toEqual({ kind: 'ignored', why: 'mode-644' });
    expect(consentProofRules('channel', NEWER, loose)).toEqual(BOTH_SCREEN);
    expect(consentProofRules('channel', MEASURED, loose)).toEqual(BOTH_CHANNEL);
  });
});

describe('package base: the measured release and its exclusions, per release', () => {
  /** The canary results the package base stands on: one entry per release, as the canary command wrote them. */
  const MEASURED_RESULTS = {
    '2.1.325': { main: 'pass', subagents: 'pass' },
    '2.1.326': { main: 'pass', subagents: 'pass' },
    '2.1.327': { main: 'fail', subagents: 'unmeasured' },
    '2.1.328': { main: 'pass', subagents: 'pass' },
    '2.1.329': { main: 'pass', subagents: 'pass' },
    '2.1.330': { main: 'pass', subagents: 'pass' },
  } as const;

  it.each([
    ['2.1.325', 'channel', 'channel'],
    ['2.1.326', 'channel', 'channel'],
    ['2.1.327', 'screen', 'screen'],
    ['2.1.328', 'channel', 'channel'],
    ['2.1.329', 'channel', 'channel'],
    ['2.1.330', 'channel', 'channel'],
    ['2.1.331', 'screen', 'screen'],
  ] as const)('%s → `%s` for both kinds without a canary file, `%s` with the measured results',
    (release, withoutFile, withResults) => {
      expect(consentProofRules('channel', release, CONSENT_CANARY_ABSENT)).toEqual(rules(withoutFile, withoutFile));
      expect(consentProofRules('channel', release, readOf(canaryText(MEASURED_RESULTS))))
        .toEqual(rules(withResults, withResults));
    });

  it('an excluded release is outside the package base: its own canary entry decides it as above the constant', () => {
    const read = (main: Result, subagents: Result): ConsentCanaryRead =>
      readOf(canaryText({ '2.1.327': { main, subagents } }));
    expect(consentProofRules('channel', '2.1.327', read('pass', 'pass'))).toEqual(BOTH_CHANNEL);
    expect(consentProofRules('channel', '2.1.327', read('pass', 'unmeasured'))).toEqual(rules('channel', 'screen'));
    expect(consentProofRules('channel', '2.1.327', read('fail', 'pass'))).toEqual(rules('screen', 'channel'));
    expect(consentProofRules('channel', '2.1.327', read('fail', 'fail'))).toEqual(BOTH_SCREEN);
  });

  it('a `fail` in the file takes `channel` away from a release the package covers, for that kind', () => {
    expect(consentProofRules('channel', '2.1.330', readOf(canaryText({ '2.1.330': { main: 'fail' } }))))
      .toEqual(rules('screen', 'channel'));
    expect(consentProofRules('channel', '2.1.328', readOf(canaryText({ '2.1.328': { subagents: 'fail' } }))))
      .toEqual(rules('channel', 'screen'));
  });
});

describe('gate with the canary file (`createConsentProofGate`)', () => {
  function gateOf(dir: string | null, configured: 'channel' | 'screen' = 'channel') {
    const lines: string[] = [];
    const gate = createConsentProofGate({
      configured, log: (line) => { lines.push(line); },
      ...(dir === null ? {} : { canary: createConsentCanaryFile(dir) }),
    });
    return { gate, lines };
  }

  const line = (session: string, version: string, rule: ConsentProofRules, note: string): string =>
    `consent: session ${session} runs Claude Code ${version}: proof rule main=${rule.main},`
    + ` subagents=${rule.subagents} (measured ${MEASURED}; ${note})`;

  it('the measured release without a file → `channel`, no line; a higher one → `screen`, one line per session', () => {
    const { gate, lines } = gateOf(dataDir());
    expect(gate.ruleFor(SESSION, waitingOn(MEASURED))).toEqual(BOTH_CHANNEL);
    expect(gate.ruleFor(OTHER_SESSION, waitingOn(NEWER))).toEqual(BOTH_SCREEN);
    expect(gate.ruleFor(OTHER_SESSION, waitingOn(NEWER))).toEqual(BOTH_SCREEN);
    expect(lines).toEqual([line(OTHER_SESSION, NEWER, BOTH_SCREEN, 'no canary file')]);
  });

  it('the measured release with `main: fail` → main thread `screen`, subagents `channel`, one line', () => {
    const dir = dataDir();
    writeCanary(dir, canaryText({ [MEASURED]: { main: 'fail', subagents: 'unmeasured' } }));
    const { gate, lines } = gateOf(dir);
    expect(gate.ruleFor(SESSION, waitingOn(MEASURED))).toEqual(rules('screen', 'channel'));
    expect(lines).toEqual([
      line(SESSION, MEASURED, rules('screen', 'channel'), 'canary file: main=fail, subagents=unmeasured'),
    ]);
  });

  it('bad JSON and mode `0644` → the package base, with the reason in the line', () => {
    const broken = dataDir();
    writeCanary(broken, '{"format": 1, "versions": {');
    const bad = gateOf(broken);
    expect(bad.gate.ruleFor(SESSION, waitingOn(MEASURED))).toEqual(BOTH_CHANNEL);
    expect(bad.gate.ruleFor(OTHER_SESSION, waitingOn(NEWER))).toEqual(BOTH_SCREEN);
    expect(bad.lines).toEqual([line(OTHER_SESSION, NEWER, BOTH_SCREEN, 'canary file ignored: not-json')]);
    const loose = dataDir();
    writeCanary(loose, canaryText({ [NEWER]: { main: 'pass', subagents: 'pass' } }), 0o644);
    expect(gateOf(loose).gate.ruleFor(SESSION, waitingOn(NEWER))).toEqual(BOTH_SCREEN);
  });

  it('a file written while the session lives changes its rule at the next observation, without a restart, with a'
    + ' line per change', () => {
    const dir = dataDir();
    const { gate, lines } = gateOf(dir);
    expect(gate.ruleFor(SESSION, waitingOn(NEWER))).toEqual(BOTH_SCREEN);
    writeCanary(dir, canaryText({ [NEWER]: { main: 'pass', subagents: 'unmeasured' } }));
    expect(gate.ruleFor(SESSION, waitingOn(NEWER))).toEqual(rules('channel', 'screen'));
    expect(gate.ruleFor(SESSION, waitingOn(NEWER))).toEqual(rules('channel', 'screen'));
    writeCanary(dir, canaryText({ [NEWER]: { main: 'pass', subagents: 'pass' } }));
    utimesSync(canaryPath(dir), new Date(clock + 5_000), new Date(clock + 5_000));
    expect(gate.ruleFor(SESSION, waitingOn(NEWER))).toEqual(BOTH_CHANNEL);
    rmSync(canaryPath(dir));
    expect(gate.ruleFor(SESSION, waitingOn(NEWER))).toEqual(BOTH_SCREEN);
    expect(lines).toEqual([
      line(SESSION, NEWER, BOTH_SCREEN, 'no canary file'),
      line(SESSION, NEWER, rules('channel', 'screen'), 'canary file: main=pass, subagents=unmeasured'),
      line(SESSION, NEWER, BOTH_CHANNEL, 'canary file: main=pass, subagents=pass'),
      line(SESSION, NEWER, BOTH_SCREEN, 'no canary file'),
    ]);
  });

  it('a new session on a passed release logs where its rule comes from', () => {
    const dir = dataDir();
    writeCanary(dir, canaryText({ [NEWER]: { main: 'pass', subagents: 'pass' } }));
    const { gate, lines } = gateOf(dir);
    expect(gate.ruleFor(SESSION, waitingOn(NEWER))).toEqual(BOTH_CHANNEL);
    expect(lines).toEqual([line(SESSION, NEWER, BOTH_CHANNEL, 'canary file: main=pass, subagents=pass')]);
  });

  it('`RAROG_CONSENT_PROOF=screen` and an unknown release → `screen` without a line', () => {
    const dir = dataDir();
    writeCanary(dir, canaryText({ [NEWER]: { main: 'pass', subagents: 'pass' } }));
    const screen = gateOf(dir, 'screen');
    expect(screen.gate.ruleFor(SESSION, waitingOn(NEWER))).toEqual(BOTH_SCREEN);
    expect(screen.gate.ruleFor(SESSION, waitingOn(MEASURED))).toEqual(BOTH_SCREEN);
    expect(screen.lines).toEqual([]);
    const unknown = gateOf(dir);
    expect(unknown.gate.ruleFor(SESSION, waitingOn(undefined))).toEqual(BOTH_SCREEN);
    expect(unknown.gate.ruleFor(SESSION, { kind: 'unknown', why: 'writers' })).toEqual(BOTH_SCREEN);
    expect(unknown.lines).toEqual([]);
  });

  it('a gate without a canary file source keeps the package base', () => {
    const { gate } = gateOf(null);
    expect(gate.ruleFor(SESSION, waitingOn(MEASURED))).toEqual(BOTH_CHANNEL);
    expect(gate.ruleFor(SESSION, waitingOn(NEWER))).toEqual(BOTH_SCREEN);
  });
});

/** A server-start harness: secret registry, cycle with IO in memory and the gate wired as in `bootstrap/consent.ts`. */
interface Harness {
  readonly dir: string;
  readonly reg: ConsentRegistry;
  readonly cycle: ConsentCycle;
  readonly gate: ConsentProofGate;
  /** Lines of the gate's log. */
  readonly lines: string[];
  /** Lines of the cycle's log. */
  readonly cycleLines: string[];
  /** Card views the cycle sent to the devices (`onCard`). */
  readonly sent: ConsentCardView[];
  /** Answer files the cycle wrote (signed `allow` and `deny`, `release`). */
  readonly files: Map<string, string>;
}

/** `io`: overrides of the in-memory IO (e.g. a step inside the `deciding` record write). */
function harness(io: Partial<ConsentCycleIo> = {}): Harness {
  const dir = dataDir();
  const reg = createConsentRegistry({
    bootId: 'boot-gate', send: () => true, sessions: () => [SESSION], log: () => {}, now,
  });
  reg.setScope('all');
  const lines: string[] = [];
  const gate = createConsentProofGate({
    configured: 'channel', log: (line) => { lines.push(line); }, canary: createConsentCanaryFile(dir),
  });
  const files = new Map<string, string>();
  const cycleLines: string[] = [];
  const sent: ConsentCardView[] = [];
  const cycle = createConsentCycle({
    dataDir: dir, bootId: 'boot-gate', registry: reg, now, mode: () => 'all', io: { ...memoryIo(files), ...io },
    log: (line) => { cycleLines.push(line); }, onCard: (view) => { sent.push(view); },
    proofRules: (sessionId) => gate.current(sessionId),
  });
  return { dir, reg, cycle, gate, lines, cycleLines, sent, files };
}

let nextPid = 64_000;

function dumpOf(toolName: string, toolInput: Record<string, unknown>, agentId?: string): HookCallDump {
  const nonce = createHash('sha256').update(JSON.stringify([toolName, toolInput, agentId ?? null])).digest('hex')
    .slice(0, 32);
  nextPid += 1;
  return {
    key: `${PROMPT}-${nonce}`, sessionId: SESSION, promptId: PROMPT, pid: nextPid, startedAt: clock - 1_000,
    toolName, toolInput, cwd: '/tmp/projekt', at: clock - 900, inputSha256: canonicalSha256(toolInput),
    permissionMode: 'default', ...(agentId === undefined ? {} : { agentId }),
  };
}

function hookStarts(h: Harness, dump: HookCallDump): void {
  const path = join(h.dir, HOOK_PENDING_DIRNAME, SESSION, `${dump.key}.json`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(dump), { mode: 0o600 });
  expect(h.reg.register({
    key: dump.key, sessionId: dump.sessionId, promptId: dump.promptId,
    secret: randomBytes(CONSENT_SECRET_BYTES).toString('hex'), inputSha256: dump.inputSha256,
    cardSha256: consentCardSha256({
      sessionId: dump.sessionId, toolName: dump.toolName, toolInput: dump.toolInput, cwd: dump.cwd,
      agentId: dump.agentId ?? null, permissionMode: dump.permissionMode ?? null,
    }),
    pid: dump.pid, startedAt: dump.startedAt, ...(dump.agentId === undefined ? {} : { agentId: dump.agentId }),
  }).status).toBe(200);
}

/** The subagent run known to its end, no closure of the call, no background start and no end of the agent. */
const SETTLED: ConsentSubagentFile = {
  partial: false, toolUses: [], results: [], settled: true, caughtUp: true,
  agent: { launch: null, ends: [], settled: true },
};

/**
 * {@link SETTLED} with the agent's background start in the main file (the background-start condition of the `screen`
 * hidden rule).
 */
const BACKGROUND: ConsentSubagentFile = {
  ...SETTLED, agent: { launch: { at: clock - 5_000 }, ends: [], settled: true },
};

const ALIVE: ProcessLiveness = async (processes) => new Map(processes.map((proc) => [proc.pid, true]));

/**
 * One session observation as `observeConsent` in `bootstrap/consent.ts` runs it: the rules from the gate with this
 * registry read, mode `all` with the subagent facts and the hook list of Rarog alone.
 */
async function observe(
  h: Harness, registry: RegistryEvidence,
  extra: {
    readonly screen?: ConsentScreenRead; readonly liveness?: ProcessLiveness; readonly subagent?: ConsentSubagentFile;
  } = {},
): Promise<void> {
  await observeConsentSession(h.cycle, {
    dataDir: h.dir, sessionId: SESSION, liveness: extra.liveness ?? ALIVE, registry, transcript: null,
    screen: extra.screen ?? null, now, proofRule: h.gate.ruleFor(SESSION, registry),
    subagentTurns: async (requests) => requests.map(() => extra.subagent ?? SETTLED),
    hidden: {
      topLoss: createConsentTopLoss(), sessionHooks: async (_sid, dumps) => new Set(dumps.map((d) => d.key)),
    },
  });
}

const button = (h: Harness, key: string): unknown => {
  const view = h.cycle.card(SESSION, key);
  return view === null ? null : { state: view.state, canAllow: view.canAllow };
};

describe('one session: main thread `channel` and subagents `screen` from the canary file', () => {
  it(`${NEWER} with \`main: pass\`, \`subagents: unmeasured\` → the main-thread request has the button without the`
    + ' screen top, the subagent request does not; `subagents: pass` gives it the button too', async () => {
    const h = harness();
    writeCanary(h.dir, canaryText({ [NEWER]: { main: 'pass', subagents: 'unmeasured' } }));
    const main = dumpOf('Write', { file_path: '/tmp/projekt/notes.md', content: '# Notes\n' });
    const sub = dumpOf('Bash', { command: 'ls -la', description: 'List files' }, AGENT);
    hookStarts(h, main);
    hookStarts(h, sub);
    await observe(h, waitingOn(NEWER));
    expect(button(h, main.key)).toEqual({ state: 'pending', canAllow: true });
    expect(button(h, sub.key)).toEqual({ state: 'pending', canAllow: false });
    writeCanary(h.dir, canaryText({ [NEWER]: { main: 'pass', subagents: 'pass' } }));
    utimesSync(canaryPath(h.dir), new Date(clock + 5_000), new Date(clock + 5_000));
    clock += 1_000;
    await observe(h, waitingOn(NEWER));
    expect(button(h, main.key)).toEqual({ state: 'pending', canAllow: true });
    expect(button(h, sub.key)).toEqual({ state: 'pending', canAllow: true });
  });

  it(`${NEWER} without a canary file → neither request has the button without the screen top`, async () => {
    const h = harness();
    const main = dumpOf('Write', { file_path: '/tmp/projekt/notes.md', content: '# Notes 2\n' });
    const sub = dumpOf('Bash', { command: 'ls', description: 'List' }, AGENT);
    hookStarts(h, main);
    hookStarts(h, sub);
    await observe(h, waitingOn(NEWER));
    expect(button(h, main.key)).toEqual({ state: 'pending', canAllow: false });
    expect(button(h, sub.key)).toEqual({ state: 'pending', canAllow: false });
  });
});

describe('a change to `screen` takes away every proof taken under `channel`', () => {
  const REFUSED = { ok: false, error: 'card-changed', state: 'pending' };

  /** Both kinds on a passed release: a main-thread `Write` and a subagent `Bash`, each with a live hook. */
  function passedSession(io: Partial<ConsentCycleIo> = {}): { h: Harness; main: HookCallDump; sub: HookCallDump } {
    const h = harness(io);
    writeCanary(h.dir, canaryText({ [NEWER]: { main: 'pass', subagents: 'pass' } }));
    const main = dumpOf('Write', { file_path: '/tmp/projekt/plan.md', content: '# Plan\n' });
    const sub = dumpOf('Bash', { command: 'git status', description: 'Status' }, AGENT);
    hookStarts(h, main);
    hookStarts(h, sub);
    return { h, main, sub };
  }

  /** `mtime` = clock + `later`: two rewrites of the same size at one clock differ in it too. */
  function rewrite(h: Harness, main: Result, subagents: Result, later = 9_000): void {
    writeCanary(h.dir, canaryText({ [NEWER]: { main, subagents } }));
    utimesSync(canaryPath(h.dir), new Date(clock + later), new Date(clock + later));
  }

  it('an observation that took `channel` before a `fail` and ends after a newer `screen` verdict gives neither'
    + ' request the button, and `allow` writes no answer file', async () => {
    const { h, main, sub } = passedSession();
    let asked = (): void => {};
    const psAsked = new Promise<void>((resolve) => { asked = resolve; });
    let answer = (): void => {};
    const psAnswers = new Promise<void>((resolve) => { answer = resolve; });
    const slowPs: ProcessLiveness = async (processes, at) => {
      asked();
      await psAnswers;
      return ALIVE(processes, at);
    };
    // A: rules from the passed release, registry read at `clock`; it waits for `ps`.
    const first = observe(h, waitingOn(NEWER), { liveness: slowPs });
    await psAsked;
    rewrite(h, 'fail', 'fail');
    // B: rules `screen`, an older screen and registry read; it ends first, without the button.
    const older = clock - 50;
    await observe(h, waitingOn(NEWER, older), { screen: { text: 'user@host ~ % ', readStartedAt: older } });
    expect(button(h, main.key)).toEqual({ state: 'pending', canAllow: false });
    expect(button(h, sub.key)).toEqual({ state: 'pending', canAllow: false });
    // A ends with reads newer than B's verdict.
    answer();
    await first;
    expect(button(h, main.key)).toEqual({ state: 'pending', canAllow: false });
    expect(button(h, sub.key)).toEqual({ state: 'pending', canAllow: false });
    expect(await h.cycle.decide(SESSION, main.key, 'allow')).toEqual(REFUSED);
    expect(await h.cycle.decide(SESSION, sub.key, 'allow')).toEqual(REFUSED);
    expect([...h.files.keys()]).toEqual([]);
  });

  it('a `fail` written after the last observation takes the button at the next tick and view and refuses `allow`,'
    + ' without a new observation; the gate logs the change, the proof line names the rule', async () => {
    const { h, main, sub } = passedSession();
    await observe(h, waitingOn(NEWER));
    expect(button(h, main.key)).toEqual({ state: 'pending', canAllow: true });
    expect(button(h, sub.key)).toEqual({ state: 'pending', canAllow: true });
    rewrite(h, 'fail', 'fail');
    h.sent.length = 0;
    await h.cycle.tick();
    expect(h.sent.map((view) => [view.permId, view.canAllow])).toEqual(expect.arrayContaining([
      [main.key, false], [sub.key, false],
    ]));
    expect(h.cycleLines).toContain(`consent: proof of key ${main.key} missing: rule=screen`);
    expect(button(h, main.key)).toEqual({ state: 'pending', canAllow: false });
    expect(button(h, sub.key)).toEqual({ state: 'pending', canAllow: false });
    expect(await h.cycle.decide(SESSION, main.key, 'allow')).toEqual(REFUSED);
    expect(await h.cycle.decide(SESSION, sub.key, 'allow')).toEqual(REFUSED);
    expect([...h.files.keys()]).toEqual([]);
    expect(h.lines).toEqual([
      `consent: session ${SESSION} runs Claude Code ${NEWER}: proof rule main=channel, subagents=channel`
        + ` (measured ${MEASURED}; canary file: main=pass, subagents=pass)`,
      `consent: session ${SESSION} runs Claude Code ${NEWER}: proof rule main=screen, subagents=screen`
        + ` (measured ${MEASURED}; canary file: main=fail, subagents=fail)`,
    ]);
  });

  it('a `fail` for the subagents alone keeps the main-thread button and signs its `allow`', async () => {
    const { h, main, sub } = passedSession();
    await observe(h, waitingOn(NEWER));
    rewrite(h, 'pass', 'fail');
    expect(button(h, sub.key)).toEqual({ state: 'pending', canAllow: false });
    expect(button(h, main.key)).toEqual({ state: 'pending', canAllow: true });
    expect(await h.cycle.decide(SESSION, sub.key, 'allow')).toEqual(REFUSED);
    expect(await h.cycle.decide(SESSION, main.key, 'allow')).toEqual({ ok: true, state: 'sent' });
  });

  it('a background MCP subagent request took the full `screen` proof under `subagents: pass`: after `fail` it keeps'
    + ' the button and signs `allow`, while a `Bash` request of the same observation loses its `channel` proof',
  async () => {
    const h = harness();
    writeCanary(h.dir, canaryText({ [NEWER]: { main: 'pass', subagents: 'pass' } }));
    const mcp = dumpOf('mcp__docs__guide', { topic: 'index' }, AGENT);
    const bash = dumpOf('Bash', { command: 'git log', description: 'Log' }, OTHER_AGENT);
    hookStarts(h, mcp);
    hookStarts(h, bash);
    // An MCP request has the `screen` rule: it needs a registry not waiting for a permission dialog and a background
    // start.
    await observe(h, { kind: 'active', at: clock, cliVersion: NEWER }, { subagent: BACKGROUND });
    expect(button(h, mcp.key)).toEqual({ state: 'pending', canAllow: true });
    expect(button(h, bash.key)).toEqual({ state: 'pending', canAllow: true });
    rewrite(h, 'pass', 'fail');
    expect(button(h, mcp.key)).toEqual({ state: 'pending', canAllow: true });
    expect(button(h, bash.key)).toEqual({ state: 'pending', canAllow: false });
    expect(await h.cycle.decide(SESSION, bash.key, 'allow')).toEqual(REFUSED);
    expect(await h.cycle.decide(SESSION, mcp.key, 'allow')).toEqual({ ok: true, state: 'sent' });
    expect([...h.files.keys()].map((path) => basename(path))).toEqual([`${mcp.key}.json`]);
  });

  it('a `fail` written while the `deciding` record is written refuses the signature of the main thread and of the'
    + ' subagent, without an answer file', async () => {
    const records: string[] = [];
    let failWhileDeciding = (): void => {};
    const { h, main, sub } = passedSession({
      writeRecord: (_dir, record) => {
        records.push(record.state);
        if (record.state === 'deciding') failWhileDeciding();
      },
    });
    await observe(h, waitingOn(NEWER));
    expect(button(h, main.key)).toEqual({ state: 'pending', canAllow: true });
    expect(button(h, sub.key)).toEqual({ state: 'pending', canAllow: true });
    failWhileDeciding = () => { rewrite(h, 'pass', 'fail'); };
    expect(await h.cycle.decide(SESSION, sub.key, 'allow')).toEqual(REFUSED);
    failWhileDeciding = () => { rewrite(h, 'fail', 'fail', 10_000); };
    expect(await h.cycle.decide(SESSION, main.key, 'allow')).toEqual(REFUSED);
    // Each decision wrote `deciding`, then the record went back to `pending`.
    expect(records.filter((state) => state === 'deciding')).toHaveLength(2);
    expect(records.at(-1)).toBe('pending');
    expect(h.cycle.record(SESSION, main.key)).toMatchObject({ state: 'pending', decision: null });
    expect(h.cycle.record(SESSION, sub.key)).toMatchObject({ state: 'pending', decision: null });
    expect([...h.files.keys()]).toEqual([]);
  });
});

describe('the rules now (`ConsentProofGate.current`)', () => {
  it('before the first observation of a session → `screen` for both kinds, also with a `pass` file', () => {
    const dir = dataDir();
    writeCanary(dir, canaryText({ [NEWER]: { main: 'pass', subagents: 'pass' } }));
    const lines: string[] = [];
    const gate = createConsentProofGate({
      configured: 'channel', log: (line) => { lines.push(line); }, canary: createConsentCanaryFile(dir),
    });
    expect(gate.current(SESSION)).toEqual(BOTH_SCREEN);
    expect(gate.ruleFor(SESSION, waitingOn(MEASURED))).toEqual(BOTH_CHANNEL);
    expect(gate.current(OTHER_SESSION)).toEqual(BOTH_SCREEN);
    expect(lines).toEqual([]);
  });

  it('a known release replaced by an unknown one at the next observation → `screen` for both kinds', () => {
    const dir = dataDir();
    writeCanary(dir, canaryText({ [NEWER]: { main: 'pass', subagents: 'pass' } }));
    const gate = createConsentProofGate({ configured: 'channel', log: () => {}, canary: createConsentCanaryFile(dir) });
    expect(gate.ruleFor(SESSION, waitingOn(NEWER))).toEqual(BOTH_CHANNEL);
    expect(gate.current(SESSION)).toEqual(BOTH_CHANNEL);
    expect(gate.ruleFor(SESSION, waitingOn(undefined))).toEqual(BOTH_SCREEN);
    expect(gate.current(SESSION)).toEqual(BOTH_SCREEN);
    expect(gate.ruleFor(SESSION, waitingOn(NEWER))).toEqual(BOTH_CHANNEL);
    expect(gate.ruleFor(SESSION, { kind: 'unknown', why: 'writers' })).toEqual(BOTH_SCREEN);
    expect(gate.current(SESSION)).toEqual(BOTH_SCREEN);
  });
});
