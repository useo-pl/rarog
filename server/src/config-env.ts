/**
 * Rejestr zmiennych środowiska serwera — JEDNA definicja każdej nazwy, którą serwer czyta.
 * `config.ts` czyta środowisko wyłącznie przez {@link readEnv}, którego typ przyjmuje tylko nazwy stąd,
 * więc nazwa spoza rejestru nie przejdzie typechecku. Listy przepustek do procesów potomnych (powłoka terminala,
 * `git`, `claude agents`, `tailscale`) też stoją tutaj i biorą nazwy z rejestru.
 *
 * Każda nazwa ma rodzaj ({@link ServerEnvKind}). Strażnik `server/test/env-registry.test.ts`
 * pilnuje równości w obie strony: każdy wpis jest czytany przez serwer i serwer nie czyta niczego spoza rejestru.
 * Jedyna grupa nazw poza mapą to prefiks {@link GIT_ENV_PREFIX} (zmienne gita przepuszczane hurtem).
 *
 * Czego tu nie ma i być nie może: kluczy VAPID ani sekretu innego kanału push. APNs credentials stored under other
 * names reach the server only after a start script maps them to Rarog's APNs variables; the server reads no other
 * names.
 */
import { DATA_DIR_ENV, XDG_DATA_HOME_ENV } from '@rarog/shared/data-dir';

/**
 * Rodzaj zmiennej:
 * - `secret` — wartość tajna: nigdy w pliku konfiguracji ani w argv, w wydrukach maskowana;
 * - `process` — tylko ze środowiska procesu, nigdy z pliku: katalog danych liczą też hook i CLI, każdy ze swojego
 *   środowiska, więc wartość z pliku rozjechałaby serwer z hookiem;
 * - `passthrough` — zmienna systemowa: serwer ją czyta albo podaje dalej procesom potomnym z list niżej;
 * - `plain` — konfiguracja Raroga.
 */
export type ServerEnvKind = 'secret' | 'process' | 'passthrough' | 'plain';

// ---------------------------------------------------------------------------
// Korzenie projektów
// ---------------------------------------------------------------------------

/** Nazwa zmiennej środowiskowej z listą korzeni (rozdzielaną przecinkami). */
export const PROJECT_ROOTS_ENV = 'RAROG_PROJECT_ROOTS';

/** Nazwa zmiennej środowiskowej z listą katalogów, w których wolno odpalić `bypassPermissions`. */
export const YOLO_ROOTS_ENV = 'RAROG_YOLO_ROOTS';

// ---------------------------------------------------------------------------
// Integracja herdr — jedyne źródło sesji
// ---------------------------------------------------------------------------

/** Ścieżka gniazda herdr. */
export const HERDR_SOCKET_ENV = 'RAROG_HERDR_SOCKET';

/** Korzenie katalogów, których panele Rarog pokazuje w pełni (transkrypt + wysyłka). */
export const HERDR_ROOTS_ENV = 'RAROG_HERDR_ROOTS';

/** Killswitch kanału ZAPISU do istniejących paneli (`0` = „widzę, nie ruszam"). */
export const HERDR_SEND_ENV = 'RAROG_HERDR_SEND';

/** Killswitch kanału TWORZENIA paneli (`1` = „wolno zakładać"). Domyślnie WYŁĄCZONY. */
export const HERDR_LAUNCH_ENV = 'RAROG_HERDR_LAUNCH';

/**
 * Czy „obejrzałem na telefonie" gasi też `done` w herdr (`0` = nie rusza).
 *
 * Nie jest killswitchem władzy — patrz `herdrSeenFocus` w `RarogConfig`.
 */
export const HERDR_SEEN_FOCUS_ENV = 'RAROG_HERDR_SEEN_FOCUS';

/**
 * Czy Rarog nazywa taby w herdr po założeniu (`0` = nie przemianowuje niczego).
 *
 * Nie jest killswitchem władzy — patrz `herdrTabLabels` w `RarogConfig`.
 */
export const HERDR_TAB_LABELS_ENV = 'RAROG_HERDR_TAB_LABELS';

/** Sufit żywych paneli Raroga. */
export const MAX_PANES_ENV = 'RAROG_MAX_PANES';

/** Zmienne środowiska zerowane w nowym panelu. */
export const CLAUDE_ENV_CLEAR_ENV = 'RAROG_CLAUDE_ENV_CLEAR';

// ---------------------------------------------------------------------------
// Killswitche i preferencje
// ---------------------------------------------------------------------------

/** Killswitch dyktowania. `0` gasi mikrofon nawet przy obecnym kluczu. */
export const VOICE_ENV = 'RAROG_VOICE';

/**
 * Killswitch NOTATEK PROJEKTU. `0` = endpointy `/api/notes` oddają 404, a klient nie
 * pokazuje notatek — dane na dysku zostają nietknięte.
 *
 * PIĄTY killswitch i pierwszy, który dotyczy TRWAŁEJ TREŚCI pisanej ręką użytkownika bez
 * retencji. Nie odbiera Rarogowi władzy nad Macem (jak trzy pierwsze) ani nie ucisza kanału
 * wychodzącego (jak `RAROG_PUSH`) — zamyka ŚCIEŻKĘ ZAPISU do jedynej powierzchni, na której
 * Rarog trzyma cudze zdania na zawsze.
 */
