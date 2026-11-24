/**
 * Terminal PTY — złożenie ficzeru.
 *
 * Jedno wejście dla `index.ts` i routera: backend trwałej powłoki, żniwiarz bezczynności
 * przy starcie, rejestr, transport WS i sprzątanie przy zamknięciu serwera.
 *
 * **Powłoka mieszka w PANELU herdr**: `RAROG_HERDR_LAUNCH=0` i `RAROG_HERDR_SEND=0` odmawiają
 * założenia terminala (`refusal()` w `herdr-backend.ts`, 409 z routera), a żniwa paneli
 * chodzą tylko wtedy, gdy wolno je w ogóle zakładać.
 *
 * WŁASNYM killswitchem terminala jest `RAROG_TERM` i tylko on gasi ficzer w całości.
 * Granice spisane w `docs/security-model.md` (sekcja terminala, punkty 1 i 10).
 */
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { TermRole } from '@rarog/shared';
import type { ServerSystem } from '@rarog/shared/rest';
import { redact } from '../auth/index.ts';
import type { DeviceStore, LoginLimiter } from '../auth/index.ts';
import { TERM_START_RETRY_MS, TERM_TOKEN_REFRESH_MS, validateProjectCwd } from '../config.ts';
import type { RarogConfig } from '../config.ts';
import type { HerdrLaunchClient } from '../herdr/types.ts';
import type { Logger } from '../router.ts';
import { DEMO_SERVER_SYSTEM } from '../demo/mac.ts';
import { DIRECT_DISK } from '../folder-gate/disk.ts';
import { serverSystem } from '../version.ts';
import type { TermBackend, TermBackendSession, TermReconcileResult } from './backend.ts';
import { createHerdrBackend } from './herdr-backend.ts';
import type { TermHerdrSpawn } from './herdr-backend.ts';
import { matchTermId, shouldReap } from './lifecycle.ts';
import { TermRegistry } from './registry.ts';
import type { TermHistoryResult, TermOpenResult, TermSlotRequest } from './registry.ts';
import { createTermUpgradeHandler } from './ws.ts';

export type { TermHistoryResult, TermOpenResult, TermSlotRequest } from './registry.ts';

/** Fraza linii taktu odzyskiwania o odświeżonych tokenach paneli (panel ops właściciela ma jej kopię w fixture). */
export const TERM_TOKENS_REFRESHED_LOG = 'term: tokens refreshed';

/** Fasada ficzeru widziana przez router i entry. */
export interface TermFeature {
  /** Zawsze `true` dla istniejącej instancji — brak ficzeru to `undefined`, nie `enabled:false`. */
  readonly enabled: true;
  /**
   * `POST /api/term` — rejestruje terminal `(katalog, slot)`, idempotentnie po realpath
   * i slocie. Brak slotu = 1 (zgodność wsteczna); `'next'` = najniższy wolny.
   */
  open(cwd: string, slot?: TermSlotRequest, role?: TermRole): TermOpenResult;
  /**
   * `GET /api/term` — lista terminali dla sidebaru: id, cwd, czy strumień żyje, numer taba,
   * nazwa procesu z cache'u backendu (`''` = jeszcze nieznana) i ROLA (panele popupowe —
   * `lazygit` i `popup` — mają `slot: 0`).
   */
  list(): { id: string; cwd: string; live: boolean; slot: number; proc: string; role: TermRole }[];
  /** `DELETE /api/term/:id` — zabicie TEJ jednej trwałej powłoki. */
  close(id: string): boolean;
  /**
   * `GET /api/term/:id/history?lines=N` — historia powłoki TEKSTEM, do zaznaczenia palcem.
   *
   * Obietnica, bo źródłem jest gniazdo herdr (`pane.read` na panelu z tokenem `rarog-term`).
   * Ani jeden znak zwróconej treści nie idzie do logu ani na dysk.
   */
  history(id: string, lines: number): Promise<TermHistoryResult>;
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  /** Zamyka otwarte terminale odpiętego urządzenia; zwraca liczbę gniazd. */
  closeOwner(owner: string): number;
  dispose(): void;
  /**
   * Żniwiarz + adopcja startowa. PRODUKCJA na to nie czeka (serwer ma przyjmować żądania od
   * pierwszej sekundy), ale testy muszą mieć czego się złapać — bez tego jedyną alternatywą
   * było odpytywanie `list()` w pętli. Nigdy się nie odrzuca: awarię notuje log.
   */
  readonly ready: Promise<void>;
}

