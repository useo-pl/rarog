/**
 * Kontrakt protokołu Rarog — JEDYNE źródło prawdy współdzielone przez serwer i klienta.
 *
 * Reguła forward-compat: nieznany `type` eventu NIE jest błędem — `parseServerEvent` zwraca
 * `null`, a klient loguje i ignoruje zdarzenie. Dzięki temu starszy klient przeżyje nowszy
 * serwer bez wysypywania strumienia SSE.
 *
 * Types and schemas of separate areas live in `./protocol/`, one file per area, re-exported here, so code imports
 * the contract from `protocol.ts` (`@rarog/shared`) only. An area file does not import this file.
 */
import { z } from 'zod';
import { type SentenceRef, say, sentenceRefSchema } from './sentences/index.ts';
import { type Activity, type Delegation, activitySchema } from './protocol/activity.ts';
import { type MessageAttachment, imageDataUrlSchema, messageAttachmentSchema } from './protocol/attachments.ts';
import {
  type BackgroundTask, type SessionArtifact, type SessionPullRequest, type SessionScheduledTask,
  backgroundTaskSchema, sessionArtifactSchema, sessionPullRequestSchema, sessionScheduledTaskSchema,
} from './protocol/background.ts';
import {
  type ConsentAlwaysEntry, consentAlwaysEntrySchema, SCREEN_UNAVAILABLE_REASONS, type ScreenUnavailableReason,
} from './protocol/consent.ts';
import {
  type GitCommit, type GitFileDetail, type GitFileKinds, gitCommitSchema, gitFileDetailSchema, gitFileKindsSchema,
} from './protocol/git.ts';
import { type HerdrMode, type HerdrStatus, herdrModeSchema, herdrStatusSchema } from './protocol/herdr.ts';
import { type InboxEventOf, inboxEventSchemas } from './protocol/inbox.ts';
import { type EffortLevel, effortLevelSchema, modelIdSchema } from './protocol/model.ts';

export type { SentenceRef };

export * from './protocol/activity.ts';
export * from './protocol/attachments.ts';
export * from './protocol/background.ts';
export * from './protocol/commands.ts';
export * from './protocol/consent.ts';
export * from './protocol/dictation.ts';
export * from './protocol/diff.ts';
export * from './protocol/directories.ts';
export * from './protocol/files.ts';
export * from './protocol/git.ts';
export * from './protocol/herdr.ts';
export * from './protocol/inbox.ts';
export * from './protocol/model.ts';
export * from './protocol/notes.ts';
export * from './protocol/resume.ts';
export * from './protocol/terminal.ts';

/**
 * Wersja kontraktu SSE — rośnie wyłącznie wtedy, gdy zmiana ŁAMIE starszego klienta.
 *
 * Dodanie nowego `type` eventu tej liczby nie podbija: reguła forward-compat (nieznany `type`
 * → `null`) każe staremu klientowi zignorować ramkę, której nie rozumie. Dodanie POLA do
 * istniejącej ramki (np. `sessions-snapshot`) jest już rozmową osobną.
 *
 * `2`: decyzja o zgodzie/pytaniu może wrócić kodem **422** z powodem odmowy
 * ({@link REFUSE_REASONS}). Stary bundle mapuje każdy nieznany status na „Nie udało się
 * wysłać" i ZDEJMUJE kartę, choć dialog stoi dalej w terminalu — czyli pokazuje nieprawdę.
 * Dlatego to jest zmiana ŁAMIĄCA, a nie addytywne pole.
 *
 * `3`: echo użytkownika niesie {@link MessageAttachment} zamiast bloków
 * `image` z pełnym `dataUrl`. Stary bundle liczy podpis echa jako „tekst + LICZBA bloków
 * image", więc po tej zmianie NIGDY by go nie pogodził: każda wysyłka ze zdjęciem wisiałaby
 * jako „Nie potwierdzono. [Ponów]" i zapraszała do wysłania jej drugi raz.
 */
export const PROTOCOL_VERSION = 3;

// ---------------------------------------------------------------------------
// Typy domenowe
// ---------------------------------------------------------------------------

export type SessionState =
  | 'starting' | 'running' | 'waiting-input' | 'waiting-permission' | 'waiting-question'
  | 'limit-reached' | 'error' | 'interrupted' | 'done' | 'resumable';

export type Risk = 'normal' | 'red';

/**
 * Zużycie okna kontekstu sesji silnika — źródło widgetu `⌁ 34%` w nagłówku sesji.
 *
 * `contextLimit` jest zawsze dodatni (UI dzieli przez niego), a `contextTokens` może go
 * przekroczyć: silnik potrafi raportować stan sprzed kompakcji.
 */
export interface SessionUsage {
  contextTokens: number;
  contextLimit: number;
}

/**
 * Okno kontekstu jest ZNANE albo NIEZNANE — trzeciej możliwości nie ma.
 *
 * W jsonl nie ma limitu okna, a identyfikator modelu (`message.model`) okna nie rozstrzyga: ten sam
 * `claude-fable-5` ma domyślnie 1M, a przy `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` 200K (docs
 * `model-config.md`, „Turn off 1M context”; skan 906 transkryptów, wersja CLI nieznana: max 885 852
 * dla `claude-fable-5`). Zgadywanie „najmniejszy próg ≥ maksimum"
 * pokazywałoby sesji 1M ~92 % przy 185k, a potem skok na 18 % — czyli alarm bez powodu
 * i kompaktowanie, którego nikt nie potrzebuje. Dopóki limit nie jest POTWIERDZONY,
 * pokazujemy liczbę bezwzględną bez paska i bez procentu.
 */
export type ContextLimitState =
  | {
      kind: 'unknown';
      tokens: number;
      /**
       * DOLNA GRANICA okna: tyle tokenów ta sesja już UNIOSŁA (największa suma z transkryptu
       * albo `preTokens` którejś z jej kompakcji). Nie jest limitem i nie czyni go znanym —
       * pilnuje tylko, żeby UI nie założyło okna MNIEJSZEGO, niż plik już udowodnił.
       * Nieobecne = sesja nie pokazała jeszcze żadnej liczby.
       */
      atLeast?: number;
    }
  | {
      kind: 'known';
      tokens: number;
      limit: number;
      /**
       * `statusline` = liczba WPROST OD SILNIKA (`context_window.context_window_size` z payloadu
       * komendy `statusLine`) i dlatego bije tabelę modelu. `model` — okno z `KNOWN_CONTEXT_LIMITS`
       * (flaga Raroga albo identyfikator modelu z jsonl). `compact-boundary` serwer nie wysyła:
       * granica kompakcji limitu nie potwierdza, a wartość zostaje dla zgodności dekodera apki.
       */
      source: 'compact-boundary' | 'model' | 'statusline';
    };

export const contextLimitStateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unknown'), tokens: z.number(), atLeast: z.number().optional() }),
  z.object({
    kind: z.literal('known'),
    tokens: z.number(),
    limit: z.number(),
    source: z.enum(['compact-boundary', 'model', 'statusline']),
  }),
]);

/**
 * Okna kontekstu, które znamy na pewno — dla aliasów z flag Raroga (`fable`, `opus[1m]`, …) oraz
 * dla pełnych identyfikatorów Fable ROZWIĄZANYCH z jsonl (follower potwierdza nimi limit sesji).
 * `opus[1m]` = 1M (`contextWindow: 1000000` in `--output-format json`).
 * The bare alias `opus` = 1M (Claude Code 2.1.280): `claude --model opus` resolves to
 * `claude-opus-5-5` with `contextWindow: 1000000`, and `opus[1m]` to `claude-opus-5-5[1m]` with the
 * SAME window — Opus 5.5 has 1M without a variant, like Fable 5.1. The full id `claude-opus-5-5`
 * is in the table because a session on the account's default model (`opus`, no flag) gets its
 * window only from jsonl and without this entry would stay `unknown`.
 *
 * The model list carries only the `fable` alias, yet the full Fable ids stay in this table on
 * purpose: Rarog also reads sessions started outside it, and transcripts with these ids exist.
 * Dropping an entry would not revoke the model — it would take the known window from those
 * sessions and drop the context bar to `unknown`.
 *
 * Fable = 1M, measured on THIS account: the account has the `claude-fable-5[1m]` variant,
 * transcripts carry window sums up to 885 852, manual compactions at `preTokens` 744 448,
 * and herdr shows 14% exactly when the window sum is 148 704 (148 704 / 1M). A 200 000 limit
 * would understate the window fivefold and raise the colour alarm at a third of the session.
 *
 * Sesja bez flagi `--model` na innym modelu niż fable startuje jako `unknown`: aliasy flag
 * (`fable`/`sonnet`/`opus`/`haiku`) nigdy nie są identyfikatorem z jsonl, a wariantu `[1m]`
 * modeli spoza rodziny Fable jsonl nie odróżnia. Alias `fable` = 1M, bo obie znane wersje
 * (5 z pomiaru, 5.1 z dokumentacji) mają to samo okno.
 *
 * Fable 5.1 = 1M z dokumentacji API: 1M to dla `claude-fable-5-1` maksimum
 * I domyślne okno zarazem, więc wariantu `[1m]` ten model nie ma i czysty identyfikator
 * nie zaniża limitu tak, jak robił to `claude-fable-5` bez nawiasu.
 */
export const KNOWN_CONTEXT_LIMITS: Readonly<Record<string, number>> = {
  fable: 1_000_000, 'opus[1m]': 1_000_000, opus: 1_000_000, sonnet: 200_000, haiku: 200_000,
  'claude-fable-5': 1_000_000, 'claude-fable-5-1': 1_000_000, 'claude-opus-5-5': 1_000_000,
};

// ---------------------------------------------------------------------------
// Sesje herdr — jedyne źródło sesji
// ---------------------------------------------------------------------------

/**
 * Dialogi spoza jsonl, które Rarog ROZUMIE na tyle, żeby wystawić przyciski.
 *
 * Lista jest ZAMKNIĘTA i jest odbiciem `KNOWN_DIALOGS` z `server/src/herdr/screen.ts` — nie
 * rośnie „przy okazji". Dialog bez odpowiednika w jsonl to dokładnie ta sytuacja, w której
 * Rarog nie wie, co zatwierdza (zgoda MCP, wyjście z trybu plan), więc wszystko spoza tej
 * listy zostaje przy wycinku ekranu i „Odrzuć dialog" — bez przycisku zatwierdzania.
 */
export const KNOWN_DIALOG_IDS = ['trust', 'model'] as const;
export type KnownDialogId = (typeof KNOWN_DIALOG_IDS)[number];
export const knownDialogIdSchema = z.enum(KNOWN_DIALOG_IDS);

/**
 * Klasa dialogu, który rejestr sesji Claude Code zgłasza jako stojący.
 *
 * Serwer czyta ją z pola `waitingFor` pliku `~/.claude/sessions/<pid>.json` i tłumaczy dosłowne
 * nazwy CLI (`permission prompt`, `input needed`, `sandbox request`…) na te krótkie, własne nazwy
 * Raroga (`server/src/cli-version.ts`) — klient nazw CLI nie zna. `other` = dialog jest, tylko nie
 * wiadomo jaki. Lista stoi w protokole, bo czytają ją obie strony: serwer (czytnik, driver,
 * dziennik odmów) i klient (`SessionSummary.cliDialog`).
 */
export const CLI_DIALOG_CLASSES = [
  'permission', 'input', 'sandbox', 'worker', 'dialog', 'goal', 'other',
] as const;
export type CliDialogClass = (typeof CLI_DIALOG_CLASSES)[number];
export const cliDialogClassSchema = z.enum(CLI_DIALOG_CLASSES);

/**
 * Twardy limit tekstu wysyłanego do PANELU herdr (`agent.prompt`).
 *
 * Osobny i dużo mniejszy od limitu ciała `/messages` (120 MB), bo po drugiej stronie jest pty
 * żywego terminala użytkownika, a nie proces, którego Rarog jest właścicielem. Egzekwuje go
 * serwer, licząc BAJTY UTF-8 — `z.string().max()` liczy znaki i tego nie zastąpi.
 *
 * 512 kB, nie 16 kB: przy 16 kB Rarog odrzucał prompty, które w panelu
 * herdr wklejone z Maca przechodziły bez problemu. Zmierzone tego dnia w jednorazowym workspace
 * (herdr 0.9.0, panel `cat > plik`): 256 kB i 512 kB przez socket dochodzą do pty co do bajtu,
 * a schemat API herdr (`AgentPromptParams.text`) nie ma własnego sufitu. 512 kB to ok. 130 k
 * tokenów — więcej i tak nie zmieści się w oknie modelu jako jedna wiadomość.
 */
