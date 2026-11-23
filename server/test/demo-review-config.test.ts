/**
 * Konfiguracja trybu recenzji demo: `RAROG_DEMO_REVIEW_CODE` włącza tryb
 * recenzji tylko razem z `RAROG_DEMO=1`, jednym originem `https` i jawnym katalogiem danych; strażnik epoki urządzeń
 * działa w nim jak poza demo, a wymuszenia demo zostają bez zmian.
 *
 * Kod recenzenta jest sekretem: każdy test losuje go w czasie biegu (`randomBytes`), a żaden komunikat
 * `ConfigError` ani wydruk środowiska go nie zawiera. Wiersze z `RAROG_DEMO_LANG` (bez
 * wartości `en`) stoją w ostatnim bloku.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseServeFlags, printableEnv } from '../src/cli/serve.ts';
import { createDeviceStore, createPairing } from '../src/auth/index.ts';
import { SERVER_ENV } from '../src/config-env.ts';
import { ConfigError, DEMO_REVIEW_MAX_DEVICES, loadConfig, logSecrets } from '../src/config.ts';
import { HOOK_CHANNEL_MODE_OFF } from '../src/herdr/dialogs/hook/contract.ts';

const ORIGIN = 'https://demo.rarog.example';
const NAME = 'RAROG_DEMO_REVIEW_CODE';

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const freshDir = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'a5-recenzja-konf-'));
  dirs.push(dir);
  return dir;
};

/** Kod recenzenta w kształcie kodu parowania (32 losowe bajty base64url), inny w każdym wywołaniu. */
const freshCode = (): string => randomBytes(32).toString('base64url');

/** Środowisko poprawnego trybu recenzji z podanym kodem. */
const reviewEnv = (code: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  RAROG_DEMO: '1', [NAME]: code, RAROG_DATA_DIR: freshDir(), RAROG_ORIGINS: ORIGIN, ...extra,
});

/** `loadConfig` ma rzucić `ConfigError` z podanym fragmentem, a komunikat nie może nieść kodu. */
function refused(env: NodeJS.ProcessEnv, code: string, fragment: RegExp): string {
  let message = '';
  try {
    loadConfig(env);
  } catch (err) {
    expect(err, 'oczekiwany ConfigError').toBeInstanceOf(ConfigError);
    message = (err as Error).message;
  }
  expect(message, 'start przeszedł zamiast odmowy').not.toBe('');
  expect(message).toMatch(fragment);
  expect(message.includes(code), 'komunikat ConfigError niesie wartość kodu recenzenta').toBe(false);
  return message;
}

describe('tryb recenzji: włączenie i kształt konfiguracji', () => {
  it('kod z `RAROG_DEMO=1`, jednym originem https i jawnym katalogiem → `demoReview` z sufitem 10', () => {
    const code = freshCode();
    const config = loadConfig(reviewEnv(code));
    expect(config.demo).toBe(true);
    expect(config.demoReview).toEqual({ code, maxDevices: 10 });
    expect(DEMO_REVIEW_MAX_DEVICES).toBe(10);
    expect(config.originAllowList).toEqual([ORIGIN]);
  });

  it('bez kodu (brak albo pusty napis) `demoReview` to `null` — w demo i poza nim', () => {
    expect(loadConfig({ RAROG_DEMO: '1' }).demoReview).toBeNull();
    expect(loadConfig({ RAROG_DEMO: '1', [NAME]: '' }).demoReview).toBeNull();
    const production = loadConfig({ RAROG_ORIGINS: ORIGIN, RAROG_DATA_DIR: freshDir(), [NAME]: '' });
    expect(production.demoReview).toBeNull();
  });

  it('kod jest sekretem: rejestr, lista `logSecrets`, `--env` odmawia bez wartości, wydruk środowiska maskuje', () => {
    expect(SERVER_ENV[NAME]).toBe('secret');
    const code = freshCode();
    expect(logSecrets(loadConfig(reviewEnv(code)))).toContain(code);
    expect(logSecrets(loadConfig({ RAROG_DEMO: '1' }))).toEqual([]);
    let refusal = '';
    try {
      parseServeFlags(['serve', '--env', `${NAME}=${code}`], freshDir());
    } catch (err) {
      refusal = (err as Error).message;
    }
    expect(refusal).toContain(NAME);
    expect(refusal.includes(code)).toBe(false);
    expect(printableEnv({ [NAME]: code })).toEqual([`${NAME}=<set>`]);
  });
});

