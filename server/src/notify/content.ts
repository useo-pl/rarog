/**
 * Treść powiadomienia — CZYSTE składanie, zero sieci.
 *
 * To, co człowiek zobaczy na ekranie blokady, składa się tutaj i testuje bez ani jednego gniazda;
 * ładunek i nagłówki APNs dokłada `apns-payload.ts`, a wysyłkę robi `apns-sink.ts`. Jedynym
 * kanałem banerów jest APNs apki natywnej — Web Push do PWA wycofano razem z PWA.
 *
 * Treść niesie tytuł, `body`, klucz koalescencji, pilność, TTL i plakietkę oraz CEL tapnięcia
 * (`kind`, `sessionId`, `termId`), a nie adres: apka czyta cel z klucza `rarog` ładunku APNs.
 * Rozróżnienie rodzaju zdarzenia na pierwszy rzut oka bierze na siebie emoji na początku tytułu
 * (szablony `push.title.<rodzaj>`).
 *
 * Zdania: tytuł i `body` to angielski tekst zdań z `say()`, a obok jedzie ich `ref` (`titleRef`, `bodyRef`),
 * z którego rozszerzenie powiadomień apki składa zdanie w swoim języku. `ref` nigdy nie odtwarza treści, której tekst
 * nie pokazuje: argumenty są spłaszczone i przycięte PRZED `say()`, a tekst, którego nie da się tak złożyć, jedzie bez
 * `ref`.
 */
import { createHash } from 'node:crypto';
import { NOTIFY_KIND_TITLE } from '@rarog/shared/notify-copy';
import type { ServerSystem } from '@rarog/shared/rest';
import { isForeignText, isServerSentence, say } from '@rarog/shared/sentences';
import type { AnyText, SentenceCode, SentenceRef, ServerSentence } from '@rarog/shared/sentences';
import type { ConsentProofRule } from '../herdr/dialogs/layer1/contract.ts';
import type { ConsentCanaryResult } from '../herdr/dialogs/layer1/version-gate.ts';
import { serverSystem } from '../version.ts';
import type { NotifyClass, NotifyKind } from './policy.ts';

/** Ile znaków treści mieści się na banerze, zanim iOS i tak ją utnie w środku słowa. */
export const MESSAGE_MAX_CHARS = 120;

/**
 * Długość klucza koalescencji ({@link topicFor}): 32 znaki base64url. Kształt z czasów nagłówka
 * `Topic` Web Push (sufit 32 znaki); `apns-collapse-id` mieści do 64 bajtów, więc klucz przechodzi
 * do APNs bez zmian.
 */
export const TOPIC_MAX_CHARS = 32;

/**
 * Treść, gdy zdarzenie nie przyniosło szczegółu (brak podsumowania, brak nazwy narzędzia).
 * Zdanie mówi, co zastanie się po tapnięciu — nigdy nie powtarza tytułu ani projektu.
 */
const FALLBACK_BODY = {
  permission: 'push.body.fallback.permission',
  question: 'push.body.fallback.question',
  blocked: 'push.body.fallback.blocked',
  done: 'push.body.fallback.done',
  error: 'push.body.fallback.error',
  limit: 'push.body.fallback.limit',
} as const satisfies Readonly<Record<NotifyKind, SentenceCode>>;

/**
 * Jak długo APNs trzyma wiadomość dla telefonu, który akurat jest poza siecią (`apns-expiration`
 * = chwila wysyłki + TTL, `apns-payload.ts`).
 *
 * Sprawa blokująca i awaria po 10 minutach są zwykle nieaktualne (użytkownik odblokował
 * z Maca albo sesja poszła dalej), więc dostarczanie ich po godzinie byłoby powiadamianiem
 * o stanie, którego nie ma. „Gotowe" starzeje się wolniej — wynik czeka w transkrypcie.
 */
const TTL_SECONDS: Readonly<Record<NotifyClass, number>> = {
  blocking: 600,
  failure: 600,
  done: 3600,
};

