/**
 * Rzeczywisty proces trybu recenzji demo: JEDYNY test procesu i dowód
 * izolacji hosta. Inwentarz tras i strażnik powierzchni (`demo-review-routes.test.ts`) są pomocnicze, czarna skrzynka
 * tras (`demo-review-guard.test.ts`) sprawdza router bez złożenia z `index.ts`; dopiero tu widać, co składa proces.
 *
 * Stanowisko: proces potomny `node --import tsx --import <szpieg> server/src/index.ts` (`main()` startuje przy
 * imporcie) na wolnym porcie loopbacku. Szpieg (`helpers/szpieg-hosta.mjs`) zapisuje do dziennika każde wywołanie
 * `node:child_process` (i niczego nie uruchamia) oraz każdy odczyt `node:fs`/`node:fs/promises` pod `HOME` procesu.
 * `HOME` to katalog tymczasowy ze znacznikami, które serwer czytałby poza trybem recenzji: `.claude/settings.json`
 * z blokiem hooka Raroga, `model` i `effortLevel` (inne niż stałe trybu recenzji), `.claude.json` i
 * `.claude/statusline/x.json`. Katalog danych i dziennik leżą obok `HOME`, nie w nim.
 *
 * Seria (poprawne żądania do tras dozwolonych): parowanie (tryb recenzji: kod recenzenta; zwykłe demo: kod
 * z `POST /api/demo/pairing`), `GET /api/version`, `GET /health`, 1 s `GET /api/stream`, `GET /api/projects`,
 * `POST /api/sessions {cwd}` bez modelu i effortu, dwie wiadomości do sesji `demo-willow-parser` (zwykłe zdanie
 * do ramki `git-status` i wyzwalacz EN `question`), `GET /api/usage`, `GET /api/usage/details`,
 * `GET /api/resumable?cwd=` i `GET /api/notes?cwd=` każdego projektu, `GET …/diff`, `POST /api/voice/token`,
 * `POST /api/demo/control` z kluczem i `x-rarog-demo-token`, `POST /api/fs/mkdir`, upgrade `/api/term/x`.
 *
 * Wynik trybu recenzji oceniają {@link naruszeniaK6}: dziennik szpiega pusty poza {@link WYJATKI_SZPIEGA} (lista
 * z powodem), `tailnet: null`, `voiceEnabled: false` i 503 z tokenu, `hook` = `HOOK_HEALTH_UNKNOWN`, nazwa serwera
 * oraz model i effort nowej sesji ze stałych trybu recenzji, `POST /api/demo/control` i `POST /api/fs/mkdir` → 404,
 * upgrade → EOF bez
 * odpowiedzi HTTP. Treść z procesu przechodzi
 * sprawdzarkę EN (`helpers/demo-en.ts`). Kontrola ujemna: zwykłe demo (bez kodu, originy domyślne) z tą samą serią
 * daje naruszenia z nazwą odczytu, więc szpieg naprawdę łapie wyciek; wywołanie procesu łapie samosprawdzenie
 * szpiega.
 *
 * Host data in every demo mode: the plain demo runs no `tailscale`, answers `GET /api/version` with the fixed tailnet
 * of the content set and pairing with the fixed demo server name; the review mode answers `tailnet: null` (above).
 *
 * `client.log` (wariant a): tryb recenzji kasuje `client.log` i `client.log.1` przy starcie (linia logu
 * tylko, gdy coś skasował), błąd kasowania inny niż `ENOENT` przewraca start (kod ≠ 0, linia z nazwą pliku i kodem
 * błędu, bez treści; tu: `client.log` jako katalog, `unlink` daje `EPERM` na macOS i `EISDIR` na Linuksie). Zwykłe
 * demo zostawia oba pliki.
 *
 * PR status (`docs/pull-requests.md`): the demo and its review mode answer from a fixed map and never start `gh`.
 * Review mode cannot create a session with PRs (the demo control route is 404, no seed lists PRs), so the empty spy
 * log of the review series covers it; the plain demo builds the `pull-requests` scenario through the demo control
 * route, waits for the merged state and for the time of a scheduled read, and its spy log has no `gh` entry.
 *
 * Testy procesu wołają `listen()`: poza sandboksem.
 */
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { deviceAuthorization } from '../src/auth/index.ts';
import { demoContentEn } from '../src/demo/content/en.ts';
import { DEMO_SERVER_NAME } from '../src/demo/mac.ts';
import { HOOK_HEALTH_UNKNOWN } from '../src/health.ts';
import { hookBlock, hookCommand } from '../src/herdr/hook-config.ts';
import { DEMO_PULL_REQUESTS } from '../src/demo/seeds.ts';
import { NEW_URL_DELAY_MS } from '../src/pr-status/index.ts';
import { DEMO_STRUCTURE_KEYS, nonEnglishTexts } from './helpers/demo-en.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SZPIEG = fileURLToPath(new URL('./helpers/szpieg-hosta.mjs', import.meta.url));
const ORIGIN_RECENZJI = 'https://demo.recenzja.example';
/** Znaczniki w `HOME`: wartości, których stałe trybu recenzji nie mają, więc odczyt pliku konta widać w odpowiedzi. */
const ZNACZNIK_MODEL = 'claude-znacznik-home-1';
const ZNACZNIK_EFFORT = 'low';
const TRESC_LOGU = 'zdarzenie apki recenzenta z poprzedniego startu';
/**
 * Klucze pomijane przez sprawdzarkę EN na odpowiedziach procesu, ponad klucze zestawu treści: pola struktury
 * protokołu, których klient nie pokazuje. `paneId` to identyfikator panelu atrapy herdr złożony z identyfikatora sesji
 * (`w0:demo-rarog`, ten sam w każdym języku), `launchedByRarog` to nazwa pola protokołu (`shared/src/protocol.ts`).
 */
