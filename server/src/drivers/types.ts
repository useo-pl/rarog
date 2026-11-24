/**
 * Kontrakt manager ↔ driver sesji.
 *
 * Plik celowo nie zawiera nic poza typami: implementacje żyją w `drivers/herdr-driver.ts`
 * (panel w herdr — jedyny driver produkcyjny) i `drivers/mock-driver.ts` (demo), a wspólne
 * narzędzia runtime (kolejka zdarzeń, zegar) w `runtime.ts`.
 *
 * Zasady kontraktu:
 * - driver NIE zna maszyny stanów ani protokołu SSE — emituje wyłącznie `DriverEvent`,
 * - `events` jest jednokonsumenckim strumieniem: czyta go dokładnie jeden pump managera,
 * - `respondPermission` / `answerQuestion` z nieznanym `reqId` oddają `stale` (idempotencja:
 *   manager może wygasić pending, zanim decyzja użytkownika dojdzie do drivera).
 */
import type {
  Activity, BackgroundTask, Block, ConsentUnavailableReason, ContextLimitState, EffortLevel, FileAttachment, GitCommit,
  GitFileDetail, GitFileKinds, HerdrMode,
  KnownDialogId, MessageAttachment, Question, QuestionChannel, RefuseReason, SessionArtifact, SessionPullRequest,
  SessionScheduledTask, ScreenUnavailableReason, TranscriptNotice,
} from '@rarog/shared';
import type { MessageSource } from '@rarog/shared/rest';
import type { AnyText, OwnText, SentenceRef } from '@rarog/shared/sentences';
import type { ModeCycleTarget } from '../herdr/mode-cycle.ts';
import type { CommandCatalog, SlashCommand } from '../herdr/commands/index.ts';
import type { CliDialogClass, CliWaitingSignal } from '../cli-version.ts';

export type { RefuseReason };

/**
 * Ucięcie tekstu do pokazania (`clipForDisplay` w `tool-text.ts`): `cut` — ile znaków wypadło, `footer` — ile znaków
 * na końcu tekstu zajmuje stopka o ucięciu. Liczby w skalarach Unicode (`[...text].length`). Na drut jedzie polem
 * `truncation` bloku `tool-call` (`wireBlocks`) i karty zgody (manager), obok tekstu, który dalej niesie stopkę.
 */
export interface Truncation {
  readonly cut: number;
  readonly footer: number;
}

/** Blok tekstu zdarzenia drivera: tekst ma pochodzenie (zdanie serwera, literał do migracji albo treść obca). */
export interface InternalTextBlock {
  readonly type: 'text';
  readonly text: AnyText;
}

/**
 * Blok WEWNĘTRZNY wiadomości (zdarzenia `message` i `history`, import pliku rozmowy, echo wysyłki). Goły `string`
 * jako tekst bloku się nie kompiluje: tekst serwera to `say()`, treść agenta i człowieka `foreign()`.
 * `Block` z `protocol.ts` powstaje z niego w jednym miejscu, `Session.appendMessage` (`wireBlocks` w `session.ts`).
 * `tool-call` niesie ucięcie `detail` (`truncation`); na drut idzie ono tylko razem z `detail`.
 */
export type InternalBlock =
  | InternalTextBlock
  | (Extract<Block, { type: 'tool-call' }> & { readonly truncation?: Truncation })
  | Extract<Block, { type: 'image' }>;

/**
 * Czy decyzja człowieka NAPRAWDĘ wyszła do silnika.
 *
 * Trzy warianty, bo dokładnie trzy rzeczy mogą się stać z tapnięciem w „Zatwierdź". Bez nich
 * (`void`) manager rozstrzygałby pending FIRST-WINS jeszcze przed wywołaniem drivera, więc odmowa
 * drivera zdejmowałaby kartę z telefonu na zawsze — dialog stałby dalej w terminalu, a Rarog
 * pokazałby „zatwierdzono".
 *
 * - `applied` — klawisz POSZEDŁ. Dopiero to zdejmuje pending w managerze (200);
 * - `refused` — nic nie poszło i pending ZOSTAJE: karta ma zostać na telefonie z powodem
 *   (422), bo dialog dalej stoi w terminalu i dalej czeka na człowieka;
 * - `stale` — decyzja adresuje coś, czego już nie ma (rozstrzygnięto przy biurku, driver
 *   odpięty): pending wygasa jak dotąd (410 + `decision: 'expired'`).
 */
export type DecisionOutcome =
  | { kind: 'applied' }
  | { kind: 'refused'; reason: RefuseReason }
  | { kind: 'stale' };

/** Skrót do najczęstszego wyniku — czytelniejszy w driverach niż literał w każdej gałęzi. */
export const APPLIED: DecisionOutcome = { kind: 'applied' };

/** Skrót do „tego już nie ma". */
export const STALE: DecisionOutcome = { kind: 'stale' };

/** Odmowa z powodem z zamkniętej listy protokołu. */
export function refused(reason: RefuseReason): DecisionOutcome {
  return { kind: 'refused', reason };
}

