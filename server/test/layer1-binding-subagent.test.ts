/**
 * Wiązanie i skutek prośby subagenta w kanale zgód, przy trybie `all`.
 *
 * Zdania, których pilnuje plik:
 *
 * - kandydaci to `tool_use` z pliku `<sesja>/subagents/agent-<agentId>.jsonl` w turze otwartej wpisem człowieka
 *   z `promptId` hooka; turę klucza zamyka koniec biegu agenta w pliku głównym nie starszy niż start hooka: wynik
 *   `Agent` ze statusem końcowym (pierwszy plan) albo meldunek o końcu zadania (tło); start w tle końcem nie jest;
 * - skutek jak w wątku głównym: `hook` z tą samą decyzją = `applied`, `user_*` albo przerwanie bez źródła =
 *   `settled-at-desk`;
 * - klucz stanu (`sessionId`, `agentId`, `promptId`): koniec tury głównej, także wymuszony, i koniec jednego
 *   subagenta nie zamykają tury innego subagenta; dwa subagenty i wątek główny wiążą się osobno;
 * - tura nieznana do końca (niedokończona albo zepsuta linia), brak pliku subagenta i wyłączone pliki subagentów
 *   (`agentFiles: false`, `RAROG_AGENT_FILES=0`) = brak wiązania, bez wyjątku;
 * - `pending` subagenta z żywą rejestracją po końcu biegu bez wywołania zostaje `pending`; tak samo `sent`
 *   z `release` (powrót do biurka albo zwolnienie z urządzenia), który hook odbierze później; `sent` z `allow`
 *   albo `deny`, `sent` bez żywej rejestracji i `sent` wątku głównego = `revoked` (`turn-ended`), a hook z żywą
 *   rejestracją dostaje podpisany `release` (zwolnienie hooka).
 *
 * Transkrypty: fixture'y subagentów (`subagent-fg.*`, `subagent-tlo.*`, CLI 2.1.314) i subagenta w tle (`background-hidden-1.*`, CLI 2.1.319)
 * z `server/test/fixtures/consent-dowod/`, a przypadki bez fixture'u składane z tych samych kształtów. Fixture'y
 * z CLI 2.1.314 nie niosą pola `toolUseResult` wyniku `Agent` (zostały w nich tylko pola korelacji), więc testy
 * dokładają je w kształcie z fixture'u z CLI 2.1.319 (start w tle) i z rejestru `CLI_SHAPES.foregroundEnd` (koniec na
 * pierwszym planie).
 */
import { randomBytes } from 'node:crypto';
import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createConsentEvidenceReview, createConsentEvidenceScanner, nodeConsentEvidenceIo,
} from '../src/herdr/consent-evidence.ts';
import type { ConsentEvidenceIo } from '../src/herdr/consent-evidence.ts';
import { canonicalSha256 } from '../src/herdr/dialogs/hook/canon.ts';
import type { HookCallDump } from '../src/herdr/dialogs/hook/contract.ts';
import type { ConsentTurnFacts } from '../src/herdr/dialogs/layer1/bind.ts';
import {
  CONSENT_DIRNAME, CONSENT_RECORDS_DIRNAME, CONSENT_SECRET_BYTES, CONSENT_SUBAGENT_GRACE_MS,
} from '../src/herdr/dialogs/layer1/contract.ts';
import { createConsentCycle } from '../src/herdr/dialogs/layer1/cycle.ts';
import type { ConsentCycle } from '../src/herdr/dialogs/layer1/cycle.ts';
import type { ConsentEffectiveMode } from '../src/herdr/dialogs/layer1/mode.ts';
import { createConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import type { ConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import { consentCardSha256 } from '../src/herdr/dialogs/layer1/sign.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'consent-dowod');
const BOOT = 'boot-wiazanie-1';
const NEXT_BOOT = 'boot-wiazanie-2';
const CWD = '/tmp/projekt';
type Tryb = Extract<ConsentEffectiveMode, 'main' | 'all'>;

type Wpis = Record<string, unknown>;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

let clock = Date.parse('2026-11-09T12:00:00.000Z');
const now = (): number => clock;
let tryb: Tryb = 'all';
beforeEach(() => { tryb = 'all'; });

const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');
const wpisy = (name: string): Wpis[] => fixture(name).split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as Wpis);
const ms = (iso: string): number => Date.parse(iso);
const iso = (at: number): string => new Date(at).toISOString();

interface WejscieHooka {
  readonly session_id: string;
  readonly prompt_id: string;
  readonly agent_id: string;
  readonly tool_name: string;
  readonly tool_input: unknown;
}

const hookOf = (name: string): WejscieHooka => JSON.parse(fixture(name)) as WejscieHooka;

/** Klucz hooka: `promptId` i 32 znaki szesnastkowe z ziarna. */
function keyOf(promptId: string, seed: string): string {
  const hex = Buffer.from(seed.padEnd(16, '.').slice(0, 16), 'utf8').toString('hex');
  return `${promptId}-${hex}`;
}

/** Katalog testu: dane serwera i projekt z plikiem głównym sesji oraz katalogiem jej subagentów. */
interface Scena {
  readonly dir: string;
  readonly main: string;
  sub(agentId: string): string;
}

function scena(sessionId: string): Scena {
  const dir = mkdtempSync(join(tmpdir(), 'rarog-wiazanie-'));
  dirs.push(dir);
  const projekt = join(dir, 'projekt');
  mkdirSync(join(projekt, sessionId, 'subagents'), { recursive: true });
  return {
    dir,
    main: join(projekt, `${sessionId}.jsonl`),
    sub: (agentId) => join(projekt, sessionId, 'subagents', `agent-${agentId}.jsonl`),
  };
}

const linie = (entries: readonly Wpis[]): string => entries.map((e) => `${JSON.stringify(e)}\n`).join('');
const zapisz = (file: string, entries: readonly Wpis[]): void => { writeFileSync(file, linie(entries)); };
const dopisz = (file: string, entries: readonly Wpis[]): void => { appendFileSync(file, linie(entries)); };

// --- Wpisy składane z kształtów fixture'ów ---

function czlowiek(promptId: string, at: number, text = 'Uruchom subagenta.'): Wpis {
  return {
    type: 'user', timestamp: iso(at), promptId, isSidechain: false, origin: { kind: 'human' },
    message: { role: 'user', content: text },
  };
}

function wywolanieAgent(toolUseId: string, at: number): Wpis {
  return {
    type: 'assistant', timestamp: iso(at), isSidechain: false,
    message: { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'Agent', input: { prompt: 'x' } }] },
  };
}

