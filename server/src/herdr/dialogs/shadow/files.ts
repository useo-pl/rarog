/**
 * Pliki kanału cienia po stronie serwera (`docs/dialogs.md`, „Server in shadow mode”):
 *
 * - odczyt zrzutów per wywołanie `pending/<sesja>/<klucz>.json` (pisze i kasuje je hook);
 * - plik cienia `shadow/<sesja>/<klucz>.json` (pisze serwer, hook przejmuje go `rename` na `.claimed`)
 *   i jego odwołanie `rename` na `.revoked` — kto pierwszy zrobił `rename`, ten wygrał;
 * - rekord cyklu `decisions/<sesja>/<klucz>.json` (wyłącznie serwer; hook go nie zna);
 * - odczyt znaczników prośby `markers/<sesja>/<nazwa>.json` (pisze hook, kasuje wyłącznie serwer: kanał zgód,
 *   `layer1/cycle.ts`).
 *
 * Nazwy i kształty wspólne z hookiem stoją w `hook/contract.ts`. Każdy zapis jest atomowy (`atomic.ts`).
 */
import { lstatSync, readdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { readRegularFileSync } from '../../../safe-read.ts';
import { ENGINE_SESSION_ID_PATTERN } from '../../../transcript-import.ts';
import {
  HOOK_CALL_KEY_PATTERN, HOOK_MARKERS_DIRNAME, HOOK_MARKER_ANON_PATTERN, HOOK_PENDING_DIRNAME,
  HOOK_SHADOW_CLAIMED_SUFFIX, HOOK_SHADOW_DIRNAME, HOOK_SHADOW_REVOKED_SUFFIX, HOOK_TOOL_INPUT_MAX_BYTES,
} from '../hook/contract.ts';
import type { HookCallDump, HookMarkerFile, HookShadowFile } from '../hook/contract.ts';
import { mcpEmptySuggestions, parseHookSuggestions } from '../hook/suggestions.ts';
import { writeAtomic } from './atomic.ts';

/** Katalog rekordów cyklu: `<dataDir>/decisions/<sesja>/<klucz>.json`. */
export const SHADOW_DECISIONS_DIRNAME = 'decisions';

/**
 * Read ceiling of a per-call dump: `tool_input` up to {@link HOOK_TOOL_INPUT_MAX_BYTES} (or the truncation marker) and
 * the other fields (`permission_suggestions`, `cwd`, identifiers) within the margin.
 */
const CALL_DUMP_MAX_BYTES = HOOK_TOOL_INPUT_MAX_BYTES + 64 * 1024;
/** Sufit odczytu rekordu cyklu — kilkaset bajtów pól prostych. */
const DECISION_MAX_BYTES = 16 * 1024;
/** Najwyżej tyle zrzutów jednej sesji naraz: więcej żywych hooków jednej sesji to już nie kolejka dialogów. */
const CALL_DUMPS_MAX = 64;

const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const callDumpSchema = z.looseObject({
  key: z.string().regex(HOOK_CALL_KEY_PATTERN),
  sessionId: z.string().regex(ENGINE_SESSION_ID_PATTERN),
  promptId: z.string().min(1).max(128),
  pid: z.number().int().positive(),
  startedAt: z.number().finite(),
  agentId: z.string().min(1).max(256).optional(),
  permissionMode: z.string().max(64).optional(),
  toolName: z.string().regex(TOOL_NAME_PATTERN),
  toolInput: z.unknown(),
  cwd: z.string(),
  at: z.number().finite(),
  inputSha256: z.string().regex(SHA256_PATTERN),
  // Checked by its own schema (`hook/suggestions.ts`): a bad value is dropped, it never makes the dump invalid.
  permissionSuggestions: z.unknown().optional(),
});

/** Ścieżka w katalogu sesji albo `null`, gdy sesja albo klucz nie nadają się na nazwę pliku. */
function sessionDir(dataDir: string, dirname: string, sessionId: string): string | null {
  return ENGINE_SESSION_ID_PATTERN.test(sessionId) ? join(dataDir, dirname, sessionId) : null;
}

function readJson(path: string, maxBytes: number): unknown {
  const read = readRegularFileSync(path, { maxBytes, followSymlink: false });
  if (read === null || read.truncated) return null;
  return JSON.parse(read.bytes.toString('utf8')) as unknown;
}

/** Zrzuty sesji z kompletnością odczytu ({@link scanCallDumps}). */
export interface CallDumpScan {
  /** Zrzuty posortowane po `at`: ta sama lista co {@link readCallDumps}. */
  readonly dumps: HookCallDump[];
  /**
   * `false` = odczyt mógł pominąć zrzut: osiągnięty sufit {@link CALL_DUMPS_MAX} albo plik o nazwie zrzutu, którego nie
   * dało się przeczytać (także zniknięty między `readdir` a odczytem, za duży, nie plik zwykły) ani przyjąć jako zrzut
   * tej sesji pod własnym kluczem (zły JSON, zły kształt, cudza sesja, inny klucz).
   */
  readonly complete: boolean;
}

/**
 * Zrzuty per wywołanie sesji z kompletnością odczytu (kanał zgód, `layer1/observe.ts`). Lista jest bit w bit ta sama
 * co {@link readCallDumps}: odczyt pomija te same pliki i kończy się na tym samym suficie. Brak katalogu = pusta lista
 * i odczyt kompletny; plik o innej nazwie niż `<klucz>.json` (plik tymczasowy zapisu atomowego) kompletności nie
 * zmienia. Błąd odczytu katalogu leci wyżej.
 */
export function scanCallDumps(dataDir: string, sessionId: string): CallDumpScan {
  const dir = sessionDir(dataDir, HOOK_PENDING_DIRNAME, sessionId);
  if (dir === null) return { dumps: [], complete: true };
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    if (isMissing(err)) return { dumps: [], complete: true };
    throw err;
  }
  const dumps: HookCallDump[] = [];
  let complete = true;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const key = name.slice(0, -'.json'.length);
    if (!HOOK_CALL_KEY_PATTERN.test(key)) continue;
    let parsed: unknown;
    try {
      parsed = readJson(join(dir, name), CALL_DUMP_MAX_BYTES);
    } catch {
      // Plik zniknął między `readdir` a odczytem (hook wyszedł) albo zły JSON — nie ma czego oceniać.
      complete = false;
      continue;
    }
    const entry = callDumpSchema.safeParse(parsed);
    if (!entry.success || entry.data.key !== key || entry.data.sessionId !== sessionId) {
      complete = false;
      continue;
    }
    const data = entry.data;
    const suggestions = parseHookSuggestions(data.permissionSuggestions);
    dumps.push({
      key: data.key, sessionId: data.sessionId, promptId: data.promptId, pid: data.pid, startedAt: data.startedAt,
      ...(data.agentId === undefined ? {} : { agentId: data.agentId }),
      ...(data.permissionMode === undefined ? {} : { permissionMode: data.permissionMode }),
      toolName: data.toolName, toolInput: data.toolInput, cwd: data.cwd, at: data.at, inputSha256: data.inputSha256,
      ...(suggestions === undefined ? {} : { permissionSuggestions: suggestions }),
      ...(mcpEmptySuggestions(data.toolName, suggestions) ? { mcpEmptySuggestions: true as const } : {}),
    });
    if (dumps.length >= CALL_DUMPS_MAX) {
      complete = false;
      break;
    }
  }
  return { dumps: dumps.sort((a, b) => a.at - b.at), complete };
}

