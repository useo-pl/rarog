/**
 * Pojedyncza sesja w pamięci serwera: dane widoczne dla klienta + ring buffer eventów
 * + referencja do żywego drivera.
 *
 * Podział odpowiedzialności:
 * - `Session` trzyma STAN i historię (kto, gdzie, w jakim stanie, jakie wiadomości),
 * - `manager.ts` decyduje o przejściach (przez `transition()`), broadcastuje i zapisuje rejestr,
 * - driver nie wie o istnieniu tej klasy.
 *
 * `seq` domkniętych eventów pochodzi WYŁĄCZNIE z ring buffera (`RingBuffer.push`), żeby numeracja
 * w SSE (`id:`) i w `TranscriptMessage.seq` była tą samą numeracją. Delty nie wchodzą do bufora.
 */
import type {
  Activity, BackgroundTask, Block, CliDialogClass, ContextLimitState, EffortLevel, GitCommit,
  GitFileKinds, HerdrMode, KnownDialogId,
  MessageAttachment, RefuseReason, ServerEvent, SessionArtifact, SessionPullRequest, SessionScheduledTask, SessionState, SessionSummary, SessionUsage,
  TranscriptMessage, TranscriptNotice, TranscriptPromptBlocked,
} from '@rarog/shared';
import { createHash, randomBytes } from 'node:crypto';
import { MAX_TRANSCRIPT_MESSAGES } from '@rarog/shared';
import { isServerSentence, say } from '@rarog/shared/sentences';
import type { AnyText, OwnText, SentenceRef } from '@rarog/shared/sentences';
import { MAX_MESSAGE_BYTES, RING_MAX_BYTES, RingBuffer, jsonBytes } from './ring-buffer.ts';
import type { InternalBlock, SessionDriver } from '../drivers/types.ts';
import type { SmEvent } from './state-machine.ts';

/**
 * Rachunek tury od poprzedniego końca tury (kształt `TurnInput` z `notify/policy.ts`):
 * notki o postoju, notki o końcu obserwacji artefaktu, inne wiadomości `user` i wywołania narzędzi
 * głównego agenta. Patrz {@link Session.turnInput}.
 */
export interface TurnTally {
  readonly standbyNotices: number;
  readonly artifactWatch: number;
  readonly other: number;
  readonly toolCalls: number;
  /** Compaction boundaries of the main thread, counted apart from `other`. */
  readonly compactions: number;
}

/** Wiadomość z echem odroczonym — `Session.heldEchoes`. */
export interface HeldEcho {
  /** Token rejestracji w oknie echa followera. */
  readonly token: string;
  /** Bloki wiadomości użytkownika, dokładnie te, które stanęłyby w echu przy wysyłce. */
  readonly blocks: InternalBlock[];
  /** Tekst wysłany do CLI — po nim odczyt pola po turze rozpoznaje prompt, którego CLI nie przyjął. */
  readonly text: string;
  readonly clientMessageId: string;
  /** Chwila wstrzymania (ms, zegar managera) — sufit wieku. */
  readonly heldAtMs: number;
}

/**
 * Wysyłka z Raroga w pierścieniu `Session.recentSends` — jedyne źródło ładunku ponownej wysyłki promptu
 * zablokowanego przez hook (`docs/dialogs.md`, „Prompt blocked by a hook”).
 */
export interface RecentSend {
  /** Klucz echa tekstu dla CLI (`echoKey`) — po nim notka blokady wskazuje wysyłkę. */
  readonly key: string;
  /** Tekst dla CLI, z blokiem ścieżek załączników. */
  readonly raw: string;
  /** Bloki dymka (tekst bez ścieżek) i wizytówki załączników, jak w echu wysyłki. */
  readonly blocks: InternalBlock[];
  readonly attachments: readonly MessageAttachment[];
  /** Chwila wysyłki (ms, zegar managera) — sufit wieku. */
  readonly atMs: number;
}

/**
 * Ile wiadomości trzymamy w RAM na sesję. Stała mieszka w shared (ten sam sufit
 * tnie tablicę `messages` w store klienta); tu zostaje re-eksport dla dotychczasowych importów.
 */
export { MAX_TRANSCRIPT_MESSAGES };

/**
 * Ile wiadomości idzie w `transcript-snapshot`.
 *
 * 50 → 200: snapshot był najciaśniejszym z trzech sit (jsonl → RAM sesji →
 * snapshot) i to on decydował, dokąd da się przescrollować wstecz na telefonie. Teraz
 * wszystkie trzy mówią tym samym sufitem — `MAX_TRANSCRIPT_MESSAGES` (także store
 * klienta, czwarte sito), wprost tą stałą, żeby liczby nie rozjechały się przy
 * kolejnej zmianie.
 */
export const SNAPSHOT_MESSAGES = MAX_TRANSCRIPT_MESSAGES;

/** Znacznik cięcia (osobny blok `text`): jedyne miejsce, z którego człowiek wie, że wiadomość jest niepełna. */
export const MESSAGE_TRIMMED_MARK = say('transcript.trimmed-mark');

/**
 * `ref` zdania serwera w bloku transkryptu (pole `ref` bloku `text`); `undefined` = tekst obcy, literał bez kodu,
 * blok przycięty przez {@link clampMessageBlocks} (NOWY obiekt bez `ref`: tłumaczenie przyciętego bloku odtworzyłoby
 * treść, której tekst nie pokazuje).
 */
export function blockRef(block: Block): SentenceRef | undefined {
  return block.type === 'text' ? block.ref : undefined;
}

/** Blok tekstu z drutu z tekstu o znanym pochodzeniu: zdanie serwera niesie obok tekstu swój `ref`. */
function wireText(text: AnyText): Block {
  return isServerSentence(text) ? { type: 'text', text: text.text, ref: text.ref } : { type: 'text', text: text.text };
}

/**
 * Bloki wewnętrzne → bloki z drutu (`Block` z `protocol.ts`). JEDYNE miejsce tej serializacji: zdanie z `say()`
 * wychodzi jako tekst z `ref`, `foreign` jako sam tekst, a ucięcie `detail` wywołania narzędzia jedzie
 * polem `truncation` tylko razem z `detail` (bez ciętego tekstu kontrakt blok odrzuca).
 */
export function wireBlocks(blocks: readonly InternalBlock[]): Block[] {
  return blocks.map((block): Block => {
    if (block.type === 'text') return wireText(block.text);
    if (block.type === 'tool-call') {
      const { truncation, ...wire } = block;
      return truncation === undefined || wire.detail === undefined
        ? wire : { ...wire, truncation: { cut: truncation.cut, footer: truncation.footer } };
    }
    return block;
  });
}

