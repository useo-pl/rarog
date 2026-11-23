/**
 * Zgodność kontraktu hooka (`server/src/herdr/dialogs/hook/contract.ts`) z hookiem `scripts/hooks/rarog-pending.mjs`.
 *
 * Hook nie importuje TypeScriptu, więc nazwy stoją w nim jako literały. Test czyta je z tekstu pliku i porównuje
 * z kontraktem, a kontrakt z resztą serwera: blokiem ustawień (`herdr/hook-config.ts`) i nazwą narzędzia pytania
 * w transkrypcie i na ekranie. Plik hooka jest tu tylko CZYTANY: Claude Code wykonuje jego kopię, a różnica
 * bajtów od repo to `stale` w `/health`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ADMIN_RUN_DIRNAME } from '../src/auth/admin.ts';
import { ASK_USER_QUESTION_TOOL } from '../src/drivers/tool-summary.ts';
import * as contract from '../src/herdr/dialogs/hook/contract.ts';
import {
  HOOK_ALIVE_FILENAME, HOOK_ALIVE_MAX_AGE_MS, HOOK_ALIVE_MODES, HOOK_ANSWERS_DIRNAME, HOOK_CALL_KEY_PATTERN,
  HOOK_CALL_NONCE_BYTES, HOOK_CHANNEL_MODES, HOOK_CHANNEL_MODE_ALL, HOOK_CHANNEL_MODE_MAIN, HOOK_CHANNEL_MODE_OFF,
  HOOK_CHANNEL_MODE_SHADOW,
  HOOK_MARKERS_DIRNAME, HOOK_MARKER_ANON_PATTERN, HOOK_MARKER_ANON_PREFIX, HOOK_PAYLOAD_FIELDS, HOOK_PENDING_DIRNAME,
  HOOK_PERMISSION_REQUEST_EVENT, HOOK_POLL_MS, HOOK_PRE_TOOL_USE_EVENT, HOOK_PROGRAMMATIC_ENTRYPOINT,
  HOOK_QUESTION_TOOL, HOOK_SHADOW_CLAIMED_SUFFIX, HOOK_SHADOW_DIRNAME, HOOK_SHADOW_LOG_EVENTS, HOOK_SHADOW_LOG_FILENAME,
  HOOK_SHADOW_REASONS, HOOK_SHADOW_REVOKED_SUFFIX,
} from '../src/herdr/dialogs/hook/contract.ts';
import {
  HOOK_GUARD_LOG_FILENAME, HOOK_PERMISSION_EVENT, HOOK_QUESTION_MATCHER, HOOK_SCRIPT_REL, expectedHookEntries,
} from '../src/herdr/hook-config.ts';
import {
  CONSENT_ALWAYS_MAC_FIELDS, CONSENT_CLAIMED_SUFFIX, CONSENT_DENY_MESSAGE, CONSENT_DIRNAME, CONSENT_MAC_FIELDS, CONSENT_MAC_PREFIX,
  CONSENT_REASONS, CONSENT_REGISTER_DEADLINE_MS, CONSENT_REGISTER_ROUTE, CONSENT_REJECTED_SUFFIX, CONSENT_SECRET_BYTES,
  CONSENT_SOCKET_FILENAME,
} from '../src/herdr/dialogs/layer1/contract.ts';
import { CONSENT_NOT_BEFORE_MARGIN_MS, CONSENT_VERIFY_FAILURES } from '../src/herdr/dialogs/layer1/sign.ts';
import { CONSENT_ALWAYS_VERSION } from '../src/herdr/dialogs/layer1/always.ts';
import { ASK_USER_QUESTION_TOOL as SCREEN_QUESTION_TOOL } from '../src/herdr/dialogs/screen/resolve.ts';
import { DEFAULT_CLAUDE_ENV_CLEAR } from '../src/config.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const HOOK = readFileSync(join(REPO, HOOK_SCRIPT_REL), 'utf8');

/** Wartość stałej `const NAZWA = '…';` z pliku hooka; `null`, gdy jej nie ma. */
function hookConst(source: string, name: string): string | null {
  return new RegExp(`^const ${name} = '([^']*)';$`, 'm').exec(source)?.[1] ?? null;
}

