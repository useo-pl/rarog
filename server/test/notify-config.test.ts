/**
 * Konfiguracja kanału powiadomień (`RAROG_PUSH`, `RAROG_APNS_*`, `RAROG_PUSH_RELAY_URL`, `RAROG_PUSH_E2E`).
 *
 * Reguła jest ta sama co przy dyktowaniu: brak kluczy = funkcja po prostu wyłączona,
 * NIGDY błąd startu. Serwer, który nie wstaje przez brak klucza do powiadomień, zabiera
 * jedyną drogę do sesji zamiast zabrać jeden baner.
 *
 * Jedyny kanał to APNs apki natywnej; Web Push do PWA wycofano razem z PWA.
 * Dawne `RAROG_VAPID_*` w env są dla Raroga zmiennymi obcymi — Rarog nie ma
 * prawa reagować na ich obecność.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadConfig, logSecrets, parseApns, parsePushE2e, parsePushEnabled, parsePushRelay,
} from '../src/config.ts';
import { PUSH_E2E_ENV } from '../src/config-env.ts';
import type { ApnsKeyReader } from '../src/config.ts';

/** Środowisko poza demo — powiadomienia w demo są wyłączone bezwarunkowo. */
const prodEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  RAROG_ORIGINS: 'https://rarog.example.com',
  ...extra,
});

/** Dawne klucze Web Push — leżą w pliku sekretów powłoki, dopóki użytkownik ich nie skasuje. */
const VAPID_ENV = {
  RAROG_VAPID_PUBLIC: 'BPublicKeyBase64url',
  RAROG_VAPID_PRIVATE: 'PrivateKeyBase64url',
  RAROG_VAPID_SUBJECT: 'mailto:rarog@example.com',
};

describe('parsePushEnabled', () => {
  it('domyślnie włączone, 0/false wyłącza', () => {
    expect(parsePushEnabled(undefined)).toBe(true);
    expect(parsePushEnabled('')).toBe(true);
    expect(parsePushEnabled('1')).toBe(true);
    expect(parsePushEnabled('0')).toBe(false);
    expect(parsePushEnabled('false')).toBe(false);
  });
});

describe('pushEnabled — killswitch i komplet kluczy muszą zajść RAZEM', () => {
  it('brak kluczy → wyłączone, ale serwer WSTAJE (nigdy ConfigError)', () => {
    const config = loadConfig(prodEnv());
    expect(config.pushEnabled).toBe(false);
    expect(config.apns).toBeUndefined();
  });

  /*
   * Web Push wycofany: komplet `RAROG_VAPID_*` sam nie włącza już niczego, a klucz prywatny
   * nie ma czego szukać w configu — środowisko serwera go nie przepuszcza, ale ręczny start z pełnym env
   * nie może go wciągnąć z powrotem.
   */
  it('dawne zmienne VAPID i `RAROG_PUSH_PWA_MUTE` nie włączają kanału i nie lądują w configu', () => {
    const config = loadConfig(prodEnv({ ...VAPID_ENV, RAROG_PUSH_PWA_MUTE: '0' }));
    expect(config.pushEnabled).toBe(false);
    expect(config).not.toHaveProperty('vapid');
    expect(config).not.toHaveProperty('pushPwaMute');
    expect(JSON.stringify(config)).not.toContain('PrivateKeyBase64url');
  });
});

/*
 * Kanał APNs apki natywnej: cztery zmienne, komplet albo nic, i PLIK klucza z kontrolą praw.
 * Klucz EC P-256 generowany w teście — prawdziwego pliku klucza test nie widzi nigdy.
 */