export const MAX_HERDR_PROMPT_BYTES = 512 * 1024;

/**
 * Ile wiadomości transkryptu trzyma się na sesję — JEDEN sufit dla czterech sit: jsonl → RAM
 * sesji na serwerze → `transcript-snapshot` → tablica `messages` w store klienta.
 *
 * Klient bez sufitu tylko dopisywałby w `upsertMessage`, więc żywa sesja czytana cały dzień
 * rosłaby bez końca (każdy render przechodzi po wszystkich wiadomościach, a bloki kodu niosą
 * setki elementów kolorowania) — a po odświeżeniu i tak wracałaby przycięta do tej liczby. Stała mieszka w shared, bo obie strony muszą mówić tym samym.
 *
 * 500 (na życzenie użytkownika). Żywy tail emituje wiadomość na KAŻDY wpis
 * asystenta, więc to tu sufit sztuk faktycznie tnie. Bajty nie tną wcześniej: na 40 ostatnich
 * plikach jsonl ostatnie 500 wiadomości ważyło najwyżej 539 kB wobec 4 MB `RING_MAX_BYTES` sesji.
 * Historia po restarcie serwera zwykle i tak nie dobija do sufitu — tnie ją `HISTORY_MAX_BYTES`.
 */
export const MAX_TRANSCRIPT_MESSAGES = 500;

export interface SessionSummary {
  id: string;              // rarogId (uuid) — klucz wszędzie; engineSessionId zostaje w serwerze
  cwd: string;
  title: string;           // basename(cwd) = człon PROJEKTU w tytule `projekt · sesja`
  /**
   * Człon SESJI w tytule `projekt · sesja`: pierwsze słowa pierwszego promptu
   * albo `session N` przy sesji założonej bez promptu. Nieobecny wyłącznie dla starszych
   * sesji — UI renderuje go zawsze, gdy jest.
   */
  label?: string;
  /**
   * Kod etykiety o treści `session N` (`session.fallback-label`). Etykieta niesie tylko tekst, więc kod
   * dostaje też prompt o tej samej treści; inna etykieta z promptu albo tytułu go nie ma.
   */
  labelRef?: SentenceRef;
  state: SessionState;
  stateDetail?: string;    // np. komunikat błędu, 'resetAt=...' — tekst dla UI
  /**
   * Kod i argumenty zdania `stateDetail`. Przy limicie planu `stateDetail` zostaje tokenem `resetAt=<ISO>`
   * (stara apka czyta go regexem), a `stateDetailRef` to `{code: 'state.limit-reached', args: [<ISO>]}`.
   */
  stateDetailRef?: SentenceRef;
  stateSince: string;      // ISO — od kiedy w bieżącym stanie (timery "czeka od")
  /**
   * ISO start of the current turn (the turn clock of the activity row): set when the session enters a turn state
   * (`starting`, `running`, `waiting-permission`, `waiting-question`) from outside one, kept through permission and
   * question inside the turn, gone when the turn ends. Absent = no turn or its start unknown: count from `stateSince`.
   */
  turnSince?: string;
  createdAt: string;
  lastActivityAt: string;
  branch?: string;
  dirtyCount?: number;
  /** Commity przed upstreamem (`# branch.ab +X`). Brak upstreamu = pole nieobecne. */
  ahead?: number;
  /** Commity za upstreamem (`# branch.ab -Y`). Brak upstreamu = pole nieobecne. */
  behind?: number;
  /**
   * Brudne pliki po rodzajach (`+3 ~5 −1`). Nieobecne, gdy driver rodzajów nie zna (albo serwer
   * jest starszy niż front) — wtedy UI pokazuje sam licznik `dirtyCount` („3 pliki").
   */
  fileKinds?: GitFileKinds;
  /** Ostatni commit (`git log -1`). Brak = repo bez commitów albo odczyt się nie udał. */
  lastCommit?: GitCommit;
  /** Zużycie okna kontekstu; nieobecne, dopóki silnik nie zaraportuje pierwszego resulta. */
  usage?: SessionUsage;
  /**
   * Zużycie kontekstu Z INFORMACJĄ, czy limit okna jest w ogóle znany.
   *
   * Zastępuje parę `contextTokens`/`contextLimit` w miejscu, gdzie UI liczy PASEK: `usage`
   * zostaje bez zmian, bo to liczba tokenów tury, a nie okno. Nieobecne = brak odczytu z jsonl.
   */
  context?: ContextLimitState;
  lastSummary?: string;    // 1 zdanie ostatniego resulta (dla done na liście)
  /**
   * Model silnika: identyfikator ROZWIĄZANY przez silnik (`system/init.model`,
   * np. `claude-fable-5`), a nie alias z formularza. Nieobecny, dopóki silnik nie wstał
   * i rejestr nic nie pamięta.
   */
  model?: string;
  /**
   * Effort zażądany przez użytkownika. Nieobecny = domyślny silnika (UI pokazuje „auto").
   * Silnik może po cichu obniżyć effort dla modelu, który go nie wspiera — pokazujemy to, co
   * zażądano, bo tylko to wiemy na pewno.
   */
  effort?: EffortLevel;
  /**
   * Ultracode tej sesji CLI: osobne ustawienie, nie poziom effortu (`effort` mówi o poziomie). Żądane do
   * pierwszego dowodu, potem znaczniki z jsonl bieżącego procesu CLI; brak = nie wiemy (ustawienia Claude Code mogą
   * je włączyć bez wiedzy Raroga).
   */
  ultracode?: boolean;
  /**
   * Agenta w panelu uruchomił Rarog: nazwa agenta `rarog-<6 hex>` z herdr ∪ klucze
   * agentów założonych przez bieżący proces serwera. Steruje chipem na karcie; z tego samego
   * źródła serwer liczy sufit paneli. Brak pola czyta się jak `false` — dlatego OPCJONALNE.
   */
  launchedByRarog?: boolean;
  /** Adres panelu w herdr (`w9:p72`) — deep-link „Pokaż w herdr" i diagnostyka. NIGDY nie klucz. */
  paneId?: string;
  /**
   * The result of the CURRENT turn was received. Absent = the turn runs or the result WAITS; `false` = herdr confirms
   * a standing `done` badge (also waiting, and it allows the `agent.focus` that clears the badge); `true` = received (a
   * tap in the client, the voice agent's pick-up, or a focus of the herdr pane AFTER the turn).
   * Not a MIRROR of the herdr status (`idle` → `true`): with a mirror the result of a turn started on a pane focused on
   * the Mac would never reach the top of the list. `seen: true` moves a card off the top into its project group.
   */
  seen?: boolean;
  /** The human marked the result of the current turn unread by hand; present only while `seen` is not `true`. */
  markedUnseen?: true;
  /** The voice agent picked up the result, not a human; present only with `seen: true`, until a human opens it. */
  seenBy?: 'voice-agent';
  /**
   * Źródło prawdy o tej sesji jest chwilowo nieosiągalne (padł socket herdr).
   *
   * Stan sesji zostaje OSTATNI ZNANY — UI wygasza kartę i pokazuje baner. To nigdy nie jest
   * przejście stanu: silnik w panelu żyje dalej, to Rarog stracił kontakt.
   */
  stale?: boolean;
  /** Tryb uprawnień panelu. Chip na karcie i w nagłówku sesji. */
  herdrMode?: HerdrMode;
  /**
   * Dialog spoza jsonl ROZPOZNANY z zamkniętej listy sygnatur (`docs/security-model.md`, „Buttons only for dialogs Rarog UNDERSTANDS”).
   *
   * Sens pola jest wyłącznie taki: „Rarog wie, co stoi w panelu, więc wolno mu wystawić
   * przycisk zatwierdzania". Obecne tylko razem z `state === 'waiting-permission'` i tylko
   * dla dialogu, który NIE ma odpowiednika w jsonl (te mają pełną kartę zgody z `permId`).
   * BRAK pola = dialog nierozpoznany = wycinek ekranu i sam „Odrzuć dialog" — i to jest
   * bezpieczny wariant domyślny, także dla starszego serwera.
   */
  herdrDialog?: KnownDialogId;
  /**
   * DLACZEGO Rarog nie złożył karty z przyciskami — powód z tej samej zamkniętej listy,
   * którą liczy dziennik odmów (`REFUSE_REASONS`).
   *
   * Pole jest ADDYTYWNE i czysto informacyjne: o przyciskach decyduje wyłącznie
   * `herdrDialog`. Sens jest taki, że karta fallbacku ma powiedzieć „wielokrotny wybór
   * zrób w terminalu" zamiast jednego zdania na wszystkie przyczyny (`REFUSE_MESSAGES`).
   * Ustawia je ta sama ocena, która woła `auditRefusal`; znika razem z kartą.
   */
  herdrDialogReason?: RefuseReason;
  /**
   * CO WIDAĆ w panelu — ostatnie linie ekranu dialogu, bez ANSI, przycięte przez `snippet()`.
   *
   * Ta sama treść nie jedzie WIADOMOŚCIĄ SYSTEMOWĄ do transkryptu, bo tam zostawałaby na zawsze
   * — przy stojącym dialogu kilkanaście bloków w pół sekundy — a karta fallbacku nie pokazywałaby
   * z dialogu NICZEGO. Treść należy do karty, żyje tak długo jak ona i znika razem z nią (dokładnie jak `herdrDialogReason`).
   *
   * Pole jest ADDYTYWNE i czysto informacyjne — o przyciskach decyduje wyłącznie
   * `herdrDialog`. Niesie je tylko karta BEZ przycisków (fallback i karta zdegradowana).
   */
  herdrDialogScreen?: string;
  /**
   * JAKI dialog stoi w terminalu według rejestru sesji Claude Code — klasa, nie treść.
   *
   * Niesie je WYŁĄCZNIE karta bez decyzji (dialog nierozpoznany i karta zdegradowana) i tylko
   * wtedy, gdy rejestr mówi `waiting`: karta z przyciskami ma własną, pełną treść. Pole
   * ADDYTYWNE i czysto informacyjne, jak `herdrDialogReason` — o przyciskach decyduje
   * `herdrDialog`, cyfry jadą wyłącznie z ekranu. Ustawia je ta sama ocena drivera, która
   * stawia kartę, i znika razem z nią. Polszczyzna klas mieszka w kliencie.
   */
  cliDialog?: CliDialogClass;
  /**
   * Panel spoza `RAROG_HERDR_ROOTS`: widać stan i projekt, nie ma transkryptu ani wysyłki.
   * Karta istnieje świadomie — panel, który działa i nie jest pokazany, to UI, które kłamie.
   */
  outOfScope?: boolean;
  /**
   * Silnik panelu — pole obecne WYŁĄCZNIE dla Codexa.
   *
   * Brak pola znaczy „Claude", dokładnie tak jak brak `backgroundTasks` znaczy „nic nie leci":
   * pole ADDYTYWNE, `PROTOCOL_VERSION` bez zmian, a stary klient widzi kartę taką, jaką znał.
   * Jedyna wartość to `'codex'` i nie ma tu miejsca na listę silników na zapas — wpis powstaje
   * tylko dla tych dwóch agentów, które filtr wejściowy herdr w ogóle wpuszcza.
   *
   * Dla UI to jest pytanie „czego ta karta NIE ma": transkryptu, composera, zgód, wznowienia
   * i „×". Stan, projekt, kropka i push są takie same jak wszędzie indziej.
   */
  engine?: 'codex';
  /**
   * Ten panel to terminal Raroga (`tokens['rarog-term']`) — adres ekranu terminala w kliencie.
   *
   * Obecne dla agenta uruchomionego w terminalu Raroga (Codex albo Claude) i tylko przy włączonym
   * ficzerze terminala: link do wygaszonego terminala prowadziłby w martwy ekran (nigdy martwy
   * przycisk). Brak pola = „nie ma dokąd wejść", a nie
   * „nie wiadomo". Karta z tym polem nie ma w kliencie własnego ekranu: jej ekranem jest terminal.
   */
  termId?: string;
  /**
   * Ostatnia znana aktywność agenta — pole ULOTNE, niesione TYLKO gdy sesja pracuje.
   *
   * Powód istnienia: lista sesji nie subskrybuje transkryptów, więc bez tego pola wiersz
   * pracującej sesji nie ma czym opisać, CO się dzieje („uruchamia: Bash", „myśli…") —
   * dostawał sam stan. Nieobecne = agent nic nie robi ALBO sesja stanęła; nigdy „nie wiem”.
   */
  activity?: Activity;
  /**
   * Zadania w tle ŻYWE według transkryptu (`docs/background-tasks.md`).
   *
   * Nieobecne = żadnego nie widać ALBO nie ma odczytu z jsonl — dla UI oba znaczą to samo:
   * plakietki nie ma. Pusta tablica nie jedzie na drut z tego samego powodu, dla którego
   * `activity` nie niesie „idle": brak sygnału to brak pola, a nie zero-wypełniacz.
   *
   * Pole ADDYTYWNE — `PROTOCOL_VERSION` zostaje, stary klient je po prostu ignoruje.
   */
  backgroundTasks?: BackgroundTask[];
  /**
   * Artefakty opublikowane w bieżącej rozmowie sesji Claude (`docs/artifacts.md`), najnowsza
   * publikacja pierwsza, najwyżej 20.
   *
   * Nieobecne = brak artefaktów albo brak odczytu pliku rozmowy (Codex, panel spoza
   * `RAROG_HERDR_ROOTS`); pusta tablica nie jedzie na drut, jak przy `backgroundTasks`. Lista idzie za
   * plikiem rozmowy: po `/clear` pole znika.
   *
   * Pole ADDYTYWNE — `PROTOCOL_VERSION` zostaje, stary klient je ignoruje.
   */
  artifacts?: SessionArtifact[];
  /**
   * Pull requesty utworzone w bieżącej rozmowie sesji Claude (`docs/pull-requests.md`): `gh pr create`
   * w narzędziu `Bash` agenta głównego, subagenta albo agenta workflow. Najnowszy pierwszy, najwyżej 20.
   *
   * Nieobecne = brak PR-ów albo brak odczytu plików rozmowy (Codex, panel spoza `RAROG_HERDR_ROOTS`); pusta
   * tablica nie jedzie na drut. Lista idzie za rozmową: po `/clear` pole znika.
   *
   * Pole ADDYTYWNE — `PROTOCOL_VERSION` zostaje, stary klient je ignoruje.
   */
  pullRequests?: SessionPullRequest[];
  /**
   * Scheduled tasks (crons) the session has armed now (`docs/scheduled-tasks.md`), newest `createdAt` first, at most
   * 50. Absent = none or no read; an empty array does not travel. ADDITIVE, like `artifacts`.
   */
  scheduledTasks?: SessionScheduledTask[];
  /**
   * NA CO czeka sesja stojąca na decyzji — patrz {@link WaitingFor}.
   *
   * Pole ULOTNE i LICZONE: powstaje w `#summaryOf` z kolejki `#pending` i znika razem z nią,
   * więc nie ma czego kasować ani czego trzymać w `Session`. Obecne WYŁĄCZNIE przy
   * `state === 'waiting-permission' | 'waiting-question'` (lustro bramki `WORKING_STATES`
   * przy `activity`): „zgoda: Bash" nad sesją, która już poszła dalej, byłoby kłamstwem.
   */
  waitingFor?: WaitingFor;
  /**
   * Proces tej sesji działa na STARSZYM wydaniu Claude Code niż zainstalowane — to samo,
   * co terminal pokazuje jako `Update installed · Restart to update`.
   *
   * Pole LICZONE w `#summaryOf` z rejestru procesów CLI i dowiązania `~/.local/bin/claude`
   * (`server/src/cli-version.ts`). Nieobecne = wydanie aktualne ALBO „nie wiem" — dla UI oba
   * znaczą ciszę. Tylko żywe panele Claude w zasięgu.
   *
   * Pole ADDYTYWNE — `PROTOCOL_VERSION` zostaje.
   */
  cliUpdate?: CliUpdate;
  /**
   * Prompt wysłany z Raroga zablokował hook `UserPromptSubmit`, a przycisk „Uruchom ponownie i wyślij”
   * notki o numerze `seq` działa. Apka pokazuje przycisk tylko pod notką z tym `seq` i odsyła całe
   * pole w ciele restartu (`{ resend: { seq, id } }`); tekst do ponownej wysyłki trzyma serwer.
   *
   * Pole ULOTNE (RAM serwera): gaśnie przy następnej wysyłce z Raroga, przy wpisie `user` albo wejściu tury
   * z pliku, przy `/exit` restartu i przy odpięciu drivera. Po restarcie serwera Raroga go nie ma.
   *
   * Pole ADDYTYWNE — `PROTOCOL_VERSION` zostaje.
   */
  promptBlocked?: SessionPromptBlocked;
}