const KLUCZE_STRUKTURY = new Set([...DEMO_STRUCTURE_KEYS, 'paneId', 'launchedByRarog']);

/**
 * Wpisy dziennika szpiega dozwolone w trybie recenzji, z powodem. Pusta lista: proces trybu recenzji nie czyta
 * niczego pod `HOME` i nie uruchamia żadnego procesu.
 */
const WYJATKI_SZPIEGA: ReadonlyArray<{ readonly wpis: RegExp; readonly powod: string }> = [];

interface WpisSzpiega {
  readonly rodzaj: 'proces' | 'odczyt';
  readonly fn: string;
  readonly plik?: string;
  readonly argumenty?: readonly string[];
  readonly sciezka?: string;
}

interface Stanowisko {
  readonly baza: string;
  readonly home: string;
  readonly dane: string;
  readonly dziennik: string;
}

const sprzatanie: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const krok of sprzatanie.splice(0).reverse()) await krok();
});

/** Katalog tymczasowy testu: `HOME` ze znacznikami, katalog danych i dziennik szpiega obok. */
function stanowisko(): Stanowisko {
  const baza = mkdtempSync(path.join(tmpdir(), 'a5z5.'));
  sprzatanie.push(() => { rmSync(baza, { recursive: true, force: true }); return Promise.resolve(); });
  const home = path.join(baza, 'home');
  mkdirSync(path.join(home, '.claude', 'statusline'), { recursive: true });
  writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({
    ...(hookBlock(hookCommand(home)) as Record<string, unknown>), model: ZNACZNIK_MODEL, effortLevel: ZNACZNIK_EFFORT,
  }));
  writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'znacznik@home.example' } }));
  writeFileSync(path.join(home, '.claude', 'statusline', 'x.json'), JSON.stringify({ znacznik: 'statusline' }));
  const dane = path.join(baza, 'dane');
  mkdirSync(dane, { mode: 0o700 });
  return { baza, home, dane, dziennik: path.join(baza, 'szpieg.jsonl') };
}

async function wolnyPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
  return port;
}

interface Proces {
  readonly child: ChildProcess;
  readonly port: number;
  wyjscie(): string;
  readonly koniec: Promise<{ kod: number | null; sygnal: NodeJS.Signals | null }>;
}

/** Proces serwera z szpiegiem; `env` dokłada zmienne trybu do minimalnego środowiska. */
function uruchom(st: Stanowisko, port: number, env: Record<string, string>): Proces {
  const child = spawn(process.execPath, ['--import', 'tsx', '--import', SZPIEG, 'server/src/index.ts'], {
    cwd: REPO,
    env: {
      PATH: process.env['PATH'] ?? '', HOME: st.home, TMPDIR: tmpdir(), RAROG_DEMO: '1', RAROG_PORT: String(port),
      RAROG_DATA_DIR: st.dane, SZPIEG_HOSTA_DZIENNIK: st.dziennik, ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let tekst = '';
  const dopisz = (chunk: Buffer): void => { tekst += chunk.toString('utf8'); };
  child.stdout?.on('data', dopisz);
  child.stderr?.on('data', dopisz);
  const bezpiecznik = setTimeout(() => { child.kill('SIGKILL'); }, 90_000);
  const koniec = new Promise<{ kod: number | null; sygnal: NodeJS.Signals | null }>((resolve) => {
    child.on('exit', (kod, sygnal) => { clearTimeout(bezpiecznik); resolve({ kod, sygnal }); });
  });
  sprzatanie.push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await koniec;
    }
  });
  return { child, port, wyjscie: () => tekst, koniec };
}

interface Odpowiedz {
  readonly status: number;
  readonly tekst: string;
  readonly json: Record<string, unknown> | null;
}

