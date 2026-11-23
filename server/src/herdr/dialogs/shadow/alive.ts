/**
 * `<dataDir>/alive.json` — znak życia serwera dla hooka w trybie cienia
 * (`docs/dialogs.md`, „Per-call dump and shadow mode”).
 *
 * Hook czyta plik przy każdym odpytaniu (co 250 ms) i czeka wyłącznie wtedy, gdy wszystkie warunki są prawdziwe:
 * `mode: "shadow"`, `send: true`, `ts` nie dalej niż 30 s od jego zegara, sesja na liście `sessions` (przy `main`
 * i `all` hook bierze kanał zgód, `layer1/`). Serwer pisze plik co {@link ALIVE_WRITE_INTERVAL_MS} atomowo
 * w KAŻDYM trybie, także `off`, i od razu po zmianie trybu efektywnego kanału zgód: hook nigdy nie zgaduje trybu z braku pliku. Przy zatrzymaniu serwera ostatni zapis niesie `mode: "off"` i pustą listę sesji, więc czekające
 * hooki wychodzą przy następnym odpytaniu. Proces zabity bez zatrzymania zostawia stary `ts`: hook przestaje
 * czekać najpóźniej po 30 s (`alive-ts`).
 *
 * `sessions` to `session_id` silnika sesji, które Rarog obserwuje (Claude w zakresie `RAROG_HERDR_ROOTS`).
 * Sesja zamknięta znika z listy przy następnym zapisie.
 *
 * `markers: true` (opcja {@link AliveWriterOptions.markers}, serwer z kanałem zgód) idzie wyłącznie z trybem kanału
 * otwartego, `main` albo `all` (`consentChannelOpen`): hook pisze wtedy znacznik prośby `markers/<sesja>/`
 * (`HookMarkerFile`). Przy `shadow` i `off` pola nie ma, więc plik
 * trybu cienia jest bit w bit ten sam co bez opcji. Dziennik przejść pola nie niesie.
 *
 * The first sessions after the start do not wait for the tick: {@link AliveWriter.sessionsChanged} writes at once when
 * the published list is empty and the current one is not. A hook started during a server restart waits for its
 * session on the list, so the tick would add up to 10 s to the restart window.
 *
 * Restart break: with a restart grace G above 0 ({@link AliveWriterOptions.graceMs}) every write carries
 * `phase: "starting"` from the first one until the first one with a session after the channel mode is resolved
 * ({@link AliveWriterOptions.channelStarting}), and the stop write carries `stop: {ts, graceMs}`. A hook that starts on
 * either waits for the next server's channel until `stop.ts + graceMs` instead of exiting
 * (`scripts/hooks/consent.mjs`). The kill switch drops both for good. The transition log does not carry them.
 *
 * Każde przejście opublikowanego stanu (start, zmiana `mode`, `send` albo listy sesji, stop) pisarz dopisuje do
 * `alive.jsonl` (`alive-log.ts`): po udanym zapisie `alive.json`, z jego `ts`. Linia, której dopisanie się nie
 * udało, czeka w kolejce z pierwotnym `at` i idzie w kolejności przy następnym zapisie. Zatrzymanie próbuje
 * opróżnić kolejkę także wtedy, gdy zapis `off` się nie udał (linia `stop` idzie tylko po udanym).
 */
import { join } from 'node:path';
import { ENGINE_SESSION_ID_PATTERN } from '../../../transcript-import.ts';
import {
  HOOK_ALIVE_FILENAME, HOOK_ALIVE_PHASE_STARTING, HOOK_CHANNEL_MODE_OFF, consentChannelOpen,
} from '../hook/contract.ts';
import type { HookAliveFile, HookChannelMode } from '../hook/contract.ts';
import { ALIVE_LOG_QUEUE_MAX, appendAliveLog, sameAliveState } from './alive-log.ts';
import type { AliveLogLine, AliveState } from './alive-log.ts';
import { writeAtomic } from './atomic.ts';

/** Rytm zapisu: trzy zapisy mieszczą się w progu świeżości hooka (`HOOK_ALIVE_MAX_AGE_MS`, 30 s). */
export const ALIVE_WRITE_INTERVAL_MS = 10_000;

/** Sufit listy sesji: plik ma zostać mały, a sesja ponad sufitem po prostu nie dostaje czekania hooka. */
export const ALIVE_SESSIONS_MAX = 256;

