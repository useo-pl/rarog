/**
 * Transkrypt panelu herdr: plik `~/.claude/projects/<slug>/<uuid>.jsonl` → strumień zdarzeń.
 *
 * Sesja herdr nie ma własnego procesu silnika, więc jedyną treścią rozmowy jest to, co CLI
 * zapisało na dysku. Ten moduł robi z pliku strumień: JEDNA porcja `history` przy podpięciu
 * plus `message`/`activity` na żywo. O stan („czeka na zgodę") ten moduł nie wie NIC — stan
 * przychodzi z herdr osobnym kanałem (uchwyt agenta), bo w pliku jest wtedy cisza.
 *
 * Cztery decyzje, które są tu ważniejsze niż kod:
 *
 * 1. **Historia i tail to jedna ścieżka.** Najpierw czytamy ogon i ZAPAMIĘTUJEMY offset, dopiero
 *    potem uruchamiamy obserwatora. Odwrotna kolejność (watch → read) daje albo duplikat, albo
 *    lukę — zależnie od tego, kto wygra wyścig.
 * 2. **Okno historii mierzy się WIADOMOŚCIAMI, nie bajtami pliku**.
 *    Bajty jsonl to w przeważającej części `tool_result`, który import i tak wyrzuca
 *    (`parseImportLine` zwraca dla niego `message: null`), więc stałe okno bajtowe dowoziło
 *    coś zupełnie innego, niż deklarowało: pomiar na 60 największych transkryptach dał przy
 *    oknie 1 MB medianę **12** wiadomości przy zadeklarowanym suficie 200, a sufitu nie dotknął
 *    ANI JEDEN plik. Dlatego `#prime` czyta ogon PORCJAMI WSTECZ i zatrzymuje się dopiero,
 *    gdy uzbiera `HERDR_HISTORY_MESSAGES` albo dobije do `HISTORY_MAX_BYTES`. Sufit wiadomości
 *    spina się z `MAX_TRANSCRIPT_MESSAGES` RAM-u sesji.
 * 3. **Asymetria historia ↔ tail jest zamierzona.** `parseTranscriptTail` SKLEJA kolejne wpisy
 *    asystenta w jedną wiadomość (inaczej jedna tura rozpadłaby się w UI na kilkanaście kafelków),
 *    a tail emituje jedną wiadomość na wpis, bo w chwili odczytu nie wiadomo, czy tura jest
 *    domknięta — czekanie na domknięcie zamieniłoby „na żywo" w „po fakcie".
 * 4. **Echo własnych promptów wycinamy tutaj, nie w managerze.** Manager dopisuje turę użytkownika
 *    lokalnie i tylko ten lokalny wpis gasi optymistyczny „wpis w locie" w kliencie. Gdyby dedup siedział
 *    w managerze, slash-komenda (panel nie zostawia w jsonl nic, komenda lokalna — notkę `system` zamiast
 *    wpisu `user`) wisiałaby jako „Nie potwierdzono. [Ponów]" — czyli zachęta do wysłania drugi raz
 *    czegoś, co się wykonało.
 *
 * Prywatność: base64 obrazków NIGDY nie opuszcza Maca — `parseImportLine` zamienia blok `image`
 * na tekst `[obraz]`.
 */
import { watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DELEGATING_TOOLS, KNOWN_CONTEXT_LIMITS } from '@rarog/shared';
import type {
  Activity, BackgroundTask, ContextLimitState, SessionArtifact, TranscriptNotice,
} from '@rarog/shared';
import {
  FOLLOW_MAX_READ_BYTES, HERDR_HISTORY_BYTES, HERDR_HISTORY_MESSAGES, HERDR_TRANSCRIPT_GRACE_MS,
} from '../config.ts';
import { say } from '@rarog/shared/sentences';
import { AsyncEventQueue } from '../drivers/runtime.ts';
import type { InternalBlock } from '../drivers/types.ts';
import { asRecord } from '../drivers/tool-text.ts';
import { defaultStoreRoot, projectSlug } from '../cli-store.ts';
import {
  ENGINE_SESSION_ID_PATTERN, IMAGE_PLACEHOLDER, isHiddenTurnInput, parseImportLine,
} from '../transcript-import.ts';
import type { ImportedMessage } from '../transcript-import.ts';
import { FileEchoPairing } from './commands/index.ts';
import type { PromptBlock } from './commands/index.ts';
import { historyMessages, readHistoryTail, readRange, sizeOf } from './history-steps.ts';
import type { FollowMessage, HistoryTail } from './history-steps.ts';
import {
  compactPostTokensFrom, compactPreTokensFrom, createUsageTracker, isMainCompactBoundary, usageFrom,
} from './jsonl-usage.ts';
import {
  artifactsSignature, createArtifactsTracker, createBackgroundTasksTracker, scanMainFileBefore,
} from './background/index.ts';
import { emptyCarry, takeLines } from './background/jsonl-lines.ts';
import { toolActivity, toolEndActivity, toolInputsByName } from './jsonl-activity.ts';
import { MAIN_SCAN_MAX_BYTES } from './background/main-scan.ts';
import { defaultStatuslineRoot, readStatusline } from './statusline.ts';
import type {
  ArtifactFact, ArtifactsTracker, BackgroundTasksTracker, MainScanOptions, MainScanResult,
} from './background/index.ts';
import type { UsageTracker } from './jsonl-usage.ts';
import {
  createPendingTracker, createUltracodeTracker, mainAssistantAt, metaOf, parseJsonlEntry,
} from './jsonl-pending.ts';
import type { ClosedTool, JsonlMeta, PendingTool, PendingTracker, UltracodeTracker } from './jsonl-pending.ts';
import { createCliQueueTracker } from './jsonl-queue.ts';
import type { CliQueuePops, CliQueueRead, CliQueueTracker } from './jsonl-queue.ts';
import { LookupRequests, TRANSCRIPT_EXT, locateTranscript, transcriptHasConversation } from './transcript-path.ts';
import { UPLOAD_DIR_NAME } from './uploads.ts';

// ---------------------------------------------------------------------------
// Stałe (świadomie w kodzie, nie w env: to nie jest konfiguracja bezpieczeństwa)
// ---------------------------------------------------------------------------

/*
 * Okno historii jest zapisane w `config.ts` razem z resztą liczb integracji — tu tylko
 * re-eksport, żeby wołający brał je z modułu, który je STOSUJE. `HERDR_HISTORY_BYTES` jest
 * dziś PORCJĄ odczytu, a nie całym oknem: pełne okno wyznacza liczba wiadomości (p. 2 nagłówka).
 */
export { FOLLOW_MAX_READ_BYTES, HERDR_HISTORY_BYTES, HERDR_HISTORY_MESSAGES };
/**
 * Twardy sufit bajtów, które wolno przeczytać w pogoni za `HERDR_HISTORY_MESSAGES`.
 *
 * Bez sufitu pętla „czytaj, aż uzbierasz N wiadomości" wciągnęłaby przy gęstych `tool_result`
 * cały wielodziesięciomegabajtowy transkrypt — a to już nie jest historia na telefon, tylko
 * awaria pamięci. 8 MB przy zmierzonej gęstości (~12 wiadomości na MB w największych plikach)
 * dowozi rząd 100 wiadomości zamiast 12, czyli tyle, ile deklaracja obiecywała.
 *
 * Cena jest geometryczna, nie kwadratowa: porcja się PODWAJA, więc plik, który dobija do
 * sufitu, kosztuje najwyżej dwa sufity odczytu (≤16 MB) i tyleż samo parsowania. Pliki
 * mniejsze od porcji — czyli zdecydowana większość — kosztują dokładnie tyle co dawniej,
 * bo pętla kończy się po pierwszym obrocie.
 */
export const HISTORY_MAX_BYTES = 8 * 1024 * 1024;
/**
 * Od tego rozmiaru pliku przegląd zadań w tle sprzed okna ogona zostawia w logu linię z czasem.
 * Równe sufitowi okna: mniejszy plik okno potrafi objąć w całości, większy ma przegląd zawsze.
 */
export const TASKS_SCAN_LOG_BYTES = HISTORY_MAX_BYTES;
/** Fraza linii logu z czasem przeglądu zadań w tle sprzed okna ogona. */
export const TASKS_SCAN_LOG = 'background task scan before the tail window';
/** Fraza linii logu, gdy przegląd się nie odbył (plik ponad sufit) albo nie udał. */
export const TASKS_SCAN_SKIPPED_LOG = 'background tasks before the tail window are not visible';
/** Fraza linii logu z czasem przeglądu listy artefaktów po skróceniu pliku albo przeskoku. */
export const ARTIFACTS_RESCAN_LOG = 'artifact scan after a file truncation or skip';
/** Fraza linii logu, gdy ten przegląd się nie odbył albo nie udał: lista zna tylko to, co przyszło potem. */
export const ARTIFACTS_RESCAN_SKIPPED_LOG = 'artifacts before the file truncation or skip are not visible';
/** Okno batchowania emisji — 100 ms wystarczy telefonowi, a ratuje SSE przy 17 panelach. */
export const FOLLOW_BATCH_MS = 100;
/** Siatka bezpieczeństwa: `fs.watch` gubi zdarzenia na części systemów plików. */
export const FOLLOW_STAT_TICK_MS = 2_000;
/** Plik jeszcze nie istnieje: gęsty poll przez pierwszą minutę… */
export const FOLLOW_MISSING_FAST_MS = 500;
export const FOLLOW_MISSING_WINDOW_MS = 60_000;
/** …potem rzadki, bo panel może stać godzinami bez ani jednego promptu. */
export const FOLLOW_MISSING_SLOW_MS = 5_000;

/**
 * Ile razy pod rząd wolno SZUKAĆ pliku, który zniknął spod znanej ścieżki.
 *
 * `EnterWorktree` przenosi transkrypt `rename(2)`-em do slugu worktree — plik ma ten sam inode
 * i tę samą treść, tylko inny adres. Bez ponownego globu follower milczał do końca życia panelu
 * (zmierzone: 55 minut ślepoty przy sesji, która dopisała 80 linii). Glob nie jest
 * jednak darmowy (`readdir` korzenia + `stat` w 42 katalogach), a plik skasowany nie wróci —
 * dlatego prób jest PIĘĆ z rosnącą przerwą, a nie pętla przy każdym ticku `stat`.
 */
export const FOLLOW_RELOCATE_TRIES = 5;

/**
 * How long after `repoint()` we hold back announcing `pending: null`, so the new file's history
 * has time to tell the truth.
 *
 * A `null` emitted right at the reset would leave the driver judging the pane blind until the
 * history read brings back the real pending tool, and it would degrade a full consent card to the
 * fallback without buttons. So `null` after a reset is DEFERRED: the history read (faster than
 * this grace) emits the actual state and clears the timer, and the grace only covers a new file
 * that does not exist — after `/clear` the previous engine session's consent card must go out
 * even without a file.
 */
export const PENDING_REPOINT_GRACE_MS = 2_000;
/**
 * Ile własnych promptów trzymamy w oknie dedup — i jak długo, zanim wpis się przeterminuje.
 *
 * Gaszeniem echa rządzi OKNO, nie zegar, i to jest cała treść tej pary. Prompt wysłany w chwili,
 * gdy agent pracuje, NIE trafia do jsonl od razu: Claude Code wkłada go do KOLEJKI i zapisuje
 * dopiero przy dequeue, czyli po domknięciu bieżącej tury. Zmierzone w transkrypcie
 * sesji `visuals`: wpis `queue-operation`/`enqueue` z treścią promptu o 13:05:00, ten sam tekst
 * jako prawdziwy wpis `user` o 13:06:56 — 115 sekund przy TTL wynoszącym 10 s. Wpis echa dawno
 * wygasał, kopia z jsonl przechodziła i użytkownik widział swój prompt dwa razy. Dotyczyło to
 * KAŻDEGO promptu wysłanego w trakcie dłuższej pracy agenta; `/compact` był tylko wyjątkowo
 * długim przypadkiem, a nie warunkiem.
 *
 * Drugi los promptu wysłanego w trakcie tury (zmierzony na CLI 2.1.267–2.1.296): CLI
 * WCHŁANIA go w trwającą turę i zwykłego wpisu `user` nie zapisuje wcale. W pliku zostaje po nim
 * załącznik kolejki, z którego parser robi wiadomość `user` (`herdr/background/queued-prompt.ts`),
 * więc echo gaśnie tą samą drogą.
 *
 * Okno wystarcza samo, bo trafienie ZUŻYWA wpis (`#takeEcho` robi `splice`): dwa identyczne
 * prompty pod rząd zostawiają dwa wpisy i gaszą dwa echa, po kolei — nie ma jak zgasić jednym
 * echem dwóch wysyłek ani odwrotnie.
 *
 * TTL zostaje WYŁĄCZNIE jako bezpiecznik na wpis po wysyłce, która do jsonl nigdy nie dojechała
 * (panel zamknięty w pół drogi, prompt wycofany Escape'em). Taki sierota i tak wypada z okna po
 * ośmiu kolejnych wysyłkach — TTL łapie przypadek graniczny, w którym kolejnych wysyłek już nie
 * ma, bo praca przeniosła się do terminala. Dlatego liczy się w godzinach, a nie w sekundach:
 * ma PRZEŻYĆ najdłuższą realną turę, a nie ją uciąć.
 */
export const ECHO_WINDOW = 8;
export const ECHO_TTL_MS = 6 * 60 * 60 * 1_000;
/**
 * Zapas na wpis okna z tokenem: wpis pliku może go zużyć, gdy jego `timestamp` jest
 * najwyżej tyle wcześniejszy od rejestracji. CLI stempluje załącznik wchłoniętego promptu chwilą
 * wpisania (od 2.1.295 0,1–0,4 s przed `enqueue`), a rejestracja stoi tuż przed `prompt` —
 * wpis promptu Raroga nie bywa starszy niż ona, a prompt wpisany wcześniej w terminalu jest.
 */
export const ECHO_TOKEN_SKEW_MS = 2_000;
/*
 * Ten sam zapas obowiązuje KAŻDY wpis okna (z tokenem i bez), gdy echo gasi wpis promptu zablokowanego przez
 * hook (`#takeEcho` ze `strict`): stara, identyczna blokada z historii albo z terminala nie zje echa nowej
 * wysyłki. Wpis blokady stoi w pliku ok. 350–500 ms PO `prompt` (`docs/dialogs.md`).
 */

/**
 * Narzędzia, które ODDAJĄ pracę w dół — po nich główny jsonl potrafi milczeć minutami.
 *
 * Lista mieszka w protokole (`@rarog/shared`), bo ta sama trójka nazw musi być rozpoznana po
 * OBU stronach drutu: tutaj — żeby dopisać opis delegacji do wiersza aktywności, a w kliencie —
 * żeby policzyć agentów z bloków transkryptu. Re-eksport jest dla importerów tego modułu.
 */
export { DELEGATING_TOOLS };

/**
 * Po tylu ms bez pliku — i po nieudanym GLOBIE po uuid — mówimy głośno, że transkryptu nie ma.
 *
 * Alarm jest głośny świadomie: docs `errors.md` podają dwie przyczyny, przy których CLI wyłącza
 * zapis transkryptu („Transcript saving is off”): odziedziczony `CLAUDE_CODE_CHILD_SESSION`
 * i ustawiony `CLAUDE_CODE_SKIP_PROMPT_HISTORY` — wtedy warstwa treści Raroga znika PO CICHU,
 * a karta sesji wygląda na zdrową. Cisza w tym miejscu jest gorsza od fałszywego alarmu, ale próg
 * musi być wyższy niż czas startu agenta (~5 s), bo plik powstaje dopiero przy PIERWSZYM
 * promptcie (sesja zakończona przed pierwszym wpisem pliku nie ma: `docs/slash-commands.md`, „Live measurement”, CLI
 * 2.1.310).
 *
 * The grace counts from ARMING the guard (`expectTranscript()`), not from attaching the driver:
 * a fresh, EMPTY session standing at the shell has no file, because nobody has written anything
 * yet. An alarm about something nobody asked for teaches people to ignore alarms.
 *
 * Wartość mieszka w `config.ts` (jedno miejsce na liczby integracji); tutaj jest reeksportowana,
 * bo „po ilu sekundach brak transkryptu jest błędem" to pytanie o followera.
 */
export { HERDR_TRANSCRIPT_GRACE_MS } from '../config.ts';

/** Wiadomość systemowa po `/clear` (nowy plik transkryptu, ten sam panel). */
export const REPOINT_MESSAGE = say('transcript.repoint-clear');
/**
 * Wiadomość systemowa, gdy nowy uuid ma JUŻ plik transkryptu — czyli `/resume` wpisane
 * w terminalu, nie `/clear`. Komunikat od `/clear`
 * byłby po wznowieniu odwrotnością prawdy: „wcześniejsza rozmowa została w terminalu",
 * gdy właśnie WRÓCIŁA na ekran.
 */
export const RESUME_REPOINT_MESSAGE = say('transcript.repoint-resume');
/** Wiadomość systemowa po skróceniu/podmianie pliku. */
export const TRUNCATED_MESSAGE = say('transcript.file-truncated');
/** Wiadomość systemowa po przeskoku przyrostu większego niż `FOLLOW_MAX_READ_BYTES`. */
export const GAP_MESSAGE = say('transcript.gap');

// ---------------------------------------------------------------------------
// Kontrakt
// ---------------------------------------------------------------------------

export type { FollowMessage } from './history-steps.ts';

/**
 * Zdarzenia followera.
 *
 * Cztery pierwsze warianty (`history`, `message`, `activity`, `turn-input`) mają kształt
 * DOKŁADNIE taki jak odpowiadające im warianty `DriverEvent` — driver przepisuje je jeden do
 * jednego, bez tłumaczenia i bez miejsca na pomyłkę.
 *
 * Cztery inne są WŁASNE dla tego modułu i driver je TŁUMACZY, bo odpowiadające im wejścia
 * managera mają inny kształt (`usage` niesie tu pełny `ContextLimitState` zamiast pary liczb,
 * `meta` rozpada się na `init` i chip, `pending` dopiero po zderzeniu ze stanem z herdr staje
 * się kartą decyzji, a `error` jest wiadomością systemową, nie przejściem stanu).
 *
 * Dyskryminatorem jest `type` — tak jak w wariantach istniejących. Nowe warianty z polem
 * `kind` odpadają: użycie dwóch różnych dyskryminatorów w jednej unii rozbiłoby
 * zwężanie typu u wołającego (`switch (event.type)` przestałby się kompilować).
 */