export type DriverEvent =
  /**
   * `engineSessionId` = identyfikator sesji silnika (CLI/SDK) — klucz do `resume`.
   *
   * `model` to identyfikator ROZWIĄZANY przez silnik (`system/init.model`), a nie alias
   * z formularza: użytkownik wybiera „sonnet", a w pigułce ma widzieć to, co naprawdę liczy.
   *
   * `effort` jest tym, co silnik NAPRAWDĘ ma (top-level `effort` we wpisie jsonl), a nie tym,
   * co Rarog ustawił: panel założony ręcznie w terminalu ma effort, o którym Rarog nic nie wie.
   * Pole jest OPCJONALNE: wpis z `effort: null` albo bez `effort` go nie daje, a manager nadpisuje
   * `session.effort` wyłącznie wtedy, gdy pole jest obecne.
   *
   * `ultracode` to znacznik ultracode z pliku rozmowy bieżącego procesu CLI (`herdr/ultracode.ts`): obecny
   * tylko przy dowodzie, brak = bez zmiany (tak samo jak `effort`). `null` = dowód przestał się liczyć (start
   * nowego procesu CLI tej rozmowy, luka w odczycie pliku): manager zdejmuje pole z karty.
   */
  | { type: 'init'; engineSessionId: string; model: string; effort?: EffortLevel; ultracode?: boolean | null }
  /**
   * Panel PRZYJĄŁ komendę sterującą `/model` albo `/effort` — optymistyczna aktualizacja
   * pigułki modelu. Komendy lokalne CLI nie tworzą wpisu asystenta w jsonl, więc bez tego
   * zdarzenia pigułka pokazywała starą wartość (albo „model?") aż do następnej tury. Wartość
   * pochodzi z TEKSTU wysłanej komendy (allow-lista managera); aliasy (`opus`) zostają na
   * pigułce tylko do pierwszego `init` z meta, który niesie identyfikator rozwiązany przez
   * silnik. Nie jest przejściem stanu. `ultracode`: panel przyjął komendę ultracode, wartość z jej formy.
   */
  | { type: 'model-set'; model?: string; effort?: EffortLevel; ultracode?: boolean }
  | { type: 'delta'; text: string }
  /**
   * Ulotny sygnał „agent coś robi": myślenie, start/postęp narzędzia,
   * czekanie na API. Nigdy nie niesie TREŚCI myślenia — tylko sam fakt ruchu. Manager
   * przepuszcza go do SSE bez ring buffera, dokładnie jak `delta`.
   */
  | ({ type: 'activity' } & Activity)
  /**
   * Wiadomość transkryptu. `role` obejmuje też `'user'`: sesja przypięta do cudzego panelu
   * czyta prompty z pliku jsonl, więc to, co użytkownik napisał W TERMINALU, musi mieć jak
   * trafić do Raroga — inaczej telefon pokazywałby same odpowiedzi bez pytań.
   */
  | {
      type: 'message'; role: 'user' | 'assistant' | 'system'; blocks: InternalBlock[];
      /** Notka harnessu z jsonl: wpis `user`, którego nikt nie napisał. */
      notice?: TranscriptNotice;
      /**
       * Prompt wysłany z Raroga z echem ODROCZONYM właśnie stanął w pliku rozmowy: manager
       * podstawia w tym miejscu wiadomość, którą trzyma od wysyłki. Token nieznany (wiadomość już
       * spłukana) = wpis z pliku jest duplikatem i nie wchodzi do transkryptu.
       */
      echoToken?: string;
    }
  /**
   * Agent dostał wejście roli `user`, którego ten strumień nie niesie jako wiadomości: wiadomość
   * od subagenta, zaplanowane wybudzenie albo prompt wysłany z Raroga w chwili, w której stanął
   * w pliku rozmowy. Bez treści; w transkrypcie niczego nie dopisuje. Manager ustala
   * z niego, co wywołało turę (cisza po turze wywołanej samym postojem subagenta).
   *
   * `lost: true` = driver stracił ciągłość pliku rozmowy (nowa rozmowa w panelu, skrócenie,
   * przeskok przyrostu) i wejścia tury mogły go ominąć: manager nie wnioskuje wtedy z rachunku
   * do następnego końca tury.
   *
   * `kind: 'compaction'` = a compaction boundary of the main thread: an input of its own kind, not a prompt.
   */
  | { type: 'turn-input'; lost?: true; kind?: 'compaction' }
  /**
   * Echo odroczone nie dostanie podstawienia z pliku: wysyłka z tym tokenem nie doszła do
   * panelu (`echo-refused` — driver emituje je PRZED swoim ostrzeżeniem, żeby to stało pod
   * dymkiem) albo jej wpis wypadł z okna echa (`echo-dropped`). Manager spłukuje wstrzymaną
   * wiadomość na koniec transkryptu.
   */
  | { type: 'echo-refused'; token: string }
  | { type: 'echo-dropped'; token: string }
  /**
   * Prompt zablokowany przez hook `UserPromptSubmit` (`docs/dialogs.md`, „Prompt blocked by a hook”).
   * Manager dopisuje notkę (z cytatem `prompt` tylko przy `echoed: false` — dymek wysyłki z Raroga stoi od
   * wysyłki), a sesję zdejmuje z „pracuje” wyłącznie przy `decided` i znaczniku tury otwartej tą wysyłką.
   *
   * - `echoed` — cytat trafił w echo wysyłki z Raroga (follower, z czasem każdego wpisu okna);
   * - `decided` — driver rozstrzygnął tą blokadą swoją OSTATNIO WYKONANĄ wysyłkę (para klucz echa →
   *   numer wysyłki); blokada starszej wysyłki, gdy nowsza już weszła do panelu, daje samą notkę;
   * - `key` — klucz echa cytatu (`echoKey`), `token` — wpis echa odroczonego, tylko obrona.
   */
  | {
      type: 'prompt-blocked'; reason: string; promptKept: boolean; prompt?: string; echoed: boolean;
      decided: boolean; key?: string; token?: string;
    }
  /**
   * PORCJA historii przy podpięciu drivera.
   *
   * Osobny wariant, a nie N × `message`, bo manager ma ją dopisać BEZ broadcastu na każdą
   * wiadomość i BEZ odpytywania gita: przy 17 panelach po 60 wiadomości pojedynczy broadcast
   * per wiadomość to tysiące globalnych ramek SSE w pierwszych sekundach po starcie Raroga.
   * `at` jest jawne, bo te wiadomości są sprzed godzin i mają zachować swoje daty.
   */
  | {
      type: 'history';
      /**
       * The engine conversation the batch was read from; absent = the driver does not tell. A driver attaching to a
       * pane that moved meanwhile hands over the new conversation's history before the `init` that names it.
       */
      engineSessionId?: string;
      messages: readonly {
        role: 'user' | 'assistant' | 'system';
        blocks: InternalBlock[];
        at: string;
        /** Wizytówki zdjęć Raroga odzyskane z jsonl; nieobecne = wiadomość bez nich. */
        attachments?: MessageAttachment[];
        /** Notka harnessu — jak w wariancie `message`. */
        notice?: TranscriptNotice;
        /** Echo odroczone — jak w wariancie `message`, na swojej pozycji historii. */
        echoToken?: string;
        /** Notka o prompcie zablokowanym przez hook bez trafienia w echo — `TranscriptMessage.promptBlocked`. */
        promptBlocked?: { reason: string; prompt?: string };
      }[];
    }
  /**
   * Stan agenta raportowany przez ZEWNĘTRZNEGO nadzorcę (herdr). Driver prowadzący własny
   * proces silnika tego nie emituje — jego stan wynika z `init`/`result`/`exit`.
   *
   * `seen` jest SUROWYM odbiciem badge'a herdr: `true` = panel bez badge'a `done` (herdrowe
   * `idle`), `false` = badge stoi. Bez tego rozróżnienia 17 bezczynnych paneli wpada do sekcji
   * uwagi i zabija listę. O ODBIORZE wyniku pole nie mówi nic: rozstrzyga
   * manager — `idle` liczy się dopiero jako przejście `done → idle` (`Session.herdrSeen`),
   * bo panel sfokusowany na Macu w chwili końca tury `done` nie dostaje wcale.
   * `mode` niesie tryb uprawnień odczytany ze stopki panelu, gdy się zmienił.
   */
  | { type: 'agent-state'; state: 'working' | 'idle' | 'blocked'; seen?: boolean;
      mode?: HerdrMode; detail?: OwnText;
      /**
       * `state_change_seq` panelu w chwili tego zdarzenia.
       *
       * Manager zapisuje przy nim znacznik „ten wynik obejrzałem z telefonu": herdr gasi `done`
       * wyłącznie fokusem w terminalu, więc bez własnego znacznika karta obejrzana na telefonie
       * wracała do sekcji uwagi po każdym resyncu. Nowszy wynik ma numer WYŻSZY i przebija
       * znacznik sam z siebie. Pole opcjonalne — driver bez numeru (atrapy) nie kłamie zerem.
       */
      stateChangeSeq?: number }
  /**
   * Auto-tytuł konwersacji panelu zmienił się (np. `/rename` w terminalu). Osobne zdarzenie,
   * a nie pole `agent-state`: zmiana tytułu przy statusie `unknown` nie ma stanu, którym
   * mogłaby jechać, a etykieta karty ma się zmienić natychmiast.
   *
   * `source: 'custom-title'`: nazwa z wpisu `custom-title` pliku rozmowy, czyli z `/rename`. Wygrywa
   * z tytułem terminala i z etykietą z pierwszego promptu, dopóki panel pisze tę samą sesję silnika. Bez pola =
   * tytuł terminala w herdr.
   */
  | { type: 'title'; title: string; source?: 'custom-title' }
  /**
   * Driver stracił kontakt ze swoim źródłem, ale silnik ŻYJE dalej (padł socket herdr).
   *
   * To NIE jest `exit` i NIE jest przejście stanu: manager ustawia `session.stale`, UI wygasza
   * kartę i pokazuje baner. Awaria nadzorcy nie ma prawa przestawić 17 kart w inne sekcje.
   */
  | { type: 'detached'; reason?: string }
  | {
      type: 'permission-request'; reqId: string; toolName: string; input: unknown;
      displayText: string;
      /** Kod zdania `displayText`: tylko karta zdegradowana; tekst z ekranu albo inputu narzędzia go nie ma. */
      displayTextRef?: SentenceRef;
      /** Ucięcie `displayText` stopką (`clipForDisplay`); manager przenosi je na kartę (`PermissionRequest.truncation`). */
      truncation?: Truncation;
      /** Etykieta opcji „Yes, and don't ask again…" z ekranu — patrz `PermissionRequest.alwaysLabel`. */
      alwaysLabel?: string;
      /**
       * Karta bez przycisku zgody mimo pełnej treści: tryb kanału zgód (`main`) nie wysyła cyfry dla klasy
       * `permission`/`sandbox`. Manager odmawia wtedy `allow` jak przy karcie bez treści; odmowa (`escape`)
       * zostaje. Brak pola = przycisk zgody wg treści karty.
       */
      canAllow?: false;
      /**
       * Why the card has no approve button (`screen-unavailable.ts`): the channel mode, or a text the card does not
       * show whole. The manager passes it only to a card without that button (`PermissionRequest.unavailable`).
       */
      unavailable?: ConsentUnavailableReason | ScreenUnavailableReason;
      /**
       * Powód DEGRADACJI karty (`input: null`, `degradedCard`) — ten sam, który poszedł
       * do dziennika odmów
       * („Refusal diagnostics” w `docs/dialogs.md`). Zwykła karta zgody go nie ma: nie było odmowy, więc nie ma
       * czego tłumaczyć.
       */
      reason?: RefuseReason;
      /**
       * CO WIDAĆ w panelu — wycinek ekranu na kartę. Niesie go WYŁĄCZNIE karta
       * zdegradowana: zwykła zgoda ma pełną treść z jsonl, więc zrzut ekranu byłby tą samą
       * informacją drugi raz.
       */
      screen?: string;
      /**
       * Klasa dialogu z rejestru sesji CLI — WYŁĄCZNIE na karcie zdegradowanej i tylko
       * wtedy, gdy rejestr mówi `waiting`. Jedzie na telefon w `SessionSummary.cliDialog`
       * i jest tam, jak `reason`, wyłącznie treścią karty.
       */
      cliDialog?: CliDialogClass;
    }
  | {
      type: 'question-request'; reqId: string; questions: Question[];
      /**
       * Czym driver ODDA odpowiedź — `keys` (cyfra z ekranu) albo
       * `hook` (plik odpowiedzi dla śpiącego hooka). Karta z kanału `hook` niesie KOMPLET
       * pytań formularza i wolno na niej zaznaczyć kilka opcji; karta `keys` niesie jedną
       * zakładkę i jedną wartość. Pole jedzie dalej na telefon (`QuestionRequest.channel`),
       * bo to na nim stoi bramka wielokrotnego wyboru w managerze.
       */
      channel?: QuestionChannel;
      /*
       * Pola `preface` tu NIE MA: wstęp dialogu czytany z ekranu
       * dublowałby tekst tury, który od CLI 2.1.267 stoi w jsonl jeszcze przed dialogiem.
       * `QuestionRequest.preface` zostaje w protokole jako pole ADDYTYWNE i nieużywane —
       * usunięcie go z kontraktu złamałoby starszego klienta.
       */
    }
  /**
   * W panelu stoi dialog, którego NIE MA w jsonl (zaufanie katalogu, zgoda MCP, wyjście
   * z trybu plan) — „Dialogs and cards in a herdr pane” w `docs/implementation-spec.md`.
   *
   * Świadomie NIE jest to `permission-request`: taka karta nie ma `permId`, bo nie ma wpisu
   * w transkrypcie, z którego dałoby się ją złożyć. Adresem decyzji jest SAMA SESJA
   * (`POST /api/sessions/:id/permission`), a treść, którą widzi człowiek, to wycinek ekranu
   * NIESIONY PRZEZ TĘ KARTĘ (pole `screen`) — nie jedzie do transkryptu.
   *
   * `knownDialog` jest jedyną rzeczą, która włącza przycisk zatwierdzania: obecne = dialog
   * dopasowany do ZAMKNIĘTEJ listy sygnatur (`KNOWN_DIALOGS`), nieobecne = Rarog nie wie,
   * co tam stoi, więc zostaje „Odrzuć (Esc)" i „Pokaż w herdr". Cyfra nie jedzie
   * ani tutaj, ani na telefon — składa ją driver z etykiety opcji w chwili decyzji.
   */
  | {
      type: 'screen-dialog'; knownDialog?: KnownDialogId;
      /**
       * DLACZEGO karta nie ma przycisków — powód z tej samej zamkniętej listy, którą liczy
       * dziennik odmów
       * („Refusal diagnostics” w `docs/dialogs.md`). Jedzie na telefon w `SessionSummary.herdrDialogReason` i jest
       * tam WYŁĄCZNIE treścią karty; o przyciskach decyduje nadal samo `knownDialog`.
       */
      reason?: RefuseReason;
      /**
       * CO WIDAĆ w panelu — ostatnie linie ekranu dialogu bez ANSI. Tak jak `reason`,
       * niesie je WYŁĄCZNIE karta bez przycisków: dialog rozpoznany z sygnatury ma na telefonie
       * własną, dosłowną treść, więc zrzut ekranu nic by do niej nie dołożył.
       */
      screen?: string;
      /** Klasa dialogu z rejestru sesji CLI — jak przy karcie zdegradowanej wyżej. */
      cliDialog?: CliDialogClass;
    }
  /**
   * Klasa z rejestru sesji CLI dla STOJĄCEJ karty bez decyzji zmieniła się po jej wystawieniu:
   * rejestr odezwał się później niż ocena ekranu albo przestał mówić `waiting`.
   * Wyłącznie pole karty sesji (`SessionSummary.cliDialog`) — bez nowej karty, pendingu,
   * przejścia stanu i pusha. Brak `cliDialog` = klasę zdjąć.
   */
  | { type: 'cli-dialog'; cliDialog?: CliDialogClass }
  /**
   * Nowy wycinek ekranu dla STOJĄCEJ karty bloku warstwy 2 (`RAROG_DIALOG_LAYER2=1`): ta sama karta, inny widok pod
   * nią (następna zakładka `/status`). Wyłącznie pole karty sesji (`SessionSummary.herdrDialogScreen`) — bez nowej
   * karty, pendingu, przejścia stanu i pusha, jak przy `cli-dialog`. Przy fladze `0` driver go nie wysyła.
   */
  | { type: 'dialog-screen'; screen: string }
  /**
   * Czekające narzędzie przestało czekać: człowiek odpowiedział w terminalu albo agent ruszył
   * dalej. Manager gasi kartę (`#expirePending(session, false)`) — bez tego karta zgody
   * z telefonu wisiałaby po decyzji podjętej przy biurku.
   */
  | { type: 'permission-cleared'; reqId?: string; reason?: string }
  | {
      type: 'git-status'; branch: string; dirtyCount: number; files: string[];
      /** Z `# branch.ab +X -Y`; brak upstreamu = pola nieobecne (patrz `git-status.ts`). */
      ahead?: number; behind?: number;
      /**
       * Brudne pliki po rodzajach (dodane / zmienione / usunięte). Opcjonalne, bo driver
       * może znać sam licznik — wtedy nagłówek pokazuje „N plików" zamiast trójki.
       */
      fileKinds?: GitFileKinds;
      /** Ostatni commit (`git log -1`); brak = repo bez commitów. */
      lastCommit?: GitCommit;
      /**
       * Brudne pliki z rodzajem i licznikami linii (kolejność i sufit jak `files`). Opcjonalne
       * jak `fileKinds`: driver, który ich nie zna, wysyła ramkę bez pola — i ta ramka gasi
       * szczegóły poprzedniej.
       */
      fileDetails?: GitFileDetail[];
    }
  | { type: 'result'; subtype: 'success' | 'error_max_turns' | 'error'; summary?: string }
  /**
   * Zużycie okna kontekstu — źródło widgetu użycia w nagłówku sesji.
   *
   * Ładunkiem jest `ContextLimitState`, a nie para liczb, bo po wycięciu SDK limit okna
   * bywa NIEZNANY: w jsonl go nie ma, a identyfikator modelu okna nie rozstrzyga (`herdr/jsonl-usage.ts`).
   * Para `{tokens, limit}` zmuszałaby drivera do zgadnięcia limitu — a zgadnięty limit
   * pokazuje pasek, który kłamie. `kind: 'unknown'` niesie samą liczbę tokenów.
   */
  | { type: 'usage'; context: ContextLimitState }
  /**
   * Żywe zadania w tle sesji (`docs/background-tasks.md`).
   *
   * Ładunek jest już w kształcie protokołu, więc driver niczego nie tłumaczy — przepisuje.
   * PUSTA lista jest pełnoprawnym zdarzeniem i znaczy „zgaś plakietkę"; brak zdarzenia znaczy
   * „nic się nie zmieniło", a te dwie rzeczy nie mają prawa się zlać.
   */
  | { type: 'background-tasks'; tasks: readonly BackgroundTask[] }
  /**
   * Artefakty opublikowane w bieżącej rozmowie (`docs/artifacts.md`) — ładunek w kształcie
   * protokołu, driver go przepisuje. PUSTA lista jest pełnoprawnym zdarzeniem: „artefaktów nie ma”
   * (`/clear`, inna rozmowa po wymianie drivera). Metadana karty jak git: bez przejścia stanu, bez
   * `seen` i bez pusha.
   */
  | { type: 'artifacts'; artifacts: readonly SessionArtifact[] }
  /**
   * Pull requesty utworzone w bieżącej rozmowie (`docs/pull-requests.md`) — ładunek w kształcie
   * protokołu. PUSTA lista jest pełnoprawnym zdarzeniem: „PR-ów nie ma” (`/clear`, pierwsza wypłata po
   * podpięciu). Metadana karty jak artefakty: bez przejścia stanu, bez `seen` i bez pusha.
   */
  | { type: 'pull-requests'; pullRequests: readonly SessionPullRequest[] }
  /**
   * Scheduled tasks (crons) the conversation has armed now (`docs/scheduled-tasks.md`), in the protocol shape. An
   * EMPTY list is a full event: the first payout after the attach and after `/clear` goes out also empty, because a
   * task can go away while nobody watched. Card metadata like artifacts: no state transition, `seen` or push.
   */
  | { type: 'scheduled-tasks'; scheduledTasks: readonly SessionScheduledTask[] }
  | { type: 'limit-reached'; resetAt?: string }
  | { type: 'exit'; ok: boolean; reason?: OwnText };

