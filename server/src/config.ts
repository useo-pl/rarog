/**
 * Konfiguracja serwera Rarog — jedyne miejsce, w którym czytamy `process.env`. Nazwy zmiennych i ich rodzaje stoją
 * w rejestrze `config-env.ts`; odczyt wyłącznie przez `readEnv` z tego rejestru.
 *
 * Twarde reguły z speca:
 * - bind ZAWSZE 127.0.0.1 (hardcode; próba nadpisania przez env kończy się wyjątkiem),
 * - demo mode (`RAROG_DEMO=1`) daje bezpieczne domyślne: dataDir w tmp, origin allow-lista = własny adres
 *   serwera na loopbacku (`demoOrigins`),
 * - jedynym poświadczeniem jest klucz urządzenia z parowania; logowania tokenem serwer nie ma
 *   (`/api/login` odpowiada stałym 410 `login-retired`), więc konfiguracja nie zna żadnego tokenu aplikacji.
 */
import { createPrivateKey } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { MAX_TRANSCRIPT_MESSAGES } from '@rarog/shared';
import { BUNDLE_ID_RE } from '@rarog/shared/rest';
import { dataDirConflictMessage, resolveDataDir } from '@rarog/shared/data-dir';
import {
  AGENT_FILES_ENV,
  APNS_ENV_NAMES,
  APNS_KEY_ID_ENV,
  APNS_KEY_PATH_ENV,
  APNS_TEAM_ID_ENV,
  APNS_TOPIC_ENV,
  CLAUDE_ENV_CLEAR_ENV,
  ConfigError,
  CLI_WAITING_ENV,
  CODEX_STATUS_ENV,
  COMPANION_ENV,
  COMPANION_MODEL_ENV,
  COMPANION_SESSIONS_ENV,
  COMPANION_ENV_PASSTHROUGH,
  CONSENT_CHANNEL_ENV,
  CONSENT_PROOF_ENV,
  CONSENT_ALWAYS_ENV,
  CONSENT_RESTART_GRACE_ENV,
  DEMO_CONTENT_ENV,
  DEMO_LANG_ENV,
  DEMO_REVIEW_CODE_ENV,
  DIALOG_LAYER2_ENV,
  FOLDER_GATE_ENV,
  GIT_ENV_PASSTHROUGH,
  GIT_ENV_PREFIX,
  GIT_FILE_DETAILS_ENV,
  HERDR_BIN_ENV,
  HERDR_LAUNCH_ENV,
  HERDR_ROOTS_ENV,
  HERDR_SEEN_FOCUS_ENV,
  HERDR_SEND_ENV,
  HERDR_SOCKET_ENV,
  HERDR_TAB_LABELS_ENV,
  INBOX_ENV,
  FILES_ENV,
  FILES_MAX_MB_ENV,
  IROH_ENV,
  IROH_KEY_ENV,
  IROH_PORT_ENV,
  IROH_RELAY_ENV,
  MAX_PANES_ENV,
  MIN_CLIENT_BUILD_ENV,
  NOTES_ENV,
  PROJECT_ROOTS_ENV,
  PROMPT_BLOCK_ENV,
  PUSH_E2E_ENV,
  PUSH_ENV,
  PR_STATUS_ENV,
  PR_STATUS_ENV_PASSTHROUGH,
  PUSH_RELAY_URL_ENV,
  QUEUE_ECHO_ENV,
  REFUSAL_DUMPS_ENV,
  SONIOX_API_HOST_ENV,
  SONIOX_API_KEY_ENV,
  OPENAI_API_KEY_ENV,
  SSE_GZIP_ENV,
  TALL_DIALOG_GUARD_ENV,
  TERM_ENV,
  TERM_ENV_PASSTHROUGH,
  TERM_IDLE_DAYS_ENV,
  TERM_MAX_ENV,
  VOICE_ENV,
  YOLO_ROOTS_ENV,
  readEnv,
} from './config-env.ts';
import { RAROG_VERSION } from './version.ts';
import { INSTALL_MODE } from './install/mode.ts';
import type { InstallMode } from './install/mode.ts';
import { DEVICES_FILENAME, activeDeviceEpochs } from './auth/devices-store.ts';
import { HOOK_CHANNEL_MODE_ALL, HOOK_CHANNEL_MODE_OFF, HOOK_CHANNEL_MODES } from './herdr/dialogs/hook/contract.ts';
import type { HookChannelMode } from './herdr/dialogs/hook/contract.ts';
import { CONSENT_PROOF_RULES } from './herdr/dialogs/layer1/contract.ts';
import type { ConsentProofRule } from './herdr/dialogs/layer1/contract.ts';
// Sam typ (import bez kodu): proces produkcyjny nie wczytuje treści demo.
import type { DemoLang, DemoSet } from './demo/content/types.ts';
import { readAccountDefaultEffort, readAccountDefaultModel } from './config/claude-account.ts';
import { minClientBuildOf, parseMinClientBuild } from './config/clients.ts';
import {
  DEMO_REVIEW_MAX_DEVICES, assertDemoReviewOrigins, demoEnabled, parseDemoContent, parseDemoLang, parseDemoReview,
} from './config/demo.ts';
import type { DemoReviewConfig } from './config/demo.ts';
import {
  COMPANION_MODEL_DEFAULT, COMPANION_MODEL_PATTERN, parseAgentFiles, parseCliWaiting, parseCodexStatusEnabled,
  parseCompanionEnabled, parseCompanionModel, parseCompanionSessionsEnabled, parseConsentRestartGrace,
  parseGitFileDetails, parseInboxEnabled, parseNotesEnabled,
  parsePrStatusEnabled, parsePromptBlock, parseQueueEcho, parseRefusalDumps, parseSseGzip,
} from './config/flags.ts';
import { parseFilesEnabled, parseFilesMaxBytes } from './config/files.ts';
import {
  DEFAULT_MAX_PANES, defaultHerdrSocket, parseHerdrLaunch, parseHerdrSeenFocus, parseHerdrSend, parseHerdrSocket,
  parseHerdrTabLabels, parseMaxPanes,
} from './config/herdr.ts';
import type { HerdrSocketOptions } from './config/herdr.ts';
import {
  DEFAULT_PORT, MAX_BODY_BYTES, RAROG_HOST, assertLoopbackHost, demoOrigins, parseIroh, parseOrigins, parsePort,
} from './config/listen.ts';
import type { IrohConfig } from './config/listen.ts';
import {
  APPLE_ID_RE, expandHome, parsePushE2e, parsePushEnabled, parsePushRelay, readApnsKeyFile,
} from './config/push.ts';
import type { ApnsConfig, ApnsKeyFile, ApnsKeyReader, PushRelayConfig } from './config/push.ts';
import {
  expandTilde, isInsideAnyRoot, isInsideAnyRootReal, parseHerdrRoots, parseProjectRoots, parseYoloRoots,
  validateProjectCwd,
} from './config/roots.ts';
import type { CwdCheck, CwdCheckOptions } from './config/roots.ts';
import {
  DEFAULT_HERDR_BIN, DEFAULT_TERM_IDLE_DAYS, DEFAULT_TERM_MAX, RAROG_TERM_PANE_TOKEN, TERM_START_RETRY_MS,
  TERM_TOKEN_REFRESH_MS, parseHerdrBin, parseTermEnabled, parseTermIdleDays, parseTermMax, termPaneTokenOf,
} from './config/terminal.ts';
import { VOICE_TOKEN_HOURLY_CAP, VOICE_TOKEN_MIN_INTERVAL_MS, parseVoiceEnabled } from './config/voice.ts';

/*
 * Area parsers and the directory checks live in `server/src/config/` and never read the environment:
 * `loadConfig` below passes the values in. This file re-exports their names, so imports from `config.ts`
 * stay as they are.
 */
export {
  COMPANION_MODEL_DEFAULT, COMPANION_MODEL_PATTERN, parseCompanionModel,
  DEFAULT_HERDR_BIN, DEFAULT_MAX_PANES, DEFAULT_PORT, DEFAULT_TERM_IDLE_DAYS, DEFAULT_TERM_MAX, DEMO_REVIEW_MAX_DEVICES,
  MAX_BODY_BYTES, RAROG_HOST, RAROG_TERM_PANE_TOKEN, TERM_START_RETRY_MS, TERM_TOKEN_REFRESH_MS,
  VOICE_TOKEN_HOURLY_CAP, VOICE_TOKEN_MIN_INTERVAL_MS, assertLoopbackHost, defaultHerdrSocket, demoOrigins,
  expandTilde, isInsideAnyRoot,
  isInsideAnyRootReal, parseAgentFiles, parseCliWaiting, parseCodexStatusEnabled, parseCompanionEnabled,
  parseGitFileDetails, parseHerdrBin,
  parseHerdrLaunch, parseHerdrRoots, parseHerdrSeenFocus, parseHerdrSend, parseHerdrSocket, parseHerdrTabLabels,
  parseMinClientBuild, parseNotesEnabled, parseProjectRoots, parsePromptBlock, parsePushE2e, parsePushEnabled,
  parsePushRelay, parseQueueEcho, parseRefusalDumps, parseSseGzip, parseTermEnabled, parseTermIdleDays, parseTermMax,
  parseVoiceEnabled, parseYoloRoots, readAccountDefaultEffort, readAccountDefaultModel, termPaneTokenOf,
  validateProjectCwd,
};
export type {
  ApnsConfig, ApnsKeyFile, ApnsKeyReader, CwdCheck, CwdCheckOptions, DemoReviewConfig, HerdrSocketOptions, IrohConfig,
  PushRelayConfig,
};