/**
 * Zrzuty per wywołanie sesji, posortowane po `at` (tryb cienia). Plik w złym kształcie, o cudzej sesji albo pod
 * nazwą inną niż własny klucz jest pomijany; brak katalogu = pusta lista. Błąd odczytu katalogu leci wyżej.
 */
export function readCallDumps(dataDir: string, sessionId: string): HookCallDump[] {
  return scanCallDumps(dataDir, sessionId).dumps;
}

/**
 * Whether a file still lies under the name of the per-call dump `<key>.json` (`lstat`, without reading it). The hook
 * deletes its dump on every exit, so a present name after an incomplete {@link scanCallDumps} (the read cap, a file
 * that could not be read) means the hook may be alive. A session or key that does not fit a file name = `false`.
 */
export function callDumpPresent(dataDir: string, sessionId: string, key: string): boolean {
  const dir = sessionDir(dataDir, HOOK_PENDING_DIRNAME, sessionId);
  if (dir === null || !HOOK_CALL_KEY_PATTERN.test(key)) return false;
  return lstatSync(join(dir, `${key}.json`), { throwIfNoEntry: false }) !== undefined;
}

/** Sufit odczytu znacznika prośby: te same pola i ten sam sufit `tool_input` co zrzut per wywołanie. */
const MARKER_MAX_BYTES = CALL_DUMP_MAX_BYTES;