/** Opcje jednej wysyłki do drivera. */
export interface SendOptions {
  /**
   * Token echa odroczonego: driver rejestruje go w oknie echa followera, a odmowę wysyłki
   * zgłasza zdarzeniem `echo-refused` z tym tokenem. Brak = echo stoi już w transkrypcie.
   */
  readonly echo?: string;
  /**
   * Klasyfikacja komendy z managera: migawka katalogu sesji, z której liczono, i wynik dla
   * tekstu po bramce (`null` = zwykły prompt). Driver bierze z niej wybór ścieżki wysyłki i watchdog,
   * a drugi strażnik klasyfikuje tekst ponownie z TEJ SAMEJ migawki — rozjazd = odmowa. Brak = driver
   * klasyfikuje sam (migawka z `deps.commandCatalog`) i tylko wtedy, gdy ma strażnika.
   */
  readonly command?: SendCommand;
  /** Who sent the message (`MessageBody.source`): each `prompt` entry of its text in the audit log carries it. */
  readonly source?: MessageSource | undefined;
}

/** One prompt the queue take-back gave back: its text and, for a message from the app, its deferred echo token. */
export interface TakenEntry {
  readonly text: string;
  readonly echo?: string;
}

/**
 * Why a queue take-back sent no key and changed no queue: `pane` (not a Claude pane in scope with a transcript, or the
 * driver is gone), `dialog` (a dialog, form or hook consent request stands, or the field is hidden), `draft` (the field
 * holds text that is not Rarog's), `unknown` (the CLI queue is not known, or the file and the screen disagree),
 * `queue` (an image in the CLI queue, or more prompts in it than one take-back can prove taken), `busy` (the
 * field still holds text of the previous take-back), `disk` (the driver's queue could not be written without the
 * taken messages; they stay queued).
 */
