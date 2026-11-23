/**
 * „Z katalogu zrób żywego agenta" — cała procedura zakładania panelu.
 *
 * Jedyne miejsce w Rarogu, które zakłada panel z AGENTEM (`agent.start`); terminal zakłada
 * swoje panele osobno (`term/herdr-backend.ts`). Manager woła `supervisor.launch()` i dostaje
 * `key` — nie wie, że po drodze powstał workspace albo tab.
 *
 * **Kolejność kroków jest kontraktem**, bo każdy z nich ma inną cenę porażki:
 *
 * 1. argv (czysta walidacja — złe żądanie nie tworzy NICZEGO, nawet taba),
 * 2. zaufanie katalogu (nic jeszcze nie powstało),
 * 3. workspace projektu: `workspace.list` + `pane.list` → resolver
 *    (`herdr/workspace-resolver.ts`), pod zamkiem projektu wspólnym z terminalem,
 * 4. pod tym samym zamkiem `tab.create` albo `workspace.create` (zawsze z `env`; nowy
 *    workspace nosi nazwę katalogu, nie tytuł sesji) — po `workspace.create` w części w tle
 *    `tab.rename`, bo herdr nadaje pierwszemu tabowi etykietę „1",
 * 5. rejestracja panelu w supervisorze → `key` → **tu oddajemy uchwyt**, żeby router mógł
 *    odpowiedzieć 202 z prawdziwym `sessionId` (`agent.start` kończy się w 1,4 ms, ale
 *    `interactive_ready` przychodzi po ~5 s, a blokujący POST ginie przy zgaszeniu ekranu iOS),
 * 6. `agent.start`, etykieta pochodzenia panelu (`pane.rename`) i sygnał „etykieta gotowa"
 *    dla nadzorcy (`paneLabelled` — od niego rusza synchronizacja etykiety taba z kartą), tytuł
 *    (`pane.report_metadata`), poll `agent.get` — w TLE, rozstrzygają `ready`.
 *
 * Launcher nie emituje żadnych zdarzeń cyklu życia i nie zna managera.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { foreign, say } from '@rarog/shared/sentences';
import {
  DEFAULT_CLAUDE_ENV_CLEAR, HERDR_LAUNCH_POLL_MS, HERDR_LAUNCH_READY_TIMEOUT_MS,
  HERDR_LAUNCH_SHELL_WAIT_MS, PANE_SHELL_ENV,
} from '../config.ts';
import { assertAllowedArgs, buildClaudeArgs } from './argv.ts';
import { decideProjectWorkspace, sharedProjectPlacement } from './project-workspace.ts';
import type { ProjectPlacement } from './project-workspace.ts';
import {
  claudePaneLabel, labelTrace, newRarogAgentName, projectKey, realProjectPath, sanitizePaneTitle,
} from './provenance.ts';
import { snippet } from './dialogs/screen/snippet.ts';
import type { TrustCheck } from './trust.ts';
// `HerdrUntrustedCwdError` NIE jest tu importowany: brak zaufania katalogu jest
// ostrzeżeniem (`trustPrompt`), a nie odmową startu. Klasa zostaje w `types.ts` razem
// z tłumaczeniem na kod `herdr-untrusted` w routerze — patrz jej docstring.
import { HerdrUnavailableError } from './socket.ts';
import { HerdrError, HerdrGoneError, HerdrLaunchTimeoutError } from './types.ts';
import type {
  HerdrAgentStatus, HerdrLaunchClient, HerdrLaunchHandle, HerdrLaunchRegistration,
  HerdrLaunchRequest, HerdrLaunchResult, HerdrLauncher,
} from './types.ts';

// ---------------------------------------------------------------------------
// Stałe (w kodzie, bo to nie jest konfiguracja bezpieczeństwa)
// ---------------------------------------------------------------------------

/*
 * Te liczby mieszkają w `config.ts` — jednym miejscu dla całej integracji. Tutaj są
 * REEKSPORTOWANE, żeby wołający launchera nie musiał wiedzieć, gdzie stoją: „ile czekamy na
 * gotowość" jest pytaniem o launcher, nie o konfigurację.
 */
export {
  HERDR_LAUNCH_POLL_MS, HERDR_LAUNCH_READY_TIMEOUT_MS, HERDR_LAUNCH_SHELL_WAIT_MS,
} from '../config.ts';
/*
 * Nazwa agenta mieszka w `provenance.ts` RAZEM ze wzorcem, którym czyta ją filtr wejściowy
 * (`RAROG_AGENT_NAME_RE`) — generator i czytelnik mają jedno źródło, a fasada gniazda
 * nie musi importować launchera. Reeksport zostaje, bo „jak Rarog nazywa agenta" jest
 * pytaniem o launcher.
 */
export { RAROG_AGENT_NAME_RE, newRarogAgentName } from './provenance.ts';
/*
 * Czyszczenie tytułu mieszka w `provenance.ts` — tej samej reguły potrzebuje etykieta taba
 * synchronizowana z kartą (`sanitizeTabLabel`). Reeksport, bo „jaki tytuł dostaje panel" jest
 * pytaniem o launcher.
 */
