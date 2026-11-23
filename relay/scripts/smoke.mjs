#!/usr/bin/env node
/**
 * Skrypt dymny przekaźnika push: pomiary (1)–(3) z `relay/README.md`, „Measurements”, i krok (4)
 * na prawdziwych tokenach z `apns-devices.json` serwera. Zwykły Node 22, bez zależności.
 *
 *     node relay/scripts/smoke.mjs <adres przekaźnika> [ścieżka apns-devices.json]
 *          [--label "iPhone·Rarog"] [--activity-label "iPad·Rarog"] [--steps 1,2,3,4]
 *
 * Adres przekaźnika jest obowiązkowy i nie ma wartości domyślnej: to origin wdrożonego Workera (domena z `routes`
 * w `relay/wrangler.toml`). Bez niego skrypt kończy się kodem 2 z instrukcją użycia, zanim cokolwiek wyśle.
 *
 * Domyślna ścieżka: `<dataDir>/apns-devices.json`, katalog danych regułą serwera (`shared/src/data-dir.mjs`;
 * konflikt katalogów = odmowa z komendą naprawy). Wpis wybiera etykieta (tylko wpisy Raroga: `topic` = `ai.rarog.app`; przy kilku — najnowszy).
 *
 * (1) `/v1/pass` + `/v1/push` na token `development` urządzenia `--label` → baner „Rarog / Nowe powiadomienie”
 *     na urządzeniu: HTTP/2 z Workera do APNs działa.
 * (2) `/v1/pass` dla tego samego tokenu w `production` → oczekiwane 422 `token-rejected` `BadDeviceToken`; 502
 *     `apns-error` to inna odmowa Apple — przekaźnik nie oddaje jej pól, więc status i powód czyta się
 *     z `wrangler tail` (`apns_status` 403 z `InvalidProviderToken`/`BadEnvironmentKeyIdInToken` = klucz NIE działa
 *     w produkcji).
 * (3) przepustka `liveactivity` dla tokenu aktywności urządzenia `--activity-label` i aktualizacja kafla → 200 albo
 *     `TopicDisallowed`: czy klucz obejmuje temat kafla. Kafel pokaże zera do następnej aktualizacji z serwera.
 * (4) tylko na żądanie (`--steps 4`, domyślne kroki to 1–3): baner urządzenia `--label` w środowisku z jego wpisu,
 *     z alertem z kluczy `push.placeholder.*` i kopertą v3, która przechodzi walidację odbiorcy, ale ma `kid`
 *     ({@link UNKNOWN_KID}), którego urządzenie nie zna. NSE zostawia wtedy alert z kluczy (brak klucza, nie zła
 *     koperta), więc baner pokazuje tekst zastępczy z katalogu apki w języku urządzenia.
 *
 * Wypisuje WYŁĄCZNIE krok, trasę, status HTTP i pola kontraktu (`error`, `apnsStatus`, `reason`, `rule`) — nigdy
 * tokenu, przepustki, etykiety spoza argumentów ani reszty odpowiedzi.
 */

import { dataDirConflictMessage, resolveDataDir } from '../../shared/src/data-dir.mjs';

export const APP_TOPIC = 'ai.rarog.app';
export const DEFAULT_LABEL = 'iPhone·Rarog';
export const DEFAULT_ACTIVITY_LABEL = 'iPad·Rarog';
const CLIENT = 'rarog-smoke/0.1.0';
export const CLIENT_HEADER = 'x-rarog-relay-client';
const TOKEN_RE = /^[0-9a-fA-F]{32,512}$/;
export const USAGE = 'usage: node relay/scripts/smoke.mjs <relay address> [path to apns-devices.json]'
  + ' [--label <label>] [--activity-label <label>] [--steps 1,2,3,4]';
const STEPS = [1, 2, 3, 4];