/** Co backend dostaje od reszty serwera. */
export interface TermBackendDeps {
  readonly logger: Logger;
  /**
   * Fabryka klienta gniazda herdr — PRZEWÓD dla backendu panelowego.
   *
   * Fabryka, nie gotowy klient: terminal ładuje się leniwie i niezależnie od nadzorcy herdr,
   * więc w chwili składania ficzeru gniazdo może jeszcze nie stać (`null`).
   */
  readonly herdrLaunchClient?: () => HerdrLaunchClient | null;
  /** Spawn kontrolera herdr — wyłącznie testy (powód przy `TermHerdrChild`). */
  readonly herdrSpawn?: TermHerdrSpawn;
}

/**
 * Składa backend trwałej powłoki. Backend jest JEDEN (panel herdr) i wyboru nie ma —
 * funkcja zostaje jako miejsce, w którym zależności serwera zamieniają się w backend.
 *
 * Rzuca, gdy backendu nie da się złożyć: `loadTerm` w `server/src/bootstrap/term.ts` łapie to i gasi
 * ficzer z linią w logu. Terminal „włączony", który przy każdym upgrade zrywa gniazdo, byłby
 * gorszy niż wyłączony.
 */
export function createTermBackend(config: RarogConfig, deps: TermBackendDeps): TermBackend {
  const launchClient = deps.herdrLaunchClient;
  if (launchClient === undefined) {
    // Backend panelowy bez przewodu do gniazda nie umiałby nawet odnaleźć panelu —
    // ficzer ma zgasnąć z linią w logu, a nie zrywać każdy upgrade WS.
    throw new Error(
      'term: no herdr socket client — the shell lives in a herdr pane,'
      + ' so without the socket there is nothing to attach. Check the herdr integration.',
    );
  }
  return createHerdrBackend({
    config,
    logger: deps.logger,
    launchClient,
    system: termSystem(config),
    ...(deps.herdrSpawn === undefined ? {} : { spawn: deps.herdrSpawn }),
  });
}

/**
 * System maszyny dla słowa maszyny w zdaniach terminala („Mac” albo „VPS”): demo to zawsze fikcyjny Mac
 * (`DEMO_SERVER_SYSTEM`, jak `GET /api/version`), inaczej system, na którym serwer stoi.
 */
function termSystem(config: RarogConfig): ServerSystem {
  return config.demo ? DEMO_SERVER_SYSTEM : serverSystem();
}

/**
 * Żniwiarz bezczynności — TYLKO przy starcie serwera, nigdy w pętli.
 *
 * Rarog restartuje się często (po każdej zmianie w `server/`), więc sprzątanie raz na start
 * wystarcza i nie dokłada tykającego procesu. Powłoki Raroga bez podłączonego klienta
 * i bez aktywności od `RAROG_TERM_IDLE_DAYS` idą do `killSession` backendu — w herdr to
 * `pane.close` JEDNEGO panelu z tokenem `rarog-term`, nigdy nic szerszego.
 */
export async function reapIdleSessions(
  backend: TermBackend, config: RarogConfig, log: Logger, nowMs: number = Date.now(),
): Promise<number> {
  /*
   * Żniwa NIE chodzą, gdy backend odmawia zakładania powłok. Killswitch,
   * który blokuje otwieranie terminala, ale przepuszcza `pane.close` na bezczynnych panelach,
   * byłby niespodzianką w dokładnie tym miejscu, w którym człowiek szuka pewności: przy
   * `RAROG_HERDR_LAUNCH=0` Rarog ma nie ruszać paneli w herdr ani w jedną, ani w drugą stronę.
   */
  const refusal = backend.refusal();
  if (refusal !== null) {
    log.info(`term: reaper skipped — ${refusal.code}`);
    return 0;
  }
  let sessions: TermBackendSession[];
  try {
    sessions = await backend.listSessions();
  } catch {
    // Gniazdo herdr nie stoi albo nie zna paneli — normalny stan przy zgaszonym herdr,
    // nie awaria: nie ma czego żąć.
    return 0;
  }
  let reaped = 0;
  for (const session of sessions) {
    const shouldKill = shouldReap({
      // Powłoka, do której backend nie przyznaje żadnego identyfikatora Raroga, jest CUDZA
      // (panel człowieka w herdr) — nie tykamy jej nigdy.
      owned: session.id !== '',
      activityEpochSec: session.activityEpochSec,
      attached: session.attached,
    }, nowMs, config.termIdleDays);
    if (!shouldKill) continue;
    try {
      await backend.killSession(session.handle);
      reaped += 1;
      log.info(`term: reaper killed idle session ${session.handle.ref}`);
    } catch (err: unknown) {
      log.info(`term: reaper kill of ${session.handle.ref} failed (${redact(err)})`);
    }
  }
  return reaped;
}