/**
 * Dopisek stanu na drut: JEDNO miejsce dla `Session.summary()` i zdarzenia `state`. Zdanie z `say()` daje tekst
 * i `stateDetailRef`; limit planu (`state.limit-reached`) daje token `resetAt=<ISO>`, który stara apka czyta regexem,
 * i ten sam `ref`; `foreign` sam tekst; brak zdania żadnego pola.
 */
export function wireStateDetail(detail: AnyText | undefined): { stateDetail?: string; stateDetailRef?: SentenceRef } {
  if (detail === undefined) return {};
  if (!isServerSentence(detail)) return { stateDetail: detail.text };
  const reset = detail.ref.code === 'state.limit-reached' ? detail.ref.args?.[0] : undefined;
  return { stateDetail: reset === undefined ? detail.text : `resetAt=${reset}`, stateDetailRef: detail.ref };
}

/** `labelRef` etykiety nadanej numeracją: tylko tekst równy zdaniu `session.fallback-label` dla swojego numeru. */
export function fallbackLabelRef(label: string | undefined): SentenceRef | undefined {
  const n = label === undefined ? undefined : /^session ([1-9]\d*)$/u.exec(label)?.[1];
  if (n === undefined || !Number.isSafeInteger(Number(n))) return undefined;
  const sentence = say('session.fallback-label', { n: Number(n) });
  return sentence.text === label ? sentence.ref : undefined;
}

/**
 * Wiadomość zmieszczona w {@link MAX_MESSAGE_BYTES} — z JAWNYM znacznikiem cięcia.
 *
 * Bloki idą od początku, bo początek wiadomości niesie treść, a ogon bywa wypisem narzędzia.
 * Blok, który sam nie mieści się w resztce budżetu, jest przycinany po ZNAKACH (tekst) albo
 * pomijany (obrazek — połowa base64 nie jest obrazkiem). Funkcja jest czysta i przy
 * wiadomości mieszczącej się w budżecie oddaje DOKŁADNIE tę samą tablicę.
 */
export function clampMessageBlocks(blocks: Block[], maxBytes = MAX_MESSAGE_BYTES): Block[] {
  if (jsonBytes(blocks) <= maxBytes) return blocks;
  const mark = wireText(MESSAGE_TRIMMED_MARK);
  // Budżet liczymy PO odjęciu znacznika i narzutu pustego bloku: sufit ma być sufitem
  // całej wiadomości, a nie samej jej treści.
  const budget = maxBytes - jsonBytes([mark]);
  const empty = jsonBytes({ type: 'text', text: '' } satisfies Block);
  const out: Block[] = [];
  let spent = 0;
  for (const block of blocks) {
    const weight = jsonBytes(block) + 1; // +1 = przecinek między blokami w tablicy JSON
    if (spent + weight <= budget) {
      out.push(block);
      spent += weight;
      continue;
    }
    if (block.type === 'text') {
      const room = budget - spent - empty - 1;
      if (room > 0) out.push({ type: 'text', text: sliceToJsonBytes(block.text, room) });
    }
    break;
  }
  out.push(mark);
  return out;
}

/** Najdłuższy początek tekstu, którego JSON mieści się w `room` bajtach. */
function sliceToJsonBytes(text: string, room: number): string {
  let cut = text.slice(0, room);
  while (cut !== '' && jsonBytes(cut) > room) {
    // Skalujemy proporcjonalnie (escape'y JSON-a potrafią rozdąć tekst), ale ZAWSZE o co
    // najmniej jeden znak — inaczej przy stosunku bliskim 1 pętla stałaby w miejscu.
    const scaled = Math.floor(cut.length * (room / jsonBytes(cut)));
    cut = cut.slice(0, Math.max(0, Math.min(scaled, cut.length - 1)));
  }
  return cut;
}

export interface SessionInit {
  id: string;
  cwd: string;
  title: string;
  /** Człon sesji w tytule `projekt · sesja` — patrz `sessionLabel()` w managerze. */
  label?: string;
  state: SessionState;
  stateDetail?: OwnText;
  stateSince: string;
  createdAt: string;
  lastActivityAt: string;
  branch?: string;
  dirtyCount?: number;
  ahead?: number;
  behind?: number;
  fileKinds?: GitFileKinds;
  lastCommit?: GitCommit;
  usage?: SessionUsage;
  /** Zużycie kontekstu Z informacją, czy limit okna jest w ogóle znany. */
  context?: ContextLimitState;
  lastSummary?: string;
  engineSessionId?: string;
  /**
   * Uuid sesji silnika, którego Rarog NIE traktuje jak tożsamości wznowienia.
   *
   * Osobne pole od `engineSessionId`, bo tamto znaczy w managerze jedną konkretną rzecz:
   * „ta karta PISZE do pliku jsonl o tej nazwie" (indeks `#byEngineSession`, `resume`,
   * bramka dwóch pisarzy). Uuid Codexa nie opisuje żadnego pliku, który Rarog czyta —
   * służy WYŁĄCZNIE za trwały adres znacznika „obejrzane".
   */
  observedSessionId?: string;
  /** Silnik panelu; obecny wyłącznie dla Codexa — brak znaczy „Claude". */
  engine?: 'codex';
  /** Terminal Raroga, w którym chodzi ten panel (`tokens['rarog-term']`) */
  termId?: string;
  permissionMode?: string;
  model?: string;
  effort?: EffortLevel;
  /** Ultracode tej sesji CLI: żądane przy starcie flagą, potem znaczniki z jsonl; brak = nie wiemy. */
  ultracode?: boolean;
  /** Wersja CLI zainstalowana w chwili, gdy panel uruchomił Rarog; tylko w pamięci procesu serwera. */
  cliVersionAtLaunch?: string;
  ringCapacity?: number;
  herdrMode?: HerdrMode;
  outOfScope?: boolean;
  /** Adres panelu w herdr (`w9:p72`) — do deep-linku „Pokaż w herdr" i diagnostyki. */
  paneId?: string;
  /** Agenta uruchomił Rarog (nazwa `rarog-<6 hex>` ∪ klucze tego procesu) — chip i sufit. */
  launchedByRarog?: boolean;
  /** `HerdrAgent.key` — tylko dla origin `herdr` (patrz pole `herdrKey`). */
  herdrKey?: string;
  /** `true` = herdr raportuje `idle` (wynik już widziany). Ustawia to wyłącznie origin `herdr`. */
  seen?: boolean;
  /** `state_change_seq` panelu w chwili powstania karty — adres znacznika „widziane". */
  herdrSeq?: number;
}

