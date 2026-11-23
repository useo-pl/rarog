/**
 * Przepustki przekaźnika push — JEDYNE miejsce, które je zamawia, odnawia i zdejmuje.
 *
 * Przepustkę dostaje WYŁĄCZNIE wpis z tematem apki przekaźnika (`topic` = {@link RELAY_APP_TOPIC}, apka Rarog) przy
 * ustawionym `RAROG_PUSH_RELAY_URL`; wpis z innym tematem nigdy jej nie dostaje i idzie kluczem na Macu. Przepustka
 * wiąże się z originem przekaźnika, środowiskiem, tematem i tokenem (blok
 * aktywności: także z `activityId` i tokenem aktywności) — {@link usablePass}; przepustka innego przekaźnika to brak
 * przepustki, więc zmiana adresu przekaźnika zamawia nowe.
 *
 * Kiedy zamówienie:
 * - po odpowiedzi trasy rejestracji (`POST /api/push/apns`) i tokenu aktywności (`POST /api/push/live-activity`) —
 *   204 na nie nie czeka;
 * - przy starcie serwera dla każdego wpisu bez ważnej przepustki i co godzinę (odnowienie wpisów, które milczą);
 * - gdy do terminu zostaje mniej niż {@link RELAY_PASS_RENEW_BEFORE_MS} (7 dni); aktywne wpisy urządzeń dostają
 *   odnowienie wcześniej, w `renewedPass` z `/v1/push` ({@link RelayPasses.renewed});
 * - kafel (blok aktywności) zamawia się za ŚWIEŻĄ przepustką urządzenia, bo przekaźnik wydaje go najwyżej do jej
 *   terminu i nie odnawia w `/v1/push`; przy nieświeżej — tylko kafel bez żadnej używalnej przepustki, raz;
 * - po `401 pass-invalid` z `/v1/push`: TA przepustka znika (jeśli wpis wciąż ją ma) i idzie nowe zamówienie
 *   z odczekaniem ({@link RelayPasses.invalid}). Tokenu to nie kasuje.
 *
 * Zamówienia idą JEDNO NA RAZ w kolejce (limit `/v1/pass` to 10 na 60 s per adres), najwyżej jedno w kolejce albo
 * w locie na token i rodzaj. Porażka daje odczekanie per token ({@link RELAY_PASS_RETRY_MS}), a porażka całego
 * przekaźnika (`429`, `502`, sieć, sufit czasu) dodatkowo WSPÓLNE odczekanie kolejki; `503` czeka tyle, ile milczy
 * droga przekaźnika w tym środowisku (`relay-sender.ts`, 15 min).
 *
 * Zapis jest WARUNKOWY (`apns-devices.ts`): spóźniona odpowiedź nie odtwarza wpisu usuniętego w trakcie (odpięcie,
 * 410, wyrejestrowanie), nie trafia do wpisu z innym środowiskiem, tematem albo aktywnością i nie nadpisuje nowszej
 * przepustki. `422 token-rejected`: `BadDeviceToken` dla tokenu bez żadnego 200 to `env-mismatch` (wpis zostaje,
 * status mówi przyczynę); każdy inny martwy token (410, `DeviceTokenNotForTopic`) wypada jak `gone` w sinku — chyba że
 * apka zarejestrowała go od nowa w trakcie zamówienia albo po chwili unieważnienia z 410.
 *
 * **Log bez tokenów, przepustek i etykiet** — rodzaj, środowisko, kod. **Nigdy nie rzuca.**
 */
import type { ApnsEnvironment } from '@rarog/shared/rest';
import { RELAY_APP_TOPIC } from '@rarog/shared/relay';
import type { RelayIssuedPass } from '@rarog/shared/relay';
import type { ApnsDeviceRecord, ApnsDeviceStore, RelayPass } from './apns-devices.ts';
import { normalizeApnsToken } from './apns-devices.ts';
import type { RelayClient, RelayPassOutcome } from './relay-sender.ts';