export interface RarogConfig {
  /** Tryb demo: mock-driver, dane w tmp. */
  readonly demo: boolean;
  /**
   * Tryb recenzji (`RAROG_DEMO_REVIEW_CODE`, tylko przy `demo`); `null` = zwykłe demo albo serwer. Wymaga jednego
   * originu `https` i jawnego `RAROG_DATA_DIR`, a strażnik epoki działa w nim jak poza demo (`parseDemoReview`).
   */
  readonly demoReview: DemoReviewConfig | null;
  /**
   * Język treści demo (`RAROG_DEMO_LANG`, domyślnie `en`): który zestaw z `demo/content/` składa proces demo.
   * Poza demo bez znaczenia, ale zła wartość i tak jest błędem startu.
   */
  readonly demoLang: DemoLang;
  /**
   * Named demo content set (`RAROG_DEMO_CONTENT`) instead of the language set, only in the plain English demo and only
   * when this build has its module (`parseDemoContent`); `null` = the set of {@link demoLang}.
   */
  readonly demoSet: DemoSet | null;
  /** Epoka uwierzytelnienia — zmiana odpina wszystkie urządzenia z inną epoką (`devices-store.ts`). */
  readonly epoch: string;
  readonly port: number;
  readonly host: typeof RAROG_HOST;
  /** Katalog na rejestr sesji i log klienta. */
  readonly dataDir: string;
  /**
   * `Origin` dozwolone w mutacjach po TCP (`RAROG_ORIGINS`; reguła: `auth/origin.ts`). Przy włączonym iroh lista
   * bywa pusta: wtedy każda mutacja po TCP dostaje 403, a link parowania niesie tylko `k=` i `r=`.
   */
  readonly originAllowList: readonly string[];
  /**
   * `RAROG_ORIGINS` entries that are not an origin (`config/listen.ts`), for the start log and `rarog serve --check`.
   * Absent when there are none. Never a start error.
   */
  readonly originsSkipped?: readonly string[];
  /** Nasłuch iroh (`RAROG_IROH=1`); `null` = wyłączony, moduł natywny się nie ładuje. */
  readonly iroh: IrohConfig | null;
  /** Wersja serwera z `package.json` korzenia repo (`version.ts`), nie ze zmiennej środowiska. */
  readonly version: string;
  readonly maxBodyBytes: number;
  /**
   * Korzenie, wewnątrz których wolno założyć sesję (`RAROG_PROJECT_ROOTS`, default `~/Projects`).
   *
   * To jest granica bezpieczeństwa dla pola „inna ścieżka…" w formularzu nowej sesji:
   * użytkownik może wskazać dowolny podkatalog roota, ale nic poza nim.
   */
  readonly projectRoots: readonly string[];
  /**
   * Ile ŻYWYCH paneli Raroga wolno mieć naraz (`RAROG_MAX_PANES`, domyślnie 30 — zapora
   * przeciwpowodziowa, nie limit pracy; patrz `DEFAULT_MAX_PANES`).
   *
   * Pole jest WYMAGANE, bo `undefined` znaczyłoby w managerze i nadzorcy „bez sufitu", tyle że
   * po cichu — a wtedy literówka w nazwie zmiennej wyglądałaby identycznie jak świadoma
   * decyzja. Liczba WPISANA wprost jest decyzją widoczną w konfiguracji.
   */
  readonly maxPanes: number;
  /**
   * Katalogi, w których wolno założyć sesję w trybie `bypassPermissions`
   * (`RAROG_YOLO_ROOTS`, domyślnie PUSTA lista = nigdzie).
   *
   * `docs/security-model.md`, „Starting sessions from the phone”, reguła 5: `bypassPermissions` wymaga
   * `RAROG_YOLO_ROOTS`.
   * Granicą bezpieczeństwa Raroga jest zgoda na KAŻDE użycie narzędzia, więc tryb, który tę
   * zgodę wyłącza, nie może być polem w ciele requestu — musi być decyzją z konfiguracji.
   */
  readonly yoloRoots: readonly string[];
  /** Ścieżka gniazda herdr (`RAROG_HERDR_SOCKET`). Integracja NIE jest już opcją. */
  readonly herdrSocket: string;
  /** Korzenie paneli pokazywanych w pełni (`RAROG_HERDR_ROOTS`, domyślnie = `projectRoots`). */
  readonly herdrRoots: readonly string[];
  /** Kanał ZAPISU do istniejących paneli (`RAROG_HERDR_SEND`, domyślnie włączony). */
  readonly herdrSend: boolean;
  /**
   * Kanał TWORZENIA paneli (`RAROG_HERDR_LAUNCH`, domyślnie **wyłączony**).
   *
   * Killswitch rozłączny z `herdrSend`: tamten mówi „nie piszę do cudzych paneli", ten
   * „nie uruchamiam procesów". Domyślne `0` jest tą samą doktryną, którą miał `RAROG_HERDR`:
   * prawo URUCHOMIENIA PROCESU na Macu musi być świadomą decyzją w jednostce uruchomieniowej,
   * a nie stanem domyślnym po `git pull`. Koszt opt-inu to jedna linia raz; koszt pomyłki to
   * `pnpm dev` z prawem zakładania paneli.
   */
  readonly herdrLaunch: boolean;
  /**
   * Czy wejście w transkrypt gasi znacznik `done` PO STRONIE HERDR
   * (`RAROG_HERDR_SEEN_FOCUS`, domyślnie włączone).
   *
   * NIE jest to szósty killswitch władzy: jedyną metodą, jaką ta ścieżka woła, jest
   * `agent.focus` — a ta siedzi w `MUTATING_METHODS`, więc `RAROG_HERDR_SEND=0` gasi ją
   * niezależnie od tej flagi. To PREFERENCJA: `0` znaczy „nie przestawiaj mi widoku herdr
   * na Macu, znacznik `done` skasuję sam", a nie „Rarog ma mniej władzy".
   */
  readonly herdrSeenFocus: boolean;
  /**
   * Czy Rarog NAZYWA taby w herdr po założeniu (`RAROG_HERDR_TAB_LABELS`, domyślnie włączone):
   * etykieta taba z Claude idzie za etykietą karty, a taby bez etykiety Raroga (Claude i terminala)
   * dostają ją przy migracji.
   *
   * PREFERENCJA, nie szósty killswitch (jak `herdrSeenFocus`): `tab.rename` i `pane.rename` są
   * w `MUTATING_METHODS`, więc `RAROG_HERDR_SEND=0` gasi je niezależnie od tej flagi. `false`
   * zostawia etykiety nadane przy ZAKŁADANIU taba i niczego później nie przemianowuje.
   */
  readonly herdrTabLabels: boolean;
  /**
   * Zmienne środowiska ZEROWANE w nowym panelu (`RAROG_CLAUDE_ENV_CLEAR`).
   *
   * Serwer herdr dziedziczy env po tym, kto go uruchomił; odziedziczony `CLAUDE_CODE_CHILD_SESSION`
   * wyłącza zapis transkryptu („Transcript saving is off”, docs `errors.md`),
   * a wtedy cała warstwa treści Raroga znika PO CICHU. Konfigurowalne, bo to jedyne miejsce,
   * które trzeba będzie poprawić, gdy `claude` doda kolejną zmienną.
   */
  readonly claudeEnvClear: readonly string[];
  /**
   * Dyktowanie jest DOSTĘPNE: `RAROG_VOICE` ≠ `0` **i** w env jest `SONIOX_API_KEY`.
   *
   * Pole jest wyliczone, a nie surową flagą, bo klientowi potrzebna jest dokładnie ta jedna
   * odpowiedź: pokazać mikrofon czy nie. Brak klucza = funkcja wyłączona z czytelnym
   * komunikatem — nigdy błąd startu i nigdy martwy przycisk.
   */
  readonly voiceEnabled: boolean;
  /**
   * Stały klucz Soniox (`SONIOX_API_KEY`, ze środowiska serwera: `rarog serve` składa je z `config.json`,
   * pliku sekretów i wrappera usługi).
   *
   * NIGDY nie wychodzi w odpowiedzi HTTP ani do logu — na telefon jedzie wyłącznie klucz
   * TYMCZASOWY z `voice/soniox.ts`. Trzymamy go w configu tylko po to, żeby router
   * mógł go dopisać do listy sekretów `redact()`.
   */
  readonly sonioxApiKey?: string;
  /** Deklarowany host Soniox (`SONIOX_API_HOST`) — tylko do kontroli regionu UE. */
  readonly sonioxApiHost?: string;
  /**
   * Powiadomienia są DOSTĘPNE: `RAROG_PUSH` ≠ `0` **i** jest kanał APNs apki natywnej — komplet
   * klucza ({@link apns}) ALBO przekaźnik push ({@link pushRelay}). Innego kanału nie ma.
   *
   * Pole jest wyliczone, a nie surową flagą, dokładnie jak `voiceEnabled` i z tego samego
   * powodu: brak kluczy = funkcja po prostu wyłączona, nigdy błąd startu i nigdy
   * kanał, który udaje, że działa. `RAROG_PUSH=0` gasi banery i Live Activity naraz.
   */
  readonly pushEnabled: boolean;
  /**
   * Treść banerów szyfrowana end-to-end (`RAROG_PUSH_E2E` ≠ `0`, domyślnie włączona). `false` = żaden wpis nie
   * dostaje ładunku v2, więc nie ma banerów ani plakietki „skończył”; Live Activity bez zmian. Wyłącznik banerów,
   * nie killswitch: dostępu niczego nie odbiera (`docs/server-config.md`).
   */
  readonly pushE2e: boolean;
  /**
   * Zrzuty diagnostyczne odmów (`RAROG_REFUSAL_DUMPS` ≠ `0`, domyślnie włączone; `docs/dialogs.md`, „Refusal diagnostics”).
   *
   * `false` = Rarog nie tworzy `<dataDir>/refusals/` i nie pisze tam ani bajtu; żniwiarz
   * startowy sprząta dalej, żeby wyłączenie ficzera opróżniło katalog, a nie zamroziło go.
   */
  readonly refusalDumps: boolean;
  /**
   * Notatki projektu są DOSTĘPNE (`RAROG_NOTES` ≠ `0`, domyślnie włączone).
   *
   * `false` = `/api/notes` oddaje 404 na każdej metodzie, `GET /api/version` mówi
   * `notesEnabled: false`, a klient nie pokazuje wejścia do notatek (nigdy martwy przycisk).
   * Pliki w `<dataDir>/notes/` zostają nietknięte: killswitch zamyka ścieżkę ZAPISU, a nie
   * kasuje treści, których nikt poza właścicielem Maca nie odtworzy.
   */
  readonly notesEnabled: boolean;
  /**
   * Panele Codexa wchodzą do Raroga jako wpisy STANU (`RAROG_CODEX_STATUS` ≠ `0`, domyślnie
   * włączone).
   *
   * FLAGA FUNKCJI, nie szósty killswitch (patrz {@link CODEX_STATUS_ENV}). `false` = filtr
   * wejściowy herdr odrzuca `agent === 'codex'`: żadnego wiersza, żadnego
   * pusha, żadnej sesji. Do `GET /api/version` NIE jedzie — klient nie ma przycisku, który
   * miałby od niej zgasnąć (reguła dotyczy MARTWYCH przycisków, a tu po prostu nie ma wiersza).
   */
  readonly codexStatusEnabled: boolean;
  /**
   * Wykrycie dialogu z rejestru sesji CLI (`RAROG_CLI_WAITING` ≠ `0`, domyślnie
   * włączone).
   *
   * PREFERENCJA, nie killswitch (patrz {@link CLI_WAITING_ENV}): rejestr niczego nie zatwierdza
   * i niczego nie wysyła — budzi ocenę ekranu i trzyma kartę, gdy herdr nie widzi dialogu.
   * `false` = brak szybkiego tiku rejestru, tylko sygnał herdr. W demo zawsze `false`.
   */
  readonly cliWaiting: boolean;
  /**
   * Szczegóły plików w ramce `git-status` (`RAROG_GIT_FILE_DETAILS` ≠ `0`, domyślnie włączone):
   * rodzaj każdego brudnego pliku i liczniki linii z `git diff --numstat`.
   *
   * PREFERENCJA, nie killswitch (patrz {@link GIT_FILE_DETAILS_ENV}): pole tylko czyta repo.
   * `false` = ramka bez `fileDetails` i bez odczytu liczników, jak przed polem.
   */
  readonly gitFileDetails: boolean;
  /**
   * Odczyt plików rozmów subagentów (`RAROG_AGENT_FILES` ≠ `0`, domyślnie włączone).
   *
   * PREFERENCJA, nie killswitch (patrz {@link AGENT_FILES_ENV}): odczyt niczego nie zatwierdza
   * i niczego nie wysyła do panelu. `false` = driver nie zakłada czytnika plików subagentów:
   * agent po postoju stoi na „czeka" do wznowienia albo końca i nie ma listy własnych komend.
   * W demo zawsze `false`.
   */
  readonly agentFiles: boolean;
  /**
   * Echo odroczone (`RAROG_QUEUE_ECHO` ≠ `0`, domyślnie włączone): prompt wysłany przez
   * klienta z `queueAware` w trakcie pracy agenta staje w transkrypcie dopiero, gdy CLI go weźmie.
   *
   * PREFERENCJA, nie killswitch (patrz {@link QUEUE_ECHO_ENV}): zmienia wyłącznie chwilę, w której
   * wiadomość wchodzi do transkryptu. `false` = echo od razu. W demo zawsze
   * `false` (mock nie ma pliku rozmowy).
   */
  readonly queueEcho: boolean;
  /**
   * Strażnik wysokości dialogu zgody `Bash` w hooku treści (`RAROG_TALL_DIALOG_GUARD` ≠ `0`,
   * domyślnie włączony).
   *
   * Serwer niczego tu nie wykonuje: flaga trafia do `roots.json` jako pole `tallDialogGuard`,
   * a odmawia hook (patrz {@link TALL_DIALOG_GUARD_ENV}). `false` = pole nieobecne, hook jak
   * przed strażnikiem.
   */
  readonly tallDialogGuard: boolean;
  /**
   * Rozpoznanie promptu zablokowanego przez hook `UserPromptSubmit` (`RAROG_PROMPT_BLOCK` ≠ `0`, domyślnie
   * włączone; `docs/dialogs.md`, „Prompt blocked by a hook”).
   *
   * Wyłącznik, nie killswitch (patrz {@link PROMPT_BLOCK_ENV}): `false` = zachowanie bez rozpoznania
   * w całości — wpis blokady pomijany, driver bez flag blokady.
   */
  readonly promptBlock: boolean;
  /**
   * Kanał zgody hooka (`RAROG_CONSENT_CHANNEL`, domyślnie `all`; `docs/server-config.md`, „Preferences and feature
   * flags”, i `docs/dialogs.md`, „Per-call dump and shadow mode”).
   *
   * `off` = serwer pisze `alive.json` z `mode: "off"` i sprząta katalogi cienia, nic więcej. `shadow` = przed
   * klawiszem zgody albo odmowy z telefonu plik cienia pod kluczem prośby z dowodem „dialog stoi”; klawisz
   * idzie jak przy `off`. W demo zawsze `off` (mock nie ma hooka ani rejestru CLI).
   *
   * `main` = kanał zgód dla wątku głównego, `all` = to samo plus prośby subagentów (karta bez przycisku zgody i powrót
   * do biurka). Oba to tylko tryb SKONFIGUROWANY: tryb efektywny liczy serwer po starcie gniazd
   * (`herdr/dialogs/layer1/mode.ts`) i bez kompletu warunków daje `shadow`.
   * So the default `all` does not open the channel of an install without the hook or without a minimum app build
   * (`RAROG_MIN_CLIENT_BUILD`, or the package default from server/src/config/clients.ts): it runs as `shadow` with the
   * reason in `/health`.
   */
  readonly consentChannel: HookChannelMode;
  /**
   * The "dialog stands" proof rule of the consent channel (`RAROG_CONSENT_PROOF`, default `channel`;
   * `docs/server-config.md`, "Preferences and feature flags", and `docs/dialogs.md`, "Proof rule"). `channel` = the
   * approve button of a main-thread request outside MCP from a live hook and a fresh registry read `waiting:
   * permission`, without the screen top, in a session on a release in the package base `CONSENT_CHANNEL_MEASURED_CLI`
   * or passed in the canary file (version gate per request kind, `layer1/version-gate.ts`; the rest = `screen`);
   * `screen` = the screen top for every request, whatever the canary file says. No effect at `off`, `shadow`, demo.
   */
  readonly consentProof: ConsentProofRule;
  /**
   * The "always" option of consent channel cards (`RAROG_CONSENT_ALWAYS`, default `on`; `docs/server-config.md`,
   * "Preferences and feature flags", and `docs/dialogs.md`, "Per-call dump and shadow mode", item "Always option").
   * `true` = a card whose suggestions are all on the closed list (`layer1/always.ts`) offers "always"; `false` = no
   * card does. No effect with the channel `off` or `shadow` and in demo.
   */
  readonly consentAlways: boolean;
  /**
   * Restart grace G of the consent channel in ms (`RAROG_CONSENT_RESTART_GRACE` in whole seconds, default 45;
   * `docs/server-config.md`, "Preferences and feature flags", and `docs/dialogs.md`, "Restart break"). The server
   * hands it to the `alive.json` writer, the channel registry and the cycle only with a channel configured (`main` or
   * `all`): its stop then writes `stop: {ts, graceMs}` and its start `phase: "starting"`, a hook that starts in the
   * break waits up to G for the next server's channel, a waiting hook pauses for it, and recovery keeps the records of
   * live hooks waiting G for their second registration. `0` = neither field and no wait, as before. No effect in demo
   * (no `alive.json`, no channel).
   */
  readonly consentRestartGraceMs: number;
  /**
   * Warstwa 2 dialogów (`RAROG_DIALOG_LAYER2=1`, domyślnie wyłączona; `docs/dialogs.md`, „Block card without digits”).
   * Czytana raz przy starcie i podawana driverowi parametrem (`HerdrDriverDeps.dialogLayer2`). `false` = kod bez
   * warstwy 2, także w dzienniku. W demo bez skutku: mock nie ma drivera herdr.
   */
  readonly dialogLayer2: boolean;
  /**
   * The folder gate (`RAROG_FOLDER_GATE`, on by default on macOS; `docs/macos-folders.md`): disk calls of the work
   * area in a guarded folder of home run in a helper process (`bootstrap/folder-gate.ts`). Always `false` in demo.
   */
  readonly folderGate: boolean;
  /**
   * SSE stream compression with gzip (`RAROG_SSE_GZIP`, on by default, `0` turns it off). The server compresses
   * only when the client sent `Accept-Encoding` naming `gzip` with a weight above zero (`sse.ts`, `acceptsGzip`).
   */
  readonly sseGzip: boolean;
  /**
   * Voice agent at a session (`RAROG_COMPANION=1`, off by default, `docs/companion.md`). Only the flag: the
   * router adds the OpenAI key and the Soniox voice (`companionEnabled` in `GET /api/version`). `false` = the route
   * `POST /api/sessions/:id/companion/ask` answers 503 `companion-disabled` and `GET /api/version` says
   * `companionEnabled: false`. Always `false` in demo mode: the demo has no conversation files and starts no process.
   */
  readonly companionEnabled: boolean;
  /**
   * The voice agent's mode across sessions (`RAROG_COMPANION_SESSIONS=1`, off by default, `docs/companion.md`,
   * "Turns route"). `false` = `GET /api/sessions/:id/companion/turns` answers 503 `companion-sessions-disabled` and
   * `GET /api/version` has no `companionSessions`. Always `false` in demo mode.
   */
  readonly companionSessionsEnabled: boolean;
  /**
   * Base environment of the voice agent's `claude -p` process: the server's start environment cut to
   * {@link COMPANION_ENV_PASSTHROUGH}, empty values dropped. In the config for the same reason as
   * {@link termEnvBase}: the list is the secret boundary, and `config.ts` is the only reader of the environment.
   */
  readonly companionEnvBase: Readonly<Record<string, string>>;
  /**
   * OpenAI Realtime model the server sets on every short-lived key of the voice agent (`RAROG_COMPANION_MODEL`,
   * default `gpt-realtime-2.1`).
   */
  readonly companionModel: string;
  /**
   * The server's OpenAI key for the voice agent (`OPENAI_API_KEY`, from the server environment). It never goes out in
   * an HTTP response or a log: the phone gets only short-lived keys (`companion/openai-token.ts`). In the config so
   * the router can put it on the `redact()` list ({@link logSecrets}), also when `RAROG_COMPANION=0`.
   */
  readonly openaiApiKey?: string;
  /**
   * PR status (`RAROG_PR_STATUS`, on by default; `docs/pull-requests.md`): `false` = no tracker and no `gh` call, the
   * `state` field of a session's PRs never goes out. In demo mode the states come from a fixed map, never from `gh`.
   */
  readonly prStatusEnabled: boolean;
  /**
   * Inbox (`RAROG_INBOX`, on by default; `docs/server-config.md`): `false` = no card tracker, no Inbox event on the
   * stream, no `inbox` capability, and the Inbox routes answer 503. The demo reads its cards from its own sessions
   * and obeys the flag the same way.
   */
  readonly inboxEnabled: boolean;
  /**
   * Session files (`RAROG_FILES`, on by default; `docs/server-config.md`): `false` = the file routes answer 404 as
   * unknown routes and the `files` capability is absent. The demo lists its fixed tree and obeys the flag the same way.
   */
  readonly filesEnabled: boolean;
  /** The largest file of a session the server sends, in bytes (`RAROG_FILES_MAX_MB` × 1 MiB, 50 MiB by default). */
  readonly filesMaxBytes: number;
  /**
   * Base environment of the `gh` process of the PR status: the server's start environment cut to
   * {@link PR_STATUS_ENV_PASSTHROUGH}, empty values dropped (same reason as {@link companionEnvBase}).
   */
  readonly prStatusEnvBase: Readonly<Record<string, string>>;
  /**
   * Terminal PTY jest WŁĄCZONY (`RAROG_TERM=1`). Domyślnie `false`.
   *
   * To jest TRZECI killswitch Raroga i pierwszy, który otwiera PEŁNĄ POWŁOKĘ — dlatego
   * opt-in, jak `RAROG_HERDR_LAUNCH`. `false` znaczy: `POST /api/term` oddaje 404, upgrade
   * WS kończy się `socket.destroy()`, a klient nie pokazuje wiersza „Terminal".
   */
  readonly termEnabled: boolean;
  /** Sufit ŻYWYCH PTY naraz (`RAROG_TERM_MAX`, default 4). Ponad sufit `POST` oddaje 409. */
  readonly termMax: number;
  /** Po ilu dniach ciszy żniwiarz zabija bezczynną powłokę (`RAROG_TERM_IDLE_DAYS`). */
  readonly termIdleDays: number;
  /**
   * Ścieżka binarki herdr (`RAROG_HERDR_BIN`, default `~/.local/bin/herdr`).
   *
   * Używa jej WYŁĄCZNIE backend terminala (`herdr terminal session control`) — reszta
   * integracji rozmawia z herdr gniazdem, nie procesem. Binarkę spawnowaną z pełnią
   * uprawnień użytkownika wskazujemy palcem, a nie wyszukujemy w `PATH`.
   */
  readonly herdrBin: string;
  /**
   * Środowisko BAZOWE powłoki terminala — wycinek env serwera wg {@link TERM_ENV_PASSTHROUGH}.
   *
   * Pole jest w configu, a nie odczytywane w module `term/`, z jednego powodu: `config.ts`
   * deklaruje się jako jedyne miejsce czytające `process.env` po konfigurację, a lista
   * przepuszczanych zmiennych JEST konfiguracją granicy sekretów.
   */
  readonly termEnvBase: Readonly<Record<string, string>>;
  /**
   * Środowisko BAZOWE procesów `git` — wycinek env serwera wg {@link GIT_ENV_PASSTHROUGH}.
   *
   * Ta sama racja co przy {@link termEnvBase}: lista przepuszczanych zmiennych JEST
   * konfiguracją granicy sekretów, więc mieszka tam, gdzie reszta konfiguracji. Odczyty gita
   * (`gitReadEnv` w `git-status.ts`) dokładają do tej bazy własne stałe i nie sięgają po
   * `process.env` w ogóle.
   */
  readonly gitEnvBase: Readonly<Record<string, string>>;
  /**
   * Najniższy build natywnej apki, który serwer obsługuje (`RAROG_MIN_CLIENT_BUILD`) —
   * jedzie w ramce `hello` jako `minClientBuild`.
   * Without a minimum app build (`RAROG_MIN_CLIENT_BUILD`, or the package default from server/src/config/clients.ts)
   * there is no threshold and no field in `hello`.
   * To bramka zgodności klienta natywnego, nie granica uprawnień; tryb efektywny `main` kanału zgód wymaga jej
   * jednak (stara apka ogłasza zgodę po samym HTTP 200), więc bez progu konfiguracja `main` daje `shadow`.
   */
  readonly minClientBuild?: number;
  /**
   * Kanał APNs apki natywnej — obecny tylko przy KOMPLECIE `RAROG_APNS_*` i pliku klucza,
   * który przeszedł kontrolę (prawa 600/400, klucz EC P-256). Treść klucza zostaje w configu
   * także przy `RAROG_PUSH=0`: lista `redact()` ({@link logSecrets}) ma ją znać, bo to ona jest
   * ryzykiem, nie wysyłka. Kto ma klucz, może WYSYŁAĆ pushe na nasze urządzenia (nie czytać).
   */
  readonly apns?: ApnsConfig;
  /**
   * Dlaczego kanału APNs NIE MA, jednym zdaniem do logu startu — albo brak, gdy zmiennych nie ma
   * wcale albo kanał powstał. Nigdy błąd startu: Rarog bez pushy z apki ma działać dalej.
   */
  readonly apnsIssue?: string;
  /**
   * Przekaźnik push (`RAROG_PUSH_RELAY_URL`) — origin `https`, pod który serwer zamawia przepustki i wysyła
   * wpisy z przepustką. Brak = dzisiejsza droga: wszystko kluczem na Macu, przepustki w rejestrze leżą martwe
   * (to jest powrót). Origin to nie sekret; przepustki są w `apns-devices.json`, nigdy w configu.
   */
  readonly pushRelay?: PushRelayConfig;
  /** Dlaczego przekaźnika NIE MA mimo ustawionej zmiennej, jednym zdaniem do logu startu. Nigdy błąd startu. */
  readonly pushRelayIssue?: string;
}

