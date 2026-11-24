/**
 * Server start: the consent channel (layer 1). The hook's secret registry, the channel cycle with its record
 * recovery and timers, the effective mode listener, the admin socket control, the manager port and the driver ports
 * of one session. `main()` in `server/src/index.ts` calls these steps in its start order; the registration socket
 * itself starts there, after `listen`.
 */
import { stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { createConsentHandler, redact, startConsentSocket } from '../auth/index.ts';
import type { ConsentAdminControl, ConsentSocket } from '../auth/index.ts';
import { defaultStoreRoot } from '../cli-store.ts';
import type { CliVersionReader } from '../cli-version.ts';
import type { RarogConfig } from '../config.ts';
import { inWorkAreaOnDisk } from '../config/work-area.ts';
import type { ConsentObserveRequest } from '../drivers/herdr-driver.ts';
import { hookChildRunning, statuslineFreshness } from '../drivers/herdr/consent-no-hook-io.ts';
import type { ConsentNoHookSources } from '../drivers/herdr/consent-no-hook.ts';
import { createConsentEvidenceReview, createConsentEvidenceScanner } from '../herdr/consent-evidence.ts';
import { consentStep } from '../herdr/consent-step.ts';
import type { SubagentObservation } from '../herdr/consent-subagent.ts';
import { consentChannelOpen } from '../herdr/dialogs/hook/contract.ts';
import type { ConsentTurnFacts } from '../herdr/dialogs/layer1/bind.ts';
import type { HookListSessionEntry } from '../herdr/dialogs/layer1/hook-list/hook-list.ts';
import { createSessionFacts } from '../herdr/dialogs/layer1/hook-list/session-facts.ts';
import { CONSENT_HOLDING_STATES, CONSENT_POOL_MAX } from '../herdr/dialogs/layer1/contract.ts';
import { createConsentCycle } from '../herdr/dialogs/layer1/cycle.ts';
import type { ConsentCycle, ConsentSessionRevokeCause } from '../herdr/dialogs/layer1/cycle.ts';
import type { ConsentModeControl, ConsentModeSource } from '../herdr/dialogs/layer1/mode.ts';
// Osobny import: strażnik wspólnej obserwacji (`layer1-obserwacja`) czyta linię importu `observeConsentSession`.
import { observeConsentSession } from '../herdr/dialogs/layer1/observe.ts';
import type { ConsentHiddenSources, ConsentProofGate } from '../herdr/dialogs/layer1/observe.ts';
import { createConsentClaims } from '../herdr/dialogs/layer1/receipt.ts';
import { recoverThenSweepConsent } from '../herdr/dialogs/layer1/records.ts';
import { retireRunningAfterRecover } from '../herdr/dialogs/layer1/frames.ts';
import {
  consentRegistrationWanted, consentRegistryScopeOf, createConsentRegistry,
} from '../herdr/dialogs/layer1/registry.ts';
import type { ConsentRegistry } from '../herdr/dialogs/layer1/registry.ts';
import { createRefusalDumper } from '../herdr/dialogs/refusals.ts';
import type { AliveWriter } from '../herdr/dialogs/shadow/alive.ts';
import { scanCallDumps, scanMarkers } from '../herdr/dialogs/shadow/files.ts';
import { psLiveness } from '../herdr/dialogs/shadow/liveness.ts';
import type { ProcessLiveness } from '../herdr/dialogs/shadow/liveness.ts';
import { HOOK_INSTALLED_SCRIPT_REL, hookCommand } from '../herdr/hook-commands.ts';
import { defaultStatuslineRoot } from '../herdr/statusline.ts';
import { TRANSCRIPT_EXT, locateTranscript } from '../herdr/transcript-path.ts';
import type { Logger } from '../router.ts';
import type { ConsentManagerCard, ConsentManagerChannel } from '../sessions/manager.ts';
import type { ManagerApi } from '../sessions/manager-api.ts';
import type { HerdrRuntime } from './herdr.ts';

/**
 * Cykl i rejestr kanału zgód dla driverów; ustawiane po utworzeniu rejestru (wyłącznie przy konfiguracji `main` albo
 * `all`).
 */
export interface ConsentLink {
  cycle: ConsentCycle | null;
  registry: ConsentRegistry | null;
}

/**
 * Chwila przyjęcia najnowszej żywej rejestracji sesji, której klucz nie ma jeszcze karty kanału (w żadnym stanie), albo
 * `null`. Karta zgody z ekranu albo jsonl czeka wtedy na kartę kanału, z sufitem w driverze
 * (`HERDR_CONSENT_CARD_WAIT_MS`). Rejestracja prośby subagenta (`agentId`, tryb `all`) się nie liczy.
 */
export function consentCardAwaitedAt(link: ConsentLink, engineSessionId: string): number | null {
  const { cycle, registry } = link;
  if (cycle === null || registry === null) return null;
  const carded = new Set(cycle.cards(engineSessionId).map((card) => card.permId));
  let newest: number | null = null;
  for (const entry of registry.entries()) {
    if (entry.sessionId !== engineSessionId || entry.agentId !== undefined || carded.has(entry.key)) continue;
    if (newest === null || entry.acceptedAt > newest) newest = entry.acceptedAt;
  }
  return newest;
}

/**
 * Czy dialog sesji trzyma karta kanału ({@link CONSENT_HOLDING_STATES}: hook czeka na plik odpowiedzi). Wtedy driver
 * nie wystawia karty z ekranu i nie wysyła klawisza decyzji; odpowiedź odebrana i `unknown` dialogu nie trzymają.
 */
export function consentCardLive(link: ConsentLink, engineSessionId: string): boolean {
  return link.cycle?.cards(engineSessionId)
    .some((card) => (CONSENT_HOLDING_STATES as readonly string[]).includes(card.state)) === true;
}

/**
 * Obserwacja kanału zgód jednej sesji (warstwa 1): jedna definicja z procesem pomiaru kanału,
 * `observeConsentSession` (`layer1/observe.ts`), z rejestrem CLI, otwartymi `tool_use` i ekranem, który driver
 * przeczytał dla tej obserwacji (z chwilą rozpoczęcia odczytu). `subagents` (tylko przy trybie efektywnym `all`)
 * daje obserwacji fakty plików subagentów, z których prośba subagenta ma dowód z wierzchu, a `hidden`
 * (też tylko przy `all`) pamięć utraty wierzchu ekranu i listę hooków sesji dla dowodu ukrytego. `proofRule`
 * daje reguły dowodu sesji (wątek główny, subagenci) z bramki wersji CLI (`createConsentProofGate`) z wersją
 * procesu z odczytu rejestru tej obserwacji, nie z innej migawki, i z plikiem kanarka.
 * Nie rzuca: błąd odczytu zostawia karty bez zmian i jedną linię w logu (`consentStep`).
 */
export async function observeConsent(
  link: ConsentLink, dataDir: string, liveness: ProcessLiveness, request: ConsentObserveRequest,
  subagents: SubagentObservation | null, hidden: ConsentHiddenSources | null,
  proofGate: ConsentProofGate, log: (line: string) => void,
): Promise<void> {
  const cycle = link.cycle;
  if (cycle === null) return;
  const sessionId = request.engineSessionId;
  // On failure the cards stay; the next registry read tries again.
  await consentStep('observe', log, () => observeConsentSession(cycle, {
    dataDir, sessionId, liveness, registry: request.registry, transcript: request.transcript,
    screen: request.screen, proofRule: proofGate.ruleFor(sessionId, request.registry),
    ...(subagents === null ? {} : { subagentTurns: (requests) => subagents.read(sessionId, requests) }),
    ...(subagents === null || hidden === null ? {} : { hidden }),
  }));
}

/**
 * The session process of an engine session for the session hook list: the one live entry of the CLI registry (pid and
 * start); `null` without a registry read, with an unreadable pid, an unlisted session or more than one entry.
 */
export function consentSessionEntry(
  cliVersionReader: CliVersionReader,
): (engineSessionId: string) => Promise<HookListSessionEntry | null> {
  return async (engineSessionId) => {
    const read = await cliVersionReader({ registryOnly: true });
    if (read.registry === null || (read.unreadablePids ?? 0) > 0) return null;
    if (read.unlistedSessions?.has(engineSessionId) === true) return null;
    const entries = read.registry.get(engineSessionId);
    const entry = entries?.length === 1 ? entries[0] : undefined;
    return entry === undefined ? null
      : { pid: entry.pid, ...(entry.startedAt === undefined ? {} : { startedAt: entry.startedAt }) };
  };
}

/** Record states of a request the hook still waits on: anything later is answered or settled. */
const CONSENT_UNSETTLED_STATES: ReadonlySet<string> = new Set(['pending', 'deciding', 'sent']);

/**
 * Whether a trace of Rarog's `PermissionRequest` hook stands for the session (the consent-without-hook detector,
 * `drivers/herdr/consent-no-hook.ts`): a live registration accepted at or after `since` (ms of the epoch, the end of
 * the previous dialog episode), a channel card holding a dialog, a request of the channel pool (dump or request
 * marker) without an exit whose record is not settled, a pool past its cap, a per-call dump on disk whose record is
 * not settled (the hook deletes it on every exit, so it stands while the hook lives), or a request marker on disk the
 * pool has not taken whose record is not settled; an incomplete read of the dumps or markers counts too. Settled
 * records, and dumps and requests under them, are no trace. Throws on a read error of the dump or marker directory.
 */
export function consentHookTrace(link: ConsentLink, dataDir: string, sessionId: string, since: number): boolean {
  const { cycle, registry } = link;
  if (registry?.entries().some((entry) => entry.sessionId === sessionId && entry.acceptedAt >= since) === true) {
    return true;
  }
  // Without the cycle there is no record to settle a request: every request counts.
  const open = (key: string): boolean => {
    const record = cycle?.record(sessionId, key) ?? null;
    return record === null || CONSENT_UNSETTLED_STATES.has(record.state);
  };
  if (cycle !== null) {
    if (cycle.cards(sessionId).some((card) => (CONSENT_HOLDING_STATES as readonly string[]).includes(card.state))) {
      return true;
    }
    const pool = cycle.pool(sessionId);
    if (pool.overflow) return true;
    if (pool.candidates.some((candidate) => candidate.exitAt === null && open(candidate.dump.key))) return true;
  }
  const dumps = scanCallDumps(dataDir, sessionId);
  if (!dumps.complete || dumps.dumps.some((dump) => open(dump.key))) return true;
  // Request markers the pool has not taken yet (written after the last channel observation). A marker under a dump
  // key or a name the pool knows is decided above; a marker without a call key has no record that settles it.
  const dumpKeys = new Set(dumps.dumps.map((dump) => dump.key));
  const markers = scanMarkers(
    dataDir, sessionId, (name) => dumpKeys.has(name) || cycle?.poolKnows(sessionId, name) === true, CONSENT_POOL_MAX,
  );
  return !markers.complete || markers.markers.some((marker) => marker.key === null || open(marker.key));
}

export interface ConsentNoHookOptions {
  readonly link: ConsentLink;
  readonly dataDir: string;
  /** Home of the server's user: the hook copy and the settings the session facts read live under it. */
  readonly home: string;
  /** The work area roots (`RAROG_HERDR_ROOTS`), the ones the hook gets in `roots.json`. */
  readonly roots: readonly string[];
  /** The session process lookup of the session hook list ({@link consentSessionEntry}). */
  readonly entry: (engineSessionId: string) => Promise<HookListSessionEntry | null>;
  readonly proofGate: Pick<ConsentProofGate, 'current'>;
  /** The restart grace G (`config.consentRestartGraceMs`) and the process start it counts from, epoch ms. */
  readonly restartGraceMs: number;
  readonly startedAt: number;
}

/** The sources of the consent-without-hook detector, shared by every driver of the process. */
export function consentNoHookSources(options: ConsentNoHookOptions): ConsentNoHookSources {
  const script = join(options.home, HOOK_INSTALLED_SCRIPT_REL);
  const statuslineRoot = defaultStatuslineRoot();
  // One instance per process, with the cache of its own; it reads like the session hook list and logs nothing.
  const facts = createSessionFacts({ home: options.home, accepted: [hookCommand(options.home)], entry: options.entry });
  return {
    hookTrace: (sessionId, since) => {
      try {
        return consentHookTrace(options.link, options.dataDir, sessionId, since);
      } catch {
        return null;
      }
    },
    facts,
    hookRunning: (pid) => hookChildRunning(pid, script),
    // The hook's rule (`scripts/hooks/work-area.mjs`): the text, then the path resolved one segment at a time.
    outsideWorkArea: (cwd) => !inWorkAreaOnDisk(cwd, options.roots, options.home),
    statusline: (sessionId) => statuslineFreshness(statuslineRoot, sessionId, Date.now()),
    proofRules: (sessionId) => options.proofGate.current(sessionId),
    restarting: () => Date.now() < options.startedAt + options.restartGraceMs,
    screenKey: (sessionId, key) => { options.link.cycle?.screenKey(sessionId, key); },
  };
}

/**
 * Wpisy rejestru sekretów, których proces hooka nie żyje według `ps` (pid i czas startu z rejestracji), idą do cyklu
 * sygnałem `dead`: karta klucza (jeśli jest) przechodzi jak przy martwym hooku, a wpis znika z rejestru. Dotyczy też
 * rejestracji bez karty (hook wyszedł, zanim driver zobaczył zrzut). Odpowiedź `ps` „nie wiem” zostawia wpis. Sygnał
 * idzie bez faktów sesji, więc karta `claimed` zostaje: o jej dialogu rozstrzyga obserwacja sesji z rejestrem CLI.
 */
export async function sweepDeadRegistrations(
  cycle: ConsentCycle, registry: ConsentRegistry, liveness: ProcessLiveness,
): Promise<void> {
  const entries = registry.entries();
  if (entries.length === 0) return;
  const now = Date.now();
  // Osobne pytanie per wpis: odpowiedź `ps` jest per pid, a stary wpis może mieć pid oddany nowemu hookowi.
  const verdicts = await Promise.all(entries.map((entry) => liveness([entry], now)
    .then((alive) => ({ alive: alive.get(entry.pid) ?? null, finding: alive.finding?.(entry.pid) }),
      () => ({ alive: null, finding: undefined }))));
  for (const [index, entry] of entries.entries()) {
    const verdict = verdicts[index];
    if (verdict?.alive !== false) continue;
    // The `ps` facts go to the log line of the forgotten registration only.
    const deadWhy = verdict.finding === undefined ? undefined : { ps: verdict.finding };
    await cycle.observe(entry.sessionId, entry.key, 'dead', undefined, undefined, undefined, undefined, deadWhy);
  }
}

/**
 * Plik wątku głównego sesji silnika dla przeglądu dowodów kanału zgód: znana ścieżka, gdy leży w magazynie CLI pod
 * nazwą tej sesji i dalej jest plikiem; inaczej szukanie po uuid w magazynie (`locateTranscript`). Ścieżkę
 * z checkpointu rekordu (plik w katalogu danych) sprawdza się tak samo: przegląd nie czyta pliku spoza magazynu.
 */
export async function consentTranscriptOf(sessionId: string, known: string | null): Promise<string | null> {
  const root = defaultStoreRoot();
  if (known !== null && dirname(dirname(known)) === root && basename(known) === `${sessionId}${TRANSCRIPT_EXT}`) {
    try {
      if ((await stat(known)).isFile()) return known;
    } catch {
      // Plik zniknął albo zmienił miejsce: szukanie po uuid niżej.
    }
  }
  return locateTranscript(root, '', sessionId);
}

/** Sufit przebiegów przeglądu jednej tury przy końcu tury bez wpisu w transkrypcie (przebieg = sufit bajtów). */
const CONSENT_TURN_END_MAX_PASSES = 64;

/**
 * Port `turnEnded` managera: koniec tury sesji silnika bez wpisu w transkrypcie (bezczynność po turze, wyjście
 * procesu, `/exit`). Dla każdej tury wątku głównego sesji z rekordami czekającymi na dowód fakty z transkryptu do
 * bieżącego końca pliku, potem `applyTurn(…, true)`: cykl rozlicza wyłącznie odpowiedzi odebrane, karty `pending`
 * i `sent` zostają. Tury subagentów (cel z `agentId`, 5.2) zostają: ich koniec daje koniec biegu agenta
 * w pliku głównym. Brak pliku = tura bez dowodów. Drugie wywołanie dla sesji, której koniec tury jest w toku, nic nie
 * robi. Nie rzuca.
 */
export function consentTurnEnd(
  cycle: Pick<ConsentCycle, 'evidenceTargets' | 'applyTurn'>,
  locate: (sessionId: string, known: string | null) => Promise<string | null>,
  log: (line: string) => void,
): (engineSessionId: string) => Promise<void> {
  const inFlight = new Set<string>();
  return async (engineSessionId) => {
    if (inFlight.has(engineSessionId)) return;
    inFlight.add(engineSessionId);
    try {
      const scanner = createConsentEvidenceScanner();
      for (const target of cycle.evidenceTargets()) {
        if (target.sessionId !== engineSessionId || target.agentId !== null) continue;
        let facts: ConsentTurnFacts = {
          promptId: target.promptId, ended: false, partial: true, toolUses: [], results: [],
        };
        try {
          const file = await locate(engineSessionId, target.checkpoint?.file ?? null);
          for (let n = 0; file !== null && n < CONSENT_TURN_END_MAX_PASSES; n += 1) {
            const pass = await scanner.pass({ ...target, file });
            if (pass.status !== 'ok') break;
            facts = pass.facts;
            if (pass.caughtUp) break;
          }
          await cycle.applyTurn(engineSessionId, target.promptId, facts, true);
        } catch (err: unknown) {
          log(`consent: turn end of session ${engineSessionId} failed: ${redact(err)}`);
        } finally {
          scanner.forget(engineSessionId, target.promptId);
        }
      }
    } finally {
      inFlight.delete(engineSessionId);
    }
  };
}

/** Przegląd plików odpowiedzi kanału zgód (`claimed`, `rejected`, termin odebrania). */
const CONSENT_TICK_MS = 1_000;
/** Co tyle ms wpisy rejestru sekretów hooka idą do `ps` ({@link sweepDeadRegistrations}). */
const CONSENT_REGISTRY_SWEEP_MS = 5_000;
/** Decyzja z urządzenia przy zamkniętym kanale (efektywny tryb inny niż `main` i `all`): karta wygasła (410). */
const CONSENT_OUTSIDE_MAIN = { ok: false, error: 'gone', state: null } as const;

export interface ConsentChannelDeps {
  /** Identifier of this process start (`bootId` of the registry and the cycle). */
  readonly serverStartId: string;
  readonly herdr: HerdrRuntime | null;
  readonly consentMode: ConsentModeSource;
  /** Gets the registry here; the cycle only after the record recovery ({@link startConsentCycle}). */
  readonly consentLink: ConsentLink;
  /** The manager, once it exists: `main()` creates it later, so every call goes through this getter. */
  readonly managerRef: () => ManagerApi | null;
  /** The CLI version gate: the cycle asks it for a session's rules at every check of a `channel` proof. */
  readonly consentProofGate: ConsentProofGate;
  readonly log: Logger;
}

export interface ConsentChannel {
  /** `null` = no channel: demo, or a configured mode that needs no registration (`off`, `shadow`). */
  readonly consentRegistry: ConsentRegistry | null;
  /** Exists exactly when the registry exists. */
  readonly consentCycle: ConsentCycle | null;
}

/** The registry and the cycle of the channel; nothing is read from disk and no timer starts here. */
export function createConsentChannel(config: RarogConfig, deps: ConsentChannelDeps): ConsentChannel {
  const { serverStartId, herdr, consentMode, consentLink, managerRef, consentProofGate, log } = deps;
  /*
   * Kanał zgód (warstwa 1): rejestr sekretów hooka w pamięci i gniazdo rejestracji `<dataDir>/run/consent.sock`
   * (niżej, po `listen`). Oba powstają wyłącznie w trybie kanału, który wymaga rejestracji
   * (`consentRegistrationWanted`); przy `off` i `shadow` gniazda nie ma, a hook bez gniazda nie czeka. Rejestr
   * startuje z zakresem `closed`: każda rejestracja dostaje 503, dopóki zakresu nie otworzy tryb efektywny.
   * Przyjęta rejestracja szturcha managera (świeży odczyt rejestru CLI tej sesji), więc karta kanału nie czeka na takt.
   * The restart grace G (`RAROG_CONSENT_RESTART_GRACE`) is the one `alive.json` announces: the registry and the cycle
   * exist only with the channel configured, where the writer in `index.ts` uses the same G.
   */
  const restartGraceMs = config.consentRestartGraceMs;
  const consentRegistry = config.demo || !consentRegistrationWanted(config.consentChannel)
    ? null
    : createConsentRegistry({
      bootId: serverStartId,
      send: () => config.herdrSend,
      sessions: () => herdr?.supervisor.observedEngineSessions?.() ?? [],
      log: (line) => { log.info(line); },
      onAccepted: (sessionId) => { managerRef()?.noteConsentRegistration?.(sessionId); },
      restartGraceMs,
    });
  consentLink.registry = consentRegistry;
  /*
   * Zmiana trybu efektywnego: najpierw zakres rejestru, potem `alive.json`. W górę (`off` → `main`) rejestr przyjmuje
   * rejestracje, zanim hook zobaczy tryb kanału; w dół (wyłącznik) odmawia, zanim hook zobaczy `off`.
   */
  /*
   * Cykl kanału zgód (`layer1/cycle.ts`, `docs/dialogs.md`, „Channel cycle”): jest wyłącznie przy rejestrze (konfiguracja
   * `main` albo `all`). Odzyskanie rekordów poprzedniego procesu PRZED pierwszą obserwacją, przegląd plików
   * odpowiedzi co sekundę. Zmiana karty idzie do managera (`applyConsentCard`), a decyzje z urządzeń do cyklu tylko przy otwartym
   * kanale (efektywne `main` albo `all`). Tryb efektywny czyta cykl przy każdej ocenie karty: `all` otwiera karty
   * subagentów i ich powrót do biurka.
   */
  const consentCycle = consentRegistry === null ? null : createConsentCycle({
    dataDir: config.dataDir,
    bootId: serverStartId,
    registry: consentRegistry,
    mode: () => consentMode.current().effective,
    always: config.consentAlways,
    // A change of a session's rule to `screen` takes away proofs taken under `channel` (version gate).
    proofRules: (sessionId) => consentProofGate.current(sessionId),
    log: (line) => { log.info(line); },
    onCard: (view) => {
      managerRef()?.applyConsentCard?.(view, consentCycle?.record(view.sessionId, view.permId)?.decision ?? null);
    },
    // Ekran karty z nieznanym elementem wierzchu idzie do `refusals/` (ten sam wyłącznik i retencja co odmowy).
    dumpUnknownTop: createRefusalDumper({
      dataDir: config.dataDir, version: config.version, enabled: config.refusalDumps,
    }),
    // Recovery: a record whose hook `ps` finds alive waits G for the hook's second registration (`resume.ts`).
    restartGraceMs,
    liveness: psLiveness(),
  });
  return { consentRegistry, consentCycle };
}

export interface ConsentCycleDeps {
  readonly consentCycle: ConsentCycle;
  readonly consentRegistry: ConsentRegistry;
  /** Gets the cycle after the recovery, before the first tick. */
  readonly consentLink: ConsentLink;
  readonly log: Logger;
}

/** Timers of the channel; `shutdown` in `main()` clears both. */
export interface ConsentTimers {
  readonly consentTick: ReturnType<typeof setInterval>;
  readonly consentSweep: ReturnType<typeof setInterval>;
}

/** Record recovery of the previous process, then the evidence review, the answer file tick and the registry sweep. */
export async function startConsentCycle(config: RarogConfig, deps: ConsentCycleDeps): Promise<ConsentTimers> {
  const { consentCycle, consentRegistry, consentLink, log } = deps;
  /*
   * Odzyskanie rekordów, a po UDANYM sprzątanie startu kanału (`layer1/records.ts`): pliki `consent/` po terminie
   * hooka i rekordy `consent-records/` ponad retencję. Rekord `sent` sprzed restartu ma najpierw zobaczyć swój plik
   * odpowiedzi; nieudane odzyskanie zostawia pliki następnemu startowi. Serwer bez cyklu (`off`, `shadow`) nie
   * sprząta: pliki `consent/` powstają tylko przy `main` i `all` i czekają na następny start z cyklem. Przed
   * pierwszym tikiem.
   */
  await recoverThenSweepConsent(() => consentCycle.recover(), config.dataDir, {
    info: (line) => { log.info(line); },
    failed: (err) => { log.error(`consent: record recovery failed: ${redact(err)}`); },
  });
  // Karta `running` sprzed restartu zostaje poza urządzeniami także po końcu tury bez skutku.
  await retireRunningAfterRecover(consentCycle, (line) => { log.info(line); });
  consentLink.cycle = consentCycle;
  /*
   * Przegląd dowodów w transkrypcie (`herdr/consent-evidence.ts`) na tym samym tiku co przegląd plików: checkpoint
   * rekordu pierwszym tikiem, fakty tury do `applyTurn` — także dla rekordów odzyskanych po restarcie. Pliki
   * subagentów tylko przy `RAROG_AGENT_FILES`.
   */
  const evidence = createConsentEvidenceReview({
    cycle: consentCycle,
    locate: consentTranscriptOf,
    agentFiles: config.agentFiles,
    log: (line) => { log.info(line); },
  });
  const consentTick = setInterval(() => {
    void consentStep('tick', (line) => { log.error(line); }, () => consentCycle.tick());
    void evidence.tick();
  }, CONSENT_TICK_MS);
  consentTick.unref();
  const registryProcesses = psLiveness();
  let sweeping = false;
  const consentSweep = setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    void consentStep('registry sweep', (line) => { log.error(line); }, () => (
      sweepDeadRegistrations(consentCycle, consentRegistry, registryProcesses)))
      .finally(() => { sweeping = false; });
  }, CONSENT_REGISTRY_SWEEP_MS);
  consentSweep.unref();
  return { consentTick, consentSweep };
}