/** Wynik dopisania wiadomości — manager potrzebuje i `seq`, i gotowego eventu do broadcastu. */
export interface AppendedMessage {
  seq: number;
  message: TranscriptMessage;
  event: ServerEvent;
}

/** Pola wiadomości spoza treści — każde nieobecne, dopóki ktoś go jawnie nie poda. */
export interface MessageExtra {
  /** Identyfikator wysyłki od klienta (echo `POST …/messages` z `clientMessageId`). */
  clientMessageId?: string;
  /** Notka harnessu z jsonl — wpis `user`, którego nikt nie napisał. */
  notice?: TranscriptNotice;
  /** Notka o prompcie zablokowanym przez hook — `TranscriptMessage.promptBlocked`. */
  promptBlocked?: TranscriptPromptBlocked;
}

/**
 * A closed message in its wire shape, `seq` 0 until the ring numbers it: wire blocks clamped to
 * {@link MAX_MESSAGE_BYTES}, a copy of the attachment cards and of the extra fields ({@link Session.appendMessage}).
 */
export function transcriptMessage(
  role: TranscriptMessage['role'], blocks: readonly InternalBlock[], at: string,
  attachments?: readonly MessageAttachment[], extra: MessageExtra = {},
): TranscriptMessage {
  const message: TranscriptMessage = { seq: 0, role, blocks: clampMessageBlocks(wireBlocks(blocks)), at };
  // Pole nieobecne, a nie puste: wiadomość bez załączników ma wyglądać dokładnie tak samo
  // jak wiadomość bez tego pola (i tak samo w ramce SSE, którą porównują testy kontraktowe).
  if (attachments !== undefined && attachments.length > 0) {
    message.attachments = attachments.map((a) => ({ ...a }));
  }
  // Identyfikator wysyłki wyłącznie w echu wiadomości wysłanej z Raroga z tym polem.
  if (extra.clientMessageId !== undefined) message.clientMessageId = extra.clientMessageId;
  if (extra.notice !== undefined) message.notice = { ...extra.notice };
  if (extra.promptBlocked !== undefined) message.promptBlocked = { ...extra.promptBlocked };
  return message;
}

export class Session {
  readonly id: string;
  readonly cwd: string;
  readonly title: string;
  readonly createdAt: string;
  readonly ring: RingBuffer<ServerEvent>;