/** Błąd konfiguracji (definicja w `config-env.ts`, bo rzuca go też odczyt zmiennej). */
export { ConfigError };

// ---------------------------------------------------------------------------
// Kanał APNs apki natywnej — nazwy zmiennych w `config-env.ts`
// ---------------------------------------------------------------------------

/**
 * Komplet APNs albo powód, dla którego go nie ma. Nigdy `ConfigError`: zły klucz do
 * powiadomień nie ma prawa zabrać serwera — kanał po prostu nie powstaje, a log startu mówi czemu.
 *
 * Plik klucza musi mieć prawa `600` albo `400` (jak klucz ASC w `ios-lib.sh`) i być kluczem
 * EC P-256: klucz czytelny dla innych kont na Macu to klucz, którego nie używamy. Komunikaty
 * nie powtarzają ścieżki ani treści.
 */
export function parseApns(
  env: NodeJS.ProcessEnv, readKey: ApnsKeyReader = readApnsKeyFile,
): { readonly apns?: ApnsConfig; readonly issue?: string } {
  const values = APNS_ENV_NAMES.map((name) => readEnv(env, name)?.trim() ?? '');
  const [keyPath = '', keyId = '', teamId = '', topic = ''] = values;
  const present = values.filter((value) => value !== '').length;
  if (present === 0) return {};
  if (present < values.length) {
    const missing = APNS_ENV_NAMES.filter((_, i) => values[i] === '');
    return { issue: `missing ${missing.join(', ')} (all or none)` };
  }
  if (!APPLE_ID_RE.test(keyId)) return { issue: `${APNS_KEY_ID_ENV} is not 10 characters A-Z0-9` };
  if (!APPLE_ID_RE.test(teamId)) return { issue: `${APNS_TEAM_ID_ENV} is not 10 characters A-Z0-9` };
  if (!BUNDLE_ID_RE.test(topic)) return { issue: `${APNS_TOPIC_ENV} does not look like a bundle id` };
  const file = expandHome(keyPath, readEnv(env, 'HOME') ?? os.homedir());
  if (!path.isAbsolute(file)) return { issue: `${APNS_KEY_PATH_ENV} must be an absolute path` };
  let key: ApnsKeyFile;
  try {
    key = readKey(file);
  } catch {
    return { issue: `${APNS_KEY_PATH_ENV} does not point to a readable file` };
  }
  if (key.mode !== 0o600 && key.mode !== 0o400) {
    return { issue: `the APNs key file has mode ${key.mode.toString(8)}; set chmod 600` };
  }
  try {
    const details = createPrivateKey(key.text);
    if (details.asymmetricKeyType !== 'ec' || details.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
      return { issue: 'the APNs key file is not an EC P-256 key' };
    }
  } catch {
    return { issue: 'the APNs key file is not a PEM private key' };
  }
  return { apns: { privateKey: key.text, keyId, teamId, topic } };
}

