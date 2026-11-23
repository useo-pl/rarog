/**
 * Sink APNs — KOMU wysłać baner apki natywnej, w JAKIM formacie i co znaczy odpowiedź.
 *
 * Nadajnik (`apns.ts`, `sender.ts`) zna protokół i drogę, rejestr (`apns-devices.ts`) zna urządzenia; ten moduł je
 * spina:
 *
 * - baner idzie do KAŻDEGO wpisu z `alerts: true` (zgoda systemowa) równolegle; wpis z `alerts:
 *   false` zostaje w rejestrze dla Live Activity, banerów do niego nie ma;
 * - `200` → `lastOkAt` i zerowanie degradacji tokenu; `gone` (`410`, `BadDeviceToken`,
 *   `DeviceTokenNotForTopic`) → wpis wypada, chyba że apka zarejestrowała token od nowa w trakcie
 *   wysyłki albo po chwili unieważnienia z `410`; porażka PRÓBY → licznik porażek tokenu. Porażka bez
 *   próby (środowisko wyłączone trwałym błędem klucza albo wstrzymane po `5xx`, wpis bez przepustki
 *   przekaźnika i bez klucza — `pass-missing`, przepustka odrzucona — `pass-invalid`; `NO_ATTEMPT_REASONS`
 *   w `sender.ts`) licznika nie rusza: degradację tokenu bez drogi mówi status z drogi wpisu
 *   (`PushSender.statusOf`);
 * - wynik to trójstan {@link SendOutcome}: `delivered`, gdy którekolwiek urządzenie dostało 200,
 *   `failed`, gdy były próby i żadna nie doszła, `no-receiver`, gdy nie było komu wysłać.
 *
 * **Format:** baner jest zawsze szyfrowany kluczem urządzenia, w formacie 3 (blok `rarog`). Wpis dostaje
 * baner wtedy i tylko wtedy, gdy flaga E2E jest włączona (`RAROG_PUSH_E2E`), ostatnia rejestracja wpisu niosła
 * `pushFormats` z 3 ({@link declaresPushFormat}), a `deviceId` wpisu ma AKTYWNY rekord w `devices.json` (z niego
 * `pushKey` i `kid`) — sam `kid` nie wystarcza, bo ma go każde sparowane urządzenie, także apka bez NSE. Inaczej wpis
 * jest POMIJANY z linią logu: bez próby i bez licznika porażek, nigdy z jawnym tekstem w zamian; wpis zostaje
 * w rejestrze (Live Activity deklaracji nie potrzebuje). Deklaracja bez 3 (np. sam format 2) to wpis bez banerów.
 * Przy `RAROG_PUSH_E2E=0` banerów nie ma wcale. Żądanie jest per wpis (własny nonce). Push próbny (`sendTo`)
 * i `device-paired` (`sendWhere`) idą tą samą regułą.
 *
 * **Tekst zastępczy:** wpis z deklaracją `locKeys` (`apns-devices.ts`) dostaje `aps.alert` jako klucze katalogu
 * apki, reszta — polski literał (`apns-payload.ts`). Deklaracja jest brana z tego samego rekordu, którym idzie wysyłka.
 *
 * **Odpięte urządzenia:** migawka aktywnych urządzeń (`activeDevices`) jest brana RAZ na wysyłkę i PRZED
 * `devices.list()` — `active()` magazynu robi przebieg wygasania, którego słuchacze synchronicznie kasują tokeny
 * odpiętych (`device-effects.ts`). Wpis bez aktywnego rekordu urządzenia (np. po nieudanym zapisie
 * `apns-devices.json` i restarcie) jest pomijany: bez próby i bez licznika porażek.
 *
 * `apns-topic` każdej wysyłki to temat WPISU ({@link apnsTopicOf}): token przyjmuje pushe tylko pod
 * tematem apki, która go zarejestrowała.
 *
 * Drogę wysyłki (przekaźnik z przepustką albo klucz na Macu) wybiera nadajnik złożony (`sender.ts`) z kontekstu,
 * który podaje TEN moduł: temat i przepustka wpisu przechwycone razem z rekordem. Ładunek od drogi nie zależy.
 *
 * Push PRÓBNY (`sendTo`) podbija `lastOkAt` przy 200 — to pierwsza dostawa, jaką apka w ogóle
 * dostaje, i realne 200 jak każde inne. Porażka próbnego licznika porażek nie rusza.
 *
 * **Ten moduł nigdy nie rzuca** i nigdy nie loguje tokenu, etykiety, klucza ani treści — tylko liczby i powody:
 * linia wysyłki mówi rodzaj, liczbę wysłanych banerów formatu 3 i liczbę pominiętych.
 */