/** Para numerów wydania Claude Code: działające i zainstalowane (nowsze) */
export interface CliUpdate {
  running: string;
  installed: string;
}

/** Notka blokady, której przycisk ponownej wysyłki działa — patrz {@link SessionSummary.promptBlocked}. */
export interface SessionPromptBlocked {
  /** `seq` wiadomości `system` z polem `TranscriptMessage.promptBlocked` — pod nią apka rysuje przycisk. */
  seq: number;
  /**
   * Identyfikator TEJ blokady (losowy, nowy przy każdej blokadzie z przyciskiem). `seq` nie jest jednoznaczny
   * między restartami — karta po restarcie numeruje transkrypt od zera — więc serwer porównuje oba pola.
   */
  id: string;
}

type _ContextLimitSchemaMatchesType =
  z.infer<typeof contextLimitStateSchema> extends ContextLimitState ? true : never;
type _ContextLimitTypeMatchesSchema =
  ContextLimitState extends z.infer<typeof contextLimitStateSchema> ? true : never;
const _contextLimitSchemaMatchesType: _ContextLimitSchemaMatchesType = true;
const _contextLimitTypeMatchesSchema: _ContextLimitTypeMatchesSchema = true;
void _contextLimitSchemaMatchesType;
void _contextLimitTypeMatchesSchema;

/*
 * Pola semantyczne — ODPOWIEDZI na pytania widoku, policzone na serwerze z wiedzy o CLI.
 *
 * Klient ma rysować z nich, a nie z nazw narzędzi (`ExitPlanMode`, `Agent`, `Bash`), kanału
 * odpowiedzi ani angielskich tekstów opcji: zmiana w CLI to wtedy wydanie samego serwera. Każde
 * pole jest OPCJONALNE w schemacie (stary serwer go nie zna, `PROTOCOL_VERSION` bez zmian), ale
 * serwer nadaje je ZAWSZE tam, gdzie pole istnieje. To są fakty, nie zdania — polszczyzna zostaje
 * w kliencie.
 */
/** Czego dotyczy zgoda: zwykłego narzędzia czy wyjścia z trybu planu (`ExitPlanMode`). */
export type PermissionSubject = 'tool' | 'plan';
/** Jak czytać `detail` wywołania: komenda powłoki (input z łańcuchem `command`) albo JSON. */
export type ToolInputKind = 'shell' | 'json';

/**
 * Kanał zgód (warstwa 1): karta, na którą odpowiada się podpisanym plikiem dla śpiącego hooka
 * `PermissionRequest`, a nie klawiszem do panelu. Dziś jedyna wartość; brak pola = karta ekranowa.
 */
export const PERMISSION_CHANNELS = ['hook'] as const;
export type PermissionChannel = (typeof PERMISSION_CHANNELS)[number];

/**
 * Stan karty kanału na drucie (`PermissionRequest.state`, `permission-settled.state`), w kolejności życia karty:
 * `pending` (czeka na decyzję), `sent` (plik odpowiedzi leży, hook go nie przejął), `claimed` (hook odebrał
 * odpowiedź), `running` (odebrana, dialog zniknął, skutku w transkrypcie jeszcze nie ma), `applied` (skutek
 * potwierdzony transkryptem), `settled-at-desk` (rozstrzygnięte w terminalu), `unknown` (koniec tury bez skutku
 * albo bez jednoznacznego wiązania), `revoked` (zdjęta bez skutku), `released` (zwolniona do terminala).
 * Stan wewnętrzny serwera `deciding` jedzie jako `sent` z `canAllow: false`.
 */
export const CONSENT_CARD_STATES = [
  'pending', 'sent', 'claimed', 'running', 'applied', 'settled-at-desk', 'unknown', 'revoked', 'released',
] as const;
export type ConsentCardState = (typeof CONSENT_CARD_STATES)[number];

/**
 * Dlaczego karty kanału nie da się zatwierdzić z telefonu (`canAllow: false`): brak rejestracji hooka
 * (`no-channel`), prezentacja ponad sufit albo zrzut przycięty (`truncated`), puste wejście (`no-content`),
 * rejestracja innego wywołania (`card-mismatch`), klucz zablokowany (`key-blocked`), martwy hook (`hook-dead`),
 * brak dowodu „dialog stoi” (`no-proof`), karta sprzed restartu serwera (`server-restart`), prośba subagenta,
 * na którą odpowiada się w terminalu (`terminal-only`), znak ukryty w treści karty: kierunek pisma, zerowa szerokość,
 * sterujący (`hidden-chars`).
 */
export const CONSENT_UNAVAILABLE_REASONS = [
  'no-channel', 'truncated', 'no-content', 'card-mismatch', 'key-blocked', 'hook-dead', 'no-proof', 'server-restart',
  'terminal-only', 'hidden-chars',
] as const;
export type ConsentUnavailableReason = (typeof CONSENT_UNAVAILABLE_REASONS)[number];

/** Uwagi prezentacji karty kanału, które karta wyróżnia zdaniem: `sandbox-disabled` = `Bash` bez sandboksa. */
export const CONSENT_NOTES = ['sandbox-disabled'] as const;
export type ConsentNote = (typeof CONSENT_NOTES)[number];

/** Pole wejścia narzędzia poza blokiem komendy na karcie kanału: nazwa i pełna wartość (napis albo JSON). */
export interface ConsentInputField {
  name: string;
  value: string;
}
/**
 * Rola opcji pytania: odpowiedź autora, pozycja „wpisz własną odpowiedź" (`custom`) albo
 * WYJŚCIE z formularza („porozmawiajmy o tym", `exit`). Dwie ostatnie to chrome CLI z ekranu,
 * rozpoznawany na serwerze sygnaturami (`SCREEN_SIGNATURES` w `server/src/herdr/screen.ts`).
 */
export type QuestionOptionRole = 'answer' | 'custom' | 'exit';

/**
 * Ucięcie tekstu do pokazania stopką: `cut` — ile znaków wypadło, `footer` — ile znaków na końcu tekstu zajmuje
 * stopka. Obie liczby w skalarach Unicode (JS `[...text].length`, Swift `unicodeScalars.count`), `footer` ≤ długość
 * ciętego tekstu. Tekst niesie dalej stopkę (stara apka); nowa bierze `prefix(count − footer)` i składa własną.
 */
export interface Truncation {
  cut: number;
  footer: number;
}

export type Block =
  /** `ref` — kod zdania serwera (wiadomość systemowa, `[image]`, znacznik przycięcia); treść obca go nie ma. */
  | { type: 'text'; text: string; ref?: SentenceRef }
  /**
   * `detailKind: 'diff'` tells the client that `detail` is a ready mini-diff (lines prefixed with
   * `+`/`-`/` `) to be coloured, with the card open at once. No field = raw tool input text.
   * `delegation` (absent = not a delegation) and `inputKind` are semantic fields: the client does not
   * know CLI tool names.
   */
  | {
      type: 'tool-call'; toolName: string; summary: string; detail?: string; detailKind?: 'diff';
      delegation?: Delegation; inputKind?: ToolInputKind;
      /** Ucięcie `detail` stopką; bez `detail` blok jest odrzucany. */
      truncation?: Truncation;
    }
  /**
   * Obrazek wklejony/załączony przez użytkownika (albo odbity przez silnik). `placeholder: true` — obraz zastępczy
   * (stary obraz migawki bez treści), `alt` to wtedy zdanie serwera, które apka składa po swojemu.
   */
  | { type: 'image'; dataUrl: string; alt?: string; placeholder?: true };