/**
 * ADOPCJA powłok, które przeżyły restart Raroga (rejestr żyje w RAM).
 *
 * Bez niej powłoka po restarcie serwera istniała, ale Rarog o niej nie wiedział: sidebar
 * nie miał czego pokazać, a WS na jej id odbijał się od pustego rejestru, dopóki klient nie
 * zrobił POST z zapamiętanym cwd (pamięć po stronie PWA — za krucha jak na jedyne źródło).
 * Teraz źródłem prawdy jest sam backend: katalog powłoki + bramka KRYPTOGRAFICZNA (powłoka
 * musi przyznawać się do identyfikatora policzonego z jej własnej, rozwiązanej ścieżki)
 * + `validateProjectCwd` (korzenie projektów, reguła 5) → `registry.open`, czyli dokładnie
 * ta sama droga co POST.
 *
 * Wołana na starcie ORAZ w takcie odzyskiwania: wpis, który rejestr już zna, jest
 * pomijany — adopcja dopisuje wyłącznie NOWE (panel odzyskany z etykiety, panel, którego start
 * nie widział, bo herdr nie odpowiadał), i nigdy nie kasuje `failed` ani bezpiecznika istniejącego
 * wpisu. Zwraca liczbę adoptowanych.
 *
 * Returns `null` when herdr could not be read (`listSessions` threw: the socket is down), so the start
 * sequence can tell "herdr unreachable" from "herdr answered with nothing to adopt".
 */
async function adoptSurvivors(
  backend: TermBackend, config: RarogConfig, registry: TermRegistry, log: Logger,
): Promise<number | null> {
  let sessions: TermBackendSession[];
  try {
    sessions = await backend.listSessions();
  } catch {
    return null; // Gniazdo herdr nie odpowiada — nie ma czego adoptować.
  }
  let adopted = 0;
  for (const session of sessions) {
    if (session.cwd === '' || session.id === '') continue;
    if (registry.has(session.id)) continue;
    let real: string;
    try {
      real = DIRECT_DISK.sync('realpath', { path: session.cwd });
    } catch {
      continue; // Katalog zniknął — sesja zostaje dla żniwiarza, nie dla rejestru.
    }
    /*
     * DOWÓD własności ORAZ odczytanie SLOTU (albo roli popupowej) — jedno i to samo pytanie, bo
     * hash jest jednokierunkowy: identyfikator, do którego powłoka się przyznaje (token
     * `rarog-term` panelu herdr), musi być hashem JEJ WŁASNEJ, rozwiązanej ścieżki przy JAKIMŚ
     * numerze taba albo roli (`matchTermId`). Panel z podmienionym katalogiem i cudzy panel
     * z ręcznie dopisanym tokenem — jedno i drugie wypada.
     *
     * Próbowanie slotów 1…`TERM_SLOTS_MAX` jest WARUNKIEM POPRAWNOŚCI całych tabów, nie
     * optymalizacją: bez nich każdy tab o numerze ≥ 2 przeżywałby restart Raroga w herdr,
     * ale znikał z Raroga. Role popupowe (`lazygit`, `popup`) mają WŁASNE tożsamości poza
     * slotami — bez ich próby żywy popup znikałby z Raroga, a następny `POST` zakładałby DRUGI
     * panel obok chodzącego.
     */
    const identity = matchTermId(session.id, real);
    if (identity === null) continue;
    if (!validateProjectCwd(real, config.projectRoots).ok) continue;
    const role: TermRole = identity.role;
    const opened = registry.open(real, identity.slot === 0 ? 1 : identity.slot, role, { adopt: true });
    if (opened.ok) {
      adopted += 1;
      log.info(
        `term: adopted session ${session.handle.ref} (cwd=${real}, role ${role},`
        + ` slot ${String(opened.slot)})`,
      );
    }
  }
  return adopted;
}

