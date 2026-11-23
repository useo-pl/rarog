/**
 * Rejestr urządzeń APNs apki natywnej — tokeny, na które Rarog ma prawo wysyłać.
 *
 * Wpis to hex-token urządzenia i środowisko (`development` = sandbox APNs). Token to ADRES do
 * wysyłki: z kluczem APNs pozwala wysłać baner na urządzenie, nie pozwala niczego przeczytać —
 * stąd `0o600` w `dataDir`, zero tokenów i etykiet w logu i runbook „utrata telefonu"
 * (`rm apns-devices.json` + restart).
 *
 * Zapis: tmp+rename, łańcuch zapisów, „zepsuty plik = pusty stan, NIGDY wyjątek". Apka rejestruje
 * się przy KAŻDYM starcie i powrocie z tła, więc `upsert` jest operacją podstawową, a utracony plik
 * kosztuje jeden start apki.
 *
 * Pola wpisu:
 * - `alerts` — stan zgody systemowej na powiadomienia (z apki). `false` NIE usuwa wpisu: token
 *   jest potrzebny Live Activity, której zgoda na alerty nie dotyczy; banerów do niego nie ma.
 * - `lastOkAt` — ostatnie REALNE 200 z APNs (także push próbny); `null` = nic jeszcze nie doszło.
 *   Po nim liczy się LRU.
 * - `failures`/`degradedSince` — porażki prób Z RZĘDU i od kiedy token jest zdegradowany
 *   ({@link DEGRADED_AFTER_FAILURES} porażki); 200 zeruje oba.
 * - `liveActivity` — token aktualizacji zbiorczej Live Activity urządzenia (`activityId`,
 *   `updateToken` małymi literami, `startedAt`, opcjonalnie `lastTimestamp`); zapisuje go trasa
 *   `POST /api/push/live-activity`, a kasuje — WYŁĄCZNIE przy zgodnym id (i tokenie) — koniec
 *   aktywności (`live-activity.ts`).
 * - `deviceId` — urządzenie z parowania, które zarejestrowało token kluczem `Rarog-Device` (pole
 *   wymagane: trasa rejestracji przyjmuje wyłącznie klucz urządzenia, a odczyt pomija wpis bez niego).
 *   Odpięcie urządzenia kasuje jego tokeny
 *   ({@link ApnsDeviceStore.removeOwnedBy}), a push `device-paired` idzie tylko do tokenów
 *   aktywnych urządzeń. Jedno urządzenie ma JEDEN wpis na temat: instalacja apki ma naraz jeden
 *   token APNs, więc rejestracja zastępuje wpisy z innym tokenem i tą samą parą `deviceId` i `topic`
 *   (rotacja tokenu, przejście z buildu z linku na TestFlight). Blok `liveActivity` przechodzi na nowy wpis
 *   tylko przy tym samym środowisku (apka nie rejestruje od nowa aktywności, którą zostawił poprzedni proces);
 *   przy zmianie środowiska należy do starej instalacji i znika razem z wpisem.
 * - `topic` — temat APNs zadeklarowany przez apkę przy rejestracji (jej bundle id; pole wymagane, trasa
 *   przepuszcza tylko temat równy tematowi serwera, a odczyt pomija wpis bez tematu albo z tematem spoza reguły
 *   bundle id). Token przyjmuje pushe WYŁĄCZNIE pod tematem swojej apki, więc każda wysyłka (baner, push próbny,
 *   `device-paired`, Live Activity) bierze temat z wpisu przez {@link apnsTopicOf}, nie z konfiguracji.
 * - `relayPass` — przepustka przekaźnika push ({@link RelayPass}) z tym, do czego ją wydano: origin
 *   przekaźnika, środowisko, temat i token. Zamawia i odnawia ją WYŁĄCZNIE `relay-pass.ts`, tylko dla wpisów z
 *   `topic`; zapis jest warunkowy ({@link ApnsDeviceStore.setRelayPass}). Ten sam kształt w bloku `liveActivity`
 *   (token = token aktywności). Przepustka to zdolność „wysłać do tego tokenu przez przekaźnik” — dlatego plik
 *   ma `0o600`, a przepustka nie trafia do logu ani do odpowiedzi.
 * - `relayMismatch` — przekaźnik odmówił przepustki, bo Apple nie zna tokenu w zgłoszonym środowisku (`BadDeviceToken`
 *   dla tokenu bez żadnego 200): `degradedReason: 'env-mismatch'` w statusie, wpis zostaje. Znika przy pierwszym 200
 *   i przy rejestracji z innym środowiskiem.
 * - `pushFormats` — formaty ładunku banera, które apka zadeklarowała w TEJ rejestracji (`3` = treść
 *   szyfrowana, którą odczyta jej NSE). Każda rejestracja niesie deklarację od nowa, a rejestracja bez pola ją
 *   kasuje — wpis bez deklaracji 3 banerów nie dostaje (`apns-sink.ts`). Odczyt bierze wyłącznie tablicę
 *   liczb całkowitych z sufitem {@link PUSH_FORMATS_MAX}; cokolwiek innego = brak deklaracji.
 * - `locKeys` — apka zadeklarowała w TEJ rejestracji klucze lokalizacji pushy: tekst zastępczy banera i dzwonek
 *   kafla idą do wpisu jako klucze katalogu apki zamiast polskich literałów (`apns-payload.ts`). Jak `pushFormats`:
 *   każda rejestracja niesie deklarację od nowa, rejestracja bez pola albo z `false` ją zdejmuje. W pliku wyłącznie
 *   `true`; odczyt bierze tylko `true`, cokolwiek innego = brak deklaracji.
 *
 * Odczyt bierze pola po nazwie: nieznany klucz jest ignorowany, a pierwszy zapis go zdejmuje.
 */
