/**
 * Czarna skrzynka tras trybu recenzji demo. Test patrzy od zewnątrz: oczekiwania biorą się z tabeli klas tras
 * i z kodu obsługi tras w `server/src/router.ts`, a nie z tabeli bramki (`server/src/demo/review-routes.ts` test
 * celowo nie importuje).
 *
 * Stanowisko (`helpers/stanowisko-recenzji.ts`): prawdziwy router na managerze demo (`demoContentPl`), magazyn
 * urządzeń w katalogu tymczasowym, `attachDeactivation`, klucz urządzenia z kodu recenzenta i `Origin` z allow-listy.
 * Każdy wiersz tabeli dostaje świeże stanowisko, więc wiersze nie widzą nawzajem swoich skutków.
 *
 * Reguły tabel:
 * - wiersz = metoda, ścieżka z zapytaniem, ciało, dokładny status i asercja odpowiedzi albo skutku;
 * - w klasie `allow` 405 i każde 5xx to czerwony test; jedyny wyjątek to `POST /api/voice/token` → 503 (tryb recenzji
 *   nie ma dyktowania-atrapy);
 * - wiersze akcji sesji przechodzą też w zwykłym demo z tym samym statusem i skutkiem (wyrocznia różnicowa: tryb
 *   recenzji nie zmienia trasy dozwolonej);
 * - odmowy przychodzą przed skutkiem: test sprawdza stan (transkrypt, notatki, hub strumieni, magazyn urządzeń,
 *   linie logu obsługi), nie tylko status, a kontrola dodatnia pokazuje, że ten sam pomiar widzi skutek.
 *
 * Wysyłki piszą do `demo-rarog-stop` (`running`, atrapa `idle`), który przyjmuje je w obu trybach (wiersz `messages`
 * tabeli akcji). Seed `demo-willow` stoi w `waiting-permission`, a manager odmawia wtedy wysyłki 409
 * `session.not-accepting-messages`, więc na nim odmowa 401 nie miałaby czego zatrzymać; testy 401 biją w obie sesje.
 *
 * Kod recenzenta zna wyłącznie stanowisko (losowy w czasie biegu); po każdym teście żadna linia logu ani ciało
 * odpowiedzi go nie zawiera.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DEMO_REVIEW_ERROR } from '@rarog/shared/rest';
import { demoContentPl } from '../src/demo/content/pl.ts';
import { DEMO_MAC_STATS } from '../src/demo/mac.ts';
import { DEMO_NOTE_CWD, DEMO_NOTE_UPDATED_AT } from '../src/demo/notes.ts';
import { demoProjectCwd, demoSeedUploads } from '../src/demo/seeds.ts';
import { demoPlanUsage, demoPlanUsageDetails } from '../src/demo/usage.ts';
import { VOICE_UNCONFIGURED } from '../src/voice/soniox.ts';
import {
  type Odpowiedz, SONDA, type Stanowisko, type Strumien, type Tryb, type Urzadzenie, stanowisko,
} from './helpers/stanowisko-recenzji.ts';

// ---------------------------------------------------------------------------
// Stałe demo i pomocnicze
// ---------------------------------------------------------------------------

/** 8 sesji seedów demo (te same identyfikatory w każdym języku). */
const SESJE = [
  'demo-willow', 'demo-willow-parser', 'demo-rarog', 'demo-fleet-ops', 'demo-data-loader', 'demo-pipe-link',
  'demo-map-view', 'demo-rarog-stop',
] as const;
const DEMO_ROOT = '/Users/demo/Projects/';
const CWD_GLOWNY = demoProjectCwd(demoContentPl, 'main');
const ZDJECIE = demoSeedUploads(demoContentPl)[0];
if (ZDJECIE === undefined) throw new Error('demo bez zdjęć seedów');
/** Token urządzenia APNs w kształcie hex (bez kanału APNs trasy push są no-opem). */
const TOKEN = 'ab'.repeat(32);
const q = encodeURIComponent;

type Klasa = 'allow' | 'retired' | 'refuse' | 'absent';

const stanowiska: Stanowisko[] = [];

afterEach(async () => {
  for (const s of stanowiska.splice(0)) {
    await s.close();
    for (const line of s.logs) expect(s.zawieraKod(line), `kod recenzenta w logu: ${line}`).toBe(false);
    expect(s.wyciekiKodu, 'kod recenzenta w odpowiedzi (ciało, strumień, nagłówki)').toEqual([]);
  }
});

async function otworz(tryb: Tryb): Promise<Stanowisko> {
  const s = await stanowisko(tryb);
  stanowiska.push(s);
  return s;
}

const opis = (res: Odpowiedz): string => `${String(res.status)} ${res.bytes.toString('utf8').slice(0, 300)}`;

/** Ciało błędu: kod `error` i kod zdania (`messageRef.code`), który mówi, KTÓRA obsługa odpowiedziała. */
function blad(res: Odpowiedz, status: number, error: string, zdanie?: string): void {
  expect(res.status, opis(res)).toBe(status);
  expect(res.json?.['error'], opis(res)).toBe(error);
  if (zdanie !== undefined) expect((res.json?.['messageRef'] as { code?: string } | undefined)?.code).toBe(zdanie);
}

const liniiZ = (s: Stanowisko, fragment: string): number => s.logs.filter((line) => line.includes(fragment)).length;

/** Wpisy użytkownika z tym tekstem w transkrypcie sesji (stan managera, nie odpowiedź HTTP). */
function wpisyUzytkownika(s: Stanowisko, id: string, tekst: string): number {
  return s.manager.transcript(id).messages
    .filter((m) => m.role === 'user' && JSON.stringify(m.blocks).includes(tekst)).length;
}

/** Wpisy użytkownika z tym tekstem w ramkach `message` strumienia. */
function wpisyWStrumieniu(strumien: Strumien, tekst: string): number {
  return strumien.ramki().filter((r) => r['type'] === 'message'
    && (r['message'] as { role?: string } | undefined)?.role === 'user'
    && JSON.stringify(r['message']).includes(tekst)).length;
}

interface Znacznik {
  readonly state?: string;
  readonly seen?: boolean;
}

/**
 * Stan i znacznik „przeczytane” (`seen`) sesji z dwóch miejsc: stan managera i ramka `sessions-snapshot` świeżego
 * `/api/stream` (to, co dostaje apka). Oba muszą się zgadzać.
 */
async function znacznik(s: Stanowisko, u: Urzadzenie, id: string): Promise<Znacznik> {
  const sesja = s.manager.get(id);
  const zManagera: Znacznik = { state: sesja?.state, seen: sesja?.seen };
  const strumien = s.strumien('/api/stream', { auth: u.auth });
  try {
    const snapshot = await strumien.czekajNa((r) => r['type'] === 'sessions-snapshot');
    const wpis = (snapshot['sessions'] as (Znacznik & { readonly id: string })[]).find((x) => x.id === id);
    expect({ state: wpis?.state, seen: wpis?.seen }, `${id}: sessions-snapshot a manager`).toEqual(zManagera);
  } finally {
    strumien.zamknij();
  }
  return zManagera;
}

/** Pola z czasem liczonym od „teraz” (limity demo), usuwane przed porównaniem z fikcją demo. */
function bezCzasow(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (key, inner: unknown) => (
    key === 'resetsAt' || key === 'fetchedAt' ? undefined : inner
  ))) as unknown;
}

// ---------------------------------------------------------------------------
// Tabele przypadków
// ---------------------------------------------------------------------------