import { APNS_RAROG_BLOCK_VERSION, apnsAlertRequestE2e, apnsSkips } from './apns-payload.ts';
import type { ApnsRequest } from './apns-payload.ts';
import type { ApnsResult } from './apns.ts';
import type { ApnsDeviceRecord, ApnsDeviceStore } from './apns-devices.ts';
import { apnsTopicOf, normalizeApnsToken } from './apns-devices.ts';
import type { PushContent, SendOutcome } from './content.ts';
import { createPushSealer } from './push-crypto.ts';
import type { DevicePushKey, PushSealer } from './push-crypto.ts';
import { attempted } from './sender.ts';
import type { PushSender, SendContext } from './sender.ts';

export interface ApnsSink {
  /** Baner do każdego wpisu z `alerts: true`; trójstan całej wysyłki. Nigdy nie rzuca. */
  send(content: PushContent): Promise<SendOutcome>;
  /**
   * Baner do wpisów z `alerts: true`, które przepuści `filter` — push `device-paired` idzie tylko
   * do tokenów aktywnych urządzeń innych niż nowe. Porażki liczą się jak przy {@link send}.
   */
  sendWhere(content: PushContent, filter: (record: ApnsDeviceRecord) => boolean): Promise<SendOutcome>;
  /** Push próbny do jednego tokenu (rejestracja z `test: true`). */
  sendTo(token: string, content: PushContent): Promise<SendOutcome>;
}

/** Migawka aktywnych urządzeń z parowania: `deviceId` → klucz push. */
export type ActivePushKeys = ReadonlyMap<string, DevicePushKey>;

