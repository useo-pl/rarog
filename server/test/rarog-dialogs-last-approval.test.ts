/**
 * `rarog dialogs last-approval --since <time>`: a read-only check of the consent channel records
 * (`<dataDir>/consent-records/`). It prints the `decisionAt` of the newest device `allow` that reached `applied` at or
 * after `--since` (ISO time, exit 0), or exits 1. Desk decisions, releases, denials and records in a bad shape do not
 * count, and the command writes nothing.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli/main.ts';
import { CONSENT_RECORDS_DIRNAME, CONSENT_RECORD_VERSION } from '../src/herdr/dialogs/layer1/contract.ts';

const SINCE = Date.parse('2026-11-12T21:00:00.000Z');
const MINUTE = 60_000;
const SHA = 'a'.repeat(64);

let root: string;
let home: string;
let dataDir: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'rarog-last-approval-'));
  home = path.join(root, 'home');
  dataDir = path.join(home, '.local', 'share', 'rarog');
  mkdirSync(dataDir, { recursive: true });
});

let keyCounter = 0;

/** A record in the shape `layer1/records.ts` accepts, with the fields a test overrides. */
function record(overrides: Record<string, unknown>): Record<string, unknown> {
  keyCounter += 1;
  return {
    v: CONSENT_RECORD_VERSION,
    key: `toolu-${keyCounter.toString(16).padStart(32, '0')}`,
    sessionId: 'session-1',
    promptId: 'prompt-1',
    agentId: null,
    pid: 4242,
    hookStartedAt: SINCE - 10 * MINUTE,
    inputSha256: SHA,
    toolName: 'Bash',
    cardSha256: SHA,
    bootId: 'boot-1',
    state: 'applied',
    decision: 'allow',
    reasonId: null,
    decisionAt: SINCE + MINUTE,
    correlation: 'bound',
    toolUseId: 'toolu_1',
    cause: null,
    late: false,
    checkpoint: null,
    times: {
      pending: SINCE - 10 * MINUTE, deciding: SINCE + MINUTE, sent: SINCE + MINUTE, settled: SINCE + 2 * MINUTE,
    },
    ...overrides,
  };
}

/** Writes a record file under `<dir>/consent-records/<session>/<key>.json`; `raw` replaces the JSON text. */
function put(dir: string, entry: Record<string, unknown>, raw?: string): void {
  const sessionDir = path.join(dir, CONSENT_RECORDS_DIRNAME, String(entry['sessionId']));
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(path.join(sessionDir, `${String(entry['key'])}.json`), raw ?? `${JSON.stringify(entry)}\n`);
}

async function rarog(argv: string[], env: NodeJS.ProcessEnv = { HOME: home }): Promise<{
  code: number; stdout: string; stderr: string;
}> {
  let stdout = '';
  let stderr = '';
  const code = await main(argv, {
    stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; }, env, cwd: root,
  });
  return { code, stdout, stderr };
}

const since = (at: number): string[] => ['dialogs', 'last-approval', '--since', new Date(at).toISOString()];

/** Names, sizes, modes, modification times and contents of everything under `dir`. */
function digest(dir: string): string {
  const hash = createHash('sha256');
  const walk = (at: string): void => {
    for (const name of readdirSync(at).sort()) {
      const full = path.join(at, name);
      const stats = statSync(full);
      hash.update(`${path.relative(dir, full)}|${String(stats.size)}|${String(stats.mode)}|${String(stats.mtimeMs)}\n`);
      if (stats.isDirectory()) walk(full);
      else hash.update(readFileSync(full));
    }
  };
  hash.update(String(statSync(dir).mtimeMs));
  walk(dir);
  return hash.digest('hex');
}