describe('tryb recenzji: odmowy startu bez wartości kodu w komunikacie', () => {
  it('kod bez `RAROG_DEMO=1` → `ConfigError` z nazwą zmiennej', () => {
    const code = freshCode();
    for (const demo of [undefined, '', '0']) {
      const env: NodeJS.ProcessEnv = { RAROG_ORIGINS: ORIGIN, RAROG_DATA_DIR: freshDir(), [NAME]: code };
      if (demo !== undefined) env['RAROG_DEMO'] = demo;
      refused(env, code, /RAROG_DEMO_REVIEW_CODE.*RAROG_DEMO=1/);
    }
  });

  it('kod w złym kształcie → `ConfigError` bez wartości', () => {
    const code = freshCode();
    const bad = [
      code.slice(1),
      `${code}A`,
      `+${code.slice(1)}`,
      `${code.slice(0, 42)}=`,
      `${code.slice(0, 20)} ${code.slice(21)}`,
      'krotki',
    ];
    for (const value of bad) refused(reviewEnv(value), value, /RAROG_DEMO_REVIEW_CODE must be/);
  });

  it('kod przy `RAROG_ORIGINS` pustym, z dwoma wpisami, `http:` albo nie samym originem → `ConfigError`', () => {
    const code = freshCode();
    refused(reviewEnv(code, { RAROG_ORIGINS: undefined }), code, /RAROG_ORIGINS/);
    refused(reviewEnv(code, { RAROG_ORIGINS: '' }), code, /RAROG_ORIGINS/);
    refused(reviewEnv(code, { RAROG_ORIGINS: `${ORIGIN},https://drugi.rarog.example` }), code, /exactly one/);
    refused(reviewEnv(code, { RAROG_ORIGINS: 'http://demo.rarog.example' }), code, /https/);
    refused(reviewEnv(code, { RAROG_ORIGINS: 'http://127.0.0.1:8930' }), code, /https/);
    refused(reviewEnv(code, { RAROG_ORIGINS: `${ORIGIN}/sciezka` }), code, /bare https origin/);
    refused(reviewEnv(code, { RAROG_ORIGINS: 'nie-adres' }), code, /RAROG_ORIGINS/);
  });

  it('kod bez jawnego `RAROG_DATA_DIR` → `ConfigError` (demo wziąłby katalog w tmp)', () => {
    const code = freshCode();
    refused(reviewEnv(code, { RAROG_DATA_DIR: undefined }), code, /RAROG_DATA_DIR/);
    refused(reviewEnv(code, { RAROG_DATA_DIR: '' }), code, /RAROG_DATA_DIR/);
  });

  it('kod, epoka domyślna i aktywne urządzenie innej epoki → `ConfigError` strażnika epoki; zwykłe demo bez zmian', async () => {
    const dir = freshDir();
    const store = createDeviceStore({ dataDir: dir, epoch: '2', log: () => {} });
    const pairing = createPairing({ store, epoch: '2' });
    expect(pairing.redeem({ code: pairing.issue('admin').code, label: 'iPhone' }).ok).toBe(true);
    await store.persist();
    await store.flush();
    const code = freshCode();
    refused(reviewEnv(code, { RAROG_DATA_DIR: dir }), code, /RAROG_AUTH_EPOCH/);
    // Jawna epoka urządzeń przechodzi, a demo bez kodu strażnika nie ma (dziś: dysk demo jest w tmp).
    expect(loadConfig(reviewEnv(code, { RAROG_DATA_DIR: dir, RAROG_AUTH_EPOCH: '2' })).epoch).toBe('2');
    expect(loadConfig({ RAROG_DEMO: '1', RAROG_DATA_DIR: dir }).demoReview).toBeNull();
  });

  it('kod i `RAROG_IROH=1` → `ConfigError` jak w demo dziś', () => {
    const code = freshCode();
    refused(reviewEnv(code, { RAROG_IROH: '1', RAROG_IROH_RELAY: 'https://relay.example.net/' }), code,
      /RAROG_IROH=1 does not work in demo mode/);
  });
});

