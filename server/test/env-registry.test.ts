/**
 * Strażnik rejestru zmiennych serwera (`server/src/config-env.ts`).
 *
 * Rejestr ma być JEDYNĄ listą nazw, które serwer czyta: z niego weźmie nazwy walidacja pliku konfiguracji
 * i allow-lista `rarog serve`, więc nazwa czytana poza rejestrem byłaby zmienną, której nowa droga startu
 * nie poda serwerowi, a wpis nieczytany — zmienną, którą przepuszcza bez powodu. Dlatego równość w obie strony
 * sprawdza tu ŻYWY odczyt (środowisko-szpieg podane `loadConfig`, `liveSessionsEnv` i `tailnetEnv`), a nie skan
 * tekstu, oraz tekst `config.ts`: jedyna droga do środowiska to `readEnv`, hurtem tylko prefiks gita.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  COMPANION_ENV_PASSTHROUGH, GIT_ENV_PASSTHROUGH, LIVE_SESSIONS_ENV_PASSTHROUGH, MAX_PANES_ENV, PR_STATUS_ENV,
  PR_STATUS_ENV_PASSTHROUGH, SERVER_ENV, TAILNET_ENV_PASSTHROUGH, TERM_ENV_PASSTHROUGH, readEnv, registryNameOf,
} from '../src/config-env.ts';
import type { ServerEnvKind } from '../src/config-env.ts';
import { loadConfig } from '../src/config.ts';
import { liveSessionsEnv } from '../src/live-sessions.ts';
import { tailnetEnv } from '../src/tailnet.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => readFileSync(path.join(REPO, rel), 'utf8');

const temporary: string[] = [];
afterAll(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});

/**
 * Środowisko-szpieg: zapisuje każdą nazwę, o którą ktoś zapytał (`get`, `in`). Wyliczenie kluczy
 * (`Object.entries`, `{ ...env }`) zależy od `enumeration`:
 * - `empty` — pusta lista; tylko dla `loadConfig`, gdzie jedyne wyliczenie to prefiks gita w `parseGitEnvBase`,
 *   a kopię środowiska w `config.ts` wyklucza skan tekstu niżej;
 * - `throw` — wyjątek; dla `liveSessionsEnv` i `tailnetEnv`, które czytają tylko nazwy z list. Kopia środowiska
 *   z pustą listą kluczy ukryłaby odczyt nazwy spoza rejestru.
 */
function spy(
  values: NodeJS.ProcessEnv, enumeration: 'empty' | 'throw',
): { env: NodeJS.ProcessEnv; reads: Set<string> } {
  const reads = new Set<string>();
  const env = new Proxy({ ...values }, {
    get(target, key, receiver) {
      if (typeof key === 'string') reads.add(key);
      return Reflect.get(target, key, receiver) as unknown;
    },
    has(target, key) {
      if (typeof key === 'string') reads.add(key);
      return Reflect.has(target, key);
    },
    ownKeys: () => {
      if (enumeration === 'throw') throw new Error('szpieg: wyliczanie środowiska zabronione');
      return [];
    },
  });
  return { env, reads };
}

/** Środowisko produkcyjne bez `RAROG_DATA_DIR`: `HOME` i baza XDG w katalogu tymczasowym, bez gniazda herdr. */
function productionValues(): NodeJS.ProcessEnv {
  const base = mkdtempSync(path.join(os.tmpdir(), 'rejestr-zmiennych-'));
  temporary.push(base);
  return {
    RAROG_ORIGINS: 'https://rarog.example',
    RAROG_HERDR_SOCKET: path.join(base, 'brak-gniazda.sock'),
    HOME: path.join(base, 'home'),
    XDG_DATA_HOME: path.join(base, 'dane'),
  };
}

const sorted = (names: Iterable<string>): string[] => [...new Set(names)].sort();
const ofKind = (kind: ServerEnvKind): string[] =>
  sorted(Object.entries(SERVER_ENV).filter(([, value]) => value === kind).map(([name]) => name));