describe('APNs — komplet albo nic, plik klucza z kontrolą praw', () => {
  const PEM = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    .privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const RSA_PEM = generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

  let dir = '';
  let keyFile = '';
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rarog-apns-key-'));
    keyFile = join(dir, 'klucz-apns');
    await writeFile(keyFile, PEM, { mode: 0o600 });
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const apnsEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    RAROG_APNS_KEY_PATH: keyFile, RAROG_APNS_KEY_ID: 'ABC123DEFG',
    RAROG_APNS_TEAM_ID: '97TDXJ84WH', RAROG_APNS_TOPIC: 'pl.useo.rarog', ...extra,
  });

  it('komplet z plikiem 0600 → `apns` w configu i kanał włączony', () => {
    const config = loadConfig(prodEnv(apnsEnv()));
    expect(config.apns).toEqual({
      privateKey: PEM, keyId: 'ABC123DEFG', teamId: '97TDXJ84WH', topic: 'pl.useo.rarog',
    });
    expect(config.apnsIssue).toBeUndefined();
    expect(config.pushEnabled).toBe(true);
  });

  it('prawa 0400 też przechodzą (jak klucz ASC w `ios-lib.sh`)', async () => {
    await chmod(keyFile, 0o400);
    expect(loadConfig(prodEnv(apnsEnv())).apns).toBeDefined();
  });

  it('brak wszystkich czterech → ani kanału, ani powodu w logu (stan domyślny)', () => {
    const config = loadConfig(prodEnv());
    expect(config.apns).toBeUndefined();
    expect(config.apnsIssue).toBeUndefined();
  });

  /*
   * Team ID i topic bywają wpisane jawnie, a ścieżka i Key ID przychodzą dopiero z kluczem — dopóki
   * użytkownik nie założy klucza, komplet NIE jest pełny. To normalny stan, nie błąd startu.
   */
  it('brak którejkolwiek z czterech → brak kanału, powód wymienia brakujące, serwer WSTAJE', () => {
    const config = loadConfig(prodEnv({ RAROG_APNS_TEAM_ID: '97TDXJ84WH', RAROG_APNS_TOPIC: 'pl.useo.rarog' }));
    expect(config.apns).toBeUndefined();
    expect(config.pushEnabled).toBe(false);
    expect(config.apnsIssue).toBe('missing RAROG_APNS_KEY_PATH, RAROG_APNS_KEY_ID (all or none)');
  });

  it.each([
    ['prawa 0644', async () => { await chmod(keyFile, 0o644); }, 'the APNs key file has mode 644; set chmod 600'],
    ['brak pliku', async () => { await rm(keyFile); }, 'RAROG_APNS_KEY_PATH does not point to a readable file'],
    ['klucz RSA', async () => { await writeFile(keyFile, RSA_PEM, { mode: 0o600 }); }, 'the APNs key file is not an EC P-256 key'],
    ['śmieci', async () => { await writeFile(keyFile, 'nie klucz', { mode: 0o600 }); }, 'the APNs key file is not a PEM private key'],
  ])('%s → kanał nie powstaje, powód bez ścieżki i bez treści, serwer WSTAJE', async (_name, spoil, issue) => {
    await spoil();
    const config = loadConfig(prodEnv(apnsEnv()));
    expect(config.apns).toBeUndefined();
    expect(config.pushEnabled).toBe(false);
    expect(config.apnsIssue).toBe(issue);
    expect(config.apnsIssue).not.toContain(dir);
  });

  it('zły format Key ID, Team ID albo topicu → powód, nie ConfigError', () => {
    expect(loadConfig(prodEnv(apnsEnv({ RAROG_APNS_KEY_ID: 'abc' }))).apnsIssue).toMatch(/RAROG_APNS_KEY_ID/);
    expect(loadConfig(prodEnv(apnsEnv({ RAROG_APNS_TEAM_ID: '97tdxj84wh' }))).apnsIssue).toMatch(/RAROG_APNS_TEAM_ID/);
    expect(loadConfig(prodEnv(apnsEnv({ RAROG_APNS_TOPIC: 'rarog' }))).apnsIssue).toMatch(/RAROG_APNS_TOPIC/);
    expect(loadConfig(prodEnv(apnsEnv({ RAROG_APNS_KEY_PATH: 'wzgledna-sciezka' }))).apnsIssue)
      .toMatch(/must be an absolute path/);
  });

  it('`~/` i `$HOME` w ścieżce rozwijają się do HOME (w cudzysłowie powłoka tego nie robi)', () => {
    const seen: string[] = [];
    const reader: ApnsKeyReader = (file) => { seen.push(file); return { mode: 0o600, text: PEM }; };
    expect(parseApns(apnsEnv({ HOME: '/Users/x', RAROG_APNS_KEY_PATH: '~/klucze.d/k' }), reader).apns).toBeDefined();
    expect(parseApns(apnsEnv({ HOME: '/Users/x', RAROG_APNS_KEY_PATH: '$HOME/klucze.d/k' }), reader).apns).toBeDefined();
    expect(seen).toEqual(['/Users/x/klucze.d/k', '/Users/x/klucze.d/k']);
  });

  it('RAROG_PUSH=0 ucisza kanał — klucz ZOSTAJE w configu i na liście `redact()`', () => {
    const config = loadConfig(prodEnv(apnsEnv({ RAROG_PUSH: '0' })));
    expect(config.pushEnabled).toBe(false);
    expect(config.apns?.privateKey).toBe(PEM);
    const secrets = logSecrets(config);
    expect(secrets).toContain(PEM);
    // Każda linia base64 klucza osobno — komunikat biblioteki bywa cytatem fragmentu PEM.
    for (const line of PEM.split('\n').filter((l) => l !== '' && !l.startsWith('-----'))) {
      expect(secrets).toContain(line);
    }
    expect(secrets.some((s) => s.startsWith('-----BEGIN') && !s.includes('\n'))).toBe(false);
  });

  it('demo nie czyta pliku klucza i nie pushuje', () => {
    const config = loadConfig({ RAROG_DEMO: '1', ...apnsEnv() });
    expect(config.apns).toBeUndefined();
    expect(config.apnsIssue).toBeUndefined();
    expect(config.pushEnabled).toBe(false);
  });

  /*
   * Ścieżka i Key ID przychodzą z `rarog serve`, więc są w env serwera — a env PTY, gita
   * i `claude agents` składa się z zamkniętych list. Sekrety APNs nie mają jak tam wejść.
   */
  it('zmienne APNs i treść klucza NIE wchodzą do środowiska terminala ani gita', () => {
    const config = loadConfig(prodEnv({ ...apnsEnv(), HOME: '/Users/x', PATH: '/bin' }));
    for (const base of [config.termEnvBase, config.gitEnvBase]) {
      expect(Object.keys(base).filter((k) => k.startsWith('RAROG_APNS'))).toEqual([]);
      expect(Object.values(base)).not.toContain(keyFile);
      expect(Object.values(base)).not.toContain(PEM);
    }
  });
});