/**
 * Sekrety wymazywane z KAŻDEGO logowanego wyjątku routera (`redact()`).
 *
 * Klucz Soniox, klucz OpenAI agenta głosowego, klucz serwera iroh, kod recenzenta (tryb recenzji demo)
 * i klucze prywatne kanałów powiadomień —
 * niezależnie od tego, czy kanał jest włączony: wyciszony Rarog (`RAROG_PUSH=0`) dalej ma klucz w configu,
 * a to on jest ryzykiem. Klucz APNs wchodzi w całości i linia po linii (treść PEM bywa cytowana fragmentami).
 * JWT APNs na tej liście nie ma i mieć nie może — zmienia się co 50 min — więc moduł APNs nie
 * loguje niczego poza kodem i powodem odpowiedzi. To samo dotyczy przepustek przekaźnika: powstają
 * w biegu i żyją w `apns-devices.json`, więc `relay-sender.ts` i `relay-pass.ts` nie piszą ich nigdzie (test).
 */
export function logSecrets(config: RarogConfig): readonly string[] {
  const pemLines = (config.apns?.privateKey ?? '').split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('-----'));
  const irohKey = config.iroh?.key ?? undefined;
  return [
    config.sonioxApiKey, config.openaiApiKey, config.apns?.privateKey, ...pemLines, irohKey, config.demoReview?.code,
  ]
    .filter((value): value is string => value !== undefined && value !== '');
}

/**
 * Zmienne zerowane w środowisku nowego panelu — DWIE różne klasy, jedna lista.
 *
 * Panel dziedziczy środowisko po serwerze herdr, a serwer po tym, kto go uruchomił. Jeśli
 * kiedykolwiek wystartował Z WNĘTRZA sesji Claude Code, cała rodzina `CLAUDE_CODE_*` jedzie
 * dalej do każdego panelu, który Rarog założy.
 *
 * 1. **Transkrypt.** Przy odziedziczonym `CLAUDE_CODE_CHILD_SESSION` panel wstaje
 *    z „Transcript saving is off” (docs `errors.md`, „Transcript saving is off because of an
 *    inherited CLAUDE_CODE_CHILD_SESSION marker”), plik jsonl nie powstaje
 *    i Rarog nie ma z czego pokazać ANI JEDNEJ wiadomości. `CLAUDECODE` docs (`env-vars.md`)
 *    opisują jako znacznik podprocesu, a `CLAUDE_CODE_ENTRYPOINT` w docs nie występuje; oba
 *    zerujemy z ostrożności, razem z resztą znaczników sesji-rodzica.
 * 2. **Zgody.** `CLAUDE_CODE_MESSAGING_SOCKET` + `CLAUDE_CODE_MESSAGING_TOKEN` to według docs
 *    gniazdo i token skrzynki wiadomości, które każda sesja eksportuje sama (`env-vars.md`;
 *    `cross-session-messaging.md`, „The session's inbox socket”). Panel
 *    Raroga nie ma nieść cudzych: zgoda w terminalu jest jedyną bramką Raroga (`docs/security-model.md`,
 *    „The only real boundary is Rarog's credential”), więc obie zmienne zerujemy z ostrożności.
 *
 * `CLAUDE_CODE_OAUTH_TOKEN` is cleared too: a pane runs an interactive `claude` of the same user, which signs in
 * with the `/login` credentials (the macOS Keychain), and a token in env OVERRIDES that sign-in with an old token
 * from the shell secrets file the herdr server inherited (measured: sessions from Rarog billed the API despite
 * a subscription `/login`).
 *
 * Lista jest nadpisywalna przez `RAROG_CLAUDE_ENV_CLEAR`, bo to jedyne miejsce, które trzeba
 * będzie poprawić, gdy `claude` doda kolejną zmienną.
 */
