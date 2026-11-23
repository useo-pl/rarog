/**
 * Ładunek i nagłówki APNs apki natywnej — CZYSTE składanie, zero sieci: baner (`alert`;
 * „skończył" jako sama plakietka, {@link badgeOnly}) i aktualizacja zbiorczej Live Activity
 * (`liveactivity`, sekcja na końcu pliku; dźwięk „skończył” jedzie w niej, {@link LIVE_ACTIVITY_CHIME}).
 *
 * Treść banera składa `content.ts` (`buildContent`): tytuł, `body` i ich `*Ref` przechodzą bez zmian, a strażnik
 * treści stoi tam, gdzie treść powstaje (`#notifyDetail` w managerze), nie tutaj. Ten moduł dokłada
 * tylko to, co należy do APNs:
 *
 * - nagłówki: `apns-push-type: alert`, `apns-topic` (temat wpisu urządzenia — podaje go wołający),
 *   `apns-priority` 10 dla spraw pilnych i 5 dla „gotowe", `apns-collapse-id` = `topic` treści
 *   (koalescencja per sesja),
 *   `apns-expiration` = CZAS ABSOLUTNY w sekundach epoki (`teraz + ttl`), nie TTL.
 *
 * Baner jest zawsze szyfrowany ({@link apnsAlertRequestE2e}), w formacie 3: wpis, który go nie
 * zadeklarował, sink (`apns-sink.ts`) pomija — jawnego wariantu nie ma:
 *
 * - `aps` DOKŁADNIE `{alert: tekst zastępczy, mutable-content: 1, sound: 'default', badge?, thread-id?}` (tekst
 *   zastępczy {@link RELAY_ALERT_PLACEHOLDER}, a dla wpisu z deklaracją `locKeys` jego klucze katalogu apki
 *   {@link ALERT_PLACEHOLDER_KEYS}; `thread-id` = klucz koalescencji `content.topic`, tylko przy rodzajach
 *   sesji — grupowanie w Centrum powiadomień);
 * - JEDEN blok POZA `aps`: {@link APNS_RAROG_BLOCK} `{v: 3, kid, n, c}` z treścią zaszyfrowaną kluczem urządzenia
 *   (`push-crypto.ts`);
 * - tekst jawny `{kind, title?, titleRef?, body?, bodyRef?, sessionId?, termId?, exp}` (`exp` = `apns-expiration`)
 *   niesie cel tapnięcia (którą sesję otworzyć) i treść z kodami zdań (`*Ref`: rozszerzenie powiadomień apki
 *   składa z nich zdanie w swoim języku), przycinaną po skalarach do {@link PUSH_PLAINTEXT_MAX_BYTES}.
 *
 * „Skończył” to sama plakietka: `aps: {badge}` bez alertu, dźwięku i `mutable-content`; szyfrogram jest wtedy bez
 * tytułu i treści (ukrywa tylko `sessionId`).
 *
 * Ładunek APNs ma sufit 4096 B. Treść jest krótka (`body` ≤ 120 znaków), ale tytuł niesie nazwę
 * projektu, której nikt nie ogranicza — więc przy nadmiarze tekstu jawnego najpierw wypadają kody zdań, a potem
 * tekst jest przycinany po SKALARACH Unicode (nigdy w środku pary surogatów), najpierw z `body`, potem z tytułu. Ładunek sprawdza się PO szyfrowaniu; gdyby
 * mimo przycięcia przekroczył sufit (patologiczne `sessionId`), żądania nie ma — wpis jest pomijany.
 */
import type { LiveActivityContentState } from '@rarog/shared/rest';
import { RELAY_ALERT_PLACEHOLDER } from '@rarog/shared/relay';
import type { SentenceCode, SentenceRef } from '@rarog/shared/sentences';
import { isSessionless } from './content.ts';
import type { PushContent } from './content.ts';
import { PUSH_PLAINTEXT_MAX_BYTES } from './push-crypto.ts';
import type { DevicePushKey, PushSealer } from './push-crypto.ts';