export interface ConsentModeWatchDeps {
  readonly consentRegistry: ConsentRegistry | null;
  readonly consentCycle: ConsentCycle | null;
  readonly aliveWriter: AliveWriter | null;
  readonly log: Logger;
}

/** Subscribes the registry scope, the channel switch-off and `alive.json` to effective mode changes. */
export function watchConsentMode(consentMode: ConsentModeSource, deps: ConsentModeWatchDeps): void {
  const { consentRegistry, consentCycle, aliveWriter, log } = deps;
  /*
   * Zmiana trybu efektywnego: najpierw zakres rejestru, potem `alive.json`. W górę (`off` → `main` albo `all`) rejestr
   * przyjmuje rejestracje, zanim hook zobaczy tryb kanału; w dół (wyłącznik) odmawia, zanim hook zobaczy `off`, a cykl
   * odwołuje odpowiedzi nieodebrane (`pending` → `revoked`, `sent` → plik odwołany).
   */
  consentMode.onChange((state) => {
    consentRegistry?.setScope(consentRegistryScopeOf(state.effective));
    if (consentCycle !== null && !consentChannelOpen(state.effective)) {
      void consentStep('channel off', (line) => { log.error(line); }, () => consentCycle.off());
    }
    aliveWriter?.writeNow();
  });
}

