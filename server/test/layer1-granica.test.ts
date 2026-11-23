/**
 * Granice warstwy 1 (`server/src/herdr/dialogs/layer1/`) i spójność jej kontraktu (`layer1/contract.ts`).
 *
 * Warstwa 1 to kanał zgód: karta i adres decyzji ze zrzutu hooka, decyzja podpisanym plikiem odpowiedzi,
 * „zatwierdzono” z dowodu w transkrypcie. Dwa zakazy importów trzymają ten podział:
 *
 * - `layer1/**` nie importuje transkryptu ani modułów drivera herdr. Treść karty bierze ze zrzutu hooka, nigdy
 *   z wpisu jsonl, a do panelu nie pisze; dowód z transkryptu i stan panelu dostaje jako argumenty od tych, którzy
 *   je czytają.
 * - `shadow/**` nie importuje `layer1/**`. Tryb cienia jest mierzony jako całość; kod kanału obok niego nie może
 *   zmienić jego zachowania.
 *
 * Testy są GREPOWE, jak `herdr-dialogs-boundary.test.ts` (kierunek importów całego katalogu dialogów, mapa modułów)
 * i `karta-zgody-bez-jsonl-guard.test.ts` (zapadka transkryptu w katalogu dialogów): łamiąca zmiana ma się pokazać
 * jako czerwony test, a nie w review. Opis: `docs/dialogs.md`, „Module map”.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ADMIN_RUN_DIRNAME, ADMIN_SOCKET_FILENAME } from '../src/auth/admin.ts';
import {
  HOOK_ANSWERS_DIRNAME, HOOK_PENDING_DIRNAME, HOOK_SHADOW_DIRNAME, HOOK_TOOL_INPUT_MAX_BYTES,
} from '../src/herdr/dialogs/hook/contract.ts';
import {
  CONSENT_ADMIN_ROUTES, CONSENT_CLAIM_ROUTE, CONSENT_CLAIMED_SUFFIX, CONSENT_CYCLE_STATES,
  CONSENT_DECIDING_WIRE_STATE, CONSENT_DECISIONS, CONSENT_DENY_MESSAGE, CONSENT_DIRNAME, CONSENT_DISPLAY_MAX,
  CONSENT_INTERNAL_STATES, CONSENT_MAC_FIELDS, CONSENT_MAC_PREFIX, CONSENT_REASONS, CONSENT_RECORDS_DIRNAME,
  CONSENT_RECORD_VERSION, CONSENT_REGISTER_ROUTE, CONSENT_REGISTRATIONS_MAX, CONSENT_REGISTRATIONS_PER_SESSION_MAX,
  CONSENT_REJECTED_SUFFIX, CONSENT_REVOKED_SUFFIX, CONSENT_SECRET_BYTES, CONSENT_SOCKET_FILENAME,
  CONSENT_SOCKET_ROUTES, CONSENT_UNAVAILABLE_REASONS, CONSENT_WIRE_STATES,
} from '../src/herdr/dialogs/layer1/contract.ts';
import { SHADOW_DECISIONS_DIRNAME } from '../src/herdr/dialogs/shadow/files.ts';
import { HOOK_SCRIPT_REL } from '../src/herdr/hook-config.ts';
import { relativeImports, scan, tsFiles } from './source-scan.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const LAYER1_DIR = 'server/src/herdr/dialogs/layer1';
const SHADOW_DIR = 'server/src/herdr/dialogs/shadow';

const repoPath = (file: string): string => relative(REPO, file);
const read = (file: string): string => readFileSync(join(REPO, file), 'utf8');
const modulesOf = (dir: string): string[] =>
  (existsSync(join(REPO, dir)) ? tsFiles(join(REPO, dir)).map(repoPath) : []);

/** Moduły warstwy 1 i trybu cienia jako ścieżki repo. */
const LAYER1 = modulesOf(LAYER1_DIR);
const SHADOW = modulesOf(SHADOW_DIR);

/** Moduły transkryptu: czytnik wpisów i śledzenie pliku rozmowy (ta sama lista co w zapadce karty zgody). */
const TRANSCRIPT = [
  'server/src/herdr/jsonl-pending.ts',
  'server/src/herdr/jsonl-follow.ts',
  'server/src/herdr/transcript-path.ts',
  'server/src/drivers/herdr/transcript.ts',
  // Przegląd dowodów kanału zgód: czyta transkrypt, a warstwa 1 dostaje od niego same fakty tury.
  'server/src/herdr/consent-evidence.ts',
  // Plik subagenta w przeglądzie dowodów kanału zgód.
  'server/src/herdr/consent-subagent.ts',
] as const;