/**
 * `high` = dostarcz natychmiast (`apns-priority: 10`), `normal` = system może poczekać na lepszy
 * moment baterii (`5`).
 */
const URGENCY: Readonly<Record<NotifyClass, PushUrgency>> = {
  blocking: 'high',
  failure: 'high',
  done: 'normal',
};

export type PushUrgency = 'high' | 'normal';

/** Część treści wspólna dla banera sesji i pusha próbnego. */
interface PushContentBase {
  readonly title: string;
  /** Kod zdania tytułu; brak = tytuł bez kodu. */
  readonly titleRef?: SentenceRef;
  readonly body: string;
  /** Kod zdania treści; brak = treść bez kodu (zdanie bez kodu albo tekst, którego nie dało się złożyć). */
  readonly bodyRef?: SentenceRef;
  /**
   * Klucz koalescencji (`apns-collapse-id`): powiadomienia o tej samej sesji system pokazuje jako
   * JEDNO — nowsze zastępuje starsze.
   */
  readonly topic: string;
  readonly urgency: PushUrgency;
  /** Sekundy życia wiadomości w APNs (z nich `apns-expiration`). */
  readonly ttl: number;
  /**
   * Plakietka NA IKONIE apki (`aps.badge`): liczba sesji, które czekają na człowieka.
   * `0` JEST wysyłane — czyści plakietkę. `undefined` = nie ruszaj plakietki.
   */
  readonly badge?: number;
}

/**
 * Rodzaje pushu BEZ sesji: próbny, `device-paired`, `version-changed` i `weekly-limit`. Cel tapnięcia to sam rodzaj;
 * ładunek nie ma `sessionId`, `termId` ani wątku (`apns-payload.ts`).
 */
export type SessionlessPushKind = 'test' | 'device-paired' | 'version-changed' | 'weekly-limit';

/**
 * Gotowa treść jednego powiadomienia — wszystko, czego sink potrzebuje poza adresatem.
 *
 * Cztery kształty: baner SESJI (rodzaj z {@link NotifyKind}, cel tapnięcia = sesja albo terminal
 * wpisu Codexa), push PRÓBNY (`kind: 'test'`, bez sesji — tap otwiera listę), push bezpieczeństwa
 * `device-paired` (sparowano nowe urządzenie; bez sesji, tap obsługuje apka) i push
 * `version-changed` (nowa wersja Claude Code albo herdr na serwerze, `version-watch.ts`; bez sesji; apka pokazuje
 * baner także na wierzchu, tap otwiera ekran „Serwer”) oraz push `weekly-limit` (tygodniowy limit planu jednego okna
 * doszedł do progu; bez sesji). Apka, która rodzaju nie zna, czyta go jako brak rodzaju:
 * pokazuje tytuł i treść, a tap otwiera samą apkę. Cel tapnięcia apka czyta z klucza `rarog` ładunku APNs
 * (`apns-payload.ts`).
 */
export type PushContent = PushContentBase & (
  | {
    readonly kind: NotifyKind;
    /** Sesja, której dotyczy baner — tap otwiera ją w kliencie. */
    readonly sessionId: string;
    /** `SessionSummary.termId` — agent w terminalu Raroga: tap prowadzi TAM. */
    readonly termId?: string;
  }
  | { readonly kind: SessionlessPushKind }
);

/** Czy push nie dotyczy sesji ({@link SessionlessPushKind}). */
export function isSessionless(
  content: PushContent,
): content is PushContentBase & { readonly kind: SessionlessPushKind } {
  return content.kind === 'test' || content.kind === 'device-paired' || content.kind === 'version-changed'
    || content.kind === 'weekly-limit';
}

/**
 * Wynik wysyłki — trójstan, bo „nikt nie słucha" nie jest ani zdrowiem, ani awarią kanału:
 * `delivered` = co najmniej jedno urządzenie przyjęło; `failed` = była próba i żadna nie doszła;
 * `no-receiver` = nie było komu wysłać, zero prób.
 */
export type SendOutcome = 'delivered' | 'failed' | 'no-receiver';