/** Control of the channel from the admin socket, or `undefined` in the demo. */
export function consentAdminControl(
  config: RarogConfig, consentCycle: ConsentCycle | null, consentMode: ConsentModeControl,
): ConsentAdminControl | undefined {
  /*
   * Sterowanie kanałem z gniazda administracyjnego (`rarog dialogs`). Wyłącznik działa w każdym trybie poza demo.
   * Zwolnienie idzie przez cykl: karty sesji silnika `sessionId` (wszystkie albo jedna po `key`) w `pending` i `sent`;
   * wynik = klucze kart przyjętych do zwolnienia. Bez cyklu albo przy zamkniętym kanale (efektywny tryb inny niż `main`
   * i `all`) — odmowa `channel-closed`.
   */
  const consentAdmin: ConsentAdminControl | undefined = config.demo ? undefined : {
    release: async (request) => {
      if (consentCycle === null || !consentChannelOpen(consentMode.current().effective)) {
        return { refused: 'channel-closed' };
      }
      const targets = consentCycle.cards(request.sessionId)
        .filter((card) => (request.key === undefined || card.permId === request.key)
          && (card.state === 'pending' || card.state === 'sent'));
      const released: string[] = [];
      for (const card of targets) {
        const outcome = await consentCycle.release(request.sessionId, card.permId);
        if (outcome.ok) released.push(card.permId);
      }
      return released;
    },
    off: () => { consentMode.kill(); },
  };
  return consentAdmin;
}

