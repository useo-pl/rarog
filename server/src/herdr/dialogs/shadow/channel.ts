/**
 * Kanał cienia po stronie serwera (`RAROG_CONSENT_CHANNEL=shadow`, `docs/dialogs.md`, „Server in shadow mode”):
 * plik cienia PRZED klawiszem zgody albo odmowy z telefonu i cykl decyzji w `decisions/` bez skutku dla CLI.
 *
 * `prepare` czyta zrzuty per wywołanie sesji, pyta `ps` o życie ich hooków, liczy dowód „dialog stoi”
 * (`evidence.ts`) i przy dokładnie jednym kandydacie pasującym do karty pisze rekord `pending`, plik cienia
 * (`decision` z tapnięcia) i rekord `sent`. Zero albo wielu kandydatów = bez pliku, wynik z powodem. `prepare`
 * nigdy nie rzuca: każdy błąd to wynik `error`, a klawisz idzie i tak. `abandoned()` = driver przestał czekać
 * (sufit czasu): wtedy pliku już nie pisze.
 *
 * Po zapisie kanał obserwuje plik: `.claimed` (hook odebrał) = `claimed`; plik nieodebrany po śmierci procesu
 * hooka (CLI zabija hook wątku głównego przy `escape`) albo po {@link SHADOW_REVOKE_AFTER_MS} kanał odwołuje
 * (`rename` na `.revoked`) i stan to `anulowany`; hook szybszy od odwołania = `claimed`; plik, który zniknął bez
 * śladu, = `unknown`. Klawisz, który nie doszedł, odwołuje plik od razu. `recover` przy starcie serwera domyka
 * rekordy poprzedniego procesu tymi samymi regułami.
 *
 * `release` zwalnia sieroty: żywy hook wątku głównego, któremu dowód zabrał sygnał negatywny (`orphanHooks`
 * w `evidence.ts`), dostaje `<klucz>.revoked` i wychodzi bez wyniku. Klucza z własnym cyklem w toku (`pending`,
 * `sent`) `release` nie rusza — ten rozlicza obserwacja.
 */
import { HOOK_QUESTION_TOOL } from '../hook/contract.ts';
import type { HookCallDump } from '../hook/contract.ts';
import { queueOnScreen } from '../screen/queue.ts';
import { orphanHooks, pickShadowTarget, standingProofs } from './evidence.ts';
import type { OpenToolUse, RegistryEvidence, ShadowCard } from './evidence.ts';
import {
  readCallDumps, readDecisions, revokeShadowFile, shadowFileState, writeDecision, writeRevokedMarker,
  writeShadowFile,
} from './files.ts';
import type { ShadowDecisionRecord } from './files.ts';
import { psLiveness } from './liveness.ts';
import type { ProcessLiveness } from './liveness.ts';

/** Plik cienia nieodebrany tyle czasu kanał odwołuje (także po restarcie serwera). */
export const SHADOW_REVOKE_AFTER_MS = 60_000;

/** Kiedy po zapisie kanał sprawdza plik (ms od zapisu); ostatnie sprawdzenie odwołuje bez względu na hook. */
export const SHADOW_WATCH_DELAYS_MS: readonly number[] = [300, 1_000, 2_000, 5_000, 15_000, 30_000, 61_000];

/** Fraza linii logu `shadow: <sesja> …: <powód>`, gdy krok cienia nie zapisał pliku (zero albo kilku kandydatów). */
export const SHADOW_NO_FILE_LOG = 'no file';

/** Wynik kroku cienia przed klawiszem — pole `shadow` w `herdr-audit.log` (lista zamknięta). */
export const SHADOW_RESULTS = ['written', 'ambiguous', 'no-dump', 'no-match', 'no-proof', 'error'] as const;
export type ShadowResult = (typeof SHADOW_RESULTS)[number];

export interface ShadowRequest {
  /** `session_id` silnika sesji (`agent_session.value` panelu). */
  readonly engineSessionId: string;
  readonly decision: 'allow' | 'deny';
  readonly card: ShadowCard;
  readonly registry: RegistryEvidence;
  /** Ostatni odczyt ekranu panelu (licznik kolejki); `null` = brak. */
  readonly screen: string | null;
  /** Otwarte `tool_use` wątku głównego; `null` = transkrypt nieznany. */
  readonly transcript: readonly OpenToolUse[] | null;
}

export interface ShadowOutcome {
  readonly result: ShadowResult;
  /** Klucz zrzutu, pod którym leży plik cienia (`written`). */
  readonly key?: string;
  /** Szczegół do logu serwera: powód braku dowodu, `timeout`, `zapis`… */
  readonly detail?: string;
  /** Sesja wyniku `written` — `keySent` odwołuje plik bez ponownego pytania drivera. */
  readonly sessionId?: string;
}