export const NOTES_ENV = 'RAROG_NOTES';

/**
 * Flaga WIERSZA CODEXA. `0` = panele `agent === 'codex'` nie istnieją dla Raroga.
 *
 * To NIE jest szósty killswitch i nie ma go w runbooku — dokładnie jak `RAROG_HERDR_SEEN_FOCUS`.
 * Wpis Codexa niczego nie wysyła i niczego nie czyta z ekranu, a jedyna mutacja, jaką da się
 * z niego wywołać (`agent.focus` pod „Pokaż w herdr"), podlega `RAROG_HERDR_SEND` tak samo jak
 * każda inna. Flaga wyłącza wiersz Codexa bez zmiany kodu.
 */
export const CODEX_STATUS_ENV = 'RAROG_CODEX_STATUS';

/**
 * Preferencja WYKRYCIA DIALOGU Z REJESTRU SESJI CLI. `0` = Rarog nie czyta
 * `~/.claude/sessions/<pid>.json` co 1,5 s i widzi dialog tylko wtedy, gdy herdr zgłosi
 * `blocked` (albo rezerwa formularza).
 *
 * To NIE jest szósty killswitch — dokładnie jak `RAROG_HERDR_SEEN_FOCUS` i `RAROG_CODEX_STATUS`.
 * Rejestr nie daje żadnej władzy: niczego nie zatwierdza (cyfry dalej wyłącznie z ekranu)
 * i niczego nie wysyła, a jego jedyny skutek po stronie panelu to dodatkowy `agent.read`.
 * Flaga istnieje, żeby dało się wyłączyć odczyt rejestru, gdy CLI zmieni format pliku.
 */
export const CLI_WAITING_ENV = 'RAROG_CLI_WAITING';

/**
 * Preferencja SZCZEGÓŁÓW PLIKÓW w ramce `git-status` (`fileDetails`). `0` = ramka bez pola
 * i bez trzeciego procesu gita (`diff --numstat`) — dokładnie jak przed polem.
 *
 * To NIE jest szósty killswitch — dokładnie jak `RAROG_CLI_WAITING`. Pole niczego nie wysyła
 * i niczego nie zmienia w repo: to jeden lokalny odczyt więcej z własnym budżetem czasu. Flaga
 * istnieje, żeby producenta dało się wyłączyć bez revertu, gdyby odczyt liczników kosztował
 * za dużo na kilkunastu panelach.
 */
export const GIT_FILE_DETAILS_ENV = 'RAROG_GIT_FILE_DETAILS';

/**
 * Preferencja ODCZYTU PLIKÓW ROZMÓW SUBAGENTÓW. `0` = Rarog nie otwiera
 * `<katalog sesji>/subagents/agent-<id>.jsonl`: subagent w postoju stoi na „czeka" do wznowienia
 * albo końca (nie widać, że sam ruszył), a pole `ownTasks` z jego własnymi komendami nie powstaje.
 *
 * To NIE jest szósty killswitch — dokładnie jak `RAROG_CLI_WAITING` i `RAROG_GIT_FILE_DETAILS`.
 * Czytnik nie daje żadnej władzy: niczego nie zatwierdza i niczego nie wysyła do panelu, tylko
 * czyta pliki tej samej klasy co transkrypt, z tą samą bramką zasięgu. Flaga istnieje, żeby
 * odczyt dało się wyłączyć bez revertu: gdy kosztuje za dużo na wielu agentach naraz (linia
 * `plik subagenta: pierwsze podpięcie` w `server.log`) albo gdy CLI zmieni układ tych plików.
 */
export const AGENT_FILES_ENV = 'RAROG_AGENT_FILES';

/**
 * Preferencja ECHA ODROCZONEGO. `0` = serwer ignoruje `queueAware` z ciała wysyłki: echo
 * promptu staje w transkrypcie od razu, a 202 nie niesie `queued` — apka wraca do progu 15 s.
 *
 * To NIE jest szósty killswitch — jak `RAROG_CLI_WAITING` i `RAROG_AGENT_FILES`. Flaga niczego nie
 * zatwierdza i niczego nie wysyła; istnieje, bo mechanizm stoi na nieudokumentowanym zapisie kolejki
 * CLI w pliku rozmowy: gdy CLI go zmieni (linie `queue: … flushed` w `server.log` przy zwykłej
 * pracy), wyłącza się bez revertu i bez nowego buildu apki.
 */
export const QUEUE_ECHO_ENV = 'RAROG_QUEUE_ECHO';

