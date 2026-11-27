/**
 * Live Activity apki natywnej — JEDNA zbiorcza aktywność na urządzenie, aktualizowana z serwera
 * Jedyne miejsce ze stanem i zegarem po tej stronie kanału APNs.
 *
 * Kształt: apka startuje aktywność LOKALNIE (na wierzchu, po zalogowaniu) i oddaje serwerowi jej
 * token aktualizacji (`POST /api/push/live-activity`, rejestr `apns-devices.json`). Serwer słucha
 * globalnych eventów managera, liczy stan zbiorczy (`live-activity-state.ts`) i wysyła go cicho
 * (`apns-push-type: liveactivity`, bez `alert` — poza dźwiękiem „skończył”, niżej) do KAŻDEJ
 * zarejestrowanej aktywności. Pełną treść kafla wysyła wyłącznie serwer — apka nie zna limitów planu ani
 * obciążenia Maca. Apka poza tłem zapisuje na kaflu sama tylko liczniki (nakładka na treść, którą system trzyma
 * z ostatniego pusha), ze znacznikiem z zegara serwera: najnowszy `stateSince` jej listy ze strumienia globalnego,
 * ucięty do pełnej sekundy, minus 1 s. ActivityKit porządkuje więc jej zapisy z naszymi `aps.timestamp`
 * (`timestampFor`: pełne sekundy, nie mniej niż sekunda wysłania), a każda wysyłka po przejściu stanu ma znacznik
 * nowszy od zapisu apki i wygrywa. Ten moduł o zapisach apki nie wie.
 *
 * Reguły wysyłki (per aktywność):
 *
 * - **diff po TREŚCI** — `updatedEpoch` i `mac` poza porównaniem, więc event bez zmiany widocznej treści
 *   nie wysyła nic, a samo obciążenie Maca (zmienia się co sekundę) nie wysyła NIGDY: jedzie z inną zmianą
 *   albo z heartbeatem, zawsze świeże — `mac()` czytane tuż przed KAŻDĄ wysyłką, bo treść zamraża się
 *   przy przeliczeniu, a heartbeat wysyła ją bez przeliczenia;
 * - **throttle** — najwyżej jedna aktualizacja na {@link LIVE_ACTIVITY_THROTTLE_MS}; zmiany
 *   w oknie składają się w jedną wysyłkę z NAJNOWSZĄ treścią;
 * - **zmiana `waiting`** (wzrost i spadek) — natychmiast, z pominięciem throttle, `apns-priority: 10`; cała reszta
 *   priorytetem 5 (budżet priorytetu 10 Apple nie publikuje);
 * - **heartbeat** — treść stoi, a od ostatniej wysyłki minęło {@link LIVE_ACTIVITY_HEARTBEAT_MS}:
 *   ta sama treść (ze świeżym obciążeniem Maca) priorytetem 5, żeby `stale-date` (15 min) nie zapalił
 *   „dane sprzed …", dopóki serwer żyje;
 * - **koniec po 30 min ciszy** — nic nie czeka, nic nie pracuje i żaden
 *   workflow nie mieli w tle (`isBusy` z sesji, `live-activity-state.ts`) przez
 *   {@link LIVE_ACTIVITY_QUIET_END_MS}, liczone od chwili, w której treść PRZESTAŁA być zajęta
 *   (a dla aktywności założonej w środku ciszy — od jej rejestracji): `event: end`
 *   z `dismissal-date` = teraz. Przed końcem stan jest przeliczany od nowa (event nowej pracy może
 *   jeszcze czekać w oknie składania). Nieudany `end` zostawia blok i ponawia się po
 *   {@link LIVE_ACTIVITY_RETRY_MS}; blok znika dopiero po dostawie albo przy martwym tokenie.
 *   Wcześniej „nic nie czeka" to zwykła aktualizacja. Nowa praca po końcu NIE wznawia aktywności —
 *   apka startuje nową przy następnym otwarciu;
 * - **8 h** ({@link LIVE_ACTIVITY_MAX_AGE_MS}) — system kończy aktywność sam, ale kafel wisi wtedy na ekranie
 *   blokady do 4 h dłużej z ostatnią, już nieaktualną treścią (Apple, ActivityKit), a brak kafla jest lepszy
 *   niż stary. Dlatego {@link LIVE_ACTIVITY_AGE_END_MS} od rejestracji (8 h − 10 min, a rejestracja jest
 *   chwilę po starcie na urządzeniu) sterownik wysyła `end` tą samą drogą co koniec po ciszy (`dismissal-date`
 *   = teraz, bieżąca treść), ale priorytetem 10, bo spóźniony po 8 h niczego już nie zdejmie; jeden na 8 h, więc
 *   budżet pilnych to wytrzyma. Nieudany ponawia się po {@link LIVE_ACTIVITY_RETRY_MS}, blok wypada po dostawie.
 *   Po 8 h od rejestracji blok wypada bez wysyłki (koniec ponowień i aktualizacji w próżnię);
 * - **koniec z trasy** (`…/end`, zgodny `activityId`) i **przy wyrejestrowaniu urządzenia**
 *   (wylogowanie) — `end` do aktywności best-effort;
 * - **`410`/`BadDeviceToken`** na token aktywności kasuje blok TYLKO, gdy nadal pasują `activityId`
 *   i token tej wysyłki — spóźniona odpowiedź po rotacji tokenu niczego nie kasuje;
 * - **`aps.timestamp`** ściśle rośnie per aktywność; gdy seria pilnych wysyłek w jednej sekundzie
 *   wyprzedzi zegar, znacznik ląduje w rejestrze, żeby po restarcie serwera nie cofnąć się w czasie;
 * - **porażka** — ponowienie najwcześniej po {@link LIVE_ACTIVITY_RETRY_MS} (429 i 5xx każą
 *   zwolnić, a nadajnik po 5xx i tak milczy 15 min);
 * - **dźwięk „skończył”** — harmonogram przy wysłanym „gotowe” woła
 *   {@link LiveActivityController.chime} (`fanout.ts`). Zlecenie dostaje każda aktywność urządzenia
 *   ze zgodą na powiadomienia (`alerts: true`) poza przerwą {@link LIVE_ACTIVITY_CHIME_MIN_GAP_MS}
 *   od ostatniego doręczonego dźwięku. Zlecenie wychodzi OD RAZU, z pominięciem throttle i diffu treści:
 *   aktualizacja z bieżącą treścią i alertem o stałych tekstach (`LIVE_ACTIVITY_CHIME`, `apns-payload.ts`; wpis
 *   z deklaracją `locKeys` dostaje je jako klucze katalogu apki, `LIVE_ACTIVITY_CHIME_KEYS`), priorytet 10, `apns-expiration` = zlecenie + {@link LIVE_ACTIVITY_CHIME_TTL_MS}. Czeka tylko na
 *   wysyłkę w locie; tor w ponowieniu go nie wypuszcza, więc po terminie przepada (linia logu). Porażka
 *   = dźwięk przepada, treść ponawia się jak zwykle, bez alertu. Przerwę sprawdza też chwila wysyłki:
 *   dźwięk doręczony, gdy zlecenie czekało, zjada je. Powrót do Raroga kasuje zlecenia, które jeszcze
 *   nie wyszły ({@link LiveActivityController.cancelChimes}). Bez żywej aktywności dźwięku nie ma.
 *
 * `apns-topic` każdej wysyłki to `<temat wpisu urządzenia>.push-type.liveactivity` ({@link apnsTopicOf}):
 * token aktywności należy do apki, która zarejestrowała urządzenie, i przyjmuje aktualizacje tylko pod
 * jej tematem.
 *
 * Droga wysyłki: każda wysyłka niesie kontekst przechwycony RAZEM z rekordem — temat wpisu i przepustkę
 * przekaźnika bloku aktywności (`SendContext`, `sender.ts`). Koniec z trasy i przy wyrejestrowaniu kasuje blok PRZED
 * wysyłką `end`, więc przepustka jedzie z wołającym, a nie z odczytu rejestru — `end` dochodzi przekaźnikiem także
 * na serwerze bez klucza. Wysyłka bez drogi (`pass-missing`: brak przepustki aktywności i klucza) czeka jak porażka
 * na {@link LIVE_ACTIVITY_RETRY_MS}, ale zapisana przepustka ({@link LiveActivityController.passReady}) budzi tor
 * od razu — zamówienie idzie po rejestracji tokenu aktywności (`relay-pass.ts`).
 *
 * `RAROG_PUSH=0` nie dochodzi tutaj wcale: ten moduł powstaje razem z kanałem APNs, a kanału przy
 * wyłączonych powiadomieniach nie ma (`apns-channel.ts`). Aktywność, której nikt nie aktualizuje,
 * po 15 min pokazuje się jako nieświeża, apka kończy ją po `apnsEnabled: false` w `/api/version`,
 * a system — najpóźniej po 8 h.
 *
 * **Log without tokens, `activityId` and labels**: only the kind of event and numbers. That includes the hourly
 * send counter with urgent sends per device (Live Activity budgets are unpublished and each device's system guards
 * its urgent budget separately, so this is the only measurement) and the `live-activity: counts …` line at every send
 * with new counts: the clock time, seconds since the counts changed on the server, the priority and the answer time
 * of the send route (tile delay measurement). A send without an attempt (no pass yet, a refused pass, a paused or
 * disabled key environment) is `not sent` in these lines and in the `end` and `done chime` lines, not a failure.
 * **Ten moduł nigdy nie rzuca** na ścieżce eventów managera.
 */