export const DEFAULT_CLAUDE_ENV_CLEAR: readonly string[] = [
  'CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_EXECPATH', 'CLAUDE_PID', 'CLAUDE_TMPDIR', 'CLAUDE_EFFORT',
  /*
   * Klucze API Anthropica: panel założony przez Raroga ma bić WYŁĄCZNIE
   * w subskrypcję. Env serwera herdr niesie te klucze z pliku sekretów powłoki (zmierzone), a CC po
   * jednorazowym zatwierdzeniu „use this API key?" zaczyna nimi płacić za tokeny po cichu.
   * Wyzerowane w panelu = ta pomyłka jest fizycznie niemożliwa dla sesji z Raroga.
   *
   * UWAGA (zmierzone): zerowanie działa tylko do
   * chwili startu powłoki. Interaktywny zsh panelu wykonuje `~/.zshrc`, a ten
   * wczytuje plik sekretów powłoki — i NADPISUJE wyzerowane zmienne pełnymi wartościami, zanim
   * wystartuje `claude`. Dopóki ten plik eksportuje te klucze bezwarunkowo, ta lista
   * jest dla nich bezsilna; wymagany jest strażnik po stronie pliku sekretów (eksport tylko
   * w powłokach nieinteraktywnych). Zerowanie zostaje: chroni przed dziedziczeniem z env
   * serwera herdr i dokumentuje intencję.
   */
  'ANTHROPIC_API_KEY', 'ANTHROPIC_ADMIN_KEY', 'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
];

/**
 * Zmienne USTAWIANE w środowisku nowego panelu — jedyna rzecz, którą Rarog do env dokłada,
 * a nie zeruje. Nie ma tu sekretów ani niczego, co zmienia zachowanie `claude`; to są
 * bezpieczniki dla POWŁOKI, w którą herdr wpisze `claude --session-id …`.
 *
 * `DISABLE_AUTO_UPDATE=true` gasi prompt aktualizacji oh-my-zsh (`[oh-my-zsh] Would you like
 * to update? [Y/n]`). **Zmierzone:** prompt wyszedł w świeżym panelu
 * Raroga, herdr uznał go za gotową powłokę (`agent_pane_busy` puścił po dwóch próbach)
 * i wpisał komendę — litera `c` poszła jako odpowiedź na pytanie o update, reszta do
 * powłoki: `zsh: command not found: laude`. Claude nie wystartował, herdr nigdy nie zobaczył
 * agenta, po 10 s `agent.get` oddał `agent_not_found` i karta dostała „Agent `claude`
 * zniknął zaraz po starcie" — bez powodu, bo `agent.read` bez agenta nie czyta ekranu.
 * Zmienna jest honorowana przez `tools/check_for_upgrade.sh` OMZ, dopóki `~/.zshrc` nie
 * ustawia `zstyle ':omz:update' mode` wprost (wtedy decyduje zstyle — i to jest właściwe
 * miejsce, żeby wyłączyć prompt także dla paneli zakładanych ręcznie).
 *
 * Reguła doboru: trafia tu WYŁĄCZNIE to, co przeszkadza powłoce przyjąć komendę. Zmienne
 * sterujące samym `claude` idą przez argv (`herdr/argv.ts`, zamknięta lista), nigdy tędy.
 */
export const PANE_SHELL_ENV: Readonly<Record<string, string>> = Object.freeze({
  DISABLE_AUTO_UPDATE: 'true',
});

/*
 * Stałe integracji herdr są w KODZIE, a nie w env, świadomie: to są bezpieczniki, a nie
 * pokrętła. Wartość w zmiennej środowiskowej robi z nich „konfigurację bezpieczeństwa",
 * czyli coś, co da się wyłączyć w pliku plist o trzeciej w nocy, żeby coś zadziałało.
 *
 * To jest JEDYNE miejsce, w którym te liczby są zapisane. Moduły `herdr/*` je stąd importują
 * i re-eksportują pod tymi samymi nazwami: two sources of a safety limit are a limit one typo can split.
 */

/** Pełny resync `agent.list` — źródło prawdy, push tylko go wyprzedza. */
export const HERDR_RESYNC_MS = 30_000;

/**
 * Minimum interval between commands that drive ONE pane in the background (`/model`, the mode cycle).
 *
 * Prompts skip it (`spaced: false`) and count only toward the hourly cap: the session's send queue in the manager
 * (`#takeSendTurn`, also while attachments are written) keeps them in order, and the driver's step queue keeps
 * them from gluing (the second prompt waits until the first is in the pane). A prompt still records its time, so
 * `/model` right after a prompt waits out the interval.
 */
export const HERDR_SEND_MIN_INTERVAL_MS = 1_000;

/**
 * Cap on sends in a one-hour window, counting ALL herdr sessions together.
 *
 * Generous on purpose: it guards against a loop in the code (a retry that calls itself), not against a person.
 * Several sessions driven from the phone at once, with quick follow-up prompts, stay well below 240 an hour, and
 * a cap that can block the user in the middle of work would be a stability regression.
 */
export const HERDR_SEND_HOURLY_CAP = 240;

/**
 * Karencja po wysyłce, w której ignorujemy `idle`/`done`.
 *
 * Detekcja herdr jest EKRANOWA: przez chwilę po `agent.prompt` panel nadal wygląda na
 * bezczynny, więc bez karencji sesja wracałaby na moment do „skończone” — karta skakałaby
 * między sekcjami dokładnie w tej sekundzie, w której użytkownik patrzy na telefon.
 * `working` i `blocked` przepuszczamy: one nie kłamią.
 */
export const HERDR_IDLE_GRACE_MS = 3_000;

/**
 * Jak długo `working` musi SIĘ UTRZYMAĆ, zanim uznamy, że panel naprawdę ruszył.
 *
 * Agent główny w trakcie workflow drga: rozstawia subagentów, przez moment jest `working`,
 * po czym wraca do czekania (`done`). Without a grace period Rarog would catch these flashes and paint the card
 * green with the timer reset, so the pane would look "still working" while herdr, a second later, shows "done".
 *
 * Karencja jest po stronie WEJŚCIA w pracę, nie wyjścia z niej, i to jest cała jej sensowność:
 * opóźnienie sygnału „gotowe" kosztowałoby przy każdej turze, a to jedyny sygnał, na który
 * człowiek z telefonem czeka. Opóźnienie „pracuje" nie kosztuje nic — wysyłka z Raroga i tak
 * ustawia stan optymistycznie, a tura wywołana przy biurku niczego nie obiecywała.
 *
 * Półtorej sekundy: dłużej niż drgnięcie, krócej niż cokolwiek, co człowiek zdąży zauważyć.
 */
export const HERDR_WORKING_GRACE_MS = 1_500;

/** Minimalny odstęp odpytywania gita dla JEDNEJ sesji herdr (17 paneli × co tool-call = burza). */
export const HERDR_GIT_MIN_INTERVAL_MS = 30_000;

/**
 * How many bytes of the jsonl tail are read as history on attach.
 *
 * 1 MB, so the session history reaches back far enough to scroll. With 17 panes that is still ≤17 MB read once at
 * start, and the message window cuts deeper than bytes anyway.
 */
export const HERDR_HISTORY_BYTES = 1024 * 1024;

/**
 * Sufit JEDNEGO odczytu przyrostu transkryptu w trakcie pracy; większa luka = przeskok do końca.
 *
 * 1 MB → 16 MiB: do tej daty sufitem był `HERDR_HISTORY_BYTES`, a jeden wynik `Read`
 * ze zrzutem ekranu (1,35 MB) wpadał do pliku jednym zapisem. Follower przeskakiwał go, zgubiony
 * `tool_result` zostawiał `Read` „czekający" do końca tury i każda zgoda tej tury kończyła się
 * kartą bez przycisków. Pomiar transkryptów z 14 dni: najdłuższa linia 5,4 MB. Przeskok zostaje
 * dla prawdziwej luki (Rarog spał, plik urósł o dziesiątki MB) i zeruje stan liczony parami
 * (`docs/dialogs.md`).
 */
export const FOLLOW_MAX_READ_BYTES = 16 * 1024 * 1024;

/**
 * Ile wiadomości maksymalnie oddaje porcja historii (60 → 200 → 500, razem z sufitem RAM
 * sesji; wprost tą samą stałą).
 */
export const HERDR_HISTORY_MESSAGES = MAX_TRANSCRIPT_MESSAGES;

/** Ile paneli podpinamy naraz (17 równoległych odczytów historii to skok latencji pierwszej listy). */
export const HERDR_ATTACH_CONCURRENCY = 4;

/** Po ilu ms plik w `<cwd>/.rarog-uploads/` idzie do kosza (sweep przy zapisie i przy starcie). */
export const HERDR_UPLOAD_TTL_MS = 48 * 3600 * 1000;

/*
 * Stałe kanału TWORZENIA. Ta sama zasada co wyżej: bezpieczniki w kodzie, nie w env.
 */

/**
 * `agent.start` → `interactive_ready`. Gotowość herdr wyprowadza z EKRANU (reguła
 * `live_prompt_box`: znak `❯` w ramce promptu), nie z hooka — zmierzone z wyłączonymi
 * hookami: 3 s. Ciepły start to 2–5 s, ale zimny (wtyczki, aktualizacja marketplace'ów, Mac pod
 * obciążeniem — tego dnia sama powłoka panelu potrzebowała 7 s zamiast 0,5 s) przekraczał 20 s
 * i Rarog ogłaszał śmierć ŻYWEGO panelu, podsuwając „Zamknij". Sześćdziesiąt sekund to zapas
 * na taki start; timeout dalej NIE sprząta panelu (launcher, kroki 7–8).
 */
export const HERDR_LAUNCH_READY_TIMEOUT_MS = 60_000;

/** Odstęp odpytywania `agent.get` w oczekiwaniu na gotowość (0,2 ms na wywołanie). */
export const HERDR_LAUNCH_POLL_MS = 250;

/**
 * Ile czekamy na PROMPT POWŁOKI w świeżo utworzonym panelu, zanim uznamy `agent.start`
 * za nieudany.
 *
 * `herdr agent start` wymaga panelu „at an interactive shell prompt" i odpowiada
 * `agent_pane_busy`, dopóki powłoka go nie narysuje — zsh z motywem potrzebuje na to kilkuset
 * milisekund po `tab.create`. Zmierzone na żywo: bez tego okna ten sam kod raz startował
 * natychmiast, a raz wywracał całą sesję i zostawiał po sobie pusty panel.
 */
export const HERDR_LAUNCH_SHELL_WAIT_MS = 5_000;

/** Jedna nowa sesja na 5 s — throttle łapie pętlę w kodzie, nie człowieka. */
export const HERDR_LAUNCH_MIN_INTERVAL_MS = 5_000;