export interface ContentInput {
  readonly cls: NotifyClass;
  /** Rodzaj zdarzenia — niesie tytuł; klasa niesie tylko pilność i TTL. */
  readonly kind: NotifyKind;
  /** Projekt (`basename(cwd)`). */
  readonly project: string;
  /** Człon sesji z tytułu `projekt · sesja`. Brak = sesja bez etykiety. */
  readonly label?: string;
  /**
   * Czego dotyczy: nazwa narzędzia, pytanie i zdanie wyniku (tekst agenta, `foreign`) albo dopisek stanu (zdanie
   * Raroga z `say()`, którego `ref` staje się `bodyRef`).
   */
  readonly detail?: AnyText;
  /** Sesja, której dotyczy baner — tap otwiera ją w Rarogu. */
  readonly sessionId: string;
  /**
   * `SessionSummary.termId` — terminal Raroga, w którym stoi ten panel (Codex albo Claude).
   * Obecne = tap ma prowadzić TAM, a nie na ekran sesji (klucz `rarog.termId` w `apns-payload.ts`).
   */
  readonly termId?: string;
  /** Plakietka na ikonie; patrz {@link PushContentBase.badge}. */
  readonly badge?: number;
}

/**
 * Ucina do `max` znaków (razem ze znacznikiem ucięcia) na granicy słowa, gdy jakaś jest blisko końca.
 */
function clip(text: string, max = MESSAGE_MAX_CHARS): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max - 1);
  // Granica nie rozcina pary surogatów: samotna połówka psuje JSON tekstu jawnego, apka odrzuca cały baner.
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max - 20 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Jedna linia bez markdownu, BEZ przycięcia — przycina dopiero składanie zdania ({@link fitBody}). */
function oneLine(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_`>#]/g, '')
    .replace(/^\s*[-–]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Zdejmuje markdown i skleja w jedną linię — baner nie ma gdzie renderować składni.
 *
 * Świadomie prymitywne: interesują nas wyłącznie znaczniki, które agent produkuje najczęściej
 * (`**`, `` ` ``, `#`, `-` na początku linii). Pełny parser byłby tu kosztem bez pokrycia —
 * treść i tak jest przycinana do {@link MESSAGE_MAX_CHARS}.
 */
export function flatten(text: string): string {
  return clip(oneLine(text));
}

/**
 * Klucz koalescencji = skrót id sesji, nie samo id ({@link TOPIC_MAX_CHARS} znaków base64url).
 * Skrót jest stabilny per sesja (to warunek koalescencji) i nie zdradza id dostawcy pushy, choć
 * akurat na tym nikomu nie zależy.
 */
export function topicFor(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('base64url').slice(0, TOPIC_MAX_CHARS);
}

/** Tekst z opcjonalnym kodem zdania — wynik składania tytułu albo treści. */
interface Sentence {
  readonly text: string;
  readonly ref?: SentenceRef;
}

const sentence = (said: ServerSentence): Sentence => ({ text: said.text, ref: said.ref });

/** `text` i `*Ref` pola treści, bez pola `*Ref`, gdy zdanie go nie ma. */
const titleFields = (title: Sentence): { title: string; titleRef?: SentenceRef } =>
  (title.ref === undefined ? { title: title.text } : { title: title.text, titleRef: title.ref });
const bodyFields = (body: Sentence): { body: string; bodyRef?: SentenceRef } =>
  (body.ref === undefined ? { body: body.text } : { body: body.text, bodyRef: body.ref });

/**
 * Numer etykiety zapasowej (`session N` i dawne `sesja N` z rejestru sprzed angielskich zdań) — ta sama reguła co
 * `isFallbackLabel` w managerze (test w `sentences-push.test.ts` pilnuje zgodności). Numer spoza bezpiecznych liczb
 * całkowitych = zwykła etykieta.
 */
function fallbackNumber(label: string): number | undefined {
  const match = /^(?:sesja|session) (\d+)$/u.exec(label);
  const n = match === null ? Number.NaN : Number(match[1]);
  return Number.isSafeInteger(n) ? n : undefined;
}