import type { SessionSummary } from '@rarog/shared';
import type { LiveActivityContentState } from '@rarog/shared/rest';
import type { ApnsResult } from './apns.ts';
import { apnsLiveActivityRequest } from './apns-payload.ts';
import type { ApnsRequest } from './apns-payload.ts';
import type {
  ApnsDeviceRecord, ApnsDeviceStore, LiveActivityInput, LiveActivitySetResult, LiveActivityToken,
} from './apns-devices.ts';
import { apnsTopicOf, normalizeApnsToken } from './apns-devices.ts';
import { aggregateState, contentKey, isBusy } from './live-activity-state.ts';
import type { LiveActivityExtras } from './live-activity-state.ts';
import { attempted } from './sender.ts';
import type { PushSender, SendContext } from './sender.ts';

/** Najwyżej jedna zwykła aktualizacja na aktywność w tym oknie. */
export const LIVE_ACTIVITY_THROTTLE_MS = 15_000;
/** Treść stoi tyle bez wysyłki → heartbeat (przed `stale-date` 15 min). */
export const LIVE_ACTIVITY_HEARTBEAT_MS = 10 * 60_000;
/** Cisza (nic nie czeka, nie pracuje i nie mieli w tle) przez tyle → `end`. */
export const LIVE_ACTIVITY_QUIET_END_MS = 30 * 60_000;
/** Po nieudanej wysyłce następna najwcześniej po tylu ms. */
export const LIVE_ACTIVITY_RETRY_MS = 60_000;
/** Okno składania eventów managera w jedno przeliczenie stanu. */
export const LIVE_ACTIVITY_COALESCE_MS = 250;
/** Systemowy sufit życia aktywności (Apple: 8 h) — po nim blok wypada bez wysyłki. */
export const LIVE_ACTIVITY_MAX_AGE_MS = 8 * 60 * 60_000;
/**
 * Tyle po rejestracji serwer sam kończy aktywność (`end`, priorytet 10), żeby po 8 h nie został na ekranie blokady
 * kafel ze starą treścią. 10 min zapasu na ponowienia i na to, że rejestracja jest chwilę po starcie na urządzeniu.
 */