import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { APNS_ENVIRONMENTS, APNS_TOKEN_RE, BUNDLE_ID_RE, DEVICE_ID_RE } from '@rarog/shared/rest';
import type { ApnsEnvironment } from '@rarog/shared/rest';
import { RELAY_PASS_RE } from '@rarog/shared/relay';
import { sanitizeLabel } from '../text.ts';
import { DEGRADED_AFTER_FAILURES } from './index.ts';

/** Nazwa pliku w `dataDir`. Strażnik `docs-zgodnosc.test.ts` wyprowadza z niej wpis w docs. */
export const APNS_DEVICES_FILENAME = 'apns-devices.json';

/**
 * Sufit wpisów. Dwa urządzenia i reinstalacje apki (każda = nowy token, stary martwy do
 * pierwszego `410`). Ponad sufit wypada wpis najdłużej bez potwierdzonej dostawy.
 */
export const APNS_DEVICES_MAX = 20;

const FILE_MODE = 0o600;

/** Sufit deklaracji `pushFormats` — ten sam co w schemacie rejestracji (`apnsRegisterBodySchema`). */
export const PUSH_FORMATS_MAX = 8;

/*
 * Etykieta urządzenia — reguła mieszka w `../text.ts` (wspólna z parowaniem); re-eksport zostaje
 * dla dotychczasowych odbiorców.
 */
export { LABEL_FALLBACK, LABEL_MAX_CODEPOINTS, sanitizeLabel } from '../text.ts';

/**
 * Przepustka przekaźnika push razem z tym, do czego ją wydano. Przekaźnik wiąże ją z tokenem, środowiskiem
 * i typem; serwer dokłada origin przekaźnika i temat wpisu, bo przepustka z innego przekaźnika (zmiana adresu)
 * albo dla innej apki nie jest przepustką. Ważność ocenia `relay-pass.ts` (`usablePass`), nie odczyt pliku.
 */
export interface RelayPass {
  /** Nieprzezroczysta przepustka (`v1.<kid>.…`, dla kafla `v2.<kid>.…`) — nigdy do logu. */
  readonly pass: string;
  /** Koniec ważności (ISO, z `/v1/pass` albo `renewedPass`). */
  readonly expiresAt: string;
  /** Origin przekaźnika, który ją wydał (`RAROG_PUSH_RELAY_URL`). */
  readonly origin: string;
  readonly environment: ApnsEnvironment;
  /** Temat wpisu urządzenia, dla którego ją zamówiono. */
  readonly topic: string;
  /** Token, na który ją wydano (urządzenia albo aktywności), małymi literami. */
  readonly token: string;
}

/** Przekaźnik odmówił przepustki: Apple nie zna tokenu w zgłoszonym środowisku (`env-mismatch`). */
export interface RelayMismatch {
  /** Od kiedy (ISO) — `degradedSince` statusu tokenu. */
  readonly since: string;
  /** Przekaźnik, który odmówił; inny origin zaczyna od nowa. */
  readonly origin: string;
  /** Środowisko z rejestracji, którego dotyczy odmowa; rejestracja z innym zdejmuje znacznik. */
  readonly environment: ApnsEnvironment;
}