export type FollowEvent =
  | { type: 'history'; messages: readonly FollowMessage[] }
  /**
   * `echoToken`: wpis promptu, który Rarog wysłał z echem ODROCZONYM — manager trzyma jego
   * wiadomość i podstawia ją w tym miejscu zamiast tej z pliku. Bez pola = zwykła wiadomość.
   */
  | {
      type: 'message'; role: 'user' | 'assistant' | 'system'; blocks: InternalBlock[]; notice?: TranscriptNotice;
      echoToken?: string;
      /**
       * Notka `system` z WYNIKIEM komendy lokalnej: nazwa komendy małymi literami, bez ukośnika
       * (z wpisu wyniku albo z ostatniego wywołania w pliku). Driver kończy po niej komendę wysłaną z Raroga
       * i zdejmuje pole przed managerem; `''` się nie zdarza — bez nazwy pola nie ma.
       */
      commandOutput?: string;
    }
  | ({ type: 'activity' } & Activity)
  /**
   * Wpis roli `user`, którego ten strumień NIE niesie jako wiadomości, a który wszedł do rozmowy:
   * wiadomość od subagenta albo zaplanowane wybudzenie (`isHiddenTurnInput`
   * w `transcript-import.ts`; w transkrypcie ich nie ma) oraz własny prompt Raroga, którego echo
   * follower właśnie zgasił (w transkrypcie stoi od wysyłki). Bez treści — sam fakt, w kolejności
   * pliku razem z `message`. Tylko na żywo: wpisy z historii przy podpięciu nie dają tego
   * zdarzenia. Manager liczy z niego, co wywołało turę; kształt jak wariant `DriverEvent`,
   * driver przepisuje 1:1.
   *
   * `lost: true` nie jest wejściem, tylko przyznaniem: follower stracił CIĄGŁOŚĆ pliku (nowa
   * rozmowa w panelu po `/clear` albo `/resume`, skrócenie pliku, przeskok przyrostu) i wejścia
   * tury mogły go ominąć. Leci PRZED tym, co follower przeczyta potem; manager przestaje wtedy
   * wnioskować z rachunku do następnego końca tury.
   *
   * `kind: 'compaction'`: a compaction boundary of the main thread (`isMainCompactBoundary` in `jsonl-usage.ts`).
   * Claude Code also compacts an idle conversation, and that turn has no other input.
   */
  | { type: 'turn-input'; lost?: true; kind?: 'compaction' }
  /**
   * Wpis okna echa z tokenem wypadł z okna, zanim plik przyniósł jego prompt: przycięcie
   * okna albo wiek ponad TTL. Manager spłukuje wtedy wstrzymaną wiadomość na koniec transkryptu.
   * Wyzerowanie okna przy przeskoku (`#onGap`) tego zdarzenia NIE daje — mówi o nim `turn-input
   * lost`.
   */
  | { type: 'echo-dropped'; token: string }
  /**
   * Prompt zablokowany przez hook `UserPromptSubmit` (wpis `promptSubmitEnding` z `blocked_by_hook`,
   * `docs/dialogs.md`, „Prompt blocked by a hook”). Na żywo zawsze tym zdarzeniem, nigdy wiadomością;
   * z historii tylko wtedy, gdy wpis trafił w echo wysyłki z Raroga (pierwszy prompt świeżej sesji zakłada
   * plik) — inaczej historia niesie notkę jako wiadomość z `promptBlocked`. Dymka `user` z cytatem nie ma
   * nigdy.
   *
   * `echoed` = cytat trafił w echo wysyłki z Raroga (ten sam `#takeEcho`, ze sprawdzeniem czasu każdego wpisu
   * okna); trafienie zużywa wpis. `key` to klucz echa cytatu (`echoKey`), `token` — wpis echa odroczonego,
   * `send` — numer wysyłki z `dropEcho` trafionego wpisu. `prompt` to PEŁNY cytat po `humanTextOf`;
   * nieobecny, gdy wpis go nie niósł. Blokada nie jest wejściem tury (`turn-input` nie leci).
   */
  | {
      type: 'prompt-blocked'; reason: string; promptKept: boolean; prompt?: string; echoed: boolean;
      key?: string; token?: string; send?: number;
    }
  /** Zużycie okna kontekstu PO turze; `kind: 'unknown'` = limit nie jest potwierdzony. */
  | { type: 'usage'; context: ContextLimitState }
  /**
   * Model / effort / tryb odczytane z pliku i ultracode bieżącego procesu CLI (nieobecne = brak dowodu,
   * `null` = dowód przestał się liczyć: start nowego procesu albo luka w odczycie). Emitowane WYŁĄCZNIE przy
   * zmianie wartości. Model, effort and mode are present only when an entry read since the previous event changed
   * a cached value (absent = no news, not "none"); ultracode is present whenever it is known.
   */
  | ({ type: 'meta' } & JsonlMeta)
  /** Zmiana stanu „czeka narzędzie"; `null` = już nie czeka. Emitowane TYLKO przy zmianie. */
  | { type: 'pending'; pending: PendingTool | null }
  /**
   * Nazwa rozmowy z `/rename`: ostatni wpis `custom-title` pliku bieżącej sesji silnika. Emitowane przy
   * zmianie wartości, w zrzucie stanu po odczycie, który wpis przyniósł (okno ogona, przegląd sprzed okna albo
   * odczyt przyrostowy). Pamięć jest per sesja silnika: `repoint` ją zeruje, bez zdarzenia.
   */
  | { type: 'custom-title'; title: string }
  /**
   * Żywe zadania w tle; pusta lista = zgaś plakietkę. Emitowane przy zmianie listy ALBO gdy
   * reduktor zamknął id, którego startu w tym pliku nie było.
   *
   * `ended` to przyrost takich końców od poprzedniego zdarzenia (nieobecne = żadnego). To przede
   * wszystkim końce własnych komend subagentów: listy nie zmieniają, ale odbiorca, który czyta
   * pliki subagentów, zamyka po nich komendę (`docs/background-tasks.md`).
   *
   * `since` to `timestamp` najstarszego wpisu, jaki reduktor widział od swojego zerowania (okno
   * ogona przy podpięciu, przeskok, skrócenie, nowa sesja silnika); nieobecne = żadnego z czasem.
   * Jedzie w KAŻDYM zdarzeniu `tasks`. Odbiorcy służy tylko do oceny zadań, które stoją na
   * liście, więc własne zdarzenie wywołuje wyłącznie wtedy, gdy zmienia się przy NIEPUSTEJ liście
   * (okno otwarte załącznikiem: lista jest, a czas przychodzi dopiero z następnym wpisem).
   */
  | { type: 'tasks'; tasks: readonly BackgroundTask[]; ended?: readonly string[]; since?: string }
  /**
   * Artefakty opublikowane w bieżącej rozmowie (`docs/artifacts.md`), w kształcie protokołu: driver
   * przepisuje je 1:1 na zdarzenie managera. Pusta lista = brak artefaktów.
   *
   * Pierwsze zdarzenie po podpięciu idzie ZAWSZE, także puste: po przeglądzie i oknie albo, gdy pliku
   * rozmowy nie ma (glob po uuid nic nie znalazł, identyfikator spoza wzorca), od razu. Odbiorca trzyma
   * listę poprzedniego followera (wymiana drivera zachowuje sesję) i tylko ta wypłata ją nadpisuje.
   * Potem wyłącznie zmiana listy, także pusta po `repoint`. Za każdym razem nowa tablica z nowymi
   * obiektami.
   */
  | { type: 'artifacts'; artifacts: readonly SessionArtifact[] }
  /**
   * Plik transkryptu ZMIENIŁ ADRES, treść jest ta sama.
   *
   * Nie jedzie do managera i nie widzi go użytkownik: to sygnał dla SATELITÓW (puls katalogu,
   * czytnik workflow), które trzymają własny cache katalogu obok transkryptu. Bez niego Rarog
   * czyta rozmowę z nowego adresu, ale puls i rozkład workflow zostają przy starym.
   */
  | { type: 'relocated'; path: string; dir: string }
  /** Plik transkryptu nie powstaje — treści nie będzie i użytkownik ma to wiedzieć. */
  | { type: 'error'; reason: 'no-transcript' };

/** Pamięć zamknięć wątku głównego z followera ({@link JsonlFollower.closedToolUses}). */
export interface ClosedToolUses {
  readonly closed: readonly ClosedTool[];
  /** `PendingTracker.lostAt` (`jsonl-pending.ts`): najpóźniejsza chwila zamknięcia, którego pamięć nie ma. */
  readonly lostAt: number | null;
}

export interface JsonlFollower {
  /** Jednokonsumencki strumień (czyta go pump drivera). */
  readonly events: AsyncIterable<FollowEvent>;
  /** `/clear`: ten sam panel, nowy plik. Wstawia wiadomość systemową i czyta nową historię. */
  repoint(agentSessionId: string): void;
  /**
   * Rejestruje tekst wysłany przez Raroga, żeby jego echo z jsonl NIE trafiło do transkryptu.
   *
   * Z `token` (echo odroczone): wpis tego promptu z pliku nie znika, tylko idzie dalej
   * z polem `echoToken` — manager podstawia w to miejsce wstrzymaną wiadomość. Taki wpis okna
   * zużywa wyłącznie wpis pliku z czasem nie starszym niż rejestracja (zapas
   * {@link ECHO_TOKEN_SKEW_MS}): prompt wpisany wcześniej w terminalu o tym samym tekście, jeszcze
   * nieprzeczytany, nie zje tokenu nowej wysyłki.
   *
   * `send` — numer wysyłki u wołającego (driver): wpis okna niesie go do zdarzenia `prompt-blocked`, więc
   * blokada hooka wskazuje DOKŁADNIE tę wysyłkę, której echo zużyła; numer znika razem z wpisem okna
   * (zużycie przez zwykły wpis `user`, przycięcie, TTL), więc nie może wskazać wysyłki, która już doszła.
   *
   * `ttlMs` — a shorter life for this entry than {@link ECHO_TTL_MS}: the echo of a command that may leave no entry in
   * the file, so that it cannot swallow the same text typed later.
   */
  dropEcho(text: string, token?: string, send?: number, ttlMs?: number): void;
  /** Wycofuje wpis okna z tym tokenem — wysyłka, która go zarejestrowała, nie doszła. */
  forgetEcho(token: string): void;
  /**
   * Second expected text of the window entry with this token: the prompt field after a paste onto other text (a draft
   * at the desk), compared without whitespace. Exact equality only, never "contains".
   */
  joinEcho(token: string, field: string): void;
  /**
   * UZBRAJA strażnika „transkrypt nie powstaje".
   *
   * Alarm ma sens dopiero wtedy, gdy jest POWÓD oczekiwać pliku: Rarog wysłał do panelu
   * wiadomość albo agent ruszył z turą. Panel, który stoi na powłoce i nie dostał ani jednego
   * promptu, pliku nie ma z definicji — i to jest stan zdrowy, a nie awaria (alarm dotyczy sesji,
   * które PISZĄ, a mimo to nie mają transkryptu). Wołanie jest idempotentne: karencja liczy się
   * od PIERWSZEGO uzbrojenia, więc druga wiadomość nie odsuwa alarmu w nieskończoność.
   *
   * Each call also looks a file not found yet up now ({@link JsonlFollower.lookUpTranscript}).
   */
  expectTranscript(): void;
  /**
   * Looks a file not found yet up now instead of at the next retry (the driver calls it when the pane enters a block).
   * Requests share the one retry chain. Until a lookup that began after the request ends, `hasTranscript()` answers
   * `'unknown'`, not the `'no'` of an earlier lookup. Nothing happens when the path is known, the file is open or the
   * id is not a session id. Optional, because follower stubs in tests read no file.
   */
  lookUpTranscript?(): void;
  /**
   * Czy plik transkryptu jest ZNALEZIONY — z trzecią odpowiedzią „jeszcze nie wiem".
   *
   * Driver używa tego do decyzji, czy WARTO czekać na wpis `tool_use` z jsonl, zanim oceni
   * dialog z ekranu (karencja jsonl ↔ ekran). Dwie odpowiedzi to za mało:
   * między podpięciem (albo `repoint()`) a końcem globu po uuid ścieżka jest po prostu
   * nieustalona, a `false` w tym oknie kazało driverowi ocenić dialog NATYCHMIAST — na
   * najgorszym możliwym ekranie, w pół przemalowania TUI. `'unknown'` każe mu poczekać
   * karencję (nic nie tracimy), `'no'` — dopiero po nieudanym globie — pozwala ruszyć bez
   * zwłoki (dialog zaufania stoi, ZANIM plik powstanie).
   */
  hasTranscript(): TranscriptPresence;
  /**
   * Proces CLI, który JAKO JEDYNY pisze rozmowę tego followera, wystartował o `startedAtMs`
   * (milisekundy epoki; z rejestru procesów CLI).
   *
   * Follower podaje tę chwilę maszynie stanów zadań w tle, a ta zamyka subagentów, których ostatni
   * dowód życia jest starszy: CLI po restarcie procesu nie zapisuje o nich nic (fixture
   * `tasks/measured/resume-cli-2.1.296.jsonl`). Wołający może
   * powtarzać tę samą wartość przy każdym odczycie rejestru: do maszyny stanów idzie tylko ZMIANA.
   * Follower pamięta wartość do `repoint()` (inna rozmowa to inne pytanie) i podaje ją każdemu
   * reduktorowi, który założy po drodze (skrócenie pliku, przeskok). Bez wywołania reguły nie ma.
   */
  noteProcessStart(startedAtMs: number): void;
  /**
   * Rarog zażądał ultracode w tej rozmowie o `atMs` (flaga startu albo komenda `/effort ultracode`).
   *
   * Uzbraja regułę pierwszej tury (`createUltracodeTracker`): pierwsza odpowiedź na prompt człowieka młodszy od
   * żądania, przed którą plik nie dał znacznika, znaczy „CLI ultracode nie włączyło” i daje `ultracode: false`.
   * Bez żądania brak znacznika niczego nie zmienia. Chwila jest też odcięciem historii, dopóki follower nie zna
   * startu procesu (`noteProcessStart`). Pamiętana do `repoint()` (inna rozmowa to inne pytanie) albo do startu
   * nowego procesu spoza Raroga, gdy żądanie nie jest młodsze od startu poprzedniego. `firstTurn: false`
   * (wznowienie z flagą: pierwsza tura nie ma załącznika, bo stoi on w historii) zostawia samo odcięcie.
   */
  noteUltracodeRequest(atMs: number, firstTurn?: boolean): void;
  /**
   * Niesparowane `tool_use` wątku głównego, przeczytane do tej chwili (kolejność bloków; kopia). Dowód
   * „dialog stoi” trybu cienia liczy z nich otwarte wywołania tej samej nazwy i skrótu wejścia. `null` = nie wiem
   * (brak pliku albo nic jeszcze nie przeczytane): pusta lista znaczy wyłącznie „przeczytane, nic nie stoi” (także plik
   * skrócony do zera), a ta zabiera dowód i zwalnia hook. Opcjonalna, bo atrapy followera w testach nie czytają pliku.
   */
  openToolUses?(): readonly PendingTool[] | null;
  /**
   * Ostatnie zamknięte `tool_use` wątku głównego (wynikiem albo końcem tury) z chwilą wpisu, który je zamknął,
   * i najpóźniejsza chwila zamknięcia, którego ta pamięć nie ma (`lostAt`: wyparte ponad limit, wynik bez znanego
   * `tool_use`, okno ogona zaczęte w środku pliku, luka odczytu albo skrócenie pliku); ta sama niewiedza co
   * {@link openToolUses}. Kanał zgód (warstwa 1) rozpoznaje po nich, że transkrypt poszedł dalej niż prośba hooka.
   * Opcjonalna, bo atrapy followera w testach nie czytają pliku.
   */
  closedToolUses?(): ClosedToolUses | null;
  /**
   * Human prompts waiting in the CLI queue, counted from the file (`jsonl-queue.ts`); `unknown` before the first read
   * and after a part of the file the follower did not read, until the next turn end. Optional, because follower stubs
   * in tests read no file.
   */
  cliQueue?(): CliQueueRead;
  /** The popAll entries counted from the file so far, a mark for `popsSince` (`jsonl-queue.ts`). Optional, as above. */
  cliQueuePops?(): CliQueuePops;
  /**
   * Reads the file tail now instead of at the next watch event or stat tick; resolves after a read that began after
   * the call (a read in flight is followed by one more). Optional, because follower stubs in tests read no file.
   */
  readNow?(): Promise<void>;
  /**
   * The echo window entry of a prompt the CLI handed back from its queue (taken back into the prompt field): the same
   * match as a prompt entry of the file (own text, then the joined field text), without a time cut. The entry leaves
   * the window; its token, if it had one, is returned. Optional, as above.
   */
  claimEcho?(text: string): string | undefined;
  /**
   * Pozycja w pliku wątku głównego dla przeglądu dowodów kanału zgód (`consent-evidence.ts`): ścieżka i bajt nie
   * dalej niż POCZĄTEK linii, której follower jeszcze nie skończył czytać (`#offset` minus bajty niedokończonej
   * linii). Przegląd szuka od niej wstecz początku tury. `null` = nie wiem (brak pliku albo nic nie przeczytane).
   * Opcjonalna, bo atrapy followera w testach nie czytają pliku.
   */
  transcriptOffset?(): TranscriptOffset | null;
  /**
   * The main file the follower found, also before its first read and when it is empty; `null` = not found.
   * Optional, because follower stubs in tests read no file.
   */
  transcriptPath?(): string | null;
  close(): void;
}

/** Odpowiedź {@link JsonlFollower.transcriptOffset}. */
export interface TranscriptOffset {
  readonly file: string;
  /** Bajt nie dalej niż początek niedokończonej linii (przy samych pełnych liniach: koniec przeczytanego). */
  readonly lineStart: number;
}

/** Odpowiedź `hasTranscript()`: `'unknown'` = ścieżka jeszcze nieustalona (glob w toku). */
export type TranscriptPresence = 'yes' | 'no' | 'unknown';

/** Podmienialne parametry czasowe — testy nie mają czekać 60 s na poll. */
export interface FollowTiming {
  batchMs?: number;
  statTickMs?: number;
  missingFastMs?: number;
  missingWindowMs?: number;
  missingSlowMs?: number;
  echoTtlMs?: number;
  echoWindow?: number;
  /** Po tylu ms bez pliku leci `error: 'no-transcript'` (raz na sesję silnika). */
  graceMs?: number;
  /** Odroczenie `pending: null` po `repoint()` — patrz `PENDING_REPOINT_GRACE_MS`. */
  pendingRepointGraceMs?: number;
}

export interface JsonlFollowOptions {
  cwd: string;
  agentSessionId: string;
  /** Korzeń magazynu CLI. Domyślnie `~/.claude/projects` (testy dają katalog tymczasowy). */
  root?: string;
  /** Zegar dla okna dedup — wstrzykiwany, bo TTL echa testujemy bez czekania 10 s. */
  now?: () => number;
  /** PORCJA odczytu historii (podwaja się przy każdym obrocie), nie całe okno. */
  historyBytes?: number;
  historyMessages?: number;
  /** Twardy sufit bajtów historii. Domyślnie `HISTORY_MAX_BYTES`. */
  historyMaxBytes?: number;
  /** Sufit jednego odczytu; większa luka = przeskok do końca (patrz `#drainOnce`). */
  maxReadBytes?: number;
  /** `false` wyłącza `fs.watch` i zostawia sam tick `stat` (determinizm w testach). */
  watch?: boolean;
  timing?: FollowTiming;
  /**
   * Limit okna kontekstu, jeśli jest ZNANY z góry.
   *
   * Wypełniany wyłącznie wtedy, gdy RAROG sam podał `--model` i model jest w
   * `KNOWN_CONTEXT_LIMITS`. Sesja bez flagi modelu (czyli domyślna) startuje jako
   * `unknown` i taka zostaje do zrzutu status line albo modelu z tabeli w jsonl — konto
   * użytkownika może mieć ustawiony wariant `[1m]`, a identyfikator modelu w jsonl okna zwykle
   * nie rozstrzyga (`jsonl-usage.ts`). Granica kompakcji okna nie potwierdza.
   */
  knownContextLimit?: number;
  /**
   * Katalog zrzutów status line. Domyślnie `~/.claude/statusline` (testy dają katalog tymczasowy).
   *
   * To STĄD bierze się rozmiar okna kontekstu — jedyne miejsce, w którym silnik podaje go wprost
   * (`statusline.ts`). Brak katalogu jest w pełni poprawnym stanem: Rarog wraca wtedy do szacunku.
   */
  statuslineRoot?: string;
  /**
   * Odczyt pliku — podmienialny WYŁĄCZNIE w testach.
   *
   * Domyślne `sizeOf`/`readRange` z założenia nie rzucają, więc jedyny sposób, żeby sprawdzić
   * bezpiecznik `#prime` (wyjątek w środku `await` nie ma prawa zabić followera), to
   * podstawić odczyt, który rzuca. Produkcja tego pola nie ustawia.
   */
  io?: Partial<FollowIo>;
  /** Dziennik awarii followera (jedna linia na incydent). Domyślnie `console.warn`. */
  logger?: (message: string) => void;
  /**
   * Przegląd pliku sprzed okna ogona dla zadań w tle (`background/main-scan.ts`): sufit
   * rozmiaru, powyżej którego przegląd się nie odbywa (`maxBytes`), porcja odczytu (`chunkBytes`)
   * i próg rozmiaru pliku, od którego linia logu podaje czas (`logBytes`). Domyślne wartości stoją
   * przy stałych; testy zmniejszają je do bajtów. `open` podmienia otwarcie pliku, żeby test mógł
   * popsuć sam przegląd, a nie odczyt okna. `titleOpen` i `titleMaxBytes` to samo dla przeglądu nazwy
   * rozmowy.
   */
  tasksScan?: TasksScanOptions;
  /**
   * Rozpoznanie promptu zablokowanego przez hook (`RAROG_PROMPT_BLOCK` ≠ `0`, domyślnie włączone). `false` =
   * wpis blokady pomijany jak przed rozpoznaniem: ani zdarzenia, ani notki.
   */
  promptBlock?: boolean;
}

