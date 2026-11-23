/**
 * Kanał cienia po stronie serwera (`server/src/herdr/dialogs/shadow/channel.ts`, `files.ts`, `liveness.ts`): plik
 * cienia przed klawiszem, wyścig `.claimed` / `.revoked`, cykl `decisions/` i jego odtworzenie po restarcie
 * serwera, sprzątanie startu (`sweep.ts`). Zegar i harmonogram obserwacji są wstrzyknięte, więc testy jednostkowe
 * nie czekają. Dwa testy biegną z prawdziwym procesem: `ps` wobec żywego procesu i pełny cykl z hookiem
 * `scripts/hooks/rarog-pending.mjs`.
 * Opis: `docs/dialogs.md`, „Server in shadow mode”.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import {
  mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../src/herdr/dialogs/hook/canon.ts';
import {
  HOOK_ALIVE_FILENAME, HOOK_CHANNEL_MODE_SHADOW, HOOK_PENDING_DIRNAME, HOOK_SHADOW_CLAIMED_SUFFIX,
  HOOK_SHADOW_DIRNAME, HOOK_SHADOW_LOG_FILENAME, HOOK_SHADOW_REVOKED_SUFFIX,
} from '../src/herdr/dialogs/hook/contract.ts';
import type { HookAliveFile, HookCallDump, HookShadowFile } from '../src/herdr/dialogs/hook/contract.ts';
import { createAliveWriter } from '../src/herdr/dialogs/shadow/alive.ts';
import { SHADOW_REVOKE_AFTER_MS, createShadowChannel } from '../src/herdr/dialogs/shadow/channel.ts';
import type { ShadowChannel, ShadowReleaseRequest, ShadowRequest } from '../src/herdr/dialogs/shadow/channel.ts';
import {
  SHADOW_DECISIONS_DIRNAME, readCallDumps, readDecisions, revokeShadowFile, shadowFileState, writeDecision,
  writeShadowFile,
} from '../src/herdr/dialogs/shadow/files.ts';
import type { ShadowDecisionRecord } from '../src/herdr/dialogs/shadow/files.ts';
import {
  EXEC_LAG_MAX_MS, describePsFinding, livenessFromPs, parseElapsed, psFindings, psLiveness, START_TOLERANCE_MS,
} from '../src/herdr/dialogs/shadow/liveness.ts';
import type { ProcessLiveness } from '../src/herdr/dialogs/shadow/liveness.ts';
import { REGISTRY_SLACK_MS } from '../src/herdr/dialogs/shadow/evidence.ts';
import {
  DECISION_RETENTION_MS, ORPHAN_DUMP_MAX_AGE_MS, SHADOW_FILE_TTL_MS, rotateAliveLog, rotateShadowLog,
  sweepShadowFiles,
} from '../src/herdr/dialogs/shadow/sweep.ts';
import { ALIVE_LOG_FILENAME } from '../src/herdr/dialogs/shadow/alive-log.ts';

const SESSION = '550e8400-e29b-41d4-a716-446655440000';
const OTHER = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const PROMPT = 'fb908934-26eb-4419-9e30-8adcd4ed356b';
const NOW = 1_800_000_000_000;
const INPUT = { command: 'ls -la', description: 'List' };
const T = { timeout: 3_000 };

const dirs: string[] = [];
const children = new Set<ChildProcess>();
afterAll(() => {
  for (const child of children) child.kill('SIGKILL');
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rarog-cien-kanal-'));
  dirs.push(dir);
  return dir;
}

let nonce = 0;
function dump(over: Partial<HookCallDump> = {}): HookCallDump {
  nonce += 1;
  const toolInput = over.toolInput ?? INPUT;
  return {
    key: `${PROMPT}-${nonce.toString(16).padStart(32, '0')}`,
    sessionId: SESSION, promptId: PROMPT, pid: 4_000 + nonce, startedAt: NOW - 20_000, toolName: 'Bash', toolInput,
    cwd: '/projekt', at: NOW - 10_000, inputSha256: canonicalSha256(toolInput),
    ...over,
  };
}

/** Zrzut per wywołanie tak, jak go zostawia hook; `raw` = dosłowna treść pliku. */
function putDump(dir: string, d: HookCallDump, raw?: string, name = `${d.key}.json`): HookCallDump {
  const sessionDir = join(dir, HOOK_PENDING_DIRNAME, d.sessionId);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, name), raw ?? JSON.stringify(d));
  return d;
}

const shadowDir = (dir: string, sid = SESSION): string => join(dir, HOOK_SHADOW_DIRNAME, sid);
const shadowListing = (dir: string): string[] => {
  try {
    return readdirSync(shadowDir(dir)).sort();
  } catch {
    return [];
  }
};
/** Przejęcie pliku jak w hooku: `rename` `.json` → `.claimed`. Rzuca, gdy pliku już nie ma. */
const hookClaims = (dir: string, key: string): void => {
  renameSync(join(shadowDir(dir), `${key}.json`), join(shadowDir(dir), `${key}${HOOK_SHADOW_CLAIMED_SUFFIX}`));
};
const recordOf = (dir: string, key: string): ShadowDecisionRecord | undefined =>
  readDecisions(dir).find((r) => r.key === key);

function request(over: Partial<ShadowRequest> = {}): ShadowRequest {
  return {
    engineSessionId: SESSION,
    decision: 'allow',
    card: { toolName: 'Bash', callPrint: null },
    registry: { kind: 'waiting', dialog: 'permission', at: NOW - 100 },
    screen: null,
    transcript: [{ toolName: 'Bash', input: INPUT }],
    ...over,
  };
}

interface Harness {
  readonly dir: string;
  readonly channel: ShadowChannel;
  readonly logs: string[];
  /** Odpowiedź `ps` dla każdego pidu. */
  readonly life: { alive: boolean | null };
  readonly tasks: (() => void)[];
  advance(ms: number): void;
  /** Najstarsze zaplanowane zadanie i czekanie na jego skutki. */
  tick(): Promise<void>;
}

function harness(opts: { dir?: string; liveness?: ProcessLiveness; bootId?: string; at?: number } = {}): Harness {
  const dir = opts.dir ?? dataDir();
  const clock = { now: opts.at ?? NOW };
  const tasks: (() => void)[] = [];
  const logs: string[] = [];
  const life: { alive: boolean | null } = { alive: true };
  const channel = createShadowChannel({
    dataDir: dir, bootId: opts.bootId ?? 'boot-1', now: () => clock.now,
    liveness: opts.liveness ?? ((procs) => Promise.resolve(new Map(procs.map((p) => [p.pid, life.alive])))),
    log: (line) => logs.push(line),
    schedule: (fn) => { tasks.push(fn); },
    watchDelaysMs: [100, 200, 61_000],
  });
  return {
    dir, channel, logs, life, tasks,
    advance: (ms) => { clock.now += ms; },
    tick: async () => {
      const fn = tasks.shift();
      if (fn === undefined) throw new Error('brak zaplanowanego zadania');
      fn();
      await channel.settled();
    },
  };
}