interface Kontekst {
  readonly s: Stanowisko;
  readonly u: Urzadzenie;
  readonly res: Odpowiedz;
}

interface KontekstSse {
  readonly s: Stanowisko;
  readonly u: Urzadzenie;
  readonly strumien: Strumien;
}

interface Wiersz {
  /** Wpis tabeli klas tras, którego dotyczy wiersz. */
  readonly k3: string;
  readonly klasa: Klasa;
  readonly method: string;
  /** Ścieżka z zapytaniem, dosłownie. */
  readonly sciezka: string;
  readonly body?: unknown;
  /** Ciało zależne od stanowiska (kod recenzenta zna tylko ono). */
  readonly cialo?: (s: Stanowisko) => unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly status: number;
  /** Stan sesji przed zapytaniem, ustawiany przez HTTP tym samym urządzeniem. */
  readonly przygotuj?: (k: { readonly s: Stanowisko; readonly u: Urzadzenie }) => Promise<void>;
  readonly sprawdz?: (k: Kontekst) => void | Promise<void>;
  /** Trasa strumienia SSE: asercja na otwartym strumieniu zamiast `sprawdz`. */
  readonly sse?: (k: KontekstSse) => void | Promise<void>;
}

/** Jedyny wiersz klasy `allow`, któremu wolno 5xx: dyktowanie bez klucza Soniox. */
const WYJATEK_5XX = 'POST /api/voice/token';

const tytul = (w: Wiersz): string => `${w.method} ${w.sciezka} → ${String(w.status)} (${w.klasa}, ${w.k3})`;

/** Kryterium klasy `allow`: 405 i każde 5xx przewraca wiersz, poza {@link WYJATEK_5XX} (tylko 503). */
function regulaAllow(w: Wiersz, status: number): void {
  if (w.klasa !== 'allow') return;
  expect(status, `${tytul(w)}: 405 w klasie allow`).not.toBe(405);
  if (`${w.method} ${w.sciezka}` === WYJATEK_5XX) expect(status).toBe(503);
  else expect(status, `${tytul(w)}: 5xx w klasie allow`).toBeLessThan(500);
}

/** Jeden wiersz na świeżym stanowisku tego trybu; oddaje otrzymany status. */
async function przebieg(tryb: Tryb, w: Wiersz): Promise<number> {
  const s = await otworz(tryb);
  const u = await s.sparuj();
  await w.przygotuj?.({ s, u });
  if (w.sse !== undefined) {
    const strumien = s.strumien(w.sciezka, { auth: u.auth });
    const status = await strumien.status;
    expect(status, tytul(w)).toBe(w.status);
    regulaAllow(w, status);
    await w.sse({ s, u, strumien });
    strumien.zamknij();
    return status;
  }
  const body = w.cialo?.(s) ?? w.body;
  const res = await s.zadanie(w.method, w.sciezka, {
    auth: u.auth, ...(body === undefined ? {} : { body }), ...(w.headers === undefined ? {} : { headers: w.headers }),
  });
  expect(res.status, `${tytul(w)}: ${opis(res)}`).toBe(w.status);
  regulaAllow(w, res.status);
  await w.sprawdz?.({ s, u, res });
  return res.status;
}

