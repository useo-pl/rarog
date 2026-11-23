/**
 * Strażnik mapy relay → rejestr (`RELAY_AUTH_REGISTRIES` w `shared/src/relay-auth.ts`): mapa
 * mówi apce, który Worker rejestru pilnuje którego relaya iroh. Musi się zgadzać z trzema plikami, które tę parę
 * ustalają w produkcji:
 * - `server/src/cli/setup.ts`: `DEFAULT_IROH_RELAY`, relay, który `rarog setup` wpisuje serwerowi (klucz mapy);
 * - `relay-vps/access-adapter.conf`: `WORKER_URL`, do którego adapter haka relaya pyta o zgodę (origin = wartość,
 *   ścieżka = trasa `access` kontraktu);
 * - `relay-auth/wrangler.toml`: `pattern` Custom Domain Workera (`https://` + pattern = wartość).
 *
 * Reguła czyta tekst plików, więc test przepuszcza przez nią także kopie z jedną zmianą: każda przewraca regułę.
 * Mapa ma dziś dokładnie jeden wpis, bo produkcja ma jeden relay i jeden Worker; relay spoza mapy (własny relay
 * użytkownika) nie ma rejestru. Drugi wpis to zmiana tej reguły.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RELAY_AUTH_PATHS, RELAY_AUTH_REGISTRIES } from '../../shared/src/relay-auth.ts';
import { DEFAULT_IROH_RELAY } from '../src/cli/setup.ts';
import { REPO } from './private-guard.ts';

interface Sources {
  readonly setup: string;
  readonly adapter: string;
  readonly wrangler: string;
}

const FILES: Readonly<Record<keyof Sources, string>> = {
  setup: 'server/src/cli/setup.ts',
  adapter: 'relay-vps/access-adapter.conf',
  wrangler: 'relay-auth/wrangler.toml',
};

const read = (file: string): string => readFileSync(path.join(REPO, file), 'utf8');

const SOURCES: Sources = { setup: read(FILES.setup), adapter: read(FILES.adapter), wrangler: read(FILES.wrangler) };

/** Wszystkie dopasowania pierwszej grupy wzorca (flaga `gm`). */
const all = (text: string, re: RegExp): string[] => [...text.matchAll(re)].map((match) => match[1] ?? '');

/** `DEFAULT_IROH_RELAY` z tekstu `setup.ts`; `null`, gdy nie ma dokładnie jednej deklaracji. */
const setupRelay = (text: string): string | null => {
  const found = all(text, /^export const DEFAULT_IROH_RELAY = '([^']*)';$/gm);
  return found.length === 1 ? (found[0] ?? null) : null;
};

const parseUrl = (raw: string): URL | null => {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
};

/** Reguła mapy: lista rozbieżności (pusta = zgodnie), każda z nazwą pliku. */
function mapProblems(registries: Readonly<Record<string, string>>, sources: Sources): string[] {
  const problems: string[] = [];
  const relay = setupRelay(sources.setup);
  if (relay === null) problems.push(`${FILES.setup}: brak jednej deklaracji DEFAULT_IROH_RELAY`);
  else if (JSON.stringify(Object.keys(registries)) !== JSON.stringify([relay])) {
    problems.push(`${FILES.setup}: klucze mapy ${JSON.stringify(Object.keys(registries))} ≠ [${relay}]`);
  }
  const registry = relay === null ? undefined : registries[relay];

  // Bez klucza z setup.ts nie ma z czym porównać wartości: rozbieżność stoi już przy setup.ts.
  if (registry === undefined) return problems;

  const workers = all(sources.adapter, /^WORKER_URL=(.*)$/gm);
  const worker = workers.length === 1 ? parseUrl(workers[0] ?? '') : null;
  if (worker === null) problems.push(`${FILES.adapter}: brak jednego poprawnego WORKER_URL`);
  else {
    if (worker.origin !== registry) problems.push(`${FILES.adapter}: origin WORKER_URL ${worker.origin} ≠ ${registry}`);
    if (worker.pathname !== RELAY_AUTH_PATHS.access) {
      problems.push(`${FILES.adapter}: ścieżka WORKER_URL ${worker.pathname} ≠ ${RELAY_AUTH_PATHS.access}`);
    }
  }

  const patterns = all(sources.wrangler, /^pattern\s*=\s*"([^"]*)"\s*$/gm);
  if (patterns.length !== 1) problems.push(`${FILES.wrangler}: ${String(patterns.length)} tras zamiast jednej`);
  else if (`https://${patterns[0] ?? ''}` !== registry) {
    problems.push(`${FILES.wrangler}: https://${patterns[0] ?? ''} ≠ ${registry}`);
  }
  return problems;
}

describe('mapa relay → rejestr (RELAY_AUTH_REGISTRIES) a konfiguracja relaya i Workera', () => {
  it('pliki z repo: mapa zgodna z setup.ts, adapterem haka i wrangler.toml', () => {
    expect(mapProblems(RELAY_AUTH_REGISTRIES, SOURCES)).toEqual([]);
  });

  it('reguła czyta z setup.ts tę samą wartość, którą eksportuje moduł', () => {
    expect(setupRelay(SOURCES.setup)).toBe(DEFAULT_IROH_RELAY);
  });

  const mutations: ReadonlyArray<readonly [string, keyof Sources, string, string]> = [
    ['inny relay w setup.ts', 'setup', "= 'https://relay.rarog.ai/'", "= 'https://relay2.rarog.ai/'"],
    ['bez deklaracji w setup.ts', 'setup', 'export const DEFAULT_IROH_RELAY', 'export const OTHER_RELAY'],
    ['inny host WORKER_URL', 'adapter', 'WORKER_URL=https://relay-auth.rarog.ai', 'WORKER_URL=https://auth.rarog.ai'],
    ['inna ścieżka WORKER_URL', 'adapter', '/v1/access', '/v2/access'],
    ['bez WORKER_URL', 'adapter', 'WORKER_URL=', '# WORKER_URL='],
    ['inny pattern trasy', 'wrangler', 'pattern = "relay-auth.rarog.ai"', 'pattern = "rejestr.rarog.ai"'],
    ['bez trasy', 'wrangler', 'pattern = "relay-auth.rarog.ai"', '# pattern = "relay-auth.rarog.ai"'],
  ];

  it.each(mutations)('kopia z jedną zmianą przewraca regułę: %s', (_name, file, from, to) => {
    expect(SOURCES[file]).toContain(from);
    const changed: Sources = { ...SOURCES, [file]: SOURCES[file].replace(from, to) };
    const problems = mapProblems(RELAY_AUTH_REGISTRIES, changed);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.every((problem) => problem.startsWith(`${FILES[file]}:`)), problems.join('\n')).toBe(true);
  });

  it('mapa z inną wartością albo drugim kluczem przewraca regułę', () => {
    const [[relay = '', registry = ''] = []] = Object.entries(RELAY_AUTH_REGISTRIES);
    expect(mapProblems({ [relay]: 'https://auth.rarog.ai' }, SOURCES).length).toBe(2);
    expect(mapProblems({ [relay]: registry, 'https://other.example/': registry }, SOURCES).length).toBe(1);
    expect(mapProblems({}, SOURCES).length).toBeGreaterThan(0);
  });
});