/*
 * Przekaźnik push: `RAROG_PUSH_RELAY_URL` to SAM origin `https`. Zła wartość = brak przekaźnika i jedno
 * zdanie do logu startu, nigdy błąd startu; kanał powstaje przy kluczu ALBO przekaźniku; puste = dziś.
 */
describe('RAROG_PUSH_RELAY_URL — przekaźnik push', () => {
  it.each([
    ['https://push.rarog.ai', 'https://push.rarog.ai'],
    ['https://push.rarog.ai/', 'https://push.rarog.ai'],
    ['  https://Push.Rarog.AI:8443  ', 'https://push.rarog.ai:8443'],
  ])('`%s` → origin `%s`', (raw, origin) => {
    expect(parsePushRelay(raw)).toEqual({ relay: { origin } });
  });

  it.each([
    ['http://push.rarog.ai', /https/],
    ['push.rarog.ai', /is not a URL/],
    ['https://push.rarog.ai/v1', /bare origin/],
    ['https://push.rarog.ai/?x=1', /bare origin/],
    ['https://push.rarog.ai/#a', /bare origin/],
    ['https://push.rarog.ai?', /bare origin/],
    ['https://user:haslo@push.rarog.ai', /credentials/],
  ])('`%s` → brak przekaźnika z powodem', (raw, reason) => {
    const parsed = parsePushRelay(raw);
    expect(parsed.relay).toBeUndefined();
    expect(parsed.issue).toMatch(reason);
    expect(parsed.issue).toMatch(/^RAROG_PUSH_RELAY_URL /);
    // Powód nie powtarza wartości (dane logowania w adresie to sekret).
    expect(parsed.issue).not.toContain('haslo');
  });

  it('puste albo brak = brak przekaźnika bez powodu (dzisiejsza droga, to jest powrót)', () => {
    expect(parsePushRelay(undefined)).toEqual({});
    expect(parsePushRelay('   ')).toEqual({});
    const config = loadConfig(prodEnv({ RAROG_PUSH_RELAY_URL: '' }));
    expect(config.pushRelay).toBeUndefined();
    expect(config.pushRelayIssue).toBeUndefined();
    expect(config.pushEnabled).toBe(false);
  });

  it('sam przekaźnik (bez klucza APNs) włącza kanał; zła wartość — serwer wstaje bez kanału, z powodem', () => {
    const relayOnly = loadConfig(prodEnv({ RAROG_PUSH_RELAY_URL: 'https://push.rarog.ai' }));
    expect(relayOnly.pushRelay).toEqual({ origin: 'https://push.rarog.ai' });
    expect(relayOnly.apns).toBeUndefined();
    expect(relayOnly.pushEnabled).toBe(true);
    const bad = loadConfig(prodEnv({ RAROG_PUSH_RELAY_URL: 'http://push.rarog.ai' }));
    expect(bad.pushRelay).toBeUndefined();
    expect(bad.pushRelayIssue).toMatch(/https/);
    expect(bad.pushEnabled).toBe(false);
  });

  it('`RAROG_PUSH=0` gasi też przekaźnik; demo nie zna przekaźnika', () => {
    expect(loadConfig(prodEnv({ RAROG_PUSH_RELAY_URL: 'https://push.rarog.ai', RAROG_PUSH: '0' })).pushEnabled)
      .toBe(false);
    const demo = loadConfig({ RAROG_DEMO: '1', RAROG_PUSH_RELAY_URL: 'https://push.rarog.ai' });
    expect(demo.pushRelay).toBeUndefined();
    expect(demo.pushEnabled).toBe(false);
  });
});