/** Wiersz na każdy wpis tabeli klas tras poza akcjami sesji (te niżej, z wyrocznią różnicową). */
const WIERSZE_K3: readonly Wiersz[] = [
  {
    k3: '/health', klasa: 'allow', method: 'GET', sciezka: '/health', status: 200,
    sprawdz: ({ res }) => { expect(res.json?.['ok']).toBe(true); },
  },
  {
    k3: '/api/version', klasa: 'allow', method: 'GET', sciezka: '/api/version', status: 200,
    sprawdz: ({ res }) => {
      expect(res.json?.['tailnet']).toBeNull();
      expect(res.json?.['voiceEnabled']).toBe(false);
    },
  },
  {
    k3: '/api/pair', klasa: 'allow', method: 'POST', sciezka: '/api/pair', cialo: (s) => s.cialoParowania('iPad·Rarog'),
    status: 200,
    sprawdz: async ({ s, u, res }) => {
      // Kod się nie zużywa i nie odpina innych — drugie urządzenie obok pierwszego, pierwsze dalej 200.
      const nowe = String(res.json?.['deviceId']);
      expect(nowe).not.toBe(u.id);
      expect(s.store.active().map((r) => r.id).sort()).toEqual([u.id, nowe].sort());
      expect((await s.zadanie('GET', '/api/version', { auth: u.auth })).status).toBe(200);
      expect(liniiZ(s, `devices: paired ${nowe} (review code)`)).toBe(1);
    },
  },
  {
    k3: '/api/login', klasa: 'retired', method: 'POST', sciezka: '/api/login', body: {}, status: 410,
    sprawdz: ({ res }) => { blad(res, 410, 'login-retired', 'rest.login-retired'); },
  },
  {
    k3: '/api/pairings', klasa: 'refuse', method: 'POST', sciezka: '/api/pairings', body: {}, status: 403,
    sprawdz: ({ s, res }) => {
      blad(res, 403, DEMO_REVIEW_ERROR, 'demo.review-refused');
      expect(res.json?.['code']).toBeUndefined();
      expect(liniiZ(s, 'pairing code from device')).toBe(0);
    },
  },
  {
    k3: '/api/devices', klasa: 'allow', method: 'GET', sciezka: '/api/devices', status: 200,
    sprawdz: ({ u, res }) => {
      const lista = res.json?.['devices'] as { id: string; current: boolean }[];
      expect(lista.filter((d) => d.current).map((d) => d.id)).toEqual([u.id]);
    },
  },
  {
    k3: '/api/devices/me', klasa: 'allow', method: 'GET', sciezka: '/api/devices/me', status: 200,
    sprawdz: ({ u, res }) => { expect((res.json?.['device'] as { id: string }).id).toBe(u.id); },
  },
  {
    k3: '/api/devices/forget', klasa: 'allow', method: 'POST', sciezka: '/api/devices/forget', body: {}, status: 204,
    sprawdz: async ({ s, u }) => {
      expect(s.store.get(u.id)).toBeUndefined();
      blad(await s.zadanie('GET', '/api/version', { auth: u.auth }), 401, 'device-revoked', 'rest.device-revoked');
    },
  },
  {
    k3: '/api/stream', klasa: 'allow', method: 'GET', sciezka: '/api/stream', status: 200,
    sse: async ({ strumien }) => {
      const snapshot = await strumien.czekajNa((r) => r['type'] === 'sessions-snapshot');
      expect(strumien.ramki()[0]?.['type']).toBe('hello');
      expect((snapshot['sessions'] as { id: string }[]).map((x) => x.id).sort()).toEqual([...SESJE].sort());
    },
  },
  {
    k3: '/api/notes', klasa: 'allow', method: 'PUT', sciezka: '/api/notes',
    body: { cwd: DEMO_NOTE_CWD, text: 'Notatka z tabeli K3', updatedAt: DEMO_NOTE_UPDATED_AT }, status: 200,
    sprawdz: async ({ s, u, res }) => {
      expect(res.json?.['updatedAt']).toBeTypeOf('number');
      const odczyt = await s.zadanie('GET', `/api/notes?cwd=${q(DEMO_NOTE_CWD)}`, { auth: u.auth });
      expect(odczyt.status).toBe(200);
      expect(odczyt.json?.['text']).toBe('Notatka z tabeli K3');
    },
  },
  {
    k3: '/api/client-log', klasa: 'allow', method: 'POST', sciezka: '/api/client-log',
    body: { events: [{ at: '2026-11-07T09:00:00.000Z', level: 'info', msg: 'z tabeli K3' }] }, status: 202,
    sprawdz: ({ res }) => { expect(res.json).toEqual({ ok: true, written: 1 }); },
  },
  {
    k3: '/api/presence', klasa: 'allow', method: 'POST', sciezka: '/api/presence',
    body: { clientId: 'karta-z7', visible: true }, status: 204,
  },
  {
    k3: '/api/projects', klasa: 'allow', method: 'GET', sciezka: '/api/projects', status: 200,
    sprawdz: ({ res }) => {
      const projekty = res.json?.['projects'] as { path: string }[];
      expect(projekty).toHaveLength(6);
      for (const p of projekty) expect(p.path.startsWith(DEMO_ROOT), p.path).toBe(true);
    },
  },
  {
    k3: '/api/projects/recent', klasa: 'allow', method: 'GET', sciezka: '/api/projects/recent', status: 200,
    sprawdz: ({ res }) => {
      const projekty = res.json?.['projects'] as { cwd: string }[];
      expect(projekty.length).toBeGreaterThan(0);
      for (const p of projekty) expect(p.cwd.startsWith(DEMO_ROOT), p.cwd).toBe(true);
    },
  },
  {
    k3: '/api/resumable', klasa: 'allow', method: 'GET', sciezka: `/api/resumable?cwd=${q(CWD_GLOWNY)}`, status: 200,
    sprawdz: ({ res }) => {
      const wpisy = res.json?.['sessions'] as { cwd: string }[];
      expect(wpisy.length).toBeGreaterThan(0);
      for (const w of wpisy) expect(w.cwd).toBe(CWD_GLOWNY);
    },
  },
  {
    k3: '/api/resumable/recent', klasa: 'allow', method: 'GET', sciezka: `/api/resumable/recent?cwd=${q(CWD_GLOWNY)}`,
    status: 200,
    sprawdz: ({ res }) => {
      const wpisy = res.json?.['sessions'] as { cwd: string }[];
      expect(wpisy.length).toBeGreaterThan(0);
      for (const w of wpisy) expect(w.cwd).toBe(CWD_GLOWNY);
    },
  },
  {
    k3: '/api/usage', klasa: 'allow', method: 'GET', sciezka: '/api/usage', status: 200,
    sprawdz: ({ res }) => { expect(bezCzasow(res.json)).toEqual(bezCzasow(demoPlanUsage(Date.now()))); },
  },
  {
    k3: '/api/usage/details', klasa: 'allow', method: 'GET', sciezka: '/api/usage/details', status: 200,
    sprawdz: ({ res }) => { expect(bezCzasow(res.json)).toEqual(bezCzasow(demoPlanUsageDetails(Date.now()))); },
  },
  {
    k3: '/api/mac', klasa: 'allow', method: 'GET', sciezka: '/api/mac', status: 200,
    sprawdz: ({ res }) => { expect(res.json).toEqual({ ...DEMO_MAC_STATS }); },
  },
  {
    k3: '/api/models', klasa: 'allow', method: 'GET', sciezka: '/api/models', status: 200,
    sprawdz: ({ res }) => { expect((res.json?.['models'] as unknown[]).length).toBeGreaterThan(0); },
  },
  {
    k3: '/api/fs', klasa: 'allow', method: 'GET', sciezka: '/api/fs', status: 200,
    sprawdz: ({ res }) => {
      const wpisy = res.json?.['entries'] as { path: string }[];
      expect(wpisy.length).toBeGreaterThan(0);
      for (const w of wpisy) expect(w.path.startsWith(DEMO_ROOT), w.path).toBe(true);
    },
  },
  {
    k3: '/api/voice/token', klasa: 'allow', method: 'POST', sciezka: '/api/voice/token', body: {}, status: 503,
    sprawdz: ({ res }) => {
      blad(res, 503, VOICE_UNCONFIGURED);
      expect(res.json?.['apiKey']).toBeUndefined();
    },
  },
  {
    k3: '/api/push/apns', klasa: 'allow', method: 'POST', sciezka: '/api/push/apns',
    body: { token: TOKEN, environment: 'development', label: 'iPhone', alerts: true }, status: 204,
  },
  {
    k3: '/api/push/apns/unregister', klasa: 'allow', method: 'POST', sciezka: '/api/push/apns/unregister',
    body: { token: TOKEN }, status: 204,
  },
  {
    k3: '/api/push/apns/status', klasa: 'allow', method: 'POST', sciezka: '/api/push/apns/status',
    body: { token: TOKEN }, status: 200,
    sprawdz: ({ res }) => { expect(res.json?.['enabled']).toBe(false); },
  },
  {
    k3: '/api/push/live-activity', klasa: 'allow', method: 'POST', sciezka: '/api/push/live-activity',
    body: { deviceToken: TOKEN, activityId: 'karta-z7', updateToken: TOKEN }, status: 204,
  },
  {
    k3: '/api/push/live-activity/end', klasa: 'allow', method: 'POST', sciezka: '/api/push/live-activity/end',
    body: { deviceToken: TOKEN, activityId: 'karta-z7' }, status: 204,
  },
  {
    k3: '/api/sessions', klasa: 'allow', method: 'POST', sciezka: '/api/sessions', body: { cwd: CWD_GLOWNY }, status: 202,
    sprawdz: ({ s, res }) => {
      expect(res.json?.['state']).toBe('starting');
      expect(s.manager.get(String(res.json?.['sessionId']))).toBeDefined();
    },
  },
  {
    k3: '/api/demo/pairing', klasa: 'absent', method: 'POST', sciezka: '/api/demo/pairing', body: {}, status: 404,
    sprawdz: ({ s, u, res }) => {
      // Zwykłe demo odpięłoby tu wszystkich i wydało kod: w trybie recenzji urządzenie zostaje, kodu nie ma.
      blad(res, 404, 'not-found', 'rest.endpoint-not-found');
      expect(s.store.get(u.id)).toBeDefined();
      expect(liniiZ(s, 'demo: pairing code')).toBe(0);
    },
  },
  {
    k3: '/api/demo/control', klasa: 'absent', method: 'POST', sciezka: '/api/demo/control', body: {},
    headers: { 'x-rarog-demo-token': 'demo' }, status: 404,
    sprawdz: ({ res }) => { blad(res, 404, 'not-found', 'rest.endpoint-not-found'); },
  },
  {
    k3: '/api/term', klasa: 'absent', method: 'GET', sciezka: '/api/term', status: 404,
    // `term.disabled` znaczyłoby, że żądanie doszło do obsługi terminala; bramka odpowiada jak nieznana ścieżka.
    sprawdz: ({ res }) => { blad(res, 404, 'not-found', 'rest.endpoint-not-found'); },
  },
  {
    k3: '/api/term', klasa: 'absent', method: 'POST', sciezka: '/api/term', body: { cwd: CWD_GLOWNY }, status: 404,
    sprawdz: ({ res }) => { blad(res, 404, 'not-found', 'rest.endpoint-not-found'); },
  },
  {
    k3: '/api/term/:id', klasa: 'absent', method: 'DELETE', sciezka: '/api/term/t1', status: 404,
    sprawdz: ({ res }) => { blad(res, 404, 'not-found', 'rest.endpoint-not-found'); },
  },
  {
    k3: '/api/term/:id/history', klasa: 'absent', method: 'GET', sciezka: '/api/term/t1/history?lines=5', status: 404,
    sprawdz: ({ res }) => { blad(res, 404, 'not-found', 'rest.endpoint-not-found'); },
  },
  {
    k3: '/api/fs/mkdir', klasa: 'absent', method: 'POST', sciezka: '/api/fs/mkdir',
    body: { parent: CWD_GLOWNY, name: 'nowy' }, status: 404,
    // `mkdir-disabled` (409) would mean the request reached the handler; the gate answers as for an unknown path.
    sprawdz: ({ res }) => { blad(res, 404, 'not-found', 'rest.endpoint-not-found'); },
  },
  {
    k3: '/api/admin/*', klasa: 'absent', method: 'GET', sciezka: '/api/admin/devices', status: 404,
    sprawdz: ({ res }) => { blad(res, 404, 'not-found', 'rest.endpoint-not-found'); },
  },
  {
    k3: '/api/admin/*', klasa: 'absent', method: 'POST', sciezka: '/api/admin/pair', body: {}, status: 404,
    sprawdz: ({ s, res }) => {
      blad(res, 404, 'not-found', 'rest.endpoint-not-found');
      expect(res.json?.['code']).toBeUndefined();
      expect(s.store.active()).toHaveLength(1);
    },
  },
  {
    k3: 'każda inna ścieżka', klasa: 'absent', method: 'GET', sciezka: '/api/xyz', status: 404,
    sprawdz: ({ res }) => { blad(res, 404, 'not-found', 'rest.endpoint-not-found'); },
  },
  {
    k3: 'każda inna ścieżka', klasa: 'absent', method: 'POST', sciezka: '/api/hidden/restore', body: {}, status: 404,
    sprawdz: ({ res }) => { blad(res, 404, 'not-found', 'rest.endpoint-not-found'); },
  },
];