  /**
   * Wynik BIEŻĄCEJ tury odebrał człowiek.
   *
   * Trzy wartości: `undefined` = tura trwa albo wynik czeka na odbiór, `false` = herdr
   * potwierdza stojący badge `done` (jedyny stan uprawniający `agent.focus` przy odbiorze),
   * `true` = odebrane (tapnięcie w kliencie albo fokus panelu PO zakończeniu tury).
   *
   * Pole NIE jest lustrem statusu herdr (`idle` → `true`): wtedy wynik tury zaczętej
   * na sfokusowanym panelu nigdy nie trafiałby do głowy listy. Surową wartość z herdr trzyma
   * {@link Session.herdrSeen}; o odbiorze decyduje manager.
   */
  seen: boolean | undefined;
  /**
   * OSTATNIE surowe `seen` z drivera herdr (`idle` → `true`, `done` → `false`). Pole
   * SERWEROWE, nie ma go w `summary()`.
   *
   * Jedyne zastosowanie: odróżnić `done → idle` („ktoś sfokusował panel PO turze", czyli
   * odbiór) od `idle → idle` z resyncu („panel był na wierzchu, gdy tura się kończyła"),
   * które odbiorem nie jest. Bez tej pamięci herdrowe `idle` chowałoby świeży wynik w ogonie
   * „bezczynni" co 30 s, bez szansy na wyjście.
   */
  herdrSeen: boolean | undefined;
  /**
   * Wynik BIEŻĄCEJ tury odebrał CZŁOWIEK (tapnięcie karty w kliencie albo „Pokaż w herdr”).
   * Pole SERWEROWE, nie ma go w `summary()`; zerowane razem z {@link Session.seen}.
   *
   * Osobne od `seen`, bo `seen === true` ma DWA źródła i tylko jedno z nich jest odbiorem:
   * adopcja panelu `idle` przy starcie Raroga też daje `true` (nikt tego wyniku nie czytał).
   * Bez tego rozróżnienia spóźniony `done` z herdr albo cofałby świeży odbiór („karta wraca
   * do głowy listy kilkanaście sekund po przeczytaniu”), albo na zawsze chował wynik panelu
   * zastanego jako `idle`.
   *
   * The voice agent's pick-up sets it too, as a real receipt; {@link Session.seenBy} then says who received.
   */
  seenByHuman: boolean | undefined;
  /**
   * The voice agent received the result of the CURRENT turn, not a human (its pick-up through `markSeen` in
   * `seen-marks.ts`). Server field, carried as `seenBy` in `summary()` while `seen` is `true` and kept in the durable
   * seen entry. It goes with every human receipt (the session opened in the app, "Show in herdr"), with "mark as
   * unread", at a turn start, and whenever `seen` stops being `true`.
   */
  seenBy: SessionSummary['seenBy'];
  /**
   * Człowiek oznaczył wynik BIEŻĄCEJ tury jako nieprzeczytany. Pole SERWEROWE, zerowane razem
   * z {@link Session.seen} na starcie tury i przy każdym odbiorze.
   *
   * Potrzebne, bo znacznik trwały „nieprzeczytane” stoi pod numerem stanu z chwili gestu, a numer
   * rośnie także bez nowej tury (spóźnione `idle` po fokusie z `markSeen`). Bez przepisania wpisu na
   * nowy numer adopcja po restarcie Raroga nie poznałaby go i karta wracałaby jako odebrana.
   *
   * The card carries it as `markedUnseen` while `seen` is not `true`: the app does not pulse the list dot
   * of a result marked unread by hand.
   */
  unseenByHuman: boolean | undefined;
  /**
   * Rarog stracił kontakt ze źródłem prawdy o tej sesji (padł socket herdr). Stan sesji
   * zostaje ostatni znany — to NIGDY nie jest przejście stanu, tylko znacznik nieświeżości.
   */
  stale: boolean | undefined;
  /** Tryb uprawnień panelu; ostatnia odczytana wartość ze stopki ekranu. */
  herdrMode: HerdrMode | undefined;
  /**
   * Dialog spoza jsonl ROZPOZNANY z zamkniętej listy sygnatur (
   * „Dialogs and cards in a herdr pane” w `docs/implementation-spec.md`).
   *
   * Jedyny sens tego pola: „Rarog wie, co stoi w panelu, więc wolno mu wystawić przycisk
   * zatwierdzania". `undefined` = dialog nierozpoznany albo żadnego nie ma — i to jest
   * wariant domyślny oraz bezpieczny (sam „Odrzuć (Esc)"). Ustawia je WYŁĄCZNIE zdarzenie
   * `screen-dialog` z drivera, kasuje `permission-cleared` i każde wyjście z blokady.
   */
  herdrDialog: KnownDialogId | undefined;
  /**
   * DLACZEGO karta dialogu nie ma przycisków — powód z `REFUSE_REASONS` („Refusal diagnostics” w `docs/dialogs.md`).
   *
   * Wyłącznie treść karty w kliencie; o przyciskach decyduje `herdrDialog`. Ustawia je ta sama
   * ocena drivera, która zapisuje odmowę w dzienniku, kasuje `permission-cleared` i każde
   * wyjście z blokady — dokładnie tak jak `herdrDialog`, bo oba opisują JEDEN dialog.
   */
  herdrDialogReason: RefuseReason | undefined;
  /**
   * CO WIDAĆ w panelu — wycinek ekranu dialogu na kartę.
   *
   * Ta sama trójka reguł co przy `herdrDialogReason`: wyłącznie treść karty, ustawiana przez
   * ocenę drivera, kasowana razem z kartą. Wcześniej ta treść jechała wiadomością systemową
   * do transkryptu i tam ZOSTAWAŁA — dziś znika razem z dialogiem, którego dotyczy.
   */
  herdrDialogScreen: string | undefined;
  /**
   * JAKI dialog stoi w terminalu według rejestru sesji CLI — klasa, nie treść.
   *
   * Ta sama trójka reguł co przy `herdrDialogReason`: wyłącznie treść karty bez decyzji,
   * ustawiana przez ocenę drivera (zdarzenie karty niesie ją tylko przy rejestrze `waiting`),
   * kasowana razem z kartą.
   */
  cliDialog: CliDialogClass | undefined;
  /** Panel spoza `RAROG_HERDR_ROOTS`: karta bez transkryptu i bez wysyłki. */
  outOfScope: boolean | undefined;
  /** Adres panelu w herdr; zmienia się przy `pane move`, więc NIGDY nie jest kluczem. */
  paneId: string | undefined;
  /**
   * Agenta w panelu uruchomił Rarog — `HerdrAgent.launchedByRarog` (nazwa agenta
   * `rarog-<6 hex>` ∪ klucze tego procesu). `undefined` poza originem `herdr`; UI czyta brak
   * jako `false`.
   */
  launchedByRarog: boolean | undefined;
  /**
   * `HerdrAgent.key` — adres tej sesji po stronie nadzorcy. Pole SERWEROWE: nie ma go ani
   * w `summary()`: klient adresuje sesję wyłącznie `id`. Manager trzyma mapę `key → id`;
   * to jest droga powrotna (throttle wysyłki i lista ukrytych są kluczowane po `key`).
   */
  herdrKey: string | undefined;
  /**
   * Ostatni znany `state_change_seq` panelu. Pole SERWEROWE (nie ma go w `summary()`).
   *
   * Jedyne zastosowanie: znacznik „widziane z telefonu" zapisuje się PRZY numerze stanu,
   * więc trzeba wiedzieć, przy którym. Numer rośnie z każdą zmianą stanu panelu, więc nowy
   * wynik unieważnia znacznik bez żadnego kasowania.
   */
  herdrSeq: number | undefined;
  /**
   * Kiedy użytkownik OSTATNIO przerwał tę sesję (ms, RAM). Karencja dla spóźnionego pusha
   * `working` z tury ubitej tuż po starcie (Esc pół sekundy po wysyłce → push `working`
   * przychodzi PO przejściu w `waiting-input` i bez karencji wskrzesiłby „pracuje"
   * na stałe, bo żaden kolejny push już nie nadchodzi).
   */
  interruptedAtMs: number | undefined;
  /**
   * Kiedy ostatnio pytaliśmy gita o TĘ sesję (ms). Tylko dla origin `herdr` i tylko w RAM:
   * `GitStatusWatcher` throttluje per KATALOG, a 17 paneli potrafi mieć wspólne katalogi
   * i własne tempo tool-calli.
   */
  lastGitStatusAt: number | undefined;
  /**
   * Podpis OSTATNIEGO `git-status` tej sesji — cała rozgłoszona ramka eventu.
   * Tylko w RAM. Służy jednemu: wymuszony odczyt, który nie przyniósł żadnej zmiany, nie ma
   * po co budzić telefonu — porównanie z tym podpisem jest jedynym sposobem, żeby to wiedzieć,
   * bo lista plików nie mieści się w `summary()`.
   *
   * Otwarcie transkryptu bez odczytu (throttle) ponawia {@link lastGitEvent}; gdy jej nie ma,
   * KASUJE podpis — wtedy najbliższy odczyt wymuszony rozgłosi raz (`manager.transcript`).
   */
  lastGitSignature: string | undefined;
  /**
   * OSTATNIA ROZGŁOSZONA ramka `git-status` tej sesji (odczyt pominięty przez dedup jej nie
   * podmienia — treść jest ta sama). Tylko w RAM. Klient wchodzący w transkrypt w oknie
   * throttle'a dostaje ją ponownie: lista plików i jej szczegóły istnieją wyłącznie w tej ramce.
   */
  lastGitEvent: Extract<ServerEvent, { type: 'git-status' }> | undefined;

  /**
   * Człon sesji w tytule. Zmienny, ale tylko raz: pusta sesja startuje z `sesja N`
   * i przejmuje słowa pierwszej wiadomości użytkownika (patrz `manager.sendMessage`).
   */
  label: string | undefined;