/** Driver herdr: fasada (jedyna pisze do panelu) i jej moduły w `drivers/herdr/`. */
const DRIVER_FACADE = 'server/src/drivers/herdr-driver.ts';
const DRIVER_DIR = 'server/src/drivers/herdr/';

/** Importy w KODZIE pliku `file` (komentarze się nie liczą), rozwiązane do ścieżek repo. */
/** Failure message of a boundary check: what broke, why the boundary exists, what to do. */
const explain = (broken: string, why: string, fix: string): string => `${broken}\nWhy: ${why}\nFix: ${fix}`;
const WHY_LAYER1 = 'layer 1 takes the card text from the hook dump, never from a jsonl entry, and never writes to the '
  + 'pane; the transcript proof and the pane state come in as arguments from the modules that read them.';
const WHY_SHADOW = 'shadow mode is measured as a whole; the consent channel code next to it must not change its '
  + 'behavior.';
const WHY_TARGETS = 'a renamed or moved target turns the import ban into an empty set that passes on anything.';

function importsOf(file: string, source: string): string[] {
  return relativeImports(scan(source).code).map((spec) => repoPath(resolve(dirname(join(REPO, file)), spec)));
}

/** Importy, których moduł warstwy 1 mieć nie może: transkrypt i driver herdr. */
function layer1Violations(file: string, source: string): string[] {
  return importsOf(file, source).filter((target) => (TRANSCRIPT as readonly string[]).includes(target)
    || target === DRIVER_FACADE || target.startsWith(DRIVER_DIR));
}

/** Importy modułu trybu cienia, które prowadzą do warstwy 1. */
function shadowViolations(file: string, source: string): string[] {
  return importsOf(file, source).filter((target) => target.startsWith(`${LAYER1_DIR}/`));
}

describe('warstwa 1: katalog istnieje', () => {
  it('ma moduły, w tym kontrakt (bez nich zakazy niżej byłyby puste)', () => {
    expect(LAYER1, explain(
      `${LAYER1_DIR}/ is missing, empty or has no \`contract.ts\`.`,
      'the import bans below check the modules of this directory; with none found they pass on nothing.',
      `after a move, update \`LAYER1_DIR\`; the layer 1 contract stays in \`${LAYER1_DIR}/contract.ts\`.`,
    )).toContain(`${LAYER1_DIR}/contract.ts`);
  });

  it('cele zakazów istnieją (przemianowany plik zrobiłby z zakazu pusty zbiór)', () => {
    for (const file of [...TRANSCRIPT, DRIVER_FACADE]) {
      expect(existsSync(join(REPO, file)), explain(
        `${file}: listed in \`TRANSCRIPT\` or as \`DRIVER_FACADE\`, but the file does not exist.`,
        WHY_TARGETS,
        'put the new path in the list (and in the same list of `karta-zgody-bez-jsonl-guard.test.ts`); remove the '
          + 'entry only when the module is gone with no successor.',
      )).toBe(true);
    }
    expect(modulesOf(DRIVER_DIR).length, explain(
      `${DRIVER_DIR} has no modules.`,
      WHY_TARGETS,
      'update `DRIVER_DIR` after a move of the herdr driver modules.',
    )).toBeGreaterThan(0);
    expect(SHADOW.length, explain(
      `${SHADOW_DIR}/ has no modules.`,
      'the shadow mode ban below checks the modules of this directory; with none found it passes on nothing.',
      'update `SHADOW_DIR` after a move of shadow mode.',
    )).toBeGreaterThan(0);
  });
});

