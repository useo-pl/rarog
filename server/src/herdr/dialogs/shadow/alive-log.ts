/**
 * `<dataDir>/alive.jsonl` — dziennik przejść `alive.json` (`docs/dialogs.md`, „Server in shadow mode”).
 * Pisze go WYŁĄCZNIE serwer (pisarz z `alive.ts`), hook go nie czyta. `alive.json` jest nadpisywany co 10 s,
 * więc bez tego dziennika nie wiadomo, jaki stan widział hook w chwili czekania; czyta go audyt trybu cienia
 * właściciela instalacji.
 *
 * Linia `{at, ev, bootId, mode, send, sessions}` idzie wyłącznie przy przejściu, po UDANYM zapisie `alive.json`
 * (dziennik opisuje stany, które hook mógł przeczytać), a `at` to `ts` tego zapisu:
 *
 * - `start`: pierwszy zapis procesu;
 * - `zmiana`: `mode`, `send` albo lista sesji inne niż w ostatniej linii tego procesu (nie co 10 s), także zmiana
 *   trybu efektywnego kanału zgód (rozstrzygnięcie po starcie gniazd: `off` → `main` albo `shadow`, wyłącznik);
 * - `stop`: zapis `mode: "off"` przy zatrzymaniu serwera (SIGTERM, SIGINT). Proces zabity bez zatrzymania linii
 *   `stop` nie ma: koniec jest nieznany, przed następnym `start`.
 *
 * Zapis jednym `appendFileSync` z flagą `a`, prawa `0600` przy tworzeniu. Best effort: błąd nie wstrzymuje
 * niczego. Linia nieudana czeka w kolejce pisarza z pierwotnym `at` i stanem i idzie przy następnym zapisie,
 * w kolejności, przed nowszymi; przy zatrzymaniu serwera także po nieudanym zapisie `off`. Kolejka ma sufit
 * {@link ALIVE_LOG_QUEUE_MAX}: przepełnienie wyrzuca najstarszą linię, a następna udana linia niesie
 * `luka: true`, czyli „historia tego procesu przed tą linią jest niepełna”.
 * Rotację do `.1` robi sprzątanie startu (`sweep.ts`).
 */
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOOK_CHANNEL_MODES } from '../hook/contract.ts';
import type { HookChannelMode } from '../hook/contract.ts';

export const ALIVE_LOG_FILENAME = 'alive.jsonl';

/** Sufit kolejki linii, których dopisanie się nie udało (pisarz ponawia je w kolejności). */
export const ALIVE_LOG_QUEUE_MAX = 50;

export const ALIVE_LOG_EVENTS = ['start', 'zmiana', 'stop'] as const;
export type AliveLogEvent = typeof ALIVE_LOG_EVENTS[number];

/** Stan opublikowany w `alive.json` bez `ts` i `bootId`. */
export interface AliveState {
  readonly mode: HookChannelMode;
  readonly send: boolean;
  readonly sessions: readonly string[];
}

export interface AliveLogLine extends AliveState {
  readonly at: number;
  readonly ev: AliveLogEvent;
  readonly bootId: string;
  /** Linie tego procesu sprzed tej przepadły (przepełniona kolejka): historia przed nią jest niepełna. */
  readonly luka?: true;
}

/** Położenie złej linii: `at` ostatniej dobrej linii przed nią i pierwszej po niej (`null` = brak takiej). */
export interface SkippedLine {
  readonly after: number | null;
  readonly before: number | null;
}

export function aliveLogPath(dataDir: string): string {
  return join(dataDir, ALIVE_LOG_FILENAME);
}

/** Czy dwa stany są tym samym przejściem (lista sesji porównywana jako zbiór). */
export function sameAliveState(a: AliveState, b: AliveState): boolean {
  if (a.mode !== b.mode || a.send !== b.send || a.sessions.length !== b.sessions.length) return false;
  const set = new Set(a.sessions);
  return b.sessions.every((id) => set.has(id)) && set.size === new Set(b.sessions).size;
}

/** Dopisuje linię. `false` = zapis się nie udał (bez wyjątku). */
export function appendAliveLog(dataDir: string, line: AliveLogLine): boolean {
  try {
    appendFileSync(aliveLogPath(dataDir), `${JSON.stringify(line)}\n`, { flag: 'a', mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

const EVENTS: ReadonlySet<string> = new Set(ALIVE_LOG_EVENTS);
const MODES: ReadonlySet<string> = new Set(HOOK_CHANNEL_MODES);

/** Jedna linia albo `null`, gdy nie ma kształtu linii dziennika. */
function parseLine(raw: string): AliveLogLine | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const { at, ev, bootId, mode, send, sessions, luka } = parsed as Record<string, unknown>;
  if (typeof at !== 'number' || !Number.isFinite(at) || typeof ev !== 'string' || !EVENTS.has(ev)
    || typeof bootId !== 'string' || bootId === '' || typeof mode !== 'string' || !MODES.has(mode)
    || typeof send !== 'boolean' || !Array.isArray(sessions) || !sessions.every((s) => typeof s === 'string')
    || (luka !== undefined && luka !== true)) {
    return null;
  }
  return {
    at, ev: ev as AliveLogEvent, bootId, mode: mode as HookChannelMode, send, sessions: sessions as string[],
    ...(luka === true ? { luka } : {}),
  };
}

/**
 * Linie dziennika; pusta pomijana, zła (nie JSON, nie obiekt, pole spoza kształtu) liczona w `skipped`
 * z położeniem w `skippedAt` (czasy sąsiednich dobrych linii).
 */
export function parseAliveLog(text: string): { lines: AliveLogLine[]; skipped: number; skippedAt: SkippedLine[] } {
  const lines: AliveLogLine[] = [];
  const open: { after: number | null }[] = [];
  const skippedAt: SkippedLine[] = [];
  let last: number | null = null;
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue;
    const line = parseLine(raw);
    if (line === null) {
      open.push({ after: last });
      continue;
    }
    for (const bad of open.splice(0)) skippedAt.push({ after: bad.after, before: line.at });
    lines.push(line);
    last = line.at;
  }
  for (const bad of open) skippedAt.push({ after: bad.after, before: null });
  return { lines, skipped: skippedAt.length, skippedAt };
}