  state: SessionState;
  /** Dopisek stanu na karcie (`SessionSummary.stateDetail`): zdanie serwera, na drut idzie jego tekst. */
  stateDetail: OwnText | undefined;
  stateSince: string;
  /**
   * Start of the current turn (`SessionSummary.turnSince`), kept through permission and question inside the turn;
   * `undefined` outside a turn and before the start is known. Set by `activity-clocks.ts` only.
   */
  turnSince: string | undefined = undefined;
  lastActivityAt: string;
  branch: string | undefined;
  dirtyCount: number | undefined;
  ahead: number | undefined;
  behind: number | undefined;
  /** Brudne pliki po rodzajach (`+3 ~5 −1`); `undefined`, dopóki nie było odczytu gita. */
  fileKinds: GitFileKinds | undefined;
  /** Ostatni commit (`git log -1`) — jak liczniki wyżej: prawda o KATALOGU, nie o sesji. */
  lastCommit: GitCommit | undefined;
  /** Zużycie kontekstu żyje wyłącznie w RAM — po restarcie silnik i tak liczy od nowa. */
  usage: SessionUsage | undefined;
  /**
   * Zużycie kontekstu Z informacją, czy limit okna jest POTWIERDZONY.
   *
   * Osobne od `usage`, bo najczęstszym stanem jest `unknown`: w jsonl nie ma limitu okna,
   * a identyfikator modelu okna nie rozstrzyga (`herdr/jsonl-usage.ts`). UI rysuje pasek wyłącznie dla `known`.
   */
  context: ContextLimitState | undefined;
  /**
   * Żywe zadania w tle (`docs/background-tasks.md`) — stan ULOTNY, jak `context`.
   *
   * Nie ma go w `SessionInit` i nie ma po co: jedynym źródłem jest transkrypt, a follower
   * odtwarza listę z okna ogona przy KAŻDYM podpięciu, więc po restarcie Raroga wraca sama.
   * `undefined` = nic nie leci albo nie ma odczytu; pustej tablicy tu nie trzymamy.
   */
  backgroundTasks: readonly BackgroundTask[] | undefined;
  /**
   * Artefakty bieżącej rozmowy (`docs/artifacts.md`) — stan ULOTNY jak `backgroundTasks`: jedynym
   * źródłem jest plik rozmowy, a follower wypłaca listę przy każdym podpięciu, także pustą. `undefined`
   * = brak artefaktów albo brak odczytu; pustej tablicy tu nie trzymamy.
   */
  artifacts: readonly SessionArtifact[] | undefined;
  /**
   * The PRs the card shows (`docs/pull-requests.md`): the owner's PRs among `pullRequestLinks`, recomputed by
   * `pr-status-link.ts` from the links, the window and the facts from GitHub. VOLATILE like `artifacts`. `undefined`
   * = none shown; an empty array is never kept here.
   */
  pullRequests: readonly SessionPullRequest[] | undefined;
  /**
   * Pull requests linked to the current conversation (the driver's `pull-requests` event, newest first, at most 100)
   * and the time of the conversation's first entry. VOLATILE like `pullRequests` and cleared with it when the
   * conversation changes; `pullRequests` is what the card shows from them. `undefined` = no links or no read.
   */
  pullRequestLinks: readonly SessionPullRequest[] | undefined;
  pullRequestWindowStart: string | undefined;
  /**
   * Scheduled tasks of the current conversation (`docs/scheduled-tasks.md`), VOLATILE like `pullRequests`: the driver
   * reads them from the conversation file and pays the list out at every attach. `undefined` = none or no read.
   */
  scheduledTasks: readonly SessionScheduledTask[] | undefined;
  lastSummary: string | undefined;
  engineSessionId: string | undefined;
  /**
   * Uuid sesji silnika BEZ prawa do indeksu pisarzy — patrz `SessionInit`.
   *
   * Pole SERWEROWE: nie ma go w `summary()`. Klient nie ma co zrobić z uuidem rollouta
   * Codexa, którego Rarog i tak nie czyta, a znacznik „obejrzane" zapisuje serwer.
   */
  observedSessionId: string | undefined;
  /**
   * Silnik panelu — `'codex'` albo `undefined` (Claude).
   *
   * Niezmienny przez całe życie karty: zmiana silnika w tym samym panelu to `gone` +
   * `appeared` w nadzorcy, czyli NOWA karta. Gdyby to pole dało się przestawić w miejscu,
   * karta Codexa odziedziczyłaby po Claude transkrypt, indeks pisarzy i prawo wysyłki.
   */
  engine: 'codex' | undefined;
  /** Terminal Raroga, w którym chodzi ten panel. `undefined` = nie ma dokąd wejść. */
  termId: string | undefined;
  permissionMode: string | undefined;
  /**
   * Model silnika. Zmienny: startuje jako to, co wybrał użytkownik (alias `sonnet`), a po
   * evencie `init` zostaje nadpisany identyfikatorem ROZWIĄZANYM przez silnik.
   */
  model: string | undefined;
  /** Effort ZAŻĄDANY przez użytkownika (silnik może go po cichu obniżyć — tego nie wiemy). */
  effort: EffortLevel | undefined;
  /**
   * Ultracode tej sesji CLI, osobno od poziomu effortu: żądane do pierwszego dowodu, potem znaczniki z jsonl
   * bieżącego procesu CLI. `undefined` = nie wiemy (ustawienia Claude Code mogą je włączyć bez wiedzy Raroga).
   */
  ultracode: boolean | undefined;
  /**
   * Wersja CLI zainstalowana w chwili startu panelu przez Raroga: zapas dla bramki wersji, gdy rejestr
   * procesów CLI nie ma jeszcze wpisu świeżego panelu. Pole SERWEROWE: nie ma go w `summary()` ani w rejestrze.
   */
  cliVersionAtLaunch: string | undefined;
  /** Żywy driver albo `null` (sesja zamknięta, wznawialna, albo odtworzona z rejestru). */
  driver: SessionDriver | null = null;
  /**
   * Rachunek tury od poprzedniego końca tury: ile było notek o postoju subagenta, ile
   * notek o końcu obserwacji artefaktu, ile czegokolwiek innego roli `user` i ile wywołań narzędzi
   * głównego agenta. Pole SERWEROWE, nie ma go w `summary()` ani w rejestrze.
   *
   * `undefined` = rachunek NIEPEŁNY i nie wolno z niego wnioskować: po podpięciu drivera i po
   * każdej porcji historii (wiadomości trwającej tury stoją w historii, której nie liczymy), po
   * utracie ciągłości pliku rozmowy (nowa rozmowa w panelu, skrócenie, przeskok przyrostu) i po
   * końcu tury z pustym rachunkiem (wiadomość tej tury mogła jeszcze nie dojść z pliku i doliczy
   * się do następnej). Pełny robi się przy następnym końcu PRAWDZIWEJ tury, który manager zobaczy.
   *
   * Liczy manager (`#noteTurnInput`, `#noteToolCalls`), zamyka koniec tury (`#applyTransition`),
   * czyta harmonogram powiadomień: tura bez wyniku (`noResultTurn`) nie daje „gotowe".
   */
  turnInput: TurnTally | undefined = undefined;
  /**
   * Koniec tury po samym meldunku o artefakcie, w której manager nie zobaczył wywołania narzędzia:
   * zdarzenie końca, rachunek z tej chwili i czas. Also a turn after a compaction alone.
   * Wpis wywołania mógł dojść z pliku już po końcu tury (follower, zgubione zdarzenie systemu plików);
   * manager poprawia wtedy rachunek tamtej tury i podaje jej koniec harmonogramowi drugi raz
   * (`#noteToolCalls`). Zastępuje go każdy następny koniec tury, gasi pierwsze wejście następnej.
   * Pole SERWEROWE, RAM.
   */
  quietTurnEnd: { readonly event: SmEvent; readonly turn: TurnTally; readonly atMs: number } | undefined = undefined;
  /**
   * The received result of the previous turn across a turn without a result (`carrySeenAcrossTurn` in
   * `seen-marks.ts`): `armed` = the turn started with the previous result received, `restored` = its end put the
   * receipt back. Server field, RAM, not in `summary()`.
   */
  seenCarry: 'armed' | 'restored' | undefined = undefined;
  /** Who received the previous result (`seenBy` before the turn start), put back with a carried receipt. RAM. */
  seenCarryBy: SessionSummary['seenBy'] = undefined;
  /**
   * Wiadomości wysłane z Raroga z echem ODROCZONYM, w kolejności wysyłki: czekają, aż CLI
   * weźmie prompt (wpis w pliku rozmowy z tokenem echa), albo na spłukanie. Pole SERWEROWE, RAM —
   * restart Raroga je gubi, a plik rozmowy odtwarza prompty już przetworzone. Zarządza manager.
   */
  heldEchoes: HeldEcho[] = [];
  /** Spłukanie wstrzymanych echa po wyjściu z tury; `null` = nieuzbrojone. */
  heldFlushTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Numer ostatniego odczytu pola dla wstrzymanych wiadomości (prompt zablokowany przez hook w trakcie
   * tury). Odczyt trwa (`await` w driverze), a timer spłukania zeruje się przed nim, więc `#disarmHeldFlush`
   * go nie zatrzyma: wynik liczy się tylko przy numerze, który wciąż jest ostatni. Pole SERWEROWE, RAM.
   */
  heldCheckOp = 0;
  /*
   * Prompt zablokowany przez hook `UserPromptSubmit` (`docs/dialogs.md`, „Prompt blocked by a hook”).
   * Wszystkie cztery pola są SERWEROWE (RAM) i nie ma ich w rejestrze. Na drut idą wyłącznie `seq` i `id`
   * z `promptBlocked` (`SessionSummary.promptBlocked`, liczone w `#summaryOf` managera).
   */
  /**
   * Ostatnie wysyłki z Raroga (`#sendToHerdr` i prompt startowy), sufit `ECHO_WINDOW` i wiek `ECHO_TTL_MS`.
   * Po kluczu echa notka blokady wskazuje ładunek ponownej wysyłki.
   */
  recentSends: RecentSend[] = [];
  /**
   * Tura otwarta wysyłką z Raroga do sesji, która nie pracowała: klucze echa wysyłek, których CLI jeszcze nie
   * przyjął, i chwila ostatniej. Zastępuje rachunek tury (po podpięciu drivera bywa `undefined`) przy decyzji,
   * czy blokada zdejmuje sesję z „pracuje”: dopiero blokada OSTATNIEJ niezamkniętej wysyłki. Następna wysyłka
   * do sesji w „pracuje” dopisuje się, póki tury nic nie potwierdziło (druga wysyłka przed blokadą pierwszej).
   * Gasi go wpis asystenta, wejście tury albo wpis `user` z pliku, wysyłka do sesji
   * w innym stanie i wiek 60 s.
   */
  turnOpenedBySend: { readonly keys: readonly string[]; readonly atMs: number } | undefined = undefined;
  /** Chwila blokady, która zdjęła sesję z „pracuje” — karencja na spóźniony `working` z herdr (6 s). */
  blockedAtMs: number | undefined = undefined;
  /**
   * Notka blokady, której przycisk „Uruchom ponownie i wyślij” działa: `seq` notki, losowy `id` tej
   * blokady i wysyłka z pierścienia — ładunek restartu z `{resend: {seq, id}}`. `id` jest potrzebny, bo karta
   * po restarcie numeruje transkrypt od zera i nowa notka może dostać ten sam `seq`. Tylko przy blokadzie
   * wysyłki z Raroga; gasi ją następna wysyłka, wpis `user` albo wejście tury z pliku, `/exit` restartu
   * (ładunek przechodzi do `RestartOp`), odpięcie i wyjście drivera.
   */
  promptBlocked: { readonly seq: number; readonly id: string; readonly send: RecentSend } | undefined = undefined;
  /**
   * Sesja założona BEZ pierwszego promptu — po `init` z drivera ma od razu czekać na
   * użytkownika zamiast wisieć w `running`. Flaga jest ulotna (gaśnie po pierwszym `init`)
   * i nie trafia ani do rejestru, ani do klienta.
   */
  emptyStart = false;
  /**
   * Karta WSTAJE: powstała w `starting` i od tej chwili nic nie zaczęło tury.
   * Pierwsze wyjście z tury przy zapalonej fladze to wstanie, nie koniec tury — bez „gotowe” i bez domknięcia
   * rachunku wiadomości (`#applyTransition` w managerze). Gaśnie przy tym wyjściu i przy każdym zdarzeniu,
   * które zaczyna turę, także przejściu-tożsamości: `init` z historii pliku przestawia kartę na `running`,
   * zanim ruszy cokolwiek. Ulotna jak {@link emptyStart}.
   */
  awaitingFirstTurn: boolean;
  /**
   * Panel założony przez Raroga jeszcze nie jest gotowy: `#finishLaunch` w managerze czeka na `ready` uchwytu
   * startu. Do tej chwili karta nie wchodzi do stanu wysyłki: `init` z historii pliku wznawianej rozmowy
   * i `idle` herdr wyprzedzające gotowość zostawiają ją w `starting`, a zamknięty dialog startowy (zaufanie
   * katalogu) cofa ją do `starting`. Wysyłka odmawia w każdym stanie karty, bo `agent.prompt` przed gotowością
   * panelu kończy się `agent_not_ready`. Ulotna jak {@link emptyStart}.
   */
  launchPending = false;
  /**
   * Ostatnia znana aktywność agenta (myśli / narzędzie / czeka). Ulotna jak delty: żyje
   * wyłącznie w RAM, nie ma jej w rejestrze ani w ring bufferze. Jedyny powód istnienia:
   * telefon, który podłącza się w ŚRODKU długiej tury, dostaje ją w `transcript-snapshot`
   * i od razu widzi, że coś się dzieje — zamiast czekać na kolejny event.
   */
  activity: Activity | null = null;
  /** When the manager set {@link activity} (ms, manager clock): the age in summaries and snapshots. */
  activityAtMs: number | undefined = undefined;