/**
 * `kid` kroku 4: format odbiorcy (8 znaków hex, `PushWire.isKid`), a urządzenie ma klucz tylko pod `kid` = pierwsze
 * 8 znaków hex `sha256` swojego klucza push. Zera trafiłyby w klucz urządzenia z szansą 2⁻³².
 */
export const UNKNOWN_KID = '00000000';
/** Tekst zastępczy banera jako klucze katalogu apki: `ALERT_PLACEHOLDER_KEYS` z `src/alert-policy.ts`. */
const PLACEHOLDER_KEYS = { 'title-loc-key': 'push.placeholder.title', 'loc-key': 'push.placeholder.body' };
/** Bajty koperty jak w banerze próbnym serwera: nonce 12 B, szyfrogram kubełka 256 B i tag 16 B. */
const NONCE_BYTES = 12;
const SEALED_BYTES = 256 + 16;

/** @param {number} length */
const randomBase64url = (length) => Buffer.from(crypto.getRandomValues(new Uint8Array(length))).toString('base64url');

/**
 * `<dataDir>/apns-devices.json` regułą katalogu danych serwera; konflikt katalogów = błąd z komunikatem reguły.
 * @param {Readonly<Record<string, string | undefined>>} env
 * @param {string} home
 */
function defaultDevicesPath(env, home) {
  const resolved = resolveDataDir({ env, home });
  if (!resolved.ok) throw new Error(dataDirConflictMessage(resolved));
  return `${resolved.dir}/apns-devices.json`;
}

/** Pola odpowiedzi, które wolno wypisać. */
const PRINTABLE = ['error', 'apnsStatus', 'reason', 'rule'];

/** Wpis urządzenia → środowisko jego tokenu (build TestFlight: `production`). @param {any} entry */
const environmentOf = (entry) => (entry.environment === 'production' ? 'production' : 'development');

/**
 * @param {readonly string[]} argv argumenty po nazwie skryptu
 * @param {Readonly<Record<string, string | undefined>>} env
 * @param {string} home
 */
export function parseArgs(argv, env, home) {
  const positional = [];
  const options = { label: DEFAULT_LABEL, activityLabel: DEFAULT_ACTIVITY_LABEL, steps: [1, 2, 3] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    const next = () => {
      i += 1;
      const value = argv[i];
      if (value === undefined) throw new Error(`missing value after ${arg}`);
      return value;
    };
    if (arg === '--label') options.label = next();
    else if (arg === '--activity-label') options.activityLabel = next();
    else if (arg === '--steps') options.steps = next().split(',').map(Number).filter((n) => STEPS.includes(n));
    else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
    else positional.push(arg);
  }
  const relayUrl = positional[0];
  if (relayUrl === undefined) {
    throw new Error('missing relay address: give the address of the deployed Worker, https://<domain from `routes`'
      + ` in relay/wrangler.toml>\n${USAGE}`);
  }
  const url = new URL(relayUrl);
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error('relay address: https only');
  return { relayUrl: url.origin, devicesPath: positional[1] ?? defaultDevicesPath(env, home), ...options };
}

/**
 * Wpis Raroga o etykiecie `label` (najnowszy `updatedAt`), albo `undefined`.
 * @param {unknown} devices zawartość `apns-devices.json`
 * @param {string} label
 */
export function pickDevice(devices, label) {
  const list = typeof devices === 'object' && devices !== null && Array.isArray(/** @type {any} */ (devices).devices)
    ? /** @type {any[]} */ (/** @type {any} */ (devices).devices) : [];
  return list
    .filter((entry) => entry?.label === label && entry?.topic === APP_TOPIC && TOKEN_RE.test(String(entry?.token)))
    .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))[0];
}

/**
 * @param {{ relayUrl: string, devices: unknown, label: string, activityLabel: string, steps: number[],
 *   fetch: (url: string, init: RequestInit) => Promise<Response>, print: (line: string) => void, nowMs: number }} input
 * @returns {Promise<boolean>} czy wszystkie kroki dostały odpowiedź przekaźnika (nie: czy wynik jest „dobry”)
 */