/** Ile znaków zostaje etykiecie, gdy zdanie z nią i szczegółem nie mieści się na banerze. */
const LABEL_ROOM = 40;

/**
 * Zdanie treści z argumentem `detail` (i stałą resztą) zmieszczone w {@link MESSAGE_MAX_CHARS}: najpierw pełne,
 * potem `detail` przycięty do miejsca, które zostawia reszta szablonu. Gdy i to nie wystarczy, zostaje przycięty
 * tekst bez `ref` — `ref` nie może odtworzyć treści, której baner nie pokazuje.
 */
function fitBody(make: (detail: string) => ServerSentence, detail: string): Sentence {
  const full = make(detail);
  if (full.text.length <= MESSAGE_MAX_CHARS) return sentence(full);
  const room = MESSAGE_MAX_CHARS - make('').text.length;
  const fitted = room > 1 ? make(clip(detail, room)) : full;
  return fitted.text.length <= MESSAGE_MAX_CHARS ? sentence(fitted) : { text: clip(fitted.text) };
}

/**
 * Szczegół, który jest zdaniem Raroga (błąd, limit planu): treścią jest to zdanie z WŁASNYM `ref`. Tekst, który
 * trzeba by spłaszczyć albo przyciąć, jedzie bez `ref`.
 */
function ownDetail(detail: AnyText): Sentence {
  const flat = oneLine(detail.text);
  if (isServerSentence(detail) && flat === detail.text && flat.length <= MESSAGE_MAX_CHARS) return sentence(detail);
  return { text: clip(flat) };
}

/**
 * Treść pod tytułem — SAMA informacja, bez powtarzania projektu (jest w tytule) i nadawcy
 * (dopisuje iOS). Co niesie, zależy od rodzaju:
 *
 * - zgoda / dialog w terminalu: nazwa narzędzia (jedyne, co wolno tu wysłać —
 *   `docs/security-model.md`, punkt 17) i etykieta sesji, bo w jednym projekcie bywa kilka sesji
 *   („Bash — zapis notatek"); etykieta zapasowa jedzie samym numerem (`push.body.detail-and-session-number`);
 * - pytanie: treść pytania; wynik: zdanie podsumowania; błąd/limit: powód (zdanie Raroga z własnym `ref`).
 *   Etykieta sesji ustępuje tu treści — dwie sesje tego samego projektu różnią się i tak zdaniem, a tap
 *   i tak otwiera właściwą.
 *
 * Bez szczegółu zostaje etykieta sesji, a bez niej zdanie z {@link FALLBACK_BODY}.
 */
function bodyFor(kind: NotifyKind, detail: AnyText | undefined, rawLabel: string | undefined): Sentence {
  const text = detail === undefined ? '' : oneLine(detail.text);
  let label = rawLabel === undefined ? '' : oneLine(rawLabel);
  const n = fallbackNumber(label);
  if ((kind === 'permission' || kind === 'blocked') && text !== '' && label !== '') {
    if (n !== undefined) return fitBody((d) => say('push.body.detail-and-session-number', { detail: d, n }), text);
    if (say('push.body.detail-and-label', { detail: text, label }).text.length > MESSAGE_MAX_CHARS) {
      label = clip(label, LABEL_ROOM);
    }
    return fitBody((d) => say('push.body.detail-and-label', { detail: d, label }), text);
  }
  if (detail !== undefined && text !== '') {
    // Szczegół od agenta (`foreign`) idzie argumentem; zdanie Raroga — sobą.
    if (!isForeignText(detail)) return ownDetail(detail);
    return fitBody((d) => say('push.body.detail', { detail: d }), text);
  }
  if (n !== undefined) return sentence(say('session.fallback-label', { n }));
  if (label !== '') return fitBody((l) => say('push.body.label', { label: l }), label);
  return sentence(say(FALLBACK_BODY[kind]));
}

/**
 * Fakty → gotowa treść banera: tytuł (emoji, rodzaj, projekt) i `body` ({@link bodyFor}), bez
 * `subtitle`. Bez `detail` zostaje sam kontekst — ta sama degradacja co w hookach (`Stop` nie
 * zawsze niesie ostatnią wiadomość).
 */