export { PANE_TITLE_MAX_CHARS, sanitizePaneTitle } from './provenance.ts';
/** `source` w `pane.report_metadata` — widoczne w `pane.get`, mówi CZYJ to tytuł. */
export const RAROG_METADATA_SOURCE = 'rarog';
/** `agent_name_taken` przy kolizji `rarog-<6 hex>` to ~1/16M; trzy podejścia to nadmiar. */
export const LAUNCH_NAME_ATTEMPTS = 3;

/**
 * Zmienne zerowane w `env` nowego panelu (domyślnik dla `RAROG_CLAUDE_ENV_CLEAR`).
 *
 * Serwer herdr dziedziczy środowisko po tym, kto go uruchomił, a panel dziedziczy je po
 * serwerze. Jeśli serwer wystartował Z WNĘTRZA sesji Claude Code, cała rodzina `CLAUDE_CODE_*`
 * jedzie dalej — i robi z nowego panelu SESJĘ POTOMNĄ tamtej sesji. Zerujemy więc dwie różne
 * klasy zmiennych:
 *
 * 1. **Transkrypt.** Przy odziedziczonym `CLAUDE_CODE_CHILD_SESSION` `claude` pokazuje
 *    „Transcript saving is off” i plik jsonl nie powstaje (docs `errors.md`, „Transcript saving is
 *    off because of an inherited CLAUDE_CODE_CHILD_SESSION marker”), czyli cała
 *    warstwa treści Raroga znika po cichu. `CLAUDECODE` docs (`env-vars.md`) opisują jako znacznik
 *    podprocesu, a `CLAUDE_CODE_ENTRYPOINT` w docs nie występuje; oba zerujemy z ostrożności.
 * 2. **Zgody.** `CLAUDE_CODE_MESSAGING_SOCKET` i `CLAUDE_CODE_MESSAGING_TOKEN` to według docs
 *    gniazdo i token skrzynki wiadomości, które każda sesja eksportuje sama (`env-vars.md`;
 *    `cross-session-messaging.md`, „The session’s inbox socket”). Panel Raroga
 *    nie ma nieść cudzych: zgoda w terminalu jest jedyną bramką Raroga
 *    (`docs/security-model.md`, „Starting sessions from the phone: three powers”),
 *    więc obie zmienne zerujemy z ostrożności.
 *
 * `CLAUDE_CODE_OAUTH_TOKEN` też jest zerowany: panel loguje się poświadczeniami
 * z `/login` (na macOS Keychain), a token w env
 * nadpisałby je tokenem z pliku sekretów powłoki i sesje z Raroga biłyby w API zamiast
 * w subskrypcję. Szczegóły przy `DEFAULT_CLAUDE_ENV_CLEAR` w `config.ts`.
 */
export { DEFAULT_CLAUDE_ENV_CLEAR } from '../config.ts';

/** Kształt nazwy zmiennej środowiskowej — lista bywa z konfiguracji, więc jest sprawdzana. */
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** Ile znaków ekranu wolno dołączyć do komunikatu „agent nie wystartował". */
const GONE_REASON_MAX_CHARS = 200;

/** Fraza linii logu o agencie, który zniknął zaraz po starcie (karta w kliencie ma osobne zdanie). */
export const AGENT_GONE_AT_START_LOG = 'herdr launcher: agent disappeared right after start';

/** Jak powstaje sesja — do linii porażki startu (zgadza się z wyborem `sessionId` w `launch`). */
type StartKind = 'new' | 'resume' | 'fork';

/** Znaki sterujące z odpowiedzi herdr nie mają prawa złamać JEDNEJ linii logu. */
function oneLine(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]/g, '?');
}

/** `interactive_ready` / `launch_pending` w linii logu; brak pola w odpowiedzi to `absent`. */
function flagText(value: boolean | null | undefined): string {
  return value === null || value === undefined ? 'absent' : String(value);
}

// ---------------------------------------------------------------------------
// Styki wstrzykiwane
// ---------------------------------------------------------------------------

/**
 * Odczyt gotowości agenta w trakcie startu.
 *
 * Osobny, wąski typ zamiast `HerdrClient.getAgent`, bo `HerdrAgentInfo` NIE
 * niesie `interactive_ready` — a to jedyne pole, które odróżnia „panel istnieje" od „można
 * wysłać prompt" (`agent.prompt` przed gotowością zwraca `agent_not_ready`, tekst NIE trafia
 * do pola). Gdy `normalizeAgentInfo` dostanie to pole, podpięcie tutaj to
 * jedna funkcja adaptująca.
 */