/** Wynik `Agent` w pliku głównym z `toolUseResult` (start w tle albo koniec na pierwszym planie). */
function wynikAgent(promptId: string, toolUseId: string, at: number, toolUseResult: Wpis): Wpis {
  return {
    type: 'user', timestamp: iso(at), promptId, isSidechain: false,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'wynik' }] },
    toolUseResult,
  };
}

function koniecTury(at: number): Wpis {
  return { type: 'system', subtype: 'turn_duration', timestamp: iso(at), isSidechain: false };
}

/** Meldunek o końcu zadania w kształcie z fixture'u `subagent-tlo.glowny.jsonl` (CLI 2.1.314). */
function meldunek(agentId: string, at: number, promptId: string, status = 'completed', wynik = 'gotowe'): Wpis {
  const text = [
    '<task-notification>', `<task-id>${agentId}</task-id>`, `<status>${status}</status>`,
    `<summary>Agent "Zadanie ${agentId}" finished</summary>`, `<result>${wynik}</result>`,
    `<usage><duration_ms>${String(at % 100_000)}</duration_ms></usage>`, '</task-notification>',
  ].join('\n');
  return {
    type: 'user', timestamp: iso(at), promptId, isSidechain: false,
    origin: { kind: 'task-notification', producer: 'session-task' }, message: { role: 'user', content: text },
  };
}

function subOtwarcie(agentId: string, promptId: string, at: number, text = 'Wykonaj jedno wywołanie Bash.'): Wpis {
  return {
    type: 'user', timestamp: iso(at), promptId, isSidechain: true, agentId, message: { role: 'user', content: text },
  };
}

function subWywolanie(agentId: string, at: number, uses: readonly { id: string; input: unknown }[]): Wpis {
  return {
    type: 'assistant', timestamp: iso(at), isSidechain: true, agentId,
    message: { role: 'assistant', content: uses.map((u) => ({ type: 'tool_use', id: u.id, name: 'Bash', input: u.input })) },
  };
}

function subWynik(
  agentId: string, promptId: string, toolUseId: string, at: number,
  permissionDecision: Wpis | null = { decision: 'accept', source: 'hook', reasonType: 'hook', reasonCode: 'unknown' },
): Wpis {
  return {
    type: 'user', timestamp: iso(at), promptId, isSidechain: true, agentId,
    ...(permissionDecision === null ? {} : { permissionDecision }),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, is_error: false, content: 'ok' }] },
  };
}

// --- Rekordy, rejestr i cykl ---

function registry(sessions: readonly string[]): ConsentRegistry {
  const reg = createConsentRegistry({ bootId: BOOT, send: () => true, sessions: () => sessions, log: () => {}, now });
  reg.setScope(tryb);
  return reg;
}

function cycleOf(dir: string, reg: ConsentRegistry, bootId = BOOT): ConsentCycle {
  return createConsentCycle({ dataDir: dir, bootId, registry: reg, now, mode: () => tryb, onCard: () => {} });
}

interface Prosba {
  readonly key: string;
  readonly sessionId: string;
  readonly promptId: string;
  readonly agentId: string | null;
  readonly toolInput: unknown;
  readonly hookStartedAt: number;
}

function cardShaOf(p: Prosba): string {
  return consentCardSha256({
    sessionId: p.sessionId, toolName: 'Bash', toolInput: p.toolInput, cwd: CWD, agentId: p.agentId,
    permissionMode: 'default',
  });
}

/** Rekord odpowiedzi odebranej przez hook (`claimed`, decyzja `allow`), zapisany przed startem serwera. */
function claimedRecord(dir: string, p: Prosba): void {
  const at = p.hookStartedAt + 1_000;
  const record = {
    v: 1, key: p.key, sessionId: p.sessionId, promptId: p.promptId, toolName: 'Bash',
    inputSha256: canonicalSha256(p.toolInput), cardSha256: cardShaOf(p), agentId: p.agentId, pid: process.pid,
    hookStartedAt: p.hookStartedAt, bootId: BOOT, state: 'claimed', decision: 'allow', reasonId: 'allow',
    decisionAt: at, correlation: 'open', toolUseId: null, cause: null, late: false, checkpoint: null,
    times: { pending: at - 1_000, deciding: at, sent: at, claimed: at + 500 },
  };
  mkdirSync(join(dir, CONSENT_RECORDS_DIRNAME, p.sessionId), { recursive: true });
  writeFileSync(join(dir, CONSENT_RECORDS_DIRNAME, p.sessionId, `${p.key}.json`), `${JSON.stringify(record)}\n`);
}

/** Cykl po restarcie serwera z rekordami `claimed` z dysku. */
async function recovered(dir: string, prosby: readonly Prosba[]): Promise<ConsentCycle> {
  for (const p of prosby) claimedRecord(dir, p);
  const reg = registry([...new Set(prosby.map((p) => p.sessionId))]);
  const cycle = cycleOf(dir, reg, NEXT_BOOT);
  expect(await cycle.recover()).toMatchObject({ records: prosby.length, changed: 0 });
  return cycle;
}

/** Rejestracja hooka prośby przyjęta przy bieżącym trybie, z nowym sekretem. */
function zarejestruj(reg: ConsentRegistry, p: Prosba): void {
  expect(reg.register({
    key: p.key, sessionId: p.sessionId, promptId: p.promptId, secret: randomBytes(CONSENT_SECRET_BYTES).toString('hex'),
    inputSha256: canonicalSha256(p.toolInput), cardSha256: cardShaOf(p), pid: process.pid, startedAt: p.hookStartedAt,
    ...(p.agentId === null ? {} : { agentId: p.agentId }),
  }).status).toBe(200);
}

/** Prośba subagenta czekająca w tym procesie: rejestracja przyjęta przy trybie `all` i karta `pending`. */
async function pendingLive(dir: string, p: Prosba): Promise<{ cycle: ConsentCycle; reg: ConsentRegistry }> {
  const reg = registry([p.sessionId]);
  const dump: HookCallDump = {
    key: p.key, sessionId: p.sessionId, promptId: p.promptId, pid: process.pid, startedAt: p.hookStartedAt,
    toolName: 'Bash', toolInput: p.toolInput, cwd: CWD, at: p.hookStartedAt + 1,
    inputSha256: canonicalSha256(p.toolInput), permissionMode: 'default', ...(p.agentId === null ? {} : { agentId: p.agentId }),
  };
  zarejestruj(reg, p);
  const cycle = cycleOf(dir, reg);
  // Bez dowodu „dialog stoi”: karta subagenta przy `all` z dowodem dostałaby przycisk i zatrzymała powrót do biurka.
  await cycle.observe(p.sessionId, p.key, 'unknown', dump);
  expect(cycle.record(p.sessionId, p.key)?.state).toBe('pending');
  return { cycle, reg };
}

const consentPath = (dir: string, p: Prosba, suffix: string): string =>
  join(dir, CONSENT_DIRNAME, p.sessionId, `${p.key}${suffix}`);