  readonly #messages: TranscriptMessage[] = [];
  /** Suma wag wiadomości w `#messages` — drugi sufit transkryptu (bajty, nie sztuki). */
  #messageBytes = 0;
  /**
   * Random name of this memory of the session for {@link readMark}: a card made again under the same id (a pane that
   * resumes the same conversation) numbers its messages from 1 again.
   */
  readonly #memoryId = randomBytes(6).toString('base64url');
  /**
   * Ring `seq` of the newest event when the pane last moved to another engine conversation (`/clear`, `/resume`); `0`
   * before any move. A message in memory with a higher `seq` belongs to the conversation the session writes now
   * ({@link lastMessageOfConversation}). Server-side only: not in `summary()` and not on the wire. When the history
   * imported since the last `init` came from the conversation the next `init` names, the move starts before that
   * history instead ({@link importedHistory}).
   */
  conversationStartSeq = 0;
  /**
   * History imported since the last `init`: the engine conversation it was read from and the ring `seq` of the newest
   * event before its first message. Every `init` clears it; `undefined` = none, or the driver did not name it.
   */
  importedHistory: { readonly engineSessionId: string; readonly fromSeq: number } | undefined = undefined;

  constructor(init: SessionInit) {
    this.id = init.id;
    this.cwd = init.cwd;
    this.title = init.title;
    this.label = init.label;
    this.createdAt = init.createdAt;
    this.state = init.state;
    this.awaitingFirstTurn = init.state === 'starting';
    this.stateDetail = init.stateDetail;
    this.stateSince = init.stateSince;
    this.lastActivityAt = init.lastActivityAt;
    this.branch = init.branch;
    this.dirtyCount = init.dirtyCount;
    this.ahead = init.ahead;
    this.behind = init.behind;
    this.fileKinds = init.fileKinds;
    this.lastCommit = init.lastCommit;
    this.usage = init.usage;
    this.context = init.context;
    this.lastSummary = init.lastSummary;
    this.engineSessionId = init.engineSessionId;
    this.observedSessionId = init.observedSessionId;
    this.engine = init.engine;
    this.termId = init.termId;
    this.permissionMode = init.permissionMode;
    this.model = init.model;
    this.effort = init.effort;
    this.ultracode = init.ultracode;
    this.cliVersionAtLaunch = init.cliVersionAtLaunch;
    this.seen = init.seen;
    this.stale = undefined;
    this.herdrMode = init.herdrMode;
    // Rozpoznanego dialogu NIE MA jak odtworzyć z inicjalizacji: bierze się wyłącznie
    // z odczytu ekranu żywego panelu, więc świeża sesja startuje bez niego (fail-closed).
    this.herdrDialog = undefined;
    this.herdrDialogReason = undefined;
    this.herdrDialogScreen = undefined;
    this.cliDialog = undefined;
    this.outOfScope = init.outOfScope;
    this.paneId = init.paneId;
    this.launchedByRarog = init.launchedByRarog;
    this.herdrKey = init.herdrKey;
    this.herdrSeq = init.herdrSeq;
    this.interruptedAtMs = undefined;
    this.lastGitStatusAt = undefined;
    this.lastGitSignature = undefined;
    this.lastGitEvent = undefined;
    // Ring ma sufit BAJTÓW obok sufitu sztuk — patrz `ring-buffer.ts`.
    this.ring = new RingBuffer<ServerEvent>(init.ringCapacity, { maxBytes: RING_MAX_BYTES });
  }