describe('pliki cienia: zapis, odczyt zrzutów, wyścig `.claimed` / `.revoked`', T, () => {
  it('plik cienia: zapis atomowy, prawa 0600, sam `<klucz>.json` w katalogu sesji', () => {
    const dir = dataDir();
    const d = dump();
    const file: HookShadowFile = {
      key: d.key, sessionId: SESSION, decision: 'allow', inputSha256: d.inputSha256, at: 1,
    };
    writeShadowFile(dir, file);
    expect(shadowListing(dir)).toEqual([`${d.key}.json`]);
    expect(JSON.parse(readFileSync(join(shadowDir(dir), `${d.key}.json`), 'utf8'))).toEqual(file);
    expect(statSync(join(shadowDir(dir), `${d.key}.json`)).mode & 0o777).toBe(0o600);
    expect(() => writeShadowFile(dir, { ...file, key: '../x' })).toThrow();
    expect(() => writeShadowFile(dir, { ...file, sessionId: '../x' })).toThrow();
  });

  it('zrzuty per wywołanie: poprawne po `at`; cudza sesja, zła nazwa, zły JSON i plik tymczasowy pominięte', () => {
    const dir = dataDir();
    expect(readCallDumps(dir, SESSION)).toEqual([]);
    const late = putDump(dir, dump({ at: NOW - 1_000 }));
    const early = putDump(dir, dump({ at: NOW - 9_000 }));
    putDump(dir, dump(), JSON.stringify({ ...dump(), sessionId: OTHER }));
    const renamed = dump();
    putDump(dir, renamed, undefined, `${dump().key}.json`);
    const broken = dump();
    putDump(dir, broken, '{"key":');
    const tmp = dump();
    putDump(dir, tmp, undefined, `.${tmp.key}.json.abc.tmp`);
    const noSha = dump();
    const { inputSha256: _, ...withoutSha } = noSha;
    putDump(dir, noSha, JSON.stringify(withoutSha));
    expect(readCallDumps(dir, SESSION).map((d) => d.key)).toEqual([early.key, late.key]);
    expect(readCallDumps(dir, SESSION)[0]).toEqual(early);
    expect(readCallDumps(dir, '../etc')).toEqual([]);
  });

  it('wyścig: hook przejmuje pierwszy → odwołanie oddaje `claimed`, `.claimed` zostaje', () => {
    const dir = dataDir();
    const d = dump();
    writeShadowFile(dir, { key: d.key, sessionId: SESSION, decision: 'allow', inputSha256: d.inputSha256, at: 1 });
    hookClaims(dir, d.key);
    expect(revokeShadowFile(dir, SESSION, d.key)).toBe('claimed');
    expect(shadowListing(dir)).toEqual([`${d.key}${HOOK_SHADOW_CLAIMED_SUFFIX}`]);
    expect(shadowFileState(dir, SESSION, d.key).state).toBe('claimed');
  });

  it('wyścig: serwer odwołuje pierwszy → hook nie ma czego przejąć, `.revoked` zostaje', () => {
    const dir = dataDir();
    const d = dump();
    writeShadowFile(dir, { key: d.key, sessionId: SESSION, decision: 'deny', inputSha256: d.inputSha256, at: 1 });
    expect(revokeShadowFile(dir, SESSION, d.key)).toBe('revoked');
    expect(() => { hookClaims(dir, d.key); }).toThrow(/ENOENT/);
    expect(shadowListing(dir)).toEqual([`${d.key}${HOOK_SHADOW_REVOKED_SUFFIX}`]);
    expect(shadowFileState(dir, SESSION, d.key).state).toBe('revoked');
    expect(revokeShadowFile(dir, SESSION, dump().key)).toBe('gone');
  });

  it('`ps`: `etime` w sekundach, życie z pidu i czasu startu, pid bez linii = martwy', () => {
    expect(parseElapsed('05')).toBeNull();
    expect(parseElapsed('01:05')).toBe(65);
    expect(parseElapsed('2:01:05')).toBe(7_265);
    expect(parseElapsed('3-02:01:05')).toBe(3 * 86_400 + 7_265);
    expect(parseElapsed('x')).toBeNull();
    const procs = [
      { pid: 10, startedAt: NOW - 65_000 },
      { pid: 11, startedAt: NOW - 5_000 },
      { pid: 12, startedAt: NOW - 1_000 },
      { pid: 13, startedAt: NOW },
    ];
    const out = livenessFromPs('   10 01:05\n   11 01:05\n   13 ??:??\n', procs, NOW);
    expect([...out]).toEqual([[10, true], [11, false], [12, false], [13, null]]);
  });

  it('`ps`: a hook whose Node runtime started seconds after exec is alive; a start after `startedAt` is not', () => {
    // Process start from `ps` is NOW - 10 s; the hook's own `startedAt` trails it by the exec lag.
    const procs = [
      { pid: 20, startedAt: NOW - 6_500 },
      { pid: 21, startedAt: NOW - 10_000 + EXEC_LAG_MAX_MS + START_TOLERANCE_MS },
      { pid: 22, startedAt: NOW - 10_000 + EXEC_LAG_MAX_MS + START_TOLERANCE_MS + 1 },
      { pid: 23, startedAt: NOW - 10_000 - START_TOLERANCE_MS },
      { pid: 24, startedAt: NOW - 10_000 - START_TOLERANCE_MS - 1 },
    ];
    const out = livenessFromPs(procs.map((p) => `   ${String(p.pid)} 00:10`).join('\n'), procs, NOW);
    expect([...out]).toEqual([[20, true], [21, true], [22, false], [23, true], [24, false]]);
  });

  it('`ps` finding: each dead case names pid, the hook start, the `ps` start, the difference and the bound', () => {
    // Process start from `ps` is NOW - 10 s for every pid with a line.
    const psStart = new Date(NOW - 10_000).toISOString();
    const late = { pid: 30, startedAt: NOW - 10_000 - START_TOLERANCE_MS - 500 };
    const early = { pid: 31, startedAt: NOW - 10_000 + EXEC_LAG_MAX_MS + START_TOLERANCE_MS + 500 };
    const gone = { pid: 32, startedAt: NOW - 1_000 };
    const fine = { pid: 33, startedAt: NOW - 9_000 };
    const found = psFindings('   30 00:10\n   31 00:10\n   33 00:10\n', [late, early, gone, fine], NOW);
    expect([...found].map(([pid, finding]) => [pid, finding.alive, finding.why])).toEqual([
      [30, false, 'start-too-late'], [31, false, 'start-too-early'], [32, false, 'no-pid'], [33, true, 'in-window'],
    ]);
    const text = (pid: number): string => {
      const finding = found.get(pid);
      if (finding === undefined) throw new Error(`no finding for pid ${String(pid)}`);
      return describePsFinding(finding);
    };
    const lateText = text(30);
    for (const part of ['pid 30', new Date(late.startedAt).toISOString(), psStart, 'etime 10 s', '2500 ms after']) {
      expect(lateText).toContain(part);
    }
    expect(lateText).toMatch(/too late/);
    const earlyText = text(31);
    const earlyLead = `${String(EXEC_LAG_MAX_MS + START_TOLERANCE_MS + 500)} ms before`;
    for (const part of ['pid 31', new Date(early.startedAt).toISOString(), psStart, earlyLead]) {
      expect(earlyText).toContain(part);
    }
    expect(earlyText).toMatch(/too early/);
    const goneText = text(32);
    expect(goneText).toContain('pid 32');
    expect(goneText).toContain(new Date(gone.startedAt).toISOString());
    expect(goneText).toMatch(/no such pid/);
  });

  it('`ps` per pid: the verdicts carry the finding of the same `ps` run; a failed `ps` has none', async () => {
    const now = 1_000_000;
    const ps = psLiveness(200, (pid) => Promise.resolve(pid === 41 ? '   41 00:01\n' : pid === 42 ? '' : null));
    const out = await ps([41, 42, 43].map((pid) => ({ pid, startedAt: now - 5_000 })), now);
    expect([...out]).toEqual([[41, false], [42, false], [43, null]]);
    expect(out.finding?.(41)).toMatchObject({ why: 'start-too-late', elapsedS: 1, leadMs: -4_000 });
    expect(out.finding?.(42)).toMatchObject({ why: 'no-pid' });
    expect(out.finding?.(43)).toBeUndefined();
  });
});