describe('tryb recenzji: wymuszenia', () => {
  it('kod, `RAROG_VOICE=1` i klucz Soniox → `voiceEnabled: false`; zwykłe demo z tym samym env → `true`', () => {
    const voice = { RAROG_VOICE: '1', SONIOX_API_KEY: randomBytes(16).toString('hex') };
    expect(loadConfig(reviewEnv(freshCode(), voice)).voiceEnabled).toBe(false);
    expect(loadConfig({ RAROG_DEMO: '1', ...voice }).voiceEnabled).toBe(true);
  });

  it('kod i dowolne flagi → te same wymuszenia demo co bez kodu', () => {
    const flags: NodeJS.ProcessEnv = {
      RAROG_PUSH: '1', RAROG_PUSH_RELAY_URL: 'https://push.rarog.example', RAROG_REFUSAL_DUMPS: '1',
      RAROG_CODEX_STATUS: '1', RAROG_CLI_WAITING: '1', RAROG_AGENT_FILES: '1', RAROG_QUEUE_ECHO: '1',
      RAROG_CONSENT_CHANNEL: 'shadow', RAROG_TERM: '1',
    };
    const review = loadConfig(reviewEnv(freshCode(), flags));
    const demo = loadConfig({ RAROG_DEMO: '1', ...flags });
    const forced = (config: ReturnType<typeof loadConfig>): Record<string, unknown> => ({
      pushEnabled: config.pushEnabled, refusalDumps: config.refusalDumps, codexStatusEnabled: config.codexStatusEnabled,
      cliWaiting: config.cliWaiting, agentFiles: config.agentFiles, queueEcho: config.queueEcho,
      consentChannel: config.consentChannel, termEnabled: config.termEnabled, pushRelay: config.pushRelay,
    });
    expect(forced(review)).toEqual({
      pushEnabled: false, refusalDumps: false, codexStatusEnabled: false, cliWaiting: false, agentFiles: false,
      queueEcho: false, consentChannel: HOOK_CHANNEL_MODE_OFF, termEnabled: false, pushRelay: undefined,
    });
    expect(forced(review)).toEqual(forced(demo));
  });
});

describe('język treści demo `RAROG_DEMO_LANG`', () => {
  const LANG = 'RAROG_DEMO_LANG';

  it('zmienna zwykła w rejestrze; bez wartości (brak albo pusty napis) `en` — w demo, w recenzji i poza demo', () => {
    expect(SERVER_ENV[LANG]).toBe('plain');
    expect(loadConfig({ RAROG_DEMO: '1' }).demoLang).toBe('en');
    expect(loadConfig({ RAROG_DEMO: '1', [LANG]: '' }).demoLang).toBe('en');
    expect(loadConfig({ RAROG_DEMO: '1', [LANG]: '  ' }).demoLang).toBe('en');
    expect(loadConfig(reviewEnv(freshCode())).demoLang).toBe('en');
    expect(loadConfig(reviewEnv(freshCode(), { [LANG]: '' })).demoLang).toBe('en');
    expect(loadConfig({ RAROG_ORIGINS: ORIGIN, RAROG_DATA_DIR: freshDir() }).demoLang).toBe('en');
  });

  it('`en` i `pl` w zwykłym demo przechodzą', () => {
    expect(loadConfig({ RAROG_DEMO: '1', [LANG]: 'en' }).demoLang).toBe('en');
    expect(loadConfig({ RAROG_DEMO: '1', [LANG]: 'pl' }).demoLang).toBe('pl');
    expect(loadConfig({ RAROG_DEMO: '1', [LANG]: ' pl ' }).demoLang).toBe('pl');
  });

  it('kod recenzenta i `RAROG_DEMO_LANG=pl` → `ConfigError` bez wartości kodu; `en` przechodzi', () => {
    const code = freshCode();
    refused(reviewEnv(code, { [LANG]: 'pl' }), code, /RAROG_DEMO_LANG=pl does not work with RAROG_DEMO_REVIEW_CODE/);
    expect(loadConfig(reviewEnv(code, { [LANG]: 'en' })).demoLang).toBe('en');
  });

  it('nieznana wartość → `ConfigError` także poza recenzją i poza demo', () => {
    for (const value of ['xx', 'EN', 'pl-PL', 'de']) {
      const message = refused({ RAROG_DEMO: '1', [LANG]: value }, freshCode(), /RAROG_DEMO_LANG must be en or pl/);
      expect(message).toContain(value);
      refused({ RAROG_ORIGINS: ORIGIN, RAROG_DATA_DIR: freshDir(), [LANG]: value }, freshCode(),
        /RAROG_DEMO_LANG must be en or pl/);
    }
    const code = freshCode();
    refused(reviewEnv(code, { [LANG]: 'xx' }), code, /RAROG_DEMO_LANG must be en or pl/);
  });
});