export interface LiveActivityToken {
  readonly activityId: string;
  readonly updateToken: string;
  readonly startedAt: string;
  /**
   * Ostatni `aps.timestamp` (sekundy epoki), gdy WYPRZEDZIŁ zegar — seria pilnych aktualizacji
   * w jednej sekundzie dostaje kolejne sekundy. Utrwalony, żeby pierwsza aktualizacja po restarcie
   * serwera nie była „starsza" od ostatniej sprzed niego (ActivityKit by ją zignorował).
   */
  readonly lastTimestamp?: number;
  /** Przepustka przekaźnika dla tokenu aktywności (`token` = `updateToken`); rotacja tokenu ją zdejmuje. */
  readonly relayPass?: RelayPass;
}

export interface ApnsDeviceRecord {
  /** Token urządzenia, hex małymi literami (tak go rejestr klucząco porównuje). */
  readonly token: string;
  readonly environment: ApnsEnvironment;
  /** Etykieta z apki po sanityzacji (`sanitizeLabel`) — nigdy do logu. */
  readonly label: string;
  readonly alerts: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastOkAt: string | null;
  readonly failures: number;
  readonly degradedSince: string | null;
  readonly liveActivity?: LiveActivityToken;
  /** Urządzenie z parowania, które zarejestrowało token. */
  readonly deviceId: string;
  /** Temat APNs zadeklarowany przez apkę (jej bundle id), {@link apnsTopicOf}. */
  readonly topic: string;
  /** Przepustka przekaźnika dla tokenu urządzenia; brak = wpis wysyła kluczem na Macu albo wcale. */
  readonly relayPass?: RelayPass;
  /** Odmowa przepustki `env-mismatch`; brak = przekaźnik nie odmówił. */
  readonly relayMismatch?: RelayMismatch;
  /** Formaty ładunku banera zadeklarowane w ostatniej rejestracji; brak = brak deklaracji (bez banerów). */
  readonly pushFormats?: readonly number[];
  /** Klucze lokalizacji zadeklarowane w ostatniej rejestracji; brak = literały tekstu zastępczego i dzwonka. */
  readonly locKeys?: true;
}

/** `apns-topic` wysyłek do tego wpisu: temat zadeklarowany przez apkę. */
export function apnsTopicOf(record: Pick<ApnsDeviceRecord, 'topic'>): string {
  return record.topic;
}

export interface ApnsUpsertInput {
  readonly token: string;
  readonly environment: ApnsEnvironment;
  readonly label: string;
  readonly alerts: boolean;
  /** Urządzenie, którego kluczem przyszła rejestracja. */
  readonly deviceId: string;
  /** Temat z ciała rejestracji (już równy tematowi serwera). */
  readonly topic: string;
  /** Deklaracja formatów z ciała rejestracji; brak = wpis bez deklaracji. */
  readonly pushFormats?: readonly number[];
  /** Deklaracja kluczy lokalizacji z ciała rejestracji; brak albo `false` = wpis bez deklaracji. */
  readonly locKeys?: boolean;
}

/** Token aktywności z apki (`pushTokenUpdates`) — trasa `POST /api/push/live-activity`. */
export interface LiveActivityInput {
  readonly activityId: string;
  readonly updateToken: string;
}

/**
 * Wynik zapisu tokenu aktywności: `started` = nowa aktywność (zastępuje poprzednią), `rotated` =
 * ten sam `activityId` z nowym tokenem, `unchanged` = powtórka, `unknown-device` = urządzenia nie
 * ma w rejestrze (apka rejestruje token urządzenia PRZED tokenem aktywności).
 */
export type LiveActivitySetResult = 'started' | 'rotated' | 'unchanged' | 'unknown-device';

/** Co musi się zgadzać, żeby wolno było skasować blok aktywności. */
export interface LiveActivityMatch {
  readonly activityId: string;
  /** Token, z którym poszła operacja; brak = wystarczy zgodny `activityId` (trasa `…/end`). */
  readonly updateToken?: string;
}

