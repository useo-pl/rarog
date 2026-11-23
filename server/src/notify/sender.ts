/**
 * Nadajnik push złożony per WYSYŁKA — JEDYNE miejsce, które rozstrzyga, którą drogą idzie jedna wysyłka.
 *
 * Dwie drogi:
 * - **przekaźnik** (`relay-sender.ts`, `RAROG_PUSH_RELAY_URL`) — gdy wysyłka niesie WAŻNĄ przepustkę wpisu albo
 *   bloku aktywności (`usablePass`: ten przekaźnik, to środowisko, ten temat, ten token, przed terminem);
 * - **klucz na Macu** (`apns.ts`, komplet `RAROG_APNS_*`) — gdy przepustki nie ma, a klucz jest. Przy
 *   skonfigurowanym przekaźniku TYLKO dla `development`: `production` bez przepustki czeka na nią.
 * Bez żadnej: brak próby z powodem `pass-missing` (sink liczy go jak `disabled`/`paused`, licznik porażek stoi).
 *
 * Kontekst daje WOŁAJĄCY ({@link SendContext}): sink i Live Activity podają przepustkę przechwyconą RAZEM z rekordem,
 * bo koniec aktywności czyści blok PRZED wysyłką `end` (`live-activity.ts`) — odczyt rejestru w chwili wysyłki by
 * jej nie znalazł. Wysyłka bez tematu w kontekście nigdy nie idzie przekaźnikiem.
 *
 * Wybór per wysyłka, nie per serwer: u właściciela build z TestFlight (produkcja) musi iść przekaźnikiem, a build
 * z kabla (sandbox) może iść jego kluczem — wybór per serwer wysłałby produkcję kluczem, a `403
 * BadEnvironmentKeyIdInToken` wyłącza środowisko klucza do restartu (`apns.ts`). Dlatego przy przekaźniku wpis
 * `production` bez przepustki (baner i kafel) nie ma drogi (`none`): push próbny czeka na zamówienie przepustki
 * (`awaitRoute`), a nie próbuje kluczem, który działa tylko w Sandbox (`docs/server-config.md`).
 *
 * Tu mieszka też status tokenu dla `POST /api/push/apns/status` ({@link PushSender.statusOf}): degradacja z DROGI tego
 * wpisu (wyłączone środowisko klucza albo przekaźnika, nie „środowisko serwera”) i przyczyna `pass-missing`
 * albo `env-mismatch` razem z `degradedSince` — starsza apka bez pola przyczyny pokazuje wtedy zwykły baner.
 *
 * Puste `RAROG_PUSH_RELAY_URL` = nadajnik bez przekaźnika: przepustki w rejestrze leżą martwe, wszystko idzie kluczem.
 */
import type { ApnsDegradedReason, ApnsEnvironment } from '@rarog/shared/rest';
import type { ApnsConfig } from '../config.ts';
import { createApnsSender } from './apns.ts';
import type { ApnsResult, ApnsSender, ApnsSenderOptions } from './apns.ts';
import type { ApnsRequest } from './apns-payload.ts';
import type { ApnsDeviceRecord, ApnsDeviceStore, RelayPass } from './apns-devices.ts';
import { normalizeApnsToken } from './apns-devices.ts';
import { usablePass } from './relay-pass.ts';
import type { PassTarget, RelayPasses } from './relay-pass.ts';
import type { RelayClient } from './relay-sender.ts';

/**
 * Porażki BEZ próby: środowisko klucza wyłączone albo wstrzymane, wpis bez drogi (`pass-missing`), przepustka
 * odrzucona przez przekaźnik (`pass-invalid`, nowa jest zamawiana). Licznik porażek tokenu ich nie widzi.
 */
export const NO_ATTEMPT_REASONS: ReadonlySet<string> = new Set(['disabled', 'paused', 'pass-missing', 'pass-invalid']);

/** Porażka bez próby: nie ma czym wysłać (brak przepustki i klucza). */
export const PASS_MISSING: ApnsResult = { kind: 'failed', status: null, reason: 'pass-missing' };

/** Wynik bez próby ({@link NO_ATTEMPT_REASONS}) — sink nie podbija licznika porażek tokenu. */
export const attempted = (result: ApnsResult): boolean =>
  !(result.kind === 'failed' && result.status === null && NO_ATTEMPT_REASONS.has(result.reason));