/** Sufit zakładania paneli w oknie godzinnym. */
export const HERDR_LAUNCH_HOURLY_CAP = 40;

/** Brak pliku jsonl po tym czasie (i po nieudanym globie) = błąd GŁOŚNY. */
export const HERDR_TRANSCRIPT_GRACE_MS = 15_000;

/**
 * Karencja ZNIKNIĘCIA agenta po dialogu zaufania katalogu.
 *
 * Po zatwierdzeniu zaufania `claude` RE-EKSEKUUJE się w tym samym panelu: przez moment nie ma
 * go w `agent.list`, a nadzorca ogłaszał wtedy `gone` i zamykał kartę sesji, która sekundę
 * później wracała (zmierzone jako `done` + `stale` bez odzyskania). W tym oknie brak agenta
 * znaczy „wstaje", a nie „zniknął" — czekamy na powrót TEGO SAMEGO panelu.
 *
 * 15 s to zapas rzędu wielkości: re-eksekucja trwa ułamek sekundy, a resync leci co 30 s.
 * Panel, który po tym czasie nie wrócił, zniknął naprawdę.
 */
export const HERDR_TRUST_REEXEC_GRACE_MS = 15_000;

/** jsonl i detekcja herdr rozjeżdżają się o ~0,5 s — karta zgody czeka na oba źródła. */
export const HERDR_PENDING_DEBOUNCE_MS = 800;

/** Jeden ponowny `agent.read` przed spadkiem karty na fail-closed. */
export const HERDR_PENDING_RETRY_MS = 500;

/**
 * Sufit czekania karty zgody z ekranu albo jsonl (bez przycisku zgody, tryb kanału `main` albo `all`) na kartę kanału
 * zgód, liczony od przyjęcia rejestracji hooka tej sesji, która karty kanału jeszcze nie ma. Pomiar
 * (n = 10): od startu hooka do karty kanału mediana 614 ms, maksimum 1501 ms przy obserwacji co takt rejestru; 3 s
 * pokrywa takt (1,5 s), sufit `ps` i zapas, a dialog bez karty kanału dostaje kartę z ekranu najpóźniej po tym czasie.
 */
export const HERDR_CONSENT_CARD_WAIT_MS = 3_000;

/**
 * Termin ważności ZRZUTU EKRANU stojącego dialogu.
 *
 * Ekran czytany przy wejściu w `blocked` był cache'owany na CAŁĄ blokadę — założenie „dialog
 * się nie zmienia, dopóki herdr mówi `blocked`" jest fałszywe i to był główny powód, dla
 * którego karta w Rarogu potrafiła opisywać CO INNEGO niż terminal:
 * formularz `AskUserQuestion` przełącza pytania W MIEJSCU, a zgoda zatwierdzona przy biurku
 * potrafi ustąpić następnej bez ani jednej klatki `working`. Cache zostaje — ale na tyle
 * krótko, żeby dzielił odczyt między `#reportBlocked` a najbliższą oceną, i ani chwili dłużej.
 */
export const HERDR_SCREEN_CACHE_MS = 1_000;

/**
 * Co ile Rarog ponownie ocenia STOJĄCY dialog.
 *
 * Bez tego zegara jedynym wyzwalaczem ponownej oceny była ZMIANA statusu herdr — a dialog
 * podmieniony w miejscu jej nie wywołuje. Cztery sekundy to kompromis: człowiek zdąży
 * zobaczyć nowe pytanie, zanim zdąży się zdziwić, a jeden `agent.read` (0,2 ms) na cztery
 * sekundy dotyczy WYŁĄCZNIE paneli, które naprawdę na coś czekają — reszta nie pyta wcale.
 */
export const HERDR_BLOCKED_POLL_MS = 4_000;

/**
 * Po tym czasie odczyt trybu ze stopki jest NIEŚWIEŻY (bramka wysyłki).
 *
 * Wpisy `permission-mode` w jsonl powstają dopiero PO turze, więc `shift+tab` naciśnięty przy
 * biurku między turami nie jest w nich widoczny — jedynym świeżym źródłem jest stopka ekranu.
 */
export const HERDR_MODE_FRESH_MS = 15_000;

/**
 * `wait.timeout_ms` w `agent.prompt` dla ZWYKŁYCH promptów.
 *
 * Tyle herdr czeka, aż panel wejdzie w `working` — brak przejścia w tym oknie to stall,
 * czyli „tekst wpisany, Enter nie zarejestrował się w TUI" (wiadomość wisi
 * w composerze, a Rarog pokazuje „pracuje").
 *
 * MUSI być wyraźnie mniejsze od `REQUEST_TIMEOUT_MS` gniazda (5 000 w `socket.ts`) — inaczej
 * timeout socketu ubiegnie odpowiedź herdr i zamiast stalla dostaniemy błąd transportu.
 * UWAGA (docs herdr, zmierzone): własny próg stalla herdr to 5 000 ms — timeout
 * krótszy niż próg wraca jako kod `timeout` (komunikat „timed out waiting for agent status"),
 * NIE `agent_prompt_stalled`. Mapowanie po treści w `mapRemoteError` sprowadza oba kształty
 * do `HerdrStalledError`, więc krótszy timeout jest tu świadomym wyborem, nie błędem.
 *
 * Sama NAZWA `timeout` pochodzi z dokumentacji herdr, nie z pomiaru: jedyny zrzut z żywego
 * serwera (0.8.2) widział kod inny i nieudokumentowany, dlatego dopasowanie idzie
 * po treści. Na herdr 0.9.0 nie mierzone; podniesienie tej stałej do ≥ 5 000 ms (z per-call
 * `timeoutMs` gniazda ponad 5 s) ma sens dopiero po pomiarze stalli i kodu tego timeoutu.
 */
export const HERDR_PROMPT_WAIT_MS = 3_000;

/**
 * `timeout_ms` for `agent.start`: on herdr 0.9.0 it is the LIFETIME OF THE START RECORD, not a response time.
 *
 * Measured on herdr 0.9.0 and CLI 2.1.266: `agent.start` answers in < 1 ms, and the wait for readiness is on the
 * client side (`agent.get`: `launch_pending: true` → `interactive_ready: true`). When `claude` does not report its
 * prompt within `timeout_ms`, herdr DROPS the record and detects the agent on its own, without `name` and without
 * `interactive_ready` for good. With a shorter window a cold start (the `claude` process after 9 s, the prompt later)
 * ends exactly so, and the launcher waits for a flag that cannot come and after 60 s shows "not ready" for a live
 * pane. So the start window EQUALS the wait window {@link HERDR_LAUNCH_READY_TIMEOUT_MS}: while the launcher waits,
 * herdr keeps the record. The net for the rest (a herdr that drops the record anyway) is the "expired record" branch
 * in `waitReady`. herdr's ceiling for this field: 300 000.
 *
 * Without the parameter the socket's global 5 s ceiling holds, a start under load comes back as a TRANSPORT timeout
 * and the launcher closes the tab of a live agent; hence the second constant below.
 */
export const HERDR_START_WAIT_MS = HERDR_LAUNCH_READY_TIMEOUT_MS;

/**
 * Sufit gniazda dla JEDNEGO wywołania `agent.start` (per-call, `HerdrRequestOptions`).
 *
 * Trzyma nierówność `wait < sufit gniazda`: gdyby jakaś wersja herdr czekała z odpowiedzią do
 * `timeout_ms` (0.8.2 tak robiła), to herdr ma rozstrzygnąć start, a nie zegar transportu — „nie
 * wiem, co się stało" (tab zostaje sierotą do resyncu) ma być stanem rzadkim. Pod 0.9.0 odpowiedź
 * i tak wraca od razu, więc ten sufit nie wydłuża niczego.
 */
export const HERDR_START_REQUEST_TIMEOUT_MS = HERDR_LAUNCH_READY_TIMEOUT_MS + 5_000;

/**
 * Ile wpis `degrade` czeka na wiersze panelu z herdr (`pane.list`) — budżet DRIVERA, liczony
 * od chwili odmowy, łącznie z kolejką slotów gniazda. Po nim wpis i zrzut idą bez wierszy, dokładnie
 * raz; spóźniony wynik przepada. Samo żądanie ma zwykły sufit transportu (`REQUEST_TIMEOUT_MS`):
 * krótszy sufit gniazda oznaczałby herdr jako niedostępny (status gniazda, `canLaunch`) z powodu
 * diagnostyki. Karta na odczyt nie czeka nigdy.
 */
export const HERDR_PANE_ROWS_WAIT_MS = 500;

/**
 * Odstęp między `agent_prompt_stalled` a decyzją o ponowieniu.
 *
 * Domyka wyścig „tura właśnie ruszyła, tylko jeszcze nie zostawiła śladu": po tym oknie driver
 * sprawdza znaki życia (status, jsonl) drugi raz i dopiero cisza + potwierdzenie ekranem
 * uruchamiają `esc esc` + ponowny prompt. Za krótki odstęp = ryzyko podwójnej wysyłki.
 */
export const HERDR_STALL_SETTLE_MS = 1_200;

/**
 * Watchdog tury po wysyłce: po tym czasie „wysłane, a panel nie ruszył" jest już faktem.
 *
 * Siatka bezpieczeństwa pod stall-guardem (fałszywy sukces `wait`, zgubiony push statusu):
 * bez niej sesja zostaje w optymistycznym `running` bez końca, bo `idle` → `idle` nie emituje
 * żadnego zdarzenia (zmierzone: „pracuje 7 min" nad pustym panelem). Wyraźnie
 * dłuższy niż cały przebieg stall-guardu (~8 s), krótszy niż resync (30 s).
 */
export const HERDR_TURN_WATCHDOG_MS = 15_000;

/**
 * Wycina z env serwera dokładnie {@link TERM_ENV_PASSTHROUGH} — nic więcej.
 *
 * Wartości puste wypadają: `TMPDIR=""` z `env -i` znaczy „nie ma zmiennej", a nie
 * „zmienna o pustej wartości".
 */
export function parseTermEnvBase(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of TERM_ENV_PASSTHROUGH) {
    const value = readEnv(env, name);
    if (value !== undefined && value !== '') out[name] = value;
  }
  return out;
}

/** Cuts {@link PR_STATUS_ENV_PASSTHROUGH} from the server environment; empty values drop out. */
export function parsePrStatusEnvBase(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of PR_STATUS_ENV_PASSTHROUGH) {
    const value = readEnv(env, name);
    if (value !== undefined && value !== '') out[name] = value;
  }
  return out;
}