/**
 * Rodzaj notki harnessu — co zgłasza wstrzyknięty wpis: koniec komendy w tle, subagenta,
 * workflow, nasłuchu monitora, pojedyncze zdarzenie monitora, sprzątanie sierot po restarcie
 * CLI albo koniec obserwacji artefaktu. `unknown` = notka, której kształtu serwer nie rozpoznał
 * (klient pokazuje formę ogólną, nigdy pustkę).
 *
 * `artifact-watch` to meldunek CLI o końcu obserwacji artefaktu (`<task-type>`
 * `artifact-watch-lifecycle`): artefakt usunięty, publiczny spoza organizacji albo zmiana konta. To
 * nie jest zadanie w tle i nie ma wyniku; `name` to tytuł artefaktu, gdy meldunek go podaje. Wartość
 * ADDYTYWNA, `PROTOCOL_VERSION` zostaje: dekoder klienta sprzed niej czyta ją jak każdy nieznany
 * łańcuch, czyli `unknown` (`notice.kind` w `DEGRADATIONS`, `decode.ts`).
 */
export type NoticeKind =
  | 'command' | 'agent' | 'workflow' | 'monitor-end' | 'monitor-event' | 'orphan' | 'artifact-watch'
  | 'unknown';
/**
 * Wynik zadania z notki: skończone, niepowodzenie, zatrzymane (ręką albo przez CLI) albo POSTÓJ
 * (`waiting`): subagent stanął i czeka na własne zadanie w tle. Postój nie jest końcem zadania
 * ani wynikiem pracy, a wartość dotyczy wyłącznie notki rodzaju `agent`.
 *
 * `waiting` jest wartością ADDYTYWNĄ, `PROTOCOL_VERSION` zostaje: dekoder klienta
 * sprzed niej czyta ją jak każdy nieznany łańcuch, czyli brak pola (`notice.outcome` w
 * `DEGRADATIONS`, `decode.ts`). Serwer nadaje ją dla meldunku agenta ze
 * statusem `completed` i dopiskiem o postoju, tym samym, po którym lista zadań zostawia agenta
 * z `waitingSince` (`docs/background-tasks.md`, „Notice in the transcript”).
 */
export type NoticeOutcome = 'done' | 'failed' | 'halted' | 'waiting';

/**
 * Notka harnessu Claude Code: wpis, który CLI WSTRZYKUJE do rozmowy jako wiadomość roli
 * `user` (koniec zadania w tle), choć nikt go nie napisał.
 *
 * Klasyfikuje serwer po POCHODZENIU wpisu jsonl (`origin.kind === 'task-notification'`), nie po
 * tekście: prompt człowieka ze znacznikiem w treści notką nie jest. `role` i `blocks` zostają bez
 * zmian (stary klient dalej rozpoznaje notkę po swojemu), a pole niesie fakty do jednego zdania:
 * - `outcome` — tylko gdy plik go mówi; brak NIE znaczy sukcesu (sierota, zdarzenie monitora);
 * - `name` — nazwa zadania z cudzysłowu w streszczeniu, do 80 znaków z wielokropkiem;
 * - `exitCode` — kod wyjścia komendy, tylko z pliku, nigdy zgadywany.
 * Wiadomość z `notice` nie jest promptem: nie gasi echa wysyłki i nie wchodzi do „ostatniego
 * promptu", cytatu tury, zwrotu tekstu po Esc ani listy „Wznów".
 */
export interface TranscriptNotice {
  kind: NoticeKind;
  outcome?: NoticeOutcome;
  name?: string;
  exitCode?: number;
}

/**
 * Prompt zablokowany przez hook `UserPromptSubmit` Claude Code — fakty notki (pole
 * {@link TranscriptMessage.promptBlocked}). `reason` to powód od hooka (stderr albo `reason` z JSON-a, bez
 * sekwencji terminala, przycięty jak wynik komendy). `prompt` to cytat promptu z pliku rozmowy — wyłącznie
 * w notce BEZ dymka promptu (prompt wpisany w terminalu albo odczytany z historii bez echa wysyłki); prompt
 * wysłany z Raroga stoi dymkiem nad notką.
 */
export interface TranscriptPromptBlocked {
  reason: string;
  prompt?: string;
}

export interface TranscriptMessage {
  seq: number; role: 'user' | 'assistant' | 'system'; blocks: Block[]; at: string;
  /**
   * Załączniki, które POSZŁY z tą wiadomością — same wizytówki.
   *
   * Osobne pole, a nie wariant `Block`: `blockSchema` jest sumą rozłączną, a bloki renderują
   * TREŚĆ wiadomości. Załącznik nie jest treścią — jest tym, co do niej dołączono, i klient
   * rysuje go jednym paskiem chipów pod tekstem, niezależnie od tego, ile bloków ma wiadomość.
   * Brak pola = wiadomość bez załączników (tak wygląda każda wiadomość agenta).
   */
  attachments?: MessageAttachment[];
  /**
   * Identyfikator wysyłki od klienta — WYŁĄCZNIE w echu wiadomości wysłanej z Raroga
   * z `MessageBody.clientMessageId`. Klient gasi po nim swój wpis „w locie", podpis treści zostaje
   * zapasem. Brak pola: wysyłka bez identyfikatora, prompt z terminala i KAŻDA wiadomość
   * odczytana z jsonl, także po restarcie Raroga (plik CLI tego pola nie zna).
   */
  clientMessageId?: string;
  /** Wpis wstrzyknięty przez harness CLI, nie wypowiedź człowieka — patrz {@link TranscriptNotice}. */
  notice?: TranscriptNotice;
  /**
   * Notka `system` o prompcie zablokowanym przez hook (`docs/dialogs.md`, „Prompt blocked by a hook”).
   * Pole ADDYTYWNE: `role` i `blocks` niosą gotowy tekst notki („⚠ Hook zablokował prompt…”, powód
   * i ewentualny cytat), więc klient bez pola pokazuje ją jak zwykłą notkę systemową. Brak pola = zwykła
   * wiadomość.
   */
  promptBlocked?: TranscriptPromptBlocked;
}

export interface PermissionRequest {
  permId: string; sessionId: string; toolName: string;
  displayText: string;     // pełna komenda / opis inputu — monospace w UI
  /** Kod zdania `displayText`: tylko karta zdegradowana; tekst agenta kodu nie ma. */
  displayTextRef?: SentenceRef;
  /** Ucięcie `displayText` stopką (karta zgody i plan). */
  truncation?: Truncation;
  risk: Risk; cwd: string; createdAt: string;
  /**
   * Whether the card can be APPROVED from the phone (fail-closed). `false`: the server rejects `allow` with 409 and the
   * app offers only the deny button; {@link unavailable} says why. A card without `channel` and without that field is
   * one Rarog does not understand (no `input`: dialog outside jsonl, tool name mismatch, options not parsed). No field
   * reads as `true` (older server, card with full input).
   */
  canAllow?: boolean;
  /**
   * DOSŁOWNA etykieta opcji „Yes, and don't ask again…" z ekranu dialogu — jeśli dialog ją ma i jest jednoznaczna
   * (dokładnie jedna twierdząca opcja eskalująca). Taka opcja dostaje na karcie WŁASNY przycisk (jawny, z pełną
   * etykietą — użytkownik czyta dokładnie to, co zatwierdza), a decyzja jedzie osobnym wariantem `allow-always`. Brak
   * pola = dialog nie ma takiej opcji albo jest ich więcej niż jedna (wtedy zostaje terminal).
   */
  alwaysLabel?: string;
  /** Karta kanału: opcja „zawsze” (`protocol/consent.ts`), decyzja `allow-always`; przycisk wymaga `canAllow`. */
  always?: ConsentAlwaysEntry[];
  /** Zgoda na narzędzie czy na wyjście z planu — klient nie zna nazwy `ExitPlanMode`. */
  subject?: PermissionSubject;
  /**
   * `displayText` to DOSŁOWNIE komenda powłoki — klient koloruje ją składnią w bloku komendy. Serwer nadaje
   * wyłącznie `'shell'` i tylko wtedy, gdy input narzędzia niesie łańcuch `command` równy `displayText` co do znaku
   * (`permissionSemantics` w `server/src/drivers/tool-text.ts`). Brak pola: karta z ekranu, zdegradowana, plan, JSON
   * innych narzędzi albo komenda ucięta stopką.
   */
  inputKind?: ToolInputKind;
  /**
   * Karta kanału zgód: odpowiedź jedzie podpisanym plikiem dla hooka, `permId` to stały klucz hooka,
   * a nowa karta o tym samym `permId` ZASTĘPUJE poprzednią. Pola niżej (`state`, `dialogVisible`, `siblingsDenied`,
   * `fields`, `notes`) niesie tylko taka karta, `unavailable` także karta bez kanału. Brak pola = karta ekranowa.
   */
  channel?: PermissionChannel;
  /** Stan karty kanału; zmiany przychodzą zdarzeniem `permission-settled`. */
  state?: ConsentCardState;
  /** First reason why the card has no approve button; screen values only without `channel`. No field = see `canAllow`. */
  unavailable?: ConsentUnavailableReason | ScreenUnavailableReason;
  /** Czy dialog prośby stoi w terminalu (dowód z ekranu); brak = serwer tego nie wie. */
  dialogVisible?: boolean;
  /** Ile próśb rodzeństwa z tej samej wiadomości modelu serwer odrzucił razem z tą kartą; brak = żadnej. */
  siblingsDenied?: number;
  /** Pola wejścia poza komendą (`inputKind: 'shell'`), w stałej kolejności; przy JSON wszystko jest w `displayText`. */
  fields?: ConsentInputField[];
  /** Uwagi, które karta wyróżnia zdaniem (np. `Bash` z wyłączonym sandboksem). */
  notes?: ConsentNote[];
}

export interface QuestionOption {
  label: string;
  description?: string;
  /**
   * Opcja WIDOCZNA, ale bez przycisku — do wybrania wyłącznie przy biurku.
   *
   * Uniwersalna karta dialogów pokazuje KAŻDĄ opcję z ekranu dosłownie, ale opcje eskalujące uprawnienia
   * („always allow…", „don't ask again…") nie mają prawa być jednym tapnięciem z telefonu: serwer flaguje je
   * tutaj, UI rysuje je wyszarzone z dopiskiem, a `answerQuestion` ODMAWIA wysyłki ich cyfry niezależnie od UI
   * (fail-closed po obu stronach). Pole jest ADDYTYWNE i OPCJONALNE — stary klient je ignoruje; nigdy nie rozszerzać
   * go do enuma, bo nowa wartość enuma łamie dekoder starego klienta.
   */
  terminalOnly?: boolean;
  /** Rola opcji na karcie; brak (stary serwer) czytamy jak `answer`. */
  role?: QuestionOptionRole;
  /**
   * PODGLĄD opcji (kod, makieta, diagram) z payloadu autora pytania — nigdy z ekranu. Kopia przycięta przez
   * serwer (sufit na opcję i na ramkę); ucięcie kończy linia `✂ …`. Oryginał zostaje w driverze, bo CLI dostaje go z
   * powrotem w `annotations`.
   */
  preview?: string;
}

/** Jedna para ekranu przeglądu formularza — treść pytania i wybrane odpowiedzi. */
export interface ReviewPair {
  question: string;
  /** Wartości z ekranu w kolejności rysowania (wielokrotny wybór = kilka). */
  answers: string[];
}

export interface Question {
  question: string; header: string; multiSelect: boolean;
  /** Kod pytania zapasowego (`dialogs.fallback-question.<rodzaj>`); pytanie autora go nie ma. */
  questionRef?: SentenceRef;
  options: QuestionOption[];
  /**
   * Pytanie przyjmuje NOTATKĘ do wybranej opcji (CLI dostaje ją w `annotations`).
   * Liczy serwer: kanał hooka, jednokrotny wybór z podglądem, proces CLI ≥ 2.1.288. Brak = bez pola.
   */
  notes?: boolean;
  /**
   * To pytanie jest ekranem PRZEGLĄDU formularza („Review your answers") — pary
   * pytanie → odpowiedzi liczy serwer z ekranu. Brak = zwykłe pytanie (albo starszy serwer).
   */
  review?: ReviewPair[];
}

/**
 * Czym Rarog ODDA odpowiedź na tę kartę — patrz `QuestionRequest.channel`.
 *
 * - `keys` — cyfrą wybranej opcji w formularzu na ekranie panelu. Jedna cyfra zamyka JEDNO pytanie i nie umie
 *   zaznaczyć dwóch opcji naraz.
 * - `hook` — plikiem odpowiedzi, który czyta śpiący proces hooka `PermissionRequest`. Do panelu nie
 *   idzie ani jeden klawisz, więc karta wolno niesie komplet pytań i wielokrotny wybór.
 */
export type QuestionChannel = 'hook' | 'keys';

