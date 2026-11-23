/**
 * Kontrakt manager ↔ warstwa HTTP.
 *
 * Plik jest celowo tylko interfejsem: router i SSE kodują przeciw niemu,
 * a `manager.ts` dostarcza implementację. Nie dodawać tu logiki ani importów runtime.
 *
 * Uwagi z kontraktu:
 * - wiadomości domknięte dostają `seq` z ring buffera sesji; delty mają `seq === null`,
 * - `session-changed` i `state` trafiają do scope 'global' ORAZ do scope danej sesji.
 */
import type {
  Activity,
  CommandList,
  CreateSessionResponse,
  DiffFileList,
  DiffFilePatch,
  EffortLevel,
  FileAttachment,
  HerdrStatus,
  ModelList,
  PermissionRequest,
  QuestionRequest,
  RecentProject, ResumableSession,
  ServerEvent,
  ModeCycleTarget,
  SessionDiff,
  SessionModeResponse,
  SessionModelResponse,
  SessionSummary,
  TranscriptMessage,
} from '@rarog/shared';
import type { MessageSource, QueueTakeBackResponse } from '@rarog/shared/rest';
import type { DeviceDecision, ResolveResult } from '../permissions.ts';
import type { CompanionEntry } from '../companion/catalog.ts';
import type { ConsentCardView } from '../herdr/dialogs/layer1/cards.ts';
import type { ConsentDecision } from '../herdr/dialogs/layer1/contract.ts';
import type { SeenPickUp } from './seen-marks.ts';

/**
 * Zlecenie założenia sesji = założenia PANELU w herdr.
 *
 * Pola pochodzą z `createSessionBodySchema`; `sessionId` jest jedynym, którego klient nie
 * podaje — wymusza je `resume()`, żeby wznowiona rozmowa została TĄ SAMĄ kartą (deep-link
 * z telefonu i `Last-Event-ID` mają dalej działać).
 */
export interface CreateSessionOptions {
  cwd: string;
  prompt?: string;
  permissionMode?: string;
  model?: string;
  effort?: EffortLevel;
  /**
   * Start z ultracode (flaga `--effort ultracode`): tylko `true`, z `effort` nieobecnym albo `xhigh`
   * (kontrakt). Brak pola = bez flagi, o ultracode decydują ustawienia Claude Code.
   */
  ultracode?: boolean;
  /** `--resume <uuid>` z magazynu CLI; walidowane po `cwd` z transkryptu
   * („Starting sessions from the phone: three powers” w `docs/security-model.md`). */
  resumeFrom?: string;
  /** `--fork-session`: nowy uuid, historia wczytana, jeden pisarz. Wymaga `resumeFrom`. */
  fork?: boolean;
  /** WYŁĄCZNIE dla `resume()` — klient tego pola nie ma i mieć nie będzie. */
  sessionId?: string;
}

/**
 * Wynik przyjętej wysyłki. `replayed: true` znaczy, że ten `clientMessageId` był już
 * przyjęty i NIC nie poszło do panelu drugi raz — router oddaje wtedy 202 `{…, replayed: true}`.
 */
export interface SendMessageAck {
  replayed: boolean;
  /**
   * Echo odroczone: wiadomość z tym `clientMessageId` czeka u serwera, aż CLI weźmie
   * prompt — echo przyjdzie dopiero wtedy. Router oddaje 202 `{…, queued: true}`.
   */
  queued?: true;
}

/** Opcje restartu od klienta (`POST /api/sessions/:id/restart`, ciało `restartBodySchema`). */
export interface RestartOptions {
  /** Ponowna wysyłka promptu zablokowanego przez hook — `seq` i `id` z `SessionSummary.promptBlocked`. */
  readonly resend?: { readonly seq: number; readonly id: string };
}