describe('kanał cienia: krok przed klawiszem', T, () => {
  it('bez zrzutu: `no-dump`, zero plików cienia i rekordów', async () => {
    const h = harness();
    await expect(h.channel.prepare(request(), () => false)).resolves.toEqual({ result: 'no-dump' });
    expect(readdirSync(h.dir)).toEqual([]);
  });

  it('jeden zrzut z dowodem: plik cienia z decyzją z tapnięcia, rekord `sent`, czas klawisza', async () => {
    const h = harness();
    const d = putDump(h.dir, dump());
    const outcome = await h.channel.prepare(request(), () => false);
    expect(outcome).toEqual({ result: 'written', key: d.key, sessionId: SESSION });
    expect(JSON.parse(readFileSync(join(shadowDir(h.dir), `${d.key}.json`), 'utf8'))).toEqual({
      key: d.key, sessionId: SESSION, decision: 'allow', inputSha256: d.inputSha256, at: NOW,
    });
    expect(recordOf(h.dir, d.key)).toMatchObject({
      state: 'sent', decision: 'allow', pid: d.pid, startedAt: d.startedAt, bootId: 'boot-1', pendingAt: NOW,
      shadowAt: NOW,
    });
    h.advance(5);
    h.channel.keySent(outcome, true);
    expect(recordOf(h.dir, d.key)).toMatchObject({ state: 'sent', keyAt: NOW + 5, keySent: true });
    // Rekord bez treści wywołania.
    const record = readFileSync(join(h.dir, SHADOW_DECISIONS_DIRNAME, SESSION, `${d.key}.json`), 'utf8');
    expect(record).not.toContain('ls -la');
  });

  it('odmowa: plik cienia `deny`', async () => {
    const h = harness();
    const d = putDump(h.dir, dump());
    await h.channel.prepare(request({ decision: 'deny' }), () => false);
    const file = readFileSync(join(shadowDir(h.dir), `${d.key}.json`), 'utf8');
    expect(JSON.parse(file)).toMatchObject({ decision: 'deny' });
  });

  it('driver porzucił czekanie: bez pliku i bez rekordu, wynik `error`', async () => {
    const h = harness();
    putDump(h.dir, dump());
    await expect(h.channel.prepare(request(), () => true)).resolves.toEqual({ result: 'error', detail: 'timeout' });
    expect(shadowListing(h.dir)).toEqual([]);
    expect(readDecisions(h.dir)).toEqual([]);
  });

  it('dwa identyczne wywołania: `ambiguous`, bez pliku, powód w logu', async () => {
    const h = harness();
    putDump(h.dir, dump());
    putDump(h.dir, dump());
    await expect(h.channel.prepare(request(), () => false)).resolves.toEqual({ result: 'ambiguous' });
    expect(shadowListing(h.dir)).toEqual([]);
    expect(h.logs.join('\n')).toContain('2 candidates');
  });

  it('karta innego narzędzia: `no-match`; hook martwy: `no-proof`; rejestr nie czeka: `no-proof`', async () => {
    const h = harness();
    putDump(h.dir, dump());
    await expect(h.channel.prepare(request({ card: { toolName: 'Read', callPrint: null } }), () => false))
      .resolves.toMatchObject({ result: 'no-match' });
    h.life.alive = false;
    await expect(h.channel.prepare(request(), () => false))
      .resolves.toEqual({ result: 'no-proof', detail: 'no-proof:hook-martwy' });
    h.life.alive = true;
    await expect(h.channel.prepare(request({ registry: { kind: 'active', at: NOW - 100 } }), () => false))
      .resolves.toEqual({ result: 'no-proof', detail: 'no-proof:rejestr-nie-czeka' });
    expect(shadowListing(h.dir)).toEqual([]);
  });

  it('błąd `ps` albo katalogu zrzutów: wynik `error`, bez wyjątku i bez pliku', async () => {
    const h = harness({ liveness: () => Promise.reject(new Error('EAGAIN')) });
    putDump(h.dir, dump());
    await expect(h.channel.prepare(request(), () => false)).resolves.toEqual({ result: 'error', detail: 'blad' });
    const blocked = harness();
    mkdirSync(join(blocked.dir, HOOK_PENDING_DIRNAME), { recursive: true });
    writeFileSync(join(blocked.dir, HOOK_PENDING_DIRNAME, SESSION), 'plik zamiast katalogu');
    await expect(blocked.channel.prepare(request(), () => false)).resolves.toEqual({ result: 'error', detail: 'blad' });
    expect(shadowListing(h.dir)).toEqual([]);
  });

  it('nieudany zapis pliku cienia: `error`, rekord `unknown` z powodem `zapis`', async () => {
    const h = harness();
    const d = putDump(h.dir, dump());
    mkdirSync(join(h.dir, HOOK_SHADOW_DIRNAME), { recursive: true });
    writeFileSync(shadowDir(h.dir), 'plik zamiast katalogu');
    await expect(h.channel.prepare(request(), () => false)).resolves.toEqual({ result: 'error', detail: 'zapis' });
    expect(recordOf(h.dir, d.key)).toMatchObject({ state: 'unknown', reason: 'zapis' });
  });
});