export interface HerdrLaunchProbe {
  /** `agent_session.value`; pusty string, gdy herdr jeszcze nie zna sesji (~2 s od startu). */
  agentSessionId: string;
  status: HerdrAgentStatus;
  /** `interactive_ready` z odpowiedzi; `null` = pola NIE MA (patrz `waitReady`, gałąź 0.9.0). */
  interactiveReady: boolean | null;
  /**
   * `launch_pending` (herdr ≥ 0.9.0): `true` od `agent.start` do gotowości, potem pole znika.
   * Nieobecne (starszy herdr, testy) = `false`.
   */
  launchPending?: boolean;
}

/** Dane, którymi supervisor rezerwuje panel „w trakcie zakładania" i nadaje `key`. */
export type { HerdrLaunchRegistration } from './types.ts';

export interface HerdrLauncherDeps {
  client: HerdrLaunchClient;
  trust: TrustCheck;
  /**
   * `agent.get` zawężony do trzech pól; rzuca `HerdrGoneError`, gdy agenta nie ma.
   * Nieobecny = `client.probeAgent` — wstrzyknięcie jest dla testów, nie dla produkcji.
   */
  probeAgent?(paneId: string): Promise<HerdrLaunchProbe>;
  /**
   * Rezerwacja panelu w supervisorze → `key`.
   *
   * Musi być SYNCHRONICZNA i musi nastąpić przed `agent.start`: dopóki rezerwacja żyje,
   * resync i push nie emitują `appeared` dla tego panelu, więc nie powstaje druga sesja
   * Raroga na tym samym panelu.
   */
  registerLaunch(reg: HerdrLaunchRegistration): string;
  /**
   * Krok etykiety pochodzenia (`pane.rename`, krok 6) się ZAKOŃCZYŁ — sukcesem albo błędem.
   *
   * Nadzorca wstrzymuje do tej chwili synchronizację etykiety taba z kartą (`syncTabLabel`):
   * sync przed etykietą panelu nie miałby dowodu pochodzenia, a migracja starych etykiet tabów
   * nadałaby panelowi etykietę równolegle z launcherem. Nieobecne = nikt nie czeka (testy).
   */
  paneLabelled?(key: string): void;
  /** Powód, dla którego `claude` zniknął (np. `--resume <nieistniejący uuid>`). */
  readScreen?(paneId: string): Promise<string>;
  /** `RAROG_CLAUDE_ENV_CLEAR`; pusta lista jest błędem konfiguracji, nie „brakiem opcji". */
  envClear?: readonly string[];
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Odroczenie części „w tle" (kroki 6–8) na następny obrót pętli zdarzeń.
   *
   * Domyślnie `setTimeout(fn, 0)`, a NIE mikrozadanie: mikrozadanie wykonałoby się przed
   * wznowieniem tego, kto czeka na `launch()`, więc `agent.start` poleciałby ZANIM manager
   * dostanie uchwyt i zdąży podpiąć driver. Koszt to jeden obrót pętli, zysk to gwarancja
   * kolejności „najpierw 202 i driver, potem proces".
   */
  defer?: (fn: () => void) => void;
  /**
   * Zamek projektu i pamięć założonych workspace'ów. Domyślnie JEDEN na proces
   * (`sharedProjectPlacement`) — ten sam, którego używa backend terminala; testy podają własny.
   */
  placement?: ProjectPlacement;
  /** UUID sesji — losuje RAROG, nie herdr. */
  newSessionId?: () => string;
  newAgentName?: () => string;
  logger?: (message: string) => void;
  readyTimeoutMs?: number;
  pollMs?: number;
}

// ---------------------------------------------------------------------------
// Pomocnicze funkcje czyste
// ---------------------------------------------------------------------------

/**
 * Czy błąd `agent.start` znaczy „nazwa zajęta".
 *
 * `client.ts` mapuje dziś `agent_name_taken` gałęzią domyślną (`herdr: <komunikat>`), więc kod
 * zdalny przeżywa wyłącznie w treści. Sprawdzamy oba warianty: pole `remoteCode` (gdyby klient
 * kiedyś je przepuścił) i tekst. Pomyłka w tę stronę kosztuje jedną dodatkową próbę z nową
 * nazwą — pomyłka w drugą zostawiłaby użytkownika z błędem, który sam znika.
 */
export function isNameTakenError(err: unknown): boolean {
  return hasRemoteCode(err, 'agent_name_taken');
}

/**
 * `agent_pane_busy` — „pane is not an available shell".
 *
 * Dla panelu, który launcher sam przed chwilą stworzył, znaczy to „powłoka jeszcze nie
 * narysowała promptu", a nie „ktoś tu pracuje" (zmierzone: zsh z motywem potrzebuje na to
 * kilkuset ms). Dlatego jest to błąd PRZEJŚCIOWY — ale wyłącznie w tym jednym kontekście.
 */
export function isPaneBusyError(err: unknown): boolean {
  return hasRemoteCode(err, 'agent_pane_busy');
}

/**
 * Czy wynik `agent.start` jest NIEZNANY (a nie „herdr powiedział nie").
 *
 * Rozstrzyga o władzy nad cudzym procesem — patrz komentarz w `finish()`. Sprawdzamy klasę
 * ORAZ `code`: `HerdrUnavailableError` mieszka w `socket.ts`, a `instanceof` przez granicę
 * modułu bywa zawodne (podwójne załadowanie, mock w teście); kod błędu jest kontraktem
 * niezależnym od tożsamości klasy.
 */
