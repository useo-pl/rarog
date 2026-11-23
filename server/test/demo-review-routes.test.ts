/**
 * Klasy tras trybu recenzji demo: tabela `server/src/demo/review-routes.ts`,
 * bramka w `handle` routera i dwa pomocnicze strażniki statyczne.
 *
 * 1. `classifyReviewRoute`: ścieżka z każdego wiersza tabeli klas tras → jego klasa, ścieżka spoza tabeli → `absent`.
 * 2. Bramka na prawdziwym routerze z magazynem urządzeń w katalogu tymczasowym: w trybie recenzji trasa `refuse` to
 *    403 `demo-review`, trasa `absent` (także znana routerowi) to 404 bez wejścia do obsługi; poza trybem recenzji te
 *    same żądania idą do obsługi jak dziś (bramka martwa bez `RAROG_DEMO_REVIEW_CODE`).
 * 3. Inwentarz tras: POMOCNICZY, nie dowód izolacji (dowodem są czarna skrzynka tras `demo-review-guard.test.ts`
 *    i test rzeczywistego procesu trybu recenzji). Drzewo składni (`parseAst` z `vitest/node`) funkcji `handle`
 *    w `server/src/router.ts` i CAŁYCH modułów grup tras `server/src/routes/*.ts` (każdy plik katalogu, także nowy)
 *    daje zbiór tras; ma się równać wzorcom tabeli bez wpisów `outside`. Rozpoznawane postaci dopasowania:
 *    - `pathname === '<literał>'` (także `!==` i stała napisowa modułu, np. `DEMO_PAIRING_PATH`) w dowolnym miejscu;
 *    - `pathname.startsWith('<literał>')` → wzorzec równy prefiksowi;
 *    - testy `if` na segmentach: `segments[N] === '<literał>'`, alias `const x = segments[N]` (`action`)
 *      i `segments.length` (`===`, `>=`, `>`), składane z testami `if` nad nimi. Wzorzec bierze segmenty 0–3
 *      (literał albo `:id`); `segments[4]` i dalej to podakcja, która dziedziczy klasę. Test `if`, pod którym stoją
 *      dalsze testy segmentów, to kontener, nie trasa.
 *    Nazwy dochodzą do grupy tylko przez żądanie `rq`: w `handle` skrót `{ pathname, segments }` w literale
 *    `const rq`, w module grupy destrukturyzacja `const { pathname, segments } = rq`. Każde inne użycie
 *    `pathname`, `segments` albo aliasu (np. `switch`, `Set.has`, przekazanie do innej funkcji, `rq.pathname`,
 *    porównanie `segments[0…3]` poza testem `if`) to czerwony wynik „nierozpoznana postać” z plikiem i linią: nową
 *    postać trzeba nauczyć inwentarz, zanim przejdzie. Poza zakresem: trasy obsługiwane w `router.ts` w innej
 *    funkcji niż `handle` bez użycia tych nazw.
 * 4. Strażnik powierzchni wejść HTTP: drzewo składni `server/src/index.ts`. Rozpoznaje `<obiekt>.on|addListener|
 *    prependListener|once|prependOnceListener` ze zdarzeniem-literałem `'request'`, `'upgrade'`, `'connect'`,
 *    `'checkContinue'` albo `'checkExpectation'` (trzy ostatnie też oddają żądanie HTTP handlerowi z pominięciem
 *    `'request'`), wywołania `createServer(…)` (`http.`, `https.` i każde inne) oraz `new <x>.Server(…)`
 *    i `new Server(…)`. Handler funkcją to `<funkcja>`, każdy inny to jego dosłowne wyrażenie. Poza zakresem,
 *    z powodem: `emit('connection')` nasłuchu iroh (`server/src/iroh/listener.ts`; w trybie recenzji `ConfigError`),
 *    gniazdo Unix administracji (`server/src/auth/admin.ts`, osobny serwer na gnieździe w katalogu danych), słuchacz
 *    dodany poza `index.ts`, zdarzenie podane zmienną zamiast literału.
 *    Ten sam strażnik pinuje warunek kontroli demo: inicjalizator `const demoControl = <test> ? … : …` ma w teście
 *    (łańcuch `&&`) człon dokładnie `config.demoReview === null`, więc słuchacz `request` w trybie recenzji to sam
 *    router. Inna postać (np. `let` i przypisanie w `if`) to czerwony wynik z linią.
 *
 * Mutacje obu strażników idą na kopii źródła w pamięci (pliki bez zmian) i każda pinuje nazwę w komunikacie.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parseAst } from 'vitest/node';
import { PROTOCOL_VERSION } from '@rarog/shared';
import { DEMO_REVIEW_ERROR } from '@rarog/shared/rest';
import { say } from '@rarog/shared/sentences';
import { createDeviceStore, createLoginLimiter, createPairing, deviceAuthorization } from '../src/auth/index.ts';
import type { DeviceStore } from '../src/auth/index.ts';
import { loadConfig } from '../src/config.ts';
import { REVIEW_ROUTES, type ReviewRouteClass, classifyReviewRoute } from '../src/demo/review-routes.ts';
import { DEMO_PAIRING_PATH, type Logger, createRouter } from '../src/router.ts';
import { SseHub } from '../src/sse.ts';
import type { TermFeature } from '../src/term/index.ts';
import { FakeManager, makeSummary } from './fake-manager.ts';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const ROUTER_PLIK = 'router.ts';
/** `router.ts` i każdy moduł `routes/` (ścieżka względem `server/src`) → kod. */
const KOD_TRAS: ReadonlyMap<string, string> = new Map([
  [ROUTER_PLIK, readFileSync(path.join(SRC, ROUTER_PLIK), 'utf8')],
  ...readdirSync(path.join(SRC, 'routes')).filter((f) => f.endsWith('.ts')).sort()
    .map((f): [string, string] => [`routes/${f}`, readFileSync(path.join(SRC, 'routes', f), 'utf8')]),
]);
const INDEX_KOD = readFileSync(path.join(SRC, 'index.ts'), 'utf8');

// ---------------------------------------------------------------------------------------------------------------
// 1. Klasyfikacja
// ---------------------------------------------------------------------------------------------------------------