/**
 * Akcje `/api/sessions/:id/<akcja>` (17, jednostka `segments[3]` routera) z podakcjami. Status i skutek z kodu
 * obsługi w `router.ts` i managera demo; każdy wiersz przechodzi tak samo w zwykłym demo.
 */
const AKCJE: readonly Wiersz[] = [
  {
    k3: '/api/sessions/:id/stream', klasa: 'allow', method: 'GET', sciezka: '/api/sessions/demo-willow/stream',
    status: 200,
    sse: async ({ strumien }) => {
      const ramka = await strumien.czekajNa((r) => r['type'] === 'transcript-snapshot');
      expect(ramka['sessionId']).toBe('demo-willow');
      expect((ramka['messages'] as unknown[]).length).toBeGreaterThan(0);
    },
  },
  {
    k3: '/api/sessions/:id/diff', klasa: 'allow', method: 'GET', sciezka: '/api/sessions/demo-willow/diff', status: 200,
    sprawdz: ({ res }) => { expect((res.json?.['files'] as unknown[]).length).toBeGreaterThan(0); },
  },
  {
    k3: '/api/sessions/:id/diff', klasa: 'allow', method: 'GET', sciezka: '/api/sessions/demo-willow/diff/files',
    status: 200,
    sprawdz: ({ res }) => {
      expect((res.json?.['files'] as { path: string }[]).map((f) => f.path)).toContain('src/notes.ts');
    },
  },
  {
    k3: '/api/sessions/:id/diff', klasa: 'allow', method: 'GET',
    sciezka: `/api/sessions/demo-willow/diff/file?path=${q('src/notes.ts')}`, status: 200,
    sprawdz: ({ res }) => {
      expect(res.json?.['path']).toBe('src/notes.ts');
      expect(String(res.json?.['patch'])).toMatch(/^diff --git a\/src\/notes\.ts/);
    },
  },
  {
    k3: '/api/sessions/:id/commands', klasa: 'allow', method: 'GET', sciezka: '/api/sessions/demo-willow/commands',
    status: 200,
    sprawdz: ({ res }) => {
      expect(res.json?.['revision']).toBeTypeOf('string');
      expect((res.json?.['commands'] as unknown[]).length).toBeGreaterThan(0);
    },
  },
  {
    k3: '/api/sessions/:id/uploads', klasa: 'allow', method: 'GET',
    sciezka: `/api/sessions/demo-pipe-link/uploads/${ZDJECIE.file}`, status: 200,
    sprawdz: ({ res }) => {
      expect(res.headers['content-type']).toBe('image/png');
      expect(res.bytes.subarray(1, 4).toString('latin1')).toBe('PNG');
    },
  },
  {
    k3: '/api/sessions/:id/messages', klasa: 'allow', method: 'POST', sciezka: '/api/sessions/demo-rarog-stop/messages',
    body: { text: 'Wiadomość z tabeli akcji' }, status: 202,
    sprawdz: ({ s, res }) => {
      expect(res.json).toEqual({ ok: true });
      expect(wpisyUzytkownika(s, 'demo-rarog-stop', 'Wiadomość z tabeli akcji')).toBe(1);
    },
  },
  {
    k3: '/api/sessions/:id/interrupt', klasa: 'allow', method: 'POST', sciezka: '/api/sessions/demo-rarog/interrupt',
    body: {}, status: 202,
    sprawdz: ({ s, res }) => {
      expect((res.json?.['session'] as { state: string }).state).toBe('waiting-input');
      expect(s.manager.get('demo-rarog')?.state).toBe('waiting-input');
    },
  },
  {
    k3: '/api/sessions/:id/close', klasa: 'allow', method: 'POST', sciezka: '/api/sessions/demo-data-loader/close',
    body: {}, status: 200,
    sprawdz: ({ s, res }) => {
      expect(res.json).toEqual({ ok: true });
      expect(s.manager.get('demo-data-loader')).toBeUndefined();
    },
  },
  {
    // Panel w herdr: wznowienie idzie przez `create({resumeFrom})`, a ta trasa odpowiada odmową managera.
    k3: '/api/sessions/:id/resume', klasa: 'allow', method: 'POST', sciezka: '/api/sessions/demo-pipe-link/resume',
    body: {}, status: 409,
    sprawdz: ({ res }) => { blad(res, 409, 'bad-state', 'rest.bad-state'); },
  },
  {
    k3: '/api/sessions/:id/restart', klasa: 'allow', method: 'POST', sciezka: '/api/sessions/demo-rarog-stop/restart',
    body: {}, status: 409,
    sprawdz: ({ s, res }) => {
      blad(res, 409, 'bad-state', 'restart.unsupported');
      expect(s.manager.get('demo-rarog-stop')?.state).toBe('running');
    },
  },
  {
    // Sesja `done` bez znacznika: fokus stawia „przeczytane” (stan nie jest pracą).
    k3: '/api/sessions/:id/focus', klasa: 'allow', method: 'POST', sciezka: '/api/sessions/demo-willow-parser/focus',
    body: {}, status: 202,
    przygotuj: async ({ s, u }) => {
      expect(await znacznik(s, u, 'demo-willow-parser')).toEqual({ state: 'done', seen: undefined });
    },
    sprawdz: async ({ s, u, res }) => {
      expect(res.json).toEqual({ ok: true });
      expect(await znacznik(s, u, 'demo-willow-parser')).toEqual({ state: 'done', seen: true });
    },
  },
  {
    k3: '/api/sessions/:id/seen', klasa: 'allow', method: 'POST', sciezka: '/api/sessions/demo-willow-parser/seen',
    body: {}, status: 200,
    przygotuj: async ({ s, u }) => {
      expect(await znacznik(s, u, 'demo-willow-parser')).toEqual({ state: 'done', seen: undefined });
    },
    sprawdz: async ({ s, u, res }) => {
      expect(res.json).toEqual({ ok: true });
      expect(await znacznik(s, u, 'demo-willow-parser')).toEqual({ state: 'done', seen: true });
    },
  },
  {
    // Znacznik zdejmuje się tylko w `waiting-input` z `seen: true`: przerwanie pracy i „przeczytane” przez HTTP.
    k3: '/api/sessions/:id/unseen', klasa: 'allow', method: 'POST', sciezka: '/api/sessions/demo-rarog/unseen',
    body: {}, status: 200,
    przygotuj: async ({ s, u }) => {
      expect((await s.zadanie('POST', '/api/sessions/demo-rarog/interrupt', { auth: u.auth, body: {} })).status)
        .toBe(202);
      expect((await s.zadanie('POST', '/api/sessions/demo-rarog/seen', { auth: u.auth, body: {} })).status).toBe(200);
      expect(await znacznik(s, u, 'demo-rarog')).toEqual({ state: 'waiting-input', seen: true });
    },
    sprawdz: async ({ s, u, res }) => {
      expect(res.json).toEqual({ ok: true });
      expect(await znacznik(s, u, 'demo-rarog')).toEqual({ state: 'waiting-input', seen: undefined });
    },
  },
  {
    k3: '/api/sessions/:id/model', klasa: 'allow', method: 'POST', sciezka: '/api/sessions/demo-willow-parser/model',
    body: { model: 'sonnet' }, status: 400,
    sprawdz: ({ res }) => { blad(res, 400, 'bad-request', 'model.herdr-set-at-start'); },
  },
  {
    k3: '/api/sessions/:id/mode', klasa: 'allow', method: 'POST', sciezka: '/api/sessions/demo-willow-parser/mode',
    body: { mode: 'plan' }, status: 400,
    sprawdz: ({ res }) => { blad(res, 400, 'bad-request', 'session.mode-no-channel'); },
  },
  {
    k3: '/api/sessions/:id/permission', klasa: 'allow', method: 'POST',
    sciezka: '/api/sessions/demo-fleet-ops/permission', body: { decision: 'deny' }, status: 410,
    sprawdz: ({ res }) => { blad(res, 410, 'gone', 'rest.decision-expired'); },
  },
  {
    k3: '/api/sessions/:id/permissions', klasa: 'allow', method: 'POST',
    sciezka: '/api/sessions/demo-willow/permissions/demo-perm-willow', body: { decision: 'allow' }, status: 200,
    sprawdz: ({ s, res }) => {
      expect(res.json).toEqual({ ok: true });
      expect(JSON.stringify(s.manager.transcript('demo-willow').pendingPermissions)).not.toContain('demo-perm-willow');
    },
  },
  {
    k3: '/api/sessions/:id/answers', klasa: 'allow', method: 'POST', sciezka: '/api/sessions/demo-willow/answers/q-z7',
    body: { answers: [['A']] }, status: 410,
    sprawdz: ({ res }) => { blad(res, 410, 'gone', 'rest.decision-expired'); },
  },
];