/** Którą drogą wysłałby teraz wpis: przekaźnik, klucz na Macu albo żadna. */
export type PushRoute = 'relay' | 'direct' | 'none';

/**
 * Kontekst JEDNEJ wysyłki od wołającego — przechwycony razem z rekordem, nie czytany w chwili wysyłki.
 */
export interface SendContext {
  /** Temat wpisu urządzenia (`record.topic`); brak = wysyłka, która NIGDY nie idzie przekaźnikiem. */
  readonly topic?: string;
  /** Przepustka wpisu (baner) albo bloku aktywności (Live Activity). */
  readonly pass?: RelayPass;
  /** Wysyłka do aktywności: token URZĄDZENIA wpisu i id aktywności (zapis `renewedPass`, zdjęcie po `401`). */
  readonly activity?: { readonly deviceToken: string; readonly activityId: string };
}

/** Status tokenu z drogi jego wpisu — pola `degradedSince` i `degradedReason` odpowiedzi statusu. */
export interface ApnsTokenStatus {
  readonly degradedSince: string | null;
  readonly degradedReason?: ApnsDegradedReason;
}

export interface PushSender {
  /** Jedna wysyłka do jednego tokenu, drogą z kontekstu. Nigdy nie rzuca. */
  send(environment: ApnsEnvironment, token: string, request: ApnsRequest, context?: SendContext): Promise<ApnsResult>;
  /** Droga banera do tego wpisu teraz. */
  routeOf(record: ApnsDeviceRecord): PushRoute;
  /** Status tokenu dla `POST /api/push/apns/status`. */
  statusOf(record: ApnsDeviceRecord): ApnsTokenStatus;
  /**
   * Push próbny: wpis bez drogi (także `production` bez przepustki przy przekaźniku) czeka na zamówienie przepustki
   * najwyżej `timeoutMs`, potem oddaje drogę (`none` = wysyłka skończyłaby się `pass-missing`). Wpis z drogą — od razu.
   */
  awaitRoute(token: string, timeoutMs: number): Promise<PushRoute>;
  /**
   * Status tokenu: czeka na zamówienie przepustki, które JUŻ jest w toku, najwyżej `timeoutMs` (nic nie zamawia),
   * żeby wynik zamówienia — `pass-missing`, `env-mismatch` — wszedł do odpowiedzi statusu, którą apka czyta raz po
   * rejestracji. Bez zamówienia w toku albo bez przekaźnika — od razu.
   */
  awaitPending(token: string, timeoutMs: number): Promise<void>;
  /** Zamyka połączenia nadajnika bezpośredniego (graceful shutdown). */
  close(): void;
}

export interface SenderDeps {
  readonly log: (line: string) => void;
  /** Rejestr — droga i status wpisu, czekanie pushu próbnego. */
  readonly devices: Pick<ApnsDeviceStore, 'get'>;
  /** Klient przekaźnika (`RAROG_PUSH_RELAY_URL`); brak = sama droga klucza. */
  readonly relay?: Pick<RelayClient, 'origin' | 'push' | 'unavailableSince'>;
  /** Przepustki (późne wiązanie: powstają po nadajniku); brak = bez przekaźnika. */
  readonly passes?: () => Pick<
    RelayPasses, 'pending' | 'missingSince' | 'renewed' | 'invalid' | 'waitForDevicePass' | 'waitPending'
  > | undefined;
  /** Fabryka nadajnika bezpośredniego; podmiana wyłącznie w testach (atrapa bez sieci). */
  readonly direct?: (options: ApnsSenderOptions) => ApnsSender;
  readonly now?: () => number;
}

/**
 * Nadajnik dla kanału APNs: klucz z konfiguracji (gdy jest) i przekaźnik (gdy jest). Bramka kanału (`pushEnabled`,
 * klucz ALBO przekaźnik) zostaje w `apns-channel.ts`; fabryka niczego nie sprawdza drugi raz.
 */