/** Cuts {@link COMPANION_ENV_PASSTHROUGH} from the server environment; empty values drop out. */
export function parseCompanionEnvBase(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of COMPANION_ENV_PASSTHROUGH) {
    const value = readEnv(env, name);
    if (value !== undefined && value !== '') out[name] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Procesy `git` (status/log/diff) — ta sama zamknięta lista co przy PTY
// ---------------------------------------------------------------------------

/**
 * Wycina z env serwera {@link GIT_ENV_PASSTHROUGH} plus wszystko o prefiksie
 * {@link GIT_ENV_PREFIX} — nic więcej.
 *
 * Wartości puste wypadają, dokładnie jak w {@link parseTermEnvBase}: `LANG=""` z `env -i`
 * znaczy „nie ma zmiennej", a nie „zmienna o pustej wartości".
 */
export function parseGitEnvBase(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of GIT_ENV_PASSTHROUGH) {
    const value = readEnv(env, name);
    if (value !== undefined && value !== '') out[name] = value;
  }
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith(GIT_ENV_PREFIX)) continue;
    if (value !== undefined && value !== '') out[name] = value;
  }
  return out;
}

/**
 * Kanał zgody hooka; brak wartości = `all` (domyślny tryb paczki). Dozwolone wyłącznie tryby
 * z {@link HOOK_CHANNEL_MODES} (`off`, `shadow`, `main`, `all`): każda inna wartość zatrzymuje start, zamiast cicho
 * wrócić do domyślnej. `main` i `all` są trybami skonfigurowanymi, nie obietnicą: tryb efektywny liczy
 * `layer1/mode.ts`.
 * An install without the hook or without a minimum app build (`RAROG_MIN_CLIENT_BUILD`, or the package default from
 * server/src/config/clients.ts) runs as `shadow` with the reason.
 */
export function parseConsentChannel(raw: string | undefined): HookChannelMode {
  const value = raw?.trim() ?? '';
  if (value === '') return HOOK_CHANNEL_MODE_ALL;
  const mode = HOOK_CHANNEL_MODES.find((known) => known === value);
  if (mode === undefined) {
    throw new ConfigError(
      `${CONSENT_CHANNEL_ENV} must be one of: ${HOOK_CHANNEL_MODES.join(', ')} (got: ${value}).`,
    );
  }
  return mode;
}

/**
 * Reguła dowodu kanału zgód; brak wartości = `channel`. Dozwolone wyłącznie {@link CONSENT_PROOF_RULES} (`channel`,
 * `screen`): każda inna wartość zatrzymuje start, zamiast cicho wrócić do domyślnej.
 */
export function parseConsentProof(raw: string | undefined): ConsentProofRule {
  const value = raw?.trim() ?? '';
  if (value === '') return 'channel';
  const rule = CONSENT_PROOF_RULES.find((known) => known === value);
  if (rule === undefined) {
    throw new ConfigError(`${CONSENT_PROOF_ENV} must be one of: ${CONSENT_PROOF_RULES.join(', ')} (got: ${value}).`);
  }
  return rule;
}

/**
 * The "always" option of consent channel cards; no value = `on`. Only `on` and `off`: any other value stops the start
 * instead of falling back to the default.
 */
export function parseConsentAlways(raw: string | undefined): boolean {
  const value = raw?.trim() ?? '';
  if (value === '' || value === 'on') return true;
  if (value === 'off') return false;
  throw new ConfigError(`${CONSENT_ALWAYS_ENV} must be one of: on, off (got: ${value}).`);
}

/**
 * Flaga warstwy 2 dialogów; brak wartości albo `0` = wyłączona, `1` = włączona. Każda inna wartość zatrzymuje start,
 * jak przy kanale zgody: literówka nie ma prawa cicho zostawić serwera w innym trybie, niż chciał właściciel.
 */
export function parseDialogLayer2(raw: string | undefined): boolean {
  const value = raw?.trim() ?? '';
  if (value === '' || value === '0') return false;
  if (value === '1') return true;
  throw new ConfigError(`${DIALOG_LAYER2_ENV} takes 1 or 0 (got: ${value}).`);
}

/**
 * The folder gate flag: missing or empty = the platform decides (on on macOS, where the consent windows are), `1` = on,
 * `0` = off; any other value stops the start, so a typo never leaves the server in another mode than the owner meant.
 */
export function parseFolderGate(raw: string | undefined, platform: NodeJS.Platform): boolean {
  const value = raw?.trim() ?? '';
  if (value === '') return platform === 'darwin';
  if (value === '1') return true;
  if (value === '0') return false;
  throw new ConfigError(`${FOLDER_GATE_ENV} takes 1 or 0 (got: ${value}).`);
}

/** Strażnik wysokości dialogu; brak wartości = WŁĄCZONY, `0`/`false` wyłącza. */
export function parseTallDialogGuard(raw: string | undefined): boolean {
  if (raw === undefined || raw.trim() === '') return true;
  return !(raw === '0' || raw === 'false');
}

/** Lista zmiennych do wyzerowania w panelu; brak wartości = {@link DEFAULT_CLAUDE_ENV_CLEAR}. */
export function parseClaudeEnvClear(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw.trim() === '') return DEFAULT_CLAUDE_ENV_CLEAR;
  const names = raw.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '');
  // Pusta lista PO podaniu wartości jest znacząca („nie zeruj nic") i nie wpada na default:
  // inaczej nie dałoby się wyłączyć tego zachowania bez zmiany kodu.
  return names;
}

/**
 * Katalog danych: jawne `RAROG_DATA_DIR` wygrywa zawsze, demo bez niego dostaje katalog w tmp, a reszta idzie
 * regułą `resolveDataDir` (`shared/src/data-dir.mjs`) — tą samą, którą liczą hook,
 * CLI i skrypty. Konflikt katalogów to `ConfigError` rzucony w `loadConfig`, czyli zanim `index.ts` zapisze
 * cokolwiek (`roots.json`, żniwiarze, `devices.json`): start na złym katalogu założyłby nowy `serverId`
 * i zerwał parowanie wszystkich urządzeń. `HOME` z przekazanego env, jak przy kluczu APNs.
 */
function dataDirOf(demo: boolean, env: NodeJS.ProcessEnv): string {
  const explicit = readEnv(env, 'RAROG_DATA_DIR');
  if (demo && (explicit === undefined || explicit === '')) return path.join(os.tmpdir(), 'rarog-demo');
  const home = readEnv(env, 'HOME');
  const result = resolveDataDir({ env, home: home !== undefined && home !== '' ? home : os.homedir() });
  if (!result.ok) throw new ConfigError(dataDirConflictMessage(result));
  return result.dir;
}

/** Epoka uwierzytelnienia, gdy zmienna epoki nie jest ustawiona (albo jest pusta). */
export const DEFAULT_AUTH_EPOCH = '1';

/**
 * Strażnik epoki: epoka z wartości domyślnej, a {@link DEVICES_FILENAME} (albo jego `.bak`, tak jak przy
 * starcie magazynu) ma aktywne urządzenia z jawną inną epoką = {@link ConfigError} z komendą naprawy. Start w tym
 * stanie zamieniłby wszystkie urządzenia w nagrobki (zgubiona zmienna epoki przy przenosinach `config.json`); błąd
 * pada przed utworzeniem magazynu, więc nic nie jest zapisane.
 * Celowa zmiana epoki ustawia nową wartość jawnie i strażnika nie budzi.
 */
function assertDefaultEpochFits(dataDir: string): void {
  const foreign = [...new Set(activeDeviceEpochs(dataDir).filter((epoch) => epoch !== DEFAULT_AUTH_EPOCH))].sort();
  if (foreign.length === 0) return;
  throw new ConfigError(`the auth epoch is not set (default ${DEFAULT_AUTH_EPOCH}), and`
    + ` ${path.join(dataDir, DEVICES_FILENAME)} has active devices with epoch ${foreign.join(', ')}; the start would`
    + ` revoke them all. Set the device epoch in config.json: "env": {"RAROG_AUTH_EPOCH": "${foreign[0] ?? ''}"}`
    + ' (for a deliberate epoch change, set the new value explicitly).');
}