/** Hook przejmuje plik odpowiedzi (`rename` `.json` → `.claimed`). */
function hookClaims(dir: string, p: Prosba): void {
  renameSync(consentPath(dir, p, '.json'), consentPath(dir, p, '.claimed'));
}

/**
 * Rekord `sent` z decyzją z telefonu i jego plik odpowiedzi `.json` zapisane przed startem serwera, rejestracja hooka
 * żywa w rejestrze nowego procesu; cykl po odzyskaniu (odpowiedź młodsza niż termin odbioru zostaje `sent`).
 */
async function sentLive(dir: string, p: Prosba, decision: 'allow' | 'deny'): Promise<ConsentCycle> {
  const at = clock - 1_000;
  const record = {
    v: 1, key: p.key, sessionId: p.sessionId, promptId: p.promptId, toolName: 'Bash',
    inputSha256: canonicalSha256(p.toolInput), cardSha256: cardShaOf(p), agentId: p.agentId, pid: process.pid,
    hookStartedAt: p.hookStartedAt, bootId: BOOT, state: 'sent', decision,
    reasonId: decision === 'allow' ? 'allow' : 'phone-deny', decisionAt: at, correlation: 'open', toolUseId: null,
    cause: null, late: false, checkpoint: null, times: { pending: p.hookStartedAt + 1, deciding: at, sent: at },
  };
  mkdirSync(join(dir, CONSENT_RECORDS_DIRNAME, p.sessionId), { recursive: true });
  writeFileSync(join(dir, CONSENT_RECORDS_DIRNAME, p.sessionId, `${p.key}.json`), `${JSON.stringify(record)}\n`);
  mkdirSync(join(dir, CONSENT_DIRNAME, p.sessionId), { recursive: true });
  writeFileSync(consentPath(dir, p, '.json'), `${JSON.stringify({ key: p.key, decision, at })}\n`);
  const reg = registry([p.sessionId]);
  zarejestruj(reg, p);
  const cycle = cycleOf(dir, reg, NEXT_BOOT);
  await cycle.recover();
  expect(cycle.record(p.sessionId, p.key)).toMatchObject({ state: 'sent', decision });
  return cycle;
}

/** Przegląd dowodów serwera nad plikami sceny; przebieg na każdym tiku. */
function review(cycle: ConsentCycle, s: Scena, extra: { agentFiles?: boolean; io?: ConsentEvidenceIo } = {}): {
  tick: () => Promise<void>; logs: string[]; locates: number;
} {
  const logs: string[] = [];
  const state = { locates: 0 };
  const evidence = createConsentEvidenceReview({
    cycle, locate: async () => { state.locates += 1; return s.main; }, now, intervalMs: 0,
    log: (line) => { logs.push(line); }, ...extra,
  });
  return {
    tick: () => evidence.tick(),
    logs,
    get locates() { return state.locates; },
  };
}

/** Fakty tury wątku głównego z końcem (wymuszony koniec tury głównej, jak port `turnEnded`). */
function koniecTuryGlownej(promptId: string): ConsentTurnFacts {
  return { promptId, ended: true, partial: false, toolUses: [], results: [] };
}

// --- Fixture'y ---

/** `timestamp` wpisu z `tool_use` o `id` (ms epoki). */
function toolUseAt(entries: readonly Wpis[], id: string): number {
  const entry = entries.find((e) => JSON.stringify(e).includes(`"id":"${id}"`) && e['type'] === 'assistant');
  if (entry === undefined) throw new Error(`brak tool_use ${id}`);
  return ms(entry['timestamp'] as string);
}

/** Wpis z wynikiem `Agent` o `tool_use_id` z dołożonym `toolUseResult`. */
function zWynikiem(entries: readonly Wpis[], toolUseId: string, toolUseResult: Wpis): Wpis[] {
  return entries.map((e) => (JSON.stringify(e).includes(`"tool_use_id":"${toolUseId}"`) ? { ...e, toolUseResult } : e));
}

const FG_SUBAGENT = {
  hook: hookOf('subagent-fg.hook.json'),
  klucz: '00000000-0000-4000-9000-000000000134-3fb514005f49a8c4ffb5c30db27b7e68',
  toolUseId: 'toolu_000000000000000000000025',
  agentToolUseId: 'toolu_000000000000000000000026',
};
const BG_SUBAGENT = {
  hook: hookOf('subagent-tlo.hook.json'),
  klucz: '00000000-0000-4000-9000-000000000133-aca20e09bf20d8de03e4df022f18a149',
  toolUseId: 'toolu_000000000000000000000024',
  agentToolUseId: 'toolu_000000000000000000000027',
};
const HIDDEN_BG_SUBAGENT = {
  hook: hookOf('background-hidden-1.hook.json'),
  klucz: '00000000-0000-4000-9000-000000000030-6b2e18f227775509dce10b0c376dd82a',
  toolUseId: 'toolu_000000000000000000000004',
};

/** Prośba z fixture'u: start hooka z czasów pomiaru (`tool_use` stoi przed nim). */
function prosbaZFixture(
  f: { hook: WejscieHooka; klucz: string; toolUseId: string }, sub: readonly Wpis[], przed: number,
): Prosba {
  return {
    key: f.klucz, sessionId: f.hook.session_id, promptId: f.hook.prompt_id, agentId: f.hook.agent_id,
    toolInput: f.hook.tool_input, hookStartedAt: toolUseAt(sub, f.toolUseId) + przed,
  };
}