/**
 * Jeden przebieg odzyskiwania paneli z linią w logu — nigdy się nie odrzuca.
 *
 * `backend.reconcile()` sam łapie swoje awarie; ta otoczka jest dla wołających, którzy idą dalej
 * (żniwa, adopcja) niezależnie od wyniku.
 */
async function reconcilePanes(backend: TermBackend, log: Logger): Promise<TermReconcileResult | null> {
  try {
    return await backend.reconcile();
  } catch (err: unknown) {
    log.info(`term: pane recovery failed (${redact(err)})`);
    return null;
  }
}

/**
 * TAKT odzyskiwania (co `TERM_TOKEN_REFRESH_MS`): `reconcile` ZAWSZE — także przy pustym
 * rejestrze, bo Rarog mógł wstać, gdy herdr nie odpowiadał, albo herdr zrestartował się od tamtej
 * pory — potem adopcja tego, czego rejestr jeszcze nie zna, i na końcu odświeżenie tokenów
 * wpisów. Takt woła backend także przy pustym rejestrze, bo inaczej sieroty po restarcie herdr
 * czekałyby na ręczny `POST`.
 */
async function termTick(
  backend: TermBackend, config: RarogConfig, registry: TermRegistry, log: Logger,
): Promise<void> {
  await reconcilePanes(backend, log);
  const adopted = await adoptSurvivors(backend, config, registry, log);
  if (adopted !== null && adopted > 0) log.info(`term: recovery tick adopted ${String(adopted)} terminal(s)`);
  try {
    const result = await registry.refreshTokens();
    if (result.refreshed + result.lost > 0) {
      log.info(
        `${TERM_TOKENS_REFRESHED_LOG} (${String(result.refreshed)} ok, ${String(result.lost)} without a token)`,
      );
    }
  } catch (err: unknown) {
    log.info(`term: token refresh failed (${redact(err)})`);
  }
}

/**
 * The start sequence: pane recovery → reaper → adoption. Recovery goes FIRST, because after a herdr
 * restart terminal panes stand without a token and neither the reaper nor adoption can see them without it.
 * Returns the adopted count, or `null` when herdr could not be read — also when only pane recovery failed
 * to read it: a later read for adoption may succeed, but panes still without a token stay invisible to it.
 */
async function startPass(
  backend: TermBackend, config: RarogConfig, registry: TermRegistry, log: Logger,
): Promise<number | null> {
  const recovery = await reconcilePanes(backend, log);
  await reapIdleSessions(backend, config, log, Date.now());
  const adopted = await adoptSurvivors(backend, config, registry, log);
  return recovery === null || !recovery.ran ? null : adopted;
}

/**
 * Retry of the start sequence while herdr is unreachable (every `TERM_START_RETRY_MS`).
 *
 * Without it a server that started before herdr saw no terminal until the 4 h recovery tick or a `POST`.
 * Each retry first probes herdr with a plain read and stays silent when it fails, so a long herdr outage
 * costs no log line per attempt; only a pass that reads herdr runs the full sequence and stops the timer.
 * The herdr supervisor's lifecycle events are not used: that queue has a single consumer, the session manager.
 */
function startRetry(
  backend: TermBackend, config: RarogConfig, registry: TermRegistry, log: Logger,
): { dispose(): void } {
  let disposed = false;
  let inFlight = false;
  const timer = setInterval(() => {
    if (disposed || inFlight) return;
    inFlight = true;
    void (async () => {
      try {
        await backend.listSessions();
      } catch {
        return; // herdr still down: try again on the next tick, without a log line.
      }
      if (disposed) return;
      const adopted = await startPass(backend, config, registry, log);
      if (adopted === null || disposed) return;
      stop();
      log.info(`term: herdr reachable, start recovery adopted ${String(adopted)} terminal(s)`);
    })().catch((err: unknown) => {
      log.info(`term: start recovery retry failed (${redact(err)})`);
    }).finally(() => { inFlight = false; });
  }, TERM_START_RETRY_MS);
  timer.unref();
  function stop(): void {
    disposed = true;
    clearInterval(timer);
  }
  return { dispose: stop };
}