export const LIVE_ACTIVITY_AGE_END_MS = LIVE_ACTIVITY_MAX_AGE_MS - 10 * 60_000;
/** Najwyżej jeden dźwięk „skończył” na aktywność w tym oknie. */
export const LIVE_ACTIVITY_CHIME_MIN_GAP_MS = 20_000;
/** Tyle żyje zlecenie dźwięku; ramka z dźwiękiem ma `apns-expiration` = zlecenie + tyle. */
export const LIVE_ACTIVITY_CHIME_TTL_MS = 30_000;
/** Fraza linii pomiaru opóźnienia kafla (`countsLine`): jedna przy każdej wysyłce z nowymi licznikami. */
export const LIVE_ACTIVITY_COUNTS_LOG = 'live-activity: counts';
/** Co ile linia z licznikiem wysyłek. */
const SUMMARY_WINDOW_MS = 60 * 60_000;

export interface LiveActivityOptions {
  readonly devices: ApnsDeviceStore;
  readonly sender: Pick<PushSender, 'send'>;
  /** Lista sesji managera w chwili przeliczenia (leniwie — manager powstaje po kanale). */
  readonly sessions: () => readonly SessionSummary[];
  /** Limity planu na tę chwilę (`live-activity-limits.ts`); brak = kafel bez pasków limitów. */
  readonly limits?: () => LiveActivityExtras['limits'];
  /** Obciążenie Maca na tę chwilę (`mac-stats.ts`); czytane przy każdej wysyłce, nie przy przeliczeniu. */
  readonly mac?: () => LiveActivityExtras['mac'];
  /** Zamykane razem ze sterownikiem (próbnik Maca, poller limitów). */
  readonly onClose?: () => void;
  readonly now?: () => number;
  readonly setTimeout?: (cb: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
  readonly log?: (line: string) => void;
}

export interface LiveActivityController {
  /** Globalny event managera — przeliczenie stanu (składane w {@link LIVE_ACTIVITY_COALESCE_MS}). */
  poke(): void;
  /** Token aktywności z apki (trasa). Nowa aktywność dostaje stan serwera od razu. */
  register(deviceToken: string, input: LiveActivityInput): LiveActivitySetResult;
  /** Apka zakończyła aktywność (trasa `…/end`). `false` = `activityId` nie pasuje, nic się nie stało. */
  end(deviceToken: string, activityId: string): boolean;
  /** Urządzenie wypada z rejestru (wylogowanie) — `end` do jego aktywności, PRZED usunięciem wpisu. */
  forgetDevice(deviceToken: string): void;
  /**
   * Dźwięk „skończył” (harmonogram przy wysłanym „gotowe”, `fanout.ts`): zlecenie aktualizacji z alertem
   * dla każdej aktywności urządzenia z `alerts: true`, poza przerwą {@link LIVE_ACTIVITY_CHIME_MIN_GAP_MS}.
   * Oddaje liczbę zleceń — 0 znaczy: nie ma żywego kafla, zgody albo trwa przerwa. Nigdy nie rzuca.
   */
  chime(): number;
  /** Powrót do Raroga: kasuje zlecenia dźwięku, które jeszcze nie wyszły. Oddaje ich liczbę. */
  cancelChimes(): number;
  /**
   * Przepustka przekaźnika zapisana dla tego urządzenia (`relay-pass.ts`): tor, który czekał na drogę
   * (`pass-missing`), ponawia od razu zamiast po {@link LIVE_ACTIVITY_RETRY_MS}. Nigdy nie rzuca.
   */
  passReady(deviceToken: string): void;
  /** Zatrzymuje timery (graceful shutdown). Wysyłki w locie kończą się same. */
  close(): void;
}

/** Zlecenie dźwięku „skończył” na jednym torze. */
interface ChimeOrder {
  /** Numer zlecenia — odpowiedź wysyłki kasuje tylko SWOJE zlecenie, nowsze przeżywa. */
  readonly id: number;
  /** Termin (ms epoki): po nim zlecenie przepada, a APNs ramki z dźwiękiem już nie dowiezie. */
  readonly untilMs: number;
  /** Ramka z tym dźwiękiem już poszła i czeka na odpowiedź — powrót do Raroga jej nie cofnie. */
  readonly sending?: true;
}

/** Stan wysyłek JEDNEJ aktywności — w RAM; po restarcie serwera aktywność dostaje świeży stan. */
interface Track {
  readonly activityId: string;
  /** Od kiedy serwer zna tę aktywność — dolna granica zegara ciszy. */
  readonly knownSinceMs: number;
  /** Klucz treści ostatniej DORĘCZONEJ aktualizacji; `null` = jeszcze nic. */
  lastKey: string | null;
  lastSentAtMs: number | null;
  /** `waiting` ostatniej doręczonej treści — od niego liczy się zmiana, która idzie pilnie. */
  lastWaiting: number;
  /** Liczniki (czeka/pracuje/skończyło) ostatniej doręczonej treści; `null` = jeszcze nic. Linia pomiaru niżej. */
  lastCounts: string | null;
  /** Ostatni `aps.timestamp` (sekundy) — następny musi być ściśle większy. */
  lastTimestamp: number;
  retryAtMs: number | null;
  inFlight: boolean;
  /** Nieudany `end` po ciszy albo przed limitem 8 h już zalogowany — kolejne ponowienia milczą (licznik godzinowy je zna). */
  endFailureLogged: boolean;
  /** Dźwięk „skończył”, który jeszcze nie wyszedł albo czeka na odpowiedź APNs; `null` = brak. */
  chime: ChimeOrder | null;
  /** Chwila wysyłki ostatniego DORĘCZONEGO dźwięku — od niej liczy się przerwa. */
  lastChimeAtMs: number | null;
  /** Ostatnia wysyłka nie miała drogi (`pass-missing`) — zapisana przepustka budzi tor od razu. */
  waitingForPass: boolean;
}

type EndReason = 'quiet 30 min' | '8 h limit' | 'app' | 'unregister';

/** Koniec, który zleca sam sterownik: blok kasuje on po dostawie, a nieudany `end` ponawia. */
const ownEnd = (reason: EndReason): boolean => reason === 'quiet 30 min' || reason === '8 h limit';

/** Aktywność z wpisu w chwili wysyłki: środowisko i temat APNs urządzenia, token aktywności. */
interface Live {
  readonly environment: Parameters<PushSender['send']>[0];
  /** Temat wpisu urządzenia ({@link apnsTopicOf}); sufiks aktywności dokleja `apns-payload.ts`. */
  readonly topic: string;
  readonly la: LiveActivityToken;
  /** Droga wysyłki: temat wpisu i przepustka bloku, przechwycone RAZEM z rekordem. */
  readonly context: SendContext;
  /** Deklaracja `locKeys` wpisu, przechwycona RAZEM z rekordem: dzwonek kluczami katalogu apki. */
  readonly locKeys: boolean;
}

const liveFrom = (record: ApnsDeviceRecord, la: LiveActivityToken): Live => ({
  environment: record.environment,
  topic: apnsTopicOf(record),
  la,
  context: {
    topic: record.topic,
    ...(la.relayPass === undefined ? {} : { pass: la.relayPass }),
    activity: { deviceToken: record.token, activityId: la.activityId },
  },
  locKeys: record.locKeys === true,
});

const OUTCOME: Readonly<Record<ApnsResult['kind'], string>> = {
  ok: 'delivered',
  gone: 'token dead',
  failed: 'failed',
};

/**
 * Outcome in the `counts`, `end` and `done chime` lines: a result without an attempt (`attempted` false: no pass yet,
 * a refused pass, a paused or disabled key environment) is `not sent (<reason>)`, not a failure, because nothing
 * reached APNs.
 */
const countsOutcomeOf = (result: ApnsResult): string =>
  (attempted(result) || result.kind !== 'failed' ? OUTCOME[result.kind] : `not sent (${result.reason})`);

/** Liczniki treści jako tekst linii pomiaru — i zarazem klucz ich porównania. */
const countsKeyOf = (state: LiveActivityContentState): string =>
  `waiting ${String(state.waiting)} · working ${String(state.working)} · finished ${String(state.finished)}`;

/** Godzina lokalna `HH:MM:SS`: prefiks linii `server.log` podaje czas w UTC, a pomiar porównuje ją z ekranem. */
const clockOf = (ms: number): string =>
  new Date(ms).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

const secondsOf = (ms: number): string => (ms / 1000).toFixed(1);

/**
 * Linia pomiaru opóźnienia kafla: co wyszło i kiedy, ile po przeliczeniu ze zmianą liczników (czyli po oknie
 * składania eventów; to, co dalej, to throttle), jakim priorytetem i po ilu sekundach odpowiedziała droga wysyłki.
 * Resztę, od odpowiedzi do zmiany na ekranie, dokłada dostawa Apple.
 */
const countsLine = (
  counts: { readonly key: string; readonly sinceMs: number }, first: boolean,
  sentAt: number, answeredAt: number, urgent: boolean, outcome: string,
): string => {
  const since = first ? 'first send to the activity' : `${secondsOf(sentAt - counts.sinceMs)} s after the change`;
  return `${LIVE_ACTIVITY_COUNTS_LOG} ${counts.key} — sent ${clockOf(sentAt)}, ${since},`
    + ` priority ${urgent ? '10' : '5'}, answer after ${secondsOf(answeredAt - sentAt)} s → ${outcome}`;
};

export function createLiveActivity(options: LiveActivityOptions): LiveActivityController {
  const { devices, sender, log } = options;
  const now = options.now ?? ((): number => Date.now());
  const setTimer = options.setTimeout
    ?? ((cb, ms): unknown => {
      const handle = setTimeout(cb, ms);
      // Timer aktywności nie może trzymać procesu przy zamykaniu serwera.
      if (typeof handle.unref === 'function') handle.unref();
      return handle;
    });
  const clearTimer = options.clearTimeout ?? ((handle): void => { clearTimeout(handle as NodeJS.Timeout); });

  const tracks = new Map<string, Track>();
  let content: { readonly state: LiveActivityContentState; readonly key: string } | null = null;
  /**
   * Liczniki bieżącej treści i chwila przeliczenia, w którym się zmieniły (pomiar opóźnienia kafla):
   * linia `live-activity: liczniki …` przy każdej wysyłce, która niesie liczniki inne niż doręczone wcześniej.
   */
  let counts: { readonly key: string; readonly sinceMs: number } | null = null;
  /** Od kiedy treść jest „pusta" (0/0); `null` = coś czeka albo pracuje. */
  let quietSinceMs: number | null = null;
  let coalesceTimer: unknown = null;
  let wakeTimer: unknown = null;
  let closed = false;
  let chimeSeq = 0;
  /** `failed` counts real failures only; results without an attempt go to `notSent`. */
  const counters = {
    windowStart: now(), updates: 0, urgent: 0, heartbeats: 0, chimes: 0, ends: 0, failed: 0, notSent: 0,
  };
  const countFailure = (result: ApnsResult): void => {
    if (attempted(result)) counters.failed += 1;
    else counters.notSent += 1;
  };
  /**
   * Pilne DORĘCZONE w oknie linii godzinowej, per token urządzenia: budżet priorytetu 10
   * pilnuje system każdego urządzenia osobno, a suma urządzeń go nie pokazuje. Klucz zostaje w pamięci, do logu idą
   * same liczby.
   */
  const urgentByDevice = new Map<string, number>();

  const safeLog = (line: string): void => {
    try {
      log?.(line);
    } catch {
      // Log nie ma prawa wywrócić ścieżki eventów managera.
    }
  };

  /**
   * The hourly counter line, written at the first send after the window. A device whose pass never comes still shows
   * up here, as `not sent`.
   */
  const noteCounters = (): void => {
    const at = now();
    if (at - counters.windowStart < SUMMARY_WINDOW_MS) return;
    const { updates, urgent, heartbeats, chimes, ends, failed, notSent } = counters;
    if (updates + ends + failed + notSent > 0) {
      const perDevice = [...urgentByDevice.values()].sort((a, b) => b - a).map(String);
      safeLog(`live-activity: last hour — sends: ${String(updates)} (urgent: ${String(urgent)},`
        + ` heartbeat: ${String(heartbeats)}, chimes: ${String(chimes)}), ends: ${String(ends)},`
        + ` unsuccessful: ${String(failed)}`
        + (notSent > 0 ? `, not sent: ${String(notSent)}` : '')
        + (perDevice.length > 0 ? `, urgent per device: ${perDevice.join(' / ')}` : ''));
    }
    Object.assign(counters, {
      windowStart: at, updates: 0, urgent: 0, heartbeats: 0, chimes: 0, ends: 0, failed: 0, notSent: 0,
    });
    urgentByDevice.clear();
  };

  /** Getter z zewnątrz: wyjątek albo pusty obiekt = brak pola (kafel nie pokazuje liczby, której nie zna). */
  const extra = <T extends object>(get: (() => T | undefined) | undefined): T | undefined => {
    try {
      const value = get?.();
      return value !== undefined && Object.keys(value).length > 0 ? value : undefined;
    } catch {
      return undefined;
    }
  };

  const recompute = (): void => {
    const at = now();
    let state: LiveActivityContentState;
    let busy: boolean;
    try {
      const sessions = options.sessions();
      const limits = extra(options.limits);
      state = aggregateState(sessions, at, limits === undefined ? {} : { limits });
      busy = isBusy(sessions);
    } catch {
      return;
    }
    if (busy) quietSinceMs = null;
    else quietSinceMs ??= at;
    content = { state, key: contentKey(state) };
    const countsKey = countsKeyOf(state);
    if (counts?.key !== countsKey) counts = { key: countsKey, sinceMs: at };
  };

  /** Stan do wysyłki: zamrożona treść + ŚWIEŻE obciążenie Maca + znacznik tej wysyłki. */
  const outgoing = (state: LiveActivityContentState, timestamp: number): LiveActivityContentState => {
    const { mac: _stale, updatedEpoch: _at, ...rest } = state;
    void _stale;
    void _at;
    const mac = extra(options.mac);
    return { ...rest, ...(mac === undefined ? {} : { mac: { ...mac } }), updatedEpoch: timestamp };
  };

  /** Aktywność z rejestru (prawda o tokenie i temacie) zgodna z torem — albo nic. */
  const liveOf = (token: string, track: Track): Live | undefined => {
    const record = devices.get(token);
    const la = record?.liveActivity;
    if (record === undefined || la === undefined || la.activityId !== track.activityId) return undefined;
    return liveFrom(record, la);
  };

  /**
   * Tory ↔ rejestr: nowa aktywność = nowy tor, zniknięta — tor wypada. Blok przeniesiony na nowy token urządzenia
   * (rotacja) dostaje nowy tor ze znacznikiem nie mniejszym niż w starym torze, bo `aps.timestamp` ma ściśle
   * rosnąć per aktywność, a blok niesie `lastTimestamp` tylko wtedy, gdy znacznik wyprzedził zegar.
   */
  const sync = (): void => {
    const lastTimestampOf = new Map<string, number>();
    for (const track of tracks.values()) {
      lastTimestampOf.set(track.activityId, Math.max(lastTimestampOf.get(track.activityId) ?? 0, track.lastTimestamp));
    }
    const seen = new Set<string>();
    for (const record of devices.list()) {
      const la = record.liveActivity;
      if (la === undefined) continue;
      seen.add(record.token);
      if (tracks.get(record.token)?.activityId === la.activityId) continue;
      const lastTimestamp = Math.max(la.lastTimestamp ?? 0, lastTimestampOf.get(la.activityId) ?? 0);
      tracks.set(record.token, {
        activityId: la.activityId, knownSinceMs: now(), lastKey: null, lastSentAtMs: null,
        lastWaiting: 0, lastCounts: null, lastTimestamp, retryAtMs: null, inFlight: false,
        endFailureLogged: false, chime: null, lastChimeAtMs: null, waitingForPass: false,
      });
    }
    for (const token of [...tracks.keys()]) if (!seen.has(token)) tracks.delete(token);
  };

  const timestampFor = (deviceToken: string, track: Track): number => {
    const nowSec = Math.floor(now() / 1000);
    const ts = Math.max(nowSec, track.lastTimestamp + 1);
    track.lastTimestamp = ts;
    // Tylko znacznik WYPRZEDZAJĄCY zegar musi przeżyć restart; zwykły zegar zrobi to sam.
    if (ts > nowSec) devices.noteLiveActivityTimestamp(deviceToken, track.activityId, ts);
    return ts;
  };

  const send = async (live: Live, request: ApnsRequest): Promise<ApnsResult> => {
    try {
      return await sender.send(live.environment, live.la.updateToken, request, live.context);
    } catch {
      return { kind: 'failed', status: null, reason: 'no-code' };
    }
  };

  const notePassWait = (track: Track | undefined, result: ApnsResult): void => {
    if (track !== undefined) track.waitingForPass = result.kind === 'failed' && result.reason === 'pass-missing';
  };

  /** Odpowiedź „token martwy" kasuje blok tylko przy zgodnym id i tokenie TEJ wysyłki. */
  const dropIfGone = (deviceToken: string, track: Track, la: LiveActivityToken, result: ApnsResult): void => {
    if (result.kind !== 'gone') return;
    const cleared = devices.clearLiveActivity(deviceToken, { activityId: la.activityId, updateToken: la.updateToken });
    if (cleared && tracks.get(deviceToken) === track) tracks.delete(deviceToken);
    safeLog(`live-activity: activity token dead (${String(result.status)} ${result.reason})`
      + (cleared ? ' — block deleted' : ' — after rotation, block kept'));
  };

  /** Aktualizacja treści; z `chime` — także dźwięk „skończył” (alert, priorytet 10, krótkie wygaśnięcie). */
  const update = async (
    deviceToken: string, track: Track, urgent: boolean, heartbeat: boolean, chime?: ChimeOrder,
  ): Promise<void> => {
    const live = liveOf(deviceToken, track);
    if (live === undefined || content === null) return;
    const sent = content;
    // Ustawiane razem z `content` w `recompute`, więc to liczniki TEJ treści.
    const sentCounts = counts;
    track.inFlight = true;
    const sentAt = now();
    const timestamp = timestampFor(deviceToken, track);
    const result = await send(live, apnsLiveActivityRequest(
      outgoing(sent.state, timestamp),
      {
        topic: live.topic, event: 'update', timestamp, priority: urgent ? 'high' : 'low',
        ...(chime === undefined ? {} : {
          chime: { expiresAtSec: Math.floor(chime.untilMs / 1000), locKeys: live.locKeys },
        }),
      },
    ));
    track.inFlight = false;
    notePassWait(track, result);
    // Dźwięk nie ma ponowień: odpowiedź kasuje SWOJE zlecenie, a nowsze (przyszło w trakcie) przeżywa.
    if (chime !== undefined && track.chime?.id === chime.id) track.chime = null;
    if (result.kind === 'ok') {
      track.lastKey = sent.key;
      track.lastSentAtMs = sentAt;
      track.lastWaiting = sent.state.waiting;
      track.retryAtMs = null;
      counters.updates += 1;
      if (urgent) {
        counters.urgent += 1;
        urgentByDevice.set(deviceToken, (urgentByDevice.get(deviceToken) ?? 0) + 1);
      }
      if (heartbeat) counters.heartbeats += 1;
      if (chime !== undefined) {
        track.lastChimeAtMs = sentAt;
        counters.chimes += 1;
      }
    } else {
      countFailure(result);
      if (result.kind === 'failed') track.retryAtMs = now() + LIVE_ACTIVITY_RETRY_MS;
      dropIfGone(deviceToken, track, live.la, result);
    }
    if (sentCounts !== null && sentCounts.key !== track.lastCounts) {
      safeLog(countsLine(sentCounts, track.lastCounts === null, sentAt, now(), urgent, countsOutcomeOf(result)));
      if (result.kind === 'ok') track.lastCounts = sentCounts.key;
    }
    // `updatedEpoch` of the sent content: the app traces every content it receives with the same number, so the two
    // logs join on it (did the chime land while the app was already in the foreground).
    if (chime !== undefined) {
      safeLog(`live-activity: done chime → ${countsOutcomeOf(result)}, updatedEpoch ${String(timestamp)}`);
    }
    noteCounters();
    evaluate();
  };

  /**
   * `end` do aktywności. Przy ciszy i przed limitem 8 h blok kasuje ta funkcja (po wysyłce, przy zgodnym id i tokenie);
   * przy trasie i wyrejestrowaniu skasował go już wołający, a tor przychodzi tylko po to, żeby
   * `aps.timestamp` końca był ściśle nowszy od ostatniej aktualizacji.
   */
  const finish = async (
    deviceToken: string, live: Live, track: Track | undefined, reason: EndReason,
  ): Promise<void> => {
    const { topic, la } = live;
    if (content === null) recompute();
    const state = content?.state ?? { waiting: 0, working: 0, finished: 0, updatedEpoch: 0 };
    if (track !== undefined) track.inFlight = true;
    const timestamp = track === undefined ? Math.floor(now() / 1000) : timestampFor(deviceToken, track);
    // Kontekst z `live` — przechwycony przed skasowaniem bloku (trasa, wyrejestrowanie), więc z przepustką.
    const result = await send(live, apnsLiveActivityRequest(
      outgoing(state, timestamp),
      { topic, event: 'end', timestamp, priority: reason === '8 h limit' ? 'high' : 'low' },
    ));
    if (track !== undefined) track.inFlight = false;
    notePassWait(track, result);
    if (ownEnd(reason) && track !== undefined && result.kind === 'failed') {
      // The activity still hangs on the device: the block stays and `end` is retried after a minute. Logged once
      // per track; the hourly line counts the retries (an end without an attempt as `not sent`).
      countFailure(result);
      track.retryAtMs = now() + LIVE_ACTIVITY_RETRY_MS;
      if (!track.endFailureLogged) {
        track.endFailureLogged = true;
        safeLog(`live-activity: end (${reason}) → ${countsOutcomeOf(result)}`
          + ` — retry in ${String(LIVE_ACTIVITY_RETRY_MS / 1000)} s`);
      }
      noteCounters();
      evaluate();
      return;
    }
    // An end without an attempt (route, unregister: no retry) is `not sent`, not an end; a real failure stays an end.
    if (attempted(result)) counters.ends += 1;
    else counters.notSent += 1;
    safeLog(`live-activity: end (${reason}) → ${countsOutcomeOf(result)}`);
    if (ownEnd(reason) && track !== undefined) {
      // Blok wypada przy zgodnym id i tokenie — rotacja w trakcie wysyłki zostawia nowy token,
      // a cisza i wiek i tak trwają, więc następne przeliczenie zakończy aktywność jeszcze raz, nowym.
      const cleared = devices.clearLiveActivity(deviceToken, { activityId: la.activityId, updateToken: la.updateToken });
      if (cleared && tracks.get(deviceToken) === track) tracks.delete(deviceToken);
    }
    noteCounters();
    evaluate();
  };

  const arm = (at: number): void => {
    if (wakeTimer !== null) clearTimer(wakeTimer);
    wakeTimer = null;
    if (closed || !Number.isFinite(at)) return;
    wakeTimer = setTimer(() => {
      wakeTimer = null;
      evaluate();
    }, Math.max(0, at - now()));
  };

  /** Decyzja per aktywność: koniec, aktualizacja, heartbeat albo czekanie — i jeden timer. */
  function evaluate(): void {
    if (closed) return;
    sync();
    if (content === null && tracks.size > 0) recompute();
    const at = now();
    let next = Infinity;
    /** Przeliczenie „na świeżo" przed nieodwracalnym końcem — najwyżej raz na przebieg. */
    let fresh = false;
    for (const [deviceToken, track] of tracks) {
      if (track.inFlight || content === null) continue;
      const live = liveOf(deviceToken, track);
      if (live === undefined) continue;
      const expiresAt = Date.parse(live.la.startedAt) + LIVE_ACTIVITY_MAX_AGE_MS;
      if (at >= expiresAt) {
        // System zakończył ją sam — dalsze aktualizacje i ponowienia szłyby w próżnię.
        if (devices.clearLiveActivity(deviceToken, { activityId: live.la.activityId, updateToken: live.la.updateToken })) {
          tracks.delete(deviceToken);
          safeLog('live-activity: activity older than 8 h — the system ended it, block deleted');
        }
        continue;
      }
      if (Number.isFinite(expiresAt)) next = Math.min(next, expiresAt);
      // Spóźniony dźwięk nie gra — sprawdzane PRZED ponowieniem, które zlecenia nie wypuszcza.
      if (track.chime !== null && at >= track.chime.untilMs) {
        track.chime = null;
        safeLog(`live-activity: done chime timed out — not sent within ${String(LIVE_ACTIVITY_CHIME_TTL_MS / 1000)} s`);
      }
      if (track.retryAtMs !== null && at < track.retryAtMs) {
        next = Math.min(next, track.retryAtMs, track.chime?.untilMs ?? Infinity);
        continue;
      }
      // Tuż przed limitem 8 h: po nim system zamraża kafel ze starą treścią na ekranie blokady.
      const ageEndAt = Date.parse(live.la.startedAt) + LIVE_ACTIVITY_AGE_END_MS;
      if (at >= ageEndAt) {
        void finish(deviceToken, live, track, '8 h limit');
        continue;
      }
      if (Number.isFinite(ageEndAt)) next = Math.min(next, ageEndAt);
      if (quietSinceMs !== null) {
        let quietEnd = Math.max(quietSinceMs, track.knownSinceMs) + LIVE_ACTIVITY_QUIET_END_MS;
        if (at >= quietEnd && !fresh) {
          // Event nowej pracy mógł jeszcze czekać w oknie składania.
          fresh = true;
          recompute();
          quietEnd = quietSinceMs === null ? Infinity : Math.max(quietSinceMs, track.knownSinceMs) + LIVE_ACTIVITY_QUIET_END_MS;
        }
        if (at >= quietEnd) {
          void finish(deviceToken, live, track, 'quiet 30 min');
          continue;
        }
        if (Number.isFinite(quietEnd)) next = Math.min(next, quietEnd);
      }
      if (track.chime !== null) {
        if (devices.get(deviceToken)?.alerts !== true) {
          // Zgodę cofnięto, gdy zlecenie czekało — bez zgody dźwięk nie gra.
          track.chime = null;
          safeLog('live-activity: done chime cancelled — the device has no notification permission');
        } else if (track.lastChimeAtMs !== null && at - track.lastChimeAtMs < LIVE_ACTIVITY_CHIME_MIN_GAP_MS) {
          // Dźwięk doręczony, gdy to zlecenie czekało na wysyłkę w locie — jeden na przerwę.
          track.chime = null;
          safeLog('live-activity: done chime skipped — the previous one played a moment ago');
        } else {
          // Od razu: bez throttle i bez diffu treści — dźwięk jedzie z tym, co jest teraz.
          track.chime = { ...track.chime, sending: true };
          void update(deviceToken, track, true, false, track.chime);
          continue;
        }
      }
      if (content.key !== track.lastKey) {
        // Any change of `waiting` is urgent: a drop answered on another device must reach this tile at once.
        const urgent = track.lastKey !== null && content.state.waiting !== track.lastWaiting;
        const due = track.lastSentAtMs === null ? at : track.lastSentAtMs + LIVE_ACTIVITY_THROTTLE_MS;
        if (urgent || at >= due) {
          void update(deviceToken, track, urgent, false);
          continue;
        }
        next = Math.min(next, due);
      } else {
        const due = (track.lastSentAtMs ?? at) + LIVE_ACTIVITY_HEARTBEAT_MS;
        if (at >= due) {
          void update(deviceToken, track, false, true);
          continue;
        }
        next = Math.min(next, due);
      }
    }
    arm(next);
  }

  const safely = (fn: () => void): void => {
    try {
      fn();
    } catch {
      // Ścieżka eventów managera i tras: best-effort, nigdy wyjątek.
    }
  };

  return {
    poke(): void {
      if (closed || coalesceTimer !== null) return;
      coalesceTimer = setTimer(() => {
        coalesceTimer = null;
        safely(() => {
          recompute();
          evaluate();
        });
      }, LIVE_ACTIVITY_COALESCE_MS);
    },
    register(deviceToken: string, input: LiveActivityInput): LiveActivitySetResult {
      const result = devices.setLiveActivity(deviceToken, input);
      if (result === 'started' || result === 'rotated') {
        const withActivity = devices.list().filter((r) => r.liveActivity !== undefined).length;
        safeLog(`live-activity: activity saved (${result === 'started' ? 'new' : 'token rotation'})`
          + ` — devices with an activity: ${String(withActivity)}`);
      }
      if (result === 'started') {
        safely(() => {
          recompute();
          evaluate();
        });
      }
      return result;
    },
    end(deviceToken: string, activityId: string): boolean {
      const token = normalizeApnsToken(deviceToken);
      const record = devices.get(token);
      const la = record?.liveActivity;
      if (record === undefined || la === undefined || la.activityId !== activityId) return false;
      devices.clearLiveActivity(token, { activityId });
      const track = tracks.get(token);
      tracks.delete(token);
      void finish(token, liveFrom(record, la), track, 'app');
      return true;
    },
    forgetDevice(deviceToken: string): void {
      const token = normalizeApnsToken(deviceToken);
      const record = devices.get(token);
      const la = record?.liveActivity;
      const track = tracks.get(token);
      tracks.delete(token);
      if (record === undefined || la === undefined) return;
      void finish(token, liveFrom(record, la), track, 'unregister');
    },
    chime(): number {
      if (closed) return 0;
      let orders = 0;
      safely(() => {
        sync();
        const at = now();
        for (const [deviceToken, track] of tracks) {
          const record = devices.get(deviceToken);
          const la = record?.liveActivity;
          // Bez zgody na powiadomienia nie gra — ta sama reguła co banery (`apns-sink.ts`).
          if (record?.alerts !== true || la === undefined) continue;
          if (at >= Date.parse(la.startedAt) + LIVE_ACTIVITY_MAX_AGE_MS) continue;
          if (track.lastChimeAtMs !== null && at - track.lastChimeAtMs < LIVE_ACTIVITY_CHIME_MIN_GAP_MS) continue;
          chimeSeq += 1;
          track.chime = { id: chimeSeq, untilMs: at + LIVE_ACTIVITY_CHIME_TTL_MS };
          orders += 1;
        }
        if (orders === 0) return;
        // Świeża treść: „gotowe” wychodzi ~15 s po końcu tury, a dźwięk jedzie z tym, co jest teraz.
        recompute();
        evaluate();
      });
      return orders;
    },
    passReady(deviceToken: string): void {
      if (closed) return;
      const track = tracks.get(normalizeApnsToken(deviceToken));
      if (track === undefined || !track.waitingForPass) return;
      track.waitingForPass = false;
      track.retryAtMs = null;
      safely(() => { evaluate(); });
    },
    cancelChimes(): number {
      let cancelled = 0;
      for (const track of tracks.values()) {
        // Ramka w locie już poszła; jej zlecenie skasuje odpowiedź.
        if (track.chime === null || track.chime.sending === true) continue;
        track.chime = null;
        cancelled += 1;
      }
      if (cancelled > 0) safeLog(`live-activity: back in Rarog — cancelled chimes: ${String(cancelled)}`);
      return cancelled;
    },
    close(): void {
      closed = true;
      if (coalesceTimer !== null) clearTimer(coalesceTimer);
      if (wakeTimer !== null) clearTimer(wakeTimer);
      coalesceTimer = null;
      wakeTimer = null;
      safely(() => options.onClose?.());
    },
  };
}