/** Wiersze tabeli klas tras z przykładową ścieżką: kontrakt spisany niezależnie od tabeli w kodzie. */
const K3: ReadonlyArray<readonly [string, ReviewRouteClass]> = [
  ['/health', 'allow'],
  ['/api/version', 'allow'],
  ['/api/pair', 'allow'],
  ['/api/login', 'retired'],
  ['/api/pairings', 'refuse'],
  ['/api/devices', 'allow'],
  ['/api/devices/me', 'allow'],
  ['/api/devices/forget', 'allow'],
  ['/api/stream', 'allow'],
  ['/api/notes', 'allow'],
  ['/api/client-log', 'allow'],
  ['/api/presence', 'allow'],
  ['/api/projects', 'allow'],
  ['/api/projects/recent', 'allow'],
  ['/api/resumable', 'allow'],
  ['/api/resumable/recent', 'allow'],
  ['/api/usage', 'allow'],
  ['/api/usage/details', 'allow'],
  ['/api/mac', 'allow'],
  ['/api/models', 'allow'],
  ['/api/fs', 'allow'],
  ['/api/voice/token', 'allow'],
  ['/api/push/apns', 'allow'],
  ['/api/push/apns/unregister', 'allow'],
  ['/api/push/apns/status', 'allow'],
  ['/api/push/live-activity', 'allow'],
  ['/api/push/live-activity/end', 'allow'],
  ['/api/sessions', 'allow'],
  ...[
    'answers', 'close', 'commands', 'diff', 'focus', 'interrupt', 'messages', 'mode', 'model', 'permission',
    'permissions', 'restart', 'resume', 'seen', 'stream', 'unseen', 'uploads',
  ].map((akcja): readonly [string, ReviewRouteClass] => [`/api/sessions/demo-willow/${akcja}`, 'allow']),
  ['/api/demo/pairing', 'absent'],
  ['/api/sessions/demo-willow/companion/ask', 'absent'],
  ['/api/sessions/demo-willow/companion/turns', 'absent'],
  ['/api/companion/token', 'absent'],
  ['/api/companion/speech-token', 'absent'],
  ['/api/demo/control', 'absent'],
  ['/api/term', 'absent'],
  ['/api/term/t1', 'absent'],
  ['/api/term/t1/history', 'absent'],
  ['/api/fs/mkdir', 'absent'],
  ['/api/admin/devices', 'absent'],
  ['/api/admin/pairings', 'absent'],
  ['/api/xyz', 'absent'],
];