describe('rejestr zmiennych serwera: serwer czyta dokładnie to, co w rejestrze', () => {
  it('każdy wpis jest czytany i nic spoza rejestru (produkcja, `claude agents`, `tailscale`)', () => {
    const values = productionValues();
    const production = spy(values, 'empty');
    const config = loadConfig(production.env);
    // Bez `RAROG_DATA_DIR` katalog liczy reguła z bazy XDG — odczyt przeszedł przez szpiega.
    expect(config.dataDir).toBe(path.join(values['XDG_DATA_HOME'] as string, 'rarog'));
    const live = spy(values, 'throw');
    liveSessionsEnv(live.env);
    const tailnet = spy(values, 'throw');
    tailnetEnv(tailnet.env);
    expect(sorted([...production.reads, ...live.reads, ...tailnet.reads])).toEqual(sorted(Object.keys(SERVER_ENV)));
  });

  it('demo i jawne `RAROG_DATA_DIR` nie czytają niczego spoza rejestru', () => {
    const registry = new Set(Object.keys(SERVER_ENV));
    const demo = spy({ RAROG_DEMO: '1' }, 'empty');
    loadConfig(demo.env);
    const explicit = spy({ ...productionValues(), RAROG_DATA_DIR: path.join(os.tmpdir(), 'rejestr-jawny') }, 'empty');
    loadConfig(explicit.env);
    expect([...demo.reads, ...explicit.reads].filter((name) => !registry.has(name))).toEqual([]);
  });

  it('szpieg bez wyliczania nie przepuszcza kopii środowiska (odczyt z kopii nie znika po cichu)', () => {
    const copying = (base: NodeJS.ProcessEnv): string | undefined => ({ ...base })['LC_ALL'];
    expect(() => copying(spy({ LC_ALL: 'C' }, 'throw').env)).toThrow(/wyliczanie środowiska zabronione/);
  });

  it('`config.ts` sięga po środowisko wyłącznie przez `readEnv`; hurtem tylko prefiks gita', () => {
    const code = read('server/src/config.ts');
    // Moduły obszarów z `server/src/config/` nie sięgają po środowisko wcale: wartości podaje im `loadConfig`.
    const modules = readdirSync(path.join(REPO, 'server/src/config')).map((name) => read(`server/src/config/${name}`));
    expect(modules.filter((text) => /\breadEnv\(|process\.env|NodeJS\.ProcessEnv/.test(text))).toEqual([]);
    // `env[…]` i `env.X` poza `readEnv` (nie łapie `process.env` ani nazwy pliku `config-env.ts`).
    expect(code.match(/(?<![\w.-])env(?:\s*\[|\.[A-Za-z_])/g) ?? []).toEqual([]);
    expect(code.match(/Object\.(?:keys|values|entries)\(env\)|\.\.\.env\b/g) ?? []).toEqual(['Object.entries(env)']);
    const start = code.indexOf('export function parseGitEnvBase(');
    expect(start, 'zniknął `parseGitEnvBase`').toBeGreaterThan(-1);
    const body = code.slice(start, code.indexOf('\n}\n', start));
    expect(body, 'odczyt hurtowy wyszedł poza parser przepustek gita').toContain('Object.entries(env)');
  });

  it('stałe nazw zmiennych mają jeden dom: rejestr', () => {
    const offenders: string[] = [];
    const walk = (rel: string): void => {
      for (const entry of readdirSync(path.join(REPO, rel), { withFileTypes: true })) {
        const child = `${rel}/${entry.name}`;
        if (entry.isDirectory()) walk(child);
        else if (child !== 'server/src/config-env.ts' && /^export const [A-Z0-9_]+_ENV = '/m.test(read(child))) {
          offenders.push(child);
        }
      }
    };
    walk('server/src');
    expect(offenders).toEqual([]);
  });
});

describe('rejestr zmiennych serwera: jedna nazwa na zmienną', () => {
  it('`readEnv` czyta nazwę z rejestru, pusty napis jest wartością', () => {
    expect(readEnv({ RAROG_PORT: '9002' }, 'RAROG_PORT')).toBe('9002');
    expect(readEnv({ RAROG_PORT: '' }, 'RAROG_PORT')).toBe('');
    expect(readEnv({}, 'RAROG_PORT')).toBeUndefined();
    expect(loadConfig({ RAROG_DEMO: '1', RAROG_PORT: '9005' }).port).toBe(9005);
  });

  it('`registryNameOf`: nazwa z rejestru albo `undefined`, także dla nazw z prototypu', () => {
    expect(registryNameOf('RAROG_MAX_PANES')).toBe(MAX_PANES_ENV);
    expect(registryNameOf('SONIOX_API_KEY')).toBe('SONIOX_API_KEY');
    expect(registryNameOf('RAROG_NIE_MA')).toBeUndefined();
    expect(registryNameOf('toString')).toBeUndefined();
  });
});

describe('rejestr zmiennych serwera: rodzaje i nazwy zakazane', () => {
  it('sekrety i zmienne „tylko proces” to dokładnie listy z planu', () => {
    expect(ofKind('secret'))
      .toEqual([
        'OPENAI_API_KEY', 'RAROG_APNS_KEY_ID', 'RAROG_APNS_KEY_PATH', 'RAROG_DEMO_REVIEW_CODE', 'RAROG_IROH_KEY',
        'SONIOX_API_KEY',
      ]);
    expect(ofKind('process')).toEqual(['RAROG_DATA_DIR', 'XDG_DATA_HOME']);
  });

  it('przepustki to dokładnie nazwy z list procesów potomnych plus `TERM` (`tailnetEnv`)', () => {
    expect(ofKind('passthrough')).toEqual(sorted([
      ...TERM_ENV_PASSTHROUGH, ...GIT_ENV_PASSTHROUGH, ...LIVE_SESSIONS_ENV_PASSTHROUGH, ...TAILNET_ENV_PASSTHROUGH,
      ...COMPANION_ENV_PASSTHROUGH, ...PR_STATUS_ENV_PASSTHROUGH,
      'TERM',
    ]));
  });

  it('the PR status flag is plain; its `gh` passthrough carries no secret and no `GH_TOKEN`', () => {
    expect(SERVER_ENV[PR_STATUS_ENV]).toBe('plain');
    expect([...PR_STATUS_ENV_PASSTHROUGH].sort()).toEqual(['HOME', 'LANG', 'LOGNAME', 'PATH', 'TMPDIR', 'USER']);
  });

  it('zwykłe to `RAROG_*` i host Soniox', () => {
    const plain = ofKind('plain');
    expect(plain.filter((name) => !name.startsWith('RAROG_') && name !== 'SONIOX_API_HOST'),
      'nowa zmienna zwykła ma prefiks RAROG_').toEqual([]);
  });

  // Obce zmienne APNs ze startu serwera (mapowane tam na `RAROG_APNS_*`) wykluczają trzy testy wyżej: każda nazwa jest
  // sekretem albo „tylko procesem” z zamkniętej listy, przepustką z list procesów potomnych albo nazwą Raroga.
  it('nie ma kluczy VAPID', () => {
    expect(Object.keys(SERVER_ENV).filter((name) => name.startsWith('RAROG_VAPID_'))).toEqual([]);
    expect(read('server/src/config-env.ts')).not.toContain('RAROG_VAPID');
  });
});