function zadanie(
  port: number, metoda: string, sciezka: string, naglowki: Record<string, string>, cialo?: unknown,
): Promise<Odpowiedz> {
  return new Promise((resolve, reject) => {
    const payload = cialo === undefined ? undefined : JSON.stringify(cialo);
    const req = http.request({
      host: '127.0.0.1', port, method: metoda, path: sciezka, agent: false,
      headers: { ...naglowki, ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => { chunks.push(chunk); });
      res.on('end', () => {
        const tekst = Buffer.concat(chunks).toString('utf8');
        let json: Record<string, unknown> | null = null;
        try { json = tekst === '' ? null : JSON.parse(tekst) as Record<string, unknown>; } catch { json = null; }
        resolve({ status: res.statusCode ?? 0, tekst, json });
      });
    });
    req.setTimeout(10_000, () => { req.destroy(new Error(`limit czasu: ${metoda} ${sciezka}`)); });
    req.on('error', reject);
    req.end(payload);
  });
}

async function czekajNaStart(p: Proces): Promise<void> {
  const termin = Date.now() + 45_000;
  for (;;) {
    if (p.child.exitCode !== null || p.child.signalCode !== null) {
      throw new Error(`serwer padł przy starcie:\n${p.wyjscie()}`);
    }
    try {
      if ((await zadanie(p.port, 'GET', '/health', {})).status === 200) return;
    } catch { /* jeszcze nie słucha */ }
    if (Date.now() > termin) throw new Error(`serwer nie wstał w 45 s:\n${p.wyjscie()}`);
    await new Promise((resolve) => { setTimeout(resolve, 150); });
  }
}

async function zatrzymaj(p: Proces): Promise<void> {
  if (p.child.exitCode !== null || p.child.signalCode !== null) return;
  p.child.kill('SIGTERM');
  const zabij = setTimeout(() => { p.child.kill('SIGKILL'); }, 10_000);
  await p.koniec;
  clearTimeout(zabij);
}

/** Strumień SSE słuchany w tle: ramki z pola `data:`. */
function sluchaj(port: number, sciezka: string, naglowki: Record<string, string>): {
  ramki(): Array<Record<string, unknown>>;
  /** Pierwsza ramka od indeksu `od` (domyślnie 0) spełniająca warunek albo `null` po `ms`. */
  czekaj(
    warunek: (ramka: Record<string, unknown>) => boolean, ms: number, od?: number,
  ): Promise<Record<string, unknown> | null>;
  zamknij(): void;
  status(): number;
} {
  const zebrane: Array<Record<string, unknown>> = [];
  let bufor = '';
  let kod = 0;
  const req = http.get({ host: '127.0.0.1', port, path: sciezka, headers: naglowki, agent: false }, (res) => {
    kod = res.statusCode ?? 0;
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      bufor += chunk;
      const czesci = bufor.split('\n\n');
      bufor = czesci.pop() ?? '';
      for (const ramka of czesci) {
        const data = /^data: (.*)$/m.exec(ramka)?.[1];
        if (data !== undefined) zebrane.push(JSON.parse(data) as Record<string, unknown>);
      }
    });
  });
  req.on('error', () => { /* rozłączenie w `zamknij()` jest celowe */ });
  return {
    ramki: () => zebrane,
    status: () => kod,
    async czekaj(warunek, ms, od = 0) {
      const termin = Date.now() + ms;
      for (;;) {
        const znaleziona = zebrane.slice(od).find(warunek);
        if (znaleziona !== undefined) return znaleziona;
        if (Date.now() > termin) return null;
        await new Promise((resolve) => { setTimeout(resolve, 50); });
      }
    },
    zamknij: () => { req.destroy(); },
  };
}