/**
 * Buduje konfigurację z env. `mode` (install mode, default: this install) only picks the package default of the
 * minimum app build (`config/clients.ts`).
 *
 * @throws {ConfigError} gdy ktoś próbuje zmienić host/port, katalog danych jest w konflikcie albo epoka
 *   domyślna odpięłaby aktywne urządzenia (strażnik epoki).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, mode: InstallMode = INSTALL_MODE): RarogConfig {
  const demo = demoEnabled(readEnv(env, 'RAROG_DEMO'));
  const demoReview = parseDemoReview(readEnv(env, DEMO_REVIEW_CODE_ENV), demo, readEnv(env, 'RAROG_DATA_DIR'));
  const demoLang = parseDemoLang(readEnv(env, DEMO_LANG_ENV), demoReview !== null);
  const demoSet = parseDemoContent(
    readEnv(env, DEMO_CONTENT_ENV), { demo, review: demoReview !== null, lang: demoLang },
  );

  // Host nie jest konfigurowalny; jawne RAROG_HOST akceptujemy tylko, gdy równe loopbackowi,
  // żeby literówka w plist nie wystawiła serwera na świat po cichu.
  const requestedHost = readEnv(env, 'RAROG_HOST');
  if (requestedHost !== undefined && requestedHost !== '') {
    assertLoopbackHost(requestedHost);
  }

  const epochRaw = readEnv(env, 'RAROG_AUTH_EPOCH');
  const epoch = epochRaw !== undefined && epochRaw !== '' ? epochRaw : DEFAULT_AUTH_EPOCH;

  const dataDir = dataDirOf(demo, env);
  /*
   * Demo nie czyta dysku; poza nim epoka domyślna nie może po cichu odpiąć urządzeń z jawnej innej epoki.
   * Tryb recenzji trzyma urządzenia na trwałym katalogu, więc zgubiona epoka odpięłaby recenzentów tak samo.
   */
  if ((!demo || demoReview !== null) && epoch !== epochRaw) assertDefaultEpochFits(dataDir);

  const projectRoots = parseProjectRoots(readEnv(env, PROJECT_ROOTS_ENV));

  const sonioxApiKey = readEnv(env, SONIOX_API_KEY_ENV)?.trim() ?? '';
  const sonioxApiHost = readEnv(env, SONIOX_API_HOST_ENV)?.trim() ?? '';
  const openaiApiKey = readEnv(env, OPENAI_API_KEY_ENV)?.trim() ?? '';
  // Demo nie czyta pliku klucza APNs: tryb pokazowy nie pushuje nigdy (niżej) i nie dotyka dysku.
  const apnsParse = demo ? {} : parseApns(env);
  // Demo nie zna przekaźnika z tego samego powodu: nie pushuje.
  const relayParse = demo ? {} : parsePushRelay(readEnv(env, PUSH_RELAY_URL_ENV));
  const minClientBuild = minClientBuildOf(readEnv(env, MIN_CLIENT_BUILD_ENV), { demo, mode })?.value;
  const port = parsePort(readEnv(env, 'RAROG_PORT'));
  const iroh = parseIroh(
    readEnv(env, IROH_ENV), readEnv(env, IROH_KEY_ENV), readEnv(env, IROH_RELAY_ENV), readEnv(env, IROH_PORT_ENV),
    demo,
  );
  const origins = parseOrigins(readEnv(env, 'RAROG_ORIGINS'), demo, port, iroh !== null);
  const originAllowList = origins.allowed;
  // The review demo keeps refusing anything but one bare https origin, a skipped entry included.
  if (demoReview !== null) assertDemoReviewOrigins([...origins.allowed, ...origins.skipped]);

  const config: RarogConfig = {
    demo,
    demoReview,
    demoLang,
    demoSet,
    epoch,
    port,
    host: RAROG_HOST,
    dataDir,
    originAllowList,
    iroh,
    version: RAROG_VERSION,
    maxBodyBytes: MAX_BODY_BYTES,
    projectRoots,
    maxPanes: parseMaxPanes(readEnv(env, MAX_PANES_ENV)),
    yoloRoots: parseYoloRoots(readEnv(env, YOLO_ROOTS_ENV)),
    /*
     * Ścieżka gniazda jest walidowana ZAWSZE (poza demo, które gniazda nie tyka): integracja
     * przestała być opcją, więc literówka w `RAROG_HERDR_SOCKET` nie jest już „wyłączoną
     * zmienną", tylko konfiguracją, przy której Rarog nie zobaczy ani jednej sesji.
     */
    herdrSocket: demo ? defaultHerdrSocket() : parseHerdrSocket(readEnv(env, HERDR_SOCKET_ENV)),
    herdrRoots: parseHerdrRoots(readEnv(env, HERDR_ROOTS_ENV), projectRoots),
    herdrSend: parseHerdrSend(readEnv(env, HERDR_SEND_ENV)),
    herdrLaunch: parseHerdrLaunch(readEnv(env, HERDR_LAUNCH_ENV)),
    herdrSeenFocus: parseHerdrSeenFocus(readEnv(env, HERDR_SEEN_FOCUS_ENV)),
    herdrTabLabels: parseHerdrTabLabels(readEnv(env, HERDR_TAB_LABELS_ENV)),
    claudeEnvClear: parseClaudeEnvClear(readEnv(env, CLAUDE_ENV_CLEAR_ENV)),
    // Brak klucza NIE jest błędem konfiguracji: Rarog wstaje bez dyktowania i mówi o tym
    // wprost, zamiast wywracać start z powodu funkcji, której nikt jeszcze nie włączył. Tryb recenzji nie ma
    // dyktowania serwera: klucz Soniox operatora nie służy recenzentowi.
    voiceEnabled: demoReview === null && parseVoiceEnabled(readEnv(env, VOICE_ENV)) && sonioxApiKey !== '',
    /*
     * Powiadomienia są wyłączone w demo BEZWARUNKOWO. Tryb pokazowy zasiewa sesje w stanach
     * `waiting-permission` i `error`, więc bez tej bramki uruchomienie demo z kluczami w env
     * wysłałoby na telefon serię banerów o sesjach, które nie istnieją.
     */
    pushEnabled: !demo && parsePushEnabled(readEnv(env, PUSH_ENV))
      && (apnsParse.apns !== undefined || relayParse.relay !== undefined),
    pushE2e: parsePushE2e(readEnv(env, PUSH_E2E_ENV)),
    /*
     * Zrzuty odmów wyłączone w demo BEZWARUNKOWO: tryb pokazowy nie dotyka dysku, a zrzut
     * jest plikiem z treścią ekranu — dokładnie tym, czego demo nie ma prawa zapisać.
     */
    refusalDumps: !demo && parseRefusalDumps(readEnv(env, REFUSAL_DUMPS_ENV)),
    /*
     * Notatki działają też w demo, ale w PAMIĘCI PROCESU (`demo/notes.ts` — testy UI
     * apki natywnej): tryb pokazowy dalej nie dotyka dysku, a notatka poza demo jest plikiem BEZ
     * retencji, jedyną trwałą treścią, jaką Rarog zapisuje z ręki człowieka. `RAROG_NOTES=0` gasi
     * je w obu trybach.
     */
    notesEnabled: parseNotesEnabled(readEnv(env, NOTES_ENV)),
    /*
     * Wiersz Codexa wyłączony w demo BEZWARUNKOWO: tryb pokazowy zasiewa własne sesje i nie
     * rozmawia z żywym herdr, więc wpis, który bierze się WYŁĄCZNIE z `agent.list`, nie miałby
     * skąd powstać. Jawne `false` zamiast „i tak nie zadziała" — demo ma być opisane, nie
     * przypadkowe.
     */
    codexStatusEnabled: !demo && parseCodexStatusEnabled(readEnv(env, CODEX_STATUS_ENV)),
    /*
     * Rejestr CLI wyłączony w demo BEZWARUNKOWO: tryb pokazowy nie czyta rejestru procesów Maca
     * (czytnika wydań w demo nie ma wcale), a jego sesje są fikcyjne.
     */
    cliWaiting: !demo && parseCliWaiting(readEnv(env, CLI_WAITING_ENV)),
    // W demo działa jak poza nim: tam pole niesie mock (zgodny z `demoDiff`), nie odczyt gita.
    gitFileDetails: parseGitFileDetails(readEnv(env, GIT_FILE_DETAILS_ENV)),
    // Wyłączone w demo BEZWARUNKOWO, jak rejestr CLI: tryb pokazowy nie czyta magazynu CLI na
    // Macu, a jego sesje są fikcyjne i nie mają plików subagentów.
    agentFiles: !demo && parseAgentFiles(readEnv(env, AGENT_FILES_ENV)),
    // Demo jedzie na mocku bez pliku rozmowy — echo odroczone nie ma tam czego podstawić.
    queueEcho: !demo && parseQueueEcho(readEnv(env, QUEUE_ECHO_ENV)),
    // Demo pisze `roots.json` do własnego `dataDir` w tmp, którego hook nigdy nie czyta — flaga
    // działa tam tak samo, bez skutku.
    tallDialogGuard: parseTallDialogGuard(readEnv(env, TALL_DIALOG_GUARD_ENV)),
    // W demo bez skutku: mock nie ma pliku rozmowy ani followera.
    promptBlock: parsePromptBlock(readEnv(env, PROMPT_BLOCK_ENV)),
    // Demo nie ma hooka ani rejestru CLI: kanał zgody zawsze `off`, także bez wpisu (domyślne `all` go nie dotyczy),
    // a wartość z env nie jest tam czytana.
    consentChannel: demo ? HOOK_CHANNEL_MODE_OFF : parseConsentChannel(readEnv(env, CONSENT_CHANNEL_ENV)),
    // W demo bez skutku (kanał `off`), ale zła wartość zatrzymuje start tak samo.
    consentProof: parseConsentProof(readEnv(env, CONSENT_PROOF_ENV)),
    consentAlways: parseConsentAlways(readEnv(env, CONSENT_ALWAYS_ENV)),
    // No effect in demo (no `alive.json`), but a wrong value stops the start there too.
    consentRestartGraceMs: parseConsentRestartGrace(readEnv(env, CONSENT_RESTART_GRACE_ENV)),
    // W demo bez skutku (mock nie ma drivera herdr), ale zła wartość zatrzymuje start tak samo.
    dialogLayer2: parseDialogLayer2(readEnv(env, DIALOG_LAYER2_ENV)),
    // Off in demo unconditionally: the demo reads nothing of the host's folders; a wrong value stops the start there.
    folderGate: parseFolderGate(readEnv(env, FOLDER_GATE_ENV), process.platform) && !demo,
    sseGzip: parseSseGzip(readEnv(env, SSE_GZIP_ENV)),
    // Off in demo unconditionally; a wrong value still stops the start there.
    companionEnabled: parseCompanionEnabled(readEnv(env, COMPANION_ENV)) && !demo,
    companionSessionsEnabled: parseCompanionSessionsEnabled(readEnv(env, COMPANION_SESSIONS_ENV)) && !demo,
    companionEnvBase: parseCompanionEnvBase(env),
    // A wrong name stops the start also in demo mode, like the flag.
    companionModel: parseCompanionModel(readEnv(env, COMPANION_MODEL_ENV)),
    // On in demo too: the demo has its own fixed source (`bootstrap/pr-status.ts`); a wrong value stops the start.
    prStatusEnabled: parsePrStatusEnabled(readEnv(env, PR_STATUS_ENV)),
    inboxEnabled: parseInboxEnabled(readEnv(env, INBOX_ENV)),
    filesEnabled: parseFilesEnabled(readEnv(env, FILES_ENV)),
    filesMaxBytes: parseFilesMaxBytes(readEnv(env, FILES_MAX_MB_ENV)),
    prStatusEnvBase: parsePrStatusEnvBase(env),
    /*
     * Terminal jest wyłączony w demo BEZWARUNKOWO: demo nie dotyka dysku ani procesów
     * (ścieżki seedów nie istnieją), a pełna powłoka jest dokładnie tą władzą, której tryb
     * pokazowy nie ma prawa mieć nawet przez pomyłkę w env.
     */
    termEnabled: !demo && parseTermEnabled(readEnv(env, TERM_ENV)),
    termMax: parseTermMax(readEnv(env, TERM_MAX_ENV)),
    termIdleDays: parseTermIdleDays(readEnv(env, TERM_IDLE_DAYS_ENV)),
    herdrBin: parseHerdrBin(readEnv(env, HERDR_BIN_ENV)),
    termEnvBase: parseTermEnvBase(env),
    gitEnvBase: parseGitEnvBase(env),
  };

  // Pola opcjonalne dokładamy tylko, gdy env je niesie — `undefined` byłoby nieodróżnialne
  // od ustawionej, ale pustej wartości.
  return {
    ...config,
    ...(sonioxApiKey !== '' ? { sonioxApiKey } : {}),
    ...(sonioxApiHost !== '' ? { sonioxApiHost } : {}),
    ...(openaiApiKey !== '' ? { openaiApiKey } : {}),
    ...(minClientBuild !== undefined ? { minClientBuild } : {}),
    ...(apnsParse.apns !== undefined ? { apns: apnsParse.apns } : {}),
    ...(apnsParse.issue !== undefined ? { apnsIssue: apnsParse.issue } : {}),
    ...(relayParse.relay !== undefined ? { pushRelay: relayParse.relay } : {}),
    ...(relayParse.issue !== undefined ? { pushRelayIssue: relayParse.issue } : {}),
    ...(origins.skipped.length > 0 ? { originsSkipped: origins.skipped } : {}),
  };
}