/** Wpisy tabeli klas tras (ręcznie, bez tabeli bramki): każdy ma co najmniej jeden wiersz. */
const AKCJE_SESJI = [
  'answers', 'close', 'commands', 'diff', 'focus', 'interrupt', 'messages', 'mode', 'model', 'permission',
  'permissions', 'restart', 'resume', 'seen', 'stream', 'unseen', 'uploads',
] as const;
const WPISY_K3 = [
  '/health', '/api/version', '/api/pair', '/api/login', '/api/pairings', '/api/devices', '/api/devices/me',
  '/api/devices/forget', '/api/stream', '/api/notes', '/api/client-log', '/api/presence', '/api/projects',
  '/api/projects/recent', '/api/resumable', '/api/resumable/recent', '/api/usage', '/api/usage/details', '/api/mac',
  '/api/models', '/api/fs', '/api/voice/token', '/api/push/apns', '/api/push/apns/unregister', '/api/push/apns/status',
  '/api/push/live-activity', '/api/push/live-activity/end', '/api/sessions',
  ...AKCJE_SESJI.map((a) => `/api/sessions/:id/${a}`),
  '/api/demo/pairing', '/api/demo/control', '/api/term', '/api/term/:id', '/api/term/:id/history', '/api/fs/mkdir',
  '/api/admin/*', 'każda inna ścieżka',
] as const;

// ---------------------------------------------------------------------------
// Testy
// ---------------------------------------------------------------------------

describe('tabele przypadków (sama treść tabel)', () => {
  it('każdy wpis tabeli klas tras i każda z 17 akcji sesji ma wiersz; podakcje diff, uploads, permissions i answers też', () => {
    const pokryte = new Set([...WIERSZE_K3, ...AKCJE].map((w) => w.k3));
    expect(WPISY_K3.filter((wpis) => !pokryte.has(wpis))).toEqual([]);
    expect([...pokryte].filter((wpis) => !(WPISY_K3 as readonly string[]).includes(wpis))).toEqual([]);
    expect(AKCJE_SESJI).toHaveLength(17);
    const sciezki = AKCJE.map((w) => w.sciezka.split('?')[0] ?? '');
    for (const pod of ['/diff/files', '/diff/file', `/uploads/${ZDJECIE.file}`, '/permissions/demo-perm-willow',
      '/answers/q-z7']) {
      expect(sciezki.some((p) => p.endsWith(pod)), pod).toBe(true);
    }
  });

  it('kryterium klasy allow: żaden wiersz nie oczekuje 405 ani 5xx, poza dyktowaniem (503)', () => {
    const zle = [...WIERSZE_K3, ...AKCJE]
      .filter((w) => w.klasa === 'allow')
      .filter((w) => w.status === 405
        || (w.status >= 500 && !(`${w.method} ${w.sciezka}` === WYJATEK_5XX && w.status === 503)));
    expect(zle.map(tytul)).toEqual([]);
  });
});

describe('czarna skrzynka: wiersz na wpis tabeli klas tras (tryb recenzji, ważny klucz z kodu recenzenta)', () => {
  it.each(WIERSZE_K3.map((w) => [tytul(w), w] as const))('%s', async (_tytul, w) => {
    await przebieg('recenzja', w);
  });
});

describe('akcje sesji: tryb recenzji i zwykłe demo dają ten sam status i skutek (wyrocznia różnicowa)', () => {
  it.each(AKCJE.map((w) => [tytul(w), w] as const))('%s', async (_tytul, w) => {
    const recenzja = await przebieg('recenzja', w);
    const demo = await przebieg('demo', w);
    expect(recenzja).toBe(demo);
  });
});