/** Opcje wysyłki od klienta. */
export interface SendMessageOptions {
  /**
   * Klient umie czekać na echo odroczone: ciało `queueAware: true`. Bez tego echo stoi
   * w transkrypcie od razu — stara apka po 15 s bez echa pokazałaby
   * „Nie potwierdzono”.
   */
  readonly queueAware?: boolean;
  /** Who sends (body `source`): the audit entry `prompt` of this send records it as `sender`. Absent = as today. */
  readonly source?: MessageSource | undefined;
  /**
   * The engine conversation the sender read (body `expectedConversation`), as a check of a conversation id. The manager
   * runs it after the last `await` of the send, right before the driver gets the text (`assertSendConversation` in
   * `companion-scope.ts`): another conversation is a 409 and nothing reaches the pane. Absent = no check.
   */
  readonly conversation?: ((agentSessionId: string | undefined) => boolean) | undefined;
}

export interface ManagerApi {
  list(): SessionSummary[];
  get(id: string): SessionSummary | undefined;
  /**
   * Zakłada panel w herdr i wraca NATYCHMIAST po `tab.create` (router oddaje 202).
   *
   * `prompt` jest opcjonalny — bez niego powstaje pusta sesja czekająca na pierwszą
   * wiadomość. Reszta startu (gotowość agenta, prompt startowy, ewentualny błąd) jedzie po
   * SSE: `starting → running` albo `starting → error` z powodem.
   */
  create(opts: CreateSessionOptions): Promise<CreateSessionResponse>;
  /**
   * Rzuca NotFound/BadState. `images`: data URL-e png/jpeg po walidacji limitów w routerze;
   * `files`: załączniki nieobrazkowe (nazwa + data URL) po tej samej walidacji.
   *
   * Asynchroniczne, bo PRZED przejściem stanu trzeba odczytać tryb panelu i zapisać załączniki
   * na dysk. Router czeka na wynik, żeby 400/429 wróciło jako odpowiedź na POST, a nie jako
   * wiadomość w transkrypcie.
   *
   * `clientMessageId`: najwyżej jedno przyjęcie na id w oknie 24 h. Powtórka przyjętej
   * oddaje `replayed: true` bez drugiej wysyłki, ten sam id z inną treścią rzuca konflikt
   * (`code: 'client-id-conflict'` → 409), odmowa zwalnia id do ponowienia.
   */
  sendMessage(
    id: string, text: string, images?: readonly string[], files?: readonly FileAttachment[],
    clientMessageId?: string, opts?: SendMessageOptions,
  ): Promise<SendMessageAck>;
  /**
   * Decyzja o zgodzie. Rzuca SYNCHRONICZNIE (400/409 z bramek zasięgu i uprawnień), a wynik
   * oddaje DOPIERO po driverze: `refused` (→422) znaczy „klawisz nie wyszedł, karta zostaje"
   * i niesie powód z zamkniętej listy protokołu.
   */
  /**
   * Zmiana karty kanału zgód z cyklu (warstwa 1): `permission-pending`, `permission-settled` albo
   * `permission-resolved` dla sesji tej karty. Brak metody = manager bez kanału.
   */
  applyConsentCard?(view: ConsentCardView, decision: ConsentDecision | null): void;
  /**
   * Przyjęta rejestracja hooka kanału zgód w sesji silnika (gniazdo rejestracji): świeży odczyt rejestru CLI dla tej
   * sesji poza taktem, żeby karta kanału nie czekała na takt. Brak metody = manager bez kanału.
   */
  noteConsentRegistration?(engineSessionId: string): void;
  resolvePermission(id: string, permId: string, decision: DeviceDecision,
    by: string, message?: string): Promise<ResolveResult>;
  /**
   * Odpowiedź na kartę pytania. `notes` — notatki równoległe do `answers`, wyłącznie
   * dla pytań z `notes: true`; reguły łamie 400, a notatka nigdy nie jedzie cyfrą (driver odmawia).
   */
  answerQuestion(
    id: string, qId: string, answers: string[][], notes?: readonly (string | null)[],
  ): Promise<ResolveResult>;
  /**
   * Esc do sesji. Rzuca SYNCHRONICZNIE (400 poza zasięgiem / przy `RAROG_HERDR_SEND=0`,
   * 404 dla nieznanej sesji); obietnica mówi wyłącznie o tym, czy klawisz DOSZEDŁ do silnika
   * — stan sesji przestawia się wcześniej, jeszcze przed jej rozstrzygnięciem.
   */
  interrupt(id: string): Promise<boolean>;
  /**
   * The queue take-back: the prompts waiting in the CLI queue and in the driver's own queue leave both and come back
   * in the 200 body; the turn runs on. One take-back per `operationId`: a retry gets the first result, or joins it
   * while it runs. Gates throw synchronously: unknown session or no driver 410, out of scope or closed write channel
   * or a driver without a queue 400, restart reservation 409. A driver refusal rejects: `pane` 410, the rest 409, each
   * with a `session.take-back.*` sentence.
   */
  takeBackQueue(id: string, operationId: string): Promise<QueueTakeBackResponse>;
  /**
   * Bez `closePanel` — zdjęcie karty (panel żyje dalej w terminalu; żywy wróci przy
   * resyncu — UI używa tej ścieżki tylko dla sesji `resumable`). Ta ścieżka NIE rzuca poza
   * NotFound (404) dla nieznanej sesji: nie rusza herdr.
   *
   * Z `closePanel: true` — `tab.close` KAŻDEGO panelu. BadState
   * (409) dla sesji bez panelu w herdr i przy niedostępnym gnieździe; BadRequest (400) przy
   * zamkniętym kanale zapisu. Panel, którego już nie ma (`herdr-gone`), błędem NIE jest —
   * karta znika, bo taki był zamiar tapnięcia. Każda odmowa stoi PRZED pierwszą mutacją
   * stanu sesji, więc odrzucone „×" nie gubi pending decyzji ani drivera.
   */
  close(id: string, opts?: { closePanel?: boolean }): Promise<void>;
  /**
   * Otwiera NOWY panel dla sesji, której panel zniknął — ta sama karta, ten sam `sessionId`.
   *
   * Sesja z żywym panelem rzuca BadState (409): jej proces należy do terminala i nie ma
   * czego wznawiać. Wznowienie sesji z magazynu CLI to `create({resumeFrom})`, nie ta metoda.
   */
  resume(id: string): Promise<SessionSummary>;
  /**
   * Restart ŻYWEJ, bezczynnej sesji na nowszym Claude Code: `/exit`, potwierdzenie końca
   * procesu w trzech źródłach, `--resume` tej samej rozmowy w nowym tabie, ta sama karta.
   *
   * `resend`: „Uruchom ponownie i wyślij” pod notką promptu zablokowanego przez hook — restart
   * także bez aktualizacji, a zablokowany prompt (tekst z serwera, nigdy od klienta) idzie do nowego
   * procesu RAZ, drogą promptu startowego. `seq` albo `id` inny niż w `SessionSummary.promptBlocked` = 409
   * przed rezerwacją.
   *
   * Każda odmowa (404/400/409/429) przychodzi PRZED `/exit` — obietnica rozwiązuje się dopiero
   * po wysłaniu `/exit`, a dalszy przebieg (koniec procesu, start, porażka) jedzie po SSE jako
   * stan karty. Po porażce po `/exit` karta stoi w `resumable` z powodem i „Wznów".
   */
  restart(id: string, opts?: RestartOptions): Promise<{ sessionId: string }>;
  /**
   * Sesje silnika do wznowienia w danym katalogu (read-only magazyn CLI).
   *
   * Rzuca BadRequest (400) dla `cwd` spoza allow-listy — lista transkryptów zdradza treść
   * pierwszych promptów, więc druga linia obrony katalogu stoi także tutaj (pierwsza jest
   * w routerze). AWARIA SAMEGO MAGAZYNU błędem nie jest: brak katalogu czy uprawnień to
   * pusta lista, bo magazyn należy do CLI i Rarog nie ma nad nim kontroli.
   */
  resumable(cwd: string): Promise<ResumableSession[]>;
  /**
   * Ostatnie sesje JEDNEGO projektu do wznowienia (`GET /api/resumable/recent?cwd=…`).
   *
   * Rzuca BadRequest (400) dla `cwd` spoza allow-listy — dokładnie jak `resumable()`. Wpisy
   * sesji OTWARTYCH (w herdr i poza nim) wypadają w całości: ta lista odpowiada wyłącznie na
   * pytanie „co da się podnieść", a otwarte stoją w sekcji AGENCI.
   */
  recentResumable(cwd: string, limit?: number): Promise<ResumableSession[]>;
  /**
   * Ostatnie PROJEKTY z historią sesji CLI (`GET /api/projects/recent`) —
   * katalogi z allow-listy, po czasie ostatniej sesji, najnowszy pierwszy. Nie rzuca: awaria
   * magazynu to pusta lista. Katalog spoza allow-listy albo nieistniejący WYPADA po cichu —
   * to jest lista skrótów, a nie walidacja wejścia.
   */
  recentProjects(limit?: number): Promise<RecentProject[]>;
  /**
   * Lista modeli do wyboru (`GET /api/models`) — WBUDOWANA (silnika nie ma o co zapytać).
   *
   * Jest też ALLOW-LISTĄ: router odrzuca 400 `model-unknown` każdy model spoza niej.
   * Pierwsza pozycja ma pusty `value` i znaczy „model domyślny konta" (zero flagi `--model`).
   */
  models(): ModelList;
  /**
   * Slash-komendy, które Rarog przepuści w tej sesji (`GET /api/sessions/:id/commands`) — ta sama
   * migawka katalogu, którą strażnik sprawdza wysyłkę, z tą samą `revision`.
   *
   * Rzuca NotFound (404) dla nieznanej sesji i BadRequest (400) dla panelu poza zasięgiem (także Codex)
   * albo katalogu sesji spoza `RAROG_HERDR_ROOTS`. Synchroniczne: skan dysku stoi w pamięci migawki.
   */
  commands(id: string): CommandList;
  /**
   * Zmiana modelu / effortu ŻYWEJ sesji — jedyna droga do `/model` w Rarogu.
   *
   * Zwraca OSTRZEŻENIE o skutku globalnym, a nie migawkę sesji: `/model` przestawia domyślny
   * model nowych sesji na całym koncie, a nowa wartość pojawi się w `SessionSummary`
   * dopiero po następnej turze (model czytamy z jsonl, nie z własnego optymizmu). Router
   * oddaje to jako 202 — dialog potwierdzenia w panelu obsługuje się PO odpowiedzi HTTP.
   *
   * Rzuca BadRequest (400) dla sesji bez kanału do panelu i BadState (409) w środku tury
   * albo przy stojącym dialogu.
   *
   * `ultracode` dokłada na końcu paczki komendę ultracode (`true` włącza, `false` wyłącza, tylko w tej
   * sesji). Wymaga Claude Code w procesie sesji od `ULTRACODE_MIN_CLI` (400 przy wersji starszej albo nieznanej;
   * demo bez bramki). Paczka z samym ultracode zwraca `ULTRACODE_CHANGE_NOTE`, każda inna `MODEL_CHANGE_WARNING`.
   */
  setModel(id: string, patch: { model?: string; effort?: EffortLevel | null; ultracode?: boolean })
    : Promise<SessionModelResponse>;
  /**
   * Zmiana trybu uprawnień ŻYWEJ sesji `plan` ↔ `auto` — jedyna droga do `shift+tab`.
   *
   * Te same odmowy co `setModel` (400 bez kanału / poza zasięgiem / tryb nieznany, 409 w turze
   * albo przy dialogu, 429 throttle) plus 409 dla panelu w `bypass`. 202: pętla klawisz →
   * odczyt stopki biegnie po odpowiedzi, wynik idzie chipem i zdaniem w transkrypcie.
   */
  setMode(id: string, patch: { mode: ModeCycleTarget }): Promise<SessionModeResponse>;
  /**
   * „Pokaż w herdr" (`agent.focus`) — przełącza panel na wierzch w terminalu użytkownika.
   *
   * Jedna z dwóch akcji Raroga kasujących znacznik `done` panelu. Druga to
   * {@link ManagerApi.markSeen} i różnica między nimi jest w INTENCJI: tu człowiek prosi
   * o przestawienie widoku („idę to obejrzeć na Macu"), tam widok przestawia się jako skutek
   * uboczny obejrzenia wyniku na telefonie. Obie wołane wyłącznie z gestu człowieka.
   *
   * Rzuca NotFound (404) dla nieznanej sesji; BadState (409), gdy sesja nie ma (już) panelu
   * w herdr ALBO gniazdo jest niedostępne (`agent.focus` to mutacja — bez tej bramki błąd
   * transportu wyszedłby jako 500); BadRequest (400) przy zamkniętym kanale zapisu
   * (`RAROG_HERDR_SEND=0`, nieznany protokół herdr) — `agent.focus` przestawia CUDZY
   * terminal, więc podlega temu samemu wyłącznikowi co wysyłka.
   */
  focus(id: string): Promise<void>;
  /**
   * „Obejrzałem ten wynik na telefonie" — `POST /api/sessions/:id/seen`.
   *
   * Znacznik lokalny jest trwały (przeżywa restart Raroga), a NOWSZY wynik panelu przebija go
   * sam z siebie. Dokłada się do tego `agent.focus` — jedyna dźwignia, jaką herdr daje
   * na skasowanie `done` — ale WYŁĄCZNIE dla panelu, o którym Rarog wie, że na `done` stoi,
   * i wyłącznie przy otwartym kanale zapisu. Nieudany fokus NIE jest błędem tej metody: znacznik
   * lokalny zostaje, a badge w herdr wisi dalej.
   *
   * Idempotentne i SYNCHRONICZNE (fokus leci w tle); rzuca NotFound dla nieznanej sesji,
   * a dla sesji bez panelu jest ciche (nie ma czego oznaczać).
   *
   * `pickUp`: the voice agent across sessions picks up the result it read. Same receipt and effects plus `seenBy` on
   * the card; BadState (409, `session.seen-result-changed`) with no effect unless the session is in `waiting-input`
   * with no decision card over it, at `pickUp.stateSince`, in the engine conversation `pickUp.conversation` accepts
   * (`markSeen` in `seen-marks.ts`). Without `pickUp` on a result the voice agent picked up, `seenBy` goes (a human
   * opened it) and herdr gets nothing. The route checks the flags and the scope before the call.
   */
  markSeen(id: string, pickUp?: SeenPickUp): void;
  /**
   * „Oznacz jako nieprzeczytane" z listy — `POST /api/sessions/:id/unseen`.
   *
   * Cofa odbiór STOJĄCEGO wyniku (`waiting-input` z `seen: true`): `seen` wraca do `undefined`, a znacznik
   * trwały pod bieżącym numerem stanu przeżywa restart Raroga. Tylko lokalnie — herdr nie ma metody, która
   * postawi `done` z powrotem, więc żadnej mutacji w herdr i żadnego powiadomienia. W innych stanach
   * i przy wyniku już nieodebranym nic nie robi. Idempotentne i synchroniczne; rzuca NotFound dla nieznanej
   * sesji.
   */
  markUnseen(id: string): void;
  /** `git diff HEAD` + `--numstat` dla katalogu sesji. Rzuca NotFound dla nieznanej sesji. */
  diff(id: string): Promise<SessionDiff>;
  /**
   * Lista zmienionych plików katalogu sesji (`GET …/diff/files`) — bez patcha.
   *
   * Te same bramki co `diff()`: NotFound dla nieznanej sesji, BadRequest (400) dla wpisu Codexa
   * i sesji poza zasięgiem. Gdy git nie odpowiedział, rzuca błąd z `code: 'git-failed'` (503);
   * katalog spoza repo to pusta lista, nie błąd.
   */
  diffFiles(id: string): Promise<DiffFileList>;
  /**
   * Patch JEDNEGO pliku katalogu sesji (`GET …/diff/file?path=…`).
   *
   * `path` przychodzi z żądania i jest używany wyłącznie wtedy, gdy co do znaku stoi na liście,
   * którą git wypisał w tym samym wywołaniu. Bramki jak `diffFiles()`, a do nich kody:
   * `bad-path` (400, walidacja wstępna), `diff-file-not-found` (404, pliku nie ma na liście
   * zmian), `git-failed` (503).
   */
  diffFile(id: string, path: string): Promise<DiffFilePatch>;
  /**
   * Transkrypt sesji. Domyślnie to OTWARCIE transkryptu (hub przy wejściu klienta w strumień sesji): odświeża
   * wiersz gita, a bez świeżego odczytu (throttle, demo bez gita) ponawia ostatnią ramkę `git-status` strumieniem
   * sesji. `peek: true` czyta bez tego skutku — dla obserwatora, który transkryptu nie otwiera (kontrola demo
   * odpytuje go co 100 ms, a każda ponowiona ramka to dla apki nowy stan repozytorium i odświeżenie okna diffa).
   */
  transcript(id: string, opts?: { peek?: boolean }): {
    messages: TranscriptMessage[];
    pendingPermissions: PermissionRequest[]; pendingQuestions: QuestionRequest[];
    /** Ostatnia aktywność ŻYWEJ sesji — telefon wchodzący w środku tury nie widzi pustki. */
    activity?: Activity;
  };
  eventsSince(id: string, seq: number | null)
    : { tooOld: boolean; events: { seq: number | null; event: ServerEvent }[] };
  onEvent(cb: (scope: 'global' | string, seq: number | null, ev: ServerEvent) => void): void;
  projects(): { path: string; name: string }[];
  /**
   * Stan integracji herdr do ramki `sessions-snapshot`.
   *
   * Metoda jest OPCJONALNA, bo atrapy managera w testach warstwy HTTP nie muszą jej mieć,
   * a `undefined` znaczy „integracja wyłączona" — czyli baner ma w ogóle nie istnieć.
   * Osobnego endpointu REST świadomie nie ma: iOS zrywa SSE przy każdym uśpieniu, więc
   * status musi jechać w tej samej ramce co lista sesji.
   */
  herdrStatus?(): HerdrStatus | undefined;
  /**
   * Session the voice agent may read, ask about or list in its catalog (`POST /api/sessions/:id/companion/ask`,
   * `GET /api/sessions/:id/companion/turns`, `GET /api/companion/sessions`): its directory, current engine
   * conversation and newest message in memory (`companionEntryOf`, read without side effects). The same gate as the
   * commands list (`inCommandScope` in `companion-scope.ts`): `null` for a Codex entry, a pane out of scope or a
   * session directory outside `RAROG_HERDR_ROOTS`; throws NotFound (404) for an unknown session.
   */
  companionTarget(id: string): CompanionEntry | null;
  /**
   * Listener of engine conversation changes (`/clear`, `/resume` in the pane): the voice agent kills a question about
   * the previous conversation. Called with the new `engineSessionId`; returns the function that detaches it.
   */
  onConversationChange(cb: (sessionId: string, agentSessionId: string) => void): () => void;
}