/** Surowy upgrade WebSocket: bajty odpowiedzi do zamknięcia gniazda albo limitu 5 s. */
function upgrade(port: number, sciezka: string, naglowki: Record<string, string>): Promise<{
  bajty: number; koniec: 'eof' | 'limit czasu';
}> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    let bajty = 0;
    const limit = setTimeout(() => { socket.destroy(); resolve({ bajty, koniec: 'limit czasu' }); }, 5_000);
    socket.on('connect', () => {
      const linie = [
        `GET ${sciezka} HTTP/1.1`, `Host: 127.0.0.1:${String(port)}`, 'Connection: Upgrade', 'Upgrade: websocket',
        'Sec-WebSocket-Version: 13', `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
        ...Object.entries(naglowki).map(([k, v]) => `${k}: ${v}`), '', '',
      ];
      socket.write(linie.join('\r\n'));
    });
    socket.on('data', (chunk: Buffer) => { bajty += chunk.byteLength; });
    socket.on('error', () => { /* zerwanie gniazda to też koniec */ });
    socket.on('close', () => { clearTimeout(limit); resolve({ bajty, koniec: 'eof' }); });
  });
}

interface Wynik {
  readonly home: string;
  readonly dziennik: readonly WpisSzpiega[];
  readonly statusy: Readonly<Record<string, number>>;
  readonly serverName: unknown;
  readonly tailnet: unknown;
  readonly voiceEnabled: unknown;
  readonly hook: unknown;
  readonly nowaSesja: { readonly model?: unknown; readonly effort?: unknown } | null;
  readonly upgrade: { readonly bajty: number; readonly koniec: string };
  /** Treść widoczna dla klienta, do sprawdzarki EN. */
  readonly tresc: Readonly<Record<string, unknown>>;
  readonly gitStatus: Record<string, unknown> | null;
  readonly pytanie: Record<string, unknown> | null;
  readonly snapshotSesji: number;
}

/** Seria żądań do tras dozwolonych; parowanie według trybu. */
async function seria(p: Proces, st: Stanowisko, tryb: 'recenzja' | 'demo', kod: string): Promise<Wynik> {
  const origin = tryb === 'recenzja' ? ORIGIN_RECENZJI : `http://127.0.0.1:${String(p.port)}`;
  const statusy: Record<string, number> = {};
  const bezKlucza = { Origin: origin };
  let kodParowania = kod;
  if (tryb === 'demo') {
    const wydany = await zadanie(p.port, 'POST', '/api/demo/pairing', bezKlucza, {});
    kodParowania = String(wydany.json?.['code'] ?? '');
  }
  const para = await zadanie(p.port, 'POST', '/api/pair', bezKlucza, { v: 1, code: kodParowania, label: 'iPhone·Test' });
  statusy['POST /api/pair'] = para.status;
  const naglowki = {
    Origin: origin, Authorization: deviceAuthorization(String(para.json?.['deviceId']), String(para.json?.['secret'])),
  };
  const server = para.json?.['server'] as Record<string, unknown> | undefined;

  const version = await zadanie(p.port, 'GET', '/api/version', naglowki);
  statusy['GET /api/version'] = version.status;
  const health = await zadanie(p.port, 'GET', '/health', {});
  statusy['GET /health'] = health.status;

  const globalny = sluchaj(p.port, '/api/stream', naglowki);
  await new Promise((resolve) => { setTimeout(resolve, 1_000); });
  globalny.zamknij();
  statusy['GET /api/stream'] = globalny.status();
  const snapshot = globalny.ramki().find((r) => r['type'] === 'sessions-snapshot') ?? null;

  const projekty = await zadanie(p.port, 'GET', '/api/projects', naglowki);
  statusy['GET /api/projects'] = projekty.status;
  const sciezki = ((projekty.json?.['projects'] ?? []) as Array<{ path: string }>).map((one) => one.path);

  // Pierwsza karta nowej sesji (`session-changed` zaraz po założeniu, przed `init` atrapy silnika, który podaje
  // model atrapy): model i effort z niej to wartości „domyślne konta”, czyli stałe trybu recenzji albo znaczniki z
  // `HOME`.
  const globalnyNowej = sluchaj(p.port, '/api/stream', naglowki);
  await globalnyNowej.czekaj((r) => r['type'] === 'sessions-snapshot', 5_000);
  const nowa = await zadanie(p.port, 'POST', '/api/sessions', naglowki, { cwd: sciezki[0] ?? '' });
  statusy['POST /api/sessions'] = nowa.status;
  const idNowej = String(nowa.json?.['sessionId'] ?? '');
  const kartaNowej = await globalnyNowej.czekaj((r) => r['type'] === 'session-changed'
    && (r['session'] as { id?: unknown } | undefined)?.id === idNowej, 5_000);
  globalnyNowej.zamknij();
  const nowaSesja = (kartaNowej?.['session'] ?? null) as Record<string, unknown> | null;

  const seed = sluchaj(p.port, '/api/sessions/demo-willow/stream', naglowki);
  const transkryptSeeda = await seed.czekaj((r) => r['type'] === 'transcript-snapshot', 5_000);
  seed.zamknij();

  // Tury atrapy na nowej sesji (panel demo wstaje gotowy do wysyłki): zwykłe zdanie do ramki `git-status`, potem
  // wyzwalacz EN `question`.
  const sciezkaNowej = `/api/sessions/${encodeURIComponent(idNowej)}`;
  const sesja = sluchaj(p.port, `${sciezkaNowej}/stream`, naglowki);
  await sesja.czekaj((r) => r['type'] === 'transcript-snapshot', 5_000);
  const przedZdaniem = sesja.ramki().length;
  const zdanie = await zadanie(p.port, 'POST', `${sciezkaNowej}/messages`, naglowki, {
    text: 'Please check the save path once more.', clientMessageId: randomUUID(),
  });
  statusy['POST …/messages (zdanie)'] = zdanie.status;
  const gitStatus = await sesja.czekaj((r) => r['type'] === 'git-status', 8_000, przedZdaniem);
  const przedPytaniem = sesja.ramki().length;
  const pytanieWyslane = await zadanie(p.port, 'POST', `${sciezkaNowej}/messages`, naglowki, {
    text: demoContentEn.driver.triggers.question[0], clientMessageId: randomUUID(),
  });
  statusy['POST …/messages (question)'] = pytanieWyslane.status;
  const pytanie = await sesja.czekaj((r) => JSON.stringify(r).includes('"questions"'), 8_000, przedPytaniem);
  sesja.zamknij();
  const transkrypt = sesja.ramki();

  const usage = await zadanie(p.port, 'GET', '/api/usage', naglowki);
  statusy['GET /api/usage'] = usage.status;
  const usageDetails = await zadanie(p.port, 'GET', '/api/usage/details', naglowki);
  statusy['GET /api/usage/details'] = usageDetails.status;
  const wznow: Record<string, unknown> = {};
  const notatki: Record<string, unknown> = {};
  for (const cwd of sciezki) {
    const q = encodeURIComponent(cwd);
    const r = await zadanie(p.port, 'GET', `/api/resumable?cwd=${q}`, naglowki);
    statusy[`GET /api/resumable?cwd=${cwd}`] = r.status;
    wznow[cwd] = r.json;
    statusy[`GET /api/resumable/recent?cwd=${cwd}`] = (await zadanie(p.port, 'GET', `/api/resumable/recent?cwd=${q}`,
      naglowki)).status;
    const n = await zadanie(p.port, 'GET', `/api/notes?cwd=${q}`, naglowki);
    statusy[`GET /api/notes?cwd=${cwd}`] = n.status;
    notatki[cwd] = n.json;
  }
  const diff = await zadanie(p.port, 'GET', '/api/sessions/demo-willow/diff', naglowki);
  statusy['GET …/diff'] = diff.status;
  // Pozostałe odczyty klasy `allow`, które w zwykłym serwerze sięgają do hosta (statystyki Maca, przeglądarka
  // katalogów, ostatnie projekty i sesje z plików CLI): w demo i trybie recenzji bez dotknięcia `HOME`.
  for (const trasa of ['/api/mac', '/api/models', '/api/fs', '/api/devices', '/api/projects/recent']) {
    statusy[`GET ${trasa}`] = (await zadanie(p.port, 'GET', trasa, naglowki)).status;
  }
  const glos = await zadanie(p.port, 'POST', '/api/voice/token', naglowki, {});
  statusy['POST /api/voice/token'] = glos.status;
  const control = await zadanie(p.port, 'POST', '/api/demo/control', { ...naglowki, 'x-rarog-demo-token': 'demo' }, {});
  statusy['POST /api/demo/control'] = control.status;
  // Creating a directory: review mode has no such route, the plain demo refuses before the disk and the child.
  const mkdir = await zadanie(p.port, 'POST', '/api/fs/mkdir', naglowki, { parent: sciezki[0] ?? '', name: 'nowy' });
  statusy['POST /api/fs/mkdir'] = mkdir.status;
  const ws = await upgrade(p.port, '/api/term/x', naglowki);

  await zatrzymaj(p);
  const dziennik = existsSync(st.dziennik)
    ? readFileSync(st.dziennik, 'utf8').split('\n').filter((linia) => linia !== '').map((linia) => JSON.parse(linia) as
      WpisSzpiega)
    : [];
  return {
    home: st.home,
    dziennik,
    statusy,
    serverName: server?.['name'],
    tailnet: version.json?.['tailnet'],
    voiceEnabled: version.json?.['voiceEnabled'],
    hook: health.json?.['hook'],
    nowaSesja: nowaSesja === null ? null : { model: nowaSesja['model'], effort: nowaSesja['effort'] },
    upgrade: ws,
    tresc: {
      snapshot, transkryptSeeda, transkrypt, notatki, projekty: projekty.json, wznow, diff: diff.json, usage: usage.json,
      usageDetails: usageDetails.json,
    },
    gitStatus,
    pytanie,
    snapshotSesji: ((snapshot?.['sessions'] ?? []) as unknown[]).length,
  };
}

/** Statusy serii według tabeli klas tras (wzorce tras dozwolonych). */
const STATUSY_K3: ReadonlyArray<readonly [RegExp, number]> = [
  [/^POST \/api\/pair$/, 200], [/^GET \/api\/version$/, 200], [/^GET \/health$/, 200], [/^GET \/api\/stream$/, 200],
  [/^GET \/api\/projects$/, 200], [/^POST \/api\/sessions$/, 202], [/^POST …\/messages/, 202],
  [/^GET \/api\/usage/, 200], [/^GET \/api\/resumable/, 200], [/^GET \/api\/notes/, 200], [/^GET …\/diff$/, 200],
  [/^POST \/api\/voice\/token$/, 503], [/^POST \/api\/demo\/control$/, 404], [/^POST \/api\/fs\/mkdir$/, 404],
  [/^GET \/api\/(mac|models|fs|devices|projects\/recent)$/, 200],
];

/** Wpis dziennika jako napis z `<HOME>` zamiast katalogu testu. */
function opisWpisu(home: string, wpis: WpisSzpiega): string {
  if (wpis.rodzaj === 'proces') return `proces ${wpis.fn} ${[wpis.plik ?? '', ...(wpis.argumenty ?? [])].join(' ')}`;
  return `odczyt ${wpis.fn} ${(wpis.sciezka ?? '').split(home).join('<HOME>')}`;
}

/** Naruszenia izolacji hosta w wyniku serii, każde z nazwą odczytu, procesu albo pola; pusta lista = brak naruszeń. */
function naruszeniaK6(w: Wynik): string[] {
  const out: string[] = [];
  for (const wpis of w.dziennik) {
    const opis = opisWpisu(w.home, wpis);
    if (!WYJATKI_SZPIEGA.some((wyjatek) => wyjatek.wpis.test(opis))) out.push(opis);
  }
  for (const [zadanieSerii, status] of Object.entries(w.statusy)) {
    const oczekiwany = STATUSY_K3.find(([wzorzec]) => wzorzec.test(zadanieSerii))?.[1];
    if (oczekiwany !== status) out.push(`${zadanieSerii}: ${String(status)} (K3: ${String(oczekiwany)})`);
  }
  const { review } = demoContentEn;
  if (w.tailnet !== null) out.push(`tailnet: ${JSON.stringify(w.tailnet)} (K6: null)`);
  if (w.voiceEnabled !== false) out.push(`voiceEnabled: ${JSON.stringify(w.voiceEnabled)} (K6: false)`);
  if (w.hook !== HOOK_HEALTH_UNKNOWN.status) {
    out.push(`/health hook: ${JSON.stringify(w.hook)} (K6: ${HOOK_HEALTH_UNKNOWN.status})`);
  }
  if (w.serverName !== review.serverName) out.push(`server.name: ${JSON.stringify(w.serverName)} (K6: ${review.serverName})`);
  if (w.nowaSesja?.model !== review.model) {
    out.push(`model nowej sesji: ${JSON.stringify(w.nowaSesja?.model)} (K6: ${review.model})`);
  }
  if (w.nowaSesja?.effort !== review.effort) {
    out.push(`effort nowej sesji: ${JSON.stringify(w.nowaSesja?.effort)} (K6: ${review.effort})`);
  }
  if (w.upgrade.bajty !== 0 || w.upgrade.koniec !== 'eof') {
    out.push(`upgrade /api/term/x: ${String(w.upgrade.bajty)} B, ${w.upgrade.koniec} (K6: EOF bez odpowiedzi HTTP)`);
  }
  return out;
}

const kodRecenzenta = (): string => randomBytes(32).toString('base64url');
const sciezkiLogu = (st: Stanowisko): readonly string[] => [
  path.join(st.dane, 'client.log'), path.join(st.dane, 'client.log.1'),
];

describe('proces trybu recenzji: izolacja hosta', () => {
  it('seria w trybie recenzji: dziennik szpiega pusty, stałe trybu recenzji, kontrola demo 404, upgrade bez odpowiedzi, treść EN', async () => {
    const st = stanowisko();
    for (const plik of sciezkiLogu(st)) writeFileSync(plik, `${JSON.stringify({ msg: TRESC_LOGU })}\n`);
    const kod = kodRecenzenta();
    const p = uruchom(st, await wolnyPort(), { RAROG_DEMO_REVIEW_CODE: kod, RAROG_ORIGINS: ORIGIN_RECENZJI });
    await czekajNaStart(p);
    // Oba pliki znikają przy starcie, zanim serwer przyjmie pierwsze żądanie.
    expect(sciezkiLogu(st).filter((plik) => existsSync(plik))).toEqual([]);
    expect(p.wyjscie()).toContain('review demo: deleted client.log, client.log.1 at start');
    const w = await seria(p, st, 'recenzja', kod);
    expect(naruszeniaK6(w)).toEqual([]);
    expect(p.wyjscie()).not.toContain(kod);

    // Treść z procesu po angielsku: każdy kawałek niepusty, żeby sprawdzarka nie przeszła na pustym.
    expect(w.snapshotSesji).toBe(8);
    expect((w.gitStatus?.['lastCommit'] as { subject?: unknown } | undefined)?.subject)
      .toBe(demoContentEn.lastCommitSubject);
    expect(JSON.stringify(w.pytanie)).toContain(JSON.stringify(demoContentEn.driver.questions[0]?.question));
    expect(Object.keys(w.tresc['notatki'] as object).length).toBeGreaterThan(0);
    expect(nonEnglishTexts({ ...w.tresc, gitStatus: w.gitStatus, pytanie: w.pytanie }, KLUCZE_STRUKTURY)).toEqual([]);
  }, 90_000);

  it('kontrola ujemna: zwykłe demo z tą samą serią → `settings.json`, model ze znacznika, kontrola demo nie 404', async () => {
    const st = stanowisko();
    for (const plik of sciezkiLogu(st)) writeFileSync(plik, `${JSON.stringify({ msg: TRESC_LOGU })}\n`);
    const p = uruchom(st, await wolnyPort(), {});
    await czekajNaStart(p);
    // Zwykłe demo nie kasuje `client.log` (kasowanie dotyczy tylko trybu recenzji).
    expect(sciezkiLogu(st).map((plik) => readFileSync(plik, 'utf8'))).toEqual([
      `${JSON.stringify({ msg: TRESC_LOGU })}\n`, `${JSON.stringify({ msg: TRESC_LOGU })}\n`,
    ]);
    const naruszenia = naruszeniaK6(await seria(p, st, 'demo', ''));
    expect(naruszenia).toEqual(expect.arrayContaining([
      expect.stringMatching(/^odczyt \S+ <HOME>\/\.claude\/settings\.json$/u),
      `model nowej sesji: ${JSON.stringify(ZNACZNIK_MODEL)} (K6: ${demoContentEn.review.model})`,
      `effort nowej sesji: ${JSON.stringify(ZNACZNIK_EFFORT)} (K6: ${demoContentEn.review.effort})`,
      expect.stringMatching(/^POST \/api\/demo\/control: (?!404)\d+ \(K3: 404\)$/u),
      'POST /api/fs/mkdir: 409 (K3: 404)',
    ]));
  }, 90_000);
});

describe('plain demo: no host tailnet and no host name', () => {
  // A demo shown, recorded or captured must not reveal the host: no demo mode runs `tailscale status` and none puts
  // `hostname()` into the pairing answer.
  it('no `tailscale` call, the fixed demo tailnet and server name', async () => {
    const content = demoContentEn;
    const st = stanowisko();
    const p = uruchom(st, await wolnyPort(), {});
    await czekajNaStart(p);
    const w = await seria(p, st, 'demo', '');
    const tailscale = w.dziennik.filter((wpis) => wpis.rodzaj === 'proces')
      .map((wpis) => opisWpisu(w.home, wpis)).filter((line) => line.includes('tailscale'));
    expect(tailscale).toEqual([]);
    // The series asks for a new directory: the plain demo refuses it (409) and starts no child for it.
    expect(w.statusy['POST /api/fs/mkdir']).toBe(409);
    expect(w.dziennik.filter((wpis) => wpis.rodzaj === 'proces').map((wpis) => opisWpisu(w.home, wpis))).toEqual([]);
    expect(w.tailnet).toBe('example.ts.net');
    expect(w.serverName).toBe(DEMO_SERVER_NAME);
    // On a host named like the fixed demo name the comparison proves nothing.
    const host = hostname().replace(/\.local$/u, '');
    if (host !== DEMO_SERVER_NAME) expect(w.serverName).not.toBe(host);
    const projects = (w.tresc['projekty'] as { projects?: { name: string }[] } | null)?.projects ?? [];
    expect(projects.map((one) => one.name).sort()).toEqual(Object.values(content.projects).sort());
  }, 90_000);

  // With no `tailscale` in the plain demo, no server series makes a child process call any more: this run shows that
  // the spy still records one made through an ESM named import, the form `server/src` uses.
  it('the spy records a child process call made through a named ESM import', () => {
    const st = stanowisko();
    const script = "import { execFile } from 'node:child_process'; execFile('probe-tool', ['status'], () => {});";
    const run = spawnSync(process.execPath, ['--import', SZPIEG, '--input-type=module', '-e', script], {
      env: { PATH: process.env['PATH'] ?? '', HOME: st.home, SZPIEG_HOSTA_DZIENNIK: st.dziennik },
      encoding: 'utf8', timeout: 30_000,
    });
    expect(run.status, run.stderr).toBe(0);
    const lines = readFileSync(st.dziennik, 'utf8').split('\n').filter((line) => line !== '')
      .map((line) => opisWpisu(st.home, JSON.parse(line) as WpisSzpiega));
    expect(lines).toEqual(['proces execFile probe-tool status']);
  }, 30_000);
});

describe('demo process: PR status from the fixed map, never from gh', () => {
  it('the demo `pull-requests` scenario: the titled PR merged, the bare one without a state, no gh in the spy log', async () => {
    const st = stanowisko();
    const p = uruchom(st, await wolnyPort(), {});
    await czekajNaStart(p);
    const origin = `http://127.0.0.1:${String(p.port)}`;
    const wydany = await zadanie(p.port, 'POST', '/api/demo/pairing', { Origin: origin }, {});
    const para = await zadanie(p.port, 'POST', '/api/pair', { Origin: origin }, {
      v: 1, code: String(wydany.json?.['code'] ?? ''), label: 'iPhone·Test',
    });
    const naglowki = {
      Origin: origin, Authorization: deviceAuthorization(String(para.json?.['deviceId']), String(para.json?.['secret'])),
    };
    const globalny = sluchaj(p.port, '/api/stream', naglowki);
    await globalny.czekaj((r) => r['type'] === 'sessions-snapshot', 5_000);
    const control = await zadanie(p.port, 'POST', '/api/demo/control', { ...naglowki, 'x-rarog-demo-token': 'demo' }, {
      action: 'create', scenario: 'pull-requests',
    });
    expect(control.status, control.tekst).toBe(200);
    const sessionId = String(control.json?.['sessionId'] ?? '');
    type Pr = { url: string; state?: string };
    const prsOf = (r: Record<string, unknown>): Pr[] => {
      const session = r['session'] as { id?: unknown; pullRequests?: Pr[] } | undefined;
      return session?.id === sessionId ? session.pullRequests ?? [] : [];
    };
    const scalony = await globalny.czekaj((r) => r['type'] === 'session-changed'
      && prsOf(r).some((one) => one.url === DEMO_PULL_REQUESTS.titled && one.state === 'merged'), 5_000);
    expect(scalony, 'no session-changed frame with the merged state').not.toBeNull();
    expect(prsOf(scalony ?? {}).find((one) => one.url === DEMO_PULL_REQUESTS.bare)).not.toHaveProperty('state');
    expect(prsOf(scalony ?? {}).find((one) => one.url === DEMO_PULL_REQUESTS.draft)?.state).toBe('draft');
    // Time for a read scheduled by the real-mode rhythm, so a wrongly chosen source would have run by now.
    await new Promise((resolve) => { setTimeout(resolve, NEW_URL_DELAY_MS + 1_000); });
    globalny.zamknij();
    await zatrzymaj(p);
    const dziennik = existsSync(st.dziennik)
      ? readFileSync(st.dziennik, 'utf8').split('\n').filter((linia) => linia !== '')
        .map((linia) => JSON.parse(linia) as WpisSzpiega)
      : [];
    const gh = dziennik.filter((wpis) => wpis.rodzaj === 'proces'
      && [wpis.plik ?? '', ...(wpis.argumenty ?? [])].some((arg) => /(^|\/)gh$|graphql/u.test(arg)));
    expect(gh).toEqual([]);
  }, 60_000);
});

describe('proces trybu recenzji: `client.log` przy starcie', () => {
  it('brak plików: start bez błędu i bez linii o kasowaniu', async () => {
    const st = stanowisko();
    const p = uruchom(st, await wolnyPort(), { RAROG_DEMO_REVIEW_CODE: kodRecenzenta(), RAROG_ORIGINS: ORIGIN_RECENZJI });
    await czekajNaStart(p);
    await zatrzymaj(p);
    expect(p.wyjscie()).not.toMatch(/client\.log/u);
  }, 60_000);

  it('błąd kasowania inny niż `ENOENT` przewraca start: kod ≠ 0, nazwa pliku i kod błędu, bez treści', async () => {
    const st = stanowisko();
    // `client.log` jako katalog: `unlink` nie usunie go (EPERM na macOS, EISDIR na Linuksie).
    mkdirSync(path.join(st.dane, 'client.log'));
    writeFileSync(path.join(st.dane, 'client.log', 'zdarzenie'), TRESC_LOGU);
    const p = uruchom(st, await wolnyPort(), { RAROG_DEMO_REVIEW_CODE: kodRecenzenta(), RAROG_ORIGINS: ORIGIN_RECENZJI });
    const wynik = await Promise.race([
      p.koniec,
      czekajNaStart(p).then(() => 'wstał' as const, () => 'padł' as const),
    ]);
    expect(wynik, `serwer wstał mimo błędu kasowania:\n${p.wyjscie()}`).not.toBe('wstał');
    const { kod } = await p.koniec;
    expect(kod).not.toBe(0);
    expect(kod).not.toBeNull();
    expect(p.wyjscie()).toMatch(/review demo: could not delete client\.log \((EPERM|EISDIR)\)/u);
    expect(p.wyjscie()).not.toContain(TRESC_LOGU);
    expect(p.wyjscie()).not.toMatch(/listening on/u);
  }, 60_000);
});