describe('SSE urządzenia i odpięcie', () => {
  it('`/api/stream`: hello, potem 8 sesji; strumień sesji niesie jej transkrypt; „Zapomnij serwer” zamyka oba, '
    + 'klucz → 401', async () => {
    const s = await otworz('recenzja');
    const u = await s.sparuj();
    const globalny = s.strumien('/api/stream', { auth: u.auth });
    expect(await globalny.status).toBe(200);
    const snapshot = await globalny.czekajNa((r) => r['type'] === 'sessions-snapshot');
    expect(globalny.ramki()[0]?.['type']).toBe('hello');
    expect((snapshot['sessions'] as unknown[])).toHaveLength(8);

    const sesji = s.strumien('/api/sessions/demo-willow/stream', { auth: u.auth });
    expect(await sesji.status).toBe(200);
    const transkrypt = await sesji.czekajNa((r) => r['type'] === 'transcript-snapshot');
    expect(transkrypt['sessionId']).toBe('demo-willow');
    expect(s.hub.clientCount).toBe(2);

    const forget = await s.zadanie('POST', '/api/devices/forget', { auth: u.auth, body: {} });
    expect(forget.status).toBe(204);
    expect(await globalny.zamkniety()).toBe(true);
    expect(await sesji.zamkniety()).toBe(true);
    expect(s.hub.clientCount).toBe(0);
    expect(liniiZ(s, `devices: ${u.id} revoked (forget) — streams: 2`)).toBe(1);

    blad(await s.zadanie('GET', '/api/version', { auth: u.auth }), 401, 'device-revoked', 'rest.device-revoked');
    const ponownie = s.strumien('/api/stream', { auth: u.auth });
    expect(await ponownie.status).toBe(401);
    expect(await ponownie.zamkniety()).toBe(true);
    expect(s.hub.clientCount).toBe(0);
  });
});

describe('rejestr wycieku kodu recenzenta: czułość (sonda stanowiska, router bez zmian)', () => {
  it('kod rozcięty między fragmenty strumienia 200 i odmowy 401, w ciele JSON i w nagłówku → wpis w rejestrze',
    async () => {
      // Stanowisko poza `otworz`: tu rejestr ma być niepusty, więc wspólne `afterEach` go nie sprawdza.
      const s = await stanowisko('recenzja', { sondaWycieku: true });
      try {
        const u = await s.sparuj();
        expect((await s.zadanie('GET', '/api/version', { auth: u.auth })).status).toBe(200);
        expect(s.wyciekiKodu, 'kontrola: zwykła odpowiedź bez kodu').toEqual([]);

        const strumien = s.strumien(SONDA.strumien);
        expect(await strumien.status).toBe(200);
        const ramka = await strumien.czekajNa((r) => r['type'] === 'sonda');
        expect(s.zawieraKod(String(ramka['x']))).toBe(true);
        expect(await strumien.zamkniety()).toBe(true);
        expect(strumien.fragmenty(), 'kod rozcięty między co najmniej dwa fragmenty danych').toBeGreaterThanOrEqual(2);

        const odmowa = s.strumien(SONDA.odmowa);
        expect(await odmowa.status).toBe(401);
        expect(await odmowa.zamkniety()).toBe(true);
        expect(odmowa.fragmenty()).toBeGreaterThanOrEqual(2);

        expect((await s.zadanie('GET', SONDA.cialo)).status).toBe(200);
        expect((await s.zadanie('GET', SONDA.naglowek)).status).toBe(204);

        expect(s.wyciekiKodu).toEqual([
          `GET ${SONDA.strumien} (strumień)`,
          `GET ${SONDA.odmowa} (strumień)`,
          `GET ${SONDA.cialo}`,
          `GET ${SONDA.naglowek} (nagłówki)`,
        ]);
      } finally {
        await s.close();
      }
    });
});

describe('macierz tras trybu recenzji w wersji routera (bez reverse proxy)', () => {
  it('`POST /api/demo/pairing`: bez klucza 401, z kluczem 404; urządzenie zostaje, kodu nie ma', async () => {
    const s = await otworz('recenzja');
    const u = await s.sparuj();
    blad(await s.zadanie('POST', '/api/demo/pairing', { body: {} }), 401, 'unauthorized');
    blad(await s.zadanie('POST', '/api/demo/pairing', { body: {}, auth: u.auth }), 404, 'not-found',
      'rest.endpoint-not-found');
    expect(s.store.get(u.id)).toBeDefined();
    expect(liniiZ(s, 'demo: pairing code')).toBe(0);
  });

  it('`POST /api/demo/control`: obcy `Origin` 403, dobry bez klucza 401, z kluczem i tokenem kontroli 404', async () => {
    const s = await otworz('recenzja');
    const u = await s.sparuj();
    const m1 = { 'x-rarog-demo-token': 'demo' };
    blad(await s.zadanie('POST', '/api/demo/control', {
      body: {}, origin: `http://127.0.0.1:${String(s.port)}`, headers: m1, auth: u.auth,
    }), 403, 'bad-origin');
    blad(await s.zadanie('POST', '/api/demo/control', { body: {}, headers: m1 }), 401, 'unauthorized');
    blad(await s.zadanie('POST', '/api/demo/control', { body: {}, headers: m1, auth: u.auth }), 404, 'not-found',
      'rest.endpoint-not-found');
  });

  it('`GET /api/admin/devices` z kluczem 404; `POST /api/pairings` z kluczem 403 `demo-review`', async () => {
    const s = await otworz('recenzja');
    const u = await s.sparuj();
    blad(await s.zadanie('GET', '/api/admin/devices', { auth: u.auth }), 404, 'not-found', 'rest.endpoint-not-found');
    blad(await s.zadanie('POST', '/api/pairings', { body: {}, auth: u.auth }), 403, DEMO_REVIEW_ERROR,
      'demo.review-refused');
    expect(liniiZ(s, 'pairing code from device')).toBe(0);
  });

  it('dowolne `Cookie` bez klucza: `GET /api/stream` i `POST …/messages` → 401, bez strumienia i bez wpisu',
    async () => {
      const s = await otworz('recenzja');
      await s.sparuj();
      const cookie = { Cookie: 'rarog_session=dowolna; rarog_token=dowolny; session=1' };
      const strumien = s.strumien('/api/stream', { headers: cookie });
      expect(await strumien.status).toBe(401);
      expect(s.hub.clientCount).toBe(0);
      for (const id of ['demo-willow', 'demo-rarog-stop']) {
        const przed = s.manager.transcript(id).messages.length;
        blad(await s.zadanie('POST', `/api/sessions/${id}/messages`, {
          body: { text: 'Z ciasteczka' }, headers: cookie,
        }), 401, 'unauthorized');
        expect(s.manager.transcript(id).messages.length).toBe(przed);
      }
    });
});

/** Stan, który odmowa ma zostawić bez zmian. */
function stan(s: Stanowisko): Record<string, unknown> {
  return {
    willow: s.manager.transcript('demo-willow').messages.length,
    stop: s.manager.transcript('demo-rarog-stop').messages.length,
    notatka: s.notes.read(DEMO_NOTE_CWD),
    strumienie: s.hub.clientCount,
  };
}