export interface ApnsSinkOptions {
  readonly sender: Pick<PushSender, 'send'>;
  readonly devices: ApnsDeviceStore;
  /**
   * Aktywne urządzenia z `devices.json` w chwili wysyłki — wołana RAZ na wysyłkę, przed `devices.list()`
   * (`active()` magazynu odpala wygasanie i słuchaczy odpięcia).
   */
  readonly activeDevices: () => ActivePushKeys;
  /** Flaga `RAROG_PUSH_E2E`: `false` = żaden wpis nie dostaje banera szyfrowanego, więc banerów nie ma. */
  readonly e2e: boolean;
  /** Szyfrowanie kopert; brak = produkcyjne (losowy nonce). Podmiana wyłącznie w testach. */
  readonly sealer?: PushSealer;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

/** Trójstan z wyników pojedynczych prób: którekolwiek 200 → `delivered`, były próby → `failed`. */
function outcomeOf(results: readonly ApnsResult[]): SendOutcome {
  if (results.length === 0) return 'no-receiver';
  return results.some((r) => r.kind === 'ok') ? 'delivered' : 'failed';
}

/** Kontekst wysyłki do wpisu: temat i przepustka przechwycone razem z rekordem. */
const contextOf = (record: ApnsDeviceRecord): SendContext => ({
  topic: record.topic,
  ...(record.relayPass === undefined ? {} : { pass: record.relayPass }),
});

/**
 * Czy deklaracja wpisu (`pushFormats`) ma jedyny format, który serwer wysyła: 3. `false` = wpis bez
 * banerów (pominięty, nigdy jawny tekst).
 */
export function declaresPushFormat(declared: readonly number[] | undefined): boolean {
  return declared?.includes(APNS_RAROG_BLOCK_VERSION) === true;
}

/** Liczby jednej wysyłki do linii logu — bez treści, tokenów i etykiet. */
interface VariantCounts {
  v3: number;
  /**
   * Bez próby: wpis odpiętego urządzenia, `RAROG_PUSH_E2E=0`, wpis bez deklaracji 3, ładunek ponad sufit albo
   * nieudane szyfrowanie.
   */
  skipped: number;
}

export function createApnsSink(options: ApnsSinkOptions): ApnsSink {
  const { sender, devices, log, e2e } = options;
  /**
   * Migawka aktywnych urządzeń. Wyjątek magazynu kluczy (nie powinien się zdarzyć — słuchacze odpięcia nie rzucają)
   * to pusta migawka: każdy wpis jest wtedy pomijany, nigdy wysyłany bez sprawdzenia.
   */
  const activeDevices = (): ActivePushKeys => {
    try {
      return options.activeDevices();
    } catch {
      log?.('push: APNs active device snapshot failed — all entries skipped');
      return new Map();
    }
  };
  const sealer = options.sealer ?? createPushSealer();
  const now = options.now ?? ((): number => Date.now());

  /**
   * „Token martwy" opisuje rejestrację SPRZED tej odpowiedzi. Wpis zostaje,
   * gdy apka zarejestrowała token od nowa w trakcie wysyłki (inny `updatedAt` niż ten, z którym
   * wysyłka ruszyła) albo — przy `410` z `timestamp` — po chwili, w której APNs go unieważnił:
   * Apple każe wtedy wysyłać dalej. Inaczej spóźniona odpowiedź uciszałaby apkę do jej
   * następnego startu.
   */
  const staleGone = (sent: ApnsDeviceRecord, result: Extract<ApnsResult, { kind: 'gone' }>): boolean => {
    const current = devices.get(sent.token);
    if (current === undefined) return false;
    if (current.updatedAt !== sent.updatedAt) return true;
    return result.invalidSince !== undefined && Date.parse(current.updatedAt) > result.invalidSince;
  };

  /** Jedna wysyłka do jednego wpisu i jej skutek w rejestrze. Nigdy nie rzuca. */
  const deliver = async (
    record: ApnsDeviceRecord, request: ApnsRequest, countFailure: boolean,
  ): Promise<ApnsResult> => {
    let result: ApnsResult;
    try {
      result = await sender.send(record.environment, record.token, request, contextOf(record));
    } catch {
      result = { kind: 'failed', status: null, reason: 'no-code' };
    }
    if (result.kind === 'ok') {
      devices.noteDelivered(record.token);
    } else if (result.kind === 'gone') {
      if (staleGone(record, result)) {
        log?.(`push: APNs token dead (${String(result.status)} ${result.reason}), but registered`
          + ' again — kept');
      } else {
        devices.remove(record.token);
        log?.(`push: APNs token dead (${String(result.status)} ${result.reason}) — removed,`
          + ` ${String(devices.size)} left`);
      }
    } else if (countFailure && attempted(result)) {
      devices.noteFailed(record.token);
    }
    return result;
  };

  /**
   * Żądania jednej wysyłki: deklaracja ({@link declaresPushFormat}) i klucz z TEJ SAMEJ migawki aktywnych urządzeń
   * i tego samego rekordu, którym potem idzie wysyłka. `undefined` = wpis pominięty bez próby; jawnego zamiennika nie
   * ma.
   */
  const planner = (
    content: PushContent, active: ActivePushKeys, counts: VariantCounts,
  ): ((record: ApnsDeviceRecord) => ApnsRequest | undefined) => {
    const nowMs = now();
    const skip = (reason?: string): undefined => {
      counts.skipped += 1;
      if (reason !== undefined) log?.(`push: APNs ${reason} — entry skipped`);
      return undefined;
    };
    return (record: ApnsDeviceRecord): ApnsRequest | undefined => {
      // Token odpiętego urządzenia (odpięcie w dwóch plikach nie jest atomowe) — liczony w linii wysyłki.
      const key = active.get(record.deviceId);
      if (key === undefined) return skip();
      if (!e2e) return skip('RAROG_PUSH_E2E=0, no banner without encryption');
      if (!declaresPushFormat(record.pushFormats)) return skip('the app did not declare format 3');
      let request: ApnsRequest | undefined;
      try {
        request = apnsAlertRequestE2e(content, {
          topic: apnsTopicOf(record), nowMs, key, sealer, locKeys: record.locKeys === true,
        });
      } catch {
        request = undefined;
      }
      if (request === undefined) return skip('v3 payload over 4096 B or encryption failed');
      counts.v3 += 1;
      return request;
    };
  };

  /** Linia wysyłki: rodzaj, liczba banerów formatu 3 i pominiętych — nic z treści. */
  const logVariants = (content: PushContent, counts: VariantCounts): void => {
    log?.(`push: APNs ${content.kind} — v3: ${String(counts.v3)}`
      + `${counts.skipped === 0 ? '' : `, skipped: ${String(counts.skipped)}`}`);
  };

  const sendWhere = async (
    content: PushContent, filter: (record: ApnsDeviceRecord) => boolean,
  ): Promise<SendOutcome> => {
    // „Skończył" bez liczby na plakietkę nie ma czego nieść (apns-payload.ts, `apnsSkips`).
    if (apnsSkips(content)) return 'no-receiver';
    // Migawka PRZED listą: przebieg wygasania w `active()` kasuje tokeny odpiętych, zanim lista je zobaczy.
    const active = activeDevices();
    const targets = devices.list().filter((record) => record.alerts && filter(record));
    if (targets.length === 0) return 'no-receiver';
    const counts: VariantCounts = { v3: 0, skipped: 0 };
    const requestFor = planner(content, active, counts);
    const planned = targets.flatMap((record) => {
      const request = requestFor(record);
      return request === undefined ? [] : [{ record, request }];
    });
    logVariants(content, counts);
    const results = await Promise.all(planned.map(({ record, request }) => deliver(record, request, true)));
    return outcomeOf(results);
  };

  return {
    send: (content: PushContent): Promise<SendOutcome> => sendWhere(content, () => true),
    sendWhere,
    async sendTo(token: string, content: PushContent): Promise<SendOutcome> {
      const active = activeDevices();
      const record = devices.get(normalizeApnsToken(token));
      if (record === undefined) return 'no-receiver';
      const counts: VariantCounts = { v3: 0, skipped: 0 };
      const request = planner(content, active, counts)(record);
      logVariants(content, counts);
      if (request === undefined) return 'no-receiver';
      return outcomeOf([await deliver(record, request, false)]);
    },
  };
}