/** Odnowienie, gdy do terminu przepustki zostaje mniej niż tyle (przekaźnik wydaje na 90 dni). */
export const RELAY_PASS_RENEW_BEFORE_MS = 7 * 24 * 60 * 60_000;
/** Co ile przegląd rejestru: odnowienia wpisów, które nie wysyłają, i wpisy, które zgubiły przepustkę. */
export const RELAY_PASS_SWEEP_MS = 60 * 60_000;
/** Odczekanie per token po kolejnych porażkach zamówienia (ostatnia wartość powtarza się). */
export const RELAY_PASS_RETRY_MS: readonly number[] = [30_000, 2 * 60_000, 10 * 60_000, 60 * 60_000];
/** Wspólne odczekanie po `429 relay-limited` — limit `/v1/pass` liczy okno 60 s. */
export const RELAY_PASS_LIMITED_MS = 60_000;
/** Ile push próbny („Włącz”) czeka na pierwszą przepustkę wpisu bez klucza (apka czeka 15 s na baner). */
export const TEST_PUSH_PASS_WAIT_MS = 10_000;
/**
 * Ile `POST /api/push/apns/status` czeka na zamówienie przepustki w toku, zanim policzy status:
 * apka czyta status RAZ po rejestracji, więc wynik zamówienia musi wejść do tej samej odpowiedzi. Sufit żądania
 * po stronie apki to 10 s.
 */
export const STATUS_PASS_WAIT_MS = 5_000;

/** Do czego musi pasować przepustka, żeby była przepustką tej wysyłki. */
export interface PassBinding {
  readonly origin: string;
  readonly environment: ApnsEnvironment;
  readonly topic: string;
  /** Token wysyłki (urządzenia albo aktywności). */
  readonly token: string;
}

/** Przepustka pasuje do przekaźnika, środowiska, tematu i tokenu i jeszcze nie wygasła. */
export function usablePass(pass: RelayPass | undefined, binding: PassBinding, nowMs: number): pass is RelayPass {
  return pass !== undefined && pass.origin === binding.origin && pass.environment === binding.environment
    && pass.topic === binding.topic && pass.token === normalizeApnsToken(binding.token)
    && Date.parse(pass.expiresAt) > nowMs;
}

/** Do terminu zostało mniej niż {@link RELAY_PASS_RENEW_BEFORE_MS}. */
export const passNeedsRenewal = (pass: Pick<RelayPass, 'expiresAt'>, nowMs: number): boolean =>
  Date.parse(pass.expiresAt) - nowMs < RELAY_PASS_RENEW_BEFORE_MS;

/**
 * Przepustka, z którą poszła jedna wysyłka (nadajnik złożony, `sender.ts`) — adres zapisu `renewedPass` i zdjęcia
 * po `401`. Pola przechwycone razem z rekordem, więc zapis jest warunkowy względem TEJ wysyłki.
 */
export type PassTarget =
  | {
    readonly kind: 'device'; readonly deviceToken: string; readonly environment: ApnsEnvironment;
    readonly topic: string; readonly pass: string;
  }
  | {
    readonly kind: 'activity'; readonly deviceToken: string; readonly activityId: string; readonly updateToken: string;
    readonly environment: ApnsEnvironment; readonly topic: string; readonly pass: string;
  };

export interface RelayPasses {
  /** Zamówienie, jeśli wpis go potrzebuje (urządzenie, potem aktywność). Nie czeka, nie rzuca. */
  ensure(deviceToken: string): void;
  /** Start serwera: zamówienia dla wpisów bez ważnej przepustki i przegląd co {@link RELAY_PASS_SWEEP_MS}. */
  start(): void;
  /** Zamawia przepustkę urządzenia, gdy trzeba, i czeka na zamówienie w toku (najwyżej `timeoutMs`). */
  waitForDevicePass(deviceToken: string, timeoutMs: number): Promise<void>;
  /**
   * Czeka WYŁĄCZNIE na zamówienie przepustki urządzenia, które już jest w toku (najwyżej `timeoutMs`), niczego nie
   * zamawiając — trasa statusu tokenu liczy status po jego rozstrzygnięciu ({@link STATUS_PASS_WAIT_MS}).
   */
  waitPending(deviceToken: string, timeoutMs: number): Promise<void>;
  /** Zamówienie przepustki urządzenia czeka w kolejce albo jest w locie. */
  pending(deviceToken: string): boolean;
  /** Od kiedy (ISO) zamówienia przepustki urządzenia padają; `null` = nie padły (albo przepustka jest). */
  missingSince(deviceToken: string): string | null;
  /** `renewedPass` z `/v1/push` — zapis warunkowy względem wysyłki, z którą przyszła. */
  renewed(target: PassTarget, issued: RelayIssuedPass): void;
  /** `401 pass-invalid` z `/v1/push`: zdjęcie TEJ przepustki i nowe zamówienie z odczekaniem. */
  invalid(target: PassTarget): void;
  close(): void;
}