export interface QuestionRequest {
  qId: string; sessionId: string; questions: Question[]; createdAt: string;
  /**
   * Kanał odpowiedzi tej karty. Pole ADDYTYWNE i OPCJONALNE — nieobecne (starszy serwer,
   * sesja SDK) czytamy jak `keys`, czyli najostrożniej z możliwych.
   *
   * Jest tu, bo ta sama karta bywa dziś odpowiadana dwiema DROGAMI o różnych możliwościach:
   * bramka wielokrotnego wyboru w managerze musi wiedzieć, czy odpowiedź pojedzie cyfrą
   * (wtedy dwie wartości na pytanie to zgadywanie, jak dialog zareaguje na drugą cyfrę),
   * czy plikiem (wtedy `answers` niesie tekst i wielokrotność jest zwykłym przecinkiem).
   */
  channel?: QuestionChannel;
  /**
   * Dialog preface: text the agent wrote in the SAME reply as `AskUserQuestion`. ADDITIVE and
   * OPTIONAL — an old client ignores it.
   *
   * UNUSED: the server does not fill it; the field stays for older clients. The turn text is in
   * jsonl before the dialog (Claude Code 2.1.267), so the transcript already shows it.
   */
  preface?: string;
  /**
   * Czy karta przyjmuje WOLNY TEKST (pole „Własna odpowiedź"). Dziś to dokładnie
   * `channel === 'hook'` — odpowiedź jedzie plikiem jako tekst — ale regułę liczy serwer,
   * żeby klient nie decydował po kanale dostarczenia.
   */
  customAnswer?: boolean;
}

/**
 * Narzędzie, którym agent WYCHODZI Z TRYBU PLANU — nazwa dosłowna z payloadu Claude Code.
 *
 * Stoi w `shared`, bo czytają ją OBIE strony: serwer (parser ekranu `herdr/screen.ts`, składanie
 * karty w `drivers/herdr/dialogs.ts`, bramka treści w `#waitingFor`) i klient (copy karty
 * i linii listy). Dwie stałe — po jednej w każdym pakiecie — rozjechałyby się przy pierwszej
 * zmianie nazwy narzędzia w CLI.
 */
export const EXIT_PLAN_MODE_TOOL = 'ExitPlanMode';

/**
 * Sufit dla `WaitingFor.text` — PIERWSZA linia treści decyzji, przycięta do tylu znaków.
 *
 * 120, a nie 60: mniej ucina ścieżkę, zanim widok zdąży ją skrócić do trzech segmentów
 * (`shortenPaths`) — a wtedy z linii zostaje sam prefiks `/Users/…`, czyli nic.
 */
export const WAITING_TEXT_MAX = 120;

/**
 * NA CO czeka sesja stojąca na decyzji — skrót dla LISTY.
 *
 * Powód istnienia: pełne `pendingPermissions`/`pendingQuestions` jadą wyłącznie strumieniem
 * OGLĄDANEJ sesji, więc sidebar nie ma z czego złożyć zdania „zgoda: Bash · pnpm test" —
 * bez tego pola karta czekającej sesji mówi tylko KTO czeka, nigdy NA CO.
 *
 * To FAKTY, nie gotowy napis: polszczyzna kart mieszka w kliencie (apka: `UICopy+Cards.swift`,
 * `UICopy+List.swift`), dokładnie jak przy `herdrDialog`/`herdrDialogReason`.
 * Gotowe zdanie z serwera byłoby drugim słownikiem do utrzymania i odcięłoby `shortenPaths`,
 * które jest kosmetyką WIDOKU, a nie własnością danych.
 *
 * Pole ADDYTYWNE — `PROTOCOL_VERSION` zostaje, stary klient je ignoruje.
 */
export interface WaitingFor {
  /** Rodzaj stojącej decyzji. Dialog z ekranu ma własne pola (`herdrDialog`) i tu go nie ma. */
  kind: 'permission' | 'question';
  /** Nazwa narzędzia zgody (`Bash`, `Edit`, `ExitPlanMode`). Nieobecna przy pytaniu. */
  tool?: string;
  /**
   * PIERWSZA linia treści decyzji (komenda, treść pytania) przycięta do
   * {@link WAITING_TEXT_MAX} znaków z `…` na końcu. Pierwsza linia, bo heredoc i wypisana
   * treść pliku mają się nie zmieścić Z DEFINICJI, a nie dlatego, że akurat były krótkie.
   *
   * Nieobecna = decyzja nie ma JEDNEJ LINII, która by ją opisała, i wtedy karta zostaje przy
   * samym rodzaju („zgoda: Edit", „plan"). Trzy takie przypadki: plan
   * ({@link EXIT_PLAN_MODE_TOOL} — treścią jest CAŁY plan, a jego nagłówek nie mówi nic ponad
   * słowo „plan"), narzędzie bez pola `command` (`Edit`, `Write`, `Task` — opis inputu jest
   * JSON-em, więc pierwszą linią byłaby sama klamra) i dialog, którego Rarog nie rozpoznał.
   */
  text?: string;
  /**
   * Ile pytań niesie karta — WYŁĄCZNIE gdy jest ich więcej niż jedno („pytanie 1/3").
   * Nieobecne = jedno pytanie albo zgoda; „1" nie jest informacją, tylko szumem.
   */
  count?: number;
  /** Przy `kind: 'permission'` — zgoda na narzędzie czy plan (jak w karcie zgody). */
  subject?: PermissionSubject;
}

export type ServerEvent =
  | {
      type: 'hello'; protocolVersion: number; serverStartId: string;
      /**
       * Najniższy build klienta NATYWNEGO, który ten serwer obsługuje (`RAROG_MIN_CLIENT_BUILD`).
       * Brak pola = brak progu. Kontrakt dla apki: `build < minClientBuild` = czyta, nie
       * mutuje. Serwer po nim niczego nie odmawia: to wygoda klienta, nie granica uprawnień.
       */
      minClientBuild?: number;
      /** Ping interval of every stream in ms; see `HELLO_HEARTBEAT_MS`. Absent = heartbeat off or an older server. */
      heartbeatMs?: number;
    }
  | {
      type: 'sessions-snapshot'; sessions: SessionSummary[];
      /**
       * Stan integracji herdr w RAMCE STARTOWEJ strumienia — jedyne miejsce, z którego klient
       * bierze go po podłączeniu. Osobnego endpointu REST świadomie nie ma: iOS zrywa SSE
       * przy każdym uśpieniu, więc status musi jechać razem z listą sesji, inaczej baner
       * kłamie po każdym powrocie do apki. Nieobecny = integracja wyłączona.
       */
      herdrStatus?: HerdrStatus;
      /**
       * Katalogi projektów, które MAJĄ notatkę — jeden napis na `cwd`, zero treści.
       *
       * Jedzie tu z tej samej racji co `herdrStatus` wyżej, tylko dla ikony notatki w wierszu
       * projektu: sidebar pokazuje kilkanaście projektów naraz, a pasek pigułek sonduje JEDEN
       * katalog (`GET /api/notes?cwd=`). Sonda per wiersz byłaby kilkunastoma żądaniami na render;
       * ramka startowa liczy to raz, przy otwarciu strumienia, z plików już leżących na dysku.
       *
       * Pole NIEOBECNE znaczy „serwer o notatkach nie mówi" (`RAROG_NOTES=0`) — wtedy klient
       * gasi WSZYSTKIE ikony. PUSTA TABLICA znaczy „żaden projekt notatki nie ma" i jest czymś
       * innym: gasi ikony katalogów z TEJ ramki, a o pozostałych nie mówi nic.
       *
       * Żeby ta różnica cokolwiek znaczyła, pole musi jechać w KAŻDEJ ramce tego typu — także
       * w tej z managera (zamknięcie sesji). Dokłada je jedna metoda przy wysyłce
       * (`SseHub.withNotes`), a nie miejsce składania ramki.
       */
      notesCwds?: string[];
    }
  | { type: 'session-changed'; session: SessionSummary }
  | {
      type: 'transcript-snapshot'; sessionId: string; messages: TranscriptMessage[];
      pendingPermissions: PermissionRequest[]; pendingQuestions: QuestionRequest[];
      /**
       * Ostatnia znana aktywność agenta. Bez tego pola telefon po reconnekcie w środku
       * długiej tury znowu widzi pustkę: eventy `activity` są ulotne i nie ma ich w replayu.
       */
      activity?: Activity;
    }
  | { type: 'message'; sessionId: string; message: TranscriptMessage }
  | { type: 'delta'; sessionId: string; text: string }
  /**
   * Event ULOTNY — dokładnie jak `delta`: `seq === null`, brak ramki `id:`, poza ring bufferem
   * (`Session.pushEvent`). Nie ma go w replayu po reconnekcie; stan odtwarza
   * `transcript-snapshot.activity`. Pola to DOKŁADNIE `Activity` (jak `activityEventSchema`
   * = `activitySchema.extend`) — osobna lista gubiła nowe pole (`delegation`).
   */
  | ({ type: 'activity'; sessionId: string } & Activity)
  | { type: 'permission-pending'; request: PermissionRequest }
  | {
      type: 'permission-resolved'; sessionId: string; permId: string;
      decision: 'allow' | 'allow-always' | 'deny' | 'expired'; by: string;
    }
  /**
   * Zmiana stanu albo przycisków karty kanału zgód (`channel: 'hook'`) W MIEJSCU: ten sam `permId`, bez nowej karty.
   * Karta znika wyłącznie przez `permission-resolved`: przy `running` (decyzja odebrana przez hook, `by: "hook"`;
   * znaczy „odpowiedź oddana hookowi”, nie „narzędzie wykonane”, i po niej o karcie nie przychodzi już nic) albo
   * w stanie końcowym. Klient bez karty o tym `permId` ramkę pomija (spóźniona zmiana nie przywraca zdjętej karty).
   */
  | {
      type: 'permission-settled'; sessionId: string; permId: string; state: ConsentCardState; canAllow: boolean;
      unavailable?: ConsentUnavailableReason; dialogVisible?: boolean; at: string;
    }
  | { type: 'question-pending'; request: QuestionRequest }
  | { type: 'question-resolved'; sessionId: string; qId: string }
  | { type: 'state'; sessionId: string; state: SessionState; detail?: string; detailRef?: SentenceRef; since: string }
  | {
      type: 'git-status'; sessionId: string; branch: string; dirtyCount: number;
      files: string[]; ahead?: number; behind?: number;
      /** Brudne pliki po rodzajach; nieobecne tylko dla eventu ze starszego serwera. */
      fileKinds?: GitFileKinds;
      /** Ostatni commit (`git log -1`); nieobecny w repo bez commitów. */
      lastCommit?: GitCommit;
      /**
       * Brudne pliki z rodzajem i licznikami linii — kolejność i sufit 50 jak `files`. Ramka
       * BEZ pola znaczy „szczegółów nie ma" i zastępuje szczegóły z poprzedniej ramki, jak każde
       * inne pole tej ramki (nie „zostaw, co było").
       */
      fileDetails?: GitFileDetail[];
    }
  | { type: 'usage'; sessionId: string; contextTokens: number; contextLimit: number }
  /**
   * Zmiana dostępności herdr NA ŻYWO. Event ULOTNY i GLOBALNY: `seq: null`, poza ring bufferem
   * którejkolwiek sesji. Stan startowy odtwarza `sessions-snapshot.herdrStatus`, a nie replay.
   */
  | { type: 'herdr-status'; available: boolean; agentCount: number; readOnly: boolean;
      canLaunch?: boolean; detail?: string; detailRef?: SentenceRef }
  /**
   * Notatki PROJEKTU się zmieniły — ktoś dodał, poprawił albo skasował notatkę.
   *
   * Event ULOTNY i GLOBALNY, dokładnie jak `herdr-status`: `seq: null`, poza ring bufferem
   * którejkolwiek sesji. Notatka nie należy do żadnej sesji, więc nie ma tu czego replayować,
   * a stan startowy widok bierze z `GET /api/notes` przy wejściu.
   *
   * TREŚCI W RAMCE NIE MA i to jest decyzja, nie oszczędność: ramka jedzie do KAŻDEGO
   * otwartego klienta, także takiego, który stoi w zupełnie innym projekcie. Jedyne, co niesie,
   * to „w tym katalogu coś się zmieniło" — kto ma ten katalog na ekranie, dociąga dokument sam.
   *
   * `empty` mówi, czy PO zapisie dokument jest pusty (sam biały znak liczy
   * się jako pustka). To jeden bit, nie treść: pigułka ✎ w pasku projektu podświetla się, gdy
   * projekt MA notatkę, a bez tego bitu każdy klient musiałby po każdym autosave robić `GET`
   * całego dokumentu tylko po to, żeby zapalić albo zgasić kolor ikony.
   */
  | { type: 'notes'; cwd: string; empty: boolean }
  | InboxEventOf<SessionState>;