/** Sufit ładunku powiadomienia APNs (bajty UTF-8 całego JSON-a). */
export const APNS_PAYLOAD_MAX_BYTES = 4096;

/** Klucz bloku banera formatu 3 poza `aps`. */
export const APNS_RAROG_BLOCK = 'rarog';

/** Wersja bloku banera formatu 3: `{v: 3, kid, n, c}` pod {@link APNS_RAROG_BLOCK}. */
export const APNS_RAROG_BLOCK_VERSION = 3;

/**
 * Tekst zastępczy banera jako klucze katalogu apki — `aps.alert` wpisu z deklaracją `locKeys`
 * (`apns-devices.ts`); wpis bez niej dostaje literał {@link RELAY_ALERT_PLACEHOLDER}. Kluczem katalogu jest kod zdania
 * obszaru `push` wprost. Kształt dosłownie z polityki `v2` przekaźnika (`placeholderKeys` w
 * `shared/fixtures/relay/alert-policy.json`): bez `loc-args`, bo argumentem byłby jawny tekst.
 */
export const ALERT_PLACEHOLDER_KEYS = {
  'title-loc-key': 'push.placeholder.title',
  'loc-key': 'push.placeholder.body',
} as const satisfies Readonly<Record<string, SentenceCode>>;

/** Znacznik ucięcia — ten sam, którym `clip` w `content.ts` ucina `body`. */
const ELLIPSIS = '…';