export interface ApnsDeviceStore {
  /**
   * Dodaje albo odświeża wpis po tokenie. Z `deviceId` i `topic` usuwa wpisy innych tokenów tej pary (jeden wpis na
   * urządzenie i temat). Zwraca stan wpisu po operacji.
   */
  upsert(input: ApnsUpsertInput): ApnsDeviceRecord;
  /** `true` = coś usunięto; nieznany token to nie błąd (`410` bywa dostarczone dwa razy). */
  remove(token: string): boolean;
  /** Kasuje wszystkie tokeny zarejestrowane kluczem tego urządzenia (odpięcie); zwraca je. */
  removeOwnedBy(deviceId: string): readonly string[];
  get(token: string): ApnsDeviceRecord | undefined;
  /** Kopia — wołający nie ma jak zepsuć rejestru przez zwrócony obiekt. */
  list(): readonly ApnsDeviceRecord[];
  /** Realne 200 z APNs: `lastOkAt` = teraz, licznik porażek i degradacja zerowane. */
  noteDelivered(token: string): void;
  /** Nieudana PRÓBA: licznik w górę, trzecia z rzędu zapala `degradedSince`. */
  noteFailed(token: string): void;
  /** Token aktywności przypięty do urządzenia; patrz {@link LiveActivitySetResult}. */
  setLiveActivity(token: string, input: LiveActivityInput): LiveActivitySetResult;
  /**
   * Kasuje blok aktywności WYŁĄCZNIE przy zgodnym `activityId` (i tokenie, gdy podany) —
   * spóźniona odpowiedź albo „zakończ" starej aktywności nie zamyka nowej. `true` = skasowano.
   */
  clearLiveActivity(token: string, match: LiveActivityMatch): boolean;
  /** Zapamiętuje `aps.timestamp` aktywności o tym `activityId`, gdy jest większy od zapisanego. */
  noteLiveActivityTimestamp(token: string, activityId: string, timestamp: number): void;
  /**
   * Przepustka urządzenia — zapis WARUNKOWY: wpis tokenu `pass.token` istnieje, ma środowisko i temat
   * przepustki, a zapisana przepustka tego samego przekaźnika i wiązania nie kończy się później. Spóźniona
   * odpowiedź nie odtwarza usuniętego wpisu, nie trafia do wpisu po zmianie środowiska ani tematu i nie nadpisuje
   * nowszej przepustki. Zdejmuje odmowę `env-mismatch` tego przekaźnika. `true` = zapisano.
   */
  setRelayPass(pass: RelayPass): boolean;
  /**
   * Przepustka aktywności — zapis WARUNKOWY jak {@link setRelayPass}, w bloku o tym `activityId` i tokenie aktywności
   * równym `pass.token` (rotacja tokenu albo nowa aktywność w trakcie zamówienia = brak zapisu).
   */
  setActivityRelayPass(deviceToken: string, activityId: string, pass: RelayPass): boolean;
  /** Zdejmuje przepustkę urządzenia, jeśli wpis WCIĄŻ ma tę (`401 pass-invalid`). `true` = zdjęto. */
  dropRelayPass(token: string, pass: string): boolean;
  /** Zdejmuje przepustkę aktywności o tym `activityId`, jeśli blok WCIĄŻ ma tę. `true` = zdjęto. */
  dropActivityRelayPass(deviceToken: string, activityId: string, pass: string): boolean;
  /**
   * Odmowa `env-mismatch` — warunkowo: wpis istnieje i ma środowisko odmowy i temat `topic`. Wpis zostaje.
   * `true` = zapisano.
   */
  noteRelayMismatch(token: string, topic: string, mismatch: RelayMismatch): boolean;
  readonly size: number;
  /** Czeka na zakończenie wszystkich zleconych zapisów (testy, zamykanie serwera). */
  flush(): Promise<void>;
}

export interface ApnsDeviceStoreOptions {
  readonly dataDir: string;
  readonly now?: () => number;
  /** Log awarii zapisu i zastąpienia wpisu. NIGDY nie dostaje tokenu ani etykiety — tylko liczby i środowiska. */
  readonly logger?: (line: string) => void;
}

export function apnsDevicesPath(dataDir: string): string {
  return path.join(dataDir, APNS_DEVICES_FILENAME);
}

/** Token w kluczu rejestru: hex małymi literami (apka może wysłać dowolną wielkość liter). */
export function normalizeApnsToken(token: string): string {
  return token.toLowerCase();
}

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value !== '';
const isEnvironment = (value: unknown): value is ApnsEnvironment =>
  typeof value === 'string' && (APNS_ENVIRONMENTS as readonly string[]).includes(value);