/** Wejście zwalniania sierot jednej sesji: te same sygnały co dowodu, bez karty i ekranu. */
export interface ShadowReleaseRequest {
  readonly engineSessionId: string;
  readonly registry: RegistryEvidence;
  readonly transcript: readonly OpenToolUse[] | null;
}

/** Kanał widziany przez driver. */
export interface ShadowConsentChannel {
  /** Krok cienia przed klawiszem. Nie rzuca. */
  prepare(request: ShadowRequest, abandoned: () => boolean): Promise<ShadowOutcome>;
  /** Klawisz wyszedł albo nie: czas do rekordu; klawisz, który nie doszedł, odwołuje plik od razu. Nie rzuca. */
  keySent(outcome: ShadowOutcome, sent: boolean): void;
  /** Zwolnienie sierot sesji (znacznik `.revoked`); oddaje liczbę zwolnionych hooków. Nie rzuca. */
  release(request: ShadowReleaseRequest): Promise<number>;
}

export interface ShadowChannel extends ShadowConsentChannel {
  /** Start serwera: domyka rekordy poprzedniego procesu; oddaje liczbę rekordów domkniętych. Nie rzuca. */
  recover(): Promise<number>;
  /** Wszystkie obserwacje w toku zakończone (testy). */
  settled(): Promise<void>;
}

export interface ShadowChannelOptions {
  readonly dataDir: string;
  readonly bootId: string;
  readonly now?: () => number;
  readonly liveness?: ProcessLiveness;
  readonly log?: (line: string) => void;
  /** Zegar obserwacji; domyślnie `setTimeout(…).unref()`. */
  readonly schedule?: (fn: () => void, ms: number) => void;
  readonly watchDelaysMs?: readonly number[];
}

/** Karty spoza kanału zgody: dialogi ekranowe (`dialog:*`) i pytanie (ma własny kanał odpowiedzi). */
export function shadowCardEligible(toolName: string): boolean {
  return toolName !== '' && toolName !== HOOK_QUESTION_TOOL && !toolName.includes(':');
}

const TERMINAL = new Set(['claimed', 'anulowany', 'unknown']);