export function createSender(config: { readonly apns?: ApnsConfig }, deps: SenderDeps): PushSender {
  const { apns } = config;
  const { devices, relay, log } = deps;
  const now = deps.now ?? ((): number => Date.now());
  const direct = apns === undefined
    ? undefined
    : (deps.direct ?? createApnsSender)({ privateKey: apns.privateKey, keyId: apns.keyId, teamId: apns.teamId, log });
  const passes = (): ReturnType<NonNullable<SenderDeps['passes']>> => deps.passes?.();

  /** Przepustka z kontekstu, jeśli pasuje do tej wysyłki. */
  const passFor = (environment: ApnsEnvironment, token: string, context: SendContext | undefined):
    RelayPass | undefined => {
    if (relay === undefined || context?.topic === undefined) return undefined;
    const binding = { origin: relay.origin, environment, topic: context.topic, token };
    return usablePass(context.pass, binding, now()) ? context.pass : undefined;
  };

  /**
   * Klucz na Macu dla wysyłki w tym środowisku: przy skonfigurowanym przekaźniku `production` idzie WYŁĄCZNIE nim
   * dla wpisu urządzenia i dla kafla. Serwer bez przekaźnika — klucz dla obu środowisk.
   */
  const directFor = (environment: ApnsEnvironment): ApnsSender | undefined =>
    (relay !== undefined && environment === 'production' ? undefined : direct);

  const targetOf = (
    environment: ApnsEnvironment, token: string, context: SendContext, pass: RelayPass,
  ): PassTarget => (context.activity === undefined
    ? { kind: 'device', deviceToken: token, environment, topic: pass.topic, pass: pass.pass }
    : {
      kind: 'activity', deviceToken: normalizeApnsToken(context.activity.deviceToken),
      activityId: context.activity.activityId, updateToken: token, environment, topic: pass.topic, pass: pass.pass,
    });

  const routeOf = (record: ApnsDeviceRecord): PushRoute => {
    const context: SendContext = {
      topic: record.topic,
      ...(record.relayPass === undefined ? {} : { pass: record.relayPass }),
    };
    if (passFor(record.environment, record.token, context) !== undefined) return 'relay';
    return directFor(record.environment) === undefined ? 'none' : 'direct';
  };

  return {
    async send(environment, token, request, context): Promise<ApnsResult> {
      const normalized = normalizeApnsToken(token);
      const pass = passFor(environment, normalized, context);
      if (relay !== undefined && pass !== undefined && context !== undefined) {
        let outcome;
        try {
          outcome = await relay.push({ pass: pass.pass, token: normalized, environment, request });
        } catch {
          return { kind: 'failed', status: null, reason: 'no-code' };
        }
        const target = targetOf(environment, normalized, context, pass);
        if (outcome.renewedPass !== undefined) passes()?.renewed(target, outcome.renewedPass);
        if (outcome.passInvalid === true) passes()?.invalid(target);
        return outcome.result;
      }
      const viaKey = directFor(environment);
      if (viaKey !== undefined) return viaKey.send(environment, token, request);
      return PASS_MISSING;
    },

    routeOf,

    statusOf(record): ApnsTokenStatus {
      const mismatch = record.relayMismatch;
      if (relay !== undefined && mismatch !== undefined && mismatch.origin === relay.origin
        && mismatch.environment === record.environment) {
        return { degradedSince: record.degradedSince ?? mismatch.since, degradedReason: 'env-mismatch' };
      }
      const route = routeOf(record);
      if (route === 'none') {
        // Zamówienie w toku (zaraz po rejestracji): jeszcze nie degradacja — status przeczytany chwilę później powie.
        if (passes()?.pending(record.token) === true) return { degradedSince: record.degradedSince };
        return {
          degradedSince: record.degradedSince ?? passes()?.missingSince(record.token) ?? record.createdAt,
          degradedReason: 'pass-missing',
        };
      }
      const disabled = route === 'relay'
        ? relay?.unavailableSince(record.environment) ?? null
        : direct?.disabledSince(record.environment) ?? null;
      return { degradedSince: record.degradedSince ?? disabled };
    },

    async awaitRoute(token, timeoutMs): Promise<PushRoute> {
      const record = devices.get(token);
      if (record === undefined) return 'none';
      const route = routeOf(record);
      const waiting = passes();
      if (route !== 'none' || waiting === undefined) return route;
      await waiting.waitForDevicePass(record.token, timeoutMs);
      const after = devices.get(token);
      return after === undefined ? 'none' : routeOf(after);
    },

    async awaitPending(token, timeoutMs): Promise<void> {
      await passes()?.waitPending(token, timeoutMs);
    },

    close(): void {
      direct?.close();
    },
  };
}