/**
 * Starts the registration socket `<dataDir>/run/consent.sock` of the hook; with the cycle, a claim of an answer file
 * goes through its receipt check. `main()` calls it after `listen`, only with the registry.
 */
export function startConsentRegistration(
  config: RarogConfig, consentRegistry: ConsentRegistry, consentCycle: ConsentCycle | null, log: Logger,
): Promise<ConsentSocket | null> {
  return startConsentSocket(config.dataDir, createConsentHandler(consentRegistry, consentCycle === null ? undefined
    : createConsentClaims({
      registry: consentRegistry, log: (line) => { log.info(line); },
      confirm: (sessionId, key, at, inputSha256) => consentCycle.confirmReceipt(sessionId, key, at, inputSha256),
    })), (line) => { log.info(line); });
}

/**
 * Cards of one engine session for the manager port (`ConsentManagerChannel.cards`): the cycle's views with the
 * record's decision (`null` = no device answered) and the record's `retired` mark, which outlives a server restart.
 */
export function consentManagerCards(
  consentCycle: Pick<ConsentCycle, 'cards' | 'record'>, engineSessionId: string,
): ConsentManagerCard[] {
  return consentCycle.cards(engineSessionId).map((card) => {
    const record = consentCycle.record(engineSessionId, card.permId);
    if (record === null) return card;
    return { ...card, decision: record.decision, ...(record.retired === undefined ? {} : { retired: true as const }) };
  });
}