export function createShadowChannel(options: ShadowChannelOptions): ShadowChannel {
  const now = options.now ?? Date.now;
  const liveness = options.liveness ?? psLiveness();
  const log = options.log ?? ((): void => {});
  const delays = options.watchDelaysMs ?? SHADOW_WATCH_DELAYS_MS;
  const schedule = options.schedule ?? ((fn: () => void, ms: number): void => {
    setTimeout(fn, ms).unref();
  });
  /**
   * Ostatni stan rekordów tego procesu: klucz → rekord. Każda zmiana idzie przez {@link update}, które składa
   * łatkę z NAJNOWSZYM stanem — obserwacja i `keySent` biegną równolegle i nie mogą sobie nadpisać pól. Rekord
   * końcowy zostaje w mapie jeszcze {@link SHADOW_REVOKE_AFTER_MS}, bo klawisz potrafi wyjść po odbiorze.
   */
  const records = new Map<string, ShadowDecisionRecord>();
  const inFlight = new Set<Promise<void>>();
  /** Klucze zrzutów, których hook według `ps` nie żyje — bez ponownego `ps` co odczyt rejestru. */
  const deadKeys = new Map<string, Set<string>>();

  const short = (id: string): string => id.slice(0, 8);

  const update = (base: ShadowDecisionRecord, patch: Partial<ShadowDecisionRecord>): ShadowDecisionRecord => {
    const latest = records.get(base.key) ?? base;
    // Stan końcowy jest końcowy: spóźniona łatka stanu go nie cofa, pola czasu tak.
    const terminal = TERMINAL.has(latest.state);
    const next: ShadowDecisionRecord = terminal
      ? {
        ...latest, ...patch, state: latest.state,
        ...(latest.reason === undefined ? {} : { reason: latest.reason }),
        ...(latest.settledAt === undefined ? {} : { settledAt: latest.settledAt }),
      }
      : { ...latest, ...patch };
    try {
      writeDecision(options.dataDir, next);
    } catch {
      log(`shadow: failed to write record ${short(next.key)} (${next.state})`);
    }
    records.set(next.key, next);
    if (!terminal && TERMINAL.has(next.state)) {
      schedule(() => { if (records.get(next.key) === next) records.delete(next.key); }, SHADOW_REVOKE_AFTER_MS);
    }
    return next;
  };

  const finish = (
    record: ShadowDecisionRecord, state: ShadowDecisionRecord['state'], reason?: string,
  ): ShadowDecisionRecord => {
    const latest = records.get(record.key) ?? record;
    if (TERMINAL.has(latest.state)) return latest;
    const done = update(record, { state, settledAt: now(), ...(reason === undefined ? {} : { reason }) });
    log(`shadow: ${short(record.sessionId)} ${short(record.key)} ${record.decision} → ${state}`
      + `${reason === undefined ? '' : ` (${reason})`}`);
    return done;
  };

  const revoke = (record: ShadowDecisionRecord, reason: string): ShadowDecisionRecord => {
    let outcome: 'revoked' | 'claimed' | 'gone';
    try {
      outcome = revokeShadowFile(options.dataDir, record.sessionId, record.key);
    } catch {
      return finish(record, 'unknown', 'odwolanie-blad');
    }
    if (outcome === 'revoked') return finish(record, 'anulowany', reason);
    if (outcome === 'claimed') return finish(record, 'claimed');
    return finish(record, 'unknown', 'zniknal');
  };

  /** Jedno sprawdzenie pliku rekordu `sent`; `final` = ostatnie, odwołuje bez względu na hook. */
  const check = async (record: ShadowDecisionRecord, final: boolean): Promise<ShadowDecisionRecord> => {
    const { state, writtenAt } = shadowFileState(options.dataDir, record.sessionId, record.key);
    if (state === 'claimed') return finish(record, 'claimed');
    if (state === 'revoked') return finish(record, 'anulowany', 'odwolany');
    if (state === 'none') return finish(record, 'unknown', 'zniknal');
    const age = now() - (record.shadowAt ?? writtenAt ?? record.pendingAt);
    if (final || age >= SHADOW_REVOKE_AFTER_MS) return revoke(record, 'sufit');
    const probe = await liveness([{ pid: record.pid, startedAt: record.startedAt }], now());
    const alive = probe.get(record.pid) ?? null;
    if (alive === false) return revoke(record, 'hook-martwy');
    return record;
  };

  /** Obserwacja rekordu `sent` od `fromMs` po zapisie pliku. */
  const watch = (record: ShadowDecisionRecord, fromMs: number): void => {
    const steps = delays.filter((delay) => delay > fromMs);
    const run = (index: number): void => {
      const delay = steps[index];
      if (delay === undefined) return;
      const prev = index === 0 ? fromMs : (steps[index - 1] ?? fromMs);
      schedule(() => {
        const current = records.get(record.key);
        if (current?.state !== 'sent') return;
        const task = check(current, index === steps.length - 1)
          .then((next) => { if (next.state === 'sent') run(index + 1); })
          .catch(() => { finish(current, 'unknown', 'blad'); });
        track(task);
      }, delay - prev);
    };
    if (steps.length === 0) {
      track(check(record, true).then(() => undefined).catch(() => { finish(record, 'unknown', 'blad'); }));
      return;
    }
    run(0);
  };

  const track = (task: Promise<unknown>): void => {
    const done = task.then(() => undefined, () => undefined);
    inFlight.add(done);
    void done.finally(() => { inFlight.delete(done); });
  };

  const prepare = async (request: ShadowRequest, abandoned: () => boolean): Promise<ShadowOutcome> => {
    const sid = request.engineSessionId;
    try {
      const dumps = readCallDumps(options.dataDir, sid);
      if (dumps.length === 0) return { result: 'no-dump' };
      const main = dumps.filter((dump) => dump.agentId === undefined);
      const processes = (main.length > 0 ? await liveness(main, now()) : new Map<number, boolean | null>());
      const alive = new Map(dumps.map((dump) => [dump.key, processes.get(dump.pid) ?? null]));
      const verdicts = standingProofs({
        now: now(), dumps, alive, registry: request.registry, queue: queueOnScreen(request.screen),
        transcript: request.transcript,
      });
      const pick = pickShadowTarget(dumps, verdicts, request.card);
      if (pick.kind === 'ambiguous') {
        log(`shadow: ${short(sid)} ${SHADOW_NO_FILE_LOG}: ${String(pick.keys.length)} candidates`
          + ` (${request.decision})`);
        return { result: 'ambiguous' };
      }
      if (pick.kind === 'none') {
        const detail = pick.detail === undefined ? pick.why : `${pick.why}:${pick.detail}`;
        log(`shadow: ${short(sid)} ${SHADOW_NO_FILE_LOG}: ${detail} (${request.decision})`);
        return { result: pick.why, detail };
      }
      if (abandoned()) return { result: 'error', detail: 'timeout' };
      return write(request, pick.dump);
    } catch {
      log(`shadow: ${short(sid)} shadow step error (${request.decision}) — the key goes without a file`);
      return { result: 'error', detail: 'blad' };
    }
  };

  const write = (request: ShadowRequest, dump: HookCallDump): ShadowOutcome => {
    const base: ShadowDecisionRecord = {
      key: dump.key, sessionId: dump.sessionId, decision: request.decision, state: 'pending',
      toolName: dump.toolName, inputSha256: dump.inputSha256, pid: dump.pid, startedAt: dump.startedAt,
      bootId: options.bootId.slice(0, 64), pendingAt: now(),
    };
    update(base, {});
    const at = now();
    try {
      writeShadowFile(options.dataDir, {
        key: dump.key, sessionId: dump.sessionId, decision: request.decision, inputSha256: dump.inputSha256, at,
      });
    } catch {
      finish(base, 'unknown', 'zapis');
      return { result: 'error', detail: 'zapis' };
    }
    const sent = update(base, { state: 'sent', shadowAt: at });
    log(`shadow: ${short(dump.sessionId)} ${short(dump.key)} shadow file ${request.decision}`);
    watch(sent, 0);
    return { result: 'written', key: dump.key, sessionId: dump.sessionId };
  };

  const keySent = (outcome: ShadowOutcome, sent: boolean): void => {
    if (outcome.result !== 'written' || outcome.key === undefined) return;
    try {
      const record = records.get(outcome.key);
      if (record === undefined) return;
      const stamped = update(record, { keyAt: now(), keySent: sent });
      // Klawisz nie doszedł: dialog stoi dalej, a plik cienia mówiłby o decyzji, której nie było.
      if (!sent && stamped.state === 'sent') revoke(stamped, 'klawisz');
    } catch {
      // Rekord to dziennik — klawisz już poszedł, nic tu go nie zmieni.
    }
  };

  const release = async (request: ShadowReleaseRequest): Promise<number> => {
    const sid = request.engineSessionId;
    try {
      const all = readCallDumps(options.dataDir, sid).filter((dump) => dump.agentId === undefined);
      const dead = deadKeys.get(sid) ?? new Set<string>();
      for (const key of dead) if (!all.some((dump) => dump.key === key)) dead.delete(key);
      const dumps = all.filter((dump) => !dead.has(dump.key));
      if (dumps.length === 0) return 0;
      const input = { registry: request.registry, transcript: request.transcript };
      // Najpierw bez `ps`: czy przy założeniu „wszystkie żyją” jest choć jedna sierota. Zwykle nie ma.
      const assumed = orphanHooks({ ...input, now: now(), dumps, alive: new Map(dumps.map((d) => [d.key, true])) });
      if (assumed.length === 0) return 0;
      const processes = await liveness(dumps, now());
      const alive = new Map(dumps.map((dump) => [dump.key, processes.get(dump.pid) ?? null]));
      for (const dump of dumps) if (alive.get(dump.key) === false) dead.add(dump.key);
      if (dead.size > 0) deadKeys.set(sid, dead);
      let released = 0;
      for (const orphan of orphanHooks({ ...input, now: now(), dumps, alive })) {
        const own = records.get(orphan.key);
        if (own !== undefined && !TERMINAL.has(own.state)) continue;
        const state = shadowFileState(options.dataDir, sid, orphan.key).state;
        if (state === 'claimed' || state === 'revoked') continue;
        if (state === 'pending') {
          if (revokeShadowFile(options.dataDir, sid, orphan.key) !== 'revoked') continue;
        } else {
          writeRevokedMarker(options.dataDir, sid, orphan.key, now());
        }
        released += 1;
        log(`shadow: ${short(sid)} ${short(orphan.key)} orphan released (${orphan.why})`);
      }
      return released;
    } catch {
      log(`shadow: ${short(sid)} orphan release error — hooks keep waiting`);
      return 0;
    }
  };

  const recover = async (): Promise<number> => {
    let closed = 0;
    let stored: ShadowDecisionRecord[];
    try {
      stored = readDecisions(options.dataDir);
    } catch {
      log('shadow: failed to read decisions/ at start');
      return 0;
    }
    for (const record of stored) {
      if (TERMINAL.has(record.state)) continue;
      try {
        const file = shadowFileState(options.dataDir, record.sessionId, record.key);
        // Rekord `pending` bez pliku: proces padł przed zapisem pliku cienia (albo zapis się nie udał).
        if (record.state === 'pending' && file.state === 'none') {
          finish(record, 'unknown', 'restart');
          closed += 1;
          continue;
        }
        records.set(record.key, record);
        const sent = record.state === 'pending'
          ? update(record, { state: 'sent', shadowAt: file.writtenAt ?? record.pendingAt })
          : record;
        const next = await check(sent, false);
        if (next.state === 'sent') {
          watch(next, now() - (next.shadowAt ?? next.pendingAt));
        } else {
          closed += 1;
        }
      } catch {
        finish(record, 'unknown', 'restart');
        closed += 1;
      }
    }
    return closed;
  };

  return {
    prepare,
    keySent,
    release,
    recover,
    async settled(): Promise<void> {
      while (inFlight.size > 0) await Promise.all([...inFlight]);
    },
  };
}