/**
 * Składa ficzer albo mówi wprost, że go nie ma.
 *
 * `null` znaczy „ficzeru nie ma" i przychodzi z killswitcha `RAROG_TERM=0`. Odpowiednikiem
 * health checku binarki jest po stronie herdr odmowa backendu
 * (`refusal()`) i pad kontrolera przy pierwszym spawnie — oba mówią JAWNIE, co jest nie tak,
 * zamiast zrywać gniazdo bez słowa.
 */
export async function createTermFeature(
  config: RarogConfig, log: Logger,
  opts: {
    /** Przewód do gniazda herdr dla backendu panelowego — powód przy `TermBackendDeps`. */
    herdrLaunchClient?: () => HerdrLaunchClient | null;
    /** Spawn kontrolera herdr — wyłącznie testy. */
    herdrSpawn?: TermHerdrSpawn;
    /** Magazyn kluczy urządzeń i wspólny dławik — ta sama bramka co w routerze. */
    devices?: DeviceStore;
    limiter?: LoginLimiter;
  } = {},
): Promise<TermFeature | null> {
  if (!config.termEnabled) return null;
  const backend = createTermBackend(config, {
    logger: log,
    herdrLaunchClient: opts.herdrLaunchClient,
    herdrSpawn: opts.herdrSpawn,
  });
  const registry = new TermRegistry({ config, logger: log, backend, system: termSystem(config) });
  const upgrade = createTermUpgradeHandler({
    config, registry, logger: log,
    ...(opts.devices === undefined ? {} : { devices: opts.devices }),
    ...(opts.limiter === undefined ? {} : { limiter: opts.limiter }),
  });
  /*
   * Start: odzyskiwanie paneli → żniwa → adopcja. Odzyskiwanie PIERWSZE, bo po restarcie
   * herdr panele terminala stoją bez tokenu i bez niego ani żniwiarz, ani adopcja ich nie widzą.
   *
   * herdr unreachable at start: retry the whole sequence (`startRetry`). Not when the backend refuses for
   * a configured reason (`refusal()`): that is not "herdr down", and a loop would only repeat the refusal.
   * `ready` still resolves after the first attempt; it never waits for herdr.
   */
  let disposed = false;
  let retry: { dispose(): void } | null = null;
  const ready = startPass(backend, config, registry, log)
    .then((adopted) => {
      if (adopted !== null || disposed || backend.refusal() !== null) return;
      retry = startRetry(backend, config, registry, log);
      log.info(
        `term: herdr unreachable at start, retrying recovery every ${String(TERM_START_RETRY_MS / 1000)} s`,
      );
    })
    .catch((err: unknown) => {
      log.info(`term: reaper failed to start (${redact(err)})`);
    });
  /*
   * Takt W PĘTLI — jedyny tykający proces terminala i wyjątek od zasady „sprzątanie raz na
   * start" (powód przy `TERM_TOKEN_REFRESH_MS`, kroki przy `termTick`). `unref()`, żeby timer
   * nie trzymał procesu przy zamykaniu serwera; `dispose()` go kasuje.
   */
  const refresh = setInterval(() => {
    void termTick(backend, config, registry, log).catch((err: unknown) => {
      log.info(`term: recovery tick failed (${redact(err)})`);
    });
  }, TERM_TOKEN_REFRESH_MS);
  refresh.unref();
  log.info(
    `term: enabled (herdr pane, ${config.herdrBin},`
    + ` cap ${String(config.termMax)}, reaping after ${String(config.termIdleDays)} days)`,
  );
  return {
    enabled: true,
    ready,
    open: (cwd, slot, role) => registry.open(cwd, slot, role),
    list: () => registry.list(),
    close: (id) => registry.close(id),
    history: async (id, lines) => await registry.history(id, lines),
    handleUpgrade: (req, socket, head) => { upgrade.handleUpgrade(req, socket, head); },
    closeOwner: (owner) => upgrade.closeOwner(owner),
    dispose: () => {
      disposed = true;
      retry?.dispose();
      clearInterval(refresh);
      upgrade.close();
      registry.dispose();
      // Przebieg odzyskiwania w locie przestaje mutować, a zakładanie odmawia.
      backend.dispose();
    },
  };
}