/**
 * Wyłącznik STRAŻNIKA WYSOKOŚCI DIALOGU. `0` = serwer nie pisze pola
 * `tallDialogGuard` do `roots.json`, więc hook treści nie odmawia formy żadnej zgodzie `Bash`
 * i wszystko idzie bez strażnika (zrzut w `pending/`, dialog na ekranie).
 *
 * To NIE jest szósty killswitch: strażnik niczego nie zatwierdza i niczego nie wysyła do panelu.
 * Jedyne, co robi, to ODMOWA formy dialogu, którego Rarog nie umie pokazać na telefonie — władzy
 * ubywa, nie przybywa (`docs/security-model.md`, hook treści). Flaga istnieje, żeby odmowy dało
 * się wyłączyć bez revertu, gdy szacunek okaże się chybiony (odmowy liczy dziennik strażnika `guard.jsonl`).
 */
export const TALL_DIALOG_GUARD_ENV = 'RAROG_TALL_DIALOG_GUARD';

/**
 * Wyłącznik ROZPOZNANIA PROMPTU ZABLOKOWANEGO PRZEZ HOOK `UserPromptSubmit`
 * (`docs/dialogs.md`, „Prompt blocked by a hook”). `0` = zachowanie bez rozpoznania w całości: follower pomija wpis
 * blokady (bez notki i bez zdarzenia), driver nie ustawia flag blokady: stall-guard czyści pole i ponawia prompt, a po
 * drugiej blokadzie kończy „prompt utknął”, jak dawniej.
 *
 * To NIE jest szósty killswitch — jak `RAROG_QUEUE_ECHO`. Rozpoznanie niczego nie zatwierdza i nie wysyła;
 * mniej klawiszy idzie do panelu, nie więcej. Flaga istnieje, bo mechanizm stoi na nieudokumentowanym polu
 * `promptSubmitEnding` pliku rozmowy: gdy CLI je zmieni, wyłącza się bez revertu i bez nowego buildu apki.
 */
export const PROMPT_BLOCK_ENV = 'RAROG_PROMPT_BLOCK';

/**
 * Kanał zgody hooka `PermissionRequest` (`docs/dialogs.md`, „Per-call dump and shadow mode”). Dozwolone `off`,
 * `shadow`, `main` i `all` (domyślnie, poza demo, gdzie zawsze `off`); każda inna wartość to błąd konfiguracji przy
 * starcie. Tryby `main` i `all` opisuje pole `consentChannel` w `config.ts`.
 *
 * `off` = zachowanie bez kanału: serwer pisze `alive.json` z `mode: "off"` (hook nie czeka) i sprząta katalogi
 * cienia, ale nie czyta zrzutów per wywołanie i nie pisze plików cienia. `shadow` = hook czeka, a przy zgodzie
 * albo odmowie z telefonu serwer PRZED klawiszem pisze plik cienia pod kluczem prośby, której dowód „dialog
 * stoi” jest prawdziwy. Hook odbiera plik i wychodzi BEZ wyniku: decyzję dalej niesie cyfra albo `escape`,
 * więc władzy nie przybywa. To NIE jest szósty killswitch.
 */
export const CONSENT_CHANNEL_ENV = 'RAROG_CONSENT_CHANNEL';

/**
 * Reguła dowodu „dialog stoi” kanału zgód: `channel` (domyślnie) albo `screen`; każda inna wartość
 * to błąd konfiguracji przy starcie. `channel` = przycisk zgody prośby wątku głównego z kanału (żywy hook i świeży
 * rejestr CLI `waiting: permission`) bez wierzchu ekranu, przy wersji CLI sesji nie wyższej niż zmierzona; `screen` =
 * dowód z wierzchu ekranu. Opis: pole `consentProof` w `config.ts`. Nie otwiera kanału i nie jest
 * killswitchem: o kanale decyduje {@link CONSENT_CHANNEL_ENV}.
 */
export const CONSENT_PROOF_ENV = 'RAROG_CONSENT_PROOF';

/**
 * The "always" option of consent channel cards: `on` (default) or `off`; any other value is a configuration
 * error at start. `on` = a card whose `permission_suggestions` are all on the closed list (`layer1/always.ts`) gets
 * the "always" button; `off` = no card has it, `allow` and `deny` unchanged. Description: field `consentAlways` in
 * `config.ts`. Opens no channel: {@link CONSENT_CHANNEL_ENV} decides that.
 */
export const CONSENT_ALWAYS_ENV = 'RAROG_CONSENT_ALWAYS';

/**
 * Restart grace G of the consent channel in whole seconds from 0 to 600, default 45; any other value is a
 * configuration error at start. With G above 0 the stop write of `alive.json` carries `stop: {ts, graceMs}` and the
 * writes of a starting server `phase: "starting"`, so a hook that starts during a restart waits up to G for the next
 * server's channel and a waiting hook pauses for it; recovery keeps the records of live hooks waiting G for their
 * second registration. `0` = neither field and no wait: such hooks exit as before. Description: field
 * `consentRestartGraceMs` in `config.ts`. Opens no channel: {@link CONSENT_CHANNEL_ENV} decides that.
 */
export const CONSENT_RESTART_GRACE_ENV = 'RAROG_CONSENT_RESTART_GRACE';