describe('classifyReviewRoute: klasy tras', () => {
  it.each(K3)('%s → %s', (sciezka, klasa) => {
    expect(classifyReviewRoute(sciezka)).toBe(klasa);
  });

  it('podakcje sesji dziedziczą klasę akcji (`segments[3]`)', () => {
    for (const sciezka of [
      '/api/sessions/demo-willow/diff/files', '/api/sessions/demo-willow/diff/file',
      '/api/sessions/demo-willow/uploads/x.png', '/api/sessions/demo-willow/permissions/p1',
      '/api/sessions/demo-willow/answers/q1',
    ]) expect(classifyReviewRoute(sciezka), sciezka).toBe('allow');
  });

  it('ścieżka spoza tabeli to `absent` (domyślna odmowa), także bliska znanej', () => {
    for (const sciezka of [
      '/', '/api', '/api/sessions/demo-willow', '/api/sessions/demo-willow/nowa', '/api/devices/xyz',
      '/api/pairings/x', '/api/pairingsx', '/api//pairings', '/api/demo', '/api/admin', '/apka', '/api/health',
    ]) expect(classifyReviewRoute(sciezka), sciezka).toBe('absent');
  });

  it('ścieżkę dzieli na segmenty jak router: puste segmenty odpadają', () => {
    expect(classifyReviewRoute('/api//sessions/demo-willow//stream')).toBe('allow');
  });

  it('tabela: wzorce bez powtórzeń, odsyłacz `outside` wskazuje istniejący plik', () => {
    const wzorce = REVIEW_ROUTES.map((wpis) => wpis.route);
    expect(new Set(wzorce).size).toBe(wzorce.length);
    for (const wpis of REVIEW_ROUTES.filter((one) => one.outside !== undefined)) {
      expect(() => readFileSync(path.join(SRC, '..', '..', wpis.outside ?? ''), 'utf8'), wpis.route).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 2. Bramka w routerze
// ---------------------------------------------------------------------------------------------------------------

const ORIGIN = 'https://demo.rarog.example';

interface Uprzaz {
  base: string;
  store: DeviceStore;
  /** Klucz urządzenia sparowanego na starcie (kodem recenzenta albo kodem z `pairing.issue`). */
  klucz: string;
  /** Wywołania `list()` atrapy terminala: dowód, czy żądanie doszło do obsługi `/api/term`. */
  listyTerminala: number;
}

const otwarte: Array<{ zamknij(): Promise<void>; dir: string }> = [];

afterEach(async () => {
  for (const { zamknij, dir } of otwarte.splice(0)) {
    await zamknij();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Router z magazynem urządzeń w katalogu tymczasowym i atrapą terminala; `tryb` wybiera konfigurację. */
async function uruchom(tryb: 'recenzja' | 'demo' | 'serwer'): Promise<Uprzaz> {
  const dir = mkdtempSync(path.join(tmpdir(), 'a5-z3-klasy-'));
  const logger: Logger = { info: () => {}, error: () => {} };
  const kod = randomBytes(32).toString('base64url');
  const env: NodeJS.ProcessEnv = { RAROG_DATA_DIR: dir, RAROG_ORIGINS: ORIGIN };
  if (tryb !== 'serwer') env['RAROG_DEMO'] = '1';
  if (tryb === 'recenzja') env['RAROG_DEMO_REVIEW_CODE'] = kod;
  const config = loadConfig(env);
  const store = createDeviceStore({ dataDir: dir, epoch: config.epoch, log: () => {} });
  const pairing = createPairing({ store, epoch: config.epoch });
  const manager = new FakeManager([makeSummary({ id: 's1' })]);
  const hub = new SseHub({ manager, serverStartId: 'start-1', protocolVersion: PROTOCOL_VERSION, heartbeatMs: 0 });
  hub.start();
  const uprzaz: Uprzaz = { base: '', store, klucz: '', listyTerminala: 0 };
  const term: TermFeature = {
    enabled: true,
    ready: Promise.resolve(),
    open: () => { throw new Error('atrapa: open'); },
    list: () => { uprzaz.listyTerminala += 1; return []; },
    close: () => false,
    history: () => Promise.reject(new Error('atrapa: history')),
    handleUpgrade: () => {},
    closeOwner: () => 0,
    dispose: () => {},
  };
  const server = http.createServer(createRouter({
    config, manager, hub, serverStartId: 'start-1', startedAtMs: Date.now(), logger, term,
    loginLimiter: createLoginLimiter(), devices: { store, pairing, serverName: 'demo' },
  }));
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  uprzaz.base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  otwarte.push({
    dir,
    zamknij: async () => {
      hub.closeAll();
      server.closeAllConnections();
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
      await store.flush();
    },
  });
  const sparowane = await zadanie(uprzaz, 'POST', '/api/pair', {
    v: 1, code: tryb === 'recenzja' ? kod : pairing.issue('admin', Date.now()).code, label: 'iPhone·Rarog',
  }, false);
  if (sparowane.status !== 200) throw new Error(`parowanie uprzęży: ${String(sparowane.status)}`);
  const { deviceId, secret } = sparowane.body as { deviceId: string; secret: string };
  uprzaz.klucz = deviceAuthorization(deviceId, secret);
  return uprzaz;
}

async function zadanie(
  u: Uprzaz, metoda: string, sciezka: string, cialo?: unknown, zKluczem = true,
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const headers: Record<string, string> = { Origin: ORIGIN };
  if (zKluczem) headers['Authorization'] = u.klucz;
  if (cialo !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${u.base}${sciezka}`, {
    method: metoda, headers, ...(cialo === undefined ? {} : { body: JSON.stringify(cialo) }),
  });
  const text = await res.text();
  return { status: res.status, body: text === '' ? null : JSON.parse(text) as Record<string, unknown> };
}

const ODMOWA = say('demo.review-refused');
const NIEZNANA = say('rest.endpoint-not-found');

describe('bramka klas tras w trybie recenzji', () => {
  it('`refuse`: `POST /api/pairings` z kluczem → 403 `demo-review` ze zdaniem rejestru', async () => {
    const u = await uruchom('recenzja');
    const odp = await zadanie(u, 'POST', '/api/pairings', {});
    expect(odp).toEqual({
      status: 403, body: { error: DEMO_REVIEW_ERROR, message: ODMOWA.text, messageRef: ODMOWA.ref },
    });
  });

  it('`refuse` covers every method of the path: `DELETE /api/pairings` with a key → 403, from the one table row', async () => {
    const u = await uruchom('recenzja');
    expect(await zadanie(u, 'DELETE', '/api/pairings')).toEqual({
      status: 403, body: { error: DEMO_REVIEW_ERROR, message: ODMOWA.text, messageRef: ODMOWA.ref },
    });
    expect(REVIEW_ROUTES.filter((wpis) => wpis.route === '/api/pairings')).toEqual([
      { route: '/api/pairings', class: 'refuse' },
    ]);
  });

  it('`absent` znane routerowi: `POST /api/demo/pairing` bez klucza 401, z kluczem 404 i urządzenie zostaje', async () => {
    const u = await uruchom('recenzja');
    expect((await zadanie(u, 'POST', DEMO_PAIRING_PATH, {}, false)).status).toBe(401);
    const odp = await zadanie(u, 'POST', DEMO_PAIRING_PATH, {});
    expect(odp).toEqual({ status: 404, body: { error: 'not-found', message: NIEZNANA.text, messageRef: NIEZNANA.ref } });
    expect(u.store.active(Date.now())).toHaveLength(1);
    expect((await zadanie(u, 'GET', '/api/version')).status).toBe(200);
  });

  it('`absent` z obsługą w routerze: `GET /api/term` → 404, a atrapa terminala nie dostaje wywołania', async () => {
    const u = await uruchom('recenzja');
    expect((await zadanie(u, 'GET', '/api/term')).status).toBe(404);
    expect((await zadanie(u, 'GET', '/api/term/t1/history')).status).toBe(404);
    expect(u.listyTerminala).toBe(0);
  });

  it('ścieżka spoza tabeli: z kluczem 404 `not-found`, bez klucza 401 (bramka poświadczeń przed klasą)', async () => {
    const u = await uruchom('recenzja');
    expect((await zadanie(u, 'GET', '/api/xyz')).status).toBe(404);
    expect((await zadanie(u, 'GET', '/api/xyz', undefined, false)).status).toBe(401);
  });

  it('`allow` i `retired` idą do routera: metody i statusy jak dziś', async () => {
    const u = await uruchom('recenzja');
    expect((await zadanie(u, 'GET', '/api/version')).status).toBe(200);
    expect((await zadanie(u, 'GET', '/health', undefined, false)).status).toBe(200);
    expect((await zadanie(u, 'GET', '/api/devices')).status).toBe(200);
    expect((await zadanie(u, 'GET', '/api/sessions')).status).toBe(405);
    expect((await zadanie(u, 'POST', '/api/login', {}, false)).status).toBe(410);
  });
});

describe('poza trybem recenzji bramki nie ma', () => {
  it('zwykłe demo: `/api/pairings` wydaje kod, `/api/term` dochodzi do obsługi, `/api/demo/pairing` odpina', async () => {
    const u = await uruchom('demo');
    expect((await zadanie(u, 'POST', '/api/pairings', {})).status).toBe(200);
    expect((await zadanie(u, 'DELETE', '/api/pairings')).status).toBe(204);
    expect((await zadanie(u, 'GET', '/api/term')).status).toBe(200);
    expect(u.listyTerminala).toBe(1);
    expect((await zadanie(u, 'POST', DEMO_PAIRING_PATH, {}, false)).status).toBe(200);
    expect(u.store.active(Date.now())).toHaveLength(0);
  });

  it('serwer: `/api/pairings` wydaje kod, `/api/term` dochodzi do obsługi, `/api/demo/pairing` to 404', async () => {
    const u = await uruchom('serwer');
    expect((await zadanie(u, 'POST', '/api/pairings', {})).status).toBe(200);
    expect((await zadanie(u, 'DELETE', '/api/pairings')).status).toBe(204);
    expect((await zadanie(u, 'GET', '/api/term')).status).toBe(200);
    expect((await zadanie(u, 'POST', DEMO_PAIRING_PATH, {})).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Drzewo składni: wspólne pomocniki
// ---------------------------------------------------------------------------------------------------------------

interface Wezel {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly [pole: string]: unknown;
}

/** Krok w dół drzewa: rodzic i pole rodzica, w którym stoi dziecko. */
interface Krok {
  readonly wezel: Wezel;
  readonly pole: string;
}

const wezel = (x: unknown): Wezel | null =>
  typeof x === 'object' && x !== null && typeof (x as { type?: unknown }).type === 'string' ? x as Wezel : null;

function dzieci(n: Wezel): Krok[] {
  const out: Krok[] = [];
  for (const [pole, wartosc] of Object.entries(n)) {
    for (const x of Array.isArray(wartosc) ? wartosc as unknown[] : [wartosc]) {
      const w = wezel(x);
      if (w !== null) out.push({ wezel: w, pole });
    }
  }
  return out;
}

/** Odwiedza poddrzewo; `przodkowie` od korzenia, ostatni to rodzic z polem, w którym stoi węzeł. */
function odwiedz(korzen: Wezel, f: (n: Wezel, przodkowie: readonly Krok[]) => void): void {
  const przodkowie: Krok[] = [];
  const krok = (n: Wezel): void => {
    f(n, przodkowie);
    for (const { wezel: d, pole } of dzieci(n)) {
      przodkowie.push({ wezel: n, pole });
      krok(d);
      przodkowie.pop();
    }
  };
  krok(korzen);
}

function parsuj(kod: string): Wezel {
  const ast = wezel(parseAst(kod, { lang: 'ts', sourceType: 'module' }));
  if (ast === null) throw new Error('parseAst nie oddał drzewa');
  return ast;
}

const nazwa = (x: unknown): string | null => {
  const w = wezel(x);
  return w?.type === 'Identifier' && typeof w['name'] === 'string' ? w['name'] : null;
};
const napis = (x: unknown): string | null => {
  const w = wezel(x);
  return w?.type === 'Literal' && typeof w['value'] === 'string' ? w['value'] : null;
};
const liczba = (x: unknown): number | null => {
  const w = wezel(x);
  return w?.type === 'Literal' && typeof w['value'] === 'number' ? w['value'] : null;
};
const zrodlo = (kod: string, n: Wezel): string => kod.slice(n.start, n.end).replace(/\s+/gu, ' ').trim();

function numerLinii(kod: string): (offset: number) => number {
  const poczatki = [0];
  for (let i = 0; i < kod.length; i += 1) if (kod[i] === '\n') poczatki.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = poczatki.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (poczatki[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

// ---------------------------------------------------------------------------------------------------------------
// 3. Inwentarz tras routera
// ---------------------------------------------------------------------------------------------------------------

interface Inwentarz {
  readonly trasy: ReadonlySet<string>;
  /** Użycia `pathname`, `segments` albo aliasu w postaci, której inwentarz nie zna: `linia N: <kod>`. */
  readonly nierozpoznane: readonly string[];
}

/** Fakty testu `if` o segmentach: literały na pozycjach i długość (dokładna albo najmniejsza). */
interface Fakty {
  readonly wartosci: ReadonlyMap<number, ReadonlySet<string>>;
  readonly dlugosc: number | null;
}

const BRAK_FAKTOW: Fakty = { wartosci: new Map(), dlugosc: null };

function polacz(a: Fakty, b: Fakty): Fakty {
  const wartosci = new Map<number, Set<string>>();
  for (const zrodlowe of [a, b]) {
    for (const [i, vs] of zrodlowe.wartosci) wartosci.set(i, new Set([...(wartosci.get(i) ?? []), ...vs]));
  }
  return { wartosci, dlugosc: b.dlugosc ?? a.dlugosc };
}

/** Wzorce z faktów: segmenty 0–3 (literał albo `:id`), dalsze to podakcja dziedzicząca klasę. */
function wzorce(f: Fakty): string[] {
  const ostatni = Math.min(3, Math.max(-1, ...f.wartosci.keys(), (f.dlugosc ?? 0) - 1));
  let wyniki = [''];
  for (let i = 0; i <= ostatni; i += 1) {
    const opcje = [...(f.wartosci.get(i) ?? [':id'])];
    wyniki = wyniki.flatMap((w) => opcje.map((o) => `${w}/${o}`));
  }
  return wyniki;
}

const jestSegmentem = (x: unknown): number | null => {
  const w = wezel(x);
  if (w?.type !== 'MemberExpression' || w['computed'] !== true || nazwa(w['object']) !== 'segments') return null;
  return liczba(w['property']);
};
const jestDlugoscia = (x: unknown): boolean => {
  const w = wezel(x);
  return w?.type === 'MemberExpression' && w['computed'] !== true && nazwa(w['object']) === 'segments'
    && nazwa(w['property']) === 'length';
};

/**
 * Inwentarz jednego pliku: w `router.ts` (`calyModul === false`) tylko funkcja `handle`, w module grupy cały moduł.
 */
function inwentarzTras(kod: string, calyModul = false): Inwentarz {
  const ast = parsuj(kod);
  const linia = numerLinii(kod);
  // Stałe napisowe modułu (`export const DEMO_PAIRING_PATH = '/api/demo/pairing'`).
  const stale = new Map<string, string>();
  for (const { wezel: st } of dzieci(ast)) {
    const deklaracja = st.type === 'ExportNamedDeclaration' ? wezel(st['declaration']) : st;
    if (deklaracja?.type !== 'VariableDeclaration') continue;
    for (const { wezel: d } of dzieci(deklaracja)) {
      const id = nazwa(d['id']);
      const wartosc = napis(d['init']);
      if (d.type === 'VariableDeclarator' && id !== null && wartosc !== null) stale.set(id, wartosc);
    }
  }
  let handle: Wezel | null = calyModul ? ast : null;
  if (!calyModul) {
    odwiedz(ast, (n) => { if (n.type === 'FunctionDeclaration' && nazwa(n['id']) === 'handle') handle = n; });
  }
  if (handle === null) throw new Error('router.ts: nie ma funkcji `handle`');
  const korzen: Wezel = handle;
  // Aliasy segmentów: `const action = segments[3]`. Alias działa w funkcji, która go deklaruje (w module grupy ta
  // sama nazwa bywa parametrem innej funkcji).
  const aliasy = new Map<string, number>();
  const zakresAliasu = new Map<string, Wezel>();
  const FUNKCJE = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
  odwiedz(korzen, (n, przodkowie) => {
    if (n.type !== 'VariableDeclarator') return;
    const id = nazwa(n['id']);
    const i = jestSegmentem(n['init']);
    if (id === null || i === null) return;
    aliasy.set(id, i);
    zakresAliasu.set(id, [...przodkowie].reverse().find((k) => FUNKCJE.has(k.wezel.type))?.wezel ?? korzen);
  });
  const wZakresieAliasu = (imie: string, przodkowie: readonly Krok[]): boolean => {
    const zakres = zakresAliasu.get(imie);
    return zakres !== undefined && (zakres === korzen || przodkowie.some((k) => k.wezel === zakres));
  };
  const indeks = (x: unknown): number | null => {
    const imie = nazwa(x);
    return imie === null ? jestSegmentem(x) : aliasy.get(imie) ?? null;
  };

  const faktyTestu = (test: Wezel): Fakty & { readonly niepuste: boolean } => {
    const wartosci = new Map<number, Set<string>>();
    let dlugosc: number | null = null;
    let niepuste = false;
    odwiedz(test, (n) => {
      if (n.type !== 'BinaryExpression') return;
      const op = n['operator'];
      for (const [a, b] of [[n['left'], n['right']], [n['right'], n['left']]] as const) {
        const i = indeks(a);
        const v = napis(b);
        if (op === '===' && i !== null && v !== null) {
          wartosci.set(i, new Set([...(wartosci.get(i) ?? []), v]));
          niepuste = true;
        }
        const k = liczba(b);
        if (jestDlugoscia(a) && k !== null) {
          dlugosc = op === '>' ? k + 1 : k;
          niepuste = true;
        }
      }
    });
    return { wartosci, dlugosc, niepuste };
  };
  const maTestSegmentow = (n: Wezel): boolean => {
    let jest = false;
    odwiedz(n, (m) => {
      const test = wezel(m['test']);
      if (m.type === 'IfStatement' && test !== null && faktyTestu(test).niepuste) jest = true;
    });
    return jest;
  };

  const trasy = new Set<string>();
  const przejdz = (n: Wezel, kontekst: Fakty): void => {
    if (n.type === 'IfStatement') {
      const test = wezel(n['test']);
      const wlasne = test === null ? { ...BRAK_FAKTOW, niepuste: false } : faktyTestu(test);
      const laczne = polacz(kontekst, wlasne);
      const tak = wezel(n['consequent']);
      if (wlasne.niepuste && laczne.wartosci.size > 0 && tak !== null) {
        if (maTestSegmentow(tak)) przejdz(tak, laczne);
        else for (const trasa of wzorce(laczne)) trasy.add(trasa);
      } else if (tak !== null) {
        przejdz(tak, kontekst);
      }
      const nie = wezel(n['alternate']);
      if (nie !== null) przejdz(nie, kontekst);
      return;
    }
    for (const { wezel: d } of dzieci(n)) przejdz(d, kontekst);
  };
  przejdz(korzen, BRAK_FAKTOW);

  // Literały `pathname` i straż nierozpoznanych postaci.
  const nierozpoznane: string[] = [];
  const zle = (n: Wezel): void => {
    nierozpoznane.push(`linia ${String(linia(n.start))}: ${zrodlo(kod, n).slice(0, 120)}`);
  };
  const wTescieIf = (przodkowie: readonly Krok[]): boolean =>
    przodkowie.some((k) => k.wezel.type === 'IfStatement' && k.pole === 'test');
  const drugaStrona = (porownanie: Wezel, ta: Wezel): unknown =>
    porownanie['left'] === ta ? porownanie['right'] : porownanie['left'];
  odwiedz(korzen, (n, przodkowie) => {
    if (n.type !== 'Identifier') return;
    const imie = nazwa(n);
    if (imie === null) return;
    if (imie !== 'pathname' && imie !== 'segments' && !wZakresieAliasu(imie, przodkowie)) return;
    const rodzic = przodkowie.at(-1);
    if (rodzic === undefined) return;
    const p = rodzic.wezel;
    const dziadek = przodkowie.at(-2);
    // Pozycje nazwy, nie odczytu: `url.pathname`, klucz obiektu, deklaracja zmiennej. Odczyt pola innego obiektu
    // (`rq.pathname`) omija rozpoznawane postaci, więc jest nierozpoznany.
    if (p.type === 'MemberExpression' && rodzic.pole === 'property' && p['computed'] !== true) {
      if (nazwa(p['object']) !== 'url' && (imie === 'pathname' || imie === 'segments')) zle(p);
      return;
    }
    if ((p.type === 'Property' || p.type === 'TSPropertySignature') && rodzic.pole === 'key') return;
    if (p.type === 'VariableDeclarator' && rodzic.pole === 'id') return;
    // Droga nazw do grupy: `const { pathname, segments } = rq` w module grupy, skrót `{ pathname, segments }`
    // w literale `const rq` w `handle`.
    if (p.type === 'Property' && rodzic.pole === 'value' && p['shorthand'] === true && dziadek !== undefined) {
      const obiekt = dziadek.wezel;
      const deklaracja = przodkowie.at(-3);
      const zRq = deklaracja?.wezel.type === 'VariableDeclarator' && nazwa(deklaracja.wezel['init']) === 'rq'
        && deklaracja.pole === 'id';
      const doRq = deklaracja?.wezel.type === 'VariableDeclarator' && nazwa(deklaracja.wezel['id']) === 'rq'
        && deklaracja.pole === 'init';
      if (obiekt.type === 'ObjectPattern' && calyModul && zRq) return;
      if (obiekt.type === 'ObjectExpression' && !calyModul && doRq) return;
    }
    if (imie === 'pathname') {
      if (p.type === 'BinaryExpression' && (p['operator'] === '===' || p['operator'] === '!==')) {
        const inna = drugaStrona(p, n);
        const literal = napis(inna) ?? stale.get(nazwa(inna) ?? '') ?? null;
        if (literal !== null) {
          trasy.add(literal);
          return;
        }
      }
      if (p.type === 'MemberExpression' && rodzic.pole === 'object' && p['computed'] !== true
        && dziadek?.wezel.type === 'CallExpression' && dziadek.pole === 'callee') {
        const metoda = nazwa(p['property']);
        const pierwszy = napis((dziadek.wezel['arguments'] as unknown[])[0]);
        if (metoda === 'startsWith' && pierwszy !== null) {
          trasy.add(pierwszy);
          return;
        }
        if (metoda === 'split') return;
      }
      if (p.type === 'TemplateLiteral') return;
      if (p.type === 'CallExpression' && rodzic.pole === 'arguments') {
        const callee = wezel(p['callee']);
        const kto = callee === null ? '' : zrodlo(kod, callee);
        if (kto === 'PUBLIC_PATHS.has' || kto === 'classifyReviewRoute') return;
      }
      zle(p);
      return;
    }
    if (imie === 'segments') {
      if (p.type === 'MemberExpression' && rodzic.pole === 'object' && dziadek !== undefined) {
        const g = dziadek.wezel;
        if (jestDlugoscia(p) && g.type === 'BinaryExpression' && liczba(drugaStrona(g, p)) !== null) return;
        const i = jestSegmentem(p);
        if (i !== null) {
          if (g.type === 'VariableDeclarator' && dziadek.pole === 'init') return;
          if (g.type === 'LogicalExpression' && g['operator'] === '??') return;
          if (g.type === 'BinaryExpression' && g['operator'] === '===' && napis(drugaStrona(g, p)) !== null
            && (i >= 4 || wTescieIf(przodkowie))) return;
        }
      }
      zle(dziadek?.wezel ?? p);
      return;
    }
    // Alias segmentu (`action`): wyłącznie `=== '<literał>'` w teście `if`.
    if (p.type === 'BinaryExpression' && p['operator'] === '===' && napis(drugaStrona(p, n)) !== null
      && ((aliasy.get(imie) ?? 0) >= 4 || wTescieIf(przodkowie))) return;
    zle(p);
  });
  return { trasy, nierozpoznane };
}

const TABELA_ROUTERA: ReadonlySet<string> = new Set(
  REVIEW_ROUTES.filter((wpis) => wpis.outside === undefined).map((wpis) => wpis.route),
);

/** Inwentarz `router.ts` (funkcja `handle`) i modułów grup (całe moduły), zsumowany; miejsca z nazwą pliku. */
function inwentarzPlikow(pliki: ReadonlyMap<string, string>): Inwentarz {
  const trasy = new Set<string>();
  const nierozpoznane: string[] = [];
  for (const [plik, kod] of pliki) {
    const wynik = inwentarzTras(kod, plik !== ROUTER_PLIK);
    for (const t of wynik.trasy) trasy.add(t);
    nierozpoznane.push(...wynik.nierozpoznane.map((miejsce) => `${plik}, ${miejsce}`));
  }
  return { trasy, nierozpoznane };
}

/** Różnica inwentarza i tabeli po nazwie; pusty napis = zgodność. */
function opisRoznicy(pliki: ReadonlyMap<string, string>): string {
  const { trasy, nierozpoznane } = inwentarzPlikow(pliki);
  return [
    ...[...trasy].filter((t) => !TABELA_ROUTERA.has(t)).sort().map((t) => `trasa bez klasy w tabeli: ${t}`),
    ...[...TABELA_ROUTERA].filter((t) => !trasy.has(t)).sort().map((t) => `martwy wpis tabeli: ${t}`),
    ...nierozpoznane.map((miejsce) => `nierozpoznana postać dopasowania, ${miejsce}`),
  ].join('\n');
}

/** Kopia źródła z jedną podmianą; kotwica musi wystąpić dokładnie raz, inaczej mutacja niczego nie sprawdza. */
function mutuj(kod: string, kotwica: string, zamiana: string): string {
  const pierwsze = kod.indexOf(kotwica);
  if (pierwsze < 0 || kod.indexOf(kotwica, pierwsze + 1) >= 0) throw new Error(`kotwica nie jest jedyna: ${kotwica}`);
  return kod.slice(0, pierwsze) + zamiana + kod.slice(pierwsze + kotwica.length);
}

/** Kopia zestawu plików z jedną podmianą w pliku `plik`. */
function mutujPlik(plik: string, kotwica: string, zamiana: string): Map<string, string> {
  const kod = KOD_TRAS.get(plik);
  if (kod === undefined) throw new Error(`brak pliku: ${plik}`);
  return new Map([...KOD_TRAS, [plik, mutuj(kod, kotwica, zamiana)]]);
}

/** Kopia źródła bez instrukcji `if`, której test to dokładnie `test`. */
function bezGalezi(kod: string, test: string): string {
  let galaz: Wezel | null = null;
  odwiedz(parsuj(kod), (n) => {
    const t = wezel(n['test']);
    if (n.type === 'IfStatement' && t !== null && zrodlo(kod, t) === test) galaz = n;
  });
  if (galaz === null) throw new Error(`brak gałęzi: ${test}`);
  const { start, end } = galaz as Wezel;
  return kod.slice(0, start) + kod.slice(end);
}

describe('inwentarz tras routera (pomocniczy, nie dowód izolacji)', () => {
  const SYSTEM = 'routes/system.ts';
  const SESJE = 'routes/sessions.ts';
  const MAC = "  if (pathname === '/api/mac') {";
  const AKCJA = '  const action = segments[3];\n';

  it('trasy z `handle` w `router.ts` i z modułów `routes/` = wzorce tabeli bez wpisów obsługiwanych poza routerem', () => {
    expect([...KOD_TRAS.keys()]).toContain(SESJE);
    expect(opisRoznicy(KOD_TRAS)).toBe('');
  });

  it('widzi trzy postaci dopasowania: 34 literały, segmenty terminala i 19 akcji sesji (z agentem głosowym)', () => {
    const { trasy } = inwentarzPlikow(KOD_TRAS);
    expect(trasy.has('/api/demo/pairing')).toBe(true);
    expect(trasy.has('/api/term/:id/history')).toBe(true);
    expect(trasy.has('/api/term/:id')).toBe(true);
    expect([...trasy].filter((t) => t.startsWith('/api/sessions/:id/'))).toHaveLength(19);
    expect(trasy.has('/api/sessions/:id/companion')).toBe(true);
    expect(trasy.has('/api/sessions/:id/queue')).toBe(true);
    expect([...trasy].filter((t) => !t.includes(':'))).toHaveLength(34);
    expect(trasy.has('/api/fs/mkdir')).toBe(true);
    expect(trasy.has('/api/companion/token')).toBe(true);
    expect(trasy.has('/api/companion/speech-token')).toBe(true);
    expect(trasy.has('/api/companion/sessions')).toBe(true);
  });

  it('mutacja: dopisane w pliku grupy `pathname === \'/api/nowa\'` → trasa bez klasy `/api/nowa`', () => {
    const mutant = mutujPlik(SYSTEM, MAC, `  if (pathname === '/api/nowa') { sendJson(res, 200, {}); return true; }\n${MAC}`);
    expect(opisRoznicy(mutant)).toBe('trasa bez klasy w tabeli: /api/nowa');
  });

  it('mutacja: nowy moduł grupy z trasą → trasa bez klasy (każdy plik `routes/` jest w inwentarzu)', () => {
    const mutant = new Map([...KOD_TRAS, ['routes/nowa.ts', [
      'export async function routeNowa(ctx, req, res, rq) {',
      '  const { pathname } = rq;',
      "  if (pathname === '/api/nowa') return true;",
      '  return false;',
      '}',
    ].join('\n')]]);
    expect(opisRoznicy(mutant)).toBe('trasa bez klasy w tabeli: /api/nowa');
  });

  it('mutacja: dopisane `action === \'nowa\'` → trasa bez klasy `/api/sessions/:id/nowa`', () => {
    const mutant = mutujPlik(SESJE, AKCJA, `${AKCJA}    if (action === 'nowa' && segments.length === 4) { return true; }\n`);
    expect(opisRoznicy(mutant)).toBe('trasa bez klasy w tabeli: /api/sessions/:id/nowa');
  });

  it('mutacja: dopisane `pathname.startsWith(\'/api/nowe\')` → trasa bez klasy `/api/nowe`', () => {
    const mutant = mutujPlik(SYSTEM, MAC, `  if (pathname.startsWith('/api/nowe')) { return true; }\n${MAC}`);
    expect(opisRoznicy(mutant)).toBe('trasa bez klasy w tabeli: /api/nowe');
  });

  it('mutacja: usunięta gałąź `/api/mac` → martwy wpis `/api/mac`', () => {
    const kod = KOD_TRAS.get(SYSTEM) ?? '';
    const mutant = new Map([...KOD_TRAS, [SYSTEM, bezGalezi(kod, "pathname === '/api/mac'")]]);
    expect(opisRoznicy(mutant)).toBe('martwy wpis tabeli: /api/mac');
  });

  it('mutacja: dopisane `segments[4] === \'nowa\'` pod `action === \'diff\'` → zgodność (podakcja dziedziczy klasę)', () => {
    const DIFF = "    if (action === 'diff' && segments.length === 4) {\n";
    const mutant = mutujPlik(SESJE, DIFF, `${DIFF}      if (segments[4] === 'nowa') { return true; }\n`);
    expect(mutant.get(SESJE)).not.toBe(KOD_TRAS.get(SESJE));
    expect(opisRoznicy(mutant)).toBe('');
  });

  it('mutacja: `switch (action)` i `Set.has(pathname)` → nierozpoznana postać z plikiem i linią', () => {
    const zSwitch = mutujPlik(SESJE, AKCJA, `${AKCJA}    switch (action) { case 'nowa': return true; default: break; }\n`);
    expect(opisRoznicy(zSwitch))
      .toMatch(/^nierozpoznana postać dopasowania, routes\/sessions\.ts, linia \d+: switch \(action\)/u);
    const zSetem = mutujPlik(SYSTEM, MAC, `  if (NOWE_TRASY.has(pathname)) { return true; }\n${MAC}`);
    expect(opisRoznicy(zSetem))
      .toMatch(/^nierozpoznana postać dopasowania, routes\/system\.ts, linia \d+: NOWE_TRASY\.has\(pathname\)$/u);
  });

  it('mutacja: `rq.pathname` zamiast destrukturyzacji → nierozpoznana postać (obejście inwentarza)', () => {
    const mutant = mutujPlik(SYSTEM, MAC, `  if (rq.pathname === '/api/nowa') { return true; }\n${MAC}`);
    expect(opisRoznicy(mutant))
      .toMatch(/^nierozpoznana postać dopasowania, routes\/system\.ts, linia \d+: rq\.pathname$/u);
  });

  it('mutacja: w `handle` ścieżka przekazana do grupy inną drogą niż literał `rq` → nierozpoznana postać', () => {
    const KOTWICA = '    for (const group of ROUTE_GROUPS) {\n';
    const mutant = mutujPlik(ROUTER_PLIK, KOTWICA, `    const inne = { pathname };\n${KOTWICA}`);
    expect(opisRoznicy(mutant)).toMatch(/^nierozpoznana postać dopasowania, router\.ts, linia \d+: pathname$/u);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 4. Strażnik powierzchni wejść HTTP w `index.ts`
// ---------------------------------------------------------------------------------------------------------------

const ZDARZENIA_HTTP = new Set(['request', 'upgrade', 'connect', 'checkContinue', 'checkExpectation']);
const METODY_SLUCHACZA = new Set(['on', 'addListener', 'prependListener', 'once', 'prependOnceListener']);

/** Stan dziś: serwer bez handlera w konstruktorze, jeden słuchacz `request` (kontrola demo albo router) i jeden `upgrade`. */
const OCZEKIWANE_WEJSCIA = [
  'http.createServer()',
  "server.on('request', demoControl?.handler ?? router)",
  "server.on('upgrade', <funkcja>)",
].sort();

/** Podpisy rozpoznanych wejść HTTP pliku z numerem linii. */
function wejsciaHttp(kod: string): Array<{ readonly podpis: string; readonly linia: number }> {
  const linia = numerLinii(kod);
  const argument = (x: unknown): string => {
    const w = wezel(x);
    if (w === null) return '?';
    return w.type === 'ArrowFunctionExpression' || w.type === 'FunctionExpression' ? '<funkcja>' : zrodlo(kod, w);
  };
  const wynik: Array<{ podpis: string; linia: number }> = [];
  odwiedz(parsuj(kod), (n) => {
    if (n.type !== 'CallExpression' && n.type !== 'NewExpression') return;
    const callee = wezel(n['callee']);
    if (callee === null) return;
    const args = n['arguments'] as unknown[];
    const wlasnosc = callee.type === 'MemberExpression' && callee['computed'] !== true ? nazwa(callee['property']) : null;
    const gola = nazwa(callee);
    const obiekt = wezel(callee['object']);
    if (n.type === 'CallExpression' && wlasnosc !== null && METODY_SLUCHACZA.has(wlasnosc) && obiekt !== null) {
      const zdarzenie = napis(args[0]);
      if (zdarzenie === null || !ZDARZENIA_HTTP.has(zdarzenie)) return;
      const reszta = args.slice(1).map(argument).join(', ');
      wynik.push({ podpis: `${zrodlo(kod, obiekt)}.${wlasnosc}('${zdarzenie}', ${reszta})`, linia: linia(n.start) });
      return;
    }
    const tworzy = n.type === 'CallExpression' && (wlasnosc === 'createServer' || gola === 'createServer');
    const konstruuje = n.type === 'NewExpression' && (wlasnosc === 'Server' || gola === 'Server');
    if (!tworzy && !konstruuje) return;
    const podpis = `${konstruuje ? 'new ' : ''}${zrodlo(kod, callee)}(${args.map(argument).join(', ')})`;
    wynik.push({ podpis, linia: linia(n.start) });
  });
  return wynik;
}

/** Różnica wejść pliku i oczekiwanych po podpisie (z krotnością); pusty napis = zgodność. */
function opisWejsc(kod: string): string {
  const reszta = [...OCZEKIWANE_WEJSCIA];
  const nadmiar: string[] = [];
  for (const { podpis, linia } of wejsciaHttp(kod)) {
    const at = reszta.indexOf(podpis);
    if (at >= 0) reszta.splice(at, 1);
    else nadmiar.push(`nowe wejście HTTP, linia ${String(linia)}: ${podpis}`);
  }
  return [...nadmiar, ...reszta.map((podpis) => `brak oczekiwanego wejścia HTTP: ${podpis}`)].join('\n');
}

const SLUCHACZ_REQUEST = "server.on('request', demoControl?.handler ?? router);";

describe('strażnik powierzchni wejść HTTP (`index.ts`)', () => {
  it('wejścia HTTP w `index.ts` = stan oczekiwany', () => {
    expect(opisWejsc(INDEX_KOD)).toBe('');
  });

  it('mutacja: dopisane `server.prependListener(\'request\', h)` → nowe wejście z nazwą', () => {
    const mutant = mutuj(INDEX_KOD, SLUCHACZ_REQUEST, `${SLUCHACZ_REQUEST}\n  server.prependListener('request', h);`);
    expect(opisWejsc(mutant)).toMatch(/^nowe wejście HTTP, linia \d+: server\.prependListener\('request', h\)$/u);
  });

  it('mutacja: `http.createServer(h)` → nowe wejście i brak serwera bez handlera', () => {
    const mutant = mutuj(INDEX_KOD, 'http.createServer()', 'http.createServer(h)');
    expect(opisWejsc(mutant)).toMatch(
      /^nowe wejście HTTP, linia \d+: http\.createServer\(h\)\nbrak oczekiwanego wejścia HTTP: http\.createServer\(\)$/u,
    );
  });

  it('mutacja: argument `request` zmieniony na `wrap(router)` → nieznane opakowanie z nazwą', () => {
    const mutant = mutuj(INDEX_KOD, SLUCHACZ_REQUEST, "server.on('request', wrap(router));");
    expect(opisWejsc(mutant)).toMatch(/^nowe wejście HTTP, linia \d+: server\.on\('request', wrap\(router\)\)\n/u);
  });

  it('mutacja: drugie `server.on(\'upgrade\', …)` → nowe wejście z nazwą', () => {
    const mutant = mutuj(INDEX_KOD, SLUCHACZ_REQUEST,
      `${SLUCHACZ_REQUEST}\n  server.on('upgrade', (req, socket) => { socket.destroy(); });`);
    expect(opisWejsc(mutant)).toMatch(/^nowe wejście HTTP, linia \d+: server\.on\('upgrade', <funkcja>\)$/u);
  });

  it('mutacja: `new http.Server(h)` i słuchacz `checkContinue` → nowe wejścia z nazwą', () => {
    const mutant = mutuj(INDEX_KOD, SLUCHACZ_REQUEST,
      `${SLUCHACZ_REQUEST}\n  const drugi = new http.Server(h);\n  drugi.on('checkContinue', h);`);
    expect(opisWejsc(mutant).split('\n')).toEqual([
      expect.stringMatching(/: new http\.Server\(h\)$/u),
      expect.stringMatching(/: drugi\.on\('checkContinue', h\)$/u),
    ]);
  });
});

/** Człony łańcucha `&&` wyrażenia (bez nawiasów), jako tekst źródła. */
function czlonyI(kod: string, n: Wezel): string[] {
  if (n.type === 'LogicalExpression' && n['operator'] === '&&') {
    const lewy = wezel(n['left']);
    const prawy = wezel(n['right']);
    return [...(lewy === null ? [] : czlonyI(kod, lewy)), ...(prawy === null ? [] : czlonyI(kod, prawy))];
  }
  return [zrodlo(kod, n)];
}

const WARUNEK_KONTROLI = 'config.demoReview === null';
/** Test inicjalizatora `demoControl` dziś: kotwica mutacji. */
const TEST_KONTROLI = `config.demo && ${WARUNEK_KONTROLI} && herdr?.scenarioPanels !== undefined`;

/** Warunek składania kontroli demo w `index.ts`; pusty napis = test inicjalizatora `demoControl` ma człon {@link WARUNEK_KONTROLI}. */
function opisWarunkuKontroli(kod: string): string {
  const linia = numerLinii(kod);
  const znalezione: Wezel[] = [];
  odwiedz(parsuj(kod), (n) => {
    if (n.type === 'VariableDeclarator' && nazwa(n['id']) === 'demoControl') znalezione.push(n);
  });
  const [deklaracja] = znalezione;
  if (deklaracja === undefined || znalezione.length > 1) {
    return `nierozpoznana postać składania kontroli demo: ${String(znalezione.length)} deklaracji \`demoControl\``;
  }
  const init = wezel(deklaracja['init']);
  const test = init?.type === 'ConditionalExpression' ? wezel(init['test']) : null;
  if (test === null) {
    return `nierozpoznana postać składania kontroli demo, linia ${String(linia(deklaracja.start))}: ${zrodlo(kod, deklaracja)}`;
  }
  return czlonyI(kod, test).includes(WARUNEK_KONTROLI)
    ? ''
    : `Kontrola demo składana bez warunku trybu recenzji, linia ${String(linia(test.start))}: ${zrodlo(kod, test)}`;
}

describe('strażnik powierzchni: kontrola demo nie istnieje w trybie recenzji (`index.ts`)', () => {
  it('inicjalizator `demoControl` ma człon `config.demoReview === null`', () => {
    expect(opisWarunkuKontroli(INDEX_KOD)).toBe('');
  });

  it('mutacja: usunięty warunek → kontrola demo składana bez warunku z linią', () => {
    const mutant = mutuj(INDEX_KOD, TEST_KONTROLI, 'config.demo && herdr?.scenarioPanels !== undefined');
    expect(opisWarunkuKontroli(mutant)).toMatch(
      /^Kontrola demo składana bez warunku trybu recenzji, linia \d+: config\.demo && herdr\?\.scenarioPanels !== undefined$/u,
    );
  });

  it('mutacja: odwrócony warunek (`!== null`) → kontrola demo składana bez warunku', () => {
    const mutant = mutuj(INDEX_KOD, TEST_KONTROLI, TEST_KONTROLI.replace('=== null', '!== null'));
    expect(opisWarunkuKontroli(mutant)).toMatch(/^Kontrola demo składana bez warunku trybu recenzji, linia \d+: /u);
  });

  it('mutacja: `let demoControl` i przypisanie w `if` → nierozpoznana postać z linią', () => {
    const mutant = mutuj(INDEX_KOD, 'const demoControl = ', 'let demoControl = null;\n  if (x) demoControl = ');
    expect(opisWarunkuKontroli(mutant)).toMatch(/^nierozpoznana postać składania kontroli demo, linia \d+: demoControl = null$/u);
  });
});