export type TakeBackRefusal = 'pane' | 'dialog' | 'draft' | 'unknown' | 'queue' | 'busy' | 'disk';

/**
 * The queue take-back for the manager: the CLI queue's prompts first, then the driver's own, each in queue order.
 * `fieldCleanup: 'pending'` = the prompt field of the CLI still holds taken text and is cleared after the answer.
 * `cliLeft: true` = the CLI queue held more prompts than the file proves taken: the rest stayed with the CLI (in its
 * queue, or delivered in the instant before `up`). Absent when the CLI part is whole, an empty CLI queue included.
 */
export type QueueTakeBackResult =
  | {
    readonly cli: readonly TakenEntry[];
    readonly rarog: readonly TakenEntry[];
    readonly fieldCleanup: 'done' | 'pending';
    readonly cliLeft?: true;
  }
  | { readonly refused: TakeBackRefusal };

/** Klasyfikacja komendy przekazywana driverowi razem z wysyłką. */
export interface SendCommand {
  readonly catalog: CommandCatalog;
  readonly slash: SlashCommand | null;
}

export interface SessionDriver {
  /**
   * Czy driver jest WŁAŚCICIELEM procesu silnika.
   *
   * `false` znaczy: proces należy do kogoś innego (żywy panel herdr użytkownika), więc odpięcie
   * drivera NIE MOŻE go dotknąć — `#detachDriver` pomija wtedy `interrupt()`. Pole jest
   * WYMAGANE, bo opcjonalność byłaby zaproszeniem do zapomnienia go w nowym driverze, a cena
   * zapomnienia to `ctrl+c` wysłany do wszystkich paneli przy restarcie Raroga.
   */
  readonly ownsProcess: boolean;
  /**
   * Czy driver umie odroczyć echo TEGO promptu do chwili, gdy prompt stanie w pliku rozmowy:
   * ma plik rozmowy, a tekst ma niepusty klucz echa i nie jest slash-komendą (komenda
   * nie zostawia w pliku wpisu, który dałoby się podstawić). Komendę rozpoznaje manager (`slash`
   * z bramki slash-komend) — driver nie zgaduje jej z tekstu. Brak metody = nie umie — manager dopisuje
   * echo od razu.
   */
  defersEcho?(text: string, slash: SlashCommand | null): boolean;
  /**
   * The engine conversation the pane runs now, as the driver knows it: it changes at `/clear` and `/resume` before the
   * manager hears `init`. Absent = the driver does not tell, and the session's `engineSessionId` stands for it.
   */
  readonly agentSessionId?: string;
  events: AsyncIterable<DriverEvent>;
  /**
   * Kolejna tura użytkownika.
   *
   * @param images data URL-e (png/jpeg) już zwalidowane przez router — driver ich nie sprawdza
   *               ani nie przetwarza, tylko mapuje na format swojego silnika.
   * @param files  załączniki nieobrazkowe (PDF, log, kod) — ta sama zasada co przy `images`.
   *               Driver, który ich nie obsługuje, po prostu ich nie deklaruje: parametr jest
   *               opcjonalny, więc implementacja bez niego dalej spełnia interfejs.
   */
  send(
    text: string, images?: readonly string[], files?: readonly FileAttachment[], opts?: SendOptions,
  ): void;
  /**
   * Settles when the driver's task for the last `send` has chosen its path and, if the message waits in the paste
   * queue of the herdr driver, its entry is on disk. The manager waits for it before the
   * `202`. Absent = nothing to wait for.
   */
  queueSaved?(): Promise<void>;
  /**
   * Takes the prompt queues back for the app: what waits in the CLI queue and in the driver's own queue leaves both,
   * so nothing of it reaches the agent; the turn runs on. Absent = the driver has no queue to take back.
   * `onFirstKey` runs once, synchronously, right before the first key of this take-back goes to the pane (the
   * manager times the take-back with it); a take-back without a key never calls it.
   */
  takeBackQueue?(onFirstKey?: () => void): Promise<QueueTakeBackResult>;
  /**
   * Decyzja o czekającym narzędziu.
   *
   * Obietnica rozstrzyga się DOPIERO po wysyłce (albo po odmowie): w driverze panelowym
   * decyzja stoi w tej samej kolejce co wysyłki i po drodze czyta ŻYWY ekran, więc
   * „przyjęte" i „poszło" to dwie różne chwile — dokładnie jak przy `interrupt()`.
   * Manager czeka na wynik, bo tylko `applied` ma prawo zdjąć pending.
   *
   * Bramki zasięgu i uprawnień rzucają SYNCHRONICZNIE (na wywołaniu), nie odrzuconą
   * obietnicą — 400 dla panelu poza `RAROG_HERDR_ROOTS` wraca tą drogą.
   */
  respondPermission(
    reqId: string, decision: 'allow' | 'allow-always' | 'deny', message?: string,
  ): Promise<DecisionOutcome>;
  /**
   * Odpowiedź na `AskUserQuestion` — te same reguły co przy {@link respondPermission}.
   *
   * `notes`: notatki równoległe do `answers` (`null` = bez notatki). Driver, który nie
   * umie ich dowieźć (kanał inny niż plik hooka), ma ODMÓWIĆ — nigdy wysłać samej odpowiedzi,
   * bo notatka przepadłaby po cichu. Driver bez kanału notatek parametr pomija (karta bez `notes`).
   */
  answerQuestion(
    reqId: string, answers: string[][], notes?: readonly (string | null)[],
  ): Promise<DecisionOutcome>;
  /**
   * Przerwanie bieżącej tury.
   *
   * @returns `true`, gdy klawisz przerwania NAPRAWDĘ poszedł do silnika, `false` w każdym innym
   *          przypadku (odpięty driver, zamknięty kanał zapisu, panel, którego już nie ma).
   *          Obietnica rozstrzyga się DOPIERO po wysłaniu — w driverze panelowym przerwanie
   *          stoi w tej samej kolejce co wysyłki, więc „przyjęte" i „dostarczone" to dwie
   *          różne chwile. Dzięki temu router ma z czego złożyć `delivered` zamiast
   *          obiecywać przerwanie w chwili przyjęcia żądania.
   *
   * Implementacja NIE MOŻE być `async`: bramki zasięgu i uprawnień mają rzucać
   * SYNCHRONICZNIE, czyli na wywołaniu, a nie jako odrzucona obietnica — 400 dla panelu
   * poza `RAROG_HERDR_ROOTS` wraca dziś tą drogą.
   */
  interrupt(): Promise<boolean>;
  /**
   * The prompt Claude Code handed back to its prompt field after the last delivered `escape`, proven by the field empty
   * before the key and equal to the turn's prompt after it; `null` otherwise, also once a newer send or interrupt came
   * or the conversation changed. It settles within a bounded field read. No method = no field read.
   */
  returnedPrompt?(): Promise<string | null>;
  /**
   * WEWNĘTRZNA ścieżka komend sterujących panelu — dziś wyłącznie `/model` i `/effort`, w tym dwie formy
   * ultracode (`ULTRACODE_COMMANDS` z rejestru komend).
   *
   * Istnieje osobno od `send()` z jednego powodu: te dwie komendy są na deny-liście wolnego
   * tekstu
   * („Model, effort and permission mode” w `docs/implementation-spec.md`) i mają tam zostać,
   * bo zapisują ustawienia KONTA. Manager składa je sam,
   * z wartości ze swojej allow-listy, przepuszcza przez guard z jawną flagą i dopiero wtedy
   * oddaje tutaj — dzięki czemu „użyj przycisku modelu" i „nie da się tego wpisać w composer"
   * są prawdziwe naraz.
   *
   * Po każdej komendzie driver sam obsługuje dialog potwierdzenia (cyfra z etykiety opcji,
   * wyłącznie dla dialogu klasy `confirm`, który mówi o TEJ komendzie: `commandDialogMatches`
   * w `drivers/herdr/commands.ts`) i melduje wynik wiadomością systemową — dlatego metoda
   * jest `void`, jak `send()`: 202 wraca z routera, zanim panel przemaluje ekran. Komenda ultracode dialogu nie ma:
   * driver czyta wiersz jej wyniku pod echem, `model-set` emituje tylko przy wyniku zgodnym z wysłaną wartością,
   * a wysłane włączenie uzbraja regułę pierwszej tury czytelnika pliku rozmowy.
   *
   * Opcjonalna, bo driver, który jej nie ma (demo bez scenariusza modelu), ma odmówić
   * JAWNIE w managerze, a nie udawać, że wysłał.
   */
  sendCommands?(commands: readonly string[]): void;
  /**
   * Przełączenie trybu uprawnień panelu `plan` ↔ `auto` — pętla „`shift+tab` → odczyt
   * stopki → porównanie" aż do celu albo do sufitu naciśnięć (`herdr/mode-cycle.ts`).
   *
   * `void` jak `sendCommands`: 202 wraca z routera, a wynik (tryb ustawiony / gdzie panel
   * stanął) melduje wiadomość systemowa w transkrypcie i chip trybu przez `agent-state`.
   * Manager sprawdza PRZED wywołaniem stan, zasięg, killswitch i tryb startowy; driver
   * tylko naciska i czyta. Opcjonalna — driver bez niej (demo) odmawia JAWNIE w managerze.
   */
  setMode?(target: ModeCycleTarget): void;
  /**
   * Świeże fakty o panelu przed restartem sesji na nowym Claude Code — odczyty
   * z gniazda, nie migawka: stan z nadzorcy wchodzi w `working` z karencją 1,5 s, więc tura
   * odpalona przed chwilą przy biurku wyglądałaby jeszcze na bezczynną.
   *
   * Nic nie wysyła. Opcjonalna — driver bez niej (demo) nie ma restartu i manager odmawia
   * JAWNIE.
   */
  restartProbe?(): Promise<RestartProbe>;
  /**
   * `/exit` do panelu — punkt bez powrotu restartu. Tekst stały, ścieżką slash-komendy
   * (bez `wait` i bez stall-guarda: proces wychodzi, więc przejścia w `working` nie będzie),
   * z wpisem `prompt` w dzienniku. `true` = poszło do gniazda; wynik (proces zniknął albo CLI
   * zapytał) manager ustala sam, odczytem z trzech źródeł.
   */
  requestExit?(): Promise<boolean>;
  /**
   * Task lines of the exit dialog `background-work-exit` on the pane screen: one screen read, no key.
   * `null` = another dialog or no block. The restart reads it before its Esc, under its own time limit, and
   * a rejection counts as `null`. Optional: without it the restart names no tasks.
   */
  readExitTasks?(): Promise<readonly string[] | null>;
  /**
   * Pole promptu trzyma NASZ prompt, który zablokował hook `UserPromptSubmit` (CLI włożył go z powrotem do
   * pola) — zgoda na jego wyczyszczenie przed restartem. Odczyt bez skutków. Nieobecne = brak zgody.
   */
  readonly blockedLeftover?: boolean;
  /**
   * Czyszczenie pola z zablokowanym promptem przed restartem — zadanie w kolejce wysyłek. Samo czyta
   * jeszcze raz `agent.get` (ta sama rozmowa `engineSessionId`, status `idle`/`done`) i sprawdza, że zgoda
   * dotyczy ostatnio wykonanej wysyłki; dopiero wtedy para Esc tylko na potwierdzone `filled` (najwyżej trzy
   * pary, jak przed wysyłką) i ponowny odczyt CAŁEGO obszaru pola (`composerRegionState`). Zgoda jest
   * jednorazowa: gaśnie po każdej próbie czyszczenia, także nieudanej. Opcjonalna — driver bez niej nie
   * czyści pola nigdy.
   */
  clearBlockedLeftover?(engineSessionId: string): Promise<BlockedLeftoverClear>;
  /**
   * Czy wstrzymane prompty (echo odroczone) stoją w polu promptu panelu — zadanie w kolejce wysyłek, bez
   * klawiszy (`docs/dialogs.md`, „Prompt blocked by a hook”). Prompt wysłany w trakcie tury i zablokowany
   * przez hook nie zostawia w pliku rozmowy żadnego wpisu, a CLI oddaje jego tekst do pola: rozstrzyga więc pole
   * po turze, po TREŚCI. Jeden odczyt ekranu (`visible` + `ansi`), tekst obszaru pola między liniami ramki
   * (`composerRegionText`) i werdykty `heldLeftoverVerdicts`: `not-taken` tylko przy polu RÓWNYM tekstowi
   * wiadomości albo sklejce kolejnych (po zbiciu białych znaków), samo zawieranie nie wystarcza. Wiadomość, której
   * tekstu driver po wklejeniu w trakcie tury nie zobaczył w polu, dostaje przy pustym albo nieczytelnym polu `unseen`.
   *
   * `valid` driver woła raz, zaraz po odczycie: `false` = odczyt unieważniony (wołający: tura wróciła, inny
   * driver, rezerwacja restartu, nowszy odczyt) — bez flag i z wynikiem `null`. Przy `valid() === true` werdykt
   * `not-taken` daje zgodę na wyczyszczenie pola przed następną wysyłką (para Esc tylko wtedy, gdy pole DALEJ
   * trzyma tę samą treść) i wycofuje wpis wiadomości z okna echa followera (`forgetEcho`: identyczny prompt
   * wysłany potem przy Macu nie zginie jako duplikat). `unconfirmed` niczego nie ustawia — cudzego tekstu nie
   * czyścimy.
   *
   * @returns od razu `null`, gdy driver pola nie czyta (`RAROG_PROMPT_BLOCK=0`, driver zamknięty, panel poza
   *   zasięgiem) — wołający zachowuje się jak przed odczytem; inaczej obietnicę werdyktów po tokenie albo
   *   `null` przy odczycie unieważnionym. Opcjonalna — driver bez niej (demo) pola nie czyta nigdy.
   */
  checkHeldLeftover?(
    items: readonly HeldLeftoverItem[], valid: () => boolean,
  ): Promise<ReadonlyMap<string, HeldLeftover> | null> | null;
  /**
   * Sygnał rejestru sesji CLI (`~/.claude/sessions/<pid>.json`) dla tej sesji.
   *
   * Manager woła go przy KAŻDYM odczycie rejestru (szybki tik co 1,5 s), także bez zmiany —
   * driver liczy z tego ponowienia oceny ekranu, póki `waiting` trwa. To SZTURCHNIĘCIE, nie
   * źródło stanu i nie zgoda: driver na jego podstawie najwyżej czyta ekran, a klawisz dalej
   * wychodzi wyłącznie z cyfry odczytanej z ekranu. Opcjonalny — driver bez niego (demo)
   * zachowuje się jak przed etapem C.
   */
  noteCliWaiting?(signal: CliWaitingSignal): void;
  /**
   * Szturchnięcie kanału zgód: świeży odczyt rejestru tej sesji poza taktem, zaraz po przyjętej rejestracji
   * hooka albo po wejściu panelu w blokadę. Przy `waiting: permission` driver bierze go jak {@link noteCliWaiting},
   * każdy inny sygnał tylko zdejmuje dowód z kanału, bez obserwacji. Opcjonalny — driver bez kanału zgód go nie ma.
   */
  noteConsentNudge?(signal: CliWaitingSignal): void;
  /**
   * Start procesu CLI, który JAKO JEDYNY pisze rozmowę tej sesji (rejestr sesji CLI).
   *
   * Manager woła go przy każdym odczycie rejestru, w którym rozmowa ma dokładnie jeden żywy proces
   * ze znanym czasem startu; przy „nie wiem" (brak rejestru, brak wpisu, dwóch pisarzy,
   * `RAROG_CLI_WAITING=0`) nie woła wcale. Driver podaje chwilę maszynie stanów zadań w tle, która
   * zamyka subagentów sprzed tego startu: CLI po restarcie procesu nic o nich nie zapisuje
   * (fixture `tasks/measured/resume-cli-2.1.296.jsonl`).
   * `sessionId` mówi, KTÓREJ rozmowy fakt dotyczy: driver, który stoi już na innej, go pomija.
   * Opcjonalny — driver bez niego (demo, SDK) nie ma zadań czytanych z pliku rozmowy.
   */
  noteCliProcessStart?(start: CliProcessStart): void;
  /**
   * Rarog zażądał ultracode w tej sesji o `atMs`: panel wstał z flagą `--effort ultracode` (woła manager).
   * Komendę włączenia z {@link sendCommands} driver zgłasza sam, z chwilą sprzed wysyłki. Driver podaje chwilę
   * czytelnikowi pliku rozmowy, który wtedy uzbraja regułę
   * pierwszej tury: odpowiedź na pierwszy prompt człowieka po żądaniu bez znacznika włączenia = `ultracode: false`
   * w `init`. `firstTurn: false` (wznowienie `--resume` z flagą) zostawia samą chwilę jako odcięcie historii, bez
   * reguły. Opcjonalny — driver bez niego (demo, SDK) nie czyta pliku rozmowy.
   */
  noteUltracodeRequest?(atMs: number, firstTurn?: boolean): void;
  dispose(): void;
}

