/**
 * Granica pakietu `@anthropic-ai/claude-agent-sdk` i kontrakt jego `listSessions` na żywym pakiecie z workspace.
 *
 * 1. **Granica importu.** Z tego pakietu wolno brać wyłącznie `listSessions`: czytnik plików, który nie potrzebuje
 *    ani poświadczeń, ani sieci (zmierzone: działa z pustym `env` i przy odciętej sieci). `query()` z tego samego
 *    pakietu prowadzi rozmowę: wymaga logowania i kosztuje tokeny, a Rarog jest klientem herdr, nie drugim
 *    silnikiem. Pakiet ładuje wyłącznie `install/sdk.ts` (w klonie z workspace, w paczce npm z katalogu danych po jawnej
 *    ścieżce); reszta kodu zna tylko typ `ListSessionsFn`. Kod produkcyjny to `server/src/`, `shared/src/`, `bin/`
 *    i `scripts/`, bez komentarzy (`source-scan.ts`). Ładowanie po nazwie w zmiennej liczy `iroh-granice.test.ts`
 *    (`import()` z argumentem innym niż literał tylko w znanych miejscach).
 * 2. **Kontrakt API.** Pakiet jest w wersji 0.x i wychodzi prawie codziennie, więc łamiąca zmiana ma się pokazać
 *    przy aktualizacji, a nie na produkcji: lista biegnie w osobnym procesie na kontrolowanym magazynie
 *    (`helpers/sdk-magazyn.ts`), więc test nie zależy od magazynu właściciela i nie kończy się na pustym.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { STORE_SESSION_ID, listInChild, writeSessionStore } from './helpers/sdk-magazyn.ts';
import { tempHome } from './rarog-home.ts';
import type { TempHome } from './rarog-home.ts';
import { repoFiles, scan } from './source-scan.ts';

const REPO = resolve(import.meta.dirname, '..', '..');
/** Nazwa paczki z kawałków: strażnik nie niesie napisu, którego szuka. */
const PACKAGE = ['@anthropic-ai', 'claude-agent-sdk'].join('/');
const LOADER = 'server/src/install/sdk.ts';
const PRODUCTION = /^(?:server\/src|shared\/src|bin|scripts)\//;
const CODE_EXT = /\.[cm]?[jt]s$/;

const CODE = new Map(
  repoFiles(REPO)
    .filter((file) => PRODUCTION.test(file) && CODE_EXT.test(file))
    .map((file) => [file, scan(readFileSync(join(REPO, file), 'utf8')).code]),
);

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/**
 * Miejsca, w których paczka wchodzi jako WARTOŚĆ: `import … from`, `export … from`, `import '…'`, `import()` bez
 * `typeof` przed nim, `require()` i `require.resolve()`. `import type … from` i `typeof import()` są wymazywane.
 */
function valueImports(code: string, pkg: string): string[] {
  const quoted = `['"\`]${escape(pkg)}['"\`]`;
  const hits: string[] = [];
  for (const hit of code.matchAll(new RegExp(`\\b(import|export)(\\s+type\\b)?[^;'"\`]*?\\bfrom\\s*${quoted}`, 'g'))) {
    if (hit[2] === undefined) hits.push(hit[0]);
  }
  for (const pattern of [
    `\\bimport\\s*${quoted}`,
    `(?<!\\btypeof\\s{0,4})\\bimport\\s*\\(\\s*${quoted}\\s*\\)`,
    `\\brequire(?:\\.resolve)?\\s*\\(\\s*${quoted}\\s*\\)`,
  ]) {
    for (const hit of code.matchAll(new RegExp(pattern, 'g'))) hits.push(hit[0]);
  }
  return hits;
}

/**
 * Nazwy brane z modułu SDK w module ładującym: dostęp do `loaded` (wynik `import()`), destrukturyzacja wyniku
 * `import()` i `typeof import('<paczka>').<nazwa>`.
 */