const isIso = (value: unknown): value is string => isNonEmptyString(value) && Number.isFinite(Date.parse(value));

/** Przepustka z dysku; cokolwiek nie tak = brak przepustki (wpis zostaje, zamówi się nową). */
function loadRelayPass(raw: unknown): RelayPass | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const entry = raw as Record<string, unknown>;
  const { pass, expiresAt, origin, environment, topic, token } = entry;
  if (typeof pass !== 'string' || !RELAY_PASS_RE.test(pass) || !isIso(expiresAt)) return undefined;
  if (!isNonEmptyString(origin) || !isEnvironment(environment)) return undefined;
  if (typeof topic !== 'string' || !BUNDLE_ID_RE.test(topic)) return undefined;
  if (typeof token !== 'string' || !APNS_TOKEN_RE.test(token)) return undefined;
  return { pass, expiresAt, origin, environment, topic, token: normalizeApnsToken(token) };
}

/** Deklaracja formatów z dysku: tablica liczb całkowitych do {@link PUSH_FORMATS_MAX}; inaczej brak deklaracji. */
function loadPushFormats(raw: unknown): readonly number[] | undefined {
  if (!Array.isArray(raw) || raw.length > PUSH_FORMATS_MAX) return undefined;
  return raw.every((value) => Number.isSafeInteger(value)) ? [...raw as number[]] : undefined;
}

function loadRelayMismatch(raw: unknown): RelayMismatch | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { since, origin, environment } = raw as Record<string, unknown>;
  if (!isIso(since) || !isNonEmptyString(origin) || !isEnvironment(environment)) return undefined;
  return { since, origin, environment };
}

function loadLiveActivity(raw: unknown): LiveActivityToken | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const entry = raw as { activityId?: unknown; updateToken?: unknown; startedAt?: unknown };
  if (!isNonEmptyString(entry.activityId) || !isNonEmptyString(entry.startedAt)) return undefined;
  if (typeof entry.updateToken !== 'string' || !APNS_TOKEN_RE.test(entry.updateToken)) return undefined;
  const last = (raw as { lastTimestamp?: unknown }).lastTimestamp;
  const relayPass = loadRelayPass((raw as { relayPass?: unknown }).relayPass);
  return {
    activityId: entry.activityId,
    updateToken: normalizeApnsToken(entry.updateToken),
    startedAt: entry.startedAt,
    ...(typeof last === 'number' && Number.isSafeInteger(last) && last > 0 ? { lastTimestamp: last } : {}),
    ...(relayPass === undefined ? {} : { relayPass }),
  };
}

/**
 * Wczytanie rejestru: cokolwiek nie tak z plikiem albo z pojedynczym wpisem → wpis znika, plik
 * jako całość nigdy nie rzuca. Etykieta z dysku przechodzi tę samą sanityzację co z sieci. Wpis bez
 * `deviceId` albo `topic` (rejestracja sprzed kluczy urządzeń albo apka sprzed pola tematu) też znika: nie
 * dostałby żadnego pushu, a pierwszy zapis zdejmuje go z pliku.
 */
