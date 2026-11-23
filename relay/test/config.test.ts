/**
 * Konfiguracja wdrożenia: `wrangler.toml` bez magazynu, jedno środowisko — produkcja na Custom Domain, polityka
 * `v2` ze sprawdzeniem `/v1/health` w komentarzu, sekrety tylko jako nazwy w komentarzu, nazwy zgodne z typem `Env`;
 * `package.json` z jedną zależnością czasu działania.
 */
import { describe, expect, it } from 'vitest';
import pkg from '../package.json';
import toml from '../wrangler.toml?raw';
import { ENV_SECRETS, ENV_VARS, RELAY_VERSION } from '../src/config.ts';
import { ENV_BINDINGS } from '../src/worker.ts';
import type { Env } from '../src/worker.ts';

type Declared = typeof ENV_VARS[number] | typeof ENV_SECRETS[number] | typeof ENV_BINDINGS[number];
/** Typ `Env` adaptera ma DOKŁADNIE nazwy z list (rozjazd = błąd kompilacji w typecheck). */
const envMatchesLists: [Exclude<keyof Env, Declared>, Exclude<Declared, keyof Env>] extends [never, never]
  ? true : false = true;

type Value = string | number | boolean;
interface Table { [key: string]: Value | Table | Table[] }

/**
 * Minimalny parser TOML dla tego pliku: tabele `[a.b]`, tablice tabel `[[a.b]]`, klucze z napisem, liczbą
 * i wartością logiczną. Cokolwiek innego przewraca test — plik ma zostać prosty.
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
        const list = Array.isArray(existing) ? existing : (node[part] = []) as Table[];
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
    const value = pair[2] ?? '';
    current[pair[1] ?? ''] = value === 'true' ? true : value === 'false' ? false
      : /^"[^"]*"$/.test(value) ? value.slice(1, -1)
        : /^[0-9]+$/.test(value) ? Number(value) : (() => { throw new Error(`wartość: ${value}`); })();
  }
  return root;
}

const config = parseToml(toml);

describe('wrangler.toml', () => {
  it('jedyne bindingi to liczniki Rate Limiting; żadnego magazynu ani usług', () => {
    const forbidden = [
      'kv_namespaces', 'd1_databases', 'r2_buckets', 'durable_objects', 'queues', 'vectorize', 'hyperdrive',
      'analytics_engine_datasets', 'workflows', 'secrets_store_secrets', 'services', 'browser', 'ai', 'unsafe',
      'migrations', 'site', 'assets', 'triggers',
    ];
    for (const key of forbidden) expect(Object.keys(config), key).not.toContain(key);
    // Bez `[env.*]`: jedno środowisko. Staging, gdy będzie potrzebny, to osobny Worker
    // z własnymi `routes`, `vars`, `ratelimits` i `PASS_KEYS` — ten test trzeba będzie wtedy rozszerzyć.
    expect(Object.keys(config).sort()).toEqual([
      'compatibility_date', 'main', 'name', 'observability', 'preview_urls', 'ratelimits', 'routes', 'vars',
      'workers_dev',
    ]);
  });

  it('produkcja rarog-relay na push.rarog.ai (Custom Domain)', () => {
    expect(config['name']).toBe('rarog-relay');
    expect(config['routes']).toEqual([{ pattern: 'push.rarog.ai', custom_domain: true }]);
    expect(config['main']).toBe('src/worker.ts');
    expect(config['compatibility_date']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  /*
   * Konto należy do wdrażającego: wrangler bierze je z `CLOUDFLARE_ACCOUNT_ID`
   * (`relay/README.md`, „Account and domain”). Pole `account_id` w pliku wygrywa ze zmienną, więc wpisane z powrotem po
   * cichu przestawiłoby każde wdrożenie na to konto. Identyfikator konta to 32 znaki hex: nie ma go też w komentarzu.
   */
  it('bez pola konta i bez identyfikatora konta; komentarz odsyła do CLOUDFLARE_ACCOUNT_ID', () => {
    expect(toml).not.toMatch(/^\s*account_id\s*=/m);
    expect(toml).not.toMatch(/(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/i);
    expect(toml).toMatch(/^# .*`CLOUDFLARE_ACCOUNT_ID`/m);
  });

  it('bez workers.dev, bez adresów podglądu, bez logów wywołań', () => {
    expect(config['workers_dev']).toBe(false);
    expect(config['preview_urls']).toBe(false);
    expect(config['observability']).toEqual({ enabled: true, head_sampling_rate: 1, logs: { invocation_logs: false } });
  });

  /*
   * Produkcja na `v2`, jedynej polityce: serwer wysyła wyłącznie banery v2. Sprawdzenie wdrożonej polityki
   * (`/v1/health` → `"alertPolicy":"v2"`) stoi w komentarzu przy zmiennej.
   */
  it('polityka: produkcja `v2`, sprawdzenie `/v1/health` w komentarzu; zmienne komplet', () => {
    const vars = config['vars'] as Record<string, Value>;
    expect(vars['ALERT_POLICY']).toBe('v2');
    expect(toml).toContain('"alertPolicy":"v2"');
    expect(Object.keys(vars).sort()).toEqual([...ENV_VARS].sort());
    expect(vars['APNS_TEAM_ID']).toMatch(/^[A-Z0-9]{10}$/);
    expect(vars['APNS_ENVIRONMENTS']).toBe('development,production');
    expect(vars['PASS_KID']).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
  });

  it('liczniki: pass 10/60 s, push 60/60 s, push per adres 600/60 s; namespace 8101–8103', () => {
    const shape = (scope: Table) => (scope['ratelimits'] as Table[]).map((entry) => ({
      name: entry['name'], namespace_id: entry['namespace_id'], ...(entry['simple'] as Table),
    }));
    expect(shape(config)).toEqual([
      { name: 'RL_PASS', namespace_id: '8101', limit: 10, period: 60 },
      { name: 'RL_PUSH', namespace_id: '8102', limit: 60, period: 60 },
      { name: 'RL_PUSH_ADDR', namespace_id: '8103', limit: 600, period: 60 },
    ]);
    expect(shape(config).map((entry) => entry.name)).toEqual([...ENV_BINDINGS]);
  });

  it('typ Env = zmienne + sekrety + bindingi', () => {
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
  it('prywatny, ESM, jedna zależność czasu działania (@noble/curves), wersje dokładne', () => {
    expect(pkg.private).toBe(true);
    expect(pkg.type).toBe('module');
    expect(Object.keys(pkg.dependencies)).toEqual(['@noble/curves']);
    expect(Object.keys(pkg.devDependencies).sort())
      .toEqual(['@cloudflare/workers-types', 'typescript', 'vitest', 'wrangler']);
    for (const version of [...Object.values(pkg.dependencies), ...Object.values(pkg.devDependencies)]) {
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    }
    expect(pkg.scripts).toEqual({ test: 'vitest run', typecheck: 'tsc --noEmit' });
  });

  it('wersja w /v1/health = version z package.json', () => {
    expect(RELAY_VERSION).toBe(pkg.version);
  });
});