function takenNames(code: string, pkg: string): string[] {
  const names: string[] = [];
  const access = /\bloaded\s*(?:\?\.)?\s*\[\s*['"`]([^'"`]+)['"`]\s*\]|\bloaded\s*\??\.\s*([A-Za-z_$][\w$]*)/g;
  for (const hit of code.matchAll(access)) {
    names.push(hit[1] ?? hit[2] ?? '');
  }
  for (const hit of code.matchAll(/\{([^{}]*)\}\s*=\s*await\s+import\s*\(/g)) {
    names.push(...(hit[1] ?? '').split(',').map((part) => part.split(':')[0]?.trim() ?? '').filter((n) => n !== ''));
  }
  const typeofAccess = new RegExp(`\\btypeof\\s+import\\s*\\(\\s*['"\`]${escape(pkg)}['"\`]\\s*\\)\\s*\\.\\s*([\\w$]+)`, 'g');
  for (const hit of code.matchAll(typeofAccess)) names.push(hit[1] ?? '');
  return names;
}

describe('granica pakietu SDK', () => {
  it('kod produkcyjny jest i obejmuje moduł ładujący', () => {
    expect([...CODE.keys()]).toEqual(expect.arrayContaining([LOADER, 'server/src/session-list.ts', 'server/src/index.ts']));
  });

  it('paczka jako wartość tylko w `install/sdk.ts`', () => {
    const holders = [...CODE].filter(([, code]) => valueImports(code, PACKAGE).length > 0).map(([file]) => file);
    expect(holders).toEqual([LOADER]);
  });

  it('`install/sdk.ts`: jeden `import()` paczki po nazwie (workspace), bez `import`/`export … from`', () => {
    const hits = valueImports(CODE.get(LOADER) ?? '', PACKAGE);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatch(/^import\s*\(/);
  });

  it('z modułu SDK brane wyłącznie `listSessions`', () => {
    const names = takenNames(CODE.get(LOADER) ?? '', PACKAGE);
    expect(names.length).toBeGreaterThan(0);
    expect([...new Set(names)]).toEqual(['listSessions']);
  });

  it('typ z paczki poza modułem ładującym tylko przez `ListSessionsFn` z `install/sdk.ts`', () => {
    const quoted = `['"\`]${escape(PACKAGE)}['"\`]`;
    const typeImport = new RegExp(`\\bimport\\s+type\\b[^;]*?\\bfrom\\s*${quoted}|\\btypeof\\s+import\\s*\\(\\s*${quoted}`);
    const typeUsers = [...CODE].filter(([file]) => file !== LOADER)
      .filter(([, code]) => typeImport.test(code))
      .map(([file]) => file);
    expect(typeUsers).toEqual([]);
  });

  it('nigdzie nie ma `query` z tego pakietu (rozmowa kosztuje tokeny)', () => {
    expect(CODE.get(LOADER) ?? '').not.toMatch(/\bquery\b/);
    expect(CODE.get('server/src/install/sdk-probe.ts') ?? '').not.toMatch(/\bquery\b/);
  });

  it('skaner widzi każdy kształt wejścia paczki jako wartości i pomija typy', () => {
    const pkg = 'pkg/x';
    expect(valueImports("import { query } from 'pkg/x';", pkg)).toHaveLength(1);
    expect(valueImports("import * as sdk from \"pkg/x\";", pkg)).toHaveLength(1);
    expect(valueImports("export { listSessions } from 'pkg/x';", pkg)).toHaveLength(1);
    expect(valueImports("import 'pkg/x';", pkg)).toHaveLength(1);
    expect(valueImports("const m = await import('pkg/x');", pkg)).toHaveLength(1);
    expect(valueImports("require('pkg/x'); require.resolve('pkg/x');", pkg)).toHaveLength(2);
    expect(valueImports("import type { Options } from 'pkg/x';", pkg)).toEqual([]);
    expect(valueImports("type F = typeof import('pkg/x').listSessions;", pkg)).toEqual([]);
    expect(valueImports("const name = 'pkg/x';", pkg)).toEqual([]);
  });

  it('skaner nazw widzi każdą nazwę braną z modułu', () => {
    const pkg = 'pkg/x';
    expect(takenNames("const fn = loaded['query'];", pkg)).toEqual(['query']);
    expect(takenNames('const fn = loaded?.query;', pkg)).toEqual(['query']);
    expect(takenNames("const { listSessions, query: q } = await import('pkg/x');", pkg)).toEqual(['listSessions', 'query']);
    expect(takenNames("type Q = typeof import('pkg/x').query;", pkg)).toEqual(['query']);
  });
});

describe('kontrakt `listSessions()` na żywym pakiecie z workspace', () => {
  let t: TempHome;
  let config = '';
  let project = '';
  beforeEach(() => {
    t = tempHome('sdk-kontrakt-');
    config = join(t.home, 'config');
    project = join(t.home, 'projekt');
    mkdirSync(config);
    mkdirSync(project);
  });
  afterEach(() => { t.cleanup(); });

  it('na niepustym magazynie oddaje wpis o znanych polach', { timeout: 60_000 }, () => {
    const dir = writeSessionStore(config, project);
    const listed = listInChild({ workspace: true }, config, t.home, dir);
    expect(listed.ok, listed.ok ? '' : listed.reason).toBe(true);
    const sessions = listed.ok ? listed.sessions as Record<string, unknown>[] : [];
    expect(sessions).toHaveLength(1);
    const [first] = sessions;
    expect(first?.['sessionId']).toBe(STORE_SESSION_ID);
    expect(typeof first?.['summary']).toBe('string');
    expect(typeof first?.['lastModified']).toBe('number');
    // `cwd` jest OPCJONALNY i to jest udokumentowane założenie naszego odsiewu, nie usterka.
    expect(['string', 'undefined']).toContain(typeof first?.['cwd']);
  });

  it('na katalogu bez sesji oddaje pustą tablicę (sonda startu serwera)', { timeout: 60_000 }, () => {
    writeSessionStore(config, project);
    const empty = join(t.home, 'pusty');
    mkdirSync(empty);
    expect(listInChild({ workspace: true }, config, t.home, empty)).toEqual({ ok: true, sessions: [] });
  });

  /*
   * `includeProgrammatic` NIE jest opisany na stronie dokumentacji — tylko w typach pakietu.
   * Gdyby zniknął, lista natychmiast zapełniłaby się sesjami hooków (zmierzone: 94 ze 190
   * najświeższych wpisów), a odsiać ich samodzielnie NIE MA CZYM: `SDKSessionInfo` nie niesie
   * ani `entrypoint`, ani `promptSource`.
   */
  it('opcja `includeProgrammatic` dalej istnieje w typach pakietu', () => {
    const types = readFileSync(
      new URL('../node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts', import.meta.url).pathname,
      'utf8',
    );
    expect(types).toContain('includeProgrammatic?: boolean');
  });
});