/**
 * Flaga WARSTWY 2 dialogów (`docs/dialogs.md`, „Block card without digits”): `1` = włączona, brak albo `0` = kod bez
 * warstwy 2; każda inna wartość to błąd konfiguracji przy starcie. Serwer czyta ją raz, przy starcie, i podaje
 * driverowi parametrem (`HerdrDriverDeps.dialogLayer2`): moduły dialogów środowiska nie czytają.
 *
 * Przy `1` karta ekranu bez opcji z cyframi niesie cały blok dialogu (wyższy sufit wycinka), odświeża wycinek pod
 * tą samą tożsamością karty, a wpis `block-card` dostaje pola `layer2` i `layer2Why`. Niczego nie zatwierdza i nie
 * wysyła, więc to NIE jest szósty killswitch. Flaga kanału zgody jej nie zmienia i odwrotnie.
 */
export const DIALOG_LAYER2_ENV = 'RAROG_DIALOG_LAYER2';

/**
 * Folder gate kill switch (`docs/macos-folders.md`): missing or empty = on on macOS and off elsewhere, `1` = on,
 * `0` = off; any other value is a config error at start, also in the demo, which never runs the gate. On, a disk call
 * of the work area in Desktop, Documents or Downloads (and any other guarded folder of home) runs in a helper
 * process the server can kill, so a macOS consent window waits there instead of in the server. Off = every call in
 * the server process, without helpers or the relay thread. It approves and sends nothing.
 */
export const FOLDER_GATE_ENV = 'RAROG_FOLDER_GATE';

/**
 * SSE STREAM COMPRESSION flag: missing, empty or `1` = the server gzips the stream when the client sent
 * `Accept-Encoding` with `gzip` at a weight above zero; `0` = no compression for any client; any other value is a
 * config error at startup. It approves and sends nothing, so it is NOT a sixth killswitch.
 */
export const SSE_GZIP_ENV = 'RAROG_SSE_GZIP';

/**
 * Voice agent flag (`docs/companion.md`): `1` = the route `POST /api/sessions/:id/companion/ask` answers, and
 * with the OpenAI key and the Soniox voice `GET /api/version` says `companionEnabled: true`; missing or `0` = the
 * route answers 503 `companion-disabled`; any other value is a configuration error at start. A preference, not a
 * killswitch: the route sends nothing to a pane and approves nothing; it starts `claude -p` without tools on the
 * owner's subscription. Demo mode never has it.
 */
export const COMPANION_ENV = 'RAROG_COMPANION';

/**
 * Flag of the voice agent's mode across sessions (`docs/companion.md`, "Turns route"): `1` = the route
 * `GET /api/sessions/:id/companion/turns` answers and, when the voice agent works, `GET /api/version` says
 * `companionSessions: true`; missing or `0` = the route answers 503 `companion-sessions-disabled` and the field is
 * absent; any other value is a configuration error at start. Without a working voice agent (`RAROG_COMPANION`) it
 * has no effect. A preference, not a killswitch: the route reads turns of a session in scope and sends nothing to a
 * pane. Demo mode never has it.
 */
export const COMPANION_SESSIONS_ENV = 'RAROG_COMPANION_SESSIONS';

/**
 * OpenAI Realtime model of the voice agent: the server sets it on every short-lived key
 * (`companion/openai-token.ts`); missing = `gpt-realtime-2.1`; a name outside `^gpt-realtime[a-z0-9.-]*$` stops the
 * start (`serve --check` too). `rarog voice-agent set-model` writes it in `config.json`.
 */
export const COMPANION_MODEL_ENV = 'RAROG_COMPANION_MODEL';

/**
 * The server's OpenAI key for the voice agent: from the server environment (`rarog serve`: the secrets file or
 * the service wrapper), never from the repo, never in an HTTP response. The phone gets only short-lived keys from
 * `POST /api/companion/token`. The provider's standard name, like `SONIOX_API_KEY`.
 */
export const OPENAI_API_KEY_ENV = 'OPENAI_API_KEY';

/**
 * Withdrawn names: `rarog serve` accepts them in `config.json` and `--env` with any value and drops them, so an
 * older file keeps starting; they are not in {@link SERVER_ENV}, so the server cannot read them.
 * - `RAROG_COMPANION_SPEECH`: the flag of the voice agent's Soniox voice. The voice agent speaks only with the
 *   Soniox voice, so the voice itself is the condition of `companionEnabled`.
 */
export const WITHDRAWN_ENV_NAMES: readonly string[] = ['RAROG_COMPANION_SPEECH'];

/**
 * PR status flag (`docs/pull-requests.md`): missing, empty or `1` = the server asks GitHub for the state of the PRs
 * that sessions created, with the user's `gh` login, while a client is connected (`server/src/pr-status/`); `0` = no
 * tracker and no `gh` call, the `state` field of `SessionPullRequest` never goes out; any other value is a
 * configuration error at start. An outbound channel that approves and sends nothing to a pane, so NOT a sixth
 * killswitch; `docs/security-model.md` describes the channel. Demo mode reads states from a fixed map.
 */
export const PR_STATUS_ENV = 'RAROG_PR_STATUS';