/** Lista sesji do pliku: tylko poprawne identyfikatory, bez powtórzeń, posortowana, z sufitem. */
export function aliveSessions(ids: Iterable<string>): string[] {
  const unique = new Set<string>();
  for (const id of ids) {
    if (ENGINE_SESSION_ID_PATTERN.test(id)) unique.add(id);
  }
  return [...unique].sort().slice(0, ALIVE_SESSIONS_MAX);
}

/** Zapisuje `alive.json` atomowo. `false` = zapis się nie udał (hook bez świeżego pliku nie czeka). */
export function writeAliveFile(dataDir: string, alive: HookAliveFile): boolean {
  try {
    writeAtomic(dataDir, HOOK_ALIVE_FILENAME, `${JSON.stringify(alive)}\n`);
    return true;
  } catch {
    return false;
  }
}

/** Ścieżka `alive.json` w katalogu danych. */
export function aliveFilePath(dataDir: string): string {
  return join(dataDir, HOOK_ALIVE_FILENAME);
}

export interface AliveWriterOptions {
  readonly dataDir: string;
  /**
   * Tryb do pliku: stały albo czytany przy każdym zapisie (serwer podaje tryb EFEKTYWNY kanału zgód,
   * `layer1/mode.ts`, i po jego zmianie woła {@link AliveWriter.writeNow}). Wyjątek odczytu = zapis z `off`.
   */
  readonly mode: HookChannelMode | (() => HookChannelMode);
  /** `RAROG_HERDR_SEND` czytany przy każdym zapisie. */
  readonly send: () => boolean;
  /** Losowy identyfikator startu procesu — hook zapisuje go w `shadow.jsonl` przy `czekam`. */
  readonly bootId: string;
  /** `session_id` silnika obserwowanych sesji, czytane przy każdym zapisie. */
  readonly sessions: () => Iterable<string>;
  /**
   * Serwer czyta znaczniki prośby (kanał zgód, warstwa 1): plik z trybem `main` albo `all` niesie `markers: true`. Bez
   * opcji pole nie pojawia się nigdy.
   */
  readonly markers?: boolean;
  /**
   * Restart grace G in ms (`RAROG_CONSENT_RESTART_GRACE`): above 0 the file carries `phase: "starting"` until the first
   * write with a session after the channel mode is resolved and the stop write `stop: {ts, graceMs}`. 0 or no option =
   * neither field.
   */
  readonly graceMs?: number;
  /**
   * The kill switch (`rarog dialogs off`) is on: from that write on neither restart field, so hooks exit as at `off`.
   */
  readonly killswitch?: () => boolean;
  /**
   * The effective channel mode is not resolved yet (reason `starting` in `layer1/mode.ts`): `phase` stays even with
   * sessions listed, because the `off` of the starting mode is not the server's answer. No option = resolved.
   */
  readonly channelStarting?: () => boolean;
  readonly now?: () => number;
  readonly intervalMs?: number;
  /** Linia logu przy pierwszej porażce zapisu i przy powrocie (bez spamu co 10 s). */
  readonly log?: (line: string) => void;
}

export interface AliveWriter {
  /** Pierwszy zapis od razu, potem co {@link ALIVE_WRITE_INTERVAL_MS}. Drugie wywołanie nic nie robi. */
  start(): void;
  /** Zapis teraz, poza rytmem (np. po zmianie trybu efektywnego albo listy sesji). */
  writeNow(): boolean;
  /**
   * The set of observed sessions may have changed. Writes now only when the published list is empty and the current
   * one is not; any other change waits for the tick. `true` = written. Before `start` and after `stop`: nothing.
   */
  sessionsChanged(): boolean;
  /**
   * Zatrzymuje rytm i zapisuje `mode: "off"` z pustą listą sesji oraz linię `stop` w `alive.jsonl`
   * (synchronicznie, przed wyjściem procesu). With a grace the file also carries `stop: {ts, graceMs}`.
   */
  stop(): void;
}