export type ServerEventType = ServerEvent['type'];

/**
 * Powody, dla których decyzja z telefonu NIE wyszła do panelu — ZAMKNIĘTA lista.
 *
 * Jedna unia obsługuje trzy rzeczy naraz i to jest cały powód, dla którego mieszka
 * w protokole, a nie po stronie serwera: kontrakt drivera (`DecisionOutcome`), dziennik
 * audytu (`method: "refuse"` — wpisy mają się SUMOWAĆ, `summarizeRefusals` serwera)
 * i ciało odpowiedzi 422 czytane przez klienta. Dwie równoległe listy rozjechałyby się przy
 * pierwszym nowym powodzie, a wtedy licznik odmów przestałby odpowiadać na pytanie
 * „czy ścieżka cyfrowa realnie zawodzi".
 *
 * Powody dzielą się na trzy grupy i tylko dwie ostatnie wracają kodem 422:
 * - **ocena karty** (`mismatch`, `unreadable`, `no-jsonl`) — Rarog nie umiał złożyć karty
 *   z przyciskami; nikt jeszcze o nic nie prosił, więc nie ma żądania, na które odpowiedzieć;
 * - **decyzja** (`multi-select` … `send-failed`) — człowiek tapnął, a klawisz nie wyszedł;
 * - **blokada** (`in-flight`) — powstaje w MANAGERZE, nie w driverze: decyzja o tej karcie
 *   właśnie leci z drugiego urządzenia. Do dziennika audytu nie trafia nigdy (`auditRefusal`
 *   woła wyłącznie driver), więc obietnicy „wpisy się SUMUJĄ" nie narusza.
 *
 * Lista stoi PRZED sekcją schematów, bo `sessionSummarySchema.herdrDialogReason` jej używa,
 * a `z.enum` czyta stałą w chwili budowy schematu.
 */
export const REFUSE_REASONS = [
  'mismatch', 'unreadable', 'no-jsonl', 'multi-select', 'no-digit', 'terminal-only',
  'screen-changed', 'stale-card', 'form-submit', 'send-failed', 'in-flight',
  /** Dialog ZGODY CLI (np. „Teach auto mode…") stoi w panelu, choć herdr widzi `idle`. */
  'consent-dialog',
] as const;

export type RefuseReason = (typeof REFUSE_REASONS)[number];

export const refuseReasonSchema = z.enum(REFUSE_REASONS);

// ---------------------------------------------------------------------------
// Schematy zod — bloki domenowe
// ---------------------------------------------------------------------------

export const sessionStateSchema = z.enum([
  'starting', 'running', 'waiting-input', 'waiting-permission', 'waiting-question',
  'limit-reached', 'error', 'interrupted', 'done', 'resumable',
]);

export const riskSchema = z.enum(['normal', 'red']);

export const sessionUsageSchema = z.object({
  contextTokens: z.number(),
  contextLimit: z.number(),
});

/*
 * Stands BEFORE `sessionSummarySchema`, which uses it: a module `const` does not hoist like a function, so the
 * reverse order is a TDZ error at module load.
 */
export const waitingForSchema = z.object({
  kind: z.enum(['permission', 'question']),
  tool: z.string().optional(),
  text: z.string().optional(),
  count: z.number().int().positive().optional(),
  subject: z.enum(['tool', 'plan']).optional(),
});

/** Dwa numery wydania; kształt `X.Y.Z` pilnuje serwer, tu tylko typ. */
export const cliUpdateSchema = z.object({
  running: z.string(),
  installed: z.string(),
});

/** `sessionPromptBlockedSchema`: `seq` notki blokady, której przycisk ponownej wysyłki działa, i identyfikator tej blokady. */
/** Ucięcie stopką ({@link Truncation}): dwie liczby całkowite ≥ 0. */
export const truncationSchema = z.object({
  cut: z.number().int().min(0),
  footer: z.number().int().min(0),
});

/**
 * Reguła rodzica `truncation`: ucięcie bez ciętego tekstu (blok `tool-call` bez `detail`) i stopka dłuższa niż tekst
 * (w skalarach Unicode) odrzucają cały obiekt — tak samo jak dekoder Swift (`contractViolation`).
 */
function checkTruncation(
  text: string | undefined, truncation: Truncation | undefined, field: string, ctx: z.RefinementCtx,
): void {
  if (truncation === undefined) return;
  if (text === undefined) {
    ctx.addIssue({ code: 'custom', path: ['truncation'], message: `truncation without ${field}` });
  } else if (truncation.footer > [...text].length) {
    ctx.addIssue({ code: 'custom', path: ['truncation', 'footer'], message: `footer longer than ${field}` });
  }
}

/** Reguła `truncation` bloku `tool-call` (względem `detail`); dekoder tolerancyjny nakłada ją na swój widok bloku. */
export function withDetailTruncation<T extends z.ZodType<{ detail?: string; truncation?: Truncation }>>(schema: T): T {
  return schema.superRefine((block, ctx) => { checkTruncation(block.detail, block.truncation, 'detail', ctx); });
}

/** Reguła `truncation` karty zgody (względem `displayText`); dekoder tolerancyjny nakłada ją na swój widok karty. */
export function withDisplayTextTruncation<T extends z.ZodType<{ displayText: string; truncation?: Truncation }>>(
  schema: T,
): T {
  return schema.superRefine((request, ctx) => {
    checkTruncation(request.displayText, request.truncation, 'displayText', ctx);
  });
}

export const sessionPromptBlockedSchema = z.object({
  seq: z.number().int(),
  id: z.string(),
});

export const sessionSummarySchema = z.object({
  id: z.string(),
  cwd: z.string(),
  title: z.string(),
  label: z.string().optional(),
  labelRef: sentenceRefSchema.optional(),
  state: sessionStateSchema,
  stateDetail: z.string().optional(),
  stateDetailRef: sentenceRefSchema.optional(),
  stateSince: z.string(),
  turnSince: z.string().optional(),
  createdAt: z.string(),
  lastActivityAt: z.string(),
  branch: z.string().optional(),
  dirtyCount: z.number().optional(),
  ahead: z.number().optional(),
  behind: z.number().optional(),
  fileKinds: gitFileKindsSchema.optional(),
  lastCommit: gitCommitSchema.optional(),
  usage: sessionUsageSchema.optional(),
  context: contextLimitStateSchema.optional(),
  lastSummary: z.string().optional(),
  model: z.string().optional(),
  effort: effortLevelSchema.optional(),
  ultracode: z.boolean().optional(),
  launchedByRarog: z.boolean().optional(),
  paneId: z.string().optional(),
  seen: z.boolean().optional(),
  markedUnseen: z.literal(true).optional(),
  seenBy: z.literal('voice-agent').optional(),
  stale: z.boolean().optional(),
  herdrMode: herdrModeSchema.optional(),
  herdrDialog: knownDialogIdSchema.optional(),
  herdrDialogReason: refuseReasonSchema.optional(),
  herdrDialogScreen: z.string().optional(),
  cliDialog: cliDialogClassSchema.optional(),
  outOfScope: z.boolean().optional(),
  // Oba pola ADDYTYWNE i opcjonalne — brak `engine` znaczy „Claude", brak `termId`
  // znaczy „nie ma dokąd wejść". `z.object` odcina nieznane klucze, więc bez tych dwóch linii
  // serwer mógłby je wysyłać, a klient parsujący tym schematem i tak by ich nie zobaczył.
  engine: z.literal('codex').optional(),
  termId: z.string().optional(),
  activity: activitySchema.optional(),
  backgroundTasks: z.array(backgroundTaskSchema).optional(),
  // Pole ADDYTYWNE; bez tej linii `z.object` odciąłby listę przed klientem.
  artifacts: z.array(sessionArtifactSchema).optional(),
  // Pole ADDYTYWNE, jak `artifacts`.
  pullRequests: z.array(sessionPullRequestSchema).optional(),
  scheduledTasks: z.array(sessionScheduledTaskSchema).optional(),
  waitingFor: waitingForSchema.optional(),
  cliUpdate: cliUpdateSchema.optional(),
  promptBlocked: sessionPromptBlockedSchema.optional(),
});

/** Blok `tool-call` bez reguły `truncation` — baza dla `blockSchema` i widoku tolerancyjnego dekodera. */
export const toolCallBlockObjectSchema = z.object({
  type: z.literal('tool-call'),
  toolName: z.string(),
  summary: z.string(),
  detail: z.string().optional(),
  detailKind: z.literal('diff').optional(),
  delegation: z.enum(['agents', 'workflow']).optional(),
  inputKind: z.enum(['shell', 'json']).optional(),
  truncation: truncationSchema.optional(),
});

export const blockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string(), ref: sentenceRefSchema.optional() }),
  withDetailTruncation(toolCallBlockObjectSchema),
  z.object({
    type: z.literal('image'),
    dataUrl: imageDataUrlSchema,
    alt: z.string().optional(),
    placeholder: z.literal(true).optional(),
  }),
]);

export const transcriptNoticeSchema = z.object({
  kind: z.enum([
    'command', 'agent', 'workflow', 'monitor-end', 'monitor-event', 'orphan', 'artifact-watch', 'unknown',
  ]),
  outcome: z.enum(['done', 'failed', 'halted', 'waiting']).optional(),
  name: z.string().optional(),
  exitCode: z.number().int().optional(),
});

type _NoticeSchemaMatchesType =
  z.infer<typeof transcriptNoticeSchema> extends TranscriptNotice ? true : never;
type _NoticeTypeMatchesSchema =
  TranscriptNotice extends z.infer<typeof transcriptNoticeSchema> ? true : never;
const _noticeSchemaMatchesType: _NoticeSchemaMatchesType = true;
const _noticeTypeMatchesSchema: _NoticeTypeMatchesSchema = true;
void _noticeSchemaMatchesType;
void _noticeTypeMatchesSchema;

export const transcriptPromptBlockedSchema = z.object({
  reason: z.string(),
  prompt: z.string().optional(),
});

type _PromptBlockedSchemaMatchesType =
  z.infer<typeof transcriptPromptBlockedSchema> extends TranscriptPromptBlocked ? true : never;
type _PromptBlockedTypeMatchesSchema =
  TranscriptPromptBlocked extends z.infer<typeof transcriptPromptBlockedSchema> ? true : never;
const _promptBlockedSchemaMatchesType: _PromptBlockedSchemaMatchesType = true;
const _promptBlockedTypeMatchesSchema: _PromptBlockedTypeMatchesSchema = true;
void _promptBlockedSchemaMatchesType;
void _promptBlockedTypeMatchesSchema;

export const transcriptMessageSchema = z.object({
  seq: z.number(),
  role: z.enum(['user', 'assistant', 'system']),
  blocks: z.array(blockSchema),
  at: z.string(),
  attachments: z.array(messageAttachmentSchema).optional(),
  // Echo niesie dokładnie łańcuch od klienta (ten przeszedł już `messageBodySchema`).
  clientMessageId: z.string().optional(),
  notice: transcriptNoticeSchema.optional(),
  promptBlocked: transcriptPromptBlockedSchema.optional(),
});

/** Karta zgody bez reguły `truncation` — baza dla `permissionRequestSchema` i widoku tolerancyjnego dekodera. */
export const permissionRequestObjectSchema = z.object({
  permId: z.string(),
  sessionId: z.string(),
  toolName: z.string(),
  displayText: z.string(),
  displayTextRef: sentenceRefSchema.optional(),
  truncation: truncationSchema.optional(),
  risk: riskSchema,
  cwd: z.string(),
  createdAt: z.string(),
  canAllow: z.boolean().optional(),
  alwaysLabel: z.string().optional(),
  subject: z.enum(['tool', 'plan']).optional(),
  inputKind: z.enum(['shell', 'json']).optional(),
  channel: z.enum(PERMISSION_CHANNELS).optional(),
  state: z.enum(CONSENT_CARD_STATES).optional(),
  unavailable: z.enum([...CONSENT_UNAVAILABLE_REASONS, ...SCREEN_UNAVAILABLE_REASONS]).optional(),
  dialogVisible: z.boolean().optional(),
  siblingsDenied: z.number().int().min(0).optional(),
  fields: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
  notes: z.array(z.enum(CONSENT_NOTES)).optional(),
  always: z.array(consentAlwaysEntrySchema).optional(),
});

