/**
 * Push routes of the native app: presence beacon (`/api/presence`), APNs device token (`/api/push/apns`, its status
 * and unregistration) and the Live Activity token (`/api/push/live-activity`, `…/end`). Without an APNs channel the
 * routes stay: `status` says `enabled: false`, the rest is a 204 no-op.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { presenceBodySchema } from '@rarog/shared';
import {
  APNS_DEVICE_UNKNOWN_ERROR, APNS_TOPIC_MISMATCH_ERROR, DEVICE_REQUIRED_ERROR, apnsRegisterBodySchema,
  apnsStatusBodySchema, apnsUnregisterBodySchema, liveActivityEndBodySchema, liveActivityRegisterBodySchema,
} from '@rarog/shared/rest';
import type { ApnsStatusResponse } from '@rarog/shared/rest';
import { say } from '@rarog/shared/sentences';
import { redact } from '../auth/index.ts';
import { normalizeApnsToken } from '../notify/apns-devices.ts';
import { buildTestContent } from '../notify/content.ts';
import { STATUS_PASS_WAIT_MS, TEST_PUSH_PASS_WAIT_MS } from '../notify/relay-pass.ts';
import { methodNotAllowed, readValidatedBody, sendError, sendJson, sendNoContent } from '../router.ts';
import type { RouteContext, RouteRequest } from './context.ts';

/**
 * Jeden push próbny na token urządzenia na minutę.
 *
 * Push próbny jest JEDYNĄ wysyłką, którą klient może wywołać na żądanie, więc jest też
 * jedynym miejscem, gdzie tap w kółko zamieniłby się w serię żądań do APNs pod naszym
 * kluczem (a Apple liczy nadużycia per nadawca). Minuta wystarcza, żeby baner zdążył
 * się pokazać, i jest krótsza niż cierpliwość przy ponownej próbie na innym urządzeniu.
 */
export const PUSH_TEST_COOLDOWN_MS = 60_000;

export interface TestCooldown {
  /** `true` = wolno wysłać (i chwila została zapisana); `false` = poprzednia była < minutę temu. */
  allow(key: string): boolean;
}

export function createTestCooldown(now: () => number, windowMs = PUSH_TEST_COOLDOWN_MS): TestCooldown {
  const lastAt = new Map<string, number>();
  return {
    allow(key: string): boolean {
      const at = now();
      // Wygasłe wpisy wypadają przy każdym użyciu — mapa nie ma prawa rosnąć z każdym
      // tokenem, który kiedykolwiek poprosił o próbę.
      for (const [seenKey, seenAt] of lastAt) {
        if (at - seenAt >= windowMs) lastAt.delete(seenKey);
      }
      const previous = lastAt.get(key);
      if (previous !== undefined && at - previous < windowMs) return false;
      lastAt.set(key, at);
      return true;
    },
  };
}