export function isUncertainStartOutcome(err: unknown): boolean {
  if (err instanceof HerdrUnavailableError) return true;
  if (typeof err !== 'object' || err === null) return false;
  return (err as { code?: unknown }).code === 'herdr-unavailable';
}

/** Kod zdalny herdr — z pola `remoteCode`, a gdy przepadło, z treści komunikatu. */
function hasRemoteCode(err: unknown, code: string): boolean {
  if (typeof err !== 'object' || err === null) return false;
  if ((err as { remoteCode?: unknown }).remoteCode === code) return true;
  const message = (err as { message?: unknown }).message;
  return typeof message === 'string' && new RegExp(code, 'i').test(message);
}

/**
 * Środowisko nowego panelu: zerowane zmienne Claude Code plus to, co powłoka panelu ma
 * dostać USTAWIONE ({@link PANE_SHELL_ENV}). Ustawienia idą PO zerowaniu — gdyby ktoś wpisał
 * tę samą nazwę do `RAROG_CLAUDE_ENV_CLEAR`, wygrywa wartość, bo bez niej `agent.start` nie
 * ma gwarancji, że pisze do powłoki, a nie do pytania nad nią.
 */
function buildEnv(names: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of names) env[name] = '';
  return { ...env, ...PANE_SHELL_ENV };
}

// ---------------------------------------------------------------------------
// Launcher
// ---------------------------------------------------------------------------