  /** Kształt wysyłany do klienta (pola serwerowe zostają na serwerze). */
  summary(): SessionSummary {
    const summary: SessionSummary = {
      id: this.id,
      cwd: this.cwd,
      title: this.title,
      state: this.state,
      stateSince: this.stateSince,
      createdAt: this.createdAt,
      lastActivityAt: this.lastActivityAt,
    };
    if (this.turnSince !== undefined) summary.turnSince = this.turnSince;
    if (this.paneId !== undefined) summary.paneId = this.paneId;
    if (this.launchedByRarog !== undefined) summary.launchedByRarog = this.launchedByRarog;
    if (this.seen !== undefined) summary.seen = this.seen;
    // The hand-made "unread" goes on the wire only while the result is not received.
    if (this.unseenByHuman === true && this.seen !== true) summary.markedUnseen = true;
    if (this.seenBy !== undefined && this.seen === true) summary.seenBy = this.seenBy;
    if (this.stale !== undefined) summary.stale = this.stale;
    if (this.herdrMode !== undefined) summary.herdrMode = this.herdrMode;
    if (this.herdrDialog !== undefined) summary.herdrDialog = this.herdrDialog;
    if (this.herdrDialogReason !== undefined) summary.herdrDialogReason = this.herdrDialogReason;
    if (this.herdrDialogScreen !== undefined) summary.herdrDialogScreen = this.herdrDialogScreen;
    if (this.cliDialog !== undefined) summary.cliDialog = this.cliDialog;
    if (this.outOfScope !== undefined) summary.outOfScope = this.outOfScope;
    // `engine` i `termId` jadą na drut, `observedSessionId` NIE — uuid rollouta Codexa
    // jest sprawą znacznika „obejrzane" po stronie serwera i klient nie ma go po co znać.
    if (this.engine !== undefined) summary.engine = this.engine;
    if (this.termId !== undefined) summary.termId = this.termId;
    if (this.label !== undefined) summary.label = this.label;
    const labelRef = fallbackLabelRef(this.label);
    if (labelRef !== undefined) summary.labelRef = labelRef;
    Object.assign(summary, wireStateDetail(this.stateDetail));
    if (this.branch !== undefined) summary.branch = this.branch;
    if (this.dirtyCount !== undefined) summary.dirtyCount = this.dirtyCount;
    if (this.ahead !== undefined) summary.ahead = this.ahead;
    if (this.behind !== undefined) summary.behind = this.behind;
    if (this.fileKinds !== undefined) summary.fileKinds = { ...this.fileKinds };
    if (this.lastCommit !== undefined) summary.lastCommit = { ...this.lastCommit };
    if (this.usage !== undefined) summary.usage = this.usage;
    if (this.context !== undefined) summary.context = this.context;
    if (this.backgroundTasks !== undefined) summary.backgroundTasks = [...this.backgroundTasks];
    if (this.artifacts !== undefined) summary.artifacts = [...this.artifacts];
    if (this.pullRequests !== undefined) summary.pullRequests = this.pullRequests.map((pr) => ({ ...pr }));
    if (this.scheduledTasks !== undefined) summary.scheduledTasks = this.scheduledTasks.map((task) => ({ ...task }));
    if (this.lastSummary !== undefined) summary.lastSummary = this.lastSummary;
    if (this.model !== undefined) summary.model = this.model;
    if (this.effort !== undefined) summary.effort = this.effort;
    if (this.ultracode !== undefined) summary.ultracode = this.ultracode;
    return summary;
  }