describe('odmowa przed skutkiem: bez klucza i z kluczem odwołanym → 401, stan bez zmian', () => {
  it.each(['bez klucza', 'klucz odwołany'] as const)('%s', async (wariant) => {
    const s = await otworz('recenzja');
    const swiadek = await s.sparuj('iPad·Rarog');
    let auth: string | undefined;
    let error = 'unauthorized';
    if (wariant === 'klucz odwołany') {
      const odwolany = await s.sparuj();
      expect((await s.zadanie('POST', '/api/devices/forget', { auth: odwolany.auth, body: {} })).status).toBe(204);
      auth = odwolany.auth;
      error = 'device-revoked';
    }
    const przed = stan(s);
    const opcje = auth === undefined ? {} : { auth };
    for (const id of ['demo-willow', 'demo-rarog-stop']) {
      const res = await s.zadanie('POST', `/api/sessions/${id}/messages`, { ...opcje, body: { text: 'Odmowa Z7' } });
      blad(res, 401, error);
      expect(wpisyUzytkownika(s, id, 'Odmowa Z7')).toBe(0);
    }
    for (const sciezka of ['/api/sessions/demo-willow/uploads/x.png', `/api/sessions/demo-pipe-link/uploads/${
      ZDJECIE.file}`]) {
      const res = await s.zadanie('GET', sciezka, opcje);
      blad(res, 401, error);
      expect(res.headers['content-type']).not.toBe('image/png');
    }
    blad(await s.zadanie('PUT', '/api/notes', {
      ...opcje, body: { cwd: DEMO_NOTE_CWD, text: 'Odmowa Z7', updatedAt: DEMO_NOTE_UPDATED_AT },
    }), 401, error);
    const strumien = s.strumien('/api/sessions/demo-willow/stream', opcje);
    expect(await strumien.status).toBe(401);
    expect(await strumien.zamkniety()).toBe(true);
    expect(stan(s)).toEqual(przed);

    // Kontrola dodatnia: te same pomiary widzą skutek żądania z ważnym kluczem.
    expect((await s.zadanie('POST', '/api/sessions/demo-rarog-stop/messages', {
      auth: swiadek.auth, body: { text: 'Świadek Z7' },
    })).status).toBe(202);
    expect(wpisyUzytkownika(s, 'demo-rarog-stop', 'Świadek Z7')).toBe(1);
    expect((await s.zadanie('PUT', '/api/notes', {
      auth: swiadek.auth, body: { cwd: DEMO_NOTE_CWD, text: 'Świadek Z7', updatedAt: DEMO_NOTE_UPDATED_AT },
    })).status).toBe(200);
    expect(s.notes.read(DEMO_NOTE_CWD).text).toBe('Świadek Z7');
    const zywy = s.strumien('/api/sessions/demo-willow/stream', { auth: swiadek.auth });
    expect(await zywy.status).toBe(200);
    await zywy.czekajNa((r) => r['type'] === 'transcript-snapshot');
    expect(s.hub.clientCount).toBe(1);
    zywy.zamknij();
  });
});

describe('dwa urządzenia z kodu recenzenta: stan wspólny', () => {
  it('oba strumienie sesji niosą wpisy obu urządzeń wysłane równocześnie (obie wysyłki 202)', async () => {
    const s = await otworz('recenzja');
    const a = await s.sparuj('iPhone·Rarog');
    const b = await s.sparuj('iPad·Rarog');
    const sciezka = '/api/sessions/demo-rarog-stop/stream';
    const strumienA = s.strumien(sciezka, { auth: a.auth });
    const strumienB = s.strumien(sciezka, { auth: b.auth });
    await strumienA.czekajNa((r) => r['type'] === 'transcript-snapshot');
    await strumienB.czekajNa((r) => r['type'] === 'transcript-snapshot');
    const [odA, odB] = await Promise.all([
      s.zadanie('POST', '/api/sessions/demo-rarog-stop/messages', { auth: a.auth, body: { text: 'Tekst urządzenia A' } }),
      s.zadanie('POST', '/api/sessions/demo-rarog-stop/messages', { auth: b.auth, body: { text: 'Tekst urządzenia B' } }),
    ]);
    expect([odA.status, odB.status]).toEqual([202, 202]);
    for (const strumien of [strumienA, strumienB]) {
      for (const tekst of ['Tekst urządzenia A', 'Tekst urządzenia B']) {
        await strumien.czekajNa((r) => r['type'] === 'message' && JSON.stringify(r['message']).includes(tekst));
        expect(wpisyWStrumieniu(strumien, tekst), tekst).toBe(1);
      }
    }
    // Recenzenci widzą nawzajem swoje urządzenia: lista ma oba rekordy.
    const lista = await s.zadanie('GET', '/api/devices', { auth: a.auth });
    expect((lista.json?.['devices'] as { id: string }[]).map((d) => d.id).sort()).toEqual([a.id, b.id].sort());
  });
});

// ---------------------------------------------------------------------------
// Macierz normalizacji ścieżek
// ---------------------------------------------------------------------------

/**
 * Wariant ścieżki i jego postać kanoniczna: ta trasa routera, którą obsłużyłby wariant. Parser URL serwera (WHATWG)
 * usuwa `.` i `..` (także `%2e`), czyta `\` jak `/`, zdejmuje zapytanie i fragment, z formy absolutnej bierze samą
 * ścieżkę, a `//host/…` czyta jako adres innego hosta; potem odpadają końcowe ukośniki. Trasy z literałem
 * (`pathname === …`) porównują całą ścieżkę, więc pusty segment w środku daje inną ścieżkę; trasy segmentowe
 * (`/api/sessions/:id/…`) liczą segmenty bez pustych, a `:id` sesji router dekoduje. Kodowania procentowego liter
 * i ukośnika parser nie zdejmuje. `kanon: null` = ścieżka spoza tabeli klas tras (klasa `absent`).
 */
interface Wariant {
  readonly sciezka: string;
  readonly kanon: string | null;
  readonly status: number;
}

interface Macierz {
  readonly opis: string;
  readonly klasa: Klasa;
  readonly method: string;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly warianty: readonly Wariant[];
  /** Odpowiedź obsługi trasy kanonicznej (tylko klasa `allow`, status 2xx). */
  readonly obsluga?: (res: Odpowiedz, u: Urzadzenie) => void;
  /** Brak skutku po wariancie (stan i linie logu obsługi). */
  readonly bezSkutku: (s: Stanowisko, u: Urzadzenie) => void;
}

/** Status postaci kanonicznej według tabeli klas tras (z ważnym kluczem). */
const STATUS_KANONU: Readonly<Record<string, number>> = {
  '/api/pairings': 403,
  '/api/demo/pairing': 404,
  '/api/term': 404,
  '/api/devices/me': 200,
  '/api/sessions/demo-willow/commands': 200,
};

const w = (sciezka: string, kanon: string | null, status: number): Wariant => ({ sciezka, kanon, status });