describe('subagent na pierwszym planie (`subagent-fg`)', () => {
  it('`hook/accept` w pliku subagenta rozlicza rekord w trakcie biegu: `unknown` (`no-receipt`) z `toolUseId`, wynik'
    + ' `Agent` ze statusem końcowym w pliku głównym zamyka cel przeglądu', async () => {
    const sub = wpisy('subagent-fg.jsonl');
    const glowny = zWynikiem(wpisy('subagent-fg.glowny.jsonl'), FG_SUBAGENT.agentToolUseId,
      { status: 'completed', agentId: FG_SUBAGENT.hook.agent_id });
    // Czasy z fixture'u: `tool_use` 89 ms przed zrzutem, zrzut 1 ms po starcie hooka.
    const p = prosbaZFixture(FG_SUBAGENT, sub, 88);
    clock = p.hookStartedAt + 60_000;
    const s = scena(p.sessionId);
    zapisz(s.sub(FG_SUBAGENT.hook.agent_id), sub);
    // Plik główny bez wyniku `Agent`: subagent jeszcze pracuje, tura otwarta.
    zapisz(s.main, glowny.slice(0, 2));
    const cycle = await recovered(s.dir, [p]);
    const r = review(cycle, s);
    await r.tick();
    const rozliczony = {
      state: 'unknown', correlation: 'bound', toolUseId: FG_SUBAGENT.toolUseId, late: false, cause: 'no-receipt',
    };
    expect(cycle.record(p.sessionId, p.key)).toMatchObject(rozliczony);
    expect(cycle.evidenceTargets()).toEqual([expect.objectContaining({ agentId: FG_SUBAGENT.hook.agent_id, keys: [p.key] })]);

    dopisz(s.main, glowny.slice(2));
    await r.tick();
    expect(cycle.record(p.sessionId, p.key)).toMatchObject(rozliczony);
    expect(cycle.evidenceTargets()).toEqual([]);
    expect(r.logs).toEqual([]);
  });

  it.each([
    ['user_temporary', 'accept'],
    ['user_reject', 'reject'],
  ])('`%s/%s` w pliku subagenta → `settled-at-desk`', async (source, decision) => {
    const sub = wpisy('subagent-fg.jsonl').map((e) => (e['permissionDecision'] === undefined
      ? e
      : { ...e, permissionDecision: { decision, source } }));
    const glowny = zWynikiem(wpisy('subagent-fg.glowny.jsonl'), FG_SUBAGENT.agentToolUseId,
      { status: 'completed', agentId: FG_SUBAGENT.hook.agent_id });
    const p = prosbaZFixture(FG_SUBAGENT, sub, 88);
    clock = p.hookStartedAt + 60_000;
    const s = scena(p.sessionId);
    zapisz(s.sub(FG_SUBAGENT.hook.agent_id), sub);
    zapisz(s.main, glowny);
    const cycle = await recovered(s.dir, [p]);
    await review(cycle, s).tick();
    expect(cycle.record(p.sessionId, p.key)).toMatchObject({
      state: 'settled-at-desk', correlation: 'bound', toolUseId: FG_SUBAGENT.toolUseId,
    });
  });
});

describe('subagent w tle', () => {
  it('`subagent-tlo`: `hook/accept` w pliku subagenta rozlicza rekord w trakcie biegu (`no-receipt`); koniec tury'
    + ' głównej (także wymuszony) nie zamyka celu subagenta, meldunek rekordu nie zmienia', async () => {
    const sub = wpisy('subagent-tlo.jsonl');
    // Start w tle w kształcie z fixture'u (CLI 2.1.319): `isAsync`, `async_launched`, `agentId`.
    const glowny = zWynikiem(wpisy('subagent-tlo.glowny.jsonl'), BG_SUBAGENT.agentToolUseId,
      { isAsync: true, status: 'async_launched', agentId: BG_SUBAGENT.hook.agent_id });
    const p = prosbaZFixture(BG_SUBAGENT, sub, 65);
    clock = p.hookStartedAt + 60_000;
    const s = scena(p.sessionId);
    zapisz(s.sub(BG_SUBAGENT.hook.agent_id), sub);
    const koniec = glowny.findIndex((e) => e['subtype'] === 'turn_duration');
    expect(koniec).toBeGreaterThan(0);
    zapisz(s.main, glowny.slice(0, koniec + 1));
    const cycle = await recovered(s.dir, [p]);
    const r = review(cycle, s);
    await r.tick();
    expect(cycle.record(p.sessionId, p.key)).toMatchObject({ state: 'unknown', cause: 'no-receipt', toolUseId: BG_SUBAGENT.toolUseId });
    // Wymuszony koniec tury głównej (bezczynność sesji) nie dotyczy tury subagenta.
    await cycle.applyTurn(p.sessionId, p.promptId, koniecTuryGlownej(p.promptId), true);
    expect(cycle.record(p.sessionId, p.key)?.state).toBe('unknown');
    expect(cycle.evidenceTargets()).toEqual([expect.objectContaining({ agentId: BG_SUBAGENT.hook.agent_id })]);

    dopisz(s.main, glowny.slice(koniec + 1));
    await r.tick();
    expect(cycle.record(p.sessionId, p.key)).toMatchObject({
      state: 'unknown', cause: 'no-receipt', correlation: 'bound', toolUseId: BG_SUBAGENT.toolUseId,
    });
  });

  it('`m8u-1`: wynik `async_launched` jest startem, nie końcem; meldunek w kolejce i we wpisie `user` to jeden'
    + ' koniec', async () => {
    const sub = wpisy('background-hidden-1.subagent.jsonl');
    const glowny = wpisy('background-hidden-1.glowny.jsonl');
    const agentId = HIDDEN_BG_SUBAGENT.hook.agent_id;
    // Zmierzone: `tool_use` w pliku subagenta 71 ms przed startem hooka.
    const p = prosbaZFixture(HIDDEN_BG_SUBAGENT, sub, 71);
    clock = p.hookStartedAt + 60_000;
    const s = scena(p.sessionId);
    zapisz(s.sub(agentId), sub);
    const koniec = glowny.findIndex((e) => e['subtype'] === 'turn_duration');
    zapisz(s.main, glowny.slice(0, koniec + 1));
    const start = glowny.find((e) => (e['toolUseResult'] as Wpis | undefined)?.['status'] === 'async_launched');
    expect(start).toBeDefined();

    const scanner = createConsentEvidenceScanner();
    const target = { sessionId: p.sessionId, agentId, promptId: p.promptId, file: s.main, checkpoint: null };
    const przed = await scanner.pass(target);
    expect(przed.status).toBe('ok');
    if (przed.status !== 'ok') return;
    expect(przed.facts).toMatchObject({
      promptId: p.promptId, ended: false, partial: false,
      toolUses: [expect.objectContaining({ id: HIDDEN_BG_SUBAGENT.toolUseId, name: 'Bash' })],
      results: [expect.objectContaining({ toolUseId: HIDDEN_BG_SUBAGENT.toolUseId, source: 'hook', decision: 'accept' })],
      agent: { agentId, launch: { at: ms(start?.['timestamp'] as string) }, ends: [], settled: true },
    });
    expect(przed.caughtUp).toBe(true);

    const cycle = await recovered(s.dir, [p]);
    const r = review(cycle, s);
    await r.tick();
    expect(cycle.record(p.sessionId, p.key)?.state).toBe('unknown');

    dopisz(s.main, glowny.slice(koniec + 1));
    const po = await scanner.pass(target);
    if (po.status !== 'ok') throw new Error('bez faktów');
    const kolejka = glowny.find((e) => e['type'] === 'queue-operation' && e['operation'] === 'enqueue');
    expect(po.facts.agent?.ends).toEqual([
      { at: ms(kolejka?.['timestamp'] as string), status: 'completed', via: 'notification', standby: false },
    ]);
    await r.tick();
    expect(cycle.record(p.sessionId, p.key)).toMatchObject({
      state: 'unknown', cause: 'no-receipt', correlation: 'bound', toolUseId: HIDDEN_BG_SUBAGENT.toolUseId,
    });
  });

  it.each(['pending', 'revoked'] as const)(
    'Esc w polu promptu widoku subagenta (zmierzony kształt): wynik z `is_error` bez źródła i wpis przerwania →'
      + ' `settled-at-desk` z rekordu `%s`',
    async (stan) => {
      const agentId = HIDDEN_BG_SUBAGENT.hook.agent_id;
      const fixtureSub = wpisy('background-hidden-1.subagent.jsonl');
      const p = prosbaZFixture(HIDDEN_BG_SUBAGENT, fixtureSub, 71);
      const promptId = p.promptId;
      clock = p.hookStartedAt + 2_000;
      // Kształt z pomiaru (CLI 2.1.319, opis w `docs/dialogs.md`, „Channel cycle”): bez `permissionDecision`
      // i bez załącznika decyzji hooka; `toolUseResult` to napis.
      const esc: Wpis = {
        type: 'user', timestamp: iso(p.hookStartedAt + 5_000), promptId, isSidechain: true, agentId,
        message: {
          role: 'user', content: [{
            type: 'tool_result', tool_use_id: HIDDEN_BG_SUBAGENT.toolUseId, is_error: true,
            content: 'The user doesn\'t want to proceed with this tool use. The tool use was rejected (eg. if it was a'
              + ' file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user'
              + ' to tell you how to proceed.',
          }],
        },
        toolUseResult: 'User rejected tool use',
      };
      const przerwanie: Wpis = {
        type: 'user', timestamp: iso(p.hookStartedAt + 5_001), promptId, isSidechain: true, agentId,
        message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] },
      };
      const s = scena(p.sessionId);
      zapisz(s.sub(agentId), [fixtureSub[0] as Wpis, fixtureSub[1] as Wpis, esc, przerwanie]);
      // Koniec biegu agenta: meldunek z fixture'u; kształtu końca po Esc pomiar nie ma.
      zapisz(s.main, wpisy('background-hidden-1.glowny.jsonl'));
      const { cycle } = await pendingLive(s.dir, p);
      if (stan === 'revoked') {
        // Hook dostaje SIGTERM: potwierdzona śmierć procesu odwołuje kartę.
        await cycle.observe(p.sessionId, p.key, 'dead');
        expect(cycle.record(p.sessionId, p.key)).toMatchObject({ state: 'revoked', cause: 'hook-dead' });
      }
      await review(cycle, s).tick();
      expect(cycle.record(p.sessionId, p.key)).toMatchObject({
        state: 'settled-at-desk', correlation: 'bound', toolUseId: HIDDEN_BG_SUBAGENT.toolUseId,
      });
    },
  );
});