/**
 * Inbox flag (`docs/server-config.md`): missing, empty or `1` = the server keeps an Inbox card per session
 * (`server/src/inbox/`), sends its heads to a stream opened with `inbox=1`, serves `/api/inbox` and announces the
 * `inbox` capability; `0` = no card tracker, no Inbox event, no capability, and the Inbox routes answer 503;
 * `inbox.json` stays on disk untouched. Any other value is a configuration error at start. It sends nothing to a pane,
 * so NOT a killswitch.
 */
export const INBOX_ENV = 'RAROG_INBOX';

/**
 * Session files switch (`docs/server-config.md`): missing, empty or `1` = the server lists a directory of a session
 * (`GET /api/sessions/:id/files`) and announces the `files` capability; `0` = the file routes answer 404 as unknown
 * routes and the capability is absent. Any other value is a configuration error at start. It sends nothing to a pane,
 * so NOT a killswitch.
 */
export const FILES_ENV = 'RAROG_FILES';

/**
 * The largest file of a session the server sends, in whole megabytes from 1 to 1024 (`docs/server-config.md`);
 * missing or empty = 50. Every listing announces it in bytes (`maxBytes`), so the app keeps no limit of its own. Any
 * other value is a configuration error at start.
 */
export const FILES_MAX_MB_ENV = 'RAROG_FILES_MAX_MB';

// ---------------------------------------------------------------------------
// Dyktowanie i powiadomienia
// ---------------------------------------------------------------------------

/** Stały klucz Soniox — ze środowiska serwera (`rarog serve`: plik sekretów albo wrapper usługi), NIGDY z repo i nigdy w odpowiedzi HTTP. */
export const SONIOX_API_KEY_ENV = 'SONIOX_API_KEY';

/** Deklarowany host Soniox — tylko SPRAWDZANY (region UE), host REST jest pinowany w kodzie. */
export const SONIOX_API_HOST_ENV = 'SONIOX_API_HOST';

/**
 * Killswitch powiadomień. `0` ucisza Raroga nawet przy obecnym sekrecie.
 *
 * Czwarty killswitch, ale JEDYNY, który niczego nie odbiera Rarogowi — wycisza kanał
 * wychodzący. Dlatego nie ma tu odpowiednika `RAROG_HERDR_SEND`: powiadomienie z definicji
 * nie ma władzy, informuje i otwiera, nigdy nie zatwierdza.
 */
export const PUSH_ENV = 'RAROG_PUSH';

/**
 * Treść banerów szyfrowana end-to-end. `0`/`false` = żaden baner (wszystkie wpisy pominięte); brak albo inna
 * wartość = v2 dla wpisów, które go zadeklarowały. Wyłączenie: `"RAROG_PUSH_E2E": "0"`
 * w `env` pliku konfiguracji (`docs/server-config.md`, „Server environment”).
 */
export const PUSH_E2E_ENV = 'RAROG_PUSH_E2E';

/**
 * Killswitch ZRZUTÓW DIAGNOSTYCZNYCH odmów (`docs/dialogs.md`, „Refusal diagnostics”). `0` gasi zapis do
 * `<dataDir>/refusals/`.
 *
 * Domyślnie WŁĄCZONE, bo bez tekstu ekranu odmowa `no-jsonl` jest nie do wyjaśnienia
 * (panel `wK:pM`). Wyłącznik istnieje, bo zrzut niesie treść ekranu panelu —
 * to samo ryzyko, co `pending/`, i ta sama droga wyłączenia (`docs/security-model.md`).
 */
export const REFUSAL_DUMPS_ENV = 'RAROG_REFUSAL_DUMPS';

/**
 * Kanał APNs apki natywnej — cztery zmienne, komplet albo nic.
 *
 * `RAROG_APNS_KEY_PATH` i `RAROG_APNS_KEY_ID` przychodzą ze środowiska serwera (plik klucza zakłada
 * użytkownik w portalu Apple — Sandbox, team-scoped — i trzyma poza repo z `chmod 600`),
 * `RAROG_APNS_TEAM_ID` i `RAROG_APNS_TOPIC` stoją w bloku `env -i` jawnie: nie są sekretami.
 * Nazwa ze ścieżką, nie z treścią klucza — jak `RAROG_ASC_KEY_PATH` skryptów iOS.
 */
export const APNS_KEY_PATH_ENV = 'RAROG_APNS_KEY_PATH';
export const APNS_KEY_ID_ENV = 'RAROG_APNS_KEY_ID';
export const APNS_TEAM_ID_ENV = 'RAROG_APNS_TEAM_ID';
export const APNS_TOPIC_ENV = 'RAROG_APNS_TOPIC';

/** Cztery nazwy kanału APNs w kolejności parsera (`parseApns` w `config.ts`). */
export const APNS_ENV_NAMES = [APNS_KEY_PATH_ENV, APNS_KEY_ID_ENV, APNS_TEAM_ID_ENV, APNS_TOPIC_ENV] as const;

/**
 * Adres przekaźnika push. Jedna zmienna środowiska serwera: produkcja `https://push.rarog.ai` (jedno
 * środowisko). Puste = brak przekaźnika.
 */
export const PUSH_RELAY_URL_ENV = 'RAROG_PUSH_RELAY_URL';