describe('cykl `decisions/`: odbiór, odwołanie, sufit', T, () => {
  async function written(h: Harness, decision: 'allow' | 'deny' = 'allow'): Promise<HookCallDump> {
    const d = putDump(h.dir, dump());
    await expect(h.channel.prepare(request({ decision }), () => false)).resolves.toMatchObject({ result: 'written' });
    return d;
  }

  it('hook przejął plik → `claimed`', async () => {
    const h = harness();
    const d = await written(h);
    await h.tick();
    expect(recordOf(h.dir, d.key)?.state).toBe('sent');
    hookClaims(h.dir, d.key);
    await h.tick();
    expect(recordOf(h.dir, d.key)).toMatchObject({ state: 'claimed', settledAt: NOW });
  });

  it('hook umarł bez odbioru (Esc przy biurku) → `anulowany`, plik `.revoked`, hook już go nie weźmie', async () => {
    const h = harness();
    const d = await written(h, 'deny');
    h.life.alive = false;
    await h.tick();
    expect(recordOf(h.dir, d.key)).toMatchObject({ state: 'anulowany', reason: 'hook-martwy' });
    expect(shadowListing(h.dir)).toEqual([`${d.key}${HOOK_SHADOW_REVOKED_SUFFIX}`]);
    expect(() => { hookClaims(h.dir, d.key); }).toThrow(/ENOENT/);
  });

  it('wyścig w kanale: hook przejmuje plik w czasie `ps`, które mówi „martwy” → `claimed`', async () => {
    const keyBox = { key: '' };
    const h = harness({
      liveness: (procs) => {
        if (keyBox.key !== '') hookClaims(h.dir, keyBox.key);
        return Promise.resolve(new Map(procs.map((p) => [p.pid, keyBox.key === '' ? true : false])));
      },
    });
    const d = await written(h);
    keyBox.key = d.key;
    await h.tick();
    expect(recordOf(h.dir, d.key)?.state).toBe('claimed');
    expect(shadowListing(h.dir)).toEqual([`${d.key}${HOOK_SHADOW_CLAIMED_SUFFIX}`]);
  });

  it('`ps` nie wie: plik czeka; ostatnie sprawdzenie odwołuje (`sufit`)', async () => {
    const h = harness();
    const d = await written(h);
    h.life.alive = null;
    await h.tick();
    await h.tick();
    expect(recordOf(h.dir, d.key)?.state).toBe('sent');
    await h.tick();
    expect(recordOf(h.dir, d.key)).toMatchObject({ state: 'anulowany', reason: 'sufit' });
  });

  it('plik starszy niż sufit przy żywym hooku → `anulowany` (`sufit`)', async () => {
    const h = harness();
    const d = await written(h);
    h.advance(SHADOW_REVOKE_AFTER_MS);
    await h.tick();
    expect(recordOf(h.dir, d.key)).toMatchObject({ state: 'anulowany', reason: 'sufit' });
  });

  it('klawisz nie doszedł → odwołanie od razu (`klawisz`); spóźniony klawisz nie cofa stanu końcowego', async () => {
    const h = harness();
    const d = await written(h);
    const outcome = { result: 'written', key: d.key, sessionId: SESSION } as const;
    h.channel.keySent(outcome, false);
    expect(recordOf(h.dir, d.key)).toMatchObject({ state: 'anulowany', reason: 'klawisz', keySent: false });
    expect(shadowListing(h.dir)).toEqual([`${d.key}${HOOK_SHADOW_REVOKED_SUFFIX}`]);

    const h2 = harness();
    const d2 = await written(h2);
    hookClaims(h2.dir, d2.key);
    await h2.tick();
    h2.advance(7);
    h2.channel.keySent({ result: 'written', key: d2.key, sessionId: SESSION }, true);
    expect(recordOf(h2.dir, d2.key)).toMatchObject({ state: 'claimed', keyAt: NOW + 7, keySent: true });
  });

  it('plik zniknął bez śladu → `unknown` (`zniknal`)', async () => {
    const h = harness();
    const d = await written(h);
    rmSync(join(shadowDir(h.dir), `${d.key}.json`));
    await h.tick();
    expect(recordOf(h.dir, d.key)).toMatchObject({ state: 'unknown', reason: 'zniknal' });
  });
});