const markerSchema = z.looseObject({
  key: z.string().regex(HOOK_CALL_KEY_PATTERN).nullable(),
  sessionId: z.string().regex(ENGINE_SESSION_ID_PATTERN),
  promptId: z.string().min(1).max(128).nullable(),
  pid: z.number().int().positive(),
  startedAt: z.number().finite(),
  agentId: z.string().min(1).max(256).optional(),
  toolName: z.string().regex(TOOL_NAME_PATTERN),
  toolInput: z.unknown(),
  cwd: z.string(),
  at: z.number().finite(),
  inputSha256: z.string().regex(SHA256_PATTERN).nullable(),
});

/** Znacznik prośby z dysku z nazwą pliku (bez `.json`): klucz per wywołanie albo `anon-<pid>-<startedAt>`. */
export interface ReadMarker extends HookMarkerFile {
  readonly name: string;
}

/** Znaczniki sesji z kompletnością odczytu ({@link scanMarkers}). */
export interface MarkerScan {
  /** Znaczniki przeczytane w tym odczycie (tylko nazwy nieznane wołającemu), posortowane po `at`. */
  readonly markers: readonly ReadMarker[];
  /** Każda nazwa znacznika w katalogu sesji, także znana wołającemu i nieprzeczytana. */
  readonly names: ReadonlySet<string>;
  /**
   * `false` = odczyt mógł pominąć znacznik nieznany wołającemu: przekroczony budżet nowych nazw albo plik o nazwie
   * znacznika, którego nie dało się przeczytać (zniknięty między `readdir` a odczytem, za duży, nie plik zwykły) ani
   * przyjąć jako znacznik tej sesji pod własną nazwą (zły JSON, zły kształt, cudza sesja, inna nazwa).
   */
  readonly complete: boolean;
}

/** Czy `name` (bez `.json`) to nazwa znacznika prośby: klucz per wywołanie albo `anon-<pid>-<startedAt>`. */
export function isMarkerName(name: string): boolean {
  return HOOK_CALL_KEY_PATTERN.test(name) || HOOK_MARKER_ANON_PATTERN.test(name);
}

/** Katalog znaczników sesji albo `null`, gdy sesja nie nadaje się na nazwę katalogu. */
export function markersDirOf(dataDir: string, sessionId: string): string | null {
  return sessionDir(dataDir, HOOK_MARKERS_DIRNAME, sessionId);
}

/** Ścieżka znacznika albo `null`, gdy sesja albo nazwa nie nadają się na nazwę pliku. */
export function markerFilePath(dataDir: string, sessionId: string, name: string): string | null {
  const dir = markersDirOf(dataDir, sessionId);
  return dir === null || !isMarkerName(name) ? null : join(dir, `${name}.json`);
}