export const permissionRequestSchema = withDisplayTextTruncation(permissionRequestObjectSchema);

export const questionOptionSchema = z.object({
  label: z.string(),
  description: z.string().optional(),
  terminalOnly: z.boolean().optional(),
  role: z.enum(['answer', 'custom', 'exit']).optional(),
  preview: z.string().optional(),
});

export const questionSchema = z.object({
  question: z.string(),
  questionRef: sentenceRefSchema.optional(),
  header: z.string(),
  multiSelect: z.boolean(),
  options: z.array(questionOptionSchema),
  notes: z.boolean().optional(),
  review: z.array(z.object({ question: z.string(), answers: z.array(z.string()) })).optional(),
});

export const questionRequestSchema = z.object({
  qId: z.string(),
  sessionId: z.string(),
  questions: z.array(questionSchema),
  createdAt: z.string(),
  channel: z.enum(['hook', 'keys']).optional(),
  customAnswer: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Schematy zod — warianty ServerEvent (po jednym na wariant)
// ---------------------------------------------------------------------------

/**
 * Range of `hello.heartbeatMs` the app treats as valid; a value outside it = no field (60 s silence limit). The schema
 * takes any positive integer, so another interval never rejects `hello`; the server omits a value outside the range.
 */
export const HELLO_HEARTBEAT_MS = { min: 1_000, max: 60_000 } as const;

export const helloEventSchema = z.object({
  type: z.literal('hello'),
  protocolVersion: z.number(),
  serverStartId: z.string(),
  // Całkowita ≥ 1: serwer waliduje ją już przy starcie (`config.ts`), więc inna to błąd producenta.
  minClientBuild: z.number().int().min(1).optional(),
  heartbeatMs: z.number().int().positive().optional(),
});

export const sessionsSnapshotEventSchema = z.object({
  type: z.literal('sessions-snapshot'),
  sessions: z.array(sessionSummarySchema),
  herdrStatus: herdrStatusSchema.optional(),
  notesCwds: z.array(z.string()).optional(),
});

export const sessionChangedEventSchema = z.object({
  type: z.literal('session-changed'),
  session: sessionSummarySchema,
});

export const transcriptSnapshotEventSchema = z.object({
  type: z.literal('transcript-snapshot'),
  sessionId: z.string(),
  messages: z.array(transcriptMessageSchema),
  pendingPermissions: z.array(permissionRequestSchema),
  pendingQuestions: z.array(questionRequestSchema),
  activity: activitySchema.optional(),
});

export const messageEventSchema = z.object({
  type: z.literal('message'),
  sessionId: z.string(),
  message: transcriptMessageSchema,
});

export const deltaEventSchema = z.object({
  type: z.literal('delta'),
  sessionId: z.string(),
  text: z.string(),
});

/** Ulotny sygnał „agent coś robi" — ta sama klasa co `delta` (bez `seq`, poza buforem). */
export const activityEventSchema = activitySchema.extend({
  type: z.literal('activity'),
  sessionId: z.string(),
});

export const permissionPendingEventSchema = z.object({
  type: z.literal('permission-pending'),
  request: permissionRequestSchema,
});

export const permissionResolvedEventSchema = z.object({
  type: z.literal('permission-resolved'),
  sessionId: z.string(),
  permId: z.string(),
  decision: z.enum(['allow', 'allow-always', 'deny', 'expired']),
  by: z.string(),
});

export const permissionSettledEventSchema = z.object({
  type: z.literal('permission-settled'),
  sessionId: z.string(),
  permId: z.string(),
  state: z.enum(CONSENT_CARD_STATES),
  canAllow: z.boolean(),
  unavailable: z.enum(CONSENT_UNAVAILABLE_REASONS).optional(),
  dialogVisible: z.boolean().optional(),
  at: z.string(),
});

export const questionPendingEventSchema = z.object({
  type: z.literal('question-pending'),
  request: questionRequestSchema,
});

export const questionResolvedEventSchema = z.object({
  type: z.literal('question-resolved'),
  sessionId: z.string(),
  qId: z.string(),
});

export const stateEventSchema = z.object({
  type: z.literal('state'),
  sessionId: z.string(),
  state: sessionStateSchema,
  detail: z.string().optional(),
  detailRef: sentenceRefSchema.optional(),
  since: z.string(),
});

export const gitStatusEventSchema = z.object({
  type: z.literal('git-status'),
  sessionId: z.string(),
  branch: z.string(),
  dirtyCount: z.number(),
  files: z.array(z.string()),
  ahead: z.number().optional(),
  behind: z.number().optional(),
  fileKinds: gitFileKindsSchema.optional(),
  lastCommit: gitCommitSchema.optional(),
  fileDetails: z.array(gitFileDetailSchema).optional(),
});

export const usageEventSchema = z.object({
  type: z.literal('usage'),
  sessionId: z.string(),
  contextTokens: z.number(),
  contextLimit: z.number(),
});

/**
 * Świadomie WĘŻSZY niż `herdrStatusSchema`: `version`/`protocol` interesują tylko ramkę
 * startową (baner „protokół nowszy niż testowany"), a nie każdą zmianę dostępności.
 *
 * `canLaunch` is not cosmetic: with the answer to "may I start a session" only in the
 * `sessions-snapshot` frame, the phone would keep the last known value until the next reconnect,
 * so a panel closed by hand at the Mac would free a slot while the app still showed a dimmed "+"
 * and the limit sentence.
 *
 * OPCJONALNE, bo event jest współdzielony ze starszymi wydaniami frontu i backendu: brak pola
 * znaczy „nie wiem", a nie „nie wolno" — klient zostawia wtedy poprzednią wartość zamiast gasić
 * przycisk na podstawie ciszy.
 */
export const herdrStatusEventSchema = z.object({
  type: z.literal('herdr-status'),
  available: z.boolean(),
  agentCount: z.number(),
  readOnly: z.boolean(),
  canLaunch: z.boolean().optional(),
  detail: z.string().optional(),
  detailRef: sentenceRefSchema.optional(),
});

/** Project notes changed: the directory and the "empty after the write" bit, no content ({@link ServerEvent}). */
export const notesEventSchema = z.object({
  type: z.literal('notes'),
  cwd: z.string().min(1),
  empty: z.boolean(),
});

export const serverEventSchema = z.discriminatedUnion('type', [
  helloEventSchema,
  sessionsSnapshotEventSchema,
  sessionChangedEventSchema,
  transcriptSnapshotEventSchema,
  messageEventSchema,
  deltaEventSchema,
  activityEventSchema,
  permissionPendingEventSchema,
  permissionResolvedEventSchema,
  permissionSettledEventSchema,
  questionPendingEventSchema,
  questionResolvedEventSchema,
  stateEventSchema,
  gitStatusEventSchema,
  usageEventSchema,
  herdrStatusEventSchema,
  notesEventSchema,
  ...inboxEventSchemas(sessionStateSchema),
]);

/**
 * Sanity-check: schemat i typ ręczny muszą się zgadzać w OBIE strony.
 *
 * To jest zamek na rozjazd kontraktu: wariant (albo pole) dodany tylko w typie ALBO tylko
 * w schemacie nie przechodzi typecheck. Osobne aliasy dla `Block` i `SessionSummary` dają
 * czytelniejszy błąd niż jeden wielki check na całej unii eventów.
 */
type _SchemaMatchesType = z.infer<typeof serverEventSchema> extends ServerEvent ? true : never;
type _TypeMatchesSchema = ServerEvent extends z.infer<typeof serverEventSchema> ? true : never;
type _BlockSchemaMatchesType = z.infer<typeof blockSchema> extends Block ? true : never;
type _BlockTypeMatchesSchema = Block extends z.infer<typeof blockSchema> ? true : never;
type _SummarySchemaMatchesType =
  z.infer<typeof sessionSummarySchema> extends SessionSummary ? true : never;
type _SummaryTypeMatchesSchema =
  SessionSummary extends z.infer<typeof sessionSummarySchema> ? true : never;
type _UsageSchemaMatchesType =
  z.infer<typeof sessionUsageSchema> extends SessionUsage ? true : never;
type _UsageTypeMatchesSchema =
  SessionUsage extends z.infer<typeof sessionUsageSchema> ? true : never;
type _ActivitySchemaMatchesType = z.infer<typeof activitySchema> extends Activity ? true : never;
type _ActivityTypeMatchesSchema = Activity extends z.infer<typeof activitySchema> ? true : never;
const _schemaMatchesType: _SchemaMatchesType = true;
const _typeMatchesSchema: _TypeMatchesSchema = true;
const _blockSchemaMatchesType: _BlockSchemaMatchesType = true;
const _blockTypeMatchesSchema: _BlockTypeMatchesSchema = true;
const _summarySchemaMatchesType: _SummarySchemaMatchesType = true;
const _summaryTypeMatchesSchema: _SummaryTypeMatchesSchema = true;
const _usageSchemaMatchesType: _UsageSchemaMatchesType = true;
const _usageTypeMatchesSchema: _UsageTypeMatchesSchema = true;
const _activitySchemaMatchesType: _ActivitySchemaMatchesType = true;
const _activityTypeMatchesSchema: _ActivityTypeMatchesSchema = true;
void _schemaMatchesType;
void _typeMatchesSchema;
void _blockSchemaMatchesType;
void _blockTypeMatchesSchema;
void _summarySchemaMatchesType;
void _summaryTypeMatchesSchema;
void _usageSchemaMatchesType;
void _usageTypeMatchesSchema;
void _activitySchemaMatchesType;
void _activityTypeMatchesSchema;

/**
 * Parsuje pojedynczy event SSE.
 *
 * @param json wartość już po `JSON.parse` (albo surowy string — wtedy parsujemy tutaj)
 * @returns event albo `null`, gdy `type` jest nieznany lub kształt niepoprawny.
 */
export function parseServerEvent(json: unknown): ServerEvent | null {
  let value: unknown = json;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  const result = serverEventSchema.safeParse(value);
  return result.success ? result.data : null;
}

// ---------------------------------------------------------------------------
// Schematy komend POST
// ---------------------------------------------------------------------------

/**
 * Tryby uprawnień, które Rarog wolno podać przez `--permission-mode` przy zakładaniu panelu.
 *
 * Zamknięta lista wartości, które `claude` faktycznie przyjmuje —
 * Rarog nie zgaduje nazw trybów cudzego CLI. `bypassPermissions` zostaje w schemacie, ale
 * serwer przepuszcza go WYŁĄCZNIE dla katalogów z `RAROG_YOLO_ROOTS` (manager, druga linia).
 */
export const PERMISSION_MODES = ['manual', 'acceptEdits', 'auto', 'plan', 'bypassPermissions'] as const;
export type CreateSessionPermissionMode = (typeof PERMISSION_MODES)[number];

/**
 * Dozwolony kształt `engineSessionId` (uuid sesji CLI) w ciele requestu.
 *
 * KOPIA `ENGINE_SESSION_ID_PATTERN` z `server/src/transcript-import.ts` — kontrakt współdzielony
 * z klientem nie może importować z serwera, a identyfikator wchodzi do `join()` przy szukaniu
 * pliku transkryptu. To jest granica bezpieczeństwa, nie kosmetyka: `../../…` czytałby dowolny
 * plik konta użytkownika. Sam wzorzec NIE wystarcza — `resumeFrom` jest dodatkowo walidowany
 * po `cwd` z transkryptu (`docs/security-model.md`, „`resumeFrom` is validated…”).
 */
export const ENGINE_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/**
 * Nowa sesja = ZAŁOŻENIE PANELU w herdr. `prompt` jest OPCJONALNY: pusta sesja
 * podnosi panel i czeka na pierwszą wiadomość. Prompt NIGDY nie wchodzi do argv `claude` —
 * jedzie `agent.prompt` po `interactive_ready` (`docs/security-model.md`, „The user's prompt NEVER enters argv”), więc obowiązuje go limit kanału
 * herdr, a nie limit ciała `/messages`.
 *
 * `model` przechodzi tu tylko test kształtu (`modelIdSchema`); allow-listą jest lista modeli
 * serwera (`GET /api/models`) — router odrzuca 400 `model-unknown` wszystko spoza niej.
 * BRAK pola `model` = „model domyślny konta" = ZERO flagi `--model` w argv (to ścieżka domyślna).
 *
 * `ultracode` wyłącznie jako `true`: start flagą `--effort ultracode`, która ustawia poziom xhigh, więc
 * `effort` nieobecny albo `xhigh`. Brak pola = bez flagi, decydują ustawienia Claude Code; jawne `false` niczego
 * by nie wyłączyło, dlatego odpada.
 */
export const createSessionBodySchema = z.object({
  cwd: z.string().min(1),
  prompt: z.string().max(MAX_HERDR_PROMPT_BYTES).optional(),
  permissionMode: z.enum(PERMISSION_MODES).optional(),
  model: modelIdSchema.optional(),
  effort: effortLevelSchema.optional(),
  /** Wznowienie sesji CLI. Bez `fork` wolno wyłącznie dla wpisu, który NIE żyje w herdr. */
  resumeFrom: z.string().regex(ENGINE_SESSION_ID_RE).optional(),
  /** `--fork-session`: nowy uuid, historia wczytana, jeden pisarz. Wymaga `resumeFrom`. */
  fork: z.boolean().optional(),
  ultracode: z.literal(true, { error: 'ultracode w ciele startu tylko jako true; brak pola = bez flagi.' })
    .optional(),
}).refine((body) => body.fork !== true || body.resumeFrom !== undefined, {
  message: 'Rozwidlenie wymaga podania sesji do wznowienia (`resumeFrom`).',
}).refine((body) => body.ultracode !== true || body.effort === undefined || body.effort === 'xhigh', {
  message: 'Ultracode startuje z effortem xhigh: pomiń effort albo podaj xhigh.',
});
export type CreateSessionBody = z.infer<typeof createSessionBodySchema>;

/**
 * Odpowiedź `POST /api/sessions` — **202**, natychmiast po `tab.create`.
 *
 * `sessionId` jest znany zaraz po utworzeniu panelu (`sessionIdFor(key)`), więc nie ma po co
 * trzymać połączenia przez ~5 s startu agenta: blokujący POST ginie przy zgaszeniu ekranu iOS
 * i zostawia telefon ze spinnerem przy ŻYWYM panelu. Reszta startu jedzie po SSE.
 */
export const createSessionResponseSchema = z.object({
  sessionId: z.string().min(1),
  state: z.literal('starting'),
  /**
   * The directory did not have `hasTrustDialogAccepted` yet.
   *
   * The trust dialog is on the closed signature list, so the panel is created and this field is
   * a WARNING: the trust question will appear in the panel shortly and you confirm it from the
   * phone. No field reads as `false`.
   */
  trustPrompt: z.boolean().optional(),
});
export type CreateSessionResponse = z.infer<typeof createSessionResponseSchema>;

/**
 * Ciało `POST /api/sessions/:id/close`. Brak ciała albo `closePanel` nieustawione = UKRYCIE
 * karty (panel żyje dalej). `closePanel: true` = `tab.close`, dozwolone wyłącznie dla paneli
 * z `launchedByRarog` — dla cudzych router odpowiada 409.
 */
export const closeBodySchema = z.object({
  closePanel: z.boolean().optional(),
}).optional();

/*
 * There is no hidden-panel API: "×" always closes the panel. The `hidden` section of
 * `herdr-hidden.json` is ignored on read (the file stays — it carries aliases and `seen`).
 */

/**
 * Górna granica `text` w ciele wiadomości, liczona w ZNAKACH.
 *
 * To jest sufit sanity-check na wspólnej ścieżce (sesje SDK i herdr), a nie limit kanału
 * herdr — ten jest dwa razy mniejszy, liczony w bajtach i egzekwowany przez serwer
 * (`MAX_HERDR_PROMPT_BYTES`). Bez niego `z.string()` przyjąłby wszystko, co zmieści się
 * w 120 MB ciała, a stamtąd tekst szedłby prosto do pty żywego panelu.
 * 1 M znaków (razem z limitem herdr 512 kB).
 */
export const MAX_MESSAGE_TEXT_CHARS = 1_048_576;

/*
 * Ciało `POST /api/sessions/:id/messages` (`messageBodySchema`, `MessageBody`) i kod 409
 * `CLIENT_ID_CONFLICT_ERROR` mieszkają w `shared/src/rest.ts` (`@rarog/shared/rest`).
 */

/**
 * Ciało decyzji karty zgody. `release` zwalnia kartę kanału zgód (`channel: 'hook'`) do terminala: hook wychodzi
 * bez wyniku, dialog zostaje przy biurku. Na karcie bez kanału serwer odpowiada 422.
 */
export const permissionDecisionBodySchema = z.object({
  decision: z.enum(['allow', 'allow-always', 'deny', 'release']),
  message: z.string().optional(),
});
export type PermissionDecisionBody = z.infer<typeof permissionDecisionBodySchema>;

/**
 * Górna granica JEDNEJ wartości odpowiedzi na pytanie, w ZNAKACH.
 *
 * Na kanale `keys` wartość jest etykietą z ekranu i tak długa nigdy nie bywa. Sufit jest tu
 * dla kanału `hook`, gdzie wartością bywa WOLNY TEKST z pola „Własna odpowiedź":
 * bez niego `z.string()` przyjmowałby wszystko, co zmieści się w ciele żądania, a stamtąd tekst
 * szedłby plikiem prosto do `updatedInput.answers`. Sufit jest DUŻO niższy niż
 * `MAX_MESSAGE_TEXT_CHARS`, bo to odpowiedź na pytanie w formularzu, a nie wiadomość do agenta —
 * na dłuższą treść jest composer.
 */
export const MAX_ANSWER_TEXT_CHARS = 2_000;

/*
 * Ciało `POST /api/sessions/:id/answers/:qId` (`answersBodySchema`, `AnswersBody`) i sufity
 * notatek mieszkają w `shared/src/rest.ts` (`@rarog/shared/rest`).
 */

/**
 * Powód → jedno zdanie przy karcie (422): angielski tekst zdania `dialogs.refuse.<powód>` z rejestru, to samo, które
 * router wysyła przez `say()`. Nowy powód bez wpisu rejestru nie kompiluje się.
 *
 * Krótsze niż wiadomości systemowe drivera i to jest zamierzone: pełne wyjaśnienie stoi
 * w transkrypcie tuż nad kartą, a pod przyciskiem ma się zmieścić powód, nie akapit.
 */
export const REFUSE_MESSAGES: Readonly<Record<RefuseReason, string>> = Object.freeze(Object.fromEntries(
  REFUSE_REASONS.map((reason) => [reason, say(`dialogs.refuse.${reason}`).text]),
) as Record<RefuseReason, string>);

/**
 * Ciało odpowiedzi **422** na decyzję, która NIE wyszła do panelu.
 *
 * 422, a nie 409: 409 znaczy „drugie urządzenie było pierwsze" i klient gasi po nim kartę,
 * a po odmowie karta ma ZOSTAĆ — dialog stoi dalej w terminalu, a pending w managerze
 * nie został zużyty. Pole `error` (a nie `code`) trzyma się kontraktu błędów całego API:
 * `{ error, message }` czyta wspólny parser klienta i to z niego bierze się `ApiError.code`.
 */
export const decisionRefusedBodySchema = z.object({
  error: z.literal('refused'),
  reason: refuseReasonSchema,
  message: z.string(),
  /** Kod zdania `message` (`dialogs.refuse.<powód>`). */
  messageRef: sentenceRefSchema.optional(),
});
export type DecisionRefusedBody = z.infer<typeof decisionRefusedBodySchema>;

/**
 * Los KLAWISZA przerwania — trzy stany, nie dwa.
 *
 * Przerwanie stoi w tej samej kolejce co wysyłki, więc „przyjąłem żądanie" i „Esc doszedł do
 * silnika" to dwie różne chwile, dzielone czasem sekundami. Bez trzeciej wartości „jeszcze
 * czekam" wchodzi klientowi w ścieżkę sukcesu: apka mówi „przerwane" nad żywą turą i oddaje
 * prompt do pola, z którego jedno tapnięcie dokleja tekst do tury, która trwa.
 *
 * - `yes` — klawisz poszedł do panelu;
 * - `no` — nie poszedł i nie pójdzie (panel zniknął, kanał zapisu zamknięty);
 * - `pending` — serwer przestał czekać, ale przerwanie wciąż jest w kolejce; rozstrzygnie je
 *   dopiero push SSE.
 */
export const INTERRUPT_DELIVERY = ['yes', 'no', 'pending'] as const;
export type InterruptDelivery = (typeof INTERRUPT_DELIVERY)[number];
export const interruptDeliverySchema = z.enum(INTERRUPT_DELIVERY);

/**
 * Answer of `POST /api/sessions/:id/interrupt`: **202**.
 *
 * `session` carries a FRESH `SessionSummary`: the state changes synchronously, so the answer fixes the view even when
 * `EventSource` died silently. Every field but `ok` is OPTIONAL: `session` is absent from an older server, `delivered`
 * from a route that does not wait for the driver; a client without `delivered` has two branches (success, exception),
 * the only allowed reaction. `returnedPrompt` stands only after a delivered key whose Esc put the interrupted turn's
 * prompt back into Claude Code's prompt field (CLI 2.1.329), proven by the whole field equal to that prompt; it is the
 * prompt as the server sent or read it. Absent: no hand-back was proven.
 */
export const interruptResponseSchema = z.object({
  ok: z.literal(true),
  session: sessionSummarySchema.optional(),
  delivered: interruptDeliverySchema.optional(),
  returnedPrompt: z.string().min(1).optional(),
});

export const clientLogBodySchema = z.object({
  events: z.array(z.object({
    at: z.string(),
    // Poziom celowo `string`, nie enum — spec go nie zawęża, a diagnostyka klienta nie może
    // odrzucać logów z powodu nieznanej etykiety poziomu.
    level: z.string(),
    msg: z.string(),
  })),
});
export type ClientLogBody = z.infer<typeof clientLogBodySchema>;

/**
 * Beacon obecności (`POST /api/presence`) — jedyny kanał, którym klient mówi serwerowi
 * „patrzę" albo „już nie patrzę".
 *
 * Istnieje, bo obecności NIE DA SIĘ wywnioskować z otwartego strumienia SSE: iOS usypia apkę
 * w tle, a gniazdo potrafi jeszcze chwilę wisieć. Serwer widziałby wtedy „klient jest" przy
 * zgaszonym ekranie i wysyłał powiadomienia dokładnie wtedy, gdy nie miał prawa — czyli
 * powtórzyłby błąd hooków, tylko z innego powodu.
 *
 * Klient odpowiada na heartbeat SSE, DOPÓKI jest widoczny, i zgłasza zmianę od razu przy
 * `visibilitychange`. Koszt: jedno małe żądanie na 25 s przy otwartej apce, ZERO w tle.
 */
/**
 * Po tylu ms bez potwierdzenia serwer przestaje uważać klienta za obecnego.
 *
 * Stała mieszka w protokole, bo jest KONTRAKTEM między dwiema stronami, a nie szczegółem
 * którejś z nich: serwer po niej wygasza obecność, a klient musi odświeżać się wyraźnie
 * CZĘŚCIEJ — jedno zgubione żądanie na kiepskim LTE nie ma prawa zamienić patrzącego
 * człowieka w nieobecnego i wypchnąć powiadomienia, którego nikt nie chciał.
 *
 * 40 s covers two presence beacons of the native app (every 20 s), so one lost request is tolerated.
 */
export const PRESENCE_TTL_MS = 40_000;

export const presenceBodySchema = z.object({
  /**
   * Identyfikator KARTY, nie użytkownika — losowany przy starcie skryptu i żyjący tyle, co
   * dokument. Serwer używa go wyłącznie do odróżnienia dwóch urządzeń (telefon i iPad mogą
   * patrzeć naraz) i nie wiąże go z niczym trwałym.
   */
  clientId: z.string().min(1).max(64),
  /** `document.visibilityState !== 'hidden'`. */
  visible: z.boolean(),
  /**
   * Sesja, której TRANSKRYPT jest otwarty. Brak = lista, ustawienia, terminal.
   *
   * Osobna informacja od `visible` i o czym innym: `visible` gasi push (patrzysz w Raroga
   * gdziekolwiek), a to pole gasi sygnał o sesji, na którą i tak patrzysz.
   */
  sessionId: z.string().min(1).max(128).optional(),
});

/**
 * Etykieta urządzenia w rejestracji APNs (`apnsRegisterBodySchema` w `rest.ts`) — wejście
 * z telefonu; serwer i tak ją sanityzuje przed zapisem (`sanitizeLabel` w `apns-devices.ts`).
 */
export const PUSH_LABEL_MAX_CHARS = 64;