// ---------------------------------------------------------------------------
// Terminal PTY
// ---------------------------------------------------------------------------

/** Killswitch CAŁEGO terminala PTY. Domyślnie WYŁĄCZONY — opt-in, jak `RAROG_HERDR_LAUNCH`. */
export const TERM_ENV = 'RAROG_TERM';

/** Sufit żywych PTY naraz. */
export const TERM_MAX_ENV = 'RAROG_TERM_MAX';

/** Po ilu dniach CISZY WYJŚCIA żniwiarz zabija bezczynną powłokę Raroga. */
export const TERM_IDLE_DAYS_ENV = 'RAROG_TERM_IDLE_DAYS';

/** Ścieżka binarki herdr — potrzebna WYŁĄCZNIE backendowi panelowemu terminala. */
export const HERDR_BIN_ENV = 'RAROG_HERDR_BIN';

// ---------------------------------------------------------------------------
// Zgodność klientów natywnych
// ---------------------------------------------------------------------------

/** Próg builda natywnej apki ogłaszany w `hello.minClientBuild`. */
export const MIN_CLIENT_BUILD_ENV = 'RAROG_MIN_CLIENT_BUILD';

// ---------------------------------------------------------------------------
// Nasłuch iroh
// ---------------------------------------------------------------------------

/** Flaga nasłuchu iroh: `1` = włączony, brak albo `0` = wyłączony (moduł natywny się wtedy nie ładuje). */
export const IROH_ENV = 'RAROG_IROH';

/** The iroh server's secret key, 64 hex characters: the server's identity (EndpointId); `rarog setup` generates it. */
export const IROH_KEY_ENV = 'RAROG_IROH_KEY';

/** Relay iroh w postaci kanonicznej `irohRelayUrl`; wymagany przy włączonym nasłuchu. */
export const IROH_RELAY_ENV = 'RAROG_IROH_RELAY';

/** Stały port UDP nasłuchu iroh (1–65535); brak = port od systemu. */
export const IROH_PORT_ENV = 'RAROG_IROH_PORT';

// ---------------------------------------------------------------------------
// Tryb recenzji demo (recenzja App Store)
// ---------------------------------------------------------------------------

/**
 * Kod recenzenta: stały kod parowania serwera demo dla recenzji App Store (`config.ts`, `parseDemoReview`). Sekret,
 * bo kto go zna, paruje urządzenie; wymaga `RAROG_DEMO=1`, jednego originu `https` i jawnego `RAROG_DATA_DIR`.
 */
export const DEMO_REVIEW_CODE_ENV = 'RAROG_DEMO_REVIEW_CODE';

/**
 * Język treści demo (`en` albo `pl`, brak albo pusty = `en`; `config.ts`, `parseDemoLang`). Znaczenie tylko w demo;
 * tryb recenzji wymaga `en`.
 */
export const DEMO_LANG_ENV = 'RAROG_DEMO_LANG';

/**
 * Named demo content set, a module of the set directory (`demo/content/named-set.ts`; unset or empty = the set of the
 * language; `config.ts`, `parseDemoContent`). Only in the plain English demo: the review code, `RAROG_DEMO_LANG=pl`,
 * no demo or a name without a module in this build refuse it.
 */
export const DEMO_CONTENT_ENV = 'RAROG_DEMO_CONTENT';

// ---------------------------------------------------------------------------
// Rejestr
// ---------------------------------------------------------------------------

/**
 * Każda nazwa, którą serwer czyta, z rodzajem. Nazwy bez stałej `*_ENV` (`RAROG_DEMO`, `RAROG_HOST`,
 * `RAROG_AUTH_EPOCH`, `RAROG_PORT`, `RAROG_ORIGINS` i zmienne systemowe) stoją tu dosłownie;
 * `config.ts` czyta je tym samym napisem przez {@link readEnv}, a typ pilnuje, że napis jest w rejestrze.
 */