/** Znacznik zgodny z nazwą pliku: nazwa = klucz (z `promptId`) albo `anon-<pid>-<startedAt>` (bez klucza i `promptId`). */
function markerNamed(marker: z.infer<typeof markerSchema>, name: string): boolean {
  if (HOOK_CALL_KEY_PATTERN.test(name)) return marker.key === name && marker.promptId !== null;
  return marker.key === null && marker.promptId === null
    && name === `anon-${String(marker.pid)}-${String(marker.startedAt)}`;
}

/**
 * Znaczniki prośby sesji (kanał zgód, `layer1/observe.ts`). Nazwy, które wołający już zna (`known`: kandydat albo
 * wyjście puli, zrzut tej obserwacji), wchodzą tylko do {@link MarkerScan.names}, bez odczytu pliku. Nowych nazw
 * odczyt parsuje najwyżej `budget`; każda następna kończy odczyt jako niekompletny. Brak katalogu = pusto i odczyt
 * kompletny; plik o innej nazwie niż nazwa znacznika z `.json` (plik tymczasowy zapisu atomowego) jest pomijany.
 * Błąd odczytu katalogu leci wyżej.
 */
export function scanMarkers(
  dataDir: string, sessionId: string, known: (name: string) => boolean, budget: number,
): MarkerScan {
  const dir = markersDirOf(dataDir, sessionId);
  const names = new Set<string>();
  if (dir === null) return { markers: [], names, complete: true };
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch (err) {
    if (isMissing(err)) return { markers: [], names, complete: true };
    throw err;
  }
  const markers: ReadMarker[] = [];
  let complete = true;
  let parsed = 0;
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const name = file.slice(0, -'.json'.length);
    if (!isMarkerName(name)) continue;
    names.add(name);
    if (known(name)) continue;
    if (parsed >= budget) {
      complete = false;
      continue;
    }
    parsed += 1;
    let raw: unknown;
    try {
      raw = readJson(join(dir, file), MARKER_MAX_BYTES);
    } catch {
      // Plik zniknął między `readdir` a odczytem albo zły JSON: znacznik mógł być prośbą z wierzchu.
      complete = false;
      continue;
    }
    const entry = markerSchema.safeParse(raw);
    if (!entry.success || entry.data.sessionId !== sessionId || !markerNamed(entry.data, name)) {
      complete = false;
      continue;
    }
    const data = entry.data;
    markers.push({
      name, key: data.key, sessionId: data.sessionId, promptId: data.promptId, pid: data.pid, startedAt: data.startedAt,
      ...(data.agentId === undefined ? {} : { agentId: data.agentId }),
      toolName: data.toolName, toolInput: data.toolInput, cwd: data.cwd, at: data.at, inputSha256: data.inputSha256,
    });
  }
  return { markers: markers.sort((a, b) => a.at - b.at), names, complete };
}

/** Stan pliku cienia pod kluczem: niepodjęty `.json`, przejęty `.claimed`, odwołany `.revoked` albo brak. */
export type ShadowFileState = 'pending' | 'claimed' | 'revoked' | 'none';

function shadowBase(dataDir: string, sessionId: string, key: string): string | null {
  const dir = sessionDir(dataDir, HOOK_SHADOW_DIRNAME, sessionId);
  return dir === null || !HOOK_CALL_KEY_PATTERN.test(key) ? null : join(dir, key);
}

/**
 * Pisze plik cienia atomowo (plik tymczasowy bez końcówki `.json`, potem `rename`). Rzuca przy złej sesji,
 * złym kluczu i przy każdym błędzie zapisu — wołający zamienia to w wynik `error`, klawisz idzie i tak.
 */