export interface RelayPassesOptions {
  readonly devices: ApnsDeviceStore;
  readonly client: Pick<RelayClient, 'origin' | 'requestPass' | 'pausedUntil'>;
  /** Przepustka zapisana dla tego wpisu (urządzenia albo aktywności) — sterownik Live Activity ponawia wtedy od razu. */
  readonly onPass?: (deviceToken: string) => void;
  readonly now?: () => number;
  readonly setTimeout?: (cb: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
  readonly log?: (line: string) => void;
}

type Kind = 'device' | 'activity';

interface Job {
  readonly kind: Kind;
  readonly token: string;
}

/** Odczekanie po porażkach jednego zamówienia (token + rodzaj). */
interface Slot {
  failures: number;
  nextAt: number;
  /** Od kiedy zamówienia padają (ISO) — `missingSince`. */
  since: string;
  timer: unknown;
}

const keyOf = (kind: Kind, token: string): string => `${kind}:${token}`;

export function createRelayPasses(options: RelayPassesOptions): RelayPasses {
  const { devices, client, log } = options;
  const now = options.now ?? ((): number => Date.now());
  const iso = (): string => new Date(now()).toISOString();
  const setTimer = options.setTimeout
    ?? ((cb, ms): unknown => {
      const handle = setTimeout(cb, ms);
      // Ponowienie zamówienia nie może trzymać procesu przy zamykaniu serwera.
      handle.unref();
      return handle;
    });
  const clearTimer = options.clearTimeout ?? ((handle): void => { clearTimeout(handle as NodeJS.Timeout); });

  const slots = new Map<string, Slot>();
  const queue: Job[] = [];
  const queued = new Set<string>();
  const waiters = new Map<string, (() => void)[]>();
  let running: string | null = null;
  /** Wspólne odczekanie kolejki po porażce całego przekaźnika. */
  let queueNextAt = 0;
  /** Od kiedy (ISO) przekaźnik pada w całości — `missingSince` wpisów, które czekają za wspólnym odczekaniem. */
  let queueFailingSince: string | null = null;
  let queueTimer: unknown = null;
  let sweepTimer: unknown = null;
  let closed = false;

  const safeLog = (line: string): void => {
    try {
      log?.(line);
    } catch {
      // Log nie ma prawa wywrócić zamówienia.
    }
  };

  const bindingOf = (record: ApnsDeviceRecord, token: string): PassBinding =>
    ({ origin: client.origin, environment: record.environment, topic: record.topic, token });

  const fresh = (pass: RelayPass | undefined, binding: PassBinding): boolean =>
    usablePass(pass, binding, now()) && !passNeedsRenewal(pass, now());

  /** Wpis apki przekaźnika — obce tematy przepustek nie dostają. */
  const eligible = (record: ApnsDeviceRecord): boolean => record.topic === RELAY_APP_TOPIC;

  /** Odmowa `env-mismatch` tego przekaźnika w środowisku wpisu: zamówienie nic nie zmieni do nowej rejestracji. */
  const mismatched = (record: ApnsDeviceRecord): boolean =>
    record.relayMismatch?.origin === client.origin && record.relayMismatch.environment === record.environment;

  const needsDevice = (record: ApnsDeviceRecord): boolean =>
    eligible(record) && !mismatched(record) && !fresh(record.relayPass, bindingOf(record, record.token));

  /**
   * Kafel do zamówienia. Przekaźnik wydaje przepustkę kafla najwyżej do terminu przepustki urządzenia,
   * więc odnowienie kafla przy NIEŚWIEŻEJ przepustce urządzenia dostałoby ten sam krótki termin i zamawiało się
   * w kółko. Odnowienie kafla czeka więc na świeżą przepustkę urządzenia (po jej wydaniu z kolejki albo z
   * `renewedPass` pada `ensure` i kafel dogania od razu). Przy nieświeżej zamawia się tylko kafel bez żadnej używalnej
   * przepustki (nowy, zrotowany, po `401`) — jedno zamówienie, żeby żywy kafel nie milkł do odnowienia urządzenia.
   */
  const needsActivity = (record: ApnsDeviceRecord): boolean => {
    const la = record.liveActivity;
    if (!eligible(record) || la === undefined) return false;
    const device = bindingOf(record, record.token);
    if (!usablePass(record.relayPass, device, now())) return false;
    const tile = bindingOf(record, la.updateToken);
    if (fresh(la.relayPass, tile)) return false;
    return fresh(record.relayPass, device) || !usablePass(la.relayPass, tile, now());
  };

  const settle = (key: string): void => {
    const pendingWaiters = waiters.get(key);
    waiters.delete(key);
    for (const resolve of pendingWaiters ?? []) resolve();
  };

  const armQueue = (at: number): void => {
    if (queueTimer !== null) clearTimer(queueTimer);
    queueTimer = setTimer(() => {
      queueTimer = null;
      pump();
    }, Math.max(0, at - now()));
  };

  /** Ponowienie zamówienia po odczekaniu — przez `ensure`, bo wpis mógł się w międzyczasie zmienić. */
  const armSlot = (slot: Slot, token: string): void => {
    if (slot.timer !== null) clearTimer(slot.timer);
    slot.timer = setTimer(() => {
      slot.timer = null;
      ensure(token);
    }, Math.max(0, slot.nextAt - now()));
  };

  const clearSlot = (key: string): void => {
    const slot = slots.get(key);
    if (slot === undefined) return;
    if (slot.timer !== null) clearTimer(slot.timer);
    slots.delete(key);
  };

  /** Porażka zamówienia: następna próba po odczekaniu (najwcześniej `minAt`); zwraca opóźnienie w ms. */
  const fail = (kind: Kind, token: string, minAt = 0): number => {
    const key = keyOf(kind, token);
    const slot = slots.get(key) ?? { failures: 0, nextAt: 0, since: iso(), timer: null };
    slot.failures += 1;
    const ladder = RELAY_PASS_RETRY_MS[Math.min(slot.failures, RELAY_PASS_RETRY_MS.length) - 1] ?? 60 * 60_000;
    slot.nextAt = Math.max(now() + ladder, minAt);
    slots.set(key, slot);
    if (!closed) armSlot(slot, token);
    return slot.nextAt - now();
  };

  const enqueue = (kind: Kind, token: string): void => {
    const key = keyOf(kind, token);
    if (queued.has(key) || running === key) return;
    const slot = slots.get(key);
    if (slot !== undefined && slot.nextAt > now()) {
      if (slot.timer === null) armSlot(slot, token);
      return;
    }
    queue.push({ kind, token });
    queued.add(key);
    pump();
  };

  function ensure(deviceToken: string): void {
    if (closed) return;
    try {
      const record = devices.get(deviceToken);
      if (record === undefined) {
        // Wpis zniknął (odpięcie, 410, wyrejestrowanie): odczekania po nim nie ma czego pilnować.
        const token = normalizeApnsToken(deviceToken);
        clearSlot(keyOf('device', token));
        clearSlot(keyOf('activity', token));
        return;
      }
      // Obie mogą czekać naraz: kolejka idzie po kolei, a aktywność sprawdza przepustkę urządzenia przy starcie.
      if (needsDevice(record)) enqueue('device', record.token);
      if (needsActivity(record)) enqueue('activity', record.token);
    } catch {
      // Best-effort: rejestr i kolejka nie mają prawa wywrócić trasy ani timera.
    }
  }

  const seconds = (ms: number): string => String(Math.round(ms / 1000));

  /**
   * Odpowiedź nie trafiła do wpisu, który wciąż istnieje (zmiana w trakcie zamówienia): następne zamówienie po
   * odczekaniu. Zmieniony wpis zamówi się sam (`ensure` po rozstrzygnięciu), ale bez odczekania wpis zmieniany
   * w kółko mieliłby kolejkę bez końca.
   */
  const stale = (kind: Kind, token: string): void => {
    if (devices.get(token) !== undefined) fail(kind, token);
  };

  /** Wydana przepustka już wymaga odnowienia — następne zamówienie po odczekaniu, nie od razu. */
  const shortPass = (kind: Kind, token: string): void => {
    const delay = fail(kind, token);
    safeLog(`push: relay pass (${kind}) shorter than 7 days — renewal in ${seconds(delay)} s`);
  };

  /** Porażka po stronie przekaźnika albo sieci — wspólne odczekanie dla `429`, `502` i braku odpowiedzi. */
  const relayFailure = (job: Job, environment: ApnsEnvironment, outcome: Extract<RelayPassOutcome, { kind: 'failed' }>):
    void => {
    const { status, reason } = outcome;
    let minAt = 0;
    if (status === 429) queueNextAt = Math.max(queueNextAt, now() + RELAY_PASS_LIMITED_MS);
    if (status === 503) minAt = client.pausedUntil(environment);
    const delay = fail(job.kind, job.token, minAt);
    if (status === null || status === 502 || (status >= 500 && status !== 503)) {
      queueNextAt = Math.max(queueNextAt, now() + Math.min(delay, RELAY_PASS_RETRY_MS[1] ?? delay));
    }
    if (status === null || status === 429 || (status >= 500 && status !== 503)) queueFailingSince ??= iso();
    const what = status === null ? reason : `${String(status)} ${reason}`;
    safeLog(`push: relay pass (${job.kind}, ${environment}) failed (${what})`
      + ` — retry in ${seconds(delay)} s`);
  };

  const runDevice = async (job: Job, record: ApnsDeviceRecord, topic: string): Promise<void> => {
    const { environment, updatedAt } = record;
    const outcome = await client.requestPass({ token: record.token, environment, type: 'alert', topic });
    if (closed) return;
    switch (outcome.kind) {
      case 'issued': {
        clearSlot(keyOf('device', job.token));
        queueFailingSince = null;
        const written = devices.setRelayPass({
          pass: outcome.pass.pass, expiresAt: outcome.pass.expiresAt, origin: client.origin, environment, topic,
          token: record.token,
        });
        safeLog(written
          ? `push: relay pass issued (device, ${environment})`
          : 'push: relay pass after an entry change during the request — skipped');
        if (written) options.onPass?.(job.token);
        else stale('device', job.token);
        // Przepustka krótsza niż próg odnowienia (zegar Maca, konfiguracja przekaźnika) zamawiałaby się w kółko.
        if (written && passNeedsRenewal(outcome.pass, now())) shortPass('device', job.token);
        return;
      }
      case 'token-rejected': {
        clearSlot(keyOf('device', job.token));
        const current = devices.get(job.token);
        const what = `${String(outcome.apnsStatus)} ${outcome.reason}`;
        if (current === undefined) return;
        if (outcome.reason === 'BadDeviceToken' && current.lastOkAt === null) {
          // Token, który nigdy nie dostał 200: pomyłka środowiska, nie martwy token — wpis zostaje.
          if (devices.noteRelayMismatch(job.token, topic, { since: iso(), origin: client.origin, environment })) {
            safeLog(`push: relay pass refused (${what}) — env-mismatch, entry kept`);
          } else {
            stale('device', job.token);
          }
          return;
        }
        const reRegistered = current.updatedAt !== updatedAt
          || (outcome.timestamp !== undefined && Date.parse(current.updatedAt) > outcome.timestamp);
        if (reRegistered) {
          // Wpis zostaje, ale następne zamówienie dopiero po odczekaniu — inaczej kolejka mieliłaby ten token w kółko.
          const delay = fail('device', job.token);
          safeLog(`push: relay pass — token dead (${what}), but registered again — kept,`
            + ` retry in ${seconds(delay)} s`);
          return;
        }
        devices.remove(job.token);
        safeLog(`push: relay pass — token dead (${what}) — removed, ${String(devices.size)} left`);
        return;
      }
      case 'pass-invalid': {
        // `alert` nie niesie `devicePass` — taka odpowiedź jest poza kontraktem; zwykłe ponowienie.
        const delay = fail('device', job.token);
        safeLog(`push: relay pass (device, ${environment}) failed (401) — retry in `
          + `${seconds(delay)} s`);
        return;
      }
      case 'failed':
        relayFailure(job, environment, outcome);
        return;
    }
  };

  const runActivity = async (job: Job, record: ApnsDeviceRecord, topic: string): Promise<void> => {
    const la = record.liveActivity;
    const devicePass = record.relayPass?.pass;
    if (la === undefined || devicePass === undefined) return;
    const { environment } = record;
    const outcome = await client.requestPass({
      token: la.updateToken, environment, type: 'liveactivity', topic, devicePass,
    });
    if (closed) return;
    switch (outcome.kind) {
      case 'issued': {
        clearSlot(keyOf('activity', job.token));
        queueFailingSince = null;
        const written = devices.setActivityRelayPass(job.token, la.activityId, {
          pass: outcome.pass.pass, expiresAt: outcome.pass.expiresAt, origin: client.origin, environment, topic,
          token: la.updateToken,
        });
        safeLog(written
          ? `push: relay pass issued (activity, ${environment})`
          : 'push: activity pass after an activity change during the request — skipped');
        if (written) options.onPass?.(job.token);
        else stale('activity', job.token);
        if (written && passNeedsRenewal(outcome.pass, now())) {
          // Krótki termin z przepustki urządzenia: kafel odnowi się po niej (`needsActivity`), nie po odczekaniu.
          const current = devices.get(job.token);
          if (current !== undefined && needsActivity(current)) shortPass('activity', job.token);
          else safeLog('push: relay pass (activity) with the device pass expiry — renews after the device pass'
            + ' renews');
        }
        return;
      }
      case 'pass-invalid': {
        // Przekaźnik nie uznał przepustki URZĄDZENIA: zdjęta (jeśli wciąż ta), nowa po odczekaniu, potem aktywność.
        // Ta sama reguła co `invalid()`: odczekanie tylko przy faktycznym zdjęciu; inaczej wpis ma już nowszą
        // przepustkę urządzenia i aktywność zamówi się z nią po odczekaniu aktywności.
        if (!devices.dropRelayPass(job.token, devicePass)) {
          stale('activity', job.token);
          return;
        }
        const delay = fail('device', job.token);
        safeLog(`push: relay refused the device pass (401) — dropped, new request in ${seconds(delay)} s`);
        return;
      }
      case 'token-rejected':
        // Przepustka aktywności nie woła Apple — taka odpowiedź jest poza kontraktem; zwykłe ponowienie.
        relayFailure(job, environment, { kind: 'failed', status: 422, reason: 'token-rejected' });
        return;
      case 'failed':
        relayFailure(job, environment, outcome);
        return;
    }
  };

  const run = async (job: Job): Promise<void> => {
    const record = devices.get(job.token);
    if (record === undefined) return;
    const paused = client.pausedUntil(record.environment);
    if (paused > now()) {
      // Droga przekaźnika milczy w tym środowisku (503): bez liczenia porażki, po ciszy od nowa.
      const key = keyOf(job.kind, job.token);
      const slot = slots.get(key) ?? { failures: 0, nextAt: 0, since: iso(), timer: null };
      slot.nextAt = paused;
      slots.set(key, slot);
      armSlot(slot, job.token);
      return;
    }
    if (job.kind === 'device') {
      if (needsDevice(record)) await runDevice(job, record, record.topic);
    } else if (needsActivity(record)) {
      await runActivity(job, record, record.topic);
    }
  };

  function pump(): void {
    if (closed || running !== null) return;
    if (queueNextAt > now()) {
      armQueue(queueNextAt);
      return;
    }
    const job = queue.shift();
    if (job === undefined) return;
    const key = keyOf(job.kind, job.token);
    queued.delete(key);
    running = key;
    void run(job).catch(() => {
      // `run` nie rzuca; obrona przed regresją — kolejka nie może stanąć.
    }).finally(() => {
      running = null;
      settle(key);
      // Następny krok tego wpisu (po urządzeniu — aktywność) i reszta kolejki.
      ensure(job.token);
      pump();
    });
  }

  /** Zamówienie w locie albo w kolejce, która nie czeka za wspólnym odczekaniem (wtedy przekaźnik pada). */
  const pendingKey = (key: string): boolean => running === key || (queued.has(key) && queueNextAt <= now());

  /**
   * Czeka na rozstrzygnięcie zamówienia przepustki urządzenia, które JUŻ jest w toku (najwyżej `timeoutMs`); nic nie
   * zamawia. Bez zamówienia w toku — od razu.
   */
  const waitPending = (deviceToken: string, timeoutMs: number): Promise<void> => {
    const key = keyOf('device', normalizeApnsToken(deviceToken));
    if (closed || !pendingKey(key)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        resolve();
      };
      const timer = setTimer(finish, timeoutMs);
      const list = waiters.get(key) ?? [];
      list.push(() => {
        clearTimer(timer);
        finish();
      });
      waiters.set(key, list);
    });
  };

  const passOf = (target: PassTarget, issued: RelayIssuedPass): RelayPass => ({
    pass: issued.pass, expiresAt: issued.expiresAt, origin: client.origin, environment: target.environment,
    topic: target.topic, token: target.kind === 'device' ? target.deviceToken : target.updateToken,
  });

  return {
    ensure,

    start(): void {
      if (closed) return;
      for (const record of devices.list()) ensure(record.token);
      const sweep = (): void => {
        sweepTimer = setTimer(() => {
          for (const record of devices.list()) ensure(record.token);
          sweep();
        }, RELAY_PASS_SWEEP_MS);
      };
      if (sweepTimer === null) sweep();
    },

    waitForDevicePass(deviceToken: string, timeoutMs: number): Promise<void> {
      ensure(normalizeApnsToken(deviceToken));
      return waitPending(deviceToken, timeoutMs);
    },

    waitPending,

    pending(deviceToken: string): boolean {
      return pendingKey(keyOf('device', normalizeApnsToken(deviceToken)));
    },

    missingSince(deviceToken: string): string | null {
      const key = keyOf('device', normalizeApnsToken(deviceToken));
      const waiting = queued.has(key) && queueNextAt > now() ? queueFailingSince : null;
      return slots.get(key)?.since ?? waiting;
    },

    renewed(target: PassTarget, issued: RelayIssuedPass): void {
      try {
        const written = target.kind === 'device'
          ? devices.setRelayPass(passOf(target, issued))
          : devices.setActivityRelayPass(target.deviceToken, target.activityId, passOf(target, issued));
        if (written) {
          const token = normalizeApnsToken(target.deviceToken);
          clearSlot(keyOf(target.kind, token));
          safeLog(`push: relay pass renewed (${target.kind}, ${target.environment})`);
          // Świeża przepustka urządzenia: kafel, który na nią czekał (`needsActivity`), dogania teraz, nie z przeglądu.
          if (target.kind === 'device') ensure(token);
        }
      } catch {
        // Best-effort: odnowienie przyjdzie przy następnej wysyłce albo z przeglądu.
      }
    },

    invalid(target: PassTarget): void {
      if (closed) return;
      try {
        const token = normalizeApnsToken(target.deviceToken);
        const dropped = target.kind === 'device'
          ? devices.dropRelayPass(token, target.pass)
          : devices.dropActivityRelayPass(token, target.activityId, target.pass);
        /*
         * Odczekanie podbija WYŁĄCZNIE faktyczne zdjęcie: kilka wysyłek w locie z tą samą
         * przepustką dostaje kilka 401, a każde liczone jako porażka wydłużałoby odczekanie (30 s → 2 min → 10 min
         * → 1 h) bez ani jednego zamówienia. Powtórzone albo nieaktualne unieważnienie (przepustki już nie ma albo
         * wpis ma nowszą) nic nie zmienia.
         */
        if (!dropped) return;
        const delay = fail(target.kind, token);
        safeLog(`push: relay refused the pass (${target.kind}, 401) — dropped,`
          + ` new request in ${seconds(delay)} s`);
      } catch {
        // Best-effort.
      }
    },

    close(): void {
      closed = true;
      if (queueTimer !== null) clearTimer(queueTimer);
      if (sweepTimer !== null) clearTimer(sweepTimer);
      queueTimer = null;
      sweepTimer = null;
      for (const slot of slots.values()) if (slot.timer !== null) clearTimer(slot.timer);
      queue.length = 0;
      queued.clear();
      for (const key of [...waiters.keys()]) settle(key);
    },
  };
}
