/**
 * Strażnik wiązań: `wrangler.toml` ma dokładnie wiązania, klasy Durable Objects, migrację, cron i zmienne, które zna
 * kod (`src/worker.ts`, `src/config.ts`, `src/objects.ts`), a zmiennych tylko poza produkcją (`CLOCK_OFFSET`) nie ma
 * wcale; `package.json` ma te same narzędzia i wersje co przekaźnik push (`relay/package.json`).
 */
import { describe, expect, it } from 'vitest';
import pkg from '../package.json';
import relayPkg from '../../relay/package.json';
import toml from '../wrangler.toml?raw';
import relayToml from '../../relay/wrangler.toml?raw';
import {
  DEFAULT_QUOTAS, ENV_BINDINGS, ENV_SECRETS, ENV_TEST_VARS, ENV_VARS, RELAY_AUTH_VERSION,
} from '../src/config.ts';
import { DURABLE_OBJECT_CLASSES } from '../src/objects.ts';
import * as worker from '../src/worker.ts';
import type { Env } from '../src/worker.ts';

type Declared =
  | typeof ENV_VARS[number] | typeof ENV_TEST_VARS[number] | typeof ENV_SECRETS[number] | typeof ENV_BINDINGS[number];
/** Typ `Env` adaptera ma DOKŁADNIE nazwy z list (rozjazd = błąd kompilacji w typecheck). */
const envMatchesLists: [Exclude<keyof Env, Declared>, Exclude<Declared, keyof Env>] extends [never, never]
  ? true : false = true;

type Value = string | number | boolean | string[];
interface Table { [key: string]: Value | Table | Table[] }

/**
 * Minimalny parser TOML dla tego pliku: tabele `[a.b]`, tablice tabel `[[a.b]]`, klucze z napisem, liczbą,
 * wartością logiczną i jednoliniową tablicą napisów. Cokolwiek innego przewraca test — plik ma zostać prosty.
 */
function parseToml(text: string): Table {
  const root: Table = {};
  let current = root;
  const walk = (path: string[], array: boolean): Table => {
    let node = root;
    path.forEach((part, index) => {
      const last = index === path.length - 1;
      const existing = node[part];
      if (last && array) {
        const list = Array.isArray(existing) ? existing as Table[] : (node[part] = []) as Table[];
        const fresh: Table = {};
        list.push(fresh);
        node = fresh;
        return;
      }
      if (Array.isArray(existing)) node = existing[existing.length - 1] as Table;
      else if (typeof existing === 'object') node = existing;
      else node = (node[part] = {}) as Table;
    });
    return node;
  };
  const scalar = (value: string): Value => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    if (/^"[^"]*"$/.test(value)) return value.slice(1, -1);
    if (/^[0-9]+$/.test(value)) return Number(value);
    const list = /^\[(.*)\]$/.exec(value);
    if (list !== null) {
      const items = (list[1] ?? '').split(',').map((item) => item.trim());
      if (items.every((item) => /^"[^"]*"$/.test(item))) return items.map((item) => item.slice(1, -1));
    }
    throw new Error(`wartość: ${value}`);
  };
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+#.*$|^#.*$/, '').trim();
    if (line === '') continue;
    const header = /^(\[\[?)([A-Za-z0-9_.-]+)\]\]?$/.exec(line);
    if (header !== null) {
      current = walk((header[2] ?? '').split('.'), header[1] === '[[');
      continue;
    }
    const pair = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (pair === null) throw new Error(`nieznana linia TOML: ${line}`);
    current[pair[1] ?? ''] = scalar(pair[2] ?? '');
  }
  return root;
}

const config = parseToml(toml);
const relayConfig = parseToml(relayToml);

/** Placeholder `id` przestrzeni KV do czasu wpisania identyfikatora z konta właściciela (README, „Account values”). */
const KV_PLACEHOLDER = 'PLACEHOLDER-KV-DENIED-ID';