describe('restart serwera: odtworzenie cyklu z `decisions/`', T, () => {
  function stored(dir: string, over: Partial<ShadowDecisionRecord> = {}): ShadowDecisionRecord {
    const d = dump();
    const record: ShadowDecisionRecord = {
      key: d.key, sessionId: SESSION, decision: 'allow', state: 'pending', toolName: 'Bash',
      inputSha256: d.inputSha256, pid: d.pid, startedAt: d.startedAt, bootId: 'boot-0', pendingAt: NOW - 1_000,
      ...over,
    };
    writeDecision(dir, record);
    return record;
  }
  const fileFor = (dir: string, r: ShadowDecisionRecord): void => {
    writeShadowFile(dir, { key: r.key, sessionId: SESSION, decision: r.decision, inputSha256: r.inputSha256, at: 1 });
  };

  it('przed zapisem pliku cienia (rekord `pending`, pliku brak) → `unknown` (`restart`)', async () => {
    const h = harness();
    const r = stored(h.dir);
    await expect(h.channel.recover()).resolves.toBe(1);
    expect(recordOf(h.dir, r.key)).toMatchObject({ state: 'unknown', reason: 'restart' });
  });

  it('między zapisem a odbiorem, hook żyje → obserwacja dalej; odbiór → `claimed`', async () => {
    const h = harness({ bootId: 'boot-2' });
    const r = stored(h.dir, { state: 'sent', shadowAt: NOW - 1_000 });
    fileFor(h.dir, r);
    await expect(h.channel.recover()).resolves.toBe(0);
    expect(recordOf(h.dir, r.key)).toMatchObject({ state: 'sent', bootId: 'boot-0' });
    hookClaims(h.dir, r.key);
    await h.tick();
    expect(recordOf(h.dir, r.key)?.state).toBe('claimed');
  });

  it('między zapisem a odbiorem, hook nie żyje → `anulowany`, plik `.revoked`', async () => {
    const h = harness();
    h.life.alive = false;
    const r = stored(h.dir, { state: 'sent', shadowAt: NOW - 1_000 });
    fileFor(h.dir, r);
    await expect(h.channel.recover()).resolves.toBe(1);
    expect(recordOf(h.dir, r.key)).toMatchObject({ state: 'anulowany', reason: 'hook-martwy' });
    expect(shadowListing(h.dir)).toEqual([`${r.key}${HOOK_SHADOW_REVOKED_SUFFIX}`]);
  });

  it('`sent` starszy niż sufit bez `.claimed` → `anulowany` (`sufit`), choćby hook żył', async () => {
    const h = harness();
    const r = stored(h.dir, { state: 'sent', shadowAt: NOW - SHADOW_REVOKE_AFTER_MS - 1 });
    fileFor(h.dir, r);
    await expect(h.channel.recover()).resolves.toBe(1);
    expect(recordOf(h.dir, r.key)).toMatchObject({ state: 'anulowany', reason: 'sufit' });
  });

  it('po odbiorze, przed rozliczeniem (`.claimed` leży, rekord `sent`) → `claimed`', async () => {
    const h = harness();
    const r = stored(h.dir, { state: 'sent', shadowAt: NOW - 1_000 });
    fileFor(h.dir, r);
    hookClaims(h.dir, r.key);
    await expect(h.channel.recover()).resolves.toBe(1);
    expect(recordOf(h.dir, r.key)?.state).toBe('claimed');
  });

  it('padł między plikiem a rekordem `sent` (rekord `pending`, plik leży) → traktowany jak `sent`', async () => {
    // Czas zapisu pliku to jego mtime, więc zegar kanału idzie tu za zegarem systemu.
    const h = harness({ at: Date.now() });
    const r = stored(h.dir);
    fileFor(h.dir, r);
    await expect(h.channel.recover()).resolves.toBe(0);
    expect(recordOf(h.dir, r.key)).toMatchObject({ state: 'sent' });
    expect(recordOf(h.dir, r.key)?.shadowAt).toBeTypeOf('number');
  });

  it('rekordy końcowe i pliki w złym kształcie: bez zmian, bez wyjątku', async () => {
    const h = harness();
    const done = stored(h.dir, { state: 'claimed', settledAt: NOW - 5 });
    writeFileSync(join(h.dir, SHADOW_DECISIONS_DIRNAME, SESSION, 'zly.json'), '{"key":1}');
    await expect(h.channel.recover()).resolves.toBe(0);
    expect(recordOf(h.dir, done.key)).toEqual(done);
  });
});

describe('zwalnianie sierot: znacznik `.revoked` dla hooka bez dialogu', T, () => {
  const ACTIVE = { kind: 'active', at: NOW - 100 } as const;
  const releaseReq = (over: Partial<ShadowReleaseRequest> = {}): ShadowReleaseRequest => ({
    engineSessionId: SESSION, registry: ACTIVE, transcript: [{ toolName: 'Bash', input: INPUT }], ...over,
  });

  function counting(h: { life: { alive: boolean | null } }): { liveness: ProcessLiveness; calls: () => number } {
    let calls = 0;
    return {
      liveness: (procs) => {
        calls += 1;
        return Promise.resolve(new Map(procs.map((p) => [p.pid, h.life.alive])));
      },
      calls: () => calls,
    };
  }

  it('rejestr `active` po zrzucie: nowy `.revoked` z treścią `sierota`; drugi przebieg nic nie robi', async () => {
    const h = harness();
    const d = putDump(h.dir, dump());
    await expect(h.channel.release(releaseReq())).resolves.toBe(1);
    expect(shadowListing(h.dir)).toEqual([`${d.key}${HOOK_SHADOW_REVOKED_SUFFIX}`]);
    const body = JSON.parse(readFileSync(join(shadowDir(h.dir), `${d.key}${HOOK_SHADOW_REVOKED_SUFFIX}`), 'utf8'));
    expect(body).toEqual({ reason: 'sierota', at: NOW });
    await expect(h.channel.release(releaseReq())).resolves.toBe(0);
    expect(h.logs.join('\n')).toContain('orphan released (rejestr-nie-czeka)');
  });

  it('niewiadoma nie zwalnia: `ps` „nie wiem”, rejestr nieznany bez transkryptu, rejestr `waiting`', async () => {
    const h = harness();
    putDump(h.dir, dump());
    h.life.alive = null;
    await expect(h.channel.release(releaseReq())).resolves.toBe(0);
    h.life.alive = true;
    await expect(h.channel.release(releaseReq({ registry: { kind: 'unknown', why: 'unread' }, transcript: null })))
      .resolves.toBe(0);
    await expect(h.channel.release(releaseReq({ registry: { kind: 'waiting', dialog: 'permission', at: NOW } })))
      .resolves.toBe(0);
    expect(shadowListing(h.dir)).toEqual([]);
  });

  it('bez sieroty nie ma `ps`; hook martwy: bez znacznika i bez ponownego `ps` w następnym przebiegu', async () => {
    const box = { life: { alive: false as boolean | null } };
    const ps = counting(box);
    const h = harness({ liveness: ps.liveness });
    const d = putDump(h.dir, dump());
    await expect(h.channel.release(releaseReq({ registry: { kind: 'waiting', dialog: 'permission', at: NOW } })))
      .resolves.toBe(0);
    expect(ps.calls()).toBe(0);
    await expect(h.channel.release(releaseReq())).resolves.toBe(0);
    await expect(h.channel.release(releaseReq())).resolves.toBe(0);
    expect(ps.calls()).toBe(1);
    expect(shadowListing(h.dir)).toEqual([]);
    expect(readCallDumps(h.dir, SESSION).map((x) => x.key)).toEqual([d.key]);
  });

  it('prośba subagenta (`agentId`), `.claimed` i własny cykl w toku: nietknięte', async () => {
    const h = harness();
    putDump(h.dir, dump({ agentId: 'a-1' }));
    const claimed = putDump(h.dir, dump({ toolInput: { command: 'pwd' } }));
    writeShadowFile(h.dir, {
      key: claimed.key, sessionId: SESSION, decision: 'allow', inputSha256: claimed.inputSha256, at: 1,
    });
    hookClaims(h.dir, claimed.key);
    await expect(h.channel.release(releaseReq())).resolves.toBe(0);

    const own = harness();
    const d = putDump(own.dir, dump());
    await expect(own.channel.prepare(request(), () => false)).resolves.toMatchObject({ result: 'written' });
    await expect(own.channel.release(releaseReq())).resolves.toBe(0);
    expect(shadowListing(own.dir)).toEqual([`${d.key}.json`]);
  });

  it('nieprzejęty `.json` bez cyklu w toku (np. sprzed restartu): `rename` na `.revoked`', async () => {
    const h = harness();
    const d = putDump(h.dir, dump());
    writeShadowFile(h.dir, { key: d.key, sessionId: SESSION, decision: 'allow', inputSha256: d.inputSha256, at: 1 });
    await expect(h.channel.release(releaseReq())).resolves.toBe(1);
    expect(shadowListing(h.dir)).toEqual([`${d.key}${HOOK_SHADOW_REVOKED_SUFFIX}`]);
    expect(JSON.parse(readFileSync(join(shadowDir(h.dir), `${d.key}${HOOK_SHADOW_REVOKED_SUFFIX}`), 'utf8')))
      .toMatchObject({ decision: 'allow' });
  });

  it('po zwolnieniu sieroty następny identyczny dialog tej sesji nie jest już `ambiguous`', async () => {
    const h = harness();
    const orphan = putDump(h.dir, dump({ at: NOW - 30_000 }));
    const next = putDump(h.dir, dump({ at: NOW - 10_000 }));
    await expect(h.channel.prepare(request(), () => false)).resolves.toEqual({ result: 'ambiguous' });
    // Kolejka: rejestr dalej `waiting`, w transkrypcie otwarte jedno identyczne wywołanie.
    const waiting = { kind: 'waiting', dialog: 'permission', at: NOW - 100 } as const;
    await expect(h.channel.release(releaseReq({ registry: waiting }))).resolves.toBe(1);
    expect(shadowListing(h.dir)).toEqual([`${orphan.key}${HOOK_SHADOW_REVOKED_SUFFIX}`]);
    // Hook sieroty wychodzi i kasuje swój zrzut.
    rmSync(join(h.dir, HOOK_PENDING_DIRNAME, SESSION, `${orphan.key}.json`));
    await expect(h.channel.prepare(request(), () => false))
      .resolves.toEqual({ result: 'written', key: next.key, sessionId: SESSION });
  });

  it('błąd odczytu katalogu zrzutów: 0, bez wyjątku', async () => {
    const h = harness();
    mkdirSync(join(h.dir, HOOK_PENDING_DIRNAME), { recursive: true });
    writeFileSync(join(h.dir, HOOK_PENDING_DIRNAME, SESSION), 'plik zamiast katalogu');
    await expect(h.channel.release(releaseReq())).resolves.toBe(0);
  });
});