export async function routePush(
  ctx: RouteContext, req: IncomingMessage, res: ServerResponse, rq: RouteRequest,
): Promise<boolean> {
  const { method, pathname, owner } = rq;
  const { config, presence, apns, apnsTestCooldown, log, secrets } = ctx;

  /*
   * POST /api/presence — „patrzę w Raroga" / „już nie patrzę".
   *
   * Bramka powiadomień i jedyny powód, dla którego pushe przeprowadziły się z hooków do
   * Raroga. Hook liczył obecność z `atime` tty i uznawał pracę w PWA na telefonie za
   * NIEOBECNOŚĆ — tutaj obecność jest deklarowana wprost, a serwer i tak wymaga jej
   * potwierdzania (TTL 40 s), bo uśpiona apka na iOS potrafi zostawić żywe gniazdo.
   *
   * 204: skutek jest natychmiastowy, w całości w RAM-ie serwera i klient nie ma z odpowiedzi
   * czego przeczytać. Brak kanału powiadomień (`presence === undefined`: nie ma kompletu
   * `RAROG_APNS_*` albo `RAROG_PUSH=0`) też daje 204 — beacon jest wtedy no-opem, a nie
   * błędem, bo apka nie ma powodu wiedzieć, czy Rarog akurat pushuje.
   */
  if (pathname === '/api/presence') {
    if (method !== 'POST') return methodNotAllowed(res, 'POST');
    const body = await readValidatedBody(req, res, config, presenceBodySchema);
    if (body === null) return true;
    presence?.note(body.clientId, {
      visible: body.visible,
      ...(body.sessionId === undefined ? {} : { sessionId: body.sessionId }),
    });
    sendNoContent(res);
    return true;
  }

  /*
   * APNs apki natywnej — apka rejestruje SWÓJ token urządzenia.
   *
   * Trzy trasy, wszystkie POST za poświadczeniem i bramką Origin. Bez kanału APNs (`apns === undefined`)
   * ciało przechodzi schemat (400 przy złym), `status` mówi `enabled: false`, reszta to 204
   * no-op — nigdy 404. Token
   * urządzenia to ADRES do wysyłki: nie trafia do logu ani do odpowiedzi, a status idzie
   * POST-em, żeby token nie stał w query (logi Caddy notują ścieżkę z zapytaniem). Etykieta
   * urządzenia też nie trafia do logu — tylko liczby.
   */
  if (pathname === '/api/push/apns/status') {
    if (method !== 'POST') return methodNotAllowed(res, 'POST');
    const body = await readValidatedBody(req, res, config, apnsStatusBodySchema);
    if (body === null) return true;
    if (apns === undefined) {
      sendJson(res, 200, {
        enabled: false, registered: false, alerts: false, degradedSince: null,
      } satisfies ApnsStatusResponse);
      return true;
    }
    /*
     * Zamówienie przepustki w toku (zaraz po rejestracji): status czeka na jego rozstrzygnięcie najwyżej
     * `STATUS_PASS_WAIT_MS`, bo apka czyta status RAZ po rejestracji — porażka zamówienia musi wejść do tej
     * odpowiedzi, a nie czekać na następny powrót z tła. Bez zamówienia w toku — od razu.
     */
    await apns.sender.awaitPending(body.token, STATUS_PASS_WAIT_MS);
    const record = apns.devices.get(body.token);
    /*
     * Degradacja PER TOKEN z DROGI tego wpisu (`PushSender.statusOf`): trzy porażki prób z rzędu do TEGO
     * urządzenia, środowisko klucza albo przekaźnika wyłączone (wtedy nie dojdzie nic, choć licznik tokenu
     * stoi), wpis bez drogi (`pass-missing`) albo odmowa przepustki `env-mismatch` — apka pokazuje baner
     * degradacji, a z `degradedReason` zdanie z przyczyną.
     */
    sendJson(res, 200, {
      enabled: true,
      registered: record !== undefined,
      alerts: record?.alerts ?? false,
      ...(record === undefined ? { degradedSince: null } : apns.sender.statusOf(record)),
    } satisfies ApnsStatusResponse);
    return true;
  }

  if (pathname === '/api/push/apns') {
    if (method !== 'POST') return methodNotAllowed(res, 'POST');
    const body = await readValidatedBody(req, res, config, apnsRegisterBodySchema);
    if (body === null) return true;
    if (apns === undefined) {
      sendNoContent(res);
      return true;
    }
    /*
     * Token należy do urządzenia z parowania: banery idą wyłącznie szyfrowane jego kluczem push,
     * a odpięcie kasuje jego tokeny. Za bramką klient jest zawsze urządzeniem; 403 to zabezpieczenie typu.
     */
    if (owner === undefined) {
      log.info('push: APNs registration refused — no device key');
      sendError(res, 403, DEVICE_REQUIRED_ERROR, say('rest.device-required'));
      return true;
    }
    /*
     * Temat apki: token przyjmuje pushe tylko pod tematem SWOJEJ apki, a serwer obsługuje jeden —
     * inny temat (także brak pola) to wpis, który skończyłby się `DeviceTokenNotForTopic`,
     * więc odmowa PRZED zapisem.
     */
    if (body.topic !== apns.topic) {
      log.info(`push: APNs registration refused — app topic ${body.topic ?? '(none)'} ≠ server topic ${apns.topic}`);
      sendError(res, 400, APNS_TOPIC_MISMATCH_ERROR,
        say('rest.apns-topic-mismatch'));
      return true;
    }
    apns.devices.upsert({
      token: body.token, environment: body.environment, label: body.label, alerts: body.alerts,
      // Token zarejestrowany kluczem urządzenia należy do niego: odpięcie go skasuje.
      deviceId: owner,
      topic: body.topic,
      // Deklaracja formatów z TEJ rejestracji: brak pola = brak deklaracji, wpis bez banerów.
      ...(body.pushFormats === undefined ? {} : { pushFormats: body.pushFormats }),
      // Tak samo klucze lokalizacji: brak pola albo `false` = wpis bez deklaracji, tekst zastępczy literałem.
      locKeys: body.locKeys === true,
    });
    log.info(`push: APNs device saved (devices: ${String(apns.devices.size)})`);
    let testPush = false;
    if (body.test === true && !body.alerts) {
      // Bez zgody systemowej baner i tak by się nie pokazał — próba byłaby szumem, a dławik
      // nie ma czego liczyć.
      log.info('push: APNs test push skipped (device without notification permission)');
    } else if (body.test === true) {
      // Upsert JUŻ się stał — 429 dotyczy wyłącznie pusha próbnego: drugi tap w „Włącz" nie może
      // zostawić urządzenia bez rejestracji tylko dlatego, że pierwszy był minutę temu.
      if (!apnsTestCooldown.allow(normalizeApnsToken(body.token))) {
        sendError(res, 429, 'too-many-requests', say('rest.push-test-cooldown'));
        apns.passes?.ensure(body.token);
        return true;
      }
      testPush = true;
    }
    sendNoContent(res);
    // Po odpowiedzi: zamówienie przepustki przekaźnika, gdy wpis jej potrzebuje — 204 na nie nie czeka.
    apns.passes?.ensure(body.token);
    if (testPush) {
      /*
       * Bez `await`: nadajnik APNs ma 10 s sufitu, a wynik idzie do logu i NIGDZIE INDZIEJ.
       * 204 NIE znaczy „doręczone" — apka pokazuje „Powiadomienia działają" dopiero, gdy push
       * próbny (`rarog.kind = 'test'`) do niej DOTRZE. Wpis bez drogi (bez przepustki i bez
       * klucza; `production` przy przekaźniku kluczem nie idzie) czeka najpierw na zamówienie
       * przepustki najwyżej `TEST_PUSH_PASS_WAIT_MS` (apka czeka na baner 15 s); bez niej push próbny kończy
       * się `pass-missing`, a status mówi przyczynę.
       */
      void apns.sender.awaitRoute(body.token, TEST_PUSH_PASS_WAIT_MS).then(async (route) => {
        if (route === 'none') {
          log.info('push: APNs test push → pass-missing (entry without a push relay pass and without a key route)');
          return;
        }
        const outcome = await apns.sink.sendTo(body.token, buildTestContent());
        log.info(`push: APNs test push → ${outcome}`);
      }).catch((err: unknown) => { log.error(`push: APNs test push failed: ${redact(err, secrets)}`); });
    }
    return true;
  }

  if (pathname === '/api/push/apns/unregister') {
    if (method !== 'POST') return methodNotAllowed(res, 'POST');
    const body = await readValidatedBody(req, res, config, apnsUnregisterBodySchema);
    if (body === null) return true;
    // Nieznany token też daje 204: wylogowanie ma być idempotentne.
    if (apns !== undefined) {
      // Wylogowanie kończy też Live Activity urządzenia — `end` idzie, póki token aktywności jest znany.
      apns.liveActivity.forgetDevice(body.token);
      const removed = apns.devices.remove(body.token);
      log.info(removed
        ? `push: APNs device unregistered (remaining: ${String(apns.devices.size)})`
        : 'push: APNs unregister of an unknown token — nothing to do');
    }
    sendNoContent(res);
    return true;
  }

  /*
   * Live Activity apki natywnej — token aktualizacji zbiorczej aktywności urządzenia.
   *
   * Bez kanału APNs: ciało przechodzi schemat (400 przy złym), odpowiedź to 204 no-op, nigdy 404.
   * Z kanałem: token aktywności wymaga ZAREJESTROWANEGO tokenu urządzenia (środowisko APNs bierze
   * się z jego wpisu) — inaczej 409 `apns-device-unknown`, żeby apka zarejestrowała urządzenie
   * i ponowiła, zamiast żyć z aktywnością, której serwer nigdy nie zaktualizuje. Nowa aktywność
   * dostaje stan serwera od razu (sterownik). Tokenów i `activityId` w logu nie ma.
   */
  if (pathname === '/api/push/live-activity') {
    if (method !== 'POST') return methodNotAllowed(res, 'POST');
    const body = await readValidatedBody(req, res, config, liveActivityRegisterBodySchema);
    if (body === null) return true;
    if (apns !== undefined) {
      const result = apns.liveActivity.register(body.deviceToken, {
        activityId: body.activityId, updateToken: body.updateToken,
      });
      if (result === 'unknown-device') {
        sendError(res, 409, APNS_DEVICE_UNKNOWN_ERROR,
          say('rest.apns-device-unknown'));
        return true;
      }
    }
    sendNoContent(res);
    // Po odpowiedzi: przepustka aktywności dla nowego albo zrotowanego tokenu aktywności.
    apns?.passes?.ensure(body.deviceToken);
    return true;
  }

  /*
   * Apka zakończyła aktywność (wylogowanie). `activityId` jest wymagany: spóźnione „zakończ" STAREJ
   * aktywności nie zamyka nowej — niezgodny id to 204 bez skutku.
   */
  if (pathname === '/api/push/live-activity/end') {
    if (method !== 'POST') return methodNotAllowed(res, 'POST');
    const body = await readValidatedBody(req, res, config, liveActivityEndBodySchema);
    if (body === null) return true;
    if (apns !== undefined && !apns.liveActivity.end(body.deviceToken, body.activityId)) {
      log.info('live-activity: end from the app for an activity the server does not know — no effect');
    }
    sendNoContent(res);
    return true;
  }

  return false;
}