  /**
   * Dopisuje domkniętą wiadomość do transkryptu.
   *
   * `seq` jest znany dopiero po wrzuceniu eventu do ring buffera, więc uzupełniamy go w tym
   * samym obiekcie wiadomości (event trzyma referencję) — dzięki temu `id:` w SSE i `message.seq`
   * są zawsze tą samą liczbą.
   *
   * `attachments` to WIZYTÓWKI (nazwa, waga, mime) — bajty załącznika leżą na dysku
   * w `.rarog-uploads` i do transkryptu nie wchodzą. Treść dłuższa niż
   * {@link MAX_MESSAGE_BYTES} jest przycinana z jawnym znacznikiem.
   *
   * Bloki przychodzą WEWNĘTRZNE (tekst z pochodzeniem) i dopiero tu stają się blokami z drutu ({@link wireBlocks}),
   * PRZED przycięciem: sufit liczy to, co wyjdzie na drut, a blok przycięty traci `ref`.
   */
  appendMessage(
    role: TranscriptMessage['role'], blocks: readonly InternalBlock[], at: string,
    attachments?: readonly MessageAttachment[], extra: MessageExtra = {},
  ): AppendedMessage {
    const message = transcriptMessage(role, blocks, at, attachments, extra);
    // Domknięta wiadomość ZASTĘPUJE wskaźnik aktywności (ta sama zasada co w reducerze
    // klienta): dopóki jej nie było, „myśli…" było najlepszą prawdą — teraz jest treść.
    this.activity = null;
    const event: ServerEvent = { type: 'message', sessionId: this.id, message };
    const seq = this.ring.push(event);
    message.seq = seq;
    this.#messages.push(message);
    this.#messageBytes += jsonBytes(message);
    if (this.#messages.length > MAX_TRANSCRIPT_MESSAGES) {
      this.#dropOldestMessages(this.#messages.length - MAX_TRANSCRIPT_MESSAGES);
    }
    /*
     * Drugi sufit, w BAJTACH: to `#messages` — nie ring — jest źródłem
     * `transcript-snapshot`, czyli ramki lecącej na telefon przy każdym wejściu w transkrypt.
     * Sam licznik sztuk mówił o niej tyle, ile o wadze walizki mówi liczba rzeczy w środku.
     * Ostatnia wiadomość zostaje zawsze: pusty transkrypt byłby gorszy niż za ciężki.
     */
    while (this.#messageBytes > RING_MAX_BYTES && this.#messages.length > 1) {
      this.#dropOldestMessages(1);
    }
    this.lastActivityAt = at;
    return { seq, message, event };
  }

  /**
   * Rejestruje event w buforze sesji.
   *
   * @returns `seq` dla eventów domkniętych albo `null` dla eventów ULOTNYCH (`delta`,
   *          `activity`): nie mają `id` w SSE, nie przesuwają `Last-Event-ID` i nie wchodzą
   *          do ring buffera. Aktywność po reconnekcie odtwarza `transcript-snapshot.activity`,
   *          a nie replay — powtórka „uruchamia: Bash" sprzed pięciu minut byłaby kłamstwem.
   */
  pushEvent(event: ServerEvent): number | null {
    if (event.type === 'delta' || event.type === 'activity') return null;
    return this.ring.push(event);
  }

  /** Zdejmuje `count` najstarszych wiadomości razem z ich wagą. */
  #dropOldestMessages(count: number): void {
    const gone = this.#messages.splice(0, count);
    for (const message of gone) this.#messageBytes -= jsonBytes(message);
    if (this.#messages.length === 0) this.#messageBytes = 0;
  }

  /** Waga transkryptu w RAM (bajty JSON-a) — do testów sufitu i diagnostyki. */
  get transcriptBytes(): number {
    return this.#messageBytes;
  }

  /** Ostatnie wiadomości dla `transcript-snapshot`. */
  recentMessages(limit: number = SNAPSHOT_MESSAGES): TranscriptMessage[] {
    return this.#messages.slice(-limit);
  }

  /**
   * The newest message in memory when it belongs to the engine conversation the session writes now; `undefined` when
   * there is none or it came before the last move to another conversation ({@link conversationStartSeq}). The driver
   * announces a new conversation at once and the follower adds its note only after a disk probe, so in that moment the
   * newest message is still the previous conversation's.
   */
  lastMessageOfConversation(): TranscriptMessage | undefined {
    const last = this.#messages.at(-1);
    return last !== undefined && (last.seq ?? 0) > this.conversationStartSeq ? last : undefined;
  }

  /**
   * Opaque name of what this memory of the session holds, the voice agent's read mark: the random name of this memory
   * (`#memoryId`), the ring `seq` of the newest message (`0` before the first one) and a digest of {@link stateSince}.
   * Every message added to the transcript ({@link appendMessage}: a prompt, an agent message, a notice, imported
   * history) gives another one, and so does every new `stateSince` (a state change, a history import that moves it
   * back). Frames sent while the state stands and seen marks leave it as it is. The state stamp is there because
   * the messages reach the memory from the conversation file while herdr reports a turn's states on its own: a turn
   * can end before its messages arrive. 37 characters at most (8 + 1 + 16 digits of a safe integer + 1 + 11).
   */
  get readMark(): string {
    const stamp = createHash('sha256').update(this.stateSince).digest('base64url').slice(0, 11);
    return `${this.#memoryId}.${String(this.#messages.at(-1)?.seq ?? 0)}.${stamp}`;
  }

  get messageCount(): number {
    return this.#messages.length;
  }
}