/**
 * Ustawienia przeglądu pliku sprzed okna ogona (patrz `JsonlFollowOptions.tasksScan`). Te same dostaje
 * przegląd listy artefaktów po skróceniu pliku i przeskoku (`#restartArtifacts`).
 */
export interface TasksScanOptions {
  maxBytes?: number;
  chunkBytes?: number;
  logBytes?: number;
  open?: MainScanOptions['open'];
  titleOpen?: MainScanOptions['open'];
  /** Sufit przeglądu nazwy rozmowy; domyślnie {@link TITLE_SCAN_MAX_BYTES}. */
  titleMaxBytes?: number;
}

/** Niskopoziomowy odczyt pliku transkryptu (patrz `JsonlFollowOptions.io`). */
export interface FollowIo {
  sizeOf(path: string): Promise<number | null>;
  readRange(
    path: string, start: number, length: number,
  ): Promise<{ text: string; bytesRead: number } | null>;
}

/**
 * OCZEKIWANA ścieżka pliku transkryptu — pierwszy strzał, nie prawda.
 *
 * `agentSessionId` pochodzi z herdr, ale traktujemy go jak wejście NIEZAUFANE: trafia do `join()`,
 * więc `../../…` czytałoby dowolny plik konta użytkownika. To jest granica traversalu.
 *
 * Follower NIE używa już tej funkcji wprost: sesja wznowiona międzykatalogowo (i rozwidlona)
 * pisze do pliku w slugu ORYGINALNYM, więc plik lokalizuje `locateTranscript` z
 * `transcript-path.ts` (slug, a po pudle glob po uuid). Funkcja zostaje jako czysty opis
 * konwencji nazw magazynu CLI — i jako jedyne miejsce, gdzie ta konwencja jest zapisana.
 *
 * @returns ścieżka albo `null`, gdy identyfikator nie jest identyfikatorem sesji silnika.
 */
export function transcriptPathFor(
  root: string, cwd: string, agentSessionId: string,
): string | null {
  if (!ENGINE_SESSION_ID_PATTERN.test(agentSessionId)) return null;
  return join(root, projectSlug(cwd), `${agentSessionId}.jsonl`);
}

// ---------------------------------------------------------------------------
// Odczyt pliku (niskopoziomowy, nigdy nie rzuca)
// ---------------------------------------------------------------------------

/** Tożsamość pliku `dev:ino`; `null` = brak pliku albo błąd `stat`. */
async function fileIdOf(path: string): Promise<string | null> {
  try {
    const info = await stat(path);
    return info.isFile() ? `${String(info.dev)}:${String(info.ino)}` : null;
  } catch {
    return null;
  }
}

/** Jedna linia o wyjątku do dziennika — bez stosu, bo to nie jest awaria serwera. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Tekst wiadomości użytkownika w postaci porównywalnej z tym, co Rarog wysłał. */
function userTextOf(blocks: readonly InternalBlock[]): string {
  return blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text.text)
    .join('\n')
    .trim();
}

/** {@link echoKey} without any whitespace: the key of a field read from the screen, which wraps and indents lines. */
function squashEchoKey(text: string): string {
  return echoKey(text).replace(/\s+/g, '');
}

/** Ścieżka załącznika doklejona przez driver: `<cokolwiek>/.rarog-uploads/<plik>` (katalog z `uploads.ts`). */
const UPLOAD_PATH = new RegExp(String.raw`\S*/${UPLOAD_DIR_NAME.replaceAll('.', '\\.')}/\S+`, 'g');

/**
 * Klucz porównania echa — wspólny dla strony ZAPISU (`dropEcho`) i ODCZYTU (`#takeEcho`).
 *
 * Prompt z załącznikami wraca z jsonl PRZEBRANY (zmierzone na żywo):
 * CLI dokleja znaczniki `[Image #N]`, import zamienia blok obrazka na `[image]` (`IMAGE_PLACEHOLDER`),
 * a po stronie ZAPISU wisi jeszcze trzeci artefakt — driver rejestruje tekst z DOKLEJONYMI
 * ścieżkami uploadów (`… .rarog-uploads/…png`, {@link UPLOAD_PATH}), które CLI po swojej stronie ZJADA,
 * zamieniając je właśnie w `[Image #N]`. Klucz zdejmuje wszystkie trzy i normalizuje białe znaki linii.
 * Czwarty artefakt: pole promptu CLI zamienia KAŻDY tabulator na cztery spacje, także w środku linii
 * (tabela TSV; zmierzone na CLI 2.1.304), więc każdy
 * ciąg spacji i tabulatorów — również pojedynczy `\t` — liczy się jako jedna spacja.
 */