export function writeShadowFile(dataDir: string, file: HookShadowFile): string {
  const base = shadowBase(dataDir, file.sessionId, file.key);
  if (base === null) throw new Error('plik cienia: zła sesja albo klucz');
  const dir = join(dataDir, HOOK_SHADOW_DIRNAME, file.sessionId);
  return writeAtomic(dir, `${file.key}.json`, `${JSON.stringify(file)}\n`);
}

/** Który plik cienia leży pod kluczem i kiedy powstał niepodjęty `.json` (mtime, ms; `null` poza `pending`). */
export function shadowFileState(
  dataDir: string, sessionId: string, key: string,
): { readonly state: ShadowFileState; readonly writtenAt: number | null } {
  const base = shadowBase(dataDir, sessionId, key);
  if (base === null) return { state: 'none', writtenAt: null };
  const pending = statOrNull(`${base}.json`);
  if (pending !== null) return { state: 'pending', writtenAt: pending };
  if (statOrNull(`${base}${HOOK_SHADOW_CLAIMED_SUFFIX}`) !== null) return { state: 'claimed', writtenAt: null };
  if (statOrNull(`${base}${HOOK_SHADOW_REVOKED_SUFFIX}`) !== null) return { state: 'revoked', writtenAt: null };
  return { state: 'none', writtenAt: null };
}

/**
 * Odwołanie: `rename` `<klucz>.json` → `<klucz>.revoked`. `revoked` = serwer był pierwszy (hook pliku nie
 * dostanie); `claimed` = hook przejął plik pierwszy; `gone` = nie ma ani pliku, ani przejęcia.
 */
export function revokeShadowFile(dataDir: string, sessionId: string, key: string): 'revoked' | 'claimed' | 'gone' {
  const base = shadowBase(dataDir, sessionId, key);
  if (base === null) return 'gone';
  try {
    renameSync(`${base}.json`, `${base}${HOOK_SHADOW_REVOKED_SUFFIX}`);
    return 'revoked';
  } catch (err) {
    if (!isMissing(err)) throw err;
  }
  return statOrNull(`${base}${HOOK_SHADOW_CLAIMED_SUFFIX}`) === null ? 'gone' : 'claimed';
}

/**
 * Zwolnienie sieroty, gdy pod kluczem nic nie leży: nowy `<klucz>.revoked` z treścią `{reason: 'sierota', at}`,
 * atomowo. Hook patrzy wyłącznie na obecność pliku i wychodzi bez wyniku. Rzuca przy złej sesji, kluczu i błędzie
 * zapisu.
 */
export function writeRevokedMarker(dataDir: string, sessionId: string, key: string, at: number): void {
  if (shadowBase(dataDir, sessionId, key) === null) throw new Error('znacznik odwołania: zła sesja albo klucz');
  const dir = join(dataDir, HOOK_SHADOW_DIRNAME, sessionId);
  writeAtomic(dir, `${key}${HOOK_SHADOW_REVOKED_SUFFIX}`, `${JSON.stringify({ reason: 'sierota', at })}\n`);
}

/** Stan cyklu decyzji w trybie cienia. Końcowe: `claimed`, `anulowany`, `unknown`. */
export const SHADOW_DECISION_STATES = ['pending', 'sent', 'claimed', 'anulowany', 'unknown'] as const;
export type ShadowDecisionState = (typeof SHADOW_DECISION_STATES)[number];

/** Rekord cyklu `decisions/<sesja>/<klucz>.json` — sam stan i czasy, bez `tool_input`. */
export interface ShadowDecisionRecord {
  readonly key: string;
  readonly sessionId: string;
  readonly decision: 'allow' | 'deny';
  readonly state: ShadowDecisionState;
  /** Powód stanu końcowego (`hook-martwy`, `sufit`, `restart`, `zapis`, `zniknal`, `klawisz`…). */
  readonly reason?: string;
  readonly toolName: string;
  readonly inputSha256: string;
  /** Proces hooka, którego zrzut wybrano (pid i czas startu) — do sprawdzenia życia po restarcie serwera. */
  readonly pid: number;
  readonly startedAt: number;
  /** Start serwera, który zaczął cykl. */
  readonly bootId: string;
  readonly pendingAt: number;
  /** Zapis pliku cienia. */
  readonly shadowAt?: number;
  /** Wysyłka klawisza (cyfra albo `escape`) i czy doszła. */
  readonly keyAt?: number;
  readonly keySent?: boolean;
  /** Przejście w stan końcowy. */
  readonly settledAt?: number;
}