export function buildContent(input: ContentInput): PushContent {
  return {
    kind: input.kind,
    sessionId: input.sessionId,
    ...(input.termId === undefined ? {} : { termId: input.termId }),
    ...titleFields(sentence(say(NOTIFY_KIND_TITLE[input.kind], { project: input.project }))),
    ...bodyFields(bodyFor(input.kind, input.detail, input.label)),
    // `Topic` zostaje NA SESJI, także dla Codexa: koalescencja ma wypierać starszy baner
    // o tej samej sprawie, a sprawą jest sesja — nie ekran, na który tap prowadzi.
    topic: topicFor(input.sessionId),
    urgency: URGENCY[input.cls],
    ttl: TTL_SECONDS[input.cls],
    ...(input.badge === undefined ? {} : { badge: input.badge }),
  };
}

/**
 * Push PRÓBNY po włączeniu powiadomień: tap otwiera listę sesji. Krótki TTL — próba, która
 * dojdzie po godzinie, niczego już nie potwierdza. Bez plakietki: nie wiemy tu, ile sesji czeka.
 * Tytuł z dzwonkiem zamiast emoji rodzaju: to jedyny baner, który mówi o samym kanale, a nie o sesji.
 */
export function buildTestContent(): PushContent {
  return {
    kind: 'test',
    ...titleFields(sentence(say('push.test-title'))),
    ...bodyFields(sentence(say('push.test-body'))),
    topic: topicFor('rarog:test'),
    urgency: 'high',
    ttl: 120,
  };
}

/**
 * Push bezpieczeństwa po sparowaniu NOWEGO urządzenia do pozostałych aktywnych urządzeń z `alerts:
 * true`. Treść = etykieta nowego urządzenia (już po sanityzacji) i jedna instrukcja z maszyną serwera (Mac albo VPS,
 * `serverSystem()`); tytuł z kłódką zamiast emoji rodzaju sesji. Doba życia
 * w APNs: telefon poza siecią ma się o tym dowiedzieć także jutro rano. Best-effort — trwały ślad
 * niesie lista urządzeń (`GET /api/devices`), którą apka porównuje po każdym `hello`.
 */
export function buildDevicePairedContent(label: string, system: ServerSystem = serverSystem()): PushContent {
  const make = system === 'macos'
    ? (l: string) => say('push.paired-body.mac', { label: l })
    : (l: string) => say('push.paired-body.vps', { label: l });
  return {
    kind: 'device-paired',
    ...titleFields(sentence(say('push.paired-title'))),
    ...bodyFields(fitBody(make, label)),
    topic: topicFor('rarog:device-paired'),
    urgency: 'high',
    ttl: 24 * 60 * 60,
  };
}

/** Program, którego wersję śledzi serwer (`version-watch.ts`). Codexa tu nie ma: serwer nie zna jego wersji. */
export type VersionedProduct = 'claude-code' | 'herdr';

/** Jedna zmiana wersji: poprzednia i nowa wartość (także niższa — powrót do starszej wersji). */
export interface VersionChange {
  readonly product: VersionedProduct;
  readonly from: string;
  readonly to: string;
}

/**
 * Push `version-changed`: na serwerze stoi inna wersja Claude Code albo herdr niż przy poprzednim odczycie. Jeden push
 * na paczkę zmian, więc jednoczesna zmiana obu programów to jedno zdanie (`push.version-body.both`). Treść to same
 * numery wersji (wołający pilnuje ich kształtu i długości, więc zdanie mieści się na banerze z kodem). Pilny i doba
 * w APNs, jak `device-paired`: to sygnał raz na wersję, a telefon poza siecią ma go dostać także później. Bez
 * plakietki. Pusta lista zmian to błąd wołającego.
 */