describe('z prawdziwym procesem', () => {
  const HOOK = join(import.meta.dirname, '..', '..', 'scripts', 'hooks', 'rarog-pending.mjs');
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  function spawnTracked(args: readonly string[], env: Record<string, string> = {}): ChildProcess {
    const child = spawn(process.execPath, [...args], {
      env: { PATH: process.env['PATH'] ?? '', ...env }, stdio: ['pipe', 'ignore', 'ignore'],
    });
    children.add(child);
    child.on('close', () => children.delete(child));
    return child;
  }

  it('`ps`: żywy proces = `true`, inny czas startu = `false`, po śmierci = `false`', async () => {
    const started = Date.now();
    const child = spawnTracked(['-e', 'setInterval(() => {}, 1000)']);
    const pid = child.pid ?? 0;
    const ps = psLiveness(2_000);
    expect((await ps([{ pid, startedAt: started }], Date.now())).get(pid)).toBe(true);
    expect((await ps([{ pid, startedAt: started - 60_000 }], Date.now())).get(pid)).toBe(false);
    const closed = new Promise((resolve) => child.on('close', resolve));
    child.kill('SIGKILL');
    await closed;
    expect((await ps([{ pid, startedAt: started }], Date.now())).get(pid)).toBe(false);
  }, 8_000);

  it('`ps` per pid: jedno wywołanie na pid z tym samym sufitem, „nie wiem” jednego pidu nie zabiera reszty', async () => {
    const calls: [number, number][] = [];
    const outputs = new Map<number, string | null>([[21, '   21 00:05\n'], [22, null], [23, '']]);
    const ps = psLiveness(200, (pid, timeoutMs) => {
      calls.push([pid, timeoutMs]);
      return pid === 24 ? Promise.reject(new Error('EAGAIN')) : Promise.resolve(outputs.get(pid) ?? null);
    });
    const now = 1_000_000;
    const procs = [21, 22, 23, 24, 21].map((pid) => ({ pid, startedAt: now - 5_000 }));
    const out = await ps(procs, now);
    expect(calls.sort((a, b) => a[0] - b[0])).toEqual([[21, 200], [22, 200], [23, 200], [24, 200]]);
    expect([...out].sort((a, b) => a[0] - b[0])).toEqual([[21, true], [22, null], [23, false], [24, null]]);
  });

  it('`ps` per pid: wszystkie wywołania startują przed pierwszą odpowiedzią; pusta lista nie woła `ps`', async () => {
    const pending: ((output: string) => void)[] = [];
    const ps = psLiveness(200, () => new Promise<string | null>((resolve) => { pending.push(resolve); }));
    const result = ps([31, 32, 33].map((pid) => ({ pid, startedAt: 0 })), 0);
    await Promise.resolve();
    expect(pending).toHaveLength(3);
    for (const resolve of pending) resolve('');
    expect([...(await result).values()]).toEqual([false, false, false]);

    let called = 0;
    const empty = await psLiveness(200, () => { called += 1; return Promise.resolve(''); })([], 0);
    expect(empty.size).toBe(0);
    expect(called).toBe(0);
  });

  it('`ps` per pid na żywo: trzy procesy naraz, każdy `true`', async () => {
    const started = Date.now();
    const pids = [0, 1, 2].map(() => spawnTracked(['-e', 'setInterval(() => {}, 1000)']).pid ?? 0);
    const out = await psLiveness(2_000)(pids.map((pid) => ({ pid, startedAt: started })), Date.now());
    expect(pids.map((pid) => out.get(pid))).toEqual([true, true, true]);
  }, 8_000);

  it('pełny cykl: `alive.json` serwera, hook czeka, plik cienia z kanału, hook przejmuje → `claimed`', async () => {
    const dir = dataDir();
    const project = join(dir, 'roots', 'Projects', 'demo');
    mkdirSync(project, { recursive: true });
    writeFileSync(join(dir, 'roots.json'), JSON.stringify({ roots: [join(dir, 'roots', 'Projects')] }));
    const alive = createAliveWriter({
      dataDir: dir, mode: HOOK_CHANNEL_MODE_SHADOW, send: () => true, bootId: 'boot-e2e', sessions: () => [SESSION],
    });
    alive.start();
    const channel = createShadowChannel({
      dataDir: dir, bootId: 'boot-e2e', liveness: psLiveness(2_000),
      watchDelaysMs: [50, 100, 200, 400, 800, 1_600, 3_200],
    });
    const child = spawnTracked([HOOK], { HOME: dir, RAROG_DATA_DIR: dir });
    const exited = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
    child.stdin?.end(JSON.stringify({
      session_id: SESSION, cwd: project, prompt_id: PROMPT, permission_mode: 'default',
      hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: INPUT,
    }));

    let dumps: HookCallDump[] = [];
    for (let i = 0; i < 200 && dumps.length === 0; i += 1) {
      await sleep(20);
      dumps = readCallDumps(dir, SESSION);
    }
    expect(dumps).toHaveLength(1);
    const outcome = await channel.prepare(request({
      registry: { kind: 'waiting', dialog: 'permission', at: Date.now() },
    }), () => false);
    expect(outcome).toMatchObject({ result: 'written', key: dumps[0]?.key });
    channel.keySent(outcome, true);
    await expect(exited).resolves.toBe(0);

    let record: ShadowDecisionRecord | undefined;
    for (let i = 0; i < 100 && record?.state !== 'claimed'; i += 1) {
      await sleep(20);
      record = recordOf(dir, outcome.key ?? '');
    }
    expect(record).toMatchObject({ state: 'claimed', keySent: true });
    const log = readFileSync(join(dir, HOOK_SHADOW_LOG_FILENAME), 'utf8');
    expect(log).toContain('"ev":"odbior"');
    expect(log).toContain('"zgodny":true');

    alive.stop();
    const file = JSON.parse(readFileSync(join(dir, HOOK_ALIVE_FILENAME), 'utf8')) as HookAliveFile;
    expect(file).toMatchObject({ mode: 'off', sessions: [] });
  }, 8_000);

  it('sierota: rejestr `active` po zrzucie → `.revoked`, hook wychodzi `odwolane` bez wyniku', async () => {
    const dir = dataDir();
    const project = join(dir, 'roots', 'Projects', 'demo');
    mkdirSync(project, { recursive: true });
    writeFileSync(join(dir, 'roots.json'), JSON.stringify({ roots: [join(dir, 'roots', 'Projects')] }));
    const alive = createAliveWriter({
      dataDir: dir, mode: HOOK_CHANNEL_MODE_SHADOW, send: () => true, bootId: 'boot-e2e', sessions: () => [SESSION],
    });
    alive.start();
    const channel = createShadowChannel({ dataDir: dir, bootId: 'boot-e2e', liveness: psLiveness(2_000) });
    const child = spawnTracked([HOOK], { HOME: dir, RAROG_DATA_DIR: dir });
    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    const exited = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
    child.stdin?.end(JSON.stringify({
      session_id: SESSION, cwd: project, prompt_id: PROMPT, permission_mode: 'default',
      hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: INPUT,
    }));

    let dumps: HookCallDump[] = [];
    for (let i = 0; i < 200 && dumps.length === 0; i += 1) {
      await sleep(20);
      dumps = readCallDumps(dir, SESSION);
    }
    const [orphan] = dumps;
    if (orphan === undefined) throw new Error('hook nie zrzucił wywołania');
    // Odczyt rejestru „później niż zrzut z zapasem” bez czekania 2 s w teście.
    const registry = { kind: 'active', at: orphan.at + REGISTRY_SLACK_MS } as const;
    await expect(channel.release({ engineSessionId: SESSION, registry, transcript: null })).resolves.toBe(1);
    await expect(exited).resolves.toBe(0);
    expect(stdout).toBe('');
    const exit = readFileSync(join(dir, HOOK_SHADOW_LOG_FILENAME), 'utf8').split('\n')
      .filter((line) => line.includes('"ev":"wyjscie"'));
    expect(exit).toHaveLength(1);
    expect(exit[0]).toContain('"powod":"odwolane"');
    expect(readCallDumps(dir, SESSION)).toEqual([]);
    alive.stop();
  }, 8_000);
});