export async function runSmoke(input) {
  const { relayUrl, devices, label, activityLabel, steps, print } = input;
  const nowSec = Math.floor(input.nowMs / 1000);
  let complete = true;

  /** @param {string} path @param {Record<string, unknown>} body */
  const post = async (path, body) => {
    try {
      const response = await input.fetch(`${relayUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [CLIENT_HEADER]: CLIENT },
        body: JSON.stringify({ v: 1, ...body }),
      });
      /** @type {Record<string, unknown>} */
      let parsed = {};
      try {
        parsed = /** @type {Record<string, unknown>} */ (await response.json());
      } catch {
        // Ciało nie-JSON: wypisujemy sam status.
      }
      return { status: response.status, body: parsed };
    } catch {
      complete = false;
      return { status: 0, body: {} };
    }
  };

  /** @param {string} step @param {string} route @param {{ status: number, body: Record<string, unknown> }} result */
  const report = (step, route, result, note = '') => {
    const fields = PRINTABLE.filter((key) => result.body[key] !== undefined)
      .map((key) => `${key}=${String(result.body[key]).replace(/[^A-Za-z0-9-]/g, '')}`);
    const status = result.status === 0 ? 'no response (network)' : String(result.status);
    print(`(${step}) ${route}: ${[status, ...fields].join(' ')}${note === '' ? '' : ` — ${note}`}`);
  };

  /** @param {any} entry @param {'development' | 'production'} environment */
  const devicePass = (entry, environment) =>
    post('/v1/pass', { token: entry.token, environment, type: 'alert', topic: APP_TOPIC });

  const device = pickDevice(devices, label);
  if ([1, 2, 4].some((step) => steps.includes(step)) && device === undefined) {
    print(`no Rarog entry labelled „${label}” (topic ${APP_TOPIC}) in apns-devices.json`);
    return false;
  }

  if (steps.includes(1)) {
    const pass = await devicePass(device, 'development');
    report('1', '/v1/pass development', pass);
    if (pass.status === 200 && typeof pass.body['pass'] === 'string') {
      const payload = JSON.stringify({
        aps: { alert: { title: 'Rarog', body: 'Nowe powiadomienie' }, 'mutable-content': 1, sound: 'default' },
        rarog: { v: 1, kind: 'test' },
      });
      const push = await post('/v1/push', {
        pass: pass.body['pass'], token: device.token, environment: 'development', payload,
        headers: {
          'apns-push-type': 'alert', 'apns-topic': APP_TOPIC, 'apns-priority': '10',
          'apns-expiration': String(nowSec + 300),
        },
      });
      report('1', '/v1/push alert', push, push.body['apnsStatus'] === 200
        ? `check the banner „Rarog / Nowe powiadomienie” on ${label}` : '');
    }
  }

  if (steps.includes(2)) {
    const result = await devicePass(device, 'production');
    const reason = result.body['reason'];
    const note = result.status === 422 && reason === 'BadDeviceToken'
      ? 'as expected: the key is accepted in production'
      : result.status === 502 && result.body['error'] === 'apns-error'
        ? 'Apple refused: check apns_status and reason in wrangler tail (403 = the key does NOT work in production)'
        : 'unexpected — save the response and check wrangler tail';
    report('2', '/v1/pass production', result, note);
  }

  if (steps.includes(3)) {
    const holder = pickDevice(devices, activityLabel);
    const activity = holder?.liveActivity?.updateToken;
    if (holder === undefined || typeof activity !== 'string' || !TOKEN_RE.test(activity)) {
      print(`(3) no active Live Activity on „${activityLabel}” (liveActivity block in apns-devices.json) — start some work`);
      return false;
    }
    const environment = environmentOf(holder);
    const device3 = await devicePass(holder, environment);
    report('3', `/v1/pass ${environment} (device)`, device3);
    if (device3.status !== 200) return complete;
    const la = await post('/v1/pass', {
      token: activity, environment, type: 'liveactivity', topic: APP_TOPIC, devicePass: device3.body['pass'],
    });
    report('3', '/v1/pass liveactivity', la);
    if (la.status !== 200) return complete;
    const payload = JSON.stringify({ aps: {
      timestamp: nowSec, event: 'update',
      'content-state': { waiting: 0, working: 0, finished: 0, updatedEpoch: nowSec },
      'stale-date': nowSec + 900,
    } });
    const push = await post('/v1/push', {
      pass: la.body['pass'], token: activity, environment, payload,
      headers: {
        'apns-push-type': 'liveactivity', 'apns-topic': `${APP_TOPIC}.push-type.liveactivity`, 'apns-priority': '5',
        'apns-expiration': String(nowSec + 900),
      },
    });
    const reason = push.body['reason'];
    report('3', '/v1/push liveactivity', push, push.body['apnsStatus'] === 200 ? 'the key covers the Live Activity topic'
      : reason === 'TopicDisallowed' ? 'the key does NOT cover the Live Activity topic' : '');
  }

  if (steps.includes(4)) {
    const environment = environmentOf(device);
    const pass = await devicePass(device, environment);
    report('4', `/v1/pass ${environment}`, pass);
    if (pass.status === 200 && typeof pass.body['pass'] === 'string') {
      const payload = JSON.stringify({
        aps: { alert: PLACEHOLDER_KEYS, 'mutable-content': 1, sound: 'default' },
        rarog: { v: 3, kid: UNKNOWN_KID, n: randomBase64url(NONCE_BYTES), c: randomBase64url(SEALED_BYTES) },
      });
      const push = await post('/v1/push', {
        pass: pass.body['pass'], token: device.token, environment, payload,
        headers: {
          'apns-push-type': 'alert', 'apns-topic': APP_TOPIC, 'apns-priority': '10',
          'apns-expiration': String(nowSec + 300),
        },
      });
      report('4', '/v1/push alert (unknown kid)', push, push.body['apnsStatus'] === 200
        ? `check on ${label} the fallback banner in the device language: „Rarog / Nowe powiadomienie” in Polish,`
          + ' „Rarog / New notification” in English'
        : '');
    }
  }
  return complete;
}

async function main() {
  const { readFile } = await import('node:fs/promises');
  const os = await import('node:os');
  let args;
  try {
    args = parseArgs(process.argv.slice(2), process.env, os.homedir());
  } catch (error) {
    process.stderr.write(`smoke: ${error instanceof Error ? error.message : 'bad argument'}\n`);
    process.exit(2);
  }
  let devices;
  try {
    devices = JSON.parse(await readFile(args.devicesPath, 'utf8'));
  } catch {
    process.stderr.write(`smoke: cannot read ${args.devicesPath}\n`);
    process.exit(2);
  }
  const ok = await runSmoke({
    ...args, devices, fetch: (url, init) => fetch(url, init), print: (line) => { process.stdout.write(`${line}\n`); },
    nowMs: Date.now(),
  });
  process.exit(ok ? 0 : 1);
}

/**
 * Czy skrypt uruchomiono wprost (`node relay/scripts/smoke.mjs`), czy go zaimportowano (test). Node podaje
 * w `import.meta.url` ścieżkę po rozwinięciu dowiązań, a `process.argv[1]` tak, jak ją podano, więc obie strony idą
 * przez `realpath`: porównanie wprost przy checkoucie pod dowiązaniem (`/var` → `/private/var`) daje `false`
 * i pomija `main` z kodem 0. Brak `argv[1]` albo błąd `realpath` = nie wprost. Ta sama reguła co
 * `scripts/lib/is-main.mjs` repo; przekaźnik to osobny pakiet, więc kopia jest lokalna.
 */
async function invokedDirectly() {
  const entry = process.argv[1];
  if (entry === undefined || entry === '') return false;
  const { realpathSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(entry));
  } catch {
    return false;
  }
}

if (await invokedDirectly()) await main();