function loadRecords(file: string): Map<string, ApnsDeviceRecord> {
  const records = new Map<string, ApnsDeviceRecord>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return records;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return records;
  const body = parsed as { devices?: unknown };
  if (!Array.isArray(body.devices)) return records;
  for (const raw of body.devices) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry['token'] !== 'string' || !APNS_TOKEN_RE.test(entry['token'])) continue;
    if (!isEnvironment(entry['environment'])) continue;
    if (!isNonEmptyString(entry['createdAt'])) continue;
    const deviceId = entry['deviceId'];
    if (typeof deviceId !== 'string' || !DEVICE_ID_RE.test(deviceId)) continue;
    const topic = entry['topic'];
    if (typeof topic !== 'string' || !BUNDLE_ID_RE.test(topic)) continue;
    const token = normalizeApnsToken(entry['token']);
    const label = sanitizeLabel(typeof entry['label'] === 'string' ? entry['label'] : undefined);
    const failures = entry['failures'];
    const liveActivity = loadLiveActivity(entry['liveActivity']);
    const relayPass = loadRelayPass(entry['relayPass']);
    const relayMismatch = loadRelayMismatch(entry['relayMismatch']);
    const pushFormats = loadPushFormats(entry['pushFormats']);
    records.set(token, {
      token,
      environment: entry['environment'],
      label,
      alerts: entry['alerts'] === true,
      createdAt: entry['createdAt'],
      updatedAt: isNonEmptyString(entry['updatedAt']) ? entry['updatedAt'] : entry['createdAt'],
      lastOkAt: isNonEmptyString(entry['lastOkAt']) ? entry['lastOkAt'] : null,
      failures: typeof failures === 'number' && Number.isInteger(failures) && failures > 0 ? failures : 0,
      degradedSince: isNonEmptyString(entry['degradedSince']) ? entry['degradedSince'] : null,
      ...(liveActivity === undefined ? {} : { liveActivity }),
      deviceId,
      topic,
      ...(relayPass === undefined ? {} : { relayPass }),
      ...(relayMismatch === undefined ? {} : { relayMismatch }),
      ...(pushFormats === undefined ? {} : { pushFormats }),
      ...(entry['locKeys'] === true ? { locKeys: true } : {}),
    });
  }
  return records;
}

/**
 * Czy `next` może zastąpić `current`: brak zapisanej, inne wiązanie (przekaźnik, środowisko, temat, token — stara
 * przepustka nie jest już przepustką tego wpisu) albo `next` kończy się nie wcześniej (spóźniona odpowiedź na
 * starsze zamówienie nie nadpisuje nowszej przepustki).
 */
function newerOrRebound(current: RelayPass | undefined, next: RelayPass): boolean {
  if (current === undefined) return true;
  if (current.origin !== next.origin || current.environment !== next.environment || current.topic !== next.topic
    || current.token !== next.token) {
    return true;
  }
  return Date.parse(next.expiresAt) >= Date.parse(current.expiresAt);
}