describe('rarog dialogs last-approval: which record counts', () => {
  it('a device `allow` in `applied` with `decisionAt` after the moment → its time in ISO, exit 0', async () => {
    put(dataDir, record({ decisionAt: SINCE + MINUTE }));
    put(dataDir, record({ decisionAt: SINCE + 5 * MINUTE, sessionId: 'session-2' }));
    put(dataDir, record({ decisionAt: SINCE + 3 * MINUTE }));
    const result = await rarog(since(SINCE));
    expect(result).toEqual({ code: 0, stdout: `${new Date(SINCE + 5 * MINUTE).toISOString()}\n`, stderr: '' });
  });

  it('`decisionAt` exactly at the moment counts (not earlier than `--since`)', async () => {
    put(dataDir, record({ decisionAt: SINCE }));
    const result = await rarog(since(SINCE));
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`${new Date(SINCE).toISOString()}\n`);
  });

  it('`decisionAt` before the moment while the move to `applied` came after it → exit 1', async () => {
    put(dataDir, record({
      decisionAt: SINCE - MINUTE,
      times: { pending: SINCE - 10 * MINUTE, deciding: SINCE - MINUTE, sent: SINCE - MINUTE, settled: SINCE + MINUTE },
    }));
    const result = await rarog(since(SINCE));
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('No phone approval');
  });

  it('a desk decision, a release, a denial and a not yet applied `allow` are skipped → exit 1', async () => {
    put(dataDir, record({ state: 'settled-at-desk', deskDecision: 'allow', decision: 'allow' }));
    put(dataDir, record({ state: 'settled-at-desk', deskDecision: 'allow', decision: null, decisionAt: null }));
    put(dataDir, record({ state: 'applied', deskDecision: 'allow' }));
    put(dataDir, record({ state: 'released', decision: 'release' }));
    put(dataDir, record({ state: 'released', decision: 'release', releaseCause: 'desk-fallback' }));
    put(dataDir, record({ state: 'applied', decision: 'deny' }));
    put(dataDir, record({ state: 'sent' }));
    put(dataDir, record({ state: 'unknown' }));
    const result = await rarog(since(SINCE));
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
  });

  it('a record in a bad shape is skipped, a good one next to it still counts', async () => {
    put(dataDir, record({ decisionAt: SINCE + 9 * MINUTE, v: 2 }));
    put(dataDir, record({ decisionAt: SINCE + 8 * MINUTE }), '{"not": "json"');
    put(dataDir, record({ decisionAt: SINCE + 7 * MINUTE, pid: 'x' }));
    const misnamed = record({ decisionAt: SINCE + 6 * MINUTE });
    put(dataDir, { ...misnamed, key: `toolu-${'f'.repeat(32)}` }, JSON.stringify(misnamed));
    expect((await rarog(since(SINCE))).code).toBe(1);
    put(dataDir, record({ decisionAt: SINCE + 2 * MINUTE }));
    const result = await rarog(since(SINCE));
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`${new Date(SINCE + 2 * MINUTE).toISOString()}\n`);
  });

  it('no records directory, or no data directory at all → exit 1', async () => {
    expect((await rarog(since(SINCE))).code).toBe(1);
    const missing = path.join(root, 'nowhere');
    const result = await rarog([...since(SINCE), '--data-dir', missing]);
    expect(result.code).toBe(1);
    expect(() => statSync(missing)).toThrow();
  });
});

describe('rarog dialogs last-approval: data directory and side effects', () => {
  it('a custom data directory (`--data-dir`, `RAROG_DATA_DIR`) is the one read', async () => {
    const custom = path.join(root, 'custom-data');
    put(custom, record({ decisionAt: SINCE + 4 * MINUTE }));
    const expected = `${new Date(SINCE + 4 * MINUTE).toISOString()}\n`;
    expect((await rarog(since(SINCE))).code).toBe(1);
    const byFlag = await rarog([...since(SINCE), '--data-dir', custom]);
    expect(byFlag).toEqual({ code: 0, stdout: expected, stderr: '' });
    const byEnv = await rarog(since(SINCE), { HOME: home, RAROG_DATA_DIR: custom });
    expect(byEnv).toEqual({ code: 0, stdout: expected, stderr: '' });
  });

  it('writes nothing: the data directory has the same digest before and after', async () => {
    put(dataDir, record({ decisionAt: SINCE + MINUTE }));
    put(dataDir, record({ decisionAt: SINCE - MINUTE }));
    put(dataDir, record({}), 'garbage');
    const before = digest(root);
    expect((await rarog(since(SINCE))).code).toBe(0);
    expect((await rarog(since(SINCE + 10 * MINUTE))).code).toBe(1);
    expect(digest(root)).toBe(before);
  });
});

describe('rarog dialogs last-approval: invocation', () => {
  it('`--since` is required and must be a time → usage, 64', async () => {
    for (const argv of [
      ['dialogs', 'last-approval'],
      ['dialogs', 'last-approval', '--since'],
      ['dialogs', 'last-approval', '--since', 'yesterday'],
      ['dialogs', 'last-approval', '--since', new Date(SINCE).toISOString(), 'extra'],
      ['dialogs', 'last-approval', '--since', new Date(SINCE).toISOString(), '--key', 'k'],
      ['dialogs', 'off', '--since', new Date(SINCE).toISOString()],
    ]) {
      const result = await rarog(argv);
      expect(result.code, argv.join(' ')).toBe(64);
    }
  });

  it('`--since` with a day the calendar does not have → usage, 64; 29 February of a leap year counts', async () => {
    for (const value of ['2026-02-30T00:00:00Z', '2025-02-29T00:00:00Z', '2026-04-31T12:00:00Z', '2026-13-01T00:00:00Z',
      '2026-00-10T00:00:00Z', '2026-01-00T00:00:00Z', '2100-02-29T00:00:00Z']) {
      const result = await rarog(['dialogs', 'last-approval', '--since', value]);
      expect(result.code, value).toBe(64);
    }
    for (const value of ['2028-02-29T00:00:00Z', '2000-02-29T00:00:00Z']) {
      const result = await rarog(['dialogs', 'last-approval', '--since', value]);
      expect(result.code, value).toBe(1);
      expect(result.stderr).toBe(`No phone approval since ${new Date(value).toISOString()}.\n`);
    }
  });

  it('`dialogs --help` shows the subcommand', async () => {
    const result = await rarog(['dialogs', '--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('rarog dialogs last-approval --since <time> [--data-dir <dir>]');
  });
});