/** Fakt z rejestru sesji CLI dla {@link SessionDriver.noteCliProcessStart}. */
export interface CliProcessStart {
  /** Rozmowa (uuid sesji silnika), którą pisze ten proces. */
  readonly sessionId: string;
  /** Chwila startu procesu, milisekundy epoki. */
  readonly startedAt: number;
}

/**
 * Wynik {@link SessionDriver.clearBlockedLeftover}. Restart idzie dalej WYŁĄCZNIE przy `empty`.
 *
 * - `empty` — pole puste po czyszczeniu (cały obszar), zgoda zużyta;
 * - `filled` / `unknown` — po czyszczeniu pole dalej pełne albo nieczytelne, zgoda zużyta;
 * - `busy` — świeży status nie jest `idle`/`done` (zero klawiszy, Esc w turze by ją przerwał) albo herdr
 *   zgłosił turę w trakcie czyszczenia (bez dalszych klawiszy, zgoda zużyta);
 * - `changed` — w panelu inna rozmowa albo `agent.get` padło: zero klawiszy;
 * - `stale` — zgody już nie ma (wysyłka przy Macu, blokada promptu spoza Raroga, Esc, nowa rozmowa) albo
 *   `RAROG_PROMPT_BLOCK=0`: zero klawiszy.
 */