const MACIERZE: readonly Macierz[] = [
  {
    opis: '`POST /api/pairings` (refuse)', klasa: 'refuse', method: 'POST', body: {},
    bezSkutku: (s) => { expect(liniiZ(s, 'pairing code from device')).toBe(0); },
    warianty: [
      w('/api/pairings', '/api/pairings', 403),
      w('/api/pairings/', '/api/pairings', 403),
      w('/api/pairings//', '/api/pairings', 403),
      w('/api/pairings?x=1', '/api/pairings', 403),
      w('/api/pairings/?x=1', '/api/pairings', 403),
      w('/api/pairings#x', '/api/pairings', 403),
      w('/API/pairings', null, 404),
      w('/api/Pairings', null, 404),
      w('/api/PAIRINGS', null, 404),
      w('/api%2Fpairings', null, 404),
      w('/api%2fpairings', null, 404),
      w('/api/pairing%73', null, 404),
      w('/api/%70airings', null, 404),
      w('/%61pi/pairings', null, 404),
      w('/api%252Fpairings', null, 404),
      w('/api/pairings%2F', null, 404),
      w('/api/pairings;x=1', null, 404),
      w('//api/pairings', null, 404),
      w('///api/pairings', null, 404),
      w('/api//pairings', null, 404),
      w('/api/./pairings', '/api/pairings', 403),
      w('/./api/pairings', '/api/pairings', 403),
      w('/api/x/../pairings', '/api/pairings', 403),
      w('/../api/pairings', '/api/pairings', 403),
      w('/api/%2e/pairings', '/api/pairings', 403),
      w('/api/%2E%2E/api/pairings', '/api/pairings', 403),
      w('/api/x/.%2e/pairings', '/api/pairings', 403),
      w('/api/pairings/.', '/api/pairings', 403),
      w('/api/pairings/..', null, 404),
      w('/api\\pairings', '/api/pairings', 403),
      w('http://obcy.example/api/pairings', '/api/pairings', 403),
    ],
  },
  {
    opis: '`POST /api/demo/pairing` (absent, obsługa w routerze odpina wszystkich)', klasa: 'absent', method: 'POST',
    body: {},
    bezSkutku: (s, u) => {
      expect(s.store.get(u.id)).toBeDefined();
      expect(liniiZ(s, 'demo: pairing code')).toBe(0);
    },
    warianty: [
      w('/api/demo/pairing', '/api/demo/pairing', 404),
      w('/api/demo/pairing/', '/api/demo/pairing', 404),
      w('/api/demo/pairing?x=1', '/api/demo/pairing', 404),
      w('/API/demo/pairing', null, 404),
      w('/api/Demo/pairing', null, 404),
      w('/api/demo/Pairing', null, 404),
      w('/api/demo%2Fpairing', null, 404),
      w('/api/demo/pairin%67', null, 404),
      w('//api/demo/pairing', null, 404),
      w('/api//demo/pairing', null, 404),
      w('/api/./demo/pairing', '/api/demo/pairing', 404),
      w('/api/demo/x/../pairing', '/api/demo/pairing', 404),
      w('/api/x/%2e%2e/demo/pairing', '/api/demo/pairing', 404),
      w('/api\\demo\\pairing', '/api/demo/pairing', 404),
      w('http://obcy.example/api/demo/pairing', '/api/demo/pairing', 404),
    ],
  },
  {
    opis: '`GET /api/term` (absent, obsługa w routerze)', klasa: 'absent', method: 'GET',
    bezSkutku: (s, u) => { expect(s.store.get(u.id)).toBeDefined(); },
    warianty: [
      w('/api/term', '/api/term', 404),
      w('/api/term/', '/api/term', 404),
      w('/api/term?x=1', '/api/term', 404),
      w('/API/term', null, 404),
      w('/api/Term', null, 404),
      w('/api%2Fterm', null, 404),
      w('/api/ter%6D', null, 404),
      w('//api/term', null, 404),
      w('/api//term', null, 404),
      w('/api/./term', '/api/term', 404),
      w('/api/x/../term', '/api/term', 404),
      w('/api\\term', '/api/term', 404),
    ],
  },
  {
    opis: '`GET /api/devices/me` (allow, literał; kontrola)', klasa: 'allow', method: 'GET',
    obsluga: (res, u) => { expect((res.json?.['device'] as { id: string }).id).toBe(u.id); },
    bezSkutku: (s, u) => { expect(s.store.get(u.id)).toBeDefined(); },
    warianty: [
      w('/api/devices/me', '/api/devices/me', 200),
      w('/api/devices/me/', '/api/devices/me', 200),
      w('/api/devices/me?x=1', '/api/devices/me', 200),
      w('/API/devices/me', null, 404),
      w('/api/Devices/me', null, 404),
      w('/api/devices/ME', null, 404),
      w('/api/devices%2Fme', null, 404),
      w('/api/devices/m%65', null, 404),
      w('//api/devices/me', null, 404),
      w('/api//devices/me', null, 404),
      w('/api/devices//me', null, 404),
      w('/api/./devices/me', '/api/devices/me', 200),
      w('/api/x/../devices/me', '/api/devices/me', 200),
      w('/api/devices/%2e/me', '/api/devices/me', 200),
      w('/api\\devices\\me', '/api/devices/me', 200),
      w('http://obcy.example/api/devices/me', '/api/devices/me', 200),
    ],
  },
  {
    opis: '`GET /api/sessions/demo-willow/commands` (allow, trasa segmentowa; kontrola)', klasa: 'allow',
    method: 'GET',
    obsluga: (res) => { expect(res.json?.['revision']).toBeTypeOf('string'); },
    bezSkutku: (s, u) => { expect(s.store.get(u.id)).toBeDefined(); },
    warianty: [
      w('/api/sessions/demo-willow/commands', '/api/sessions/demo-willow/commands', 200),
      w('/api/sessions/demo-willow/commands/', '/api/sessions/demo-willow/commands', 200),
      w('/api/sessions/demo-willow/commands?x=1', '/api/sessions/demo-willow/commands', 200),
      w('/api//sessions/demo-willow/commands', '/api/sessions/demo-willow/commands', 200),
      w('/api/sessions//demo-willow/commands', '/api/sessions/demo-willow/commands', 200),
      w('/api/sessions/demo-willow//commands', '/api/sessions/demo-willow/commands', 200),
      w('/api/sessions/demo%2Dwillow/commands', '/api/sessions/demo-willow/commands', 200),
      w('/api/sessions/demo-willow/./commands', '/api/sessions/demo-willow/commands', 200),
      w('/api/sessions/x/../demo-willow/commands', '/api/sessions/demo-willow/commands', 200),
      w('/api\\sessions\\demo-willow\\commands', '/api/sessions/demo-willow/commands', 200),
      w('/API/sessions/demo-willow/commands', null, 404),
      w('/api/Sessions/demo-willow/commands', null, 404),
      w('/api/sessions/demo-willow/Commands', null, 404),
      w('/api/sessions/demo-willow%2Fcommands', null, 404),
      w('/api/sessions/demo-willow/command%73', null, 404),
      w('//api/sessions/demo-willow/commands', null, 404),
    ],
  },
];

describe('macierz normalizacji ścieżek: dokładny status, brak skutku, obsługa tylko klasy postaci kanonicznej', () => {
  it('tabela: status każdego wariantu = status jego postaci kanonicznej według tabeli klas tras (spoza tabeli: 404)', () => {
    const zle = MACIERZE.flatMap((m) => m.warianty
      .filter((v) => v.status !== (v.kanon === null ? 404 : STATUS_KANONU[v.kanon]))
      .map((v) => `${m.opis}: ${v.sciezka}`));
    expect(zle).toEqual([]);
  });

  it.each(MACIERZE.map((m) => [m.opis, m] as const))('%s', async (_opis, m) => {
    const s = await otworz('recenzja');
    const u = await s.sparuj();
    const zle: string[] = [];
    for (const v of m.warianty) {
      const res = await s.zadanie(m.method, v.sciezka, {
        auth: u.auth, ...(m.body === undefined ? {} : { body: m.body }),
        ...(m.headers === undefined ? {} : { headers: m.headers }),
      });
      const ref = (res.json?.['messageRef'] as { code?: string } | undefined)?.code;
      const otrzymane = `${String(res.status)} ${String(res.json?.['error'] ?? '')} ${String(ref ?? '')}`.trim();
      // Kto odpowiedział: 403 tylko bramka `refuse`, 404 tylko bramka albo końcowe 404 routera (nigdy obsługa trasy
      // `absent`, np. `term.disabled`), 2xx tylko obsługa trasy kanonicznej.
      let zgodne = res.status === v.status;
      if (res.status === 403) zgodne &&= res.json?.['error'] === DEMO_REVIEW_ERROR && ref === 'demo.review-refused';
      if (res.status === 404) zgodne &&= res.json?.['error'] === 'not-found' && ref === 'rest.endpoint-not-found';
      if (zgodne && res.status === 200) m.obsluga?.(res, u);
      if (!zgodne) zle.push(`${v.sciezka}: oczekiwane ${String(v.status)}, otrzymane ${otrzymane}`);
      m.bezSkutku(s, u);
    }
    expect(zle).toEqual([]);
  });
});