describe('klucz stanu (`sessionId`, `agentId`, `promptId`)', () => {
  const SESSION = '00000000-0000-4000-9000-0000000000b1';
  const PROMPT = '00000000-0000-4000-9000-0000000000b2';
  const NEXT_PROMPT = '00000000-0000-4000-9000-0000000000b3';
  const A = 'aa11bb22cc33dd44e';
  const B = 'ff55ee66dd77cc88b';
  const BASH = { command: 'npm test', description: 'Testy' };
  const T0 = Date.parse('2026-11-09T11:00:00.000Z');

  const prosba = (seed: string, agentId: string | null, hookStartedAt: number, promptId = PROMPT): Prosba => ({
    key: keyOf(promptId, seed), sessionId: SESSION, promptId, agentId, toolInput: BASH, hookStartedAt,
  });

  it('dwa identyczne `Bash` z jednej wiadomości subagenta → `ambiguous-tool-use` dla obu', async () => {
    clock = T0 + 60_000;
    const s = scena(SESSION);
    zapisz(s.sub(A), [
      subOtwarcie(A, PROMPT, T0 + 1_000),
      subWywolanie(A, T0 + 2_000, [{ id: 'toolu_a1', input: BASH }, { id: 'toolu_a2', input: BASH }]),
      subWynik(A, PROMPT, 'toolu_a1', T0 + 4_000),
      subWynik(A, PROMPT, 'toolu_a2', T0 + 5_000),
    ]);
    zapisz(s.main, [
      czlowiek(PROMPT, T0), wywolanieAgent('toolu_agent_a', T0 + 500),
      wynikAgent(PROMPT, 'toolu_agent_a', T0 + 6_000, { status: 'completed', agentId: A }), koniecTury(T0 + 7_000),
    ]);
    const p1 = prosba('dwa-1', A, T0 + 2_100);
    const p2 = prosba('dwa-2', A, T0 + 2_200);
    const cycle = await recovered(s.dir, [p1, p2]);
    await review(cycle, s).tick();
    for (const p of [p1, p2]) {
      expect(cycle.record(SESSION, p.key), p.key).toMatchObject({
        state: 'unknown', correlation: 'ambiguous-tool-use', toolUseId: null, cause: 'ambiguous-tool-use',
      });
    }
  });

  it('dwa subagenty z tym samym `promptId`, każdy z identycznym `Bash` → każdy rekord związany w swoim pliku', async () => {
    clock = T0 + 60_000;
    const s = scena(SESSION);
    for (const [agentId, id] of [[A, 'toolu_a1'], [B, 'toolu_b1']] as const) {
      zapisz(s.sub(agentId), [
        subOtwarcie(agentId, PROMPT, T0 + 1_000),
        subWywolanie(agentId, T0 + 2_000, [{ id, input: BASH }]),
        subWynik(agentId, PROMPT, id, T0 + 4_000),
      ]);
    }
    zapisz(s.main, [
      czlowiek(PROMPT, T0), wywolanieAgent('toolu_agent_a', T0 + 500), wywolanieAgent('toolu_agent_b', T0 + 600),
      wynikAgent(PROMPT, 'toolu_agent_a', T0 + 6_000, { status: 'completed', agentId: A }),
      wynikAgent(PROMPT, 'toolu_agent_b', T0 + 6_100, { status: 'completed', agentId: B }), koniecTury(T0 + 7_000),
    ]);
    const pa = prosba('para-a', A, T0 + 2_100);
    const pb = prosba('para-b', B, T0 + 2_100);
    const cycle = await recovered(s.dir, [pa, pb]);
    await review(cycle, s).tick();
    expect(cycle.record(SESSION, pa.key)).toMatchObject({ state: 'unknown', correlation: 'bound', toolUseId: 'toolu_a1' });
    expect(cycle.record(SESSION, pb.key)).toMatchObject({ state: 'unknown', correlation: 'bound', toolUseId: 'toolu_b1' });
  });

  it('rekord wątku głównego i rekord subagenta z identycznym `Bash` w tej samej turze → każdy związany w swoim'
    + ' pliku', async () => {
    clock = T0 + 60_000;
    const s = scena(SESSION);
    zapisz(s.sub(A), [
      subOtwarcie(A, PROMPT, T0 + 3_000),
      subWywolanie(A, T0 + 4_000, [{ id: 'toolu_a1', input: BASH }]),
      subWynik(A, PROMPT, 'toolu_a1', T0 + 5_000),
    ]);
    zapisz(s.main, [
      czlowiek(PROMPT, T0),
      { ...subWywolanie(A, T0 + 500, [{ id: 'toolu_m1', input: BASH }]), isSidechain: false, agentId: undefined },
      { ...subWynik(A, PROMPT, 'toolu_m1', T0 + 1_500), isSidechain: false, agentId: undefined },
      wywolanieAgent('toolu_agent_a', T0 + 2_000),
      wynikAgent(PROMPT, 'toolu_agent_a', T0 + 6_000, { status: 'completed', agentId: A }), koniecTury(T0 + 7_000),
    ]);
    const glowny = prosba('glowny', null, T0 + 600);
    const subagent = prosba('subagent', A, T0 + 4_100);
    const cycle = await recovered(s.dir, [glowny, subagent]);
    const r = review(cycle, s);
    // Pierwszy tik: checkpoint, drugi: przebieg z checkpointu (rekordy bez niego w tej samej chwili też idą od zera).
    await r.tick();
    await r.tick();
    expect(cycle.record(SESSION, glowny.key)).toMatchObject({ state: 'unknown', cause: 'no-receipt', toolUseId: 'toolu_m1' });
    expect(cycle.record(SESSION, subagent.key)).toMatchObject({ state: 'unknown', cause: 'no-receipt', toolUseId: 'toolu_a1' });
  });

  it('koniec tury głównej w trakcie pracy dwóch subagentów → ich cele żyją; koniec jednego → drugi żyje', async () => {
    clock = T0 + 60_000;
    const s = scena(SESSION);
    for (const [agentId, id] of [[A, 'toolu_a1'], [B, 'toolu_b1']] as const) {
      zapisz(s.sub(agentId), [
        subOtwarcie(agentId, PROMPT, T0 + 1_000),
        subWywolanie(agentId, T0 + 3_000, [{ id, input: { command: `echo ${agentId}` } }]),
      ]);
    }
    zapisz(s.main, [
      czlowiek(PROMPT, T0),
      wywolanieAgent('toolu_agent_a', T0 + 500),
      wynikAgent(PROMPT, 'toolu_agent_a', T0 + 600, { isAsync: true, status: 'async_launched', agentId: A }),
      wywolanieAgent('toolu_agent_b', T0 + 700),
      wynikAgent(PROMPT, 'toolu_agent_b', T0 + 800, { isAsync: true, status: 'async_launched', agentId: B }),
      koniecTury(T0 + 900),
    ]);
    const pa: Prosba = { ...prosba('praca-a', A, T0 + 3_100), toolInput: { command: `echo ${A}` } };
    const pb: Prosba = { ...prosba('praca-b', B, T0 + 3_100), toolInput: { command: `echo ${B}` } };
    const cycle = await recovered(s.dir, [pa, pb]);
    const r = review(cycle, s);
    await r.tick();
    await cycle.applyTurn(SESSION, PROMPT, koniecTuryGlownej(PROMPT), true);
    expect([pa, pb].map((p) => cycle.record(SESSION, p.key)?.state)).toEqual(['claimed', 'claimed']);
    expect(cycle.evidenceTargets().map((t) => t.agentId).sort()).toEqual([A, B].sort());

    // Wynik w pliku subagenta rozlicza rekord; meldunek zamyka cel przeglądu.
    dopisz(s.sub(A), [subWynik(A, PROMPT, 'toolu_a1', T0 + 5_000)]);
    dopisz(s.main, [meldunek(A, T0 + 8_000, NEXT_PROMPT)]);
    await r.tick();
    expect(cycle.record(SESSION, pa.key)).toMatchObject({ state: 'unknown', cause: 'no-receipt', toolUseId: 'toolu_a1' });
    expect(cycle.record(SESSION, pb.key)?.state).toBe('claimed');
    expect(cycle.evidenceTargets().map((t) => t.agentId)).toEqual([B]);

    dopisz(s.sub(B), [subWynik(B, PROMPT, 'toolu_b1', T0 + 5_000)]);
    dopisz(s.main, [meldunek(B, T0 + 9_000, '00000000-0000-4000-9000-0000000000b4', 'completed', 'inny wynik')]);
    await r.tick();
    expect(cycle.record(SESSION, pb.key)).toMatchObject({ state: 'unknown', cause: 'no-receipt', toolUseId: 'toolu_b1' });
    expect(cycle.evidenceTargets()).toEqual([]);
  });

  it('wznowienie agenta: koniec wcześniejszego biegu nie zamyka prośby nowego biegu', async () => {
    clock = T0 + 60_000;
    const s = scena(SESSION);
    zapisz(s.sub(A), [
      subOtwarcie(A, PROMPT, T0 + 1_000),
      subWywolanie(A, T0 + 2_000, [{ id: 'toolu_a1', input: BASH }]),
      subWynik(A, PROMPT, 'toolu_a1', T0 + 3_000),
      subOtwarcie(A, PROMPT, T0 + 10_000, 'Druga wiadomość do agenta.'),
      subWywolanie(A, T0 + 11_000, [{ id: 'toolu_a2', input: BASH }]),
    ]);
    zapisz(s.main, [
      czlowiek(PROMPT, T0), wywolanieAgent('toolu_agent_a', T0 + 500),
      wynikAgent(PROMPT, 'toolu_agent_a', T0 + 600, { isAsync: true, status: 'async_launched', agentId: A }),
      koniecTury(T0 + 700), meldunek(A, T0 + 4_000, NEXT_PROMPT),
    ]);
    const p = prosba('wznowienie', A, T0 + 11_100);
    const cycle = await recovered(s.dir, [p]);
    const r = review(cycle, s);
    await r.tick();
    expect(cycle.record(SESSION, p.key)).toMatchObject({ state: 'claimed', correlation: 'open' });

    dopisz(s.sub(A), [subWynik(A, PROMPT, 'toolu_a2', T0 + 12_000)]);
    dopisz(s.main, [meldunek(A, T0 + 13_000, '00000000-0000-4000-9000-0000000000b4', 'completed', 'drugi bieg')]);
    await r.tick();
    expect(cycle.record(SESSION, p.key)).toMatchObject({ state: 'unknown', cause: 'no-receipt', toolUseId: 'toolu_a2' });
  });

  it('niedokończona ostatnia linia pliku subagenta → bez faktu „brak zamknięcia”, bez wyjątku; reszta linii →'
    + ' `unknown` (`no-receipt`)', async () => {
    clock = T0 + 60_000;
    const s = scena(SESSION);
    const wynik = JSON.stringify(subWynik(A, PROMPT, 'toolu_a1', T0 + 3_000));
    const ciecie = Math.floor(wynik.length / 2);
    writeFileSync(s.sub(A), linie([
      subOtwarcie(A, PROMPT, T0 + 1_000), subWywolanie(A, T0 + 2_000, [{ id: 'toolu_a1', input: BASH }]),
    ]) + wynik.slice(0, ciecie));
    zapisz(s.main, [
      czlowiek(PROMPT, T0), wywolanieAgent('toolu_agent_a', T0 + 500),
      wynikAgent(PROMPT, 'toolu_agent_a', T0 + 4_000, { status: 'completed', agentId: A }), koniecTury(T0 + 5_000),
    ]);
    const p = prosba('urwana', A, T0 + 2_100);

    const pass = await createConsentEvidenceScanner().pass({
      sessionId: SESSION, agentId: A, promptId: PROMPT, file: s.main, checkpoint: null,
    });
    expect(pass).toMatchObject({ status: 'ok', facts: { partial: false, results: [], agent: { settled: false } } });

    const cycle = await recovered(s.dir, [p]);
    const r = review(cycle, s);
    await r.tick();
    expect(cycle.record(SESSION, p.key)).toMatchObject({ state: 'claimed', correlation: 'open', cause: null });
    expect(r.logs).toEqual([]);

    appendFileSync(s.sub(A), `${wynik.slice(ciecie)}\n`);
    await r.tick();
    expect(cycle.record(SESSION, p.key)).toMatchObject({ state: 'unknown', cause: 'no-receipt', toolUseId: 'toolu_a1' });
  });

  it('pełna linia pliku subagenta, której nie da się sparsować → tura nieznana do końca, rekord czeka', async () => {
    clock = T0 + 60_000;
    const s = scena(SESSION);
    writeFileSync(s.sub(A), linie([subOtwarcie(A, PROMPT, T0 + 1_000)]) + '{"type":"assistant",\n');
    zapisz(s.main, [
      czlowiek(PROMPT, T0), wywolanieAgent('toolu_agent_a', T0 + 500),
      wynikAgent(PROMPT, 'toolu_agent_a', T0 + 4_000, { status: 'completed', agentId: A }),
    ]);
    const p = prosba('zepsuta', A, T0 + 2_100);
    const cycle = await recovered(s.dir, [p]);
    await review(cycle, s).tick();
    expect(cycle.record(SESSION, p.key)).toMatchObject({ state: 'claimed', correlation: 'open' });
  });

  it('brak pliku subagenta → brak wiązania, bez wyjątku', async () => {
    clock = T0 + 60_000;
    const s = scena(SESSION);
    zapisz(s.main, [
      czlowiek(PROMPT, T0), wywolanieAgent('toolu_agent_a', T0 + 500),
      wynikAgent(PROMPT, 'toolu_agent_a', T0 + 4_000, { status: 'completed', agentId: A }), koniecTury(T0 + 5_000),
    ]);
    const p = prosba('bez-pliku', A, T0 + 2_100);
    const pass = await createConsentEvidenceScanner().pass({
      sessionId: SESSION, agentId: A, promptId: PROMPT, file: s.main, checkpoint: null,
    });
    expect(pass).toMatchObject({
      status: 'ok', facts: { partial: true, toolUses: [], agent: { settled: false, ends: [expect.anything()] } },
    });
    const cycle = await recovered(s.dir, [p]);
    const r = review(cycle, s);
    await r.tick();
    expect(cycle.record(SESSION, p.key)).toMatchObject({ state: 'claimed', correlation: 'open' });
    expect(r.logs).toEqual([]);
  });

  it('`agentFiles: false` (`RAROG_AGENT_FILES=0`) → przegląd nie czyta plików dla subagenta, brak wiązania', async () => {
    clock = T0 + 60_000;
    const s = scena(SESSION);
    zapisz(s.sub(A), [
      subOtwarcie(A, PROMPT, T0 + 1_000),
      subWywolanie(A, T0 + 2_000, [{ id: 'toolu_a1', input: BASH }]),
      subWynik(A, PROMPT, 'toolu_a1', T0 + 3_000),
    ]);
    zapisz(s.main, [
      czlowiek(PROMPT, T0), wywolanieAgent('toolu_agent_a', T0 + 500),
      wynikAgent(PROMPT, 'toolu_agent_a', T0 + 4_000, { status: 'completed', agentId: A }), koniecTury(T0 + 5_000),
    ]);
    const p = prosba('wylaczone', A, T0 + 2_100);
    const czytane: string[] = [];
    const io: ConsentEvidenceIo = {
      stat: async (path) => { czytane.push(path); return nodeConsentEvidenceIo.stat(path); },
      read: async (path, start, length) => { czytane.push(path); return nodeConsentEvidenceIo.read(path, start, length); },
    };
    const cycle = await recovered(s.dir, [p]);
    const r = review(cycle, s, { agentFiles: false, io });
    await r.tick();
    await r.tick();
    expect(cycle.record(SESSION, p.key)).toMatchObject({ state: 'claimed', correlation: 'open' });
    expect(czytane).toEqual([]);
    expect(r.locates).toBe(0);
    expect(await createConsentEvidenceScanner({ agentFiles: false, io }).pass({
      sessionId: SESSION, agentId: A, promptId: PROMPT, file: s.main, checkpoint: null,
    })).toEqual({ status: 'missing' });
    expect(czytane).toEqual([]);
  });

  it('`pending` subagenta z żywą rejestracją po końcu biegu bez wywołania zostaje `pending`', async () => {
    const s = scena(SESSION);
    const p = prosba('d5', A, T0 + 2_000);
    clock = p.hookStartedAt + 2_000;
    zapisz(s.sub(A), [subOtwarcie(A, PROMPT, T0 + 1_000)]);
    zapisz(s.main, [
      czlowiek(PROMPT, T0), wywolanieAgent('toolu_agent_a', T0 + 500),
      wynikAgent(PROMPT, 'toolu_agent_a', T0 + 3_000, { status: 'completed', agentId: A }), koniecTury(T0 + 3_500),
    ]);
    const { cycle } = await pendingLive(s.dir, p);
    await review(cycle, s).tick();
    expect(cycle.record(SESSION, p.key)?.state).toBe('pending');
  });

  /** Subagent wywołał `Bash` (hook czeka) i jego bieg ma koniec w pliku głównym, bez wyniku wywołania. */
  function scenaKoncaBiegu(): Scena {
    const s = scena(SESSION);
    zapisz(s.sub(A), [
      subOtwarcie(A, PROMPT, T0 + 1_000), subWywolanie(A, T0 + 1_900, [{ id: 'toolu_a1', input: BASH }]),
    ]);
    zapisz(s.main, [
      czlowiek(PROMPT, T0), wywolanieAgent('toolu_agent_a', T0 + 500),
      wynikAgent(PROMPT, 'toolu_agent_a', T0 + 3_000, { status: 'completed', agentId: A }), koniecTury(T0 + 3_500),
    ]);
    return s;
  }

  it.each(['powrót do biurka', 'zwolnienie z urządzenia'] as const)(
    '`sent` z `release` subagenta z żywą rejestracją (%s), koniec biegu bez wyniku przed odbiorem pliku →'
      + ' `sent`, plik `.json` na miejscu; odbiór przez hook → `released` (test padający na bazie)',
    async (droga) => {
      const s = scenaKoncaBiegu();
      // Ziarno klucza w ASCII: 16 bajtów = 32 znaki szesnastkowe.
      const p = prosba(droga === 'powrót do biurka' ? 'd5-sent-biurko' : 'd5-sent-telefon', A, T0 + 2_000);
      clock = p.hookStartedAt + 2_000;
      const { cycle } = await pendingLive(s.dir, p);
      if (droga === 'powrót do biurka') {
        clock += CONSENT_SUBAGENT_GRACE_MS;
        await cycle.tick();
      } else {
        expect(await cycle.release(SESSION, p.key)).toEqual({ ok: true, state: 'sent' });
      }
      expect(cycle.record(SESSION, p.key)).toMatchObject({ state: 'sent', decision: 'release' });

      await review(cycle, s).tick();
      expect(cycle.record(SESSION, p.key)).toMatchObject({ state: 'sent', decision: 'release', cause: null });
      expect(existsSync(consentPath(s.dir, p, '.json'))).toBe(true);
      expect(existsSync(consentPath(s.dir, p, '.revoked'))).toBe(false);
      // Tura klucza zamknięta: rekord nie czeka już na dowód, rozlicza go przegląd plików.
      expect(cycle.evidenceTargets()).toEqual([]);

      hookClaims(s.dir, p);
      await cycle.tick();
      expect(cycle.record(SESSION, p.key)).toMatchObject({
        state: 'released', decision: 'release', cause: null,
        ...(droga === 'powrót do biurka' ? { releaseCause: 'desk-fallback' } : {}),
      });
    },
  );

  it.each(['allow', 'deny'] as const)(
    '`sent` z `%s` subagenta z żywą rejestracją po końcu biegu bez wyniku → `revoked` (`turn-ended`), plik'
      + ' `.revoked`, a w miejscu odpowiedzi podpisany `release` dla czekającego hooka',
    async (decision) => {
      const s = scenaKoncaBiegu();
      const p = prosba(`sent-${decision}`, A, T0 + 2_000);
      clock = p.hookStartedAt + 2_000;
      const cycle = await sentLive(s.dir, p, decision);
      await review(cycle, s).tick();
      expect(cycle.record(SESSION, p.key)).toMatchObject({ state: 'revoked', cause: 'turn-ended', decision });
      expect(JSON.parse(readFileSync(consentPath(s.dir, p, '.revoked'), 'utf8'))).toMatchObject({ decision });
      // Hook nie czyta `.revoked`: zwolnienie hooka pisze pod kluczem plik `release`, który nie wykonuje narzędzia.
      expect(JSON.parse(readFileSync(consentPath(s.dir, p, '.json'), 'utf8')))
        .toMatchObject({ key: p.key, sessionId: SESSION, decision: 'release', reasonId: 'release' });
    },
  );

  it('`sent` z `release` subagenta bez żywej rejestracji po końcu biegu bez wyniku → `revoked` (`turn-ended`)',
    async () => {
      const s = scenaKoncaBiegu();
      const p = prosba('sent-release-bez-rejestracji', A, T0 + 2_000);
      clock = p.hookStartedAt + 2_000;
      const { cycle, reg } = await pendingLive(s.dir, p);
      expect(await cycle.release(SESSION, p.key)).toEqual({ ok: true, state: 'sent' });
      expect(reg.forget(SESSION, p.key)).toBe(true);
      await review(cycle, s).tick();
      expect(cycle.record(SESSION, p.key))
        .toMatchObject({ state: 'revoked', cause: 'turn-ended', decision: 'release' });
      expect(existsSync(consentPath(s.dir, p, '.revoked'))).toBe(true);
    });

  it('`sent` z `release` wątku głównego z żywą rejestracją po końcu tury bez wyniku → `revoked`'
    + ' (`turn-ended`)',
    async () => {
      const s = scena(SESSION);
      const p = prosba('sent-release-glowny', null, T0 + 2_000);
      clock = p.hookStartedAt + 2_000;
      const { cycle, reg } = await pendingLive(s.dir, p);
      expect(await cycle.release(SESSION, p.key)).toEqual({ ok: true, state: 'sent' });
      expect(reg.entry(SESSION, p.key)).not.toBeNull();
      await cycle.applyTurn(SESSION, PROMPT, koniecTuryGlownej(PROMPT));
      expect(cycle.record(SESSION, p.key))
        .toMatchObject({ state: 'revoked', cause: 'turn-ended', decision: 'release' });
      expect(existsSync(consentPath(s.dir, p, '.revoked'))).toBe(true);
    });

  it('tryb `main`: rekord subagenta nie jest celem przeglądu, a jego fakty nie zmieniają rekordu', async () => {
    tryb = 'main';
    clock = T0 + 60_000;
    const s = scena(SESSION);
    zapisz(s.sub(A), [
      subOtwarcie(A, PROMPT, T0 + 1_000),
      subWywolanie(A, T0 + 2_000, [{ id: 'toolu_a1', input: BASH }]),
      subWynik(A, PROMPT, 'toolu_a1', T0 + 3_000),
    ]);
    zapisz(s.main, [
      czlowiek(PROMPT, T0), wywolanieAgent('toolu_agent_a', T0 + 500),
      wynikAgent(PROMPT, 'toolu_agent_a', T0 + 4_000, { status: 'completed', agentId: A }), koniecTury(T0 + 5_000),
    ]);
    const p = prosba('tryb-main', A, T0 + 2_100);
    const cycle = await recovered(s.dir, [p]);
    expect(cycle.evidenceTargets()).toEqual([]);
    const pass = await createConsentEvidenceScanner().pass({
      sessionId: SESSION, agentId: A, promptId: PROMPT, file: s.main, checkpoint: null,
    });
    if (pass.status !== 'ok') throw new Error('bez faktów');
    await cycle.applyTurn(SESSION, PROMPT, pass.facts);
    expect(cycle.record(SESSION, p.key)).toMatchObject({ state: 'claimed', correlation: 'open' });
  });
});