const decisionSchema = z.looseObject({
  key: z.string().regex(HOOK_CALL_KEY_PATTERN),
  sessionId: z.string().regex(ENGINE_SESSION_ID_PATTERN),
  decision: z.enum(['allow', 'deny']),
  state: z.enum(SHADOW_DECISION_STATES),
  reason: z.string().max(64).optional(),
  toolName: z.string().regex(TOOL_NAME_PATTERN),
  inputSha256: z.string().regex(SHA256_PATTERN),
  pid: z.number().int().positive(),
  startedAt: z.number().finite(),
  bootId: z.string().min(1).max(64),
  pendingAt: z.number().finite(),
  shadowAt: z.number().finite().optional(),
  keyAt: z.number().finite().optional(),
  keySent: z.boolean().optional(),
  settledAt: z.number().finite().optional(),
});

/** Zapisuje rekord cyklu atomowo. Rzuca przy błędzie (wołający łapie: rekord to dziennik, nie bramka). */
export function writeDecision(dataDir: string, record: ShadowDecisionRecord): void {
  const dir = sessionDir(dataDir, SHADOW_DECISIONS_DIRNAME, record.sessionId);
  if (dir === null || !HOOK_CALL_KEY_PATTERN.test(record.key)) throw new Error('rekord cyklu: zła sesja albo klucz');
  writeAtomic(dir, `${record.key}.json`, `${JSON.stringify(record)}\n`);
}

/** Wszystkie rekordy cyklu z `decisions/` (wszystkie sesje). Plik w złym kształcie jest pomijany. */
export function readDecisions(dataDir: string): ShadowDecisionRecord[] {
  const root = join(dataDir, SHADOW_DECISIONS_DIRNAME);
  const out: ShadowDecisionRecord[] = [];
  for (const sessionId of listDir(root)) {
    if (!ENGINE_SESSION_ID_PATTERN.test(sessionId)) continue;
    for (const name of listDir(join(root, sessionId))) {
      if (!name.endsWith('.json')) continue;
      let parsed: unknown;
      try {
        parsed = readJson(join(root, sessionId, name), DECISION_MAX_BYTES);
      } catch {
        continue;
      }
      const entry = decisionSchema.safeParse(parsed);
      if (!entry.success || entry.data.sessionId !== sessionId || `${entry.data.key}.json` !== name) continue;
      const { reason, shadowAt, keyAt, keySent, settledAt, ...required } = entry.data;
      out.push({
        key: required.key, sessionId: required.sessionId, decision: required.decision, state: required.state,
        toolName: required.toolName, inputSha256: required.inputSha256, pid: required.pid,
        startedAt: required.startedAt, bootId: required.bootId, pendingAt: required.pendingAt,
        ...(reason === undefined ? {} : { reason }),
        ...(shadowAt === undefined ? {} : { shadowAt }),
        ...(keyAt === undefined ? {} : { keyAt }),
        ...(keySent === undefined ? {} : { keySent }),
        ...(settledAt === undefined ? {} : { settledAt }),
      });
    }
  }
  return out;
}

/** Nazwy w katalogu; brak katalogu = pusta lista. */
export function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }
}

/** mtime w ms albo `null`, gdy pliku nie ma. */
export function statOrNull(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

export function isMissing(err: unknown): boolean {
  return err !== null && typeof err === 'object' && (err as { code?: unknown }).code === 'ENOENT';
}