/**
 * Receiver of a forgotten conversation for the manager: the cycle drops the session's entries
 * (`ConsentCycle.forgetSession`). A failure leaves one log line instead of an unhandled rejection.
 */
export function consentForgottenPort(consentCycle: ConsentCycle, log: Logger): (engineSessionId: string) => void {
  return (engineSessionId: string) => {
    void consentStep('forget session', (line) => { log.error(line); }, () => consentCycle.forgetSession(engineSessionId));
  };
}

/** The consent port of the manager over the channel cycle. */
export function consentManagerPort(
  consentCycle: ConsentCycle, consentMode: ConsentModeSource, log: Logger,
): ConsentManagerChannel {
  return {
    cards: (engineSessionId: string) => consentManagerCards(consentCycle, engineSessionId),
    decide: (engineSessionId: string, permId: string, decision: 'allow' | 'allow-always' | 'deny') =>
      (consentChannelOpen(consentMode.current().effective)
        ? consentCycle.decide(engineSessionId, permId, decision)
        : Promise.resolve(CONSENT_OUTSIDE_MAIN)),
    release: (engineSessionId: string, permId: string) =>
      (consentChannelOpen(consentMode.current().effective)
        ? consentCycle.release(engineSessionId, permId)
        : Promise.resolve(CONSENT_OUTSIDE_MAIN)),
    // Koniec sesji (wyzwalacze managera) w każdym trybie: odwołanie nie pisze pliku odpowiedzi.
    revoke: (engineSessionId: string, cause: ConsentSessionRevokeCause) =>
      consentCycle.revokeSession(engineSessionId, cause),
    // Zdjęcie karty z urządzeń na końcu sesji, w każdym trybie: pole rekordu, bez pliku odpowiedzi.
    retire: async (engineSessionId: string, permId: string) => {
      await consentCycle.retire(engineSessionId, permId);
    },
    // Koniec tury bez wpisu w transkrypcie, w każdym trybie: rozlicza tylko odpowiedzi odebrane.
    turnEnded: consentTurnEnd(consentCycle, consentTranscriptOf, (line) => { log.info(line); }),
    // Powrót gniazda herdr, w każdym trybie: granica utraty dowodu w cyklu, bez pliku odpowiedzi.
    reattached: async (engineSessionIds: readonly string[]) => {
      await Promise.all(engineSessionIds.map((id) => consentCycle.markReattached(id)));
    },
    // Koniec rozmowy bez innego żywego panelu, w każdym trybie: pula sesji z pamięci, znaczniki prośby z dysku.
    ended: (engineSessionId: string) => {
      consentCycle.endPool(engineSessionId);
    },
  };
}