describe('wrangler.toml', () => {
  it('klucze najwyższego poziomu: Durable Objects, migracje, KV, licznik, cron; żadnych innych usług', () => {
    expect(Object.keys(config).sort()).toEqual([
      'compatibility_date', 'durable_objects', 'kv_namespaces', 'main', 'migrations', 'name', 'observability',
      'preview_urls', 'ratelimits', 'routes', 'triggers', 'vars', 'workers_dev',
    ]);
  });

  it('produkcja rarog-relay-auth na relay-auth.rarog.ai (Custom Domain), bez workers.dev i podglądu', () => {
    expect(config['name']).toBe('rarog-relay-auth');
    expect(config['routes']).toEqual([{ pattern: 'relay-auth.rarog.ai', custom_domain: true }]);
    expect(config['main']).toBe('src/worker.ts');
    expect(config['compatibility_date']).toBe(relayConfig['compatibility_date']);
    expect(config['workers_dev']).toBe(false);
    expect(config['preview_urls']).toBe(false);
    expect(config['observability']).toEqual({ enabled: true, head_sampling_rate: 1, logs: { invocation_logs: false } });
  });

  // Identyfikator konta to 32 znaki hex, tak jak `id` przestrzeni KV: jedyna dozwolona taka wartość to `id` KV.
  it('bez pola konta i bez identyfikatora konta; komentarz odsyła do CLOUDFLARE_ACCOUNT_ID', () => {
    expect(toml).not.toMatch(/^\s*account_id\s*=/m);
    const rest = toml.split('\n').filter((line) => !/^id = "[0-9a-f]{32}"$/.test(line)).join('\n');
    expect(rest).not.toMatch(/(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/i);
    expect(toml).toMatch(/^# .*`CLOUDFLARE_ACCOUNT_ID`/m);
  });

  it('Durable Objects: wiązania ENDPOINT, GATE, ADMIN → klasy eksportowane z worker.ts', () => {
    const bindings = (config['durable_objects'] as Table)['bindings'] as Table[];
    expect(bindings).toEqual([
      { name: 'ENDPOINT', class_name: 'Endpoint' },
      { name: 'GATE', class_name: 'Gate' },
      { name: 'ADMIN', class_name: 'Admin' },
    ]);
    for (const { class_name: name } of bindings) {
      expect(DURABLE_OBJECT_CLASSES as readonly unknown[], String(name)).toContain(name);
      expect(typeof (worker as Record<string, unknown>)[String(name)], String(name)).toBe('function');
    }
  });

  it('migracje: jedna, `v1`, wszystkie klasy z magazynem SQLite', () => {
    expect(config['migrations']).toEqual([{ tag: 'v1', new_sqlite_classes: [...DURABLE_OBJECT_CLASSES] }]);
  });

  it('KV lustra odmów: wiązanie DENIED, id placeholder albo identyfikator przestrzeni', () => {
    const kv = config['kv_namespaces'] as Table[];
    expect(kv.map((entry) => Object.keys(entry).sort())).toEqual([['binding', 'id']]);
    expect(kv[0]?.['binding']).toBe('DENIED');
    expect(String(kv[0]?.['id'])).toMatch(new RegExp(`^(?:${KV_PLACEHOLDER}|[0-9a-f]{32})$`));
  });

  it('liczniki RL_APP 60/60 s i RL_REGISTER 10/60 s; namespace_id rozłączne z licznikami przekaźnika push', () => {
    const shape = (scope: Table) => (scope['ratelimits'] as Table[]).map((entry) => ({
      name: entry['name'], namespace_id: entry['namespace_id'], ...(entry['simple'] as Table),
    }));
    expect(shape(config)).toEqual([
      { name: 'RL_APP', namespace_id: '8201', limit: 60, period: 60 },
      { name: 'RL_REGISTER', namespace_id: '8202', limit: 10, period: 60 },
    ]);
    const taken = new Set(shape(relayConfig).map((entry) => entry.namespace_id));
    for (const entry of shape(config)) expect(taken.has(entry.namespace_id), String(entry.namespace_id)).toBe(false);
  });

  it('cron kanarka co 6 h; worker.ts ma `scheduled`', () => {
    expect(config['triggers']).toEqual({ crons: ['0 */6 * * *'] });
    expect(typeof worker.default.scheduled).toBe('function');
  });

  it('vars: the full ENV_VARS set, the DeviceCheck gate in shadow mode, quotas = defaults', () => {
    const vars = config['vars'] as Record<string, Value>;
    expect(Object.keys(vars).sort()).toEqual([...ENV_VARS].sort());
    expect(vars).toEqual({
      DEPLOY_SHA: 'dev', GATE_KIND: 'devicecheck', ENFORCE: '0',
      APPLE_TEAM_ID: (relayConfig['vars'] as Record<string, Value>)['APNS_TEAM_ID'],
      REGISTER_MONTHLY_QUOTA: String(DEFAULT_QUOTAS.registerMonthly),
      REGISTER_DAILY_BRAKE: String(DEFAULT_QUOTAS.registerDailyBrake),
      SPONSOR_QUOTA: String(DEFAULT_QUOTAS.sponsor), SPONSORED_LIVE_MAX: String(DEFAULT_QUOTAS.sponsoredLive),
      QUOTA_GRACE_UNTIL: '', DIAG_UNTIL: '',
    });
  });

  it('zmiennych tylko poza produkcją nie ma w pliku (ani jako klucza, ani w [vars])', () => {
    for (const name of ENV_TEST_VARS) {
      expect(toml.split('\n').some((line) => new RegExp(`^\\s*${name}\\s*=`).test(line)), name).toBe(false);
      expect(Object.keys(config['vars'] as Table), name).not.toContain(name);
    }
  });

  it('wiązania w pliku = ENV_BINDINGS', () => {
    const names = [
      ...((config['durable_objects'] as Table)['bindings'] as Table[]).map((entry) => entry['name']),
      ...(config['kv_namespaces'] as Table[]).map((entry) => entry['binding']),
      ...(config['ratelimits'] as Table[]).map((entry) => entry['name']),
    ];
    expect(names).toEqual([...ENV_BINDINGS]);
  });

  it('typ Env = zmienne + zmienne testowe + sekrety + wiązania', () => {
    expect(envMatchesLists).toBe(true);
  });

  it('sekrety tylko jako nazwy w komentarzu', () => {
    const lines = toml.split('\n');
    for (const secret of ENV_SECRETS) {
      expect(lines.some((line) => line.startsWith('#') && line.includes(secret)), secret).toBe(true);
      expect(lines.some((line) => new RegExp(`^\\s*${secret}\\s*=`).test(line)), secret).toBe(false);
    }
  });
});

describe('package.json', () => {
  it('prywatny, ESM, bez zależności czasu działania; narzędzia i wersje te same co w relay/package.json', () => {
    expect(pkg.private).toBe(true);
    expect(pkg.type).toBe('module');
    expect(Object.keys(pkg)).not.toContain('dependencies');
    expect(pkg.devDependencies).toEqual(relayPkg.devDependencies);
    expect(pkg.scripts).toEqual({ test: 'vitest run', typecheck: 'tsc --noEmit' });
  });

  it('wersja w /v1/health = version z package.json', () => {
    expect(RELAY_AUTH_VERSION).toBe(pkg.version);
  });
});