describe('warstwa 1: bez transkryptu i drivera', () => {
  it('wzorzec widzi import typu, wartości, reeksport i dynamiczny; komentarz się nie liczy', () => {
    const file = `${LAYER1_DIR}/probka.ts`;
    const source = [
      "import type { PendingTool } from '../../jsonl-pending.ts';",
      "export { echoKey } from '../../jsonl-follow.ts';",
      "const t = await import('../../../drivers/herdr/transcript.ts');",
      "import { composerRegionState } from '../../../drivers/herdr/commands.ts';",
      "import '../../../drivers/herdr-driver.ts';",
      "// import { locateTranscript } from '../../transcript-path.ts';",
      "import { parseOptions } from '../screen/parse.ts';",
      "import { asRecord } from '../../../drivers/tool-text.ts';",
    ].join('\n');
    expect(layer1Violations(file, source), explain(
      'The layer 1 import check no longer sees every import shape (type, value, re-export, dynamic) or counts a '
        + 'comment.',
      'a shape the check misses lets a forbidden import through unnoticed.',
      'fix `relativeImports` or `scan` in `server/test/source-scan.ts`, not the expected list.',
    )).toEqual([
      'server/src/herdr/jsonl-pending.ts', 'server/src/herdr/jsonl-follow.ts',
      'server/src/drivers/herdr/commands.ts', 'server/src/drivers/herdr-driver.ts',
      'server/src/drivers/herdr/transcript.ts',
    ]);
  });

  it.each(LAYER1)('%s nie importuje transkryptu ani drivera herdr', (file) => {
    expect(layer1Violations(file, read(file)), explain(
      `${file} imports the transcript or a herdr driver module (list below).`,
      WHY_LAYER1,
      'take the fact as a parameter from the caller that reads the transcript or the pane (e.g. the consent '
        + 'evidence from `server/src/herdr/consent-evidence.ts`), or move a shared type into `layer1/`.',
    )).toEqual([]);
  });
});

describe('tryb cienia: bez warstwy 1', () => {
  it('wzorzec widzi import warstwy 1 z `shadow/`', () => {
    const source = [
      "import { CONSENT_DIRNAME } from '../layer1/contract.ts';",
      "import type { ConsentFile } from '../layer1/contract.ts';",
      "import { writeAtomic } from './atomic.ts';",
    ].join('\n');
    expect(shadowViolations(`${SHADOW_DIR}/probka.ts`, source), explain(
      'The shadow mode import check no longer sees an import of `layer1/`.',
      'a shape the check misses lets a forbidden import through unnoticed.',
      'fix `relativeImports` or `scan` in `server/test/source-scan.ts`, not the expected list.',
    )).toEqual([
      `${LAYER1_DIR}/contract.ts`, `${LAYER1_DIR}/contract.ts`,
    ]);
  });

  it('moduły cienia mają importy (inaczej zakaz niżej byłby pusty)', () => {
    expect(SHADOW.flatMap((file) => importsOf(file, read(file))).length, explain(
      `No relative import found in ${SHADOW_DIR}/.`,
      'with no imports seen, the ban below passes on nothing.',
      'check `relativeImports` in `server/test/source-scan.ts` and `SHADOW_DIR`.',
    )).toBeGreaterThan(0);
  });

  it.each(SHADOW)('%s nie importuje warstwy 1', (file) => {
    expect(shadowViolations(file, read(file)), explain(
      `${file} imports layer 1 (\`${LAYER1_DIR}/\`, list below).`,
      WHY_SHADOW,
      'copy the value into shadow mode or move it to a module outside `layer1/` that both import (e.g. '
        + '`hook/contract.ts`).',
    )).toEqual([]);
  });
});