/** Wartość stałej liczbowej `const NAZWA = 123;` z pliku hooka; `null`, gdy jej nie ma. */
function hookNumber(source: string, name: string): number | null {
  const hit = new RegExp(`^const ${name} = (\\d+);$`, 'm').exec(source)?.[1];
  return hit === undefined ? null : Number(hit);
}

/** Napisy z literału `const NAZWA = new Set(['…', …]);` w pliku hooka; `null`, gdy go nie ma. */
function hookStringSet(source: string, name: string): string[] | null {
  const body = new RegExp(`^const ${name} = new Set\\(\\[([^\\]]*)\\]\\);$`, 'm').exec(source)?.[1];
  return body === undefined ? null : [...body.matchAll(/'([^']*)'/g)].map((hit) => hit[1] ?? '');
}

/** Pola payloadu, które hook czyta literałem (`payload['…']`). */
function hookPayloadFields(source: string): string[] {
  return [...source.matchAll(/\bpayload\['([^']+)'\]/g)].map((hit) => hit[1] ?? '');
}

/** Argumenty-literały wywołań `nazwa('…'` w pliku hooka. */
function literalArgs(source: string, fn: string): string[] {
  return [...source.matchAll(new RegExp(`\\b${fn}\\('([^']+)'`, 'g'))].map((hit) => hit[1] ?? '');
}

/** Zdarzenia, z którymi hook porównuje `hook_event_name` literałem (`event === '…'`, `event !== '…'`). */
function hookEvents(source: string): string[] {
  return [...source.matchAll(/\bevent\s*[!=]==\s*'([^']+)'/g)].map((hit) => hit[1] ?? '');
}

/** Podkatalogi katalogu danych, które hook podaje literałem (`join(dir, '…'`). */
function hookDataSubdirs(source: string): string[] {
  return [...source.matchAll(/\bjoin\(\s*dir\s*,\s*'([^']+)'/g)].map((hit) => hit[1] ?? '');
}

describe('kontrakt hooka: literały w `rarog-pending.mjs`', () => {
  it('stałe hooka mają wartości z kontraktu', () => {
    expect(hookConst(HOOK, 'QUESTION_TOOL')).toBe(HOOK_QUESTION_TOOL);
    expect(hookConst(HOOK, 'PERMISSION_REQUEST_EVENT')).toBe(HOOK_PERMISSION_REQUEST_EVENT);
    expect(hookConst(HOOK, 'ANSWERS_DIR')).toBe(HOOK_ANSWERS_DIRNAME);
  });

  it('hook porównuje zdarzenie wyłącznie z nazwami z kontraktu, z obiema', () => {
    const events = hookEvents(HOOK);
    expect(events.length, 'wzorzec nie widzi porównań zdarzenia w hooku').toBeGreaterThan(0);
    expect(new Set(events)).toEqual(new Set([HOOK_PERMISSION_REQUEST_EVENT, HOOK_PRE_TOOL_USE_EVENT]));
  });

  it('zrzuty hook pisze i czyta w katalogu z kontraktu', () => {
    const subdirs = hookDataSubdirs(HOOK);
    expect(subdirs.length, 'wzorzec nie widzi `join(dir, …)` w hooku').toBeGreaterThan(0);
    for (const subdir of subdirs) expect(subdir).toBe(HOOK_PENDING_DIRNAME);
  });

  it('nazwy trybu cienia: plik życia, katalog cienia, przyrostki, dziennik, tryby, odstęp, wiek, nonce', () => {
    expect(hookConst(HOOK, 'ALIVE_FILE')).toBe(HOOK_ALIVE_FILENAME);
    expect(hookConst(HOOK, 'SHADOW_DIR')).toBe(HOOK_SHADOW_DIRNAME);
    expect(hookConst(HOOK, 'CLAIMED_SUFFIX')).toBe(HOOK_SHADOW_CLAIMED_SUFFIX);
    expect(hookConst(HOOK, 'REVOKED_SUFFIX')).toBe(HOOK_SHADOW_REVOKED_SUFFIX);
    expect(hookConst(HOOK, 'SHADOW_LOG_FILE')).toBe(HOOK_SHADOW_LOG_FILENAME);
    expect(['MODE_OFF', 'MODE_SHADOW', 'MODE_MAIN', 'MODE_ALL'].map((name) => hookConst(HOOK, name)))
      .toEqual([...HOOK_ALIVE_MODES]);
    // Konfiguracja serwera przyjmuje te same tryby, które hook zna (także `all`).
    expect(HOOK_CHANNEL_MODES).toEqual([
      HOOK_CHANNEL_MODE_OFF, HOOK_CHANNEL_MODE_SHADOW, HOOK_CHANNEL_MODE_MAIN, HOOK_CHANNEL_MODE_ALL,
    ]);
    expect([...HOOK_CHANNEL_MODES]).toEqual([...HOOK_ALIVE_MODES]);
    // Hook rozumie każdy tryb, który może wpisać konfiguracja serwera.
    for (const mode of HOOK_CHANNEL_MODES) expect(HOOK_ALIVE_MODES, mode).toContain(mode);
    expect(hookNumber(HOOK, 'ANSWER_POLL_MS')).toBe(HOOK_POLL_MS);
    expect(hookNumber(HOOK, 'ALIVE_MAX_AGE_MS')).toBe(HOOK_ALIVE_MAX_AGE_MS);
    expect(hookNumber(HOOK, 'CALL_NONCE_BYTES')).toBe(HOOK_CALL_NONCE_BYTES);
    // Dziennik cienia to osobny plik obok dziennika strażnika, nie ten sam.
    expect(HOOK_SHADOW_LOG_FILENAME).not.toBe(HOOK_GUARD_LOG_FILENAME);
    // Plik cienia nigdy w katalogu odpowiedzi: żaden plik cienia nie może dać się przeczytać jako odpowiedź.
    expect(HOOK_SHADOW_DIRNAME).not.toBe(HOOK_ANSWERS_DIRNAME);
    expect(HOOK_SHADOW_DIRNAME).not.toBe(HOOK_PENDING_DIRNAME);
  });

  it('znacznik prośby: katalog i przedrostek nazwy bez klucza w hooku = kontrakt, osobny katalog', () => {
    expect(hookConst(HOOK, 'MARKERS_DIR')).toBe(HOOK_MARKERS_DIRNAME);
    expect(hookConst(HOOK, 'MARKER_ANON_PREFIX')).toBe(HOOK_MARKER_ANON_PREFIX);
    // Znacznik nie może dać się przeczytać jako zrzut, plik cienia, odpowiedź na pytanie ani plik kanału zgód.
    for (const other of [HOOK_PENDING_DIRNAME, HOOK_SHADOW_DIRNAME, HOOK_ANSWERS_DIRNAME, CONSENT_DIRNAME]) {
      expect(HOOK_MARKERS_DIRNAME).not.toBe(other);
    }
    // Nazwa bez klucza zaczyna się przedrostkiem i nigdy nie wygląda jak klucz per wywołanie.
    const anon = `${HOOK_MARKER_ANON_PREFIX}48213-1767225600123`;
    expect(anon).toMatch(HOOK_MARKER_ANON_PATTERN);
    expect(anon).not.toMatch(HOOK_CALL_KEY_PATTERN);
    const nonce = '00112233445566778899aabbccddeeff';
    expect(`${HOOK_MARKER_ANON_PREFIX}${nonce}`).not.toMatch(HOOK_MARKER_ANON_PATTERN);
    expect(`fb908934-26eb-4419-9e30-8adcd4ed356b-${nonce}`).not.toMatch(HOOK_MARKER_ANON_PATTERN);
  });

  it('the hook reads exactly the registry fields from the payload, each with the CLI version of its measurement', () => {
    const fields = Object.values(HOOK_PAYLOAD_FIELDS);
    expect(new Set(hookPayloadFields(HOOK))).toEqual(new Set(fields.map((one) => one.field)));
    for (const one of fields) {
      expect(one.cli, one.field).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it('programmatic sessions: the variable name and value set in the hook = the registry, with the CLI version', () => {
    expect(hookConst(HOOK, 'ENTRYPOINT_ENV')).toBe(HOOK_PROGRAMMATIC_ENTRYPOINT.env);
    const values = hookStringSet(HOOK, 'PROGRAMMATIC_ENTRYPOINTS');
    expect(values, 'wzorzec nie widzi zbioru wartości w hooku').not.toBeNull();
    expect([...(values ?? [])].sort()).toEqual([...HOOK_PROGRAMMATIC_ENTRYPOINT.values].sort());
    expect(new Set(values).size, 'wartość podwójnie').toBe(values?.length);
    expect(HOOK_PROGRAMMATIC_ENTRYPOINT.cli).toMatch(/^\d+\.\d+\.\d+$/);
    // Warunek czyta zmienną przez obie stałe, zaraz po odczycie stdin (przed walidacją payloadu).
    const main = HOOK.slice(HOOK.indexOf('async function main() {')).split('\n').filter((l) => !/^\s*\/\//.test(l));
    expect(main.slice(0, 3)).toEqual([
      'async function main() {',
      '  const raw = await readStdin();',
      '  if (PROGRAMMATIC_ENTRYPOINTS.has(process.env[ENTRYPOINT_ENV])) return;',
    ]);
    // Panele zakładane przez Raroga zmiennej nie dziedziczą, więc reguła ich nie dotyka.
    expect(DEFAULT_CLAUDE_ENV_CLEAR).toContain(HOOK_PROGRAMMATIC_ENTRYPOINT.env);
  });

  it('powody i rodzaje linii `shadow.jsonl` w hooku = lista z kontraktu, w obie strony', () => {
    const reasons = [...literalArgs(HOOK, 'skipWaiting'), ...literalArgs(HOOK, 'finishCycle')];
    expect(reasons.length, 'wzorzec nie widzi wywołań `skipWaiting`/`finishCycle`').toBeGreaterThan(0);
    for (const reason of reasons) expect(HOOK_SHADOW_REASONS, reason).toContain(reason);
    // Każdy powód z kontraktu stoi w hooku jako literał (weto `alive.json` i wyjścia czekania zwracane
    // wartością).
    for (const reason of HOOK_SHADOW_REASONS) expect(HOOK, reason).toContain(`'${reason}'`);
    expect(new Set(literalArgs(HOOK, 'shadowLog'))).toEqual(new Set(HOOK_SHADOW_LOG_EVENTS));
  });

  it('wzorce widzą zmieniony literał (inaczej porównania wyżej niczego nie bronią)', () => {
    const changed = HOOK
      .replace(`const ANSWERS_DIR = '${HOOK_ANSWERS_DIRNAME}';`, "const ANSWERS_DIR = 'odpowiedzi';")
      .replace(`event !== '${HOOK_PRE_TOOL_USE_EVENT}'`, "event !== 'PostToolUse'")
      .replace(`join(dir, '${HOOK_PENDING_DIRNAME}'`, "join(dir, 'zrzuty'");
    expect(hookConst(changed, 'ANSWERS_DIR')).toBe('odpowiedzi');
    expect(hookEvents(changed)).toContain('PostToolUse');
    expect(hookDataSubdirs(changed)).toContain('zrzuty');
    const numbers = HOOK.replace('const CALL_NONCE_BYTES = 16;', 'const CALL_NONCE_BYTES = 8;')
      .replace("payload['agent_id']", "payload['agentId']")
      .replace("skipWaiting('subagent')", "skipWaiting('podagent')");
    expect(hookNumber(numbers, 'CALL_NONCE_BYTES')).toBe(8);
    expect(hookPayloadFields(numbers)).toContain('agentId');
    expect(literalArgs(numbers, 'skipWaiting')).toContain('podagent');
    const entry = HOOK
      .replace("const ENTRYPOINT_ENV = 'CLAUDE_CODE_ENTRYPOINT';", "const ENTRYPOINT_ENV = 'CLAUDE_ENTRYPOINT';")
      .replace("new Set(['sdk-cli', 'sdk-ts', 'sdk-py'])", "new Set(['sdk-cli', 'sdk-ts', 'sdk-go'])");
    expect(hookConst(entry, 'ENTRYPOINT_ENV')).toBe('CLAUDE_ENTRYPOINT');
    expect(hookStringSet(entry, 'PROGRAMMATIC_ENTRYPOINTS')).toEqual(['sdk-cli', 'sdk-ts', 'sdk-go']);
  });
});

describe('kontrakt hooka: reszta serwera', () => {
  it('blok ustawień rejestruje hook na zdarzeniach kontraktu, `PreToolUse` tylko dla narzędzia pytania', () => {
    expect(HOOK_PERMISSION_EVENT).toBe(HOOK_PERMISSION_REQUEST_EVENT);
    expect(HOOK_QUESTION_MATCHER).toBe(HOOK_QUESTION_TOOL);
    const entries = expectedHookEntries('hook');
    expect(entries.map((entry) => [entry.event, entry.matcher])).toEqual([
      [HOOK_PERMISSION_REQUEST_EVENT, null],
      [HOOK_PRE_TOOL_USE_EVENT, HOOK_QUESTION_TOOL],
    ]);
  });

  it('narzędzie pytania z kontraktu to to samo narzędzie w transkrypcie i na ekranie', () => {
    expect(ASK_USER_QUESTION_TOOL).toBe(HOOK_QUESTION_TOOL);
    expect(SCREEN_QUESTION_TOOL).toBe(HOOK_QUESTION_TOOL);
  });

  it('kontrakt to nazwy, dwie bramki trybu i wydanie CLI pomiaru kanału zgód, bez katalogu danych (hook i serwer'
    + ' wyznaczają go każdy po swojemu)', () => {
    expect(Object.keys(contract).sort()).toEqual([
      'CONSENT_CHANNEL_MEASURED_CLI', 'HOOK_ALIVE_FILENAME', 'HOOK_ALIVE_MAX_AGE_MS', 'HOOK_ALIVE_MODES',
      'HOOK_ALIVE_PHASE_STARTING', 'HOOK_ANSWERS_DIRNAME', 'HOOK_CALL_KEY_PATTERN',
      'HOOK_CALL_NONCE_BYTES', 'HOOK_CHANNEL_MODES', 'HOOK_CHANNEL_MODE_ALL', 'HOOK_CHANNEL_MODE_MAIN',
      'HOOK_CHANNEL_MODE_OFF', 'HOOK_CHANNEL_MODE_SHADOW', 'HOOK_MARKERS_DIRNAME', 'HOOK_MARKER_ANON_PATTERN', 'HOOK_MARKER_ANON_PREFIX',
      'HOOK_PAYLOAD_FIELDS', 'HOOK_PENDING_DIRNAME', 'HOOK_PERMISSION_REQUEST_EVENT', 'HOOK_POLL_MS',
      'HOOK_PRE_TOOL_USE_EVENT', 'HOOK_PROGRAMMATIC_ENTRYPOINT', 'HOOK_QUESTION_TOOL', 'HOOK_RESTART_GRACE_DEFAULT_MS',
      'HOOK_RESTART_GRACE_MAX_MS', 'HOOK_SHADOW_CLAIMED_SUFFIX',
      'HOOK_SHADOW_DIRNAME', 'HOOK_SHADOW_LOG_EVENTS', 'HOOK_SHADOW_LOG_FILENAME', 'HOOK_SHADOW_REASONS',
      'HOOK_SHADOW_REVOKED_SUFFIX', 'HOOK_TOOL_INPUT_MAX_BYTES', 'consentChannelOpen', 'consentSubagentsOpen',
    ]);
  });

  it('bramki trybu (5.1): wątek główny przy `main` i `all`, subagent tylko przy `all`; reszta zamknięta', () => {
    const modes: Array<string | null | undefined> = [...HOOK_CHANNEL_MODES, 'MAIN', 'ALL', '', 'wszystko', null, undefined];
    expect(modes.map((mode) => [mode, contract.consentChannelOpen(mode), contract.consentSubagentsOpen(mode)])).toEqual([
      ['off', false, false], ['shadow', false, false], ['main', true, false], ['all', true, true],
      ['MAIN', false, false], ['ALL', false, false], ['', false, false], ['wszystko', false, false],
      [null, false, false], [undefined, false, false],
    ]);
  });
});

describe('kontrakt kanału zgód: `consent.mjs` = `layer1/contract.ts` i `layer1/sign.ts`', () => {
  const CONSENT_MODULE = join(REPO, 'scripts', 'hooks', 'consent.mjs');
  const load = async (): Promise<Record<string, unknown>> =>
    (await import(pathToFileURL(CONSENT_MODULE).href)) as Record<string, unknown>;

  it('nazwy plików i gniazda, trasa, termin, sekret, podpis i powody weryfikacji', async () => {
    const consent = await load();
    expect(consent['CONSENT_DIR']).toBe(CONSENT_DIRNAME);
    expect(consent['CLAIMED_SUFFIX']).toBe(CONSENT_CLAIMED_SUFFIX);
    expect(consent['REJECTED_SUFFIX']).toBe(CONSENT_REJECTED_SUFFIX);
    expect(consent['RUN_DIR']).toBe(ADMIN_RUN_DIRNAME);
    expect(consent['SOCKET_FILE']).toBe(CONSENT_SOCKET_FILENAME);
    expect(consent['REGISTER_ROUTE']).toBe(CONSENT_REGISTER_ROUTE);
    expect(consent['REGISTER_DEADLINE_MS']).toBe(CONSENT_REGISTER_DEADLINE_MS);
    expect(consent['SECRET_BYTES']).toBe(CONSENT_SECRET_BYTES);
    expect(consent['MAC_PREFIX']).toBe(CONSENT_MAC_PREFIX);
    expect(consent['MAC_FIELDS']).toEqual([...CONSENT_MAC_FIELDS]);
    expect(consent['ALWAYS_MAC_FIELDS']).toEqual([...CONSENT_ALWAYS_MAC_FIELDS]);
    expect(consent['ALWAYS_VERSION']).toBe(CONSENT_ALWAYS_VERSION);
    expect(consent['NOT_BEFORE_MARGIN_MS']).toBe(CONSENT_NOT_BEFORE_MARGIN_MS);
    expect(consent['VERIFY_FAILURES']).toEqual([...CONSENT_VERIFY_FAILURES]);
  });

  it('lista `reasonId` i teksty `message` w hooku = lista kontraktu; tekst odmowy po angielsku, sam ASCII', async () => {
    const consent = await load();
    expect(consent['CONSENT_REASONS']).toEqual(CONSENT_REASONS);
    expect(consent['DENY_MESSAGE']).toBe(CONSENT_DENY_MESSAGE);
    expect(CONSENT_DENY_MESSAGE).toMatch(/^[\x20-\x7e]+$/);
  });
});