export function buildVersionContent(changes: readonly VersionChange[]): PushContent {
  const cli = changes.find((change) => change.product === 'claude-code');
  const herdr = changes.find((change) => change.product === 'herdr');
  let body: ServerSentence;
  if (cli !== undefined && herdr !== undefined) {
    body = say('push.version-body.both', {
      cliFrom: cli.from, cliTo: cli.to, herdrFrom: herdr.from, herdrTo: herdr.to,
    });
  } else if (cli !== undefined) {
    body = say('push.version-body.claude-code', { from: cli.from, to: cli.to });
  } else if (herdr !== undefined) {
    body = say('push.version-body.herdr', { from: herdr.from, to: herdr.to });
  } else {
    throw new Error('buildVersionContent: no version change');
  }
  return {
    kind: 'version-changed',
    ...titleFields(sentence(say('push.version-title'))),
    ...bodyFields(body.text.length <= MESSAGE_MAX_CHARS ? sentence(body) : { text: clip(body.text) }),
    topic: topicFor('rarog:version-changed'),
    urgency: 'high',
    ttl: 24 * 60 * 60,
  };
}

/**
 * Push with the consent canary result of one Claude Code release (`consent-canary-push.ts`): the release and its
 * main-thread result only. Kind `version-changed`, so the app shows it like the version banner (also in the
 * foreground, a tap opens the "Server" screen); the collapse key is per release, so a newer result of the same
 * release takes the place of the older banner. Urgent, one day in APNs, no badge. The caller passes a release in the
 * canary file's shape (digits and dots), so the body fits the banner with its code.
 *
 * `rule` is the main-thread proof rule the version gate gives the release with this result (`consentProofRuleOf`),
 * so the body says what holds after the push: `fail` is always `screen`; `unmeasured` is `screen`, or `channel` on
 * a release the package measured (`.unmeasured-package`).
 */
export function buildConsentCanaryContent(
  release: string, result: ConsentCanaryResult, rule: ConsentProofRule,
): PushContent {
  let body: ServerSentence;
  if (result === 'pass') body = say('push.canary-body.pass', { version: release });
  else if (result === 'fail') body = say('push.canary-body.fail', { version: release });
  else if (rule === 'channel') body = say('push.canary-body.unmeasured-package', { version: release });
  else body = say('push.canary-body.unmeasured', { version: release });
  return {
    kind: 'version-changed',
    ...titleFields(sentence(say('push.canary-title'))),
    ...bodyFields(body.text.length <= MESSAGE_MAX_CHARS ? sentence(body) : { text: clip(body.text) }),
    topic: topicFor(`rarog:consent-canary:${release}`),
    urgency: 'high',
    ttl: 24 * 60 * 60,
  };
}

/** Longest life of a weekly limit banner in APNs: one day, as the other sessionless pushes. */
const WEEKLY_LIMIT_MAX_TTL_SECONDS = 24 * 60 * 60;

/**
 * Push `weekly-limit`: the weekly plan usage of one window reached the alert threshold. `percent` is the whole
 * percent the tile shows (0–100) and `resetsAt` the ISO reset instant of that window, which is also the collapse key,
 * so two accounts in one week give two banners. Urgent, no badge. The banner lives until the reset, at most one day,
 * because a banner about a window that already reset has nothing to say; at or after the reset there is no content.
 */
export function buildWeeklyLimitContent(percent: number, resetsAt: string, nowMs: number): PushContent | undefined {
  const resetMs = Date.parse(resetsAt);
  if (!(resetMs > nowMs)) return undefined;
  // Whole epoch seconds, like `apns-expiration` (floor of now + TTL): the expiration lands on the reset second, also
  // when the reset is under a second away.
  const left = Math.ceil(resetMs / 1000) - Math.floor(nowMs / 1000);
  return {
    kind: 'weekly-limit',
    ...titleFields(sentence(say('push.weekly-limit-title', { percent }))),
    ...bodyFields(sentence(say('push.weekly-limit-body', { reset: resetsAt }))),
    topic: topicFor(`rarog:weekly-limit:${resetsAt}`),
    urgency: 'high',
    ttl: Math.min(left, WEEKLY_LIMIT_MAX_TTL_SECONDS),
  };
}