export function createApnsDeviceStore(opts: ApnsDeviceStoreOptions): ApnsDeviceStore {
  const file = apnsDevicesPath(opts.dataDir);
  const now = opts.now ?? ((): number => Date.now());
  const iso = (): string => new Date(now()).toISOString();
  const records = loadRecords(file);
  let chain: Promise<void> = Promise.resolve();

  const persist = (): Promise<void> => {
    const payload = `${JSON.stringify({ devices: [...records.values()] }, null, 2)}\n`;
    chain = chain.then(async () => {
      const tmp = `${file}.tmp`;
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(tmp, payload, { encoding: 'utf8', mode: FILE_MODE });
      await rename(tmp, file);
    }).catch((err: unknown) => {
      // Łańcuch nie może zostać odrzucony (ten sam powód co w `herdr/identity.ts`): odrzucona
      // obietnica pomija każdy następny krok, a wołający używają `void`. Kod błędu, nie komunikat:
      // ścieżka pliku to nie sekret, ale w logu nie ma po co jej powtarzać.
      const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
      opts.logger?.(
        `apns-devices: write failed (${typeof code === 'string' ? code : 'no code'})`
        + ` — ${String(records.size)} entries stay in RAM`,
      );
    });
    return chain;
  };

  /*
   * Ponad sufit wypada wpis o najstarszym `lastOkAt` (brak potwierdzenia = najstarszy), ale NIGDY
   * ten, który właśnie wchodzi — świeży wpis ma `lastOkAt: null` i inaczej wypadałby pierwszy.
   */
  const rank = (record: ApnsDeviceRecord): string => record.lastOkAt ?? '';
  const evict = (keep: string): void => {
    while (records.size > APNS_DEVICES_MAX) {
      let victim: ApnsDeviceRecord | undefined;
      for (const record of records.values()) {
        if (record.token === keep) continue;
        if (victim === undefined || rank(record) < rank(victim)) victim = record;
      }
      if (victim === undefined) return;
      records.delete(victim.token);
    }
  };

  const update = (token: string, change: (record: ApnsDeviceRecord) => ApnsDeviceRecord): void => {
    const existing = records.get(normalizeApnsToken(token));
    if (existing === undefined) return;
    const next = change(existing);
    if (next === existing) return;
    records.set(existing.token, next);
    void persist();
  };

  return {
    upsert(input: ApnsUpsertInput): ApnsDeviceRecord {
      const token = normalizeApnsToken(input.token);
      const existing = records.get(token);
      const label = sanitizeLabel(input.label);
      const at = iso();
      // Przepustka zostaje tylko przy tym samym środowisku i temacie (z tym ją wydano); odmowa — przy tym samym środowisku.
      const keptPass = existing?.relayPass !== undefined && existing.relayPass.environment === input.environment
        && existing.relayPass.topic === input.topic ? existing.relayPass : undefined;
      const keptMismatch = existing?.relayMismatch?.environment === input.environment
        ? existing.relayMismatch : undefined;
      // Jeden wpis na urządzenie i temat: inny token tej pary to martwa instalacja albo token sprzed rotacji.
      const replaced = [...records.values()]
        .filter((r) => r.token !== token && r.deviceId === input.deviceId && r.topic === input.topic);
      for (const old of replaced) records.delete(old.token);
      // Kafel przy rotacji w tym samym środowisku: aktywność żyje dalej, a apka nie zarejestruje jej od nowa.
      const movedActivity = existing?.liveActivity !== undefined ? undefined
        : replaced.filter((r) => r.environment === input.environment && r.liveActivity !== undefined).at(-1)?.liveActivity;
      const liveActivity = existing?.liveActivity ?? movedActivity;
      const record: ApnsDeviceRecord = {
        token,
        environment: input.environment,
        label,
        alerts: input.alerts,
        createdAt: existing?.createdAt ?? at,
        updatedAt: at,
        lastOkAt: existing?.lastOkAt ?? null,
        failures: existing?.failures ?? 0,
        degradedSince: existing?.degradedSince ?? null,
        ...(liveActivity === undefined ? {} : { liveActivity }),
        deviceId: input.deviceId,
        // Temat z TEJ rejestracji: token należy do jednej apki, a ona deklaruje go za każdym razem.
        topic: input.topic,
        ...(keptPass === undefined ? {} : { relayPass: keptPass }),
        ...(keptMismatch === undefined ? {} : { relayMismatch: keptMismatch }),
        // Deklaracja z TEJ rejestracji, jak temat: brak pola = brak deklaracji (wpis bez banerów).
        ...(input.pushFormats === undefined ? {} : { pushFormats: [...input.pushFormats] }),
        // Tak samo klucze lokalizacji: brak pola albo `false` zdejmuje deklarację (literały).
        ...(input.locKeys === true ? { locKeys: true } : {}),
      };
      // Odświeżony wpis na koniec kolejności wstawiania — czytelniej w pliku, bez znaczenia dla LRU.
      records.delete(token);
      records.set(token, record);
      evict(token);
      void persist();
      if (replaced.length > 0) {
        const from = [...new Set(replaced.map((r) => r.environment))].join(', ');
        opts.logger?.(`push: APNs device entry overwritten (${from} → ${input.environment})`
          + (movedActivity === undefined ? '' : ', Live Activity moved'));
      }
      return record;
    },
    remove(token: string): boolean {
      const removed = records.delete(normalizeApnsToken(token));
      if (removed) void persist();
      return removed;
    },
    removeOwnedBy(deviceId: string): readonly string[] {
      const owned = [...records.values()].filter((record) => record.deviceId === deviceId).map((r) => r.token);
      for (const token of owned) records.delete(token);
      if (owned.length > 0) void persist();
      return owned;
    },
    get(token: string): ApnsDeviceRecord | undefined {
      return records.get(normalizeApnsToken(token));
    },
    list(): readonly ApnsDeviceRecord[] {
      return [...records.values()];
    },
    noteDelivered(token: string): void {
      update(token, (record) => {
        // Realne 200 do tego tokenu w jego środowisku: odmowa `env-mismatch` była nieaktualna.
        const { relayMismatch: _gone, ...rest } = record;
        void _gone;
        return { ...rest, lastOkAt: iso(), failures: 0, degradedSince: null };
      });
    },
    noteFailed(token: string): void {
      update(token, (record) => {
        const failures = record.failures + 1;
        const degradedSince = record.degradedSince
          ?? (failures >= DEGRADED_AFTER_FAILURES ? iso() : null);
        return { ...record, failures, degradedSince };
      });
    },
    setLiveActivity(token: string, input: LiveActivityInput): LiveActivitySetResult {
      const record = records.get(normalizeApnsToken(token));
      if (record === undefined) return 'unknown-device';
      const updateToken = normalizeApnsToken(input.updateToken);
      const current = record.liveActivity;
      if (current?.activityId === input.activityId) {
        if (current.updateToken === updateToken) return 'unchanged';
        // Przepustka aktywności była wydana na stary token — rotacja ją zdejmuje (zamówi się nową).
        const { relayPass: _stale, ...kept } = current;
        void _stale;
        records.set(record.token, { ...record, liveActivity: { ...kept, updateToken } });
        void persist();
        return 'rotated';
      }
      records.set(record.token, {
        ...record, liveActivity: { activityId: input.activityId, updateToken, startedAt: iso() },
      });
      void persist();
      return 'started';
    },
    noteLiveActivityTimestamp(token: string, activityId: string, timestamp: number): void {
      update(token, (record) => {
        const current = record.liveActivity;
        if (current?.activityId !== activityId || (current.lastTimestamp ?? 0) >= timestamp) return record;
        return { ...record, liveActivity: { ...current, lastTimestamp: timestamp } };
      });
    },
    clearLiveActivity(token: string, match: LiveActivityMatch): boolean {
      const record = records.get(normalizeApnsToken(token));
      const current = record?.liveActivity;
      if (record === undefined || current === undefined || current.activityId !== match.activityId) return false;
      if (match.updateToken !== undefined && current.updateToken !== normalizeApnsToken(match.updateToken)) {
        return false;
      }
      const { liveActivity: _dropped, ...rest } = record;
      void _dropped;
      records.set(record.token, rest);
      void persist();
      return true;
    },
    setRelayPass(given: RelayPass): boolean {
      const pass = { ...given, token: normalizeApnsToken(given.token) };
      const record = records.get(pass.token);
      if (record === undefined || record.environment !== pass.environment || record.topic !== pass.topic) return false;
      if (!newerOrRebound(record.relayPass, pass)) return false;
      const { relayMismatch, ...rest } = record;
      const next: ApnsDeviceRecord = {
        ...rest, relayPass: pass,
        // Odmowa INNEGO przekaźnika zostaje; ten właśnie wydał przepustkę.
        ...(relayMismatch === undefined || relayMismatch.origin === pass.origin ? {} : { relayMismatch }),
      };
      records.set(record.token, next);
      void persist();
      return true;
    },
    setActivityRelayPass(deviceToken: string, activityId: string, given: RelayPass): boolean {
      const pass = { ...given, token: normalizeApnsToken(given.token) };
      const record = records.get(normalizeApnsToken(deviceToken));
      const current = record?.liveActivity;
      if (record === undefined || current === undefined || current.activityId !== activityId) return false;
      if (current.updateToken !== pass.token) return false;
      if (record.environment !== pass.environment || record.topic !== pass.topic) return false;
      if (!newerOrRebound(current.relayPass, pass)) return false;
      records.set(record.token, { ...record, liveActivity: { ...current, relayPass: pass } });
      void persist();
      return true;
    },
    dropRelayPass(token: string, pass: string): boolean {
      const record = records.get(normalizeApnsToken(token));
      if (record?.relayPass?.pass !== pass) return false;
      const { relayPass: _dropped, ...rest } = record;
      void _dropped;
      records.set(record.token, rest);
      void persist();
      return true;
    },
    dropActivityRelayPass(deviceToken: string, activityId: string, pass: string): boolean {
      const record = records.get(normalizeApnsToken(deviceToken));
      const current = record?.liveActivity;
      if (record === undefined || current?.activityId !== activityId || current.relayPass?.pass !== pass) return false;
      const { relayPass: _dropped, ...kept } = current;
      void _dropped;
      records.set(record.token, { ...record, liveActivity: kept });
      void persist();
      return true;
    },
    noteRelayMismatch(token: string, topic: string, mismatch: RelayMismatch): boolean {
      const record = records.get(normalizeApnsToken(token));
      if (record === undefined || record.environment !== mismatch.environment || record.topic !== topic) return false;
      const previous = record.relayMismatch;
      // Pierwsza odmowa wyznacza `since`; powtórka tego samego przekaźnika i środowiska go nie przesuwa.
      if (previous !== undefined && previous.origin === mismatch.origin && previous.environment === mismatch.environment) {
        return true;
      }
      records.set(record.token, { ...record, relayMismatch: mismatch });
      void persist();
      return true;
    },
    get size(): number {
      return records.size;
    },
    flush(): Promise<void> {
      return chain;
    },
  };
}