/*
 * Treść banerów szyfrowana end-to-end: brak wartości = WŁĄCZONA, `0`/`false` = żadnych banerów (wpisy
 * pominięte). Flaga nie zależy od kanału ani od demo — o wysyłce i tak rozstrzyga `pushEnabled`.
 */

describe('RAROG_PUSH_E2E — treść banerów szyfrowana', () => {
  it('parser jak `parsePushEnabled`: brak i pusta = włączona, `0`/`false` wyłącza', () => {
    expect(PUSH_E2E_ENV).toBe('RAROG_PUSH_E2E');
    for (const raw of [undefined, '', '  ', '1', 'true', 'tak']) expect(parsePushE2e(raw), String(raw)).toBe(true);
    for (const raw of ['0', 'false']) expect(parsePushE2e(raw), raw).toBe(false);
  });

  it('pole `pushE2e` w configu: domyślnie `true`, `RAROG_PUSH_E2E=0` → `false`; kanał bez zmian', () => {
    expect(loadConfig(prodEnv()).pushE2e).toBe(true);
    const off = loadConfig(prodEnv({ RAROG_PUSH_E2E: '0', RAROG_PUSH_RELAY_URL: 'https://push.rarog.ai' }));
    expect(off.pushE2e).toBe(false);
    expect(off.pushEnabled).toBe(true);
  });
});