export type BlockedLeftoverClear = 'empty' | 'filled' | 'unknown' | 'busy' | 'changed' | 'stale';

/** Wstrzymana wiadomość do odczytu pola ({@link SessionDriver.checkHeldLeftover}): token echa i tekst dla CLI. */
export interface HeldLeftoverItem {
  readonly token: string;
  readonly text: string;
}

/**
 * Werdykt odczytu pola dla jednej wstrzymanej wiadomości ({@link SessionDriver.checkHeldLeftover}):
 *
 * - `not-taken` — pole trzyma tekst tej wiadomości: CLI jej nie przyjął (najczęściej hook);
 * - `unconfirmed` — pole pełne, ale bez tego tekstu (szkic przy Macu, `[Pasted text #N +K lines]` długiego
 *   promptu): nie da się powiedzieć, czy prompt doszedł;
 * - `empty` — pole puste: prompt z pola wyszedł (doszedł albo CLI go wchłonął);
 * - `unknown` — ekran nieczytelny (brak ramki pola, dialog, błąd odczytu);
 * - `unseen` — pole puste albo nieczytelne, a wiadomość szła wklejeniem w trakcie tury i driver nie zobaczył jej tekstu
 *   w polu ani nie wkleił go drugi raz (`docs/dialogs.md`, „Sending while a turn runs”): wysyłki nic nie potwierdza.
 */
export type HeldLeftover = 'not-taken' | 'unconfirmed' | 'empty' | 'unknown' | 'unseen';

/** Wynik {@link SessionDriver.restartProbe}. */
export interface RestartProbe {
  /** Świeże `agent.get`: sesja CLI i status; `null` = agenta nie ma albo odczyt padł. */
  readonly agent: { readonly agentSessionId: string; readonly status: string } | null;
  /** Cały obszar pola promptu (`composerRegionState`); błąd odczytu = `unknown`. */
  readonly composer: 'filled' | 'empty' | 'unknown';
  /** DOKŁADNY tryb ze stopki (`acceptEdits` osobno od `auto`); błąd odczytu = `unknown`. */
  readonly mode: HerdrMode | 'acceptEdits';
}

/*
 * Fabryki driverów (`DriverFactory`) nie ma.
 *
 * Sesję zakłada `HerdrLauncher` (panel w herdr), a driver do niej daje
 * `HerdrSupervisor.attach(key)`. Rarog jest klientem herdr, nie właścicielem procesu silnika, więc
 * fabryka otwierałaby tylko drugą ścieżkę zakładania sesji.
 */