export const SERVER_ENV = {
  // Tożsamość i sieć.
  RAROG_DEMO: 'plain',
  RAROG_HOST: 'plain',
  RAROG_PORT: 'plain',
  RAROG_ORIGINS: 'plain',
  RAROG_AUTH_EPOCH: 'plain',
  // Katalog danych: reguła `shared/src/data-dir.mjs`.
  [DATA_DIR_ENV]: 'process',
  [XDG_DATA_HOME_ENV]: 'process',
  // Korzenie i herdr.
  [PROJECT_ROOTS_ENV]: 'plain',
  [YOLO_ROOTS_ENV]: 'plain',
  [HERDR_SOCKET_ENV]: 'plain',
  [HERDR_ROOTS_ENV]: 'plain',
  [HERDR_SEND_ENV]: 'plain',
  [HERDR_LAUNCH_ENV]: 'plain',
  [HERDR_SEEN_FOCUS_ENV]: 'plain',
  [HERDR_TAB_LABELS_ENV]: 'plain',
  [MAX_PANES_ENV]: 'plain',
  [CLAUDE_ENV_CLEAR_ENV]: 'plain',
  // Killswitche i preferencje.
  [VOICE_ENV]: 'plain',
  [NOTES_ENV]: 'plain',
  [CODEX_STATUS_ENV]: 'plain',
  [CLI_WAITING_ENV]: 'plain',
  [GIT_FILE_DETAILS_ENV]: 'plain',
  [AGENT_FILES_ENV]: 'plain',
  [QUEUE_ECHO_ENV]: 'plain',
  [TALL_DIALOG_GUARD_ENV]: 'plain',
  [PROMPT_BLOCK_ENV]: 'plain',
  [CONSENT_CHANNEL_ENV]: 'plain',
  [CONSENT_PROOF_ENV]: 'plain',
  [CONSENT_ALWAYS_ENV]: 'plain',
  [CONSENT_RESTART_GRACE_ENV]: 'plain',
  [DIALOG_LAYER2_ENV]: 'plain',
  [FOLDER_GATE_ENV]: 'plain',
  [SSE_GZIP_ENV]: 'plain',
  [COMPANION_ENV]: 'plain',
  [COMPANION_SESSIONS_ENV]: 'plain',
  [COMPANION_MODEL_ENV]: 'plain',
  [PR_STATUS_ENV]: 'plain',
  [INBOX_ENV]: 'plain',
  [FILES_ENV]: 'plain',
  [FILES_MAX_MB_ENV]: 'plain',
  [OPENAI_API_KEY_ENV]: 'secret',
  // Dyktowanie i powiadomienia.
  [SONIOX_API_KEY_ENV]: 'secret',
  [SONIOX_API_HOST_ENV]: 'plain',
  [PUSH_ENV]: 'plain',
  [PUSH_E2E_ENV]: 'plain',
  [REFUSAL_DUMPS_ENV]: 'plain',
  [APNS_KEY_PATH_ENV]: 'secret',
  [APNS_KEY_ID_ENV]: 'secret',
  [APNS_TEAM_ID_ENV]: 'plain',
  [APNS_TOPIC_ENV]: 'plain',
  [PUSH_RELAY_URL_ENV]: 'plain',
  // Terminal.
  [TERM_ENV]: 'plain',
  [TERM_MAX_ENV]: 'plain',
  [TERM_IDLE_DAYS_ENV]: 'plain',
  [HERDR_BIN_ENV]: 'plain',
  // Zgodność klientów.
  [MIN_CLIENT_BUILD_ENV]: 'plain',
  // Nasłuch iroh.
  [IROH_ENV]: 'plain',
  [IROH_KEY_ENV]: 'secret',
  [IROH_RELAY_ENV]: 'plain',
  [IROH_PORT_ENV]: 'plain',
  // Tryb recenzji demo. Po kluczu iroh: kolejność sekretów to kolejność linii `secrets:` w `rarog serve --check`.
  [DEMO_REVIEW_CODE_ENV]: 'secret',
  [DEMO_LANG_ENV]: 'plain',
  [DEMO_CONTENT_ENV]: 'plain',
  // Zmienne systemowe: `HOME` czyta też `config.ts` (katalog danych, klucz APNs), `TERM` — tylko `tailnet.ts`.
  HOME: 'passthrough',
  USER: 'passthrough',
  LOGNAME: 'passthrough',
  SHELL: 'passthrough',
  LANG: 'passthrough',
  TMPDIR: 'passthrough',
  PATH: 'passthrough',
  TERM: 'passthrough',
} as const satisfies Readonly<Record<string, ServerEnvKind>>;

/** Nazwa z rejestru. */
export type ServerEnvName = keyof typeof SERVER_ENV;

/** Nazwa z rejestru rodzaju `passthrough` — tylko takie wolno wpisać na listę przepustek. */
export type ServerPassthroughName = {
  [Name in ServerEnvName]: (typeof SERVER_ENV)[Name] extends 'passthrough' ? Name : never;
}[ServerEnvName];

/** Błąd konfiguracji — osobna klasa, żeby entry mogło go odróżnić od błędów runtime (eksport także z `config.ts`). */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/** Nazwa z rejestru albo `undefined` (nazwa spoza rejestru, także nazwa z prototypu obiektu). */
export function registryNameOf(name: string): ServerEnvName | undefined {
  return Object.hasOwn(SERVER_ENV, name) ? name as ServerEnvName : undefined;
}

/**
 * Odczyt jednej zmiennej z rejestru. Jedyna droga do środowiska w `config.ts` poza hurtowym prefiksem gita
 * (`parseGitEnvBase`) i całym środowiskiem podanym regule katalogu danych (`resolveDataDir` czyta tylko
 * `RAROG_DATA_DIR` i bazę XDG, obie w rejestrze).
 */
export function readEnv(env: NodeJS.ProcessEnv, name: ServerEnvName): string | undefined {
  return env[name];
}

// ---------------------------------------------------------------------------
// Przepustki do procesów potomnych — listy zamknięte, nazwy z rejestru
// ---------------------------------------------------------------------------