export function echoKey(text: string): string {
  return text
    .replace(/\[Image #\d+\]/g, '')
    .replace(UPLOAD_PATH, '')
    .split('\n')
    .map((line) => line.trim().replace(/[ \t]+/g, ' '))
    .filter((line) => line !== '' && line !== IMAGE_PLACEHOLDER.text)
    .join('\n');
}

/**
 * Klucz echa wywołania komendy: {@link echoKey} z nazwą komendy (pierwszy token) małymi literami
 * i jedną spacją przed argumentami. CLI zapisuje nazwę kanoniczną (`/clear`, zmierzone na 2.1.302), a strażnik
 * Raroga przepuszcza ją w każdej wielkości liter (`/CLEAR`); argumenty CLI trzyma osobno, więc import składa „/nazwa
 * args” z jedną spacją, choć z telefonu przyszła nowa linia albo tabulator. Treść
 * argumentów zostaje dosłownie, z wewnętrznymi nowymi liniami.
 */
export function commandEchoKey(key: string): string {
  const split = /^(\S+)\s+([\s\S]*)$/.exec(key);
  if (split === null) return key.toLowerCase();
  return `${(split[1] ?? '').toLowerCase()} ${split[2] ?? ''}`;
}

// ---------------------------------------------------------------------------
// Follower
// ---------------------------------------------------------------------------

/**
 * Podpis listy zadań w tle — po nim follower poznaje ZMIANĘ, a tylko zmiana jedzie na drut.
 *
 * Obejmuje wszystko, co reduktor zmienia w zadaniu PO jego otwarciu. Identyfikatory rozstrzygają
 * o tym, co stoi na liście, a `waitingSince` o tym, czy subagent pracuje, czy stoi: bez niego
 * przejście pracuje ↔ czeka nie wyszłoby nigdy, bo lista identyfikatorów zostaje ta sama. Opis
 * dochodzi po otwarciu tylko agentowi sprzed okna (z nazwy w meldunku). Reszta pól powstaje raz
 * przy starcie i już się nie rusza. Pusta lista ma podpis pusty — na tym stoją zerowania followera.
 *
 * Końców bez startu podpis NIE obejmuje, bo listy nie zmieniają: drugim powodem emisji jest
 * licznik `#endsSent` followera, porównywany z `unstartedEnds` reduktora po każdym wpisie.
 */
function tasksSignature(tasks: readonly BackgroundTask[]): string {
  return tasks
    .map((task) => JSON.stringify([task.id, task.waitingSince ?? null, task.description ?? null]))
    .join('|');
}

/**
 * Igła przeglądu nazwy rozmowy: typ wpisu `custom-title` tak, jak stoi w linii, w cudzysłowie. Cytat
 * w treści rozmowy ma cudzysłów po ukośniku, więc go nie łapie; fałszywe „tak” kosztuje jedno parsowanie.
 */
const CUSTOM_TITLE_NEEDLE = Buffer.from('"custom-title"', 'latin1');
/** Porcja odczytu przeglądu nazwy rozmowy. */
const TITLE_SCAN_CHUNK_BYTES = 1024 * 1024;
/**
 * Sufit przeglądu nazwy rozmowy: ten sam co przeglądu pliku głównego przed oknem, 1 GiB. Pomiar
 * i powód wartości stoją przy `MAIN_SCAN_MAX_BYTES` (największy plik rozmowy 236 MiB,
 * ok. 2,5 ms na MiB).
 */
export const TITLE_SCAN_MAX_BYTES = MAIN_SCAN_MAX_BYTES;
/** Sufit długości linii w przeglądzie; wpis `custom-title` ma kilkadziesiąt bajtów. */
const TITLE_SCAN_LINE_MAX_BYTES = 1024 * 1024;

/**
 * Nazwa rozmowy z wpisu `{type: 'custom-title', customTitle, sessionId}`; `null` = inny wpis albo nazwa
 * pusta. Kształt z pomiaru `/rename` (fixture `commands/measured/rename-clear-2.1.302.jsonl`) i z plików
 * rozmów CLI 2.1.311–2.1.319. Wpis `agent-name` nazwy nie zmienia.
 */
export function customTitleOf(entry: unknown): string | null {
  const record = asRecord(entry);
  if (record?.['type'] !== 'custom-title') return null;
  const title = record['customTitle'];
  return typeof title === 'string' && title.trim() !== '' ? title : null;
}

/** Fraza linii logu o dopisku meldunku agenta, którego reduktor nie zna (jedna na proces). */
export const UNKNOWN_AGENT_NOTE_LOG = 'background tasks: unknown note in an agent task notification';

/**
 * Czy linia {@link UNKNOWN_AGENT_NOTE_LOG} już wyszła. RAZ NA PROCES, nie na followera: zmiana
 * zdania w nowym CLI dotyczy każdej sesji naraz, a linia na sesję i na każde podpięcie panelu
 * zasypałaby log tym samym. Licznik prowadzi reduktor, follower tylko go ogłasza.
 */
let unknownAgentNoteLogged = false;

/**
 * Wpis okna echa: `token` ma wpis echa odroczonego, `at` to chwila rejestracji, `send` — numer wysyłki
 * u wołającego (`dropEcho`), oddawany przy blokadzie hooka.
 */
interface EchoEntry {
  text: string;
  /** {@link JsonlFollower.joinEcho}: the field after a paste onto a draft, without whitespace. */
  joined?: string;
  at: number;
  token?: string;
  send?: number;
  /** Own life of the entry instead of the follower's TTL ({@link JsonlFollower.dropEcho}). */
  ttlMs?: number;
}

class Follower implements JsonlFollower {
  readonly #queue = new AsyncEventQueue<FollowEvent>();
  readonly #root: string;
  readonly #cwd: string;
  readonly #now: () => number;
  readonly #historyBytes: number;
  readonly #historyMessages: number;
  readonly #historyMaxBytes: number;
  readonly #maxReadBytes: number;
  readonly #useWatch: boolean;
  readonly #batchMs: number;
  readonly #statTickMs: number;
  readonly #missingFastMs: number;
  readonly #missingWindowMs: number;
  readonly #missingSlowMs: number;
  readonly #echoTtlMs: number;
  readonly #echoWindow: number;
  readonly #graceMs: number;
  readonly #pendingRepointGraceMs: number;
  readonly #knownContextLimit: number | undefined;
  readonly #io: FollowIo;
  readonly #log: (message: string) => void;
  readonly #tasksScan: TasksScanOptions & { logBytes: number };
  /** Rozpoznanie promptu zablokowanego przez hook (`JsonlFollowOptions.promptBlock`). */
  readonly #promptBlock: boolean;

  /** Identyfikator sesji silnika; `null` = nie przeszedł wzorca, transkryptu nie będzie. */
  #agentSessionId: string | null = null;
  /** Rośnie przy każdym otwarciu sesji silnika; unieważnia odczyty w locie (patrz `#openSession`). */
  #generation = 0;
  /** Ścieżka bieżącego pliku; `null` = jeszcze nieznaleziona (glob po uuid). */
  #path: string | null = null;
  /**
   * Czy glob po uuid ZAKOŃCZYŁ SIĘ choć raz w tej sesji silnika (niezależnie od wyniku)?
   *
   * Rozróżnia „pliku nie ma" od „jeszcze nie szukaliśmy" — to druga połowa odpowiedzi
   * `hasTranscript()`. Zeruje się przy każdym otwarciu sesji (start, `repoint()`), bo nowy uuid
   * to nowe pytanie.
   */
  #pathLookedUp = false;
  /** Lookup requests of this engine session; a new session gets a new one, so an old lookup in flight answers none. */
  #lookups = new LookupRequests();
  /** The armed retry of the lookup (`#armLookup`): one at a time, so requests never start a second chain. */
  #lookupTimer: ReturnType<typeof setTimeout> | null = null;
  /** Ile BAJTÓW pliku już skonsumowaliśmy. */
  #offset = 0;
  /**
   * Plik skrócony do zera: znany i pusty. Odróżnia `#offset === 0` po skróceniu od `#offset === 0` przed pierwszym
   * odczytem, w którym pusty tracker jest pusty z niewiedzy (`openToolUses`, `closedToolUses`). Zeruje go `repoint()`.
   */
  #knownEmpty = false;
  /** Ogon bez `\n` — zapis jest atomowy, ale odczyt potrafi wejść w środek linii. */
  #partial = '';
  #primed = false;
  /**
   * Pokolenie, dla którego `#prime` właśnie pracuje; `null` = żadne. Otwarcie pliku ma w środku
   * `await` (glob, odczyt okna, przegląd sprzed okna), a `#prime` wołają też timery ponowień:
   * drugie wejście w trakcie pierwszego czytałoby ten sam plik drugi raz, wysłało historię po raz
   * drugi i podmieniło reduktor zadań, który zdążył już przyjąć wpisy z odczytu przyrostowego.
   * Numer pokolenia zamiast flagi, bo `/clear` w trakcie ma pozwolić
   * otworzyć NOWY plik od razu, bez czekania na powrót starego odczytu.
   */
  #primingGen: number | null = null;
  /** The read loop in flight ({@link #readMore}), or `null`. */
  #reading: Promise<void> | null = null;
  #readAgain = false;
  #closed = false;
  #watcher: FSWatcher | null = null;
  #timers = new Set<ReturnType<typeof setTimeout>>();
  #flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Odroczony `pending: null` po `repoint()` — patrz `PENDING_REPOINT_GRACE_MS`. */
  #pendingSettleTimer: ReturnType<typeof setTimeout> | null = null;
  #buffer: FollowEvent[] = [];
  #missingSince = 0;
  /**
   * Czy w ogóle SPODZIEWAMY się pliku?
   *
   * `false` do pierwszej wysłanej wiadomości i do pierwszej tury — a dopóki jest `false`, alarm
   * „transkrypt nie powstaje" nie ma prawa polecieć. Poll pliku leci niezależnie od tej flagi:
   * plik ma być podłapany od razu, gdy powstanie, niezależnie od tego, czy ktoś go oczekiwał.
   */
  #expecting = false;
  #echo: EchoEntry[] = [];
  /**
   * Nazwa ostatniego wywołania komendy w pliku (małymi literami, `''` = żadnego od otwarcia pliku albo od
   * wiadomości spoza komendy). Wynik zapisany wpisem `user` nazwy nie niesie, a stoi zaraz za wywołaniem —
   * po tej nazwie driver poznaje koniec SWOJEJ komendy lokalnej. Pamięć followera, nie importu:
   * mapowanie wpisu jest bezstanowe.
   */
  #lastCommand = '';
  /** One carrier per `/compact` call on the live tail: CLI 2.1.299 writes the call twice (`FileEchoPairing`). */
  #fileEcho = new FileEchoPairing();

  /*
   * Stan czytany z pliku POZA treścią rozmowy.
   *
   * Wszystkie trzy są „ostatnia znana wartość + brudna flaga", a nie strumień zdarzeń: telefon
   * ma dostać JEDNO zdarzenie na partię odczytu, a nie osiem kolejnych sum tokenów z jednej
   * tury. Wypłatę robi `#drainState()` przy zrzucie bufora.
   */
  #usage: UsageTracker;
  #lastUsageSum: number | null = null;
  #context: ContextLimitState | null = null;
  #usageDirty = false;
  #meta: JsonlMeta = {};
  /**
   * Model, effort and mode read from the file since the last `meta` event: the fields of every entry that changed
   * a cached value. Only these leave with the event, so a flush caused by ultracode or by another field does not
   * put old values back over a live change the card already took (`model-set`).
   */
  #metaFresh: Pick<JsonlMeta, 'model' | 'effort' | 'mode'> = {};
  #metaDirty = false;
  /** Ultracode bieżącego procesu CLI; jego `value` to `#meta.ultracode`. Od nowa przy `#resetState`. */
  #ultracode: UltracodeTracker = createUltracodeTracker();
  #pending: PendingTracker = createPendingTracker();
  #cliQueue: CliQueueTracker = createCliQueueTracker();
  #lastPendingId: string | null = null;
  #pendingDirty = false;
  /**
   * Nazwa rozmowy z ostatniego wpisu `custom-title` bieżącej sesji silnika; `null` = nieznana. Zeruje ją
   * tylko nowa sesja silnika (`#resetState`): skrócenie pliku i przeskok jej nie gaszą, a przegląd pliku
   * (`#scanCustomTitle`) najwyżej ją podmienia.
   */
  #customTitle: string | null = null;
  #customTitleDirty = false;
  /**
   * Licznik wpisów `custom-title` przeczytanych oknem albo na żywo i zerowań pamięci. Przegląd pliku zapamiętuje
   * go na starcie, a wynik bierze tylko przy tej samej wartości: wpis przeczytany w trakcie jest nowszy.
   */
  #customTitleSeq = 0;
  /**
   * Numer ostatnio rozpoczętego przeglądu nazwy rozmowy (`#scanCustomTitle`). Każdy przegląd unieważnia
   * poprzednie: skrócenie, przeskok i podmiana pliku zaczynają nowy, a spóźniony przegląd starej treści nie ma
   * prawa nadpisać nazwy z nowej.
   */
  #titleScan = 0;
  /**
   * Tożsamość pliku rozmowy (`dev:ino`) z ostatniego odczytu; `null` = nieznana. Służy tylko nazwie rozmowy:
   * podmiana pliku na plik tej samej albo większej długości nie zmienia rozmiaru w dół, więc bez niej nie byłoby
   * ponownego przeglądu. `EnterWorktree` przenosi plik `rename(2)`-em z tym samym inode, więc to nie jest podmiana.
   */
  #transcriptId: string | null = null;
  /**
   * Katalog zrzutów status line i to, co z niego już wyczytaliśmy.
   *
   * `#statuslineLimit` pełni podwójną rolę: trzyma ostatnio potwierdzoną wartość ORAZ wycisza
   * odpytywanie — dopóki jest `null`, próbujemy przy każdym ticku, bo panel bezczynny zrzuci
   * plik dopiero przy najbliższym renderze stopki. Gdy już mamy liczbę, czytamy wyłącznie
   * wtedy, gdy w pliku rozmowy coś drgnęło (`/model` potrafi zmienić okno w środku sesji).
   * Pierwszy odczyt idzie przy otwarciu pliku, razem z historią (`#primeOnce`).
   */
  #statuslineRoot: string;
  #statuslineLimit: number | null = null;
  /**
   * Pokolenie, którego odczyt zrzutu właśnie trwa; `null` = żaden. Numer zamiast flagi z tego
   * samego powodu co `#primingGen`: odczyt starej sesji w locie nie blokuje odczytu nowej po
   * `repoint()`, który `#primeOnce` robi przed pierwszym stanem okna.
   */
  #statuslineReadingGen: number | null = null;
  #tasks: BackgroundTasksTracker = createBackgroundTasksTracker();
  /**
   * Chwila startu jedynego procesu CLI tej rozmowy (ms epoki, `noteProcessStart`); `null` = nikt
   * jej nie podał albo po `repoint()` jeszcze nie przyszła. Dostaje ją każdy nowy reduktor zadań.
   */
  #processStartedAt: number | null = null;
  /** Podpis listy zadań w tle — po nim poznajemy ZMIANĘ, a tylko zmiana jedzie na drut. */
  #lastTasksKey = '';
  /**
   * Czy zdarzenie `tasks` już wyszło. Pierwsza wypłata po podpięciu idzie BEZWARUNKOWO, także pusta, jak lista
   * artefaktów (`#artifactsKey`): wymiana drivera zachowuje sesję razem z listą poprzedniego followera, a pusta
   * lista nowego nie różniłaby się od pustego podpisu. Ustawiane przy samej wypłacie (`#drainState`), bo
   * `repoint` przed nią zeruje brudną flagę, a plik nowej rozmowy ma dostać tę samą gwarancję.
   */
  #tasksPaid = false;
  /**
   * Ile końców bez startu (`unstartedEnds` reduktora) już pojechało w zdarzeniu `tasks`. Drugi,
   * obok podpisu listy, powód emisji: koniec własnej komendy subagenta listy nie zmienia.
   */
  #endsSent = 0;
  /**
   * `since` z ostatniego zdarzenia `tasks` (`''` = bez pola). Trzeci powód emisji: początek okna
   * ustalony PO tym, jak lista już wyszła.
   */
  #sinceSent = '';
  #tasksDirty = false;
  /**
   * Lista artefaktów sesji (`background/artifacts.ts`). Inaczej niż zadania tylko się sumuje: nic
   * jej nie zamyka, więc po zerowaniu (skrócenie pliku, przeskok) nie odbuduje się z przyszłych linii —
   * dlatego zerowanie idzie razem z przeglądem pliku od początku (`#restartArtifacts`).
   */
  #artifacts: ArtifactsTracker = createArtifactsTracker();
  /**
   * Podpis listy z ostatniej wypłaty; `null` = wypłaty jeszcze nie było. Pierwsza wypłata po podpięciu
   * idzie BEZWARUNKOWO, także pusta: odbiorca trzyma listę poprzedniego followera (wymiana drivera
   * zachowuje sesję), a pusta lista nowego nie różniłaby się od pustego podpisu.
   */
  #artifactsKey: string | null = null;
  #artifactsDirty = false;
  /**
   * Fakty o artefaktach przeczytane od zerowania listy, póki trwa przegląd pliku do miejsca zerowania;
   * `null` = przeglądu nie ma. Po udanym przeglądzie idą na jego wynik w tej samej kolejności.
   */
  #artifactsReplay: ArtifactFact[] | null = null;
  /** Numer zerowania listy artefaktów; przegląd z innym numerem oddaje wynik do kosza. */
  #artifactsEpoch = 0;
  /** Alarm „transkrypt nie powstaje" leci RAZ na sesję silnika, nie co tick. */
  #noTranscriptReported = false;
  /** Ile razy z rzędu szukaliśmy zaginionego pliku bez skutku (sufit: `FOLLOW_RELOCATE_TRIES`). */
  #relocateTries = 0;
  /** Najbliższa chwila, w której wolno spróbować ponownie (backoff między próbami). */
  #relocateNextAt = 0;
  /** „Plik zniknął i nie ma go nigdzie" mówimy RAZ, a nie przy każdym ticku `stat`. */
  #relocateReported = false;

  constructor(opts: JsonlFollowOptions) {
    this.#root = opts.root ?? defaultStoreRoot();
    this.#cwd = opts.cwd;
    this.#now = opts.now ?? Date.now;
    this.#historyBytes = opts.historyBytes ?? HERDR_HISTORY_BYTES;
    this.#historyMessages = opts.historyMessages ?? HERDR_HISTORY_MESSAGES;
    // Sufit nie może być mniejszy od porcji — inaczej pierwszy obrót czytałby ponad sufit.
    this.#historyMaxBytes = Math.max(
      this.#historyBytes, opts.historyMaxBytes ?? HISTORY_MAX_BYTES,
    );
    this.#maxReadBytes = opts.maxReadBytes ?? FOLLOW_MAX_READ_BYTES;
    this.#useWatch = opts.watch ?? true;
    const t = opts.timing ?? {};
    this.#batchMs = t.batchMs ?? FOLLOW_BATCH_MS;
    this.#statTickMs = t.statTickMs ?? FOLLOW_STAT_TICK_MS;
    this.#missingFastMs = t.missingFastMs ?? FOLLOW_MISSING_FAST_MS;
    this.#missingWindowMs = t.missingWindowMs ?? FOLLOW_MISSING_WINDOW_MS;
    this.#missingSlowMs = t.missingSlowMs ?? FOLLOW_MISSING_SLOW_MS;
    this.#echoTtlMs = t.echoTtlMs ?? ECHO_TTL_MS;
    this.#echoWindow = t.echoWindow ?? ECHO_WINDOW;
    this.#graceMs = t.graceMs ?? HERDR_TRANSCRIPT_GRACE_MS;
    this.#pendingRepointGraceMs = t.pendingRepointGraceMs ?? PENDING_REPOINT_GRACE_MS;
    this.#knownContextLimit = opts.knownContextLimit;
    this.#statuslineRoot = opts.statuslineRoot ?? defaultStatuslineRoot();
    this.#io = { sizeOf, readRange, ...opts.io };
    this.#log = opts.logger ?? ((message) => { console.warn(message); });
    this.#tasksScan = { ...opts.tasksScan, logBytes: opts.tasksScan?.logBytes ?? TASKS_SCAN_LOG_BYTES };
    this.#usage = createUsageTracker(this.#knownContextLimit);
    this.#promptBlock = opts.promptBlock !== false;

    // Unknown until a history read replaces the tracker; a read that fails before that must not answer "empty".
    this.#cliQueue.lose();
    this.#openSession(opts.agentSessionId);
  }

  get events(): AsyncIterable<FollowEvent> {
    return this.#queue;
  }

  // -------------------------------------------------------------------------
  // API
  // -------------------------------------------------------------------------

  repoint(agentSessionId: string): void {
    if (this.#closed) return;
    /*
     * Pokolenie rośnie TUTAJ, a nie dopiero w `#openSession` — inaczej zostaje otwarte okno
     * między resetem a otwarciem nowego pliku (`#openSession` czeka na `await
     * transcriptHasConversation`). W tym oknie `#path` wskazuje jeszcze STARY plik, a `#offset`
     * jest już wyzerowany: tik `stat`, który wpadnie w tę szczelinę, czyta stary plik OD ZERA
     * i wsypuje całą poprzednią rozmowę do świeżej sesji jako wiadomości „na żywo" (zmierzone:
     * po `/clear` wracały wiadomości, karta zgody i plakietka „w tle").
     */
    this.#generation += 1;
    // Nowa rozmowa w tym samym panelu: jej historia potrafi nieść prompt tury, która już trwa,
    // a historii nikt nie liczy — rachunek wejść tury przestaje być pełny.
    this.#emitNow({ type: 'turn-input', lost: true });
    this.#stopWatch();
    this.#offset = 0;
    this.#knownEmpty = false;
    this.#partial = '';
    this.#primed = false;
    // Start procesu dotyczył POPRZEDNIEJ rozmowy: nową może pisać inny proces albo kilka naraz.
    // Wołający poda go ponownie przy najbliższym odczycie rejestru, już dla nowego uuid.
    this.#processStartedAt = null;
    this.#resetState();
    // Stary uuid gaśnie OD RAZU: spóźniony timer `#prime`/`#scheduleMissing` nie ma prawa
    // ponownie otworzyć starego pliku w oknie, w którym rozstrzyga się wariant komunikatu.
    // Strażnik też rozbraja się synchronicznie — `#openSession` zrobi to ponownie, ale
    // dopiero po `await` w `#repoint`, a timer alarmu może wypaść dokładnie w tej szczelinie
    // (zmierzone: migotliwy test „`/clear` ROZBRAJA strażnika").
    this.#agentSessionId = null;
    this.#expecting = false;
    // Stara ścieżka przestaje być odpowiedzią NA COKOLWIEK: do końca globu nowego uuid
    // `hasTranscript()` ma mówić „nie wiem", a nie „tak" o pliku poprzedniej sesji.
    this.#path = null;
    this.#pathLookedUp = false;
    void this.#repoint(agentSessionId);
  }

  /**
   * Dokończenie `repoint()` — wariant komunikatu i otwarcie nowej sesji.
   *
   * `/clear` i `/resume` przychodzą TYM SAMYM zdarzeniem `session-changed` (supervisor nie zna
   * przyczyny). Rozróżnia je TREŚĆ pliku nowego uuid: po `/resume` są w nim wypowiedzi, po
   * `/clear` nie ma żadnej — i to mimo że sam PLIK już jest.
   *
   * Test „plik istnieje" jest tu za słaby:
   * CLI zakłada plik nowej sesji w tej samej chwili, w której czyści
   * panel, i wpisuje do niego tytuł panelu, tryb, snapshot plików i echo samej komendy —
   * a `session-changed` przychodzi już po tym. Szczegóły sondy: `transcriptHasConversation`.
   *
   * Wyścig „`/clear` + natychmiastowy prompt w terminalu" nadal może skłamać w stronę
   * `/resume`, ale wtedy historia i tak pokazuje dokładnie to, co panel.
   */
  async #repoint(agentSessionId: string): Promise<void> {
    let resumed = false;
    if (ENGINE_SESSION_ID_PATTERN.test(agentSessionId)) {
      try {
        const path = await locateTranscript(this.#root, this.#cwd, agentSessionId);
        resumed = path !== null && await transcriptHasConversation(path);
      } catch {
        // Nie wiem = komunikat od `/clear`: gorszy jest komunikat obiecujący historię,
        // której nie będzie, niż „rozmowa została w terminalu" przy rozmowie, która wróciła.
      }
    }
    if (this.#closed) return;
    // Wiadomość leci PRZED historią, a nie razem z nią: gdyby nowy plik nie powstał (użytkownik
    // po `/clear` nic nie napisał), użytkownik i tak musi wiedzieć, dlaczego transkrypt zniknął.
    this.#emitNow({
      type: 'message', role: 'system',
      blocks: [{ type: 'text', text: resumed ? RESUME_REPOINT_MESSAGE : REPOINT_MESSAGE }],
    });
    this.#openSession(agentSessionId);
  }

  expectTranscript(): void {
    if (this.#closed) return;
    if (!this.#expecting) {
      this.#expecting = true;
      // Karencja liczy się od chwili, w której powstał POWÓD oczekiwania — nie od podpięcia
      // drivera. Panel podpięty rano i użyty wieczorem ma dostać pełne 15 s, a nie alarm
      // w tej samej sekundzie, w której poszła pierwsza wiadomość.
      this.#missingSince = this.#now();
    }
    // The file is due now; after the fast window the next retry is seconds away.
    this.lookUpTranscript();
  }

  lookUpTranscript(): void {
    // An open file follows its own relocation tries, and a known path or a missing uuid has nothing to look for.
    if (this.#closed || this.#primed || this.#path !== null || this.#agentSessionId === null) return;
    if (this.#lookups.ask()) this.#armLookup(0);
  }

  hasTranscript(): TranscriptPresence {
    if (this.#path !== null) return 'yes';
    return this.#pathLookedUp && !this.#lookups.unanswered ? 'no' : 'unknown';
  }

  openToolUses(): readonly PendingTool[] | null {
    if (this.#trackerUnknown()) return null;
    return this.#pending.open;
  }

  closedToolUses(): ClosedToolUses | null {
    if (this.#trackerUnknown()) return null;
    return { closed: this.#pending.closed, lostAt: this.#pending.lostAt };
  }

  cliQueue(): CliQueueRead {
    return this.#trackerUnknown() ? 'unknown' : this.#cliQueue.prompts();
  }

  cliQueuePops(): CliQueuePops {
    return this.#cliQueue.pops();
  }

  readNow(): Promise<void> {
    return this.#readMore();
  }

  claimEcho(text: string): string | undefined {
    return this.#takeEcho(text)?.token;
  }

  /**
   * Pusty tracker przed pierwszym odczytem (albo bez pliku) jest pusty z niewiedzy, nie z faktu. Plik skrócony do zera
   * jest znany i pusty (`#knownEmpty`): kanał zgód dostaje pustą listę i utratę pokrycia z chwili skrócenia.
   */
  #trackerUnknown(): boolean {
    return this.#path === null || (this.#offset === 0 && !this.#knownEmpty);
  }

  transcriptPath(): string | null {
    return this.#path;
  }

  transcriptOffset(): TranscriptOffset | null {
    if (this.#path === null || this.#offset === 0) return null;
    // `#partial` to tekst UTF-8: znak rozcięty na granicy odczytu dekoduje się jako U+FFFD (3 bajty), czyli nie
    // mniej bajtów, niż było — pozycja wychodzi przed początkiem linii albo na nim, nigdy za nim.
    return { file: this.#path, lineStart: Math.max(0, this.#offset - Buffer.byteLength(this.#partial, 'utf8')) };
  }

  noteProcessStart(startedAtMs: number): void {
    if (this.#closed || startedAtMs === this.#processStartedAt) return;
    this.#processStartedAt = startedAtMs;
    this.#tasks.processStarted(startedAtMs);
    // Reguła mogła zamknąć agenta: lista jedzie w górę tą samą drogą co po wpisie z pliku.
    this.#syncTasks();
    /*
     * Znacznik ultracode przeczytany przed tą chwilą mógł dopiero teraz zacząć (albo przestać) się liczyć. Drugi,
     * późniejszy start w tym followerze to proces spoza Raroga (Rarog każde swoje uruchomienie podpina nowym
     * driverem), więc żądane `true` sprzed startu poprzedniego procesu też zjeżdża z karty jako `null`.
     */
    if (this.#ultracode.processStarted(startedAtMs)) this.#syncUltracode();
  }

  noteUltracodeRequest(atMs: number, firstTurn = true): void {
    if (this.#closed) return;
    this.#ultracode.requested(atMs, firstTurn);
  }

  dropEcho(text: string, token?: string, send?: number, ttlMs?: number): void {
    const normalized = echoKey(text);
    if (normalized === '') return;
    this.#expireEcho();
    this.#echo.push({
      text: normalized, at: this.#now(),
      ...(token === undefined ? {} : { token }), ...(send === undefined ? {} : { send }),
      ...(ttlMs === undefined ? {} : { ttlMs }),
    });
    /*
     * Wpisy z tokenem i bez przycinamy OSOBNO, każde do okna: zwykłe echo (sieroty slash-komend,
     * `/model`, wysyłki ze zdjęciem) nie wypycha wstrzymanych promptów, a osiem wstrzymanych nie
     * wypycha świeżego zwykłego echa — inaczej jego prompt wszedłby z pliku drugi raz.
     * Wpis z tokenem znika z wiadomością dla managera: prompt nie dostanie podstawienia.
     */
    const tokened = token !== undefined;
    while (this.#echo.filter((e) => (e.token !== undefined) === tokened).length > this.#echoWindow) {
      const oldest = this.#echo.findIndex((e) => (e.token !== undefined) === tokened);
      const [gone] = this.#echo.splice(oldest, 1);
      if (gone?.token !== undefined) this.#push({ type: 'echo-dropped', token: gone.token });
    }
  }

  forgetEcho(token: string): void {
    this.#echo = this.#echo.filter((e) => e.token !== token);
  }

  joinEcho(token: string, field: string): void {
    const joined = squashEchoKey(field);
    if (joined === '') return;
    for (const entry of this.#echo) if (entry.token === token) entry.joined = joined;
  }

  /** Wpisy starsze niż TTL wypadają; za wpis z tokenem manager dostaje `echo-dropped`. */
  #expireEcho(): void {
    const now = this.#now();
    const kept: EchoEntry[] = [];
    for (const entry of this.#echo) {
      if (now - entry.at < (entry.ttlMs ?? this.#echoTtlMs)) kept.push(entry);
      else if (entry.token !== undefined) this.#push({ type: 'echo-dropped', token: entry.token });
    }
    this.#echo = kept;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#stopWatch();
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    if (this.#flushTimer !== null) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    this.#buffer = [];
    this.#queue.close();
  }

  // -------------------------------------------------------------------------
  // Otwarcie pliku: historia → offset → obserwator
  // -------------------------------------------------------------------------

  #openSession(agentSessionId: string): void {
    /*
     * Numer pokolenia rośnie przy KAŻDYM otwarciu — i to on unieważnia odczyty w locie.
     *
     * `#prime` i `#drainOnce` mają w środku `await` (stat, read), a `/clear` potrafi wpaść
     * dokładnie w tę szczelinę: reset stanu wykonuje się natychmiast, ale odczyt STAREGO pliku
     * kończy się chwilę później i wsypuje jego linie do świeżego stanu — czyli do nowej sesji
     * silnika. Objawy: wiadomości poprzedniej rozmowy dopisane po komunikacie `/clear`, karta
     * zgody sprzed czyszczenia i (dopiero to ujawniło całość) plakietka „w tle"
     * z zadaniem, którego nowa sesja nie zna. Do tego `#offset` starego pliku podstawiał się
     * pod nowy, więc kolejny odczyt startował z losowego miejsca.
     *
     * Sam `#closed` nie wystarczy: follower ŻYJE dalej, zmienia tylko plik.
     */
    this.#generation += 1;
    this.#lookups = new LookupRequests();
    // Identyfikator spoza wzorca = brak transkryptu. Świadomie po cichu: to nie jest sytuacja,
    // z którą użytkownik telefonu może cokolwiek zrobić, a stan panelu dalej działa.
    this.#agentSessionId = ENGINE_SESSION_ID_PATTERN.test(agentSessionId) ? agentSessionId : null;
    this.#path = null;
    // Identyfikator spoza wzorca to odpowiedź OSTATECZNA („nie ma i nie będzie"), a nie okno
    // niepewności — driver nie ma na co czekać. Prawidłowy uuid zaczyna od „nie wiem".
    this.#pathLookedUp = this.#agentSessionId === null;
    // Nowa sesja silnika po starcie panelu nie ma pliku, dopóki ktoś czegoś nie wyśle; po `/clear`
    // plik już jest, ale bez rozmowy (fixture `commands/measured/rename-clear-2.1.302.jsonl`).
    // W obu przypadkach strażnik wraca do stanu rozbrojonego.
    this.#expecting = false;
    // Nowy uuid = nowe pytanie o adres: budżet prób relokacji wraca do pełna.
    this.#relocateTries = 0;
    this.#relocateNextAt = 0;
    this.#relocateReported = false;
    if (this.#agentSessionId === null) {
      // Pliku nie będzie, więc lista zadań i lista artefaktów są puste NA PEWNO: wypłata nadpisuje listy,
      // które odbiorca trzyma po poprzednim followerze (`#payTasks`, `#payArtifacts`).
      this.#payTasks();
      this.#payArtifacts();
      return;
    }
    this.#missingSince = this.#now();
    void this.#prime();
  }

  /**
   * Ustala ścieżkę pliku po UUID.
   *
   * Wynik jest cache'owany na sesję silnika (`#path`): glob po korzeniu magazynu jest tani
   * (42 katalogi), ale wykonywany raz, a nie przy każdym ticku `stat`.
   */
  async #resolvePath(): Promise<string | null> {
    if (this.#path !== null) return this.#path;
    const uuid = this.#agentSessionId;
    if (uuid === null) return null;
    const gen = this.#generation;
    const lookups = this.#lookups;
    const mark = lookups.began();
    let found: string | null;
    try {
      found = await locateTranscript(this.#root, this.#cwd, uuid);
    } finally {
      lookups.ended(mark);
    }
    // Odpowiedź dotyczy TEJ sesji silnika: po `/clear` w trakcie globu wynik opisuje stary uuid
    // i nie ma prawa ani ustawić ścieżki, ani zamknąć okna „nie wiem" nowej sesji.
    if (this.#stale(gen)) return found;
    this.#pathLookedUp = true;
    if (found !== null) {
      this.#path = found;
      // A request left open would make every retry of a failed read of this file immediate.
      lookups.found();
    }
    return found;
  }

  /**
   * Otwarcie pliku z BEZPIECZNIKIEM: wyjątek w środku `await` nie zabija followera.
   *
   * `#prime` jest wołane przez `void this.#prime()` (konstruktor, `#scheduleMissing`), więc
   * odrzucenie obietnicy nie miało kogo obudzić: follower milkł bez
   * ani jednego zdarzenia — bez historii, bez taila i, co gorsza, bez alarmu `no-transcript`,
   * bo strażnik uzbraja się dopiero w `#scheduleMissing`, do którego ścieżka po wyjątku nie
   * dochodziła. Serwer nie ma handlera `unhandledRejection` z założenia (patrz `identity.ts`),
   * więc taki wyjątek to w najlepszym razie cisza, w najgorszym — koniec procesu.
   *
   * Po wyjątku: jedna linia w dzienniku i to samo, co przy braku pliku — `#scheduleMissing`
   * ponawia próbę przy następnym ticku i po karencji mówi głośno, że transkryptu nie ma.
   * `#primed` zostaje `false` (ustawia je dopiero domknięte `#primeOnce`), więc ponowienie
   * czyta plik od nowa zamiast startować tail nad połowicznie wczytanym stanem.
   */
  async #prime(): Promise<void> {
    if (this.#closed || this.#primed) return;
    if (this.#agentSessionId === null) return;
    // Pokolenie z chwili WEJŚCIA — każdy `await` niżej może przepuścić `/clear` (`#openSession`).
    const gen = this.#generation;
    // Ten plik jest już otwierany: drugie wejście (spóźniony timer) nie ma tu nic do zrobienia.
    if (this.#primingGen === gen) return;
    this.#primingGen = gen;
    try {
      await this.#primeOnce(gen);
    } catch (error) {
      if (this.#stale(gen)) return;
      this.#log(
        `rarog: reading transcript ${this.#agentSessionId ?? '?'} failed: `
        + `${describeError(error)} — retrying on the next tick`,
      );
      this.#scheduleMissing();
    } finally {
      // Zwalniamy tylko WŁASNĄ blokadę: po `/clear` pole należy już do otwarcia nowego pliku.
      if (this.#primingGen === gen) this.#primingGen = null;
    }
  }

  async #primeOnce(gen: number): Promise<void> {
    const path = await this.#resolvePath();
    if (this.#stale(gen)) return;
    if (path === null) {
      /*
       * Glob po uuid nie znalazł pliku: rozmowa nie ma jeszcze ani jednej linii, więc nie ma też zadań w tle
       * ani artefaktów. Puste listy wychodzą od razu jako pierwsza wypłata: po wymianie drivera przy
       * panelu, który czeka na pierwszy prompt (`/clear` w czasie przerwy gniazda herdr), albo przy pliku,
       * który zniknął w przerwie, odbiorca zostałby inaczej z listami poprzedniego followera aż do powstania
       * pliku. Kolejne pudła globu nie wypłacają nic.
       */
      this.#payTasks();
      this.#payArtifacts();
      this.#scheduleMissing();
      return;
    }
    // Tożsamość pliku, z którego czytamy historię: odniesienie dla podmiany w `#drainOnce`. Czytana PRZED
    // rozmiarem: podmiana między dwoma `stat` daje wtedy starą tożsamość, więc następny tick ją wykryje i przejrzy
    // cały nowy plik; w odwrotnej kolejności nowa tożsamość szłaby z rozmiarem starego pliku.
    const id = await fileIdOf(path);
    if (this.#stale(gen)) return;
    const size = await this.#io.sizeOf(path);
    if (this.#stale(gen)) return;
    if (size === null) {
      this.#scheduleMissing();
      return;
    }
    this.#transcriptId = id;

    const tail = await this.#readHistory(path, size, gen);
    if (this.#stale(gen)) return;
    if (tail === null) {
      this.#scheduleMissing();
      return;
    }

    /*
     * Zrzut status line czytamy TU, przed wpisami historii.
     * Pierwszy stan okna wychodzi zrzutem bufora `#batchMs` po pierwszej sumie z pętli
     * niżej, a tik `stat` zagląda do zrzutu dopiero po `#statTickMs`: bez tego odczytu apka po
     * podpięciu dostawała limit z innego źródła, który za chwilę skakał. Przed pętlą, a nie po
     * niej, bo pętla uzbraja już zrzut bufora i `await` po niej ścigałby się z jego timerem. Brak
     * zrzutu niczego nie zmienia: dopytuje tik, jak dotąd. Stan nie wychodzi przed historią:
     * od tego miejsca do `#emitNow` historii nie ma już `await`.
     */
    await this.#readStatusline();
    if (this.#stale(gen)) return;

    this.#partial = tail.partial;
    this.#offset = tail.offset;

    const messages = historyMessages(tail.messages, {
      promptBlocked: (m) => this.#promptBlockedEvent(m),
      follow: (m) => this.#followMessage(m),
      takeEcho: (m, command) => this.#takeEcho(userTextOf(m.blocks), m.at, command),
      flush: (batch, event) => {
        if (batch.length > 0) this.#emitNow({ type: 'history', messages: batch });
        this.#emitNow(event);
      },
    });
    /*
     * Stan (zużycie, model, czekające narzędzie) liczymy z CAŁEGO okna historii, ale wypłacamy
     * jedną migawką PO historii, a nie po jednym zdarzeniu na wpis: osiem wpisów asystenta
     * w oknie to osiem rosnących sum tego samego licznika, z których wartość ma tylko ostatnia.
     *
     * Zadania w tle NIE idą w tej pętli: one dostają najpierw część pliku sprzed okna
     * (`#primeTasks` niżej), a kolejność wpisów jest dla reduktora treścią. Sparsowane wpisy okna
     * czekają na swoją kolej w tablicy, żeby nie parsować ich drugi raz.
     */
    const entries: unknown[] = [];
    let coveredFrom: number | null = null;
    // A fresh count for every history read (a retry reads the file again); a window from mid-file misses queue entries.
    this.#cliQueue = createCliQueueTracker();
    if (tail.start > 0) this.#cliQueue.lose();
    const titleSeq = this.#customTitleSeq;
    for (const line of tail.complete.split('\n')) {
      const entry = parseJsonlEntry(line);
      if (entry === null) continue;
      this.#noteState(entry);
      entries.push(entry);
      coveredFrom ??= mainAssistantAt(entry);
    }
    /*
     * Okno ogona zaczęło się w środku pliku (podpięcie do długiej rozmowy: start serwera, nowy panel albo nowy driver po
     * powrocie gniazda herdr): zamknięć sprzed okna tracker nie widział, więc kanał zgód liczy je jako utracone (`lose`),
     * nie jako brak. Chwila utraty to chwila pierwszego wpisu `assistant` wątku głównego w oknie: hook, który wystartował
     * później, zachowuje dowód, bo zamknięcie jego prośby leżałoby w oknie. Okno bez takiego wpisu = utrata do chwili
     * odczytu.
     *
     * Nie pierwszy wpis okna z chwilą, bo plik główny nie idzie w kolejności czasu: `attachment` `queued_command` niesie
     * chwilę wpisania do kolejki, do 22,5 s wcześniejszą niż wyniki zapisane przed nim (CLI 2.1.295, fixture
     * `tasks/incydent-postoj-agenta-2.1.295.jsonl`), a echo `/compact` stoi za podsumowaniem kompakcji ze starszą chwilą
     * (CLI 2.1.299, `queue/measured/compact-2.1.299.jsonl`). Wpis `assistant` wątku głównego w żadnym pliku głównym
     * fixture'ów (225 wpisów w 65 plikach) nie był starszy niż zamknięcie przed nim: odpowiedź modelu przychodzi po
     * zapytaniu, które niesie wcześniejsze wyniki. Nie chwila startu followera: zabrałaby dowód stojącemu hookowi sprzed
     * podpięcia, którego `tool_use` jeszcze nie ma w pliku (hookowi sprzed powrotu gniazda herdr dowód zabiera i tak
     * granica w cyklu kanału zgód, `layer1/cycle.ts`). Przegląd części sprzed okna (`#primeTasks`) zostaje przy
     * zadaniach w tle i artefaktach.
     */
    if (tail.start > 0) this.#pending.lose(coveredFrom ?? this.#now());
    /*
     * Nazwa rozmowy: okno bez wpisu `custom-title` nie znaczy rozmowy bez nazwy. Wpis sprzed okna znajduje
     * przegląd pliku z igłą, w tle: historia i odczyt przyrostowy na niego nie czekają, a wpis przeczytany
     * w międzyczasie jest nowszy i wygrywa.
     */
    if (tail.start > 0 && titleSeq === this.#customTitleSeq) void this.#scanCustomTitle(path, tail.offset);
    /*
     * Historia przeczytana = stan czekającego narzędzia jest już FAKTEM, nie luką po resecie:
     * kasujemy odroczenie i emitujemy stan bieżący — także `null`, bo po `/clear` z nowym
     * plikiem to właśnie `null` gasi kartę zgody poprzedniej sesji silnika.
     */
    if (this.#pendingSettleTimer !== null) {
      clearTimeout(this.#pendingSettleTimer);
      this.#timers.delete(this.#pendingSettleTimer);
      this.#pendingSettleTimer = null;
      this.#pendingDirty = true;
    }
    if (messages.length > 0) {
      this.#emitNow({ type: 'history', messages });
    }
    this.#arm();

    /*
     * Historia już wyszła i stan okna jest uzbrojony: przegląd pliku sprzed okna niczego z tego
     * nie opóźnia. Opóźnia tylko listę zadań w tle i start odczytu przyrostowego, o czas przeglądu
     * (około 1 ms na MiB). Metoda nie rzuca: po historii nie ma już do czego wracać ponowieniem.
     */
    await this.#primeTasks(path, tail, entries, gen);
    if (this.#stale(gen)) return;

    // Dopiero TU, po całej pracy: wyjątek PRZED historią ma zostawić `#primed === false`,
    // żeby ponowienie z `#prime` przeczytało plik od nowa (bezpiecznik w `#prime`).
    this.#primed = true;
    this.#startWatch();
    // Plik mógł urosnąć między `stat` a końcem parsowania — dociągamy resztę tą samą ścieżką.
    void this.#readMore();
  }

  /** Ogon pliku jako historia (`readHistoryTail` w `history-steps.ts`) z oknem i sufitem tego followera. */
  #readHistory(path: string, size: number, gen: number): Promise<HistoryTail | null> {
    return readHistoryTail((p, start, length) => this.#io.readRange(p, start, length), path, size, {
      firstWindow: this.#historyBytes, maxBytes: this.#historyMaxBytes, limit: this.#historyMessages,
      promptBlock: this.#promptBlock, stale: () => this.#stale(gen),
    });
  }

  /**
   * Zadania w tle przy podpięciu: reduktor dostaje linie o zadaniach z CAŁEGO pliku, nie tylko
   * z okna ogona.
   *
   * Okno ogona (do `HISTORY_MAX_BYTES`) wystarcza na historię rozmowy, ale lista zadań z samego
   * okna gubi wszystko, co zaczęło się wcześniej: subagent, którego start i wznowienie leżą przed
   * oknem, był po każdym restarcie Raroga niewidoczny do swojego następnego postoju, a własne
   * komendy subagentów sprzed okna miały „los nieznany". Dlatego najpierw idzie część pliku sprzed
   * okna (`scanMainFileBefore`: strumieniowo, z prefiltrem przed `JSON.parse`), w kolejności
   * pliku, a dopiero po niej wpisy okna. Pozostałe mechanizmy (transkrypt, zgody, zużycie, echo)
   * tej części nie dostają: im okno wystarcza.
   *
   * Przegląd pisze do OSOBNEGO reduktora, a follower bierze go do użytku dopiero po udanym końcu.
   * Do tej chwili `#tasks` jest pusty i tak ma być: zrzut stanu, który wypadnie w trakcie
   * przeglądu (wygaszenie listy po `/clear`), nie ma prawa pokazać listy złożonej w połowie.
   *
   * Gdy przegląd się nie odbył (plik ponad sufit) albo nie udał, zostaje zachowanie sprzed
   * przeglądu: lista z samego okna i `since` od pierwszego wpisu okna. Jedna linia w logu.
   * Zadania mają przegląd tylko TU, przy otwarciu pliku: skrócenie i przeskok zerują reduktor bez
   * ponownego przeglądu. Lista artefaktów jedzie tym samym przejściem jako drugie ujście, a po
   * skróceniu i przeskoku ma własny przegląd (`#restartArtifacts`).
   */
  async #primeTasks(
    path: string, tail: HistoryTail, entries: readonly unknown[], gen: number,
  ): Promise<void> {
    const scanned = tail.start === 0 ? null : await this.#scanBeforeWindow(path, tail, gen);
    if (this.#stale(gen)) return;
    try {
      if (scanned !== null) {
        // Start procesu CLI mógł przyjść w trakcie przeglądu i trafić tylko do starego reduktora.
        if (this.#processStartedAt !== null) scanned.tasks.processStarted(this.#processStartedAt);
        this.#tasks = scanned.tasks;
      }
      for (const entry of entries) this.#tasks.note(entry);
    } catch (error) {
      this.#log(
        `rarog: transcript ${this.#agentSessionId ?? '?'}: failed to count background tasks from the `
        + `history window: ${describeError(error)}`,
      );
    }
    this.#payTasks();
    try {
      if (scanned !== null) this.#artifacts = scanned.artifacts;
      for (const entry of entries) this.#artifacts.note(entry);
    } catch (error) {
      this.#log(
        `rarog: transcript ${this.#agentSessionId ?? '?'}: failed to count artifacts from the `
        + `history window: ${describeError(error)}`,
      );
    }
    this.#payArtifacts();
  }

  /**
   * Część pliku sprzed okna → świeży reduktor i świeża lista artefaktów; `null` = przeglądu nie ma
   * i wołający zostaje przy tym, co ma. Nigdy nie rzuca.
   */
  async #scanBeforeWindow(
    path: string, tail: HistoryTail, gen: number,
  ): Promise<{ tasks: BackgroundTasksTracker; artifacts: ArtifactsTracker } | null> {
    const tracker = this.#newTasks();
    const artifacts = createArtifactsTracker();
    const uuid = this.#agentSessionId ?? '?';
    const started = performance.now();
    let result: MainScanResult;
    try {
      result = await scanMainFileBefore({
        path, windowStart: tail.start, windowEnd: tail.offset, tracker, artifacts,
        stale: () => this.#stale(gen), ...this.#scanLimits(),
      });
    } catch (error) {
      result = { outcome: 'failed', reason: describeError(error) };
    }
    if (result.outcome === 'stale' || this.#stale(gen)) return null;
    if (result.outcome === 'done') {
      if (tail.offset > this.#tasksScan.logBytes) {
        this.#log(
          `rarog: transcript ${uuid}: ${TASKS_SCAN_LOG}: ${String(result.bytes)} B in `
          + `${String(Math.round(performance.now() - started))} ms, parsed `
          + `${String(result.parsed)} of ${String(result.lines)} lines`,
        );
      }
      return { tasks: tracker, artifacts };
    }
    const why = result.outcome === 'too-large'
      ? `the file has ${String(tail.start)} B before the window, more than the scan cap`
      : `the scan failed (${result.reason})`;
    this.#log(
      `rarog: transcript ${uuid}: ${why}; ${TASKS_SCAN_SKIPPED_LOG}, the task and artifact lists come `
      + 'from the window alone',
    );
    return null;
  }

  /** Sufity i otwarcie pliku dla przeglądu — z opcji `tasksScan`, gdy test je podał. */
  #scanLimits(): Pick<MainScanOptions, 'maxBytes' | 'chunkBytes' | 'open'> {
    return {
      ...(this.#tasksScan.maxBytes === undefined ? {} : { maxBytes: this.#tasksScan.maxBytes }),
      ...(this.#tasksScan.chunkBytes === undefined ? {} : { chunkBytes: this.#tasksScan.chunkBytes }),
      ...(this.#tasksScan.open === undefined ? {} : { open: this.#tasksScan.open }),
    };
  }

  /**
   * Lista artefaktów od zera, a w tle przegląd pliku od początku do miejsca, od którego follower czyta
   * dalej. Wołane przy skróceniu pliku i przeskoku przyrostu: tam stan liczony z pliku wraca do
   * zera, a lista artefaktów, która tylko się sumuje, nie odbuduje się z przyszłych linii jak zadania.
   * Jedna reguła dla obu przypadków: lista zawsze odpowiada bieżącej zawartości pliku.
   *
   * Granice jak przy podpięciu (`scanMainFileBefore`): wszystko przed `windowStart` i linia, w której
   * `windowStart` wypada, do jej `\n` (nie dalej niż `windowEnd`). Resztę dostaje lista na żywo.
   * Do końca przeglądu lista nie wychodzi: fakty przeczytane w tym czasie zbiera powtórka i po udanym
   * przeglądzie idą na jego wynik. Po porażce zostaje lista z samych tych faktów i linia w logu.
   */
  #restartArtifacts(windowStart: number, windowEnd: number): void {
    this.#artifacts = createArtifactsTracker();
    this.#artifactsEpoch += 1;
    this.#artifactsReplay = [];
    const path = this.#path;
    if (path === null) {
      this.#finishArtifactsRescan(null, 'file path unknown');
      return;
    }
    void this.#rescanArtifacts(path, windowStart, windowEnd, this.#generation, this.#artifactsEpoch);
  }

  async #rescanArtifacts(
    path: string, windowStart: number, windowEnd: number, gen: number, epoch: number,
  ): Promise<void> {
    const scanned = createArtifactsTracker();
    const started = performance.now();
    // Wynik należy do TEGO zerowania: `repoint`, zamknięcie albo kolejne zerowanie go unieważniają.
    const stale = (): boolean => this.#stale(gen) || epoch !== this.#artifactsEpoch;
    let result: MainScanResult;
    try {
      result = await scanMainFileBefore({
        path, windowStart, windowEnd, artifacts: scanned, stale, ...this.#scanLimits(),
      });
    } catch (error) {
      result = { outcome: 'failed', reason: describeError(error) };
    }
    if (stale()) return;
    if (result.outcome === 'done') {
      if (windowEnd > this.#tasksScan.logBytes) {
        this.#log(
          `rarog: transcript ${this.#agentSessionId ?? '?'}: ${ARTIFACTS_RESCAN_LOG}: `
          + `${String(result.bytes)} B in ${String(Math.round(performance.now() - started))} ms, parsed `
          + `${String(result.parsed)} of ${String(result.lines)} lines`,
        );
      }
      this.#finishArtifactsRescan(scanned, '');
      return;
    }
    this.#finishArtifactsRescan(null, result.outcome === 'too-large'
      ? `the file has ${String(windowStart)} B before the reset point, more than the scan cap`
      : result.outcome === 'failed' ? `the scan failed (${result.reason})` : 'scan interrupted');
  }

  /**
   * Koniec przeglądu po zerowaniu: udany wynik dostaje fakty przeczytane w międzyczasie i zastępuje listę;
   * bez wyniku zostaje lista z samych tych faktów i linia w logu z powodem.
   */
  #finishArtifactsRescan(scanned: ArtifactsTracker | null, why: string): void {
    const replay = this.#artifactsReplay ?? [];
    this.#artifactsReplay = null;
    if (scanned !== null) {
      for (const fact of replay) scanned.apply(fact);
      this.#artifacts = scanned;
    } else {
      this.#log(`rarog: transcript ${this.#agentSessionId ?? '?'}: ${why}; ${ARTIFACTS_RESCAN_SKIPPED_LOG}`);
    }
    this.#syncArtifacts();
    // Wypłata wstrzymana na czas przeglądu (brudna flaga sprzed zerowania) wychodzi teraz, z listą po nim.
    if (this.#artifactsDirty) this.#arm();
  }

  /**
   * Pliku nie ma: zaplanuj kolejne podejście, a po karencji powiedz o tym GŁOŚNO.
   *
   * Alarm leci dopiero po nieudanym GLOBIE (`#resolvePath` sprawdza cały korzeń), a nie po
   * nieudanym trafieniu w slug — inaczej sesja wznowiona międzykatalogowo, której plik istnieje
   * i rośnie, dostawałaby fałszywy alarm co 15 s. Poll leci dalej także po alarmie: plik może
   * powstać później (panel stoi na powłoce i czeka na pierwszy prompt).
   */
  #scheduleMissing(): void {
    const elapsed = this.#now() - this.#missingSince;
    if (this.#expecting && elapsed >= this.#graceMs && !this.#noTranscriptReported) {
      this.#noTranscriptReported = true;
      this.#push({ type: 'error', reason: 'no-transcript' });
    }
    // A request that came during the lookup which just missed wants a lookup that begins after it: now.
    const delay = this.#lookups.unanswered ? 0
      : elapsed < this.#missingWindowMs ? this.#missingFastMs : this.#missingSlowMs;
    this.#armLookup(delay);
  }

  /** Arms the retry of the lookup in `delay` ms in place of the one armed before. */
  #armLookup(delay: number): void {
    if (this.#lookupTimer !== null) {
      clearTimeout(this.#lookupTimer);
      this.#timers.delete(this.#lookupTimer);
    }
    // Ponowienie należy do TEJ sesji silnika. Po `repoint()` nowy plik ma własne otwarcie i własne
    // ponowienia; stare, które wypadłoby w trakcie, otwierałoby go drugi raz.
    const gen = this.#generation;
    this.#lookupTimer = this.#after(delay, () => {
      this.#lookupTimer = null;
      if (!this.#stale(gen)) void this.#prime();
    });
  }

  #startWatch(): void {
    if (this.#closed) return;
    this.#startWatcher();
    this.#scheduleTick();
  }

  /**
   * Sam obserwator pliku — BEZ zakładania drugiego łańcucha ticków.
   *
   * Relokacja (`#relocate`) przepina obserwatora na nowy adres w środku życia followera, a
   * `#startWatch()` woła przy okazji `#scheduleTick()`: użyty tam dołożyłby drugi, równoległy
   * tik `stat` przy każdym przeniesieniu pliku.
   *
   * Zdarzenia nie rozróżniamy po `eventType`: `rename` z kqueue i tak kończy się `#drainOnce`,
   * które po `ENOENT` samo wchodzi w relokację. Jedna ścieżka zamiast dwóch.
   */
  #startWatcher(): void {
    if (this.#closed) return;
    const path = this.#path;
    if (path !== null && this.#useWatch) {
      try {
        // `persistent: false` — obserwator transkryptu nie ma prawa trzymać procesu przy życiu.
        const watcher = watch(path, { persistent: false }, () => { void this.#readMore(); });
        watcher.on('error', () => { this.#stopWatch(); });
        this.#watcher = watcher;
      } catch {
        this.#watcher = null;
      }
    }
  }

  #scheduleTick(): void {
    this.#after(this.#statTickMs, () => {
      if (!this.#primed) return;
      void this.#readMore();
      // Zegar zadań: monitor wygasa także wtedy, gdy plik nie rośnie.
      this.#syncTasks();
      // Dopóki okna nie znamy, dopytujemy co tik: panel bezczynny zrzuci payload dopiero przy
      // najbliższym renderze stopki, a do tego czasu procent jest ZGADYWANY i potrafi być
      // pięciokrotnie za ostry. Po pierwszym trafieniu ta ścieżka milknie.
      if (this.#statuslineLimit === null) void this.#readStatusline();
      this.#scheduleTick();
    });
  }

  /**
   * Rozmiar okna WPROST OD SILNIKA (`statusline.ts`) → potwierdzenie limitu.
   *
   * Nigdy nie rzuca i nigdy nie kasuje tego, co już wiemy: brak zrzutu to normalny stan (panel
   * spoza tej maszyny, sesja bez renderu od czasu wdrożenia), a wtedy zostaje szacunek z jsonl.
   */
  async #readStatusline(): Promise<void> {
    const uuid = this.#agentSessionId;
    const gen = this.#generation;
    if (uuid === null || this.#statuslineReadingGen === gen) return;
    this.#statuslineReadingGen = gen;
    let state: Awaited<ReturnType<typeof readStatusline>> = null;
    try {
      state = await readStatusline(this.#statuslineRoot, uuid);
    } finally {
      // Zwalniamy tylko WŁASNĄ blokadę: po `repoint()` pole należy już do odczytu nowej sesji.
      if (this.#statuslineReadingGen === gen) this.#statuslineReadingGen = null;
    }
    if (this.#stale(gen) || state === null) return;
    const size = state.contextWindow;
    if (size === undefined || size === this.#statuslineLimit) return;
    this.#statuslineLimit = size;
    this.#usage.confirmLimit(size, 'statusline');
    this.#context = this.#usage.state();
    this.#usageDirty = true;
    this.#arm();
  }

  #stopWatch(): void {
    if (this.#watcher !== null) {
      this.#watcher.close();
      this.#watcher = null;
    }
  }

  // -------------------------------------------------------------------------
  // Tail
  // -------------------------------------------------------------------------

  /** Czy wynik odczytu jest już NIEAKTUALNY: follower zamknięty albo plik podmieniony. */
  #stale(gen: number): boolean {
    return this.#closed || gen !== this.#generation;
  }

  async #readMore(): Promise<void> {
    if (this.#closed || !this.#primed) return;
    if (this.#reading !== null) {
      // Zdarzenie w trakcie odczytu: zamiast równoległego czytania tego samego pliku
      // (dwa razy ten sam offset = duplikaty) zapamiętujemy, że trzeba powtórzyć.
      // The loop repeats the read, so its promise settles after a read that began after this call (`readNow`).
      this.#readAgain = true;
      return this.#reading;
    }
    const loop = this.#readLoop();
    this.#reading = loop;
    return loop;
  }

  /** The reads of {@link #readMore}; it clears `#reading` in the same step that saw no repeat request. */
  async #readLoop(): Promise<void> {
    try {
      do {
        this.#readAgain = false;
        await this.#drainOnce();
      } while (this.#readAgain && !this.#closed);
    } catch (error) {
      // Ten sam bezpiecznik co w `#prime`: tail jest wołany przez `void` z watchera i ticka,
      // a odrzucenie nie ma kogo obudzić. Odczyt wróci przy najbliższym ticku `stat`.
      if (!this.#closed) {
        this.#log(
          `rarog: reading transcript ${this.#agentSessionId ?? '?'} failed: `
          + `${describeError(error)} — back on the next tick`,
        );
      }
    } finally {
      this.#reading = null;
    }
  }

  async #drainOnce(): Promise<void> {
    const gen = this.#generation;
    const path = this.#path;
    // Ścieżki nie ma, a follower jest już rozgrzany: plik zniknął spod znanego adresu
    // (`EnterWorktree`) i szukamy go po uuid — patrz `#relocate`.
    if (path === null) {
      await this.#relocate(gen);
      return;
    }
    // Tożsamość PRZED rozmiarem (jak w `#primeOnce`): podmiana między dwoma `stat` zostawia starą tożsamość, więc
    // wykrywa ją następny tick, a skan nazwy dostaje rozmiar nowego pliku, nie starego.
    const replaced = await this.#noteTranscriptId(path, gen);
    if (this.#stale(gen)) return;
    const size = await this.#io.sizeOf(path);
    if (this.#stale(gen)) return;
    // `ENOENT` na ścieżce, którą przed chwilą czytaliśmy, NIE jest ciszą do przeczekania.
    if (size === null) {
      await this.#relocate(gen);
      return;
    }
    if (size < this.#offset) {
      this.#onTruncated(size);
      return;
    }
    /*
     * Nazwa rozmowy: plik podmieniony na plik tej samej albo większej długości to nowa treść, której
     * rozmiar nie zdradza. Ponowny przegląd tylko dla nazwy; bez wpisu `custom-title` etykieta zostaje bez zmian.
     */
    if (replaced) void this.#scanCustomTitle(path, size);
    if (size === this.#offset) return;

    let start = this.#offset;
    let skipped = false;
    // Luka większa niż sufit odczytu (Rarog spał, panel mielił) — przeskakujemy do końca zamiast
    // wciągać do RAM dziesiątki MB. Utracony środek jest w terminalu; replay od zera byłby gorszy.
    if (size - start > this.#maxReadBytes) {
      start = size - this.#maxReadBytes;
      skipped = true;
    }
    const chunk = await this.#io.readRange(path, start, size - start);
    // Bramka MUSI stać przed `#offset`: podstawienie pozycji starego pliku pod nowy zostawiłoby
    // następny odczyt w losowym miejscu, a `#consume` dopisałby starą rozmowę do nowej.
    if (this.#stale(gen) || chunk === null) return;
    // Reset PRZED ogonem: wpisy z ogona odbudowują stan już od zera, a nie na martwym.
    if (skipped) this.#onGap(start - this.#offset, start, start + chunk.bytesRead);
    this.#offset = start + chunk.bytesRead;
    let text = chunk.text;
    if (skipped) {
      const first = text.indexOf('\n');
      text = first === -1 ? '' : text.slice(first + 1);
    }
    this.#consume(text);
    // Rozmowa drgnęła — to jedyny moment, w którym okno może się zmienić bez naszej wiedzy
    // (`/model` w terminalu). Czytamy zrzut ponownie; gdy jest ten sam, nic się nie dzieje.
    void this.#readStatusline();
  }

  /**
   * Plik zniknął spod znanego adresu — znajdź go po uuid i czytaj DALEJ.
   *
   * `EnterWorktree` w Claude Code przenosi transkrypt `rename(2)`-em do slugu worktree: ten sam
   * inode, ta sama treść, inny katalog projektu. Bez tego follower kończył wtedy `#drainOnce`
   * po `ENOENT` i milczał do końca życia panelu — bez logu, bez alarmu i z `hasTranscript()`
   * odpowiadającym `'yes'` o pliku, którego pod tym adresem nie ma (zmierzone: sesja
   * dopisała 80 linii przez 55 minut, Rarog nie pokazał ani jednej).
   *
   * Trzy rzeczy, które są tu ważniejsze niż kod:
   *
   * 1. **`#offset` ZOSTAJE.** Treść się nie zmieniła, więc czytanie zaczyna się dokładnie tam,
   *    gdzie skończyło — zero replayu historii, zero duplikatów, zero luki. Dlatego relokacja
   *    NIE jest `repoint()`: ten wstawiłby komunikat o nowej sesji i przeczytał historię od nowa.
   * 2. **Nowy plik musi być KONTYNUACJĄ**: `size >= #offset`. Krótszy plik pod tym samym uuid to
   *    inna zawartość, a od niej jest `#onTruncated` (bufor, pending i zadania w tle do zera).
   * 3. **Bez pętli.** Glob to `readdir` korzenia i `stat` w kilkudziesięciu katalogach; przy
   *    pudle próbujemy najwyżej `FOLLOW_RELOCATE_TRIES` razy z rosnącą przerwą i mówimy o tym
   *    JEDNĄ linią w dzienniku. Po pudle `#path` wraca do `null`, a `hasTranscript()` odpowiada
   *    `'no'` — driver ma prawo wiedzieć, że treści nie będzie, zamiast czekać na nią w ciszy.
   */
  async #relocate(gen: number): Promise<void> {
    const uuid = this.#agentSessionId;
    if (uuid === null || !this.#primed) return;
    if (this.#relocateTries >= FOLLOW_RELOCATE_TRIES) return;
    const now = this.#now();
    if (now < this.#relocateNextAt) return;

    const found = await locateTranscript(this.#root, this.#cwd, uuid);
    if (this.#stale(gen)) return;
    const size = found === null ? null : await this.#io.sizeOf(found);
    if (this.#stale(gen)) return;
    if (found === null || size === null) {
      this.#relocateMissed(now, uuid);
      return;
    }

    const moved = found !== this.#path;
    this.#stopWatch();
    this.#path = found;
    this.#pathLookedUp = true;
    this.#relocateTries = 0;
    this.#relocateNextAt = 0;
    this.#relocateReported = false;
    if (moved) {
      this.#log(
        `rarog: transcript ${uuid} moved to ${found} — reading on from byte `
        + `${String(this.#offset)}`,
      );
      // Satelity (puls katalogu, czytnik workflow) trzymają WŁASNY cache katalogu obok
      // transkryptu — bez tego sygnału podążyłaby za plikiem sama rozmowa.
      this.#emitNow({
        type: 'relocated', path: found, dir: found.slice(0, found.length - TRANSCRIPT_EXT.length),
      });
    }
    this.#startWatcher();
    if (size < this.#offset) {
      this.#onTruncated(size);
      return;
    }
    // Dokończenie czytania robi pętla `#readMore` — rekurencja `#drainOnce` w środku `#drainOnce`
    // czytałaby ten sam zakres w dwóch ramkach stosu naraz.
    this.#readAgain = true;
  }

  /** Pudło globu: jedna linia w dzienniku, uczciwe `hasTranscript()` i rosnąca przerwa. */
  #relocateMissed(now: number, uuid: string): void {
    this.#relocateTries += 1;
    const backoff = Math.min(
      this.#missingFastMs * 2 ** (this.#relocateTries - 1), this.#missingSlowMs,
    );
    this.#relocateNextAt = now + backoff;
    this.#stopWatch();
    this.#path = null;
    // Glob PRZEBIEGŁ i nic nie znalazł — to odpowiedź „nie ma", a nie „jeszcze nie wiem".
    this.#pathLookedUp = true;
    if (this.#relocateReported) return;
    this.#relocateReported = true;
    this.#log(
      `rarog: transcript ${uuid} disappeared and is not under any CLI store slug — `
      + `trying ${String(FOLLOW_RELOCATE_TRIES - 1)} more times, then going quiet`,
    );
  }

  /**
   * Plik zmalał: to już INNA zawartość, nie dalszy ciąg tej, którą liczyliśmy.
   *
   * Offset i bufor linii wracają do stanu pliku, ale to samo musi spotkać tracker czekającego
   * narzędzia: `tool_use` sprzed skrócenia nigdy nie dostanie swojego
   * `tool_result` — wpis z parą został ucięty razem z resztą — więc bez resetu karta zgody
   * stałaby jako WIDMO aż do `/clear`. Replayu historii tu nie ma (celowo, patrz test
   * „skrócenie pliku daje wiadomość systemową"), więc `null` jest jedyną prawdą, jaką znamy;
   * jeśli w nowej treści stoi otwarte narzędzie, tail dopisze je przy najbliższym odczycie.
   */
  #onTruncated(size: number): void {
    this.#offset = size;
    // Skrócenie do zera to plik znany i pusty, nie stan sprzed pierwszego odczytu (`#trackerUnknown`).
    this.#knownEmpty = size === 0;
    this.#partial = '';
    // A plain command entry from the cut content is no pair for a call written after it.
    this.#fileEcho.reset();
    /*
     * Ucięta treść mogła nieść znacznik ultracode (wyłączenie, pierwszą turę po żądaniu), a kolejne tury go nie
     * powtarzają: znany stan przepada, a karta, która mogła coś nieść, dostaje `null`.
     */
    if (this.#ultracode.lost()) this.#syncUltracode();
    this.#pending = createPendingTracker();
    // Zamknięcia sprzed resetu (i z pominiętego kawałka) przepadają: kanał zgód nie może ich brać za niewiadomą.
    this.#pending.lose(this.#now());
    if (this.#lastPendingId !== null) {
      this.#lastPendingId = null;
      this.#pendingDirty = true;
    }
    // A cut file says nothing about the queue of the running CLI process: unknown until the next turn end.
    this.#cliQueue.lose();
    /*
     * Zadania w tle gasną z DOKŁADNIE TEGO SAMEGO powodu co pending — i przez chwilę tego tu
     * nie było, więc karta-widmo miała drugie wcielenie. Tracker zamyka wpis wyłącznie linią
     * `<\task-notification>` albo `TaskOutput` z pliku, a te po skróceniu leżą poniżej nowego
     * `size` i NIGDY nie zostaną odczytane. Skutek zawieszonego wpisu jest cichy i trwały:
     * plakietka „w tle" nad sesją, która niczego nie liczy, `doneOrSilence()` zwracające `null`
     * dopóki `backgroundTasks > 0` (czyli ani jednego pusha „gotowe" do końca życia sesji)
     * i driver czytający co 5 s katalog przebiegu, który dawno się skończył.
     *
     * `#usage` ZOSTAJE świadomie: to wskaźnik ostatniej wartości, a nie para otwórz/zamknij —
     * najbliższa linia `usage` go poprawi, a wyzerowanie zgasiłoby miernik kontekstu żywej
     * sesji bez niczyjego zysku.
     */
    this.#tasks = this.#newTasks();
    this.#endsSent = 0;
    this.#sinceSent = '';
    // Wypłata, która jeszcze nie wyszła (także pierwsza po podpięciu, `#payTasks`), idzie dalej z listą od zera.
    this.#tasksDirty = this.#tasksDirty || this.#lastTasksKey !== '';
    this.#lastTasksKey = '';
    // Lista artefaktów: od zera i przegląd tego, co z pliku zostało. Follower czyta dalej od `size`.
    this.#restartArtifacts(size, size);
    // Nazwa rozmowy: przegląd nowej treści; bez wpisu `custom-title` etykieta zostaje bez zmian.
    if (this.#path !== null) void this.#scanCustomTitle(this.#path, size);
    // Ucięta treść mogła nieść prompt albo raport subagenta bieżącej tury.
    this.#push({ type: 'turn-input', lost: true });
    this.#push({
      type: 'message', role: 'system', blocks: [{ type: 'text', text: TRUNCATED_MESSAGE }],
    });
  }

  /**
   * Przeskok przyrostu większego niż sufit odczytu — utrata CIĄGŁOŚCI pliku.
   *
   * Pominięty kawałek mógł nieść `tool_result`, zakończenie zadania w tle albo echo własnego
   * promptu. Stan liczony parami (otwórz/zamknij) nie przeżyje takiej luki: do tej daty tracker
   * trzymał `Read`, którego wynik (zrzut ekranu, 1,35 MB) przeskoczono, i każda zgoda do końca
   * tury kończyła się `mismatch`. Dlatego to samo, co przy skróceniu pliku (`#onTruncated`):
   * czekające narzędzie i zadania w tle od zera, kierunek bezpieczny — gubimy kartę z jsonl,
   * nie dorabiamy jej (zrzut hooka i ekran zostają). Do tego okno echa: echo sprzed luki,
   * którego wpisu follower nigdy nie zobaczy, ukryłoby później identyczną wiadomość z terminala;
   * zdublowany własny prompt jest tańszy niż zniknięta cudza wiadomość.
   *
   * `#usage` i model, effort i tryb w `#meta` zostają — to ostatnie znane wartości, które poprawi
   * najbliższy wpis. Ultracode nie: pominięty kawałek mógł nieść wynik `Ultracode off`
   * i `ultra_effort_exit`, a kolejne tury znacznika nie powtarzają, więc znany stan przepada
   * i pole dostaje `null` PRZED ogonem. Znacznik z ogona ustala wartość od razu, a meta wychodzi
   * jedną wypłatą po ogonie (`#metaDirty`), więc karta nie mruga przez „nie wiem”.
   * Wiadomość systemowa mówi użytkownikowi o luce, a jej `#push` uzbraja wypłatę stanu także
   * wtedy, gdy po przeskoku nie zostaje ani jedna kompletna linia.
   */
  #onGap(skippedBytes: number, windowStart: number, windowEnd: number): void {
    this.#partial = '';
    // Pominięty kawałek mógł nieść znacznik ultracode; bez stanu i bez żądania nie ma czego zdejmować.
    if (this.#ultracode.lost()) this.#syncUltracode();
    this.#pending = createPendingTracker();
    // Zamknięcia sprzed resetu (i z pominiętego kawałka) przepadają: kanał zgód nie może ich brać za niewiadomą.
    this.#pending.lose(this.#now());
    if (this.#lastPendingId !== null) {
      this.#lastPendingId = null;
      this.#pendingDirty = true;
    }
    this.#cliQueue.lose();
    this.#tasks = this.#newTasks();
    this.#endsSent = 0;
    this.#sinceSent = '';
    if (this.#lastTasksKey !== '') {
      this.#lastTasksKey = '';
      this.#tasksDirty = true;
    }
    this.#echo = [];
    // Lista artefaktów: od zera i przegląd pliku do miejsca, od którego follower czyta ogon.
    this.#restartArtifacts(windowStart, windowEnd);
    // Pominięty kawałek mógł nieść nowszy wpis `custom-title`; wpis z ogona po przeskoku wygrywa z przeglądem.
    if (this.#path !== null) void this.#scanCustomTitle(this.#path, windowEnd);
    this.#log(
      `rarog: transcript ${this.#agentSessionId ?? '?'}: skipped ${String(skippedBytes)} B `
      + 'of growth over the read cap — pending tool, background tasks and echo reset',
    );
    // Pominięty kawałek mógł nieść prompt albo raport subagenta bieżącej tury; notka o postoju
    // z zachowanego ogona wyglądałaby wtedy na jedyną przyczynę tury. PRZED ogonem.
    this.#push({ type: 'turn-input', lost: true });
    this.#push({
      type: 'message', role: 'system', blocks: [{ type: 'text', text: GAP_MESSAGE }],
    });
  }

  #consume(text: string): void {
    const combined = this.#partial + text;
    const cut = combined.lastIndexOf('\n');
    if (cut === -1) {
      this.#partial = combined;
      return;
    }
    this.#partial = combined.slice(cut + 1);
    for (const line of combined.slice(0, cut).split('\n')) this.#handleLine(line);
  }

  #handleLine(line: string): void {
    // Dwa niezależne przebiegi po tej samej linii: `#noteRaw` bierze to, czego parser treści
    // nie zwraca (surowy `input`, `id`, `usage`, tryb), a `parseImportLine` — treść.
    const raw = parseJsonlEntry(line);
    const openBefore = this.#pending.open;
    this.#noteRaw(raw);
    // The end of the call on the row (live tail only): the row moves to a call still open, or to `thinking`.
    const ended = toolEndActivity(raw, openBefore, this.#pending.open);
    if (ended !== null) this.#push({ type: 'activity', ...ended });
    const entry = parseImportLine(line, this.#promptBlock ? {} : { promptBlock: false });
    // The call entry that repeats the plain "/compact" entry before it gives nothing, as in the history.
    if (entry !== null && this.#fileEcho.repeats(entry.fileEcho, entry.message !== null)) return;
    // `system` (w tym `compact_boundary`), `attachment` (poza promptem człowieka wchłoniętym w turę),
    // sidechainy i wpisy meta → `null`.
    if (entry === null || entry.message === null) {
      // Wpis meta, który CLI oznaczył jako czyjeś wejście (wiadomość subagenta, wybudzenie):
      // wiadomością nie jest, ale turę wywołuje — manager ma o nim wiedzieć.
      if (isHiddenTurnInput(raw)) this.#push({ type: 'turn-input' });
      else if (isMainCompactBoundary(raw)) this.#push({ type: 'turn-input', kind: 'compaction' });
      return;
    }
    const message = entry.message;
    // Prompt zablokowany przez hook — PRZED `#commandLine`: to nie wywołanie ani wynik komendy, a jego
    // notka nie jest zwykłą wiadomością `system` (decyduje echo wysyłki z Raroga).
    if (message.command?.part === 'prompt-blocked') {
      const event = this.#promptBlockedEvent(message);
      if (event !== null) this.#push(event);
      return;
    }
    if (message.command !== undefined) {
      this.#commandLine(message);
      return;
    }
    // Wynik stoi zaraz za swoim wywołaniem: wiadomość pomiędzy zrywa parę (`#lastCommand`).
    this.#lastCommand = '';

    if (entry.role === 'user') {
      // Notka harnessu nie jest promptem Raroga: echa nie gasi i z nim się nie paruje.
      if (message.notice !== undefined) {
        this.#push({ type: 'message', role: 'user', blocks: message.blocks, notice: message.notice });
        return;
      }
      // Echo własnego promptu gasimy TU, a nie w managerze (patrz nagłówek pliku). Wiadomości
      // z niego nie ma, ale fakt zostaje: CLI właśnie wzięło ten prompt do tury (kolejka zmierzona
      // na 2.1.299). Manager liczy go też przy wysyłce, tyle że prompt wysłany w trakcie tury trafia tu
      // turę później.
      const echo = this.#takeEcho(userTextOf(message.blocks), message.at);
      if (echo?.token !== undefined) {
        // Echo odroczone: wiadomość idzie dalej w kolejności pliku, manager podstawi
        // wstrzymaną. Wejście tury liczy manager przy samej wiadomości.
        this.#push({ type: 'message', role: 'user', blocks: message.blocks, echoToken: echo.token });
        return;
      }
      if (echo !== null) {
        this.#push({ type: 'turn-input' });
        return;
      }
      this.#push({ type: 'message', role: 'user', blocks: message.blocks });
      return;
    }

    if (entry.role === 'system') {
      this.#push({ type: 'message', role: 'system', blocks: message.blocks });
      return;
    }

    this.#push({ type: 'message', role: 'assistant', blocks: message.blocks });
    /*
     * Wskaźnik „co agent robi": bez niego sesje herdr byłyby jedynymi, które podczas pracy
     * nie pokazują nic.
     *
     * Leci PO wiadomości, nie przed nią. W jsonl wpis z tool_use stoi
     * PRZED długą ciszą narzędzia (minuty `Bash`a), więc wskaźnik ma trwać po nim; kiedy dokładnie
     * CLI dopisuje wpis, niezmierzone (docs hooks, „Common input fields”: plik transkryptu jest
     * pisany asynchronicznie i bywa w tyle za rozmową). Klient kasuje aktywność
     * przy każdej wiadomości (treść jest mocniejsza od „pracuje"), więc wskaźnik wysłany przed
     * własną wiadomością gasł w tej samej partii eventów i sesje bez workflow nie pokazywały
     * podczas pracy NIC poza stanem w nagłówku.
     */
    const inputs = toolInputsByName(raw);
    for (const block of message.blocks) {
      if (block.type !== 'tool-call') continue;
      this.#push({ type: 'activity', ...toolActivity(block.toolName, inputs.get(block.toolName)?.shift()) });
    }
  }

  /**
   * Wiadomość importu → wiadomość followera, bez śladu komendy (`ImportedMessage.command` nie jedzie dalej).
   *
   * Wywołanie komendy zapamiętuje swoją nazwę, a wynik dostaje `commandOutput` z nazwą z wpisu albo
   * z ostatniego wywołania — driver kończy po nim komendę lokalną wysłaną z Raroga. Wołane dla
   * KAŻDEJ wiadomości w kolejności pliku (historia i tail), także dla wywołania zgaszonego echem.
   */
  #followMessage(message: ImportedMessage): FollowMessage {
    const { command, ...rest } = message;
    // Wiadomość spoza komendy zrywa parę wywołanie/wynik: nazwa nie przechodzi na późniejszy wynik.
    // On CLI 2.1.299 the `/compact` call is dropped as a repeat of the plain entry, so its output has no name.
    if (command === undefined) this.#lastCommand = '';
    if (command?.part === 'invocation') this.#lastCommand = command.name ?? '';
    if (command?.part !== 'output') return rest;
    const name = command.name ?? this.#lastCommand;
    return name === '' ? rest : { ...rest, commandOutput: name };
  }

  /**
   * Wpis promptu zablokowanego przez hook → zdarzenie `prompt-blocked` (ogon i historia, jedna reguła).
   *
   * Cytat (już po `humanTextOf`) gasi echo wysyłki z Raroga tym samym `#takeEcho`, ale ze sprawdzeniem czasu
   * KAŻDEGO wpisu okna (`strict`), i trafienie zużywa wpis: sierota po zablokowanej wysyłce nie połknie
   * późniejszego identycznego promptu. Wiadomość między wywołaniem komendy a jej wynikiem zrywa parę
   * (`#lastCommand`), jak każda wiadomość spoza komendy.
   */
  #promptBlockedEvent(message: ImportedMessage): Extract<FollowEvent, { type: 'prompt-blocked' }> | null {
    this.#lastCommand = '';
    const blocked: PromptBlock | undefined = message.promptBlocked;
    if (blocked === undefined) return null;
    const prompt = blocked.prompt ?? '';
    const key = echoKey(prompt);
    const echo = key === '' ? null : this.#takeEcho(prompt, message.at, false, true);
    return {
      type: 'prompt-blocked', reason: blocked.reason, promptKept: blocked.promptKept, echoed: echo !== null,
      ...(blocked.prompt === undefined ? {} : { prompt: blocked.prompt }),
      ...(key === '' ? {} : { key }),
      ...(echo?.token === undefined ? {} : { token: echo.token }),
      ...(echo?.send === undefined ? {} : { send: echo.send }),
    };
  }

  /**
   * Wpis komendy na żywo: wywołanie, wynik albo ostrzeżenie o komendzie nieznanej.
   *
   * Wywołanie wysłane z Raroga gaśnie echem jak prompt (dymek stoi od wysyłki), a klucz porównuje nazwę bez
   * względu na wielkość liter: CLI zapisuje nazwę kanoniczną (zmierzone na 2.1.302), a Rarog przepuszcza
   * `/CLEAR`. Wejściem tury jest tylko komenda typu prompt (wiadomość `user`); komenda lokalna turą nie jest, więc
   * jej zgaszone echo nie daje `turn-input`, a notka `system` z pliku nie liczy się w managerze wcale.
   */
  #commandLine(message: ImportedMessage): void {
    const follow = this.#followMessage(message);
    if (message.command?.part === 'invocation') {
      const echo = this.#takeEcho(userTextOf(message.blocks), message.at, true);
      if (echo?.token !== undefined) {
        this.#push({ type: 'message', role: follow.role, blocks: follow.blocks, echoToken: echo.token });
        return;
      }
      if (echo !== null) {
        if (message.role === 'user') this.#push({ type: 'turn-input' });
        return;
      }
    }
    this.#push({
      type: 'message', role: follow.role, blocks: follow.blocks,
      ...(follow.commandOutput === undefined ? {} : { commandOutput: follow.commandOutput }),
    });
  }

  // -------------------------------------------------------------------------
  // Stan spoza treści: zużycie okna, model/effort/tryb, czekające narzędzie
  // -------------------------------------------------------------------------

  /**
   * Jeden SPARSOWANY wpis → aktualizacja stanu.
   *
   * Wpis przychodzi już sparsowany (a nie jako linia), bo `#handleLine` potrzebuje surowego
   * kształtu także dla siebie — opisu delegacji nie ma w zaimportowanych blokach. Jeden
   * `JSON.parse` na linię zamiast dwóch.
   *
   * Emisji tu NIE MA: każda zmiana podnosi tylko brudną flagę, a zdarzenie powstaje przy
   * zrzucie bufora (`#drainState`). Dzięki temu partia dziesięciu wpisów daje JEDNO zdarzenie
   * `usage`, a nie dziesięć — telefon nie ma po co widzieć sum pośrednich.
   */
  #noteRaw(entry: unknown): void {
    if (entry === null) return;
    this.#noteState(entry);
    this.#tasks.note(entry);
    this.#syncTasks();
    const fact = this.#artifacts.note(entry);
    if (fact === null) return;
    // Przegląd po zerowaniu w toku: fakt pójdzie też na jego wynik (`#finishArtifactsRescan`).
    this.#artifactsReplay?.push(fact);
    this.#syncArtifacts();
  }

  /**
   * Wszystko z `#noteRaw` POZA zadaniami w tle: zużycie okna, model i tryb, czekające narzędzie.
   * Osobno, bo przy podpięciu zadania idą inną kolejnością niż reszta: najpierw część pliku sprzed
   * okna, potem okno (`#primeTasks`), a ten stan zna samo okno.
   */
  #noteState(entry: unknown): void {
    this.#cliQueue.note(entry);
    const sum = usageFrom(entry);
    if (sum !== null && sum !== this.#lastUsageSum) {
      this.#lastUsageSum = sum;
      this.#context = this.#usage.note(sum);
      this.#usageDirty = true;
      this.#arm();
    }
    /*
     * `preTokens` KAŻDEJ granicy (`auto` i `manual`) podnosi DOLNĄ GRANICĘ okna.
     *
     * It does not and cannot confirm the limit: under `auto` it is the compaction threshold, and
     * a threshold is a setting, not the window size (header of `jsonl-usage.ts`). It does cut the
     * lie the other way: a session that stood at 744k tokens has no 200k window, while a model
     * outside `KNOWN_CONTEXT_LIMITS` would otherwise get 200k and show `~67%` instead of ~13% after
     * `/compact`. It must run BEFORE `note(post)` so the state sent after compaction already
     * carries the right lower bound.
     */
    const pre = compactPreTokensFrom(entry);
    if (pre !== null) {
      this.#usage.noteFloor(pre);
      this.#context = this.#usage.state();
      this.#usageDirty = true;
      this.#arm();
    }
    /*
     * …a ILE ZOSTAŁO po cięciu mówi ta sama granica, przy każdym triggerze.
     *
     * To jedyne miejsce, w którym licznik spada bez nowej wypowiedzi asystenta: po `/compact`
     * kolejny wpis `assistant` powstaje dopiero przy następnym prompcie, więc bez tej gałęzi
     * widget pokazywał zużycie SPRZED kompakcji — czyli namawiał do kompaktowania rozmowy,
     * którą właśnie skompaktowano.
     *
     * `#lastUsageSum` też przestawiamy: to „ostatnia znana suma okna", a nie „ostatnia suma
     * z wpisu asystenta" — inaczej pierwsza wypowiedź po kompakcji (równa `postTokens`, patrz
     * fixture) wyglądałaby na zmianę i wysłała drugie, identyczne zdarzenie.
     */
    const post = compactPostTokensFrom(entry);
    if (post !== null && post !== this.#lastUsageSum) {
      this.#lastUsageSum = post;
      this.#context = this.#usage.note(post);
      this.#usageDirty = true;
      this.#arm();
    }

    const meta = metaOf(entry);
    if (meta !== null) this.#noteMeta(meta);
    if (this.#ultracode.note(entry)) this.#syncUltracode();
    const title = customTitleOf(entry);
    if (title !== null) {
      this.#customTitleSeq += 1;
      this.#setCustomTitle(title);
    }

    this.#pending.note(entry);
    const pendingId = this.#pending.pending?.id ?? null;
    if (pendingId !== this.#lastPendingId) {
      this.#lastPendingId = pendingId;
      this.#pendingDirty = true;
      this.#arm();
    }
  }

  /**
   * Nowy reduktor zadań w tle. Zna od razu start procesu CLI, jeśli follower go zna: reduktor
   * założony po skróceniu pliku albo przeskoku czyta dalej TĘ SAMĄ rozmowę.
   */
  #newTasks(): BackgroundTasksTracker {
    const tracker = createBackgroundTasksTracker();
    if (this.#processStartedAt !== null) tracker.processStarted(this.#processStartedAt);
    return tracker;
  }

  /**
   * Zadania w tle — ten sam wzorzec co reszta stanu: tracker śledzi, a na drut jedzie dopiero
   * ZMIANA. Podpis (`tasksSignature`) obejmuje to, co w zadaniu zmienia się po starcie. Wołane po
   * każdym wpisie z pliku, po sygnale o starcie procesu CLI (`noteProcessStart`) i na każdym tyknięciu
   * `stat` (`#scheduleTick`).
   *
   * Najpierw zegar terminów monitorów (reguła 11 reduktora): wygaśnięcie monitora nie zostawia w pliku
   * linii, więc bez tyknięcia monitor stałby na liście do następnego wpisu. Chwila pierwszego wywołania po
   * wpisie to zarazem chwila odczytu linii, od której liczy się termin startu bez `timestamp`.
   */
  #syncTasks(): void {
    this.#tasks.expire(this.#now());
    const tasksKey = tasksSignature(this.#tasks.tasks);
    if (tasksKey !== this.#lastTasksKey) {
      this.#lastTasksKey = tasksKey;
      this.#tasksDirty = true;
      this.#arm();
    }
    // Koniec bez startu nie zmienia listy, więc podpis go nie widzi: zdarzenie uzbraja licznik.
    if (this.#tasks.unstartedEnds.length !== this.#endsSent) {
      this.#tasksDirty = true;
      this.#arm();
    }
    // Początek okna też nie: gdy lista wyszła bez niego, odbiorca musi go dostać osobno. Przy
    // pustej liście nie ma komu, a pierwsze zadanie i tak przyniesie bieżącą wartość.
    if (tasksKey !== '' && this.#tasks.firstEntryAt !== this.#sinceSent) {
      this.#tasksDirty = true;
      this.#arm();
    }
    if (!unknownAgentNoteLogged && this.#tasks.unknownAgentNotes > 0) {
      unknownAgentNoteLogged = true;
      this.#log(
        `rarog: transcript ${this.#agentSessionId ?? '?'}: ${UNKNOWN_AGENT_NOTE_LOG} — the notification `
        + 'counts as the subagent end, so standby closes the entry again; check the note wording '
        + 'after a CLI update (docs/background-tasks.md, "Subagent: working, waiting, finished")',
      );
    }
  }

  /**
   * Wypłata listy zadań po otwarciu pliku (przegląd i okno) albo po pudle globu (pliku nie ma, lista pusta).
   * Pierwsza w życiu followera idzie bezwarunkowo, także pusta: nadpisuje listę, którą odbiorca trzyma po
   * poprzednim followerze (wymiana drivera). Każda następna tylko przy zmianie (`#syncTasks`).
   */
  #payTasks(): void {
    if (!this.#tasksPaid) {
      this.#tasksDirty = true;
      this.#arm();
    }
    this.#syncTasks();
  }

  /**
   * Lista artefaktów — na drut (zdarzenie `artifacts`) jedzie tylko ZMIANA podpisu. Przed pierwszą
   * wypłatą (`#payArtifacts` po podpięciu) i w trakcie przeglądu po zerowaniu nie wychodzi nic: lista
   * złożona w połowie nie ma prawa się pokazać.
   */
  #syncArtifacts(): void {
    if (this.#artifactsKey === null || this.#artifactsReplay !== null) return;
    const key = artifactsSignature(this.#artifacts.artifacts);
    if (key === this.#artifactsKey) return;
    this.#artifactsKey = key;
    this.#artifactsDirty = true;
    this.#arm();
  }

  /**
   * Wypłata listy po otwarciu pliku (przegląd i okno) albo po pudle globu (pliku nie ma, lista pusta).
   * Pierwsza w życiu followera idzie bezwarunkowo, także pusta — nadpisuje listę, którą odbiorca trzyma
   * po poprzednim followerze. Każda następna (plik nowej rozmowy po `repoint`, plik, który powstał po
   * pustej wypłacie) tylko przy zmianie, jak zadania.
   */
  #payArtifacts(): void {
    if (this.#artifactsKey !== null) {
      this.#syncArtifacts();
      return;
    }
    this.#artifactsKey = artifactsSignature(this.#artifacts.artifacts);
    this.#artifactsDirty = true;
    this.#arm();
  }

  /**
   * Scala świeże pola meta z ostatnio znanymi.
   *
   * An entry that changes any cached value marks ALL the fields it carries as fresh, not only the changed one:
   * an answer that changes only the effort still carries the resolved model, which replaces an alias on the card.
   * An entry that changes nothing marks nothing.
   */
  #noteMeta(meta: JsonlMeta): void {
    let changed = false;
    if (meta.model !== undefined && meta.model !== this.#meta.model) {
      this.#meta.model = meta.model;
      changed = true;
      /*
       * Rozwiązany identyfikator potrafi POTWIERDZIĆ okno sesji: `claude-fable-5`
       * w jsonl znaczy na tym koncie okno 1M (pomiar w komentarzu przy `KNOWN_CONTEXT_LIMITS`).
       * Bez tego sesje fable bez flagi `--model` wisiały jako `unknown`, a telefon liczył
       * procent od założonych 200k — pięciokrotnie za ostro (herdr: 14%, Rarog: ~74%).
       */
      const known = KNOWN_CONTEXT_LIMITS[meta.model];
      if (known !== undefined) {
        this.#usage.confirmLimit(known, 'model');
        this.#context = this.#usage.state();
        this.#usageDirty = true;
      }
    }
    if (meta.effort !== undefined && meta.effort !== this.#meta.effort) {
      this.#meta.effort = meta.effort;
      changed = true;
    }
    if (meta.mode !== undefined && meta.mode !== this.#meta.mode) {
      this.#meta.mode = meta.mode;
      changed = true;
    }
    if (!changed) return;
    if (meta.model !== undefined) this.#metaFresh.model = meta.model;
    if (meta.effort !== undefined) this.#metaFresh.effort = meta.effort;
    if (meta.mode !== undefined) this.#metaFresh.mode = meta.mode;
    this.#metaDirty = true;
    this.#arm();
  }

  /**
   * The tracker's ultracode changed: the meta field follows it. The `meta` event carries ultracode whenever it is
   * known, plus only the fresh model, effort and mode (`#metaFresh`). `undefined` means the proof stopped counting
   * (a new CLI process, a read gap): the field gets `null` then, because the receiver reads its absence as "no
   * change". `null` stays until the next marker.
   */
  #syncUltracode(): void {
    this.#meta.ultracode = this.#ultracode.value ?? null;
    this.#metaDirty = true;
    this.#arm();
  }

  /** Nowa nazwa rozmowy → brudna flaga; ta sama wartość nie daje zdarzenia. */
  #setCustomTitle(title: string): void {
    if (title === this.#customTitle) return;
    this.#customTitle = title;
    this.#customTitleDirty = true;
    this.#arm();
  }

  /**
   * Przegląd pliku `[0, end)` w poszukiwaniu OSTATNIEGO wpisu `custom-title`: część sprzed okna ogona przy
   * podpięciu, gdy okno wpisu nie miało, oraz plik po skróceniu, przeskoku przyrostu i podmianie. Strumieniowo,
   * porcjami, z igłą przed `JSON.parse`. Wynik wchodzi tylko wtedy, gdy od startu przeglądu nie przyszedł nowszy
   * wpis, nowa sesja silnika (`#customTitleSeq`, pokolenie) ani nowszy przegląd (`#titleScan`). Brak wpisu niczego
   * nie zmienia: etykieta stoi. Nigdy nie rzuca; plik ponad sufit i błąd odczytu dają jedną linię w logu. Plik
   * otwiera `tasksScan.titleOpen`, a sufit daje `tasksScan.titleMaxBytes`, gdy test je podał.
   */
  async #scanCustomTitle(path: string, end: number): Promise<void> {
    // Numer PRZED wyjściem dla pustego pliku: plik skrócony do zera też unieważnia przegląd starej treści.
    this.#titleScan += 1;
    const scan = this.#titleScan;
    if (end <= 0) return;
    const gen = this.#generation;
    const seq = this.#customTitleSeq;
    const uuid = this.#agentSessionId ?? '?';
    if (end > (this.#tasksScan.titleMaxBytes ?? TITLE_SCAN_MAX_BYTES)) {
      this.#log(`rarog: transcript ${uuid}: ${String(end)} B to scan for the session name, more than the scan cap`);
      return;
    }
    let found: string | null = null;
    try {
      const handle = await (this.#tasksScan.titleOpen ?? ((file: string) => open(file, 'r')))(path);
      try {
        const carry = emptyCarry();
        const buffer = Buffer.allocUnsafe(Math.min(TITLE_SCAN_CHUNK_BYTES, end));
        let from = 0;
        while (from < end) {
          const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, end - from), from);
          if (this.#stale(gen) || seq !== this.#customTitleSeq || scan !== this.#titleScan) return;
          if (bytesRead === 0) break;
          from += bytesRead;
          for (const line of takeLines(carry, buffer.subarray(0, bytesRead), TITLE_SCAN_LINE_MAX_BYTES)) {
            if (!line.includes(CUSTOM_TITLE_NEEDLE)) continue;
            found = customTitleOf(parseJsonlEntry(line.toString('utf8'))) ?? found;
          }
        }
      } finally {
        await handle.close().catch(() => undefined);
      }
    } catch (error) {
      if (!this.#stale(gen)) {
        this.#log(`rarog: transcript ${uuid}: scan for the session name failed: ${describeError(error)}`);
      }
      return;
    }
    if (this.#stale(gen) || seq !== this.#customTitleSeq || scan !== this.#titleScan || found === null) return;
    this.#setCustomTitle(found);
  }

  /**
   * Zapamiętuje tożsamość pliku rozmowy i mówi, czy plik pod tą ścieżką został podmieniony (inny `dev:ino` niż
   * przy poprzednim odczycie). Nieznana tożsamość (błąd `stat`, pierwszy odczyt) podmianą nie jest.
   */
  async #noteTranscriptId(path: string, gen: number): Promise<boolean> {
    const id = await fileIdOf(path);
    // Odczyt starej sesji silnika nie nadpisuje tożsamości pliku nowej.
    if (id === null || this.#stale(gen)) return false;
    const replaced = this.#transcriptId !== null && id !== this.#transcriptId;
    this.#transcriptId = id;
    return replaced;
  }

  /** `/clear`: nowa sesja silnika = nowe okno kontekstu, nowy model, zero czekających narzędzi. */
  #resetState(): void {
    this.#usage = createUsageTracker(this.#knownContextLimit);
    this.#lastUsageSum = null;
    this.#context = null;
    this.#usageDirty = false;
    this.#meta = {};
    this.#metaFresh = {};
    this.#metaDirty = false;
    // Ultracode nowej rozmowy potwierdzi dopiero jej plik; żądanie i start procesu dotyczyły poprzedniej.
    this.#ultracode = createUltracodeTracker();
    this.#pending = createPendingTracker();
    this.#cliQueue.lose();
    /*
     * `pending: null` po resecie NIE wychodzi od razu (patrz `PENDING_REPOINT_GRACE_MS`):
     * historia nowego pliku za chwilę powie prawdę i to ONA emituje stan. Karencja niżej
     * jest siatką na `/clear` bez nowego pliku — wtedy `null` jest prawdą i musi dojechać.
     */
    const hadPending = this.#lastPendingId !== null;
    this.#pendingDirty = false;
    this.#lastPendingId = null;
    if (this.#pendingSettleTimer !== null) {
      clearTimeout(this.#pendingSettleTimer);
      this.#timers.delete(this.#pendingSettleTimer);
    }
    this.#pendingSettleTimer = null;
    if (hadPending) {
      const timer = setTimeout(() => {
        this.#timers.delete(timer);
        if (this.#pendingSettleTimer !== timer) return;
        this.#pendingSettleTimer = null;
        if (this.#closed) return;
        this.#pendingDirty = true;
        this.#arm();
      }, this.#pendingRepointGraceMs);
      timer.unref?.();
      this.#timers.add(timer);
      this.#pendingSettleTimer = timer;
    }
    // Nowa sesja silnika ma WŁASNY zrzut status line — stary limit nie ma prawa jej opisywać.
    this.#statuslineLimit = null;
    // Wywołanie komendy z poprzedniego pliku nie jest parą dla wyniku w nowym.
    this.#lastCommand = '';
    this.#fileEcho.reset();
    /*
     * Nazwa rozmowy jest per sesja silnika: nowy plik (`/clear`) niesie własny wpis, a rozmowa wznowiona
     * bez niego nie ma nazwy. Bez zdarzenia: etykieta stoi, a o regule tytułu herdr decyduje manager po `init`.
     * Licznik unieważnia przegląd starego pliku, który jeszcze trwa.
     */
    this.#customTitle = null;
    this.#customTitleDirty = false;
    this.#customTitleSeq += 1;
    this.#tasks = this.#newTasks();
    this.#endsSent = 0;
    this.#sinceSent = '';
    // Wypłata, która jeszcze nie wyszła (także pierwsza po podpięciu, `#payTasks`), idzie dalej: lista od zera
    // jest prawdą o nowej rozmowie.
    this.#tasksDirty = this.#tasksDirty || this.#lastTasksKey !== '';
    this.#lastTasksKey = '';
    /*
     * Lista artefaktów idzie za plikiem: nowa rozmowa zaczyna od pustej. Przegląd po zerowaniu,
     * który jeszcze trwa, dotyczy starego pliku — nowy numer zerowania oddaje jego wynik do kosza.
     * Pusta lista wychodzi, jeśli poprzednia pusta nie była; przed pierwszą wypłatą nie wychodzi nic.
     */
    this.#artifacts = createArtifactsTracker();
    this.#artifactsEpoch += 1;
    this.#artifactsReplay = null;
    const noArtifacts = artifactsSignature([]);
    if (this.#artifactsKey !== null && this.#artifactsKey !== noArtifacts) {
      this.#artifactsKey = noArtifacts;
      this.#artifactsDirty = true;
    }
    this.#noTranscriptReported = false;
    // Wygaszenie karty musi dojechać także wtedy, gdy nowy plik jeszcze nie powstał — inaczej
    // po `/clear` wisiałaby zgoda na narzędzie z poprzedniej sesji silnika. Ta sama racja dotyczy
    // plakietki „w tle": zadania poprzedniej sesji silnika nie mają jak się już domknąć.
    if (this.#pendingDirty || this.#tasksDirty || this.#artifactsDirty) this.#arm();
  }

  /**
   * Czy ten tekst Rarog właśnie wysłał? Trafienie ZUŻYWA wpis (jeden prompt = jedno echo);
   * `null` = nie, `token` = wpis echa odroczonego.
   *
   * Wpis z tokenem bierze tylko wpis pliku nie starszy niż rejestracja (`at` = `timestamp` wpisu,
   * pusty = nie wiemy, więc nie odcinamy) — patrz {@link ECHO_TOKEN_SKEW_MS}. `command` — wpis
   * wywołania komendy: nazwa komendy porównuje się bez względu na wielkość liter
   * ({@link commandEchoKey}). `strict` — wpis promptu zablokowanego przez hook: ten sam warunek czasu
   * obowiązuje KAŻDY wpis okna, także bez tokenu.
   */
  #takeEcho(raw: string, at = '', command = false, strict = false): { token?: string; send?: number } | null {
    const text = echoKey(raw);
    if (text === '') return null;
    this.#expireEcho();
    const written = at === '' ? Number.NaN : Date.parse(at);
    const key = command ? commandEchoKey(text) : text;
    const fresh = (e: EchoEntry): boolean => (e.token === undefined && !strict) || !Number.isFinite(written)
      || written >= e.at - ECHO_TOKEN_SKEW_MS;
    let index = this.#echo.findIndex((e) => (command ? commandEchoKey(e.text) : e.text) === key && fresh(e));
    // The own text wins: an entry's second text (`joinEcho`) counts only when no entry has this text as its own.
    // Never for a hook-blocked prompt (`strict`): a hit there makes the whole field Rarog's text, and the next send
    // would clear it, the desk draft included.
    if (index === -1 && !command && !strict) {
      const squashed = squashEchoKey(text);
      index = this.#echo.findIndex((e) => e.joined === squashed && fresh(e));
    }
    if (index === -1) return null;
    const [taken] = this.#echo.splice(index, 1);
    return {
      ...(taken?.token === undefined ? {} : { token: taken.token }),
      ...(taken?.send === undefined ? {} : { send: taken.send }),
    };
  }

  // -------------------------------------------------------------------------
  // Emisja
  // -------------------------------------------------------------------------

  /** Batching: 10 wpisów w 10 ms to jedna emisja, a nie 10 ramek SSE na telefon. */
  #push(event: FollowEvent): void {
    if (this.#closed) return;
    this.#buffer.push(event);
    this.#arm();
  }

  /** Uzbraja zrzut bufora. Wołane też przez zmiany stanu, które własnego zdarzenia nie mają. */
  #arm(): void {
    if (this.#closed || this.#flushTimer !== null) return;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      this.#flush();
    }, this.#batchMs);
    this.#flushTimer.unref?.();
  }

  /**
   * Zdarzenie, które nie może czekać (historia, `/clear`) — z zachowaniem kolejności.
   *
   * Zrzuca WYŁĄCZNIE bufor wiadomości. Stan (zużycie, meta, pending) zostaje na następny zrzut,
   * bo opisuje plik PO historii — wypuszczony przed nią wyglądałby jak zdarzenie sprzed sesji.
   */
  #emitNow(event: FollowEvent): void {
    if (this.#closed) return;
    this.#flushMessages();
    this.#queue.push(event);
  }

  #flush(): void {
    this.#flushMessages();
    this.#drainState();
  }

  /**
   * Bufor → kolejka, z JEDNYM wskaźnikiem aktywności na partię (zasada z `#drainState`).
   *
   * Aktywność jest ulotna: klient kasuje ją przy każdej wiadomości i nadpisuje przy każdej
   * kolejnej aktywności (`setActivity` w `store.ts`). Wskaźnik, po którym w TEJ SAMEJ partii
   * leci cokolwiek innego, nie ma więc jak się pokazać — do kolejki idzie tylko ten, który
   * partię zamyka. Odpowiedź asystenta z pięcioma blokami `tool_use` daje jedno zdarzenie
   * `activity`, a nie pięć ramek SSE na telefon.
   *
   * `turn-input` partii NIE zamyka: klient go nie widzi, więc niczego nie kasuje ani nie
   * nadpisuje. Bez tego wyjątku raport subagenta albo zgaszone echo promptu, przeczytane w tej
   * samej partii co `tool_use`, zabierały wskaźnik narzędzia.
   */
  #flushMessages(): void {
    if (this.#buffer.length === 0) return;
    const events = this.#buffer;
    this.#buffer = [];
    let last = events.length - 1;
    // Zdarzenia bez treści (wejście tury, wypadnięty wpis echa) nie odbierają wskaźnikowi aktywności
    // miejsca ostatniego w partii.
    while (last >= 0 && (events[last]?.type === 'turn-input' || events[last]?.type === 'echo-dropped')) last -= 1;
    for (let i = 0; i < events.length; i += 1) {
      const event = events[i];
      if (event === undefined) continue;
      if (event.type === 'activity' && i !== last) continue;
      this.#queue.push(event);
    }
  }

  /** Jedno zdarzenie na partię i na każdy rodzaj stanu — tylko dla tych, które się zmieniły. */
  #drainState(): void {
    if (this.#usageDirty && this.#context !== null) {
      this.#usageDirty = false;
      this.#queue.push({ type: 'usage', context: this.#context });
    }
    if (this.#metaDirty) {
      this.#metaDirty = false;
      const { ultracode } = this.#meta;
      this.#queue.push({ type: 'meta', ...this.#metaFresh, ...(ultracode === undefined ? {} : { ultracode }) });
      this.#metaFresh = {};
    }
    if (this.#pendingDirty) {
      this.#pendingDirty = false;
      this.#queue.push({ type: 'pending', pending: this.#pending.pending });
    }
    if (this.#customTitleDirty && this.#customTitle !== null) {
      this.#customTitleDirty = false;
      this.#queue.push({ type: 'custom-title', title: this.#customTitle });
    }
    if (this.#tasksDirty) {
      this.#tasksDirty = false;
      this.#tasksPaid = true;
      // Kopia, nie referencja: tracker mutuje swoją tablicę w miejscu, a zdarzenie ma opisywać
      // chwilę, w której powstało — inaczej odbiorca zobaczyłby stan sprzed dwóch linii pliku.
      const ended = this.#tasks.unstartedEnds.slice(this.#endsSent);
      this.#endsSent = this.#tasks.unstartedEnds.length;
      const since = this.#tasks.firstEntryAt;
      this.#sinceSent = since;
      this.#queue.push({
        type: 'tasks', tasks: [...this.#tasks.tasks],
        ...(ended.length > 0 ? { ended } : {}), ...(since !== '' ? { since } : {}),
      });
    }
    // W trakcie przeglądu po zerowaniu lista na żywo zna tylko fakty sprzed chwili: wypłata czeka na
    // jego koniec (`#finishArtifactsRescan`), a brudna flaga zostaje.
    if (this.#artifactsDirty && this.#artifactsReplay === null) {
      this.#artifactsDirty = false;
      // Tracker oddaje przy każdym odczycie nową tablicę z nowymi obiektami: kopia nie jest potrzebna.
      this.#queue.push({ type: 'artifacts', artifacts: this.#artifacts.artifacts });
    }
  }

  #after(ms: number, fn: () => void): ReturnType<typeof setTimeout> | null {
    if (this.#closed) return null;
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      if (this.#closed) return;
      fn();
    }, ms);
    timer.unref?.();
    this.#timers.add(timer);
    return timer;
  }
}

/**
 * Tworzy followera transkryptu dla jednego panelu.
 *
 * Nigdy nie rzuca: brak pliku, brak uprawnień i uszkodzone linie są normalnym stanem pracy
 * (panel może stać godzinami bez promptu, a plik powstaje dopiero przy pierwszym).
 */
export function createJsonlFollower(opts: JsonlFollowOptions): JsonlFollower {
  return new Follower(opts);
}