export function createHerdrLauncher(deps: HerdrLauncherDeps): HerdrLauncher {
  const { client, trust } = deps;
  const now = deps.now ?? ((): number => Date.now());
  const sleep = deps.sleep ?? (async (ms: number): Promise<void> => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  });
  const defer = deps.defer ?? ((fn: () => void): void => {
    setTimeout(fn, 0);
  });
  const newSessionId = deps.newSessionId ?? ((): string => randomUUID());
  const newAgentName = deps.newAgentName ?? newRarogAgentName;
  const probeAgent = deps.probeAgent ?? ((paneId: string): Promise<HerdrLaunchProbe> => (
    client.probeAgent(paneId)
  ));
  const log = deps.logger ?? ((): void => {});
  const placement = deps.placement ?? sharedProjectPlacement;
  const readyTimeoutMs = deps.readyTimeoutMs ?? HERDR_LAUNCH_READY_TIMEOUT_MS;
  const pollMs = deps.pollMs ?? HERDR_LAUNCH_POLL_MS;

  const envNames = deps.envClear ?? DEFAULT_CLAUDE_ENV_CLEAR;
  // Fail-fast przy składaniu zależności, nie przy pierwszym żądaniu: pusta albo popsuta lista
  // znaczy, że transkrypt nie powstanie, a warstwa treści zniknie po cichu.
  if (envNames.length === 0) {
    throw new Error('herdr launcher: lista `RAROG_CLAUDE_ENV_CLEAR` nie może być pusta.');
  }
  for (const name of envNames) {
    if (!ENV_NAME_PATTERN.test(name)) {
      throw new Error(`herdr launcher: „${name}" nie jest nazwą zmiennej środowiskowej.`);
    }
  }
  const env = buildEnv(envNames);

  /** Ogon ekranu panelu — krótki, przycięty, bez ANSI; pusty, gdy nie ma jak albo czego czytać. */
  const screenTail = async (paneId: string): Promise<string> => {
    if (deps.readScreen === undefined) return '';
    try {
      const cut = snippet(await deps.readScreen(paneId));
      if (cut === null) return '';
      const text = cut.text.trim();
      return text.length > GONE_REASON_MAX_CHARS
        ? text.slice(text.length - GONE_REASON_MAX_CHARS)
        : text;
    } catch {
      // Ekran to miła dodatkowa informacja, a nie warunek poprawności — brak jej nie zmienia
      // faktu, że agent zniknął albo nie wstał na czas.
      return '';
    }
  };

  /**
   * JEDNA linia `server.log` o porażce czekania na gotowość (rozjazd id sesji albo timeout).
   *
   * Zdanie dla apki mówi „co", a ta linia — co herdr wtedy zgłosił: ostatni odczyt `agent.get`
   * i procesy pierwszego planu panelu. Bez niej „błąd tworzenia sesji" właściciela
   * nie miał w logu żadnego śladu. Procesy idą przez fasadę `readPaneProcess`, więc do logu
   * trafia tylko `pid`, `name` i `argv0` — `argv`, `cmdline` i `cwd` fasada odcina, bo linia
   * poleceń bywa sekretem. Panel jest WŁASNY: launcher sam go przed chwilą założył. Odczyt
   * procesów to dodatek: jego błąd daje `foreground: unknown`, a linia i tak powstaje.
   */
  const logStartFailure = async (
    paneId: string, reason: string, probe: HerdrLaunchProbe, expected: string, start: StartKind,
  ): Promise<void> => {
    let foreground: string;
    try {
      const { processes } = await client.readPaneProcess(paneId);
      foreground = processes.length === 0
        ? 'none'
        : processes.map((p) => `${p.pid} ${oneLine(p.name)} ${p.argv0 === '' ? '-' : oneLine(p.argv0)}`)
          .join(', ');
    } catch {
      foreground = 'unknown';
    }
    const reported = probe.agentSessionId === '' ? 'none' : oneLine(probe.agentSessionId);
    log(`herdr launcher: start failed on ${paneId}: ${reason}; expected session ${expected}, `
      + `herdr reported ${reported}; status ${oneLine(probe.status)}, `
      + `interactive_ready ${flagText(probe.interactiveReady)}, launch_pending ${flagText(probe.launchPending)}, `
      + `start ${start}; foreground: ${foreground}`);
  };

  /**
   * `agent.start` z retry na DWIE sytuacje przejściowe — i tylko na nie.
   *
   * 1. `agent_name_taken` — kolizja `rarog-<6 hex>`; ponawiamy z NOWĄ nazwą.
   * 2. `agent_pane_busy` — „pane is not an available shell". Wbrew nazwie to najczęściej NIE
   *    jest zajęty panel, tylko powłoka, która nie zdążyła narysować promptu: `herdr agent
   *    start` wymaga panelu „at an interactive shell prompt", a zsh z motywem potrzebuje na
   *    to kilkuset milisekund po `tab.create`. Zmierzone na żywo: ten sam kod raz przechodzi
   *    natychmiast, raz wywala start (`nie udało się założyć panelu`) i zostawia po sobie
   *    pusty panel — czyli dokładnie to, czego zakazuje reguła 11.9.
   *
   * Ponawianie `agent_pane_busy` jest bezpieczne WYŁĄCZNIE dlatego, że launcher adresuje
   * panel, który sam przed chwilą stworzył: nie ma tam żadnego cudzego procesu, któremu
   * moglibyśmy wejść w drogę.
   */
  const startAgent = async (
    paneId: string, args: readonly string[],
  ): Promise<readonly string[]> => {
    let lastErr: unknown = null;
    const used: string[] = [];
    const shellDeadline = now() + HERDR_LAUNCH_SHELL_WAIT_MS;
    let name: string | null = null;
    let nameAttempts = 0;
    while (nameAttempts < LAUNCH_NAME_ATTEMPTS) {
      if (name === null) {
        // Nowa nazwa MUSI być inna niż poprzednie — inaczej „retry" jest powtórzeniem błędu.
        name = newAgentName();
        let guard = 0;
        while (used.includes(name) && guard < 8) {
          name = newRarogAgentName();
          guard += 1;
        }
        used.push(name);
        nameAttempts += 1;
      }
      try {
        const result = await client.startAgent({ name, kind: 'claude', paneId, args });
        return result.argv;
      } catch (err) {
        lastErr = err;
        if (isPaneBusyError(err) && now() < shellDeadline) {
          // TA SAMA nazwa, tylko później: nie była gotowa powłoka, a nie nazwa zajęta.
          // Zużywanie na to budżetu trzech prób odebrałoby go prawdziwej kolizji.
          await sleep(pollMs);
          continue;
        }
        if (!isNameTakenError(err)) throw err;
        name = null;
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new HerdrError(say('herdr.agent-name-failed'));
  };

  /**
   * Poll `agent.get` do gotowości; kroki 7–8 procedury.
   *
   * Oddaje TO, CO ZOBACZYŁ na końcu czekania — `blocked` panelu stojącego na dialogu jest
   * wynikiem tak samo poprawnym jak `idle` panelu gotowego, a dla dialogu zaufania jest
   * jedynym źródłem statusu, jakie Rarog w ogóle dostanie (patrz `HerdrLaunchResult.status`).
   */
  const waitReady = async (
    paneId: string,
    sessionId: string,
    start: StartKind,
  ): Promise<{ status: HerdrAgentStatus; interactiveReady: boolean }> => {
    const deadline = now() + readyTimeoutMs;
    /** Rozjazd `--session-id` znaczy, że ścieżka jsonl byłaby zgadywaniem — to porażka startu. */
    const assertSameSession = async (probe: HerdrLaunchProbe): Promise<void> => {
      if (probe.agentSessionId === sessionId) return;
      await logStartFailure(paneId, 'session id mismatch', probe, sessionId, start);
      throw new HerdrLaunchTimeoutError(say('herdr.session-id-mismatch'));
    };
    for (;;) {
      let probe: HerdrLaunchProbe;
      try {
        probe = await probeAgent(paneId);
      } catch (err) {
        if (err instanceof HerdrGoneError) {
          const reason = await screenTail(paneId);
          /*
           * Ślad w logu serwera, bo karta w kliencie to jedyne inne miejsce, w którym ta porażka
           * w ogóle istnieje — a ona znika razem z sesją. Bez tej linii diagnoza
           * (np. prompt aktualizacji oh-my-zsh zjada pierwszą literę `claude`) wymaga czytania
           * dziennika herdr i ekranu osieroconego panelu. Ekranu tu zwykle NIE MA: `agent.read`
           * wymaga agenta, a agenta właśnie nie ma — stąd wskazówka, gdzie patrzeć.
           */
          log(`${AGENT_GONE_AT_START_LOG} on ${paneId}`
            + (reason === '' ? ' — inspect the screen in herdr (the pane stays).' : ` — screen: ${reason}`));
          throw new HerdrGoneError(
            reason === ''
              ? say('herdr.agent-vanished')
              : say('herdr.agent-vanished.screen', { screen: foreign(reason) }),
          );
        }
        throw err;
      }

      // herdr can report readiness a moment before it reports the session id (herdr 0.9.5), so an
      // empty `agent_session` here means "not yet": keep polling until the deadline below.
      if (probe.interactiveReady === true && probe.agentSessionId !== '') {
        await assertSameSession(probe);
        return { status: probe.status, interactiveReady: true };
      }
      /*
       * Rekord startu WYGASŁ, agent żyje (herdr 0.9.0, zmierzone).
       *
       * Od 0.9.0 `agent.start` odpowiada od razu, a `timeout_ms` ogranicza życie REKORDU
       * startu po stronie herdr: dopóki trwa, `agent.get` niesie `launch_pending: true`,
       * a przy gotowości — `interactive_ready: true`. Gdy `claude` nie zdąży w tym oknie
       * (zimny start: proces pojawił się po 9 s), herdr porzuca rekord i wykrywa agenta SAM:
       * bez `name`, bez `launch_pending` i bez `interactive_ready` — JUŻ NIGDY. Taki panel
       * przyjmuje `agent.prompt` jak każdy założony ręcznie (te też nie mają pola), więc czekanie
       * na flagę kończyłoby się po 60 s kartą „nie zgłosił gotowości" przy ŻYWYM panelu.
       * Gotowość rozstrzyga wtedy status z ekranu (`idle` = widoczny prompt `❯`; `working` =
       * zdążył już dostać pracę) plus zgodność sesji — `unknown` i pusty `agent_session`
       * dalej znaczą „czekaj". Okno startu jest równe oknu czekania
       * (`HERDR_START_WAIT_MS`), więc ta gałąź to siatka, nie ścieżka główna.
       */
      const adoptedWithoutLaunch = probe.interactiveReady === null
        && probe.launchPending !== true
        && (probe.status === 'idle' || probe.status === 'working')
        && probe.agentSessionId !== '';
      if (adoptedWithoutLaunch) {
        await assertSameSession(probe);
        log(`herdr launcher: pane ${paneId} without \`interactive_ready\` (launch record expired, `
          + `herdr detected the agent itself) — readiness from status ${probe.status}.`);
        return { status: probe.status, interactiveReady: true };
      }
      if (probe.status === 'blocked') {
        // Panel stoi na dialogu (najczęściej zaufanie katalogu, gdy flaga w `~/.claude.json`
        // była nieaktualna). To NIE jest porażka startu: karta dialogu pokaże, o co chodzi,
        // a zabicie panelu odebrałoby użytkownikowi jedyną możliwość odpowiedzi.
        log(`herdr launcher: pane ${paneId} starts with a dialog (status blocked).`);
        // `agent_session` przy dialogu bywa jeszcze puste — sprawdzamy tylko ROZJAZD.
        if (probe.agentSessionId !== '') await assertSameSession(probe);
        return { status: 'blocked', interactiveReady: false };
      }
      if (now() >= deadline) {
        // Panel ZOSTAJE (patrz `finish`), więc karta musi mówić, że jest na czym pracować —
        // a ogon ekranu pokazuje, na czym start stanął (dialog, aktualizacja, zwykła ślamazarność).
        const tail = await screenTail(paneId);
        await logStartFailure(
          paneId, `not ready within ${Math.round(readyTimeoutMs / 1000)} s`, probe, sessionId, start,
        );
        throw new HerdrLaunchTimeoutError(
          tail === ''
            ? say('herdr.launch-timeout', { seconds: Math.round(readyTimeoutMs / 1000) })
            : say('herdr.launch-timeout.screen', { seconds: Math.round(readyTimeoutMs / 1000), screen: foreign(tail) }),
        );
      }
      await sleep(pollMs);
    }
  };

  return {
    async launch(req: HerdrLaunchRequest): Promise<HerdrLaunchHandle> {
      const cwd = path.resolve(req.cwd);

      // Krok 1 (przed wszystkim): argv to czysta walidacja, a złe żądanie nie ma prawa
      // zostawić po sobie panelu. `sessionId` jest tylko losową liczbą — nic nie tworzy.
      const fresh = newSessionId();
      const args = buildClaudeArgs(req, fresh);
      assertAllowedArgs(args);
      /*
       * UUID, pod którym ta sesja BĘDZIE ZNANA — i pod którym leży jej plik jsonl.
       *
       * Przy świeżej sesji i przy rozwidleniu nadaje go Rarog (`--session-id`). Przy zwykłym
       * wznowieniu sesja zachowuje SWÓJ uuid, bo CLI nie pozwala nadać nowego bez
       * `--fork-session` (zmierzone: „--session-id can only be used with … --resume if
       * --fork-session is also specified"). Mylenie tych dwóch znaczyłoby szukanie
       * transkryptu pod adresem, którego nikt nie zapisze.
       */
      const sessionId = req.resumeFrom !== undefined && req.fork !== true
        ? req.resumeFrom
        : fresh;
      let startKind: StartKind = 'new';
      if (req.resumeFrom !== undefined) startKind = req.fork === true ? 'fork' : 'resume';

      /*
       * Krok 2: zaufanie katalogu — OSTRZEŻENIE, nie odmowa.
       *
       * The trust dialog stays on screen without end (measured: 40 s without a change). It is on the CLOSED list of
       * sygnatur (`KNOWN_DIALOGS`), czyli da się go potwierdzić z telefonu jednym tapnięciem — a wtedy
       * odmowa zakładania byłaby już tylko przeszkodą bez pokrycia w ryzyku.
       *
       * `waitReady` (kroki 7–8) traktuje `blocked` jako poprawny wynik startu, więc panel
       * z dialogiem zaufania nie jest błędem launchera i nie wymaga tu żadnej dodatkowej
       * ścieżki: sesja wstaje, karta dialogu pokazuje się z przyciskiem, koniec.
       */
      const trustPrompt = !(await trust.isTrusted(cwd));

      /*
       * Kroki 3–4: katalog → workspace projektu i założenie taba — RAZEM pod zamkiem projektu.
       * Resolver (`herdr/workspace-resolver.ts`) bierze kandydata po etykiecie albo
       * ścieżce checkoutu i wymaga dowodu ścieżki; bez dowodu — nowy workspace. Zamek jest wspólny
       * z backendem terminala, więc pierwsze równoczesne założenie dwóch rzeczy tego projektu
       * (dwie sesje; sesja i terminal) daje JEDEN workspace, a nie dwa.
       *
       * Nowy workspace nosi nazwę KATALOGU (albo `katalog (nadrzędny)` przy kolizji), nie tytuł
       * sesji: po nazwie resolver pozna go przy następnym starcie, a tytuł sesji nazywa TAB.
       */
      const realCwd = await realProjectPath(cwd);
      const title = sanitizePaneTitle(req.label ?? path.basename(cwd), path.basename(cwd));
      const placed = await placement.withProjectLock(realCwd, async () => {
        // `cwd` w pisowni żądania: na macOS może różnić się od `realCwd` wielkością liter, a w niej
        // mogła zostać policzona etykieta panelu sprzed poprawki.
        const decision = await decideProjectWorkspace({ client, realCwd, placement, spellings: [cwd] });
        if (decision.kind === 'existing') {
          const tab = await client.createTab({
            workspaceId: decision.workspaceId, cwd, label: title, env,
          });
          return { paneId: tab.paneId, tabId: tab.tabId, createdWorkspace: false };
        }
        const workspace = await client.createWorkspace({ cwd, label: decision.label, env });
        placement.remember(realCwd, workspace.workspaceId);
        log(`herdr launcher: new workspace "${decision.label}" for ${realCwd} (no path proof`
          + ' in the existing ones).');
        return { paneId: workspace.paneId, tabId: workspace.tabId, createdWorkspace: true };
      });
      const { paneId, tabId, createdWorkspace } = placed;

      // Krok 5: rezerwacja w supervisorze → `key`. Od tej chwili router ma `sessionId`.
      const key = deps.registerLaunch({
        paneId, tabId, agentSessionId: sessionId, cwd, label: title,
      });

      const finish = async (): Promise<HerdrLaunchResult> => {
        /*
         * `label` z `workspace.create` nazywa WORKSPACE, a jego pierwszy tab dostaje od herdr
         * „1" (zmierzone) — `tab.create` niesie etykietę sam, ta ścieżka nie.
         * Pierwszy krok części w tle, a nie przed uchwytem: 202 nie czeka na RPC, którego
         * porażka (timeout gniazda = 5 s) niczego by nie zmieniła. BEST EFFORT — nazwa taba
         * nie jest warunkiem sesji. Ślad w etykiecie panelu (krok 6) liczy się z tej samej
         * etykiety także wtedy, gdy zmiana się nie udała: tab pokazuje wtedy „1", a nie nic,
         * co Rarog mógłby kiedyś wziąć za swoje.
         */
        if (createdWorkspace) {
          try {
            await client.renameTab(tabId, title);
          } catch (err) {
            log(`herdr launcher: failed to set the Rarog label on tab ${tabId} (${(err as Error).message}) `
              + '— it keeps "1".');
          }
        }
        let argv: readonly string[];
        try {
          argv = await startAgent(paneId, args);
        } catch (err) {
          /*
           * DWA RÓŻNE NIEPOWODZENIA, dwie różne decyzje o cudzym procesie.
           *
           * „herdr odpowiedział błędem startu" (kod zdalny: `agent_name_taken` po trzech
           * próbach, `agent_pane_busy` po całym oknie, `feature_disabled`…) znaczy, że
           * PROCESU NIE MA — zostaje po nas pusty tab i sprzątamy go, bo sami go stworzyliśmy
           * (reguła 11.9). `workspace.close` celowo nie jest w allow-liście metod: pusty
           * workspace jest nieszkodliwy, a jedna metoda mniej jest warta jednego pustego
           * workspace'a.
           *
           * „nie wiem, co się stało" (timeout gniazda, zerwane połączenie — `HerdrUnavailable
           * Error`) NIE JEST tym samym: `agent.start` mógł dojść i wykonać się w całości,
           * a zgubiła się dopiero odpowiedź. Ślepy `closeTab` zabijał wtedy panel z żywym,
           * właśnie uruchomionym agentem — i to bez śladu dla użytkownika. Tab ZOSTAJE:
           * sierotą zajmie się resync (≤ 30 s), a reguła 11.9 mówi wprost, że sierota ma być
           * WIDOCZNA. Koszt pomyłki w tę stronę to jeden panel do zamknięcia ręcznie; koszt
           * pomyłki w drugą to ubita sesja.
           */
          if (isUncertainStartOutcome(err)) {
            log(`herdr launcher: unknown outcome of \`agent.start\` on ${paneId} — tab ${tabId}`
              + ' STAYS (the pane may be alive; resync will see it).');
            throw err;
          }
          try {
            await client.closeTab(tabId);
          } catch {
            log(`herdr launcher: failed to clean up tab ${tabId} after a failed start.`);
          }
          throw err;
        }

        /*
         * Krok 6: pochodzenie i tytuł panelu — oba BEST EFFORT, żaden nie przerywa startu.
         *
         * The pane label leads with the tab label set above (`<title> · rarog-claude …`), so
         * herdr's Go-to window names the pane like its tab.
         *
         * Etykieta PANELU `rarog-claude <klucz projektu> <ślad etykiety taba>` jest jedyną rzeczą
         * Raroga, którą herdr trzyma w snapshotcie (przeżywa jego restart) — dowód „ten panel
         * założył Rarog dla tego projektu". Idzie PO `agent.start`, na panelu, który launcher
         * sam przed chwilą stworzył; herdr zostawia ją przy wykryciu agenta, przy jego wyjściu
         * i przy kolejnym uruchomieniu. WŁASNOŚCI nie daje — tę mówi
         * nazwa agenta `rarog-<6 hex>` i klucz zarezerwowany w nadzorcy (`registerLaunch`).
         */
        try {
          await client.renamePane(paneId, claudePaneLabel(projectKey(realCwd), labelTrace(title), title));
        } catch (err) {
          log(`herdr launcher: failed to set the provenance label on pane ${paneId} `
            + `(${(err as Error).message}) — the session starts anyway.`);
        }
        // Dopiero teraz nadzorca może zsynchronizować etykietę taba z kartą — z dowodem
        // pochodzenia na panelu albo, gdy go nie ma, drogą migracji (nazwa agenta `rarog-*`).
        deps.paneLabelled?.(key);
        // Tytuł panelu — bez tokenów i bez TTL: trwa do nadpisania albo zamknięcia panelu.
        try {
          await client.reportPaneMetadata({ paneId, source: RAROG_METADATA_SOURCE, title });
        } catch {
          log(`herdr launcher: failed to set the Rarog title on pane ${paneId}.`);
        }

        // Kroki 7–8. Timeout NIE sprząta: panel może stać na dialogu i za chwilę ruszyć,
        // a zabicie go byłoby gorsze niż wisząca karta.
        const settled = await waitReady(paneId, sessionId, startKind);

        return {
          key, paneId, tabId, agentSessionId: sessionId, createdWorkspace, argv,
          status: settled.status,
          interactiveReady: settled.interactiveReady,
        };
      };

      // Kroki 6–8 dopiero po oddaniu uchwytu (patrz `defer`): manager ma zdążyć odpowiedzieć
      // 202 i podpiąć driver, zanim w panelu ruszy proces.
      const ready = new Promise<HerdrLaunchResult>((resolve, reject) => {
        defer((): void => {
          finish().then(resolve, reject);
        });
      });
      // Manager obsługuje odrzucenie w `#finishLaunch`, ale uchwyt bywa porzucony (klient
      // zamknął kartę zaraz po 202) — bez tego jedna nieudana próba wywracałaby proces
      // przez `unhandledRejection`. Oryginalna obietnica zachowuje odrzucenie.
      void ready.catch((): void => {});

      return {
        key,
        paneId,
        tabId,
        agentSessionId: sessionId,
        ...(trustPrompt ? { trustPrompt: true } : {}),
        ready,
      };
    },
  };
}