/**
 * Zmienne środowiska serwera PRZEPUSZCZANE do powłoki terminala — lista zamknięta.
 *
 * Środowisko PTY budujemy OD ZERA (nigdy z całego środowiska procesu), bo proces serwera niesie
 * `SONIOX_API_KEY`, `OPENAI_API_KEY` i klucz serwera iroh. Tu jest cała lista tego, co przechodzi; resztę
 * dokłada `ptyEnv()` stałymi wartościami (`TERM`, `COLORTERM`).
 *
 * `SSH_AUTH_SOCK` does not pass: herdr starts the shell with its own env, so herdr, not Rarog, gives the agent
 * socket for a `git push` from the terminal.
 *
 * **Granica tej gwarancji jest znana i zapisana** (`docs/security-model.md`): interaktywny zsh
 * wykona `~/.zshrc`, ten wczytuje plik sekretów powłoki — i własne klucze użytkownika będą w powłoce,
 * jak w każdym jego terminalu. Gwarantujemy dokładnie jedno: sekrety RAROGA nie wyciekają
 * z procesu serwera do powłoki.
 */
export const TERM_ENV_PASSTHROUGH: readonly ServerPassthroughName[] = [
  'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TMPDIR', 'PATH',
];

/**
 * Zmienne środowiska serwera PRZEPUSZCZANE do procesów `git` — lista zamknięta.
 *
 * The `git` process never gets the whole server environment, which carries secrets (`SONIOX_API_KEY`, the iroh
 * server key). Rarog only READS git (`status`, `log`, `diff`), but the repository config (e.g. `core.fsmonitor`)
 * still runs foreign code with this env.
 *
 * `LANG` passes: a locale, not a secret. `SSH_AUTH_SOCK` does not, because local reads connect to no remote
 * repository.
 *
 * **Granica tej gwarancji jest ta sama co przy powłoce** (`docs/security-model.md`): hooki
 * repozytorium wykonują się dalej z pełnią uprawnień użytkownika i mogą sobie wczytać jego
 * własne sekrety. Gwarantujemy dokładnie jedno — sekrety RAROGA nie wychodzą z procesu
 * serwera do gita.
 */
export const GIT_ENV_PASSTHROUGH: readonly ServerPassthroughName[] = [
  'HOME', 'PATH', 'TMPDIR', 'LANG',
];

/**
 * Prefiks zmiennych przepuszczanych HURTEM (dziś nie ma w env serwera ani jednej).
 *
 * Furtka na `GIT_SSH_COMMAND` / `GIT_CONFIG_*` bez edycji kodu: dopisanie zmiennej do środowiska
 * serwera ma wystarczyć. Nazwy z tym prefiksem są własnością gita,
 * więc nie da się nim przemycić sekretu Raroga — te zaczynają się od `RAROG_`, `SONIOX_` albo `OPENAI_`.
 */
export const GIT_ENV_PREFIX = 'GIT_';

/**
 * Co ze środowiska serwera wchodzi do procesu `claude agents --json` (`live-sessions.ts`, `liveSessionsEnv`):
 * `HOME` i `PATH`, bo komenda znajduje po nich konfigurację i samą siebie, oraz `LANG` i `TMPDIR` dla porządku
 * cudzych narzędzi. Powód listy zamkniętej opisuje `liveSessionsEnv`.
 */
export const LIVE_SESSIONS_ENV_PASSTHROUGH: readonly ServerPassthroughName[] = ['HOME', 'PATH', 'LANG', 'TMPDIR'];

/**
 * Co ze środowiska serwera wchodzi do procesu `tailscale status` (`tailnet.ts`, `tailnetEnv`); `TERM` dokłada
 * `tailnetEnv` osobno, bo musi być niepusty. Powód listy zamkniętej opisuje `tailnetEnv`.
 */
export const TAILNET_ENV_PASSTHROUGH: readonly ServerPassthroughName[] = ['HOME', 'PATH', 'TMPDIR'];

/**
 * What enters the voice agent's `claude -p` process from the server environment (`companion/cli.ts`,
 * `companionEnv`): `HOME` and `PATH`, because the program finds its configuration and itself by them, `USER`,
 * because the subscription login is read from the login keychain by user name (measured on CLI 2.1.322), and `LANG`
 * and `TMPDIR` for well-behaved tools. No Rarog secret, no `ANTHROPIC_*` (an API key would replace the
 * subscription), no `CLAUDE_CODE_*` and no `HERDR_*` (the server may run inside a herdr pane).
 */
export const COMPANION_ENV_PASSTHROUGH: readonly ServerPassthroughName[] = ['HOME', 'USER', 'PATH', 'LANG', 'TMPDIR'];

/**
 * What enters the `gh` process of the PR status (`pr-status/gh.ts`, `ghEnv`) from the server environment: `HOME`,
 * `USER` and `LOGNAME`, because `gh` finds its configuration and the keychain login by them, `PATH`, and `LANG` and
 * `TMPDIR` for well-behaved tools. No Rarog secret and no `GH_TOKEN`: the token stays with `gh`.
 */
export const PR_STATUS_ENV_PASSTHROUGH: readonly ServerPassthroughName[] = [
  'HOME', 'USER', 'LOGNAME', 'LANG', 'TMPDIR', 'PATH',
];