export function createAliveWriter(options: AliveWriterOptions): AliveWriter {
  const now = options.now ?? Date.now;
  const intervalMs = options.intervalMs ?? ALIVE_WRITE_INTERVAL_MS;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  let failing = false;
  /** Stan ostatniej linii zapisanej ALBO czekającej w kolejce; `null` = linii `start` jeszcze nie było. */
  let lastState: AliveState | null = null;
  /** Linie, których dopisanie się nie udało, w kolejności przejść (sufit {@link ALIVE_LOG_QUEUE_MAX}). */
  const queue: AliveLogLine[] = [];
  /** Kolejka wyrzuciła linię: następna udana niesie `luka: true`. */
  let gap = false;
  let logFailing = false;
  /** The last successful write carried at least one session. */
  let publishedSessions = false;
  const graceMs = options.graceMs ?? 0;
  /** `phase: "starting"` until the first write with a session after the mode is resolved (only with a grace). */
  let starting = graceMs > 0;
  /** The kill switch was seen: no restart field until the process ends. */
  let killed = false;

  /** Dopisuje kolejkę w kolejności; pierwsza porażka zatrzymuje resztę do następnego zapisu. */
  const flush = (): void => {
    while (queue.length > 0) {
      const head = queue[0];
      if (head === undefined) break;
      const ok = appendAliveLog(options.dataDir, gap ? { ...head, luka: true } : head);
      if (!ok) {
        if (!logFailing) options.log?.('shadow: failed to append alive.jsonl — the line waits in the queue');
        logFailing = true;
        return;
      }
      queue.shift();
      gap = false;
    }
    if (logFailing) options.log?.('shadow: alive.jsonl appended again');
    logFailing = false;
  };

  /** Przejście względem ostatniej linii zapisanej albo czekającej, potem próba dopisania kolejki. */
  const history = (at: number, state: AliveState, stop: boolean): void => {
    const ev = stop ? 'stop' : (lastState === null ? 'start' : (sameAliveState(lastState, state) ? null : 'zmiana'));
    if (ev !== null) {
      if (queue.length >= ALIVE_LOG_QUEUE_MAX) {
        queue.shift();
        if (!gap) options.log?.('shadow: alive.jsonl queue overflowed — gap in the transition history');
        gap = true;
      }
      queue.push({ at, ev, bootId: options.bootId, ...state });
      lastState = state;
    }
    flush();
  };

  const write = (mode: HookChannelMode, sessions: readonly string[], stop = false): boolean => {
    let ok: boolean;
    let ts = 0;
    let send = false;
    try {
      ts = now();
      send = options.send();
      if (options.killswitch?.() === true) killed = true;
      if (starting && sessions.length > 0 && options.channelStarting?.() !== true) starting = false;
      const restart: Pick<HookAliveFile, 'stop' | 'phase'> = killed ? {}
        : stop ? (graceMs > 0 ? { stop: { ts, graceMs } } : {})
        : (starting ? { phase: HOOK_ALIVE_PHASE_STARTING } : {});
      ok = writeAliveFile(options.dataDir, {
        ts, bootId: options.bootId, mode, send, sessions,
        ...(options.markers === true && consentChannelOpen(mode) ? { markers: true } : {}),
        ...restart,
      });
    } catch {
      // `send()` albo zegar rzucił — tak samo jak nieudany zapis: hook bez świeżego pliku nie czeka.
      ok = false;
    }
    if (!ok && !failing) options.log?.('shadow: failed to write alive.json — the hook will not wait');
    if (ok && failing) options.log?.('shadow: alive.json written again');
    failing = !ok;
    if (ok) publishedSessions = sessions.length > 0;
    if (ok) history(ts, { mode, send, sessions }, stop);
    return ok;
  };

  const currentSessions = (): string[] => {
    try {
      return aliveSessions(options.sessions());
    } catch {
      // Lista sesji niedostępna — zapis z pustą listą: hook nie czeka nigdzie, plik i tak świeży.
      return [];
    }
  };

  const tick = (): boolean => {
    const sessions = currentSessions();
    let mode: HookChannelMode;
    try {
      mode = typeof options.mode === 'function' ? options.mode() : options.mode;
    } catch {
      // Tryb nieznany = hook nie czeka: plik świeży, ale z `off`.
      mode = HOOK_CHANNEL_MODE_OFF;
    }
    return write(mode, sessions);
  };

  return {
    start(): void {
      if (timer !== null || stopped) return;
      tick();
      timer = setInterval(() => { tick(); }, intervalMs);
      timer.unref();
    },
    writeNow(): boolean {
      if (stopped) return false;
      return tick();
    },
    sessionsChanged(): boolean {
      if (timer === null || stopped || publishedSessions) return false;
      if (currentSessions().length === 0) return false;
      return tick();
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      if (timer !== null) clearInterval(timer);
      timer = null;
      // Linia `stop` idzie tylko po opublikowanym `off`; kolejka czekających linii — zawsze, bo później nie ma
      // już kolejnego zapisu, który by ją ponowił.
      if (!write(HOOK_CHANNEL_MODE_OFF, [], true)) flush();
    },
  };
}