describe('sprzątanie startu: `shadow.jsonl`, `shadow/`, sieroty `pending/<sesja>/`, `decisions/`', T, () => {
  /** Plik z mtime cofniętym o `ageMs` względem zegara systemu. */
  function aged(path: string, body: string, ageMs: number): void {
    writeFileSync(path, body);
    const when = new Date(Date.now() - ageMs);
    utimesSync(path, when, when);
  }

  it('rotacja `shadow.jsonl`: powyżej progu do `.1`, poniżej i bez pliku nic', () => {
    const dir = dataDir();
    expect(rotateShadowLog(dir, 10)).toBe(false);
    writeFileSync(join(dir, HOOK_SHADOW_LOG_FILENAME), '{"ev":"start"}\n');
    expect(rotateShadowLog(dir, 1_000)).toBe(false);
    expect(rotateShadowLog(dir, 10)).toBe(true);
    expect(readdirSync(dir).sort()).toEqual([`${HOOK_SHADOW_LOG_FILENAME}.1`]);
  });

  it('rotacja `alive.jsonl`: powyżej progu do `.1` (poprzednie `.1` zastąpione), poniżej i bez pliku nic', () => {
    const dir = dataDir();
    expect(rotateAliveLog(dir, 10)).toBe(false);
    writeFileSync(join(dir, `${ALIVE_LOG_FILENAME}.1`), 'stare\n');
    writeFileSync(join(dir, ALIVE_LOG_FILENAME), '{"ev":"start"}\n');
    expect(rotateAliveLog(dir, 1_000)).toBe(false);
    expect(rotateAliveLog(dir, 10)).toBe(true);
    expect(readdirSync(dir).sort()).toEqual([`${ALIVE_LOG_FILENAME}.1`]);
    expect(readFileSync(join(dir, `${ALIVE_LOG_FILENAME}.1`), 'utf8')).toBe('{"ev":"start"}\n');
  });

  it('`shadow/`: resztki starsze niż sufit znikają razem z pustym katalogiem, świeże zostają', async () => {
    const dir = dataDir();
    const old = shadowDir(dir, OTHER);
    const fresh = shadowDir(dir);
    mkdirSync(old, { recursive: true });
    mkdirSync(fresh, { recursive: true });
    for (const name of ['a.claimed', 'b.revoked', 'c.json', '.c.json.ab.tmp']) {
      aged(join(old, name), '{}', SHADOW_FILE_TTL_MS + 60_000);
    }
    aged(join(fresh, 'd.json'), '{}', 1_000);
    aged(join(fresh, 'e.claimed'), '{}', SHADOW_FILE_TTL_MS + 60_000);
    const result = await sweepShadowFiles(dir, { liveness: () => Promise.resolve(new Map()) });
    expect(result.shadowFiles).toBe(5);
    expect(readdirSync(join(dir, HOOK_SHADOW_DIRNAME))).toEqual([SESSION]);
    expect(readdirSync(fresh)).toEqual(['d.json']);
  });

  it('`pending/<sesja>/`: sierota po martwym hooku znika, żywy i „nie wiem” zostają, stary znika zawsze', async () => {
    const dir = dataDir();
    putDump(dir, dump({ pid: 101 }));
    const live = putDump(dir, dump({ pid: 102 }));
    const unknown = putDump(dir, dump({ pid: 103 }));
    const ancient = dump({ pid: 103 });
    aged(join(dir, HOOK_PENDING_DIRNAME, SESSION, `${ancient.key}.json`), JSON.stringify(ancient),
      ORPHAN_DUMP_MAX_AGE_MS + 60_000);
    aged(join(dir, HOOK_PENDING_DIRNAME, SESSION, 'zepsuty.json'), '{', ORPHAN_DUMP_MAX_AGE_MS + 60_000);
    // Zrzut per sesja w samym `pending/` należy do `sweepPendingHooks` — tu zostaje.
    writeFileSync(join(dir, HOOK_PENDING_DIRNAME, `${SESSION}.json`), '{}');
    const answers = new Map<number, boolean | null>([[101, false], [102, true], [103, null]]);
    const result = await sweepShadowFiles(dir, { liveness: () => Promise.resolve(answers) });
    expect(result.callDumps).toBe(3);
    expect(readdirSync(join(dir, HOOK_PENDING_DIRNAME, SESSION)).sort())
      .toEqual([`${live.key}.json`, `${unknown.key}.json`].sort());
    expect(readdirSync(join(dir, HOOK_PENDING_DIRNAME)).sort()).toEqual([SESSION, `${SESSION}.json`].sort());
  });

  it('`dumpAge` (kanał zgód): żywy proces trzyma zrzut bez względu na wiek, po wieku znika tylko bez `ps`', async () => {
    const dir = dataDir();
    const maxAgeMs = 70 * 60_000;
    mkdirSync(join(dir, HOOK_PENDING_DIRNAME, SESSION), { recursive: true });
    const put = (pid: number, ageMs: number): string => {
      const d = dump({ pid });
      aged(join(dir, HOOK_PENDING_DIRNAME, SESSION, `${d.key}.json`), JSON.stringify(d), ageMs);
      return `${d.key}.json`;
    };
    put(101, 1_000);
    const liveOld = put(102, ORPHAN_DUMP_MAX_AGE_MS + 60_000);
    put(103, maxAgeMs + 60_000);
    const unknownYoung = put(104, maxAgeMs - 60_000);
    aged(join(dir, HOOK_PENDING_DIRNAME, SESSION, 'zepsuty.json'), '{', maxAgeMs + 60_000);
    const answers = new Map<number, boolean | null>([[101, false], [102, true], [103, null], [104, null]]);
    const result = await sweepShadowFiles(dir, { liveness: () => Promise.resolve(answers), dumpAge: { maxAgeMs } });
    expect(result.callDumps).toBe(3);
    expect(readdirSync(join(dir, HOOK_PENDING_DIRNAME, SESSION)).sort()).toEqual([liveOld, unknownYoung].sort());
  });

  it('`dumpAge`: `ps` padło — po wieku znika każdy zrzut, młodszy zostaje', async () => {
    const dir = dataDir();
    const young = putDump(dir, dump());
    const old = dump();
    aged(join(dir, HOOK_PENDING_DIRNAME, SESSION, `${old.key}.json`), JSON.stringify(old), 70 * 60_000 + 1);
    const result = await sweepShadowFiles(dir, {
      liveness: () => Promise.reject(new Error('EAGAIN')), dumpAge: { maxAgeMs: 70 * 60_000 },
    });
    expect(result.callDumps).toBe(1);
    expect(readdirSync(join(dir, HOOK_PENDING_DIRNAME, SESSION))).toEqual([`${young.key}.json`]);
  });

  it('`pending/<sesja>/`: `ps` padło — zostaje sam sufit wieku; pusty katalog sesji znika', async () => {
    const dir = dataDir();
    const d = putDump(dir, dump());
    const empty = join(dir, HOOK_PENDING_DIRNAME, OTHER);
    mkdirSync(empty);
    const result = await sweepShadowFiles(dir, { liveness: () => Promise.reject(new Error('EAGAIN')) });
    expect(result.callDumps).toBe(0);
    expect(readdirSync(join(dir, HOOK_PENDING_DIRNAME))).toEqual([SESSION]);
    expect(readdirSync(join(dir, HOOK_PENDING_DIRNAME, SESSION))).toEqual([`${d.key}.json`]);
  });

  it('`decisions/`: rekord starszy niż retencja znika, młodszy zostaje', async () => {
    const dir = dataDir();
    const sessionDir = join(dir, SHADOW_DECISIONS_DIRNAME, SESSION);
    mkdirSync(sessionDir, { recursive: true });
    aged(join(sessionDir, 'stary.json'), '{}', DECISION_RETENTION_MS + 60_000);
    aged(join(sessionDir, 'mlody.json'), '{}', 60_000);
    const result = await sweepShadowFiles(dir, { liveness: () => Promise.resolve(new Map()) });
    expect(result.decisions).toBe(1);
    expect(readdirSync(sessionDir)).toEqual(['mlody.json']);
  });

  it('dowiązanie symboliczne w miejscu katalogu sesji: nietknięte, cel też', async () => {
    const dir = dataDir();
    const outside = dataDir();
    aged(join(outside, 'cudzy.json'), '{}', DECISION_RETENTION_MS + 60_000);
    mkdirSync(join(dir, SHADOW_DECISIONS_DIRNAME), { recursive: true });
    symlinkSync(outside, join(dir, SHADOW_DECISIONS_DIRNAME, SESSION));
    await sweepShadowFiles(dir, { liveness: () => Promise.resolve(new Map()) });
    expect(readdirSync(outside)).toEqual(['cudzy.json']);
  });

  it.each([HOOK_SHADOW_DIRNAME, HOOK_PENDING_DIRNAME, SHADOW_DECISIONS_DIRNAME])(
    'dowiązanie symboliczne w miejscu korzenia `%s/`: pliki w celu nietknięte, katalog też',
    async (rootName) => {
      const dir = dataDir();
      const outside = dataDir();
      const target = join(outside, SESSION);
      mkdirSync(target);
      aged(join(target, 'cudzy.json'), '{}', DECISION_RETENTION_MS + 60_000);
      symlinkSync(outside, join(dir, rootName));
      const result = await sweepShadowFiles(dir, { liveness: () => Promise.resolve(new Map()) });
      expect(result).toEqual({ shadowFiles: 0, callDumps: 0, decisions: 0 });
      expect(readdirSync(target)).toEqual(['cudzy.json']);
    },
  );
});