describe('kontrakt warstwy 1', () => {
  const unique = (values: readonly unknown[]): boolean => new Set(values).size === values.length;

  it('stany na drucie to cykl bez stanów wewnętrznych, w tej samej kolejności', () => {
    const internal: readonly string[] = CONSENT_INTERNAL_STATES;
    expect(CONSENT_WIRE_STATES).toEqual(CONSENT_CYCLE_STATES.filter((state) => !internal.includes(state)));
    expect(CONSENT_WIRE_STATES).toContain(CONSENT_DECIDING_WIRE_STATE);
    expect(CONSENT_WIRE_STATES).not.toContain('deciding');
    for (const list of [CONSENT_CYCLE_STATES, CONSENT_UNAVAILABLE_REASONS, CONSENT_DECISIONS]) {
      expect(unique(list), list.join(', ')).toBe(true);
    }
    expect(CONSENT_RECORD_VERSION).toBe(1);
  });

  it('`reasonId`: każda decyzja ma powód, tekst `message` ma dokładnie każdy powód `deny`', () => {
    const entries = Object.entries(CONSENT_REASONS);
    expect(new Set(entries.map(([, reason]) => reason.decision))).toEqual(new Set(CONSENT_DECISIONS));
    for (const [id, reason] of entries) {
      expect(id).toMatch(/^[a-z][a-z-]*$/);
      if (reason.decision === 'deny') {
        expect(reason.message, id).toBe(CONSENT_DENY_MESSAGE);
      } else {
        expect(reason.message, id).toBeNull();
      }
    }
    expect(CONSENT_DENY_MESSAGE).not.toMatch(/[\n\r]/);
    expect(CONSENT_DENY_MESSAGE.length).toBeGreaterThan(0);
  });

  it('podpis: prefiks domeny z wersją, pola bez powtórzeń, z `reasonId` i skrótem karty', () => {
    expect(CONSENT_MAC_PREFIX).toMatch(/^[a-z]+-consent-v\d+\|$/);
    expect(unique(CONSENT_MAC_FIELDS)).toBe(true);
    for (const field of ['sessionId', 'key', 'decision', 'reasonId', 'inputSha256', 'cardSha256', 'at']) {
      expect(CONSENT_MAC_FIELDS).toContain(field);
    }
    expect(CONSENT_MAC_FIELDS).not.toContain('mac');
    expect(CONSENT_SECRET_BYTES).toBe(32);
  });

  it('katalogi kanału są osobne od zrzutów, odpowiedzi, cienia, rekordów cienia i gniazd', () => {
    const others = [HOOK_PENDING_DIRNAME, HOOK_ANSWERS_DIRNAME, HOOK_SHADOW_DIRNAME, SHADOW_DECISIONS_DIRNAME,
      ADMIN_RUN_DIRNAME];
    expect(unique([CONSENT_DIRNAME, CONSENT_RECORDS_DIRNAME, ...others])).toBe(true);
    const suffixes = [CONSENT_CLAIMED_SUFFIX, CONSENT_REVOKED_SUFFIX, CONSENT_REJECTED_SUFFIX];
    expect(unique(suffixes)).toBe(true);
    for (const suffix of suffixes) {
      expect(suffix).toMatch(/^\.[a-z]+$/);
      expect(suffix).not.toBe('.json');
    }
  });

  it('gniazdo rejestracji ma wyłącznie `/register` i `/claim`, trasy kanału na gnieździe administracyjnym', () => {
    expect(CONSENT_SOCKET_FILENAME).not.toBe(ADMIN_SOCKET_FILENAME);
    expect(CONSENT_SOCKET_ROUTES).toEqual([CONSENT_REGISTER_ROUTE, CONSENT_CLAIM_ROUTE]);
    for (const route of CONSENT_SOCKET_ROUTES) expect(route.startsWith('/api/admin/')).toBe(false);
    for (const route of CONSENT_ADMIN_ROUTES) expect(route).toMatch(/^\/api\/admin\/dialogs\/[a-z]+$/);
    expect(unique([...CONSENT_SOCKET_ROUTES, ...CONSENT_ADMIN_ROUTES])).toBe(true);
  });

  it('limity: sufit `tool_input` hooka = kontrakt, prezentacja ≤ zrzut, rejestracje sesji ≤ wszystkich', () => {
    const hit = /^const TOOL_INPUT_MAX_BYTES = (\d+) \* (\d+);$/m.exec(read(HOOK_SCRIPT_REL));
    expect(hit, explain(
      `${HOOK_SCRIPT_REL}: no line \`const TOOL_INPUT_MAX_BYTES = a * b;\`.`,
      'the hook and the server must agree on the `tool_input` ceiling; this test reads the hook\'s value from that line.',
      'keep the ceiling in the hook as `const TOOL_INPUT_MAX_BYTES = a * b;` on one line.',
    )).not.toBeNull();
    expect(HOOK_TOOL_INPUT_MAX_BYTES, explain(
      `\`HOOK_TOOL_INPUT_MAX_BYTES\` differs from \`TOOL_INPUT_MAX_BYTES\` in ${HOOK_SCRIPT_REL}.`,
      'the hook and the server must agree on the `tool_input` ceiling.',
      'change both values together: `hook/contract.ts` and the hook script.',
    )).toBe(Number(hit?.[1]) * Number(hit?.[2]));
    // Every input the hook carries whole reaches the card whole, indentation included (decision 4).
    expect(CONSENT_DISPLAY_MAX).toBeGreaterThan(HOOK_TOOL_INPUT_MAX_BYTES);
    expect(CONSENT_REGISTRATIONS_PER_SESSION_MAX).toBeLessThanOrEqual(CONSENT_REGISTRATIONS_MAX);
  });
});