/** Gotowe żądanie do `POST /3/device/<token>`: nagłówki APNs i ciało JSON. */
export interface ApnsRequest {
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface ApnsAlertE2eOptions {
  /** `apns-topic` — temat wpisu urządzenia (`apnsTopicOf`, `apns-devices.ts`), czyli bundle id jego apki. */
  readonly topic: string;
  /** Chwila wysyłki (ms epoki) — z niej liczy się `apns-expiration`. */
  readonly nowMs: number;
  /** Klucz push urządzenia-adresata (`devices.json`): szyfrowanie jest per urządzenie. */
  readonly key: DevicePushKey;
  /** Szyfrowanie koperty (`createPushSealer`); produkcja — z losowym nonce. */
  readonly sealer: PushSealer;
  /** Deklaracja `locKeys` wpisu-adresata: `true` = tekst zastępczy kluczami {@link ALERT_PLACEHOLDER_KEYS}. */
  readonly locKeys?: boolean;
}

/**
 * Sesja banera; push próbny, „sparowano nowe urządzenie”, „zmiana wersji” i limit tygodniowy jej nie
 * mają — bez `sessionId`, `termId` i wątku.
 */
const sessionIdOf = (content: PushContent): string | undefined =>
  (isSessionless(content) ? undefined : content.sessionId);

/** Cel tapnięcia w tekście jawnym: rodzaj, a przy rodzajach sesji — sesja i terminal. */
function target(content: PushContent): { kind: string; sessionId?: string; termId?: string } {
  // Rodzaje bez sesji (`isSessionless`) — cel to sam rodzaj.
  if (isSessionless(content)) return { kind: content.kind };
  return {
    kind: content.kind,
    sessionId: content.sessionId,
    ...(content.termId === undefined ? {} : { termId: content.termId }),
  };
}

/**
 * „Skończył" (`done`) idzie do apki jako SAMA PLAKIETKA: `aps: { badge }`, bez `alert`, bez `sound`
 * i bez wątku (o wyniku mówią kafel Live Activity
 * i dymek w apce, baner byłby zbędnym przerwaniem). Push nie znika całkiem, bo:
 *
 * - plakietka na ikonie zostaje aktualna (liczba czekających zmienia się i przy wyniku);
 * - realne 200 odświeża `lastOkAt` urządzenia, a po nim rejestr liczy LRU (`apns-devices.ts`).
 *
 * Typ zostaje `alert`: Apple każe go używać także dla powiadomienia, które tylko ustawia plakietkę.
 * Dźwięk „skończył” gra nie ten push, tylko aktualizacja kafla, którą w tej samej
 * chwili zleca `fanout.ts` ({@link LIVE_ACTIVITY_CHIME}, `live-activity.ts`).
 */
export function badgeOnly(content: PushContent): boolean {
  return content.kind === 'done';
}

/**
 * Wysyłka bez sensu: sama plakietka bez liczby. W produkcji nadawca zawsze ją zna
 * (`server/src/index.ts`, `badge`), więc to gałąź testów i konfiguracji bez managera.
 */
export function apnsSkips(content: PushContent): boolean {
  return badgeOnly(content) && content.badge === undefined;
}

/** `aps` samej plakietki — „skończył”. */
const badgeAps = (content: PushContent): Record<string, unknown> =>
  (content.badge === undefined ? {} : { badge: content.badge });

const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

/**
 * Ucina `text` od końca po skalarach Unicode, aż zwolni co najmniej `excess` bajtów (licząc
 * znacznik ucięcia). Pusty wynik, gdy całe pole nie wystarczy.
 */
function trimScalars(text: string, excess: number): string {
  const scalars = [...text];
  let freed = 0;
  while (scalars.length > 0 && freed < excess + bytes(ELLIPSIS)) {
    freed += bytes(scalars.pop() ?? '');
  }
  return scalars.length === 0 ? '' : `${scalars.join('').trimEnd()}${ELLIPSIS}`;
}

/** Teksty banera do tekstu jawnego: tytuł i treść z kodami zdań (`*Ref`), gdy są. */
interface Texts {
  readonly title: string;
  readonly titleRef?: SentenceRef;
  readonly body: string;
  readonly bodyRef?: SentenceRef;
}

/**
 * JSON z tytułem i treścią ≤ `maxBytes`. Kody zdań liczą się w limicie: gdy tekst jawny się nie mieści, najpierw
 * wypadają oba `*Ref` (tłumaczenie jest dodatkiem, tekst serwera — treścią), potem przycina się `body`, a gdy to nie
 * wystarczy — tytuł. Tekst przycięty nigdy nie niesie `ref`, bo tłumaczenie odtworzyłoby uciętą resztę. Pętla, bo
 * escapowanie JSON-a (cudzysłów, `\n`) waży więcej niż sam znak. Sufit tekstu jawnego to
 * {@link PUSH_PLAINTEXT_MAX_BYTES}; gdy nie ma już czego ciąć, zostaje to, co jest.
 */
function fitTexts(content: PushContent, maxBytes: number, render: (texts: Texts) => string): string {
  let texts: Texts = {
    title: content.title,
    ...(content.titleRef === undefined ? {} : { titleRef: content.titleRef }),
    body: content.body,
    ...(content.bodyRef === undefined ? {} : { bodyRef: content.bodyRef }),
  };
  let json = render(texts);
  if (bytes(json) > maxBytes && (texts.titleRef !== undefined || texts.bodyRef !== undefined)) {
    texts = { title: texts.title, body: texts.body };
    json = render(texts);
  }
  while (bytes(json) > maxBytes) {
    const excess = bytes(json) - maxBytes;
    if (texts.body !== '') texts = { ...texts, body: trimScalars(texts.body, excess) };
    else if (texts.title !== '') texts = { ...texts, title: trimScalars(texts.title, excess) };
    else break;
    json = render(texts);
  }
  return json;
}

/** `apns-expiration` (sekundy epoki) — także `exp` tekstu jawnego. */
const expirationOf = (content: PushContent, nowMs: number): number => Math.floor(nowMs / 1000) + content.ttl;

/** Nagłówki banera. */
function alertHeaders(content: PushContent, topic: string, nowMs: number): Readonly<Record<string, string>> {
  return {
    'apns-push-type': 'alert',
    'apns-topic': topic,
    'apns-priority': content.urgency === 'high' ? '10' : '5',
    'apns-collapse-id': content.topic,
    'apns-expiration': String(expirationOf(content, nowMs)),
  };
}

/** Tekst jawny: cel tapnięcia, tytuł i treść (z `*Ref`) tylko przy alercie, `exp` = `apns-expiration`. */
function plaintextJson(content: PushContent, exp: number, texts: Texts): string {
  const { kind, ...rest } = target(content);
  return JSON.stringify({ kind, ...(badgeOnly(content) ? {} : texts), ...rest, exp });
}

/**
 * Treść banera → żądanie APNs typu `alert` w formacie 3 (przy `done` — sama plakietka,
 * {@link badgeOnly}) zaszyfrowane kluczem JEDNEGO urządzenia. `undefined` = cały ładunek PO szyfrowaniu przekroczył
 * {@link APNS_PAYLOAD_MAX_BYTES} — wołający pomija wpis. Rzuca przy złym kluczu (`push-crypto.ts`); sink łapie to jak
 * pominięcie.
 */
export function apnsAlertRequestE2e(content: PushContent, options: ApnsAlertE2eOptions): ApnsRequest | undefined {
  const exp = expirationOf(content, options.nowMs);
  const plaintext = fitTexts(content, PUSH_PLAINTEXT_MAX_BYTES, (texts) => plaintextJson(content, exp, texts));
  const envelope = options.sealer.seal(options.key, plaintext);
  const aps = badgeOnly(content)
    ? badgeAps(content)
    : {
      alert: options.locKeys === true ? { ...ALERT_PLACEHOLDER_KEYS } : { ...RELAY_ALERT_PLACEHOLDER },
      'mutable-content': 1,
      sound: 'default',
      ...badgeAps(content),
      // Klucz koalescencji (skrót id sesji), ta sama wartość co jawny `apns-collapse-id` — nie surowe id.
      ...(sessionIdOf(content) === undefined ? {} : { 'thread-id': content.topic }),
    };
  const body = JSON.stringify({ aps, [APNS_RAROG_BLOCK]: { v: APNS_RAROG_BLOCK_VERSION, ...envelope } });
  if (bytes(body) > APNS_PAYLOAD_MAX_BYTES) return undefined;
  return { headers: alertHeaders(content, options.topic, options.nowMs), body };
}

// ---------------------------------------------------------------------------
// Live Activity — ramka `liveactivity`
// ---------------------------------------------------------------------------

/** Sufiks topicu aktualizacji Live Activity: `<bundle id>.push-type.liveactivity` (Apple). */
export const LIVE_ACTIVITY_TOPIC_SUFFIX = '.push-type.liveactivity';

/**
 * Po ilu sekundach od wysyłki aktywność uznaje treść za NIEŚWIEŻĄ (`stale-date`) i apka pokazuje
 * „dane sprzed …". Heartbeat co ~10 min (`live-activity.ts`) trzyma ją świeżą, dopóki serwer żyje
 * i ma łączność; po jego zniknięciu kafel sam mówi, że może kłamać.
 */
export const LIVE_ACTIVITY_STALE_SECONDS = 15 * 60;

/**
 * Jak długo APNs trzyma `end` dla urządzenia poza siecią. Aktywność żyje systemowo najwyżej 8 h,
 * więc dłużej nie ma czego kończyć.
 */
export const LIVE_ACTIVITY_END_EXPIRATION_SECONDS = 8 * 60 * 60;

/**
 * Alert dźwięku „skończył” w aktualizacji kafla. Teksty są STAŁE: kafel
 * nie niesie treści (`docs/security-model.md`, „Live Activity of the native app”), a Apple Watch pokazuje
 * tytuł i treść alertu. Plik dźwięku leży w korzeniu paczki apki (`native/Rarog/Rarog/skonczyl.caf`, strażnik
 * w `notify-apns-payload.test.ts`). Zmierzone na zablokowanym iPhonie: taka aktualizacja
 * gra sam dźwięk, bez banera i bez wpisu w Centrum powiadomień.
 */
export const LIVE_ACTIVITY_CHIME = {
  title: 'Agent skończył',
  body: 'Wynik czeka w Rarogu',
  sound: 'skonczyl.caf',
} as const;

/**
 * Ten sam dzwonek jako klucze katalogu apki — wpis z deklaracją `locKeys`. Postać zagnieżdżona kafla
 * (`{title: {loc-key}, body: {loc-key}}`) i ten sam dźwięk, dosłownie jak w polityce `v2` przekaźnika (`chimeKeys`
 * w `shared/fixtures/relay/alert-policy.json`); kluczem jest kod zdania obszaru `push`.
 */
export const LIVE_ACTIVITY_CHIME_KEYS = {
  title: { 'loc-key': 'push.chime.title' satisfies SentenceCode },
  body: { 'loc-key': 'push.chime.body' satisfies SentenceCode },
  sound: LIVE_ACTIVITY_CHIME.sound,
} as const;

/** Dźwięk „skończył” doklejony do aktualizacji kafla. */
export interface LiveActivityChime {
  /**
   * `apns-expiration` w sekundach epoki, z ZEGARA ŚCIENNEGO wołającego (nie z `timestamp`, który
   * bywa przed zegarem): APNs po tej chwili ramki z dźwiękiem już nie dowiezie.
   */
  readonly expiresAtSec: number;
  /** Deklaracja `locKeys` wpisu urządzenia: `true` = dzwonek kluczami {@link LIVE_ACTIVITY_CHIME_KEYS}. */
  readonly locKeys?: boolean;
}

interface LiveActivityBaseOptions {
  /** Temat wpisu urządzenia (`apnsTopicOf`, `apns-devices.ts`) — sufiks dokleja ten moduł. */
  readonly topic: string;
  /**
   * `aps.timestamp` w sekundach epoki. ActivityKit odrzuca aktualizację nie nowszą niż ostatnia,
   * więc ściśle rosnący znacznik per aktywność pilnuje wołający (`live-activity.ts`).
   */
  readonly timestamp: number;
  /** `high` = `apns-priority: 10` (wzrost liczby czekających), `low` = 5 (reszta, budżet). */
  readonly priority: 'high' | 'low';
}

/** Dźwięk jedzie wyłącznie z `update` — `end` z alertem typ odrzuca. */
export type ApnsLiveActivityOptions =
  | (LiveActivityBaseOptions & { readonly event: 'update'; readonly chime?: LiveActivityChime })
  | (LiveActivityBaseOptions & { readonly event: 'end'; readonly chime?: never });

type ContentState = LiveActivityContentState;

function liveActivityBody(state: ContentState, options: ApnsLiveActivityOptions): string {
  const aps = options.event === 'update'
    ? {
      timestamp: options.timestamp, event: 'update', 'content-state': state,
      ...(options.chime === undefined ? {} : {
        alert: options.chime.locKeys === true ? LIVE_ACTIVITY_CHIME_KEYS : { ...LIVE_ACTIVITY_CHIME },
      }),
      'stale-date': options.timestamp + LIVE_ACTIVITY_STALE_SECONDS,
    }
    : { timestamp: options.timestamp, event: 'end', 'content-state': state, 'dismissal-date': options.timestamp };
  return JSON.stringify({ aps });
}

type Workflow = NonNullable<ContentState['workflows']>[number];

/** Podmiana jednego przebiegu na kafelku (reszta stanu bez zmian). */
function withWorkflow(state: ContentState, index: number, change: (w: Workflow) => Workflow): ContentState {
  const list = state.workflows;
  const target = list?.[index];
  if (list === undefined || target === undefined) return state;
  return { ...state, workflows: list.map((w, i) => (i === index ? change(w) : w)) };
}

/** Pola tekstowe JEDNEGO przebiegu od najmniej ważnego: tytuł fazy, nazwa skryptu, projekt. */
function workflowFields(index: number): readonly {
  readonly get: (s: ContentState) => string | undefined;
  readonly set: (s: ContentState, value: string) => ContentState;
}[] {
  return [
    {
      get: (s) => s.workflows?.[index]?.phase?.title,
      set: (s, v) => withWorkflow(s, index, (w) => (w.phase === undefined ? w : { ...w, phase: { ...w.phase, title: v } })),
    },
    // Nazwa i projekt są wymagane i niepuste (kontrakt) — przycięte do zera zostają samym wielokropkiem.
    { get: (s) => s.workflows?.[index]?.name, set: (s, v) => withWorkflow(s, index, (w) => ({ ...w, name: v === '' ? ELLIPSIS : v })) },
    { get: (s) => s.workflows?.[index]?.project, set: (s, v) => withWorkflow(s, index, (w) => ({ ...w, project: v === '' ? ELLIPSIS : v })) },
  ];
}

/**
 * Pola tekstowe stanu, które wolno przyciąć — w kolejności OD NAJMNIEJ ważnego: najpierw drugi przebieg,
 * potem pierwszy. Kontrakt v2 ma sufit 60 znaków na łańcuch, więc ładunek mieści się z konstrukcji;
 * to obrona na wypadek zmiany sufitu albo producenta, który go nie przestrzega.
 */
const TRIMMABLE = [...workflowFields(1), ...workflowFields(0)];

/**
 * Ciało ≤ {@link APNS_PAYLOAD_MAX_BYTES}: przycina pola tekstowe stanu po skalarach Unicode
 * w kolejności {@link TRIMMABLE}, aż się zmieści. Stan z seedów mieści się z wielkim zapasem —
 * to obrona przed nazwą projektu albo tytułem fazy, których nikt nie ogranicza.
 */
function fitLiveActivity(state: ContentState, options: ApnsLiveActivityOptions): string {
  let current = state;
  let json = liveActivityBody(current, options);
  for (const field of TRIMMABLE) {
    if (bytes(json) <= APNS_PAYLOAD_MAX_BYTES) break;
    const value = field.get(current) ?? '';
    if (value === '' || value === ELLIPSIS) continue;
    current = field.set(current, trimScalars(value, bytes(json) - APNS_PAYLOAD_MAX_BYTES));
    json = liveActivityBody(current, options);
  }
  return json;
}

/**
 * Stan treści → żądanie APNs typu `liveactivity` (`update` albo `end`). Zwykle bez `alert`: aktywność
 * aktualizuje się po cichu, a baner o sprawie idzie osobnym żądaniem typu `alert`. Wyjątek to dźwięk
 * „skończył” (`chime`, tylko `update`): `aps.alert` = {@link LIVE_ACTIVITY_CHIME} (przy `chime.locKeys` jego klucze
 * {@link LIVE_ACTIVITY_CHIME_KEYS}), `apns-priority: 10`
 * (kształt zmierzony; dostawa od razu, a nie w paczce) i `apns-expiration` =
 * `chime.expiresAtSec` — spóźniony dźwięk nie ma grać.
 */
export function apnsLiveActivityRequest(state: ContentState, options: ApnsLiveActivityOptions): ApnsRequest {
  const chime = options.event === 'update' ? options.chime : undefined;
  const expiration = chime !== undefined
    ? chime.expiresAtSec
    : options.event === 'update'
      ? options.timestamp + LIVE_ACTIVITY_STALE_SECONDS
      : options.timestamp + LIVE_ACTIVITY_END_EXPIRATION_SECONDS;
  return {
    headers: {
      'apns-push-type': 'liveactivity',
      'apns-topic': `${options.topic}${LIVE_ACTIVITY_TOPIC_SUFFIX}`,
      'apns-priority': chime !== undefined || options.priority === 'high' ? '10' : '5',
      'apns-expiration': String(expiration),
    },
    body: fitLiveActivity(state, options),
  };
}
