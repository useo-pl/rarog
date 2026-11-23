/**
 * Stanowisko czarnej skrzynki trybu recenzji demo: prawdziwy router na prawdziwym
 * managerze demo (`demoContentPl`, atrapa herdr), prawdziwy magazyn `devices.json` w katalogu tymczasowym, parowanie,
 * hub SSE i skutki odpięcia (`attachDeactivation`, jak w `server/src/index.ts`).
 *
 * Dwa tryby z tym samym składaniem, różne tylko konfiguracją:
 * - `recenzja`: `RAROG_DEMO=1` z kodem recenzenta, który stanowisko losuje w czasie biegu i trzyma w domknięciu
 *   (test go nie zna; `zawieraKod` sprawdza tekst, `sparuj` paruje). Złożenie izolowane od hosta: bez dyktowania-atrapy
 *   (router składa prawdziwy minter, który przy wyłączonym głosie daje 503), bez `tailnet`, bez sond `/health`,
 *   bez terminala i kontroli demo, limity z `demoUsageProvider`, model i effort nowej sesji ze stałych zestawu.
 * - `demo`: zwykłe demo bez kodu (wyrocznia różnicowa), z dyktowaniem-atrapą jak w `index.ts`; urządzenia paruje
 *   kod `admin` (pierwsze) i `POST /api/pairings` z kluczem pierwszego (kolejne).
 *
 * Odpowiedzi tras nie biorą niczego z katalogu domowego: limity, maszyna i system to fikcje demo, a domyślny model
 * sesji nie idzie przez `readAccountDefault*`. Izolację całego procesu od hosta sprawdza
 * `server/test/demo-review-proces.test.ts`, nie to stanowisko.
 *
 * Żądania idą przez `node:http` z surową ścieżką: `fetch` normalizuje adres po stronie klienta (`..`, `%2e`,
 * ukośniki), a macierz normalizacji ma dojść do serwera dosłownie.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { PROTOCOL_VERSION } from '@rarog/shared';
import { createDeviceStore, createLoginLimiter, createPairing, deviceAuthorization } from '../../src/auth/index.ts';
import type { DeviceStore } from '../../src/auth/index.ts';
import { loadConfig } from '../../src/config.ts';
import type { RarogConfig } from '../../src/config.ts';
import { demoContentPl } from '../../src/demo/content/pl.ts';
import { DEMO_SERVER_SYSTEM, demoMacStats } from '../../src/demo/mac.ts';
import { createMockHerdr } from '../../src/demo/mock-herdr.ts';
import { createDemoNotes } from '../../src/demo/notes.ts';
import type { DemoNotes } from '../../src/demo/notes.ts';
import { demoUsageProvider } from '../../src/demo/usage.ts';
import { demoVoiceMinter } from '../../src/demo/voice.ts';
import { attachDeactivation } from '../../src/device-effects.ts';
import { type Logger, createRouter } from '../../src/router.ts';
import { createManager } from '../../src/sessions/manager.ts';
import type { ManagerApi } from '../../src/sessions/manager-api.ts';
import { SseHub } from '../../src/sse.ts';

/** Jedyny wpis allow-listy `Origin` obu trybów (tryb recenzji wymaga jednego originu `https`). */
export const ORIGIN = 'https://demo.rarog.example';

export type Tryb = 'recenzja' | 'demo';

export interface Odpowiedz {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly bytes: Buffer;
  /** Ciało JSON albo `null` (puste ciało, inny typ treści). */
  readonly json: Record<string, unknown> | null;
}

export interface ZadanieOpcje {
  /** Ciało: obiekt idzie jako JSON, napis dosłownie. */
  readonly body?: unknown;
  /** Klucz urządzenia (`Authorization`); brak = żądanie bez klucza. */
  readonly auth?: string;
  /** `Origin`; domyślnie {@link ORIGIN} dla metod innych niż GET, `null` = bez nagłówka. */
  readonly origin?: string | null;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface Urzadzenie {
  readonly id: string;
  readonly auth: string;
}

/** Strumień SSE słuchany w tle: ramki `data:` w kolejności i stan połączenia. */
export interface Strumien {
  readonly status: Promise<number>;
  ramki(): readonly Record<string, unknown>[];
  /** Czeka na ramkę spełniającą warunek (do limitu czasu) i ją oddaje. */
  czekajNa(warunek: (ramka: Record<string, unknown>) => boolean, ms?: number): Promise<Record<string, unknown>>;
  /** Czeka, aż serwer zamknie strumień; `false` po limicie czasu. */
  zamkniety(ms?: number): Promise<boolean>;
  /** Liczba fragmentów danych (zdarzeń `data`) odebranych do tej chwili. */
  fragmenty(): number;
  zamknij(): void;
}

export interface StanowiskoOpcje {
  /**
   * Sonda czułości rejestru wycieku: serwer stanowiska (nie router) odpowiada na ścieżkach `SONDA_*` kodem recenzenta,
   * w ciele rozciętym między dwa zapisy albo w nagłówku. Tylko tryb recenzji; bez opcji tych ścieżek nie ma.
   */
  readonly sondaWycieku?: boolean;
}

/** Ścieżki sondy czułości ({@link StanowiskoOpcje.sondaWycieku}); router ich nie zna. */
export const SONDA = {
  strumien: '/__sonda/strumien',
  odmowa: '/__sonda/odmowa',
  cialo: '/__sonda/cialo',
  naglowek: '/__sonda/naglowek',
} as const;

export interface Stanowisko {
  readonly tryb: Tryb;
  readonly base: string;
  readonly port: number;
  readonly config: RarogConfig;
  readonly manager: ManagerApi;
  readonly hub: SseHub;
  readonly notes: DemoNotes;
  readonly store: DeviceStore;
  readonly dataDir: string;
  /** Linie loggera routera, magazynu i skutków odpięcia. */
  readonly logs: readonly string[];
  /** Czy tekst zawiera kod recenzenta (w zwykłym demo zawsze `false`). */
  zawieraKod(text: string): boolean;
  /**
   * Odpowiedzi, które niosły kod recenzenta (ma być pusto): `<metoda> <ścieżka>` dla ciała `zadanie`,
   * z dopiskiem `(strumień)` dla surowych bajtów `strumien` przy dowolnym statusie i `(nagłówki)` dla nagłówków.
   */
  readonly wyciekiKodu: readonly string[];
  /** Ciało `POST /api/pair` z kodem recenzenta (tylko tryb recenzji). */
  cialoParowania(label: string): Record<string, unknown>;
  /** Nowe urządzenie przez `POST /api/pair`: kod recenzenta albo (zwykłe demo) kod `admin` / `POST /api/pairings`. */
  sparuj(label?: string): Promise<Urzadzenie>;
  zadanie(method: string, sciezka: string, opts?: ZadanieOpcje): Promise<Odpowiedz>;
  strumien(sciezka: string, opts?: ZadanieOpcje): Strumien;
  close(): Promise<void>;
}

/** Czeka (bez timerów atrapy) aż warunek się spełni; po limicie `false`. */
async function czekaj(warunek: () => boolean, ms: number): Promise<boolean> {
  const koniec = Date.now() + ms;
  while (Date.now() < koniec) {
    if (warunek()) return true;
    await new Promise((resolve) => { setTimeout(resolve, 5); });
  }
  return warunek();
}

/**
 * Sonda czułości: kod rozcięty w połowie między dwa zapisy odpowiedzi (drugi po 30 ms, więc klient dostaje dwa
 * fragmenty), w strumieniu 200, w odmowie 401, w ciele JSON i w nagłówku. `false` = ścieżka nie należy do sondy.
 */
function sonda(kod: string, req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const pol = Math.floor(kod.length / 2);
  const rozciete = (status: number, type: string, przed: string, po: string): void => {
    res.writeHead(status, { 'Content-Type': type });
    res.write(`${przed}${kod.slice(0, pol)}`);
    setTimeout(() => { res.end(`${kod.slice(pol)}${po}`); }, 30);
  };
  if (req.url === SONDA.strumien) rozciete(200, 'text/event-stream', 'data: {"type":"sonda","x":"', '"}\n\n');
  else if (req.url === SONDA.odmowa) rozciete(401, 'application/json', '{"error":"unauthorized","x":"', '"}');
  else if (req.url === SONDA.cialo) rozciete(200, 'application/json', '{"x":"', '"}');
  else if (req.url === SONDA.naglowek) {
    res.writeHead(204, { 'X-Sonda': kod });
    res.end();
  } else return false;
  return true;
}

export async function stanowisko(tryb: Tryb, opcje: StanowiskoOpcje = {}): Promise<Stanowisko> {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'a5z7-'));
  // Kod recenzenta tylko w pamięci tego stanowiska: 32 losowe bajty base64url, kształt kodu parowania.
  const kod = tryb === 'recenzja' ? randomBytes(32).toString('base64url') : null;
  if (opcje.sondaWycieku === true && kod === null) throw new Error('stanowisko: sonda wycieku tylko w trybie recenzji');
  const env: NodeJS.ProcessEnv = { RAROG_DEMO: '1', RAROG_DATA_DIR: dataDir, RAROG_ORIGINS: ORIGIN };
  if (kod !== null) env['RAROG_DEMO_REVIEW_CODE'] = kod;
  const config = loadConfig(env);
  if ((config.demoReview !== null) !== (tryb === 'recenzja')) {
    throw new Error(`stanowisko: tryb ${tryb}, a demoReview ${config.demoReview === null ? 'null' : 'ustawione'}`);
  }

  const logs: string[] = [];
  const logger: Logger = { info: (line) => { logs.push(line); }, error: (line) => { logs.push(line); } };
  const content = demoContentPl;
  const mock = createMockHerdr(content);
  const manager = await createManager({
    ...config, demoContent: content, system: DEMO_SERVER_SYSTEM,
    herdrSupervisor: mock.supervisor, herdrDeps: mock.deps,
    accountDefaultModel: () => content.review.model,
    accountDefaultEffort: () => content.review.effort,
  });
  await manager.ready;
  const notes = createDemoNotes(content);
  const hub = new SseHub({
    manager, serverStartId: `a5z7-${tryb}`, protocolVersion: PROTOCOL_VERSION, heartbeatMs: 0,
    notesFor: (cwds) => notes.withNotes(cwds),
  });
  hub.start();
  const store = createDeviceStore({ dataDir, epoch: config.epoch, log: (line) => { logs.push(line); } });
  const pairing = createPairing({ store, epoch: config.epoch });
  attachDeactivation(store, { pairing, hub, log: (line) => { logs.push(line); } });
  const mac = demoMacStats();
  const router = createRouter({
    config, manager, hub, serverStartId: `a5z7-${tryb}`, startedAtMs: Date.now(), logger,
    system: DEMO_SERVER_SYSTEM, mac: () => mac.current(), usage: demoUsageProvider(), notes,
    readUpload: (cwd, name) => mock.readUpload(cwd, name),
    ...(tryb === 'demo' ? { voice: demoVoiceMinter() } : {}),
    loginLimiter: createLoginLimiter(), iroh: null,
    devices: { store, pairing, serverName: content.review.serverName },
  });
  const server = http.createServer(opcje.sondaWycieku === true && kod !== null
    ? (req, res) => { if (!sonda(kod, req, res)) router(req, res); }
    : router);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const port = (server.address() as AddressInfo).port;
  const open = new Set<http.ClientRequest>();
  const wyciekiKodu: string[] = [];
  /** Nagłówki odpowiedzi z kodem recenzenta → wpis `(nagłówki)`. */
  const sprawdzNaglowki = (method: string, sciezka: string, headers: http.IncomingHttpHeaders): void => {
    if (kod !== null && JSON.stringify(headers).includes(kod)) wyciekiKodu.push(`${method} ${sciezka} (nagłówki)`);
  };

  const naglowki = (method: string, opts: ZadanieOpcje, payload: string | undefined): http.OutgoingHttpHeaders => {
    const origin = opts.origin === undefined ? (method === 'GET' ? null : ORIGIN) : opts.origin;
    return {
      ...(origin === null ? {} : { Origin: origin }),
      ...(opts.auth === undefined ? {} : { Authorization: opts.auth }),
      ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...opts.headers,
    };
  };

  const zadanie = (method: string, sciezka: string, opts: ZadanieOpcje = {}): Promise<Odpowiedz> =>
    new Promise((resolve, reject) => {
      const payload = opts.body === undefined
        ? undefined
        : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
      const req = http.request({
        host: '127.0.0.1', port, method, path: sciezka, headers: naglowki(method, opts, payload),
      }, (res) => {
        sprawdzNaglowki(method, sciezka, res.headers);
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => { chunks.push(chunk); });
        res.on('end', () => {
          const bytes = Buffer.concat(chunks);
          if (kod !== null && bytes.toString('latin1').includes(kod)) wyciekiKodu.push(`${method} ${sciezka}`);
          const type = res.headers['content-type'] ?? '';
          let json: Record<string, unknown> | null = null;
          if (type.includes('application/json') && bytes.length > 0) {
            json = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, bytes, json });
        });
      });
      req.on('error', reject);
      req.end(payload);
    });

  const strumien = (sciezka: string, opts: ZadanieOpcje = {}): Strumien => {
    const zebrane: Record<string, unknown>[] = [];
    let zamkniety = false;
    let bufor = '';
    // Całe surowe ciało, narastająco: kod rozcięty między fragmenty danych i tak jest w nim w całości.
    let surowe = Buffer.alloc(0);
    let fragmenty = 0;
    let wyciek = false;
    const dekoder = new StringDecoder('utf8');
    let ustawStatus: (status: number) => void = () => {};
    const status = new Promise<number>((resolve) => { ustawStatus = resolve; });
    const req = http.get({ host: '127.0.0.1', port, path: sciezka, headers: naglowki('GET', opts, undefined) }, (res) => {
      ustawStatus(res.statusCode ?? 0);
      sprawdzNaglowki('GET', sciezka, res.headers);
      // Bez względu na status: odmowa 401 też jest ciałem, które dociera do klienta.
      res.on('data', (chunk: Buffer) => {
        fragmenty += 1;
        surowe = Buffer.concat([surowe, chunk]);
        if (!wyciek && kod !== null && surowe.includes(kod)) {
          wyciek = true;
          wyciekiKodu.push(`GET ${sciezka} (strumień)`);
        }
        bufor += dekoder.write(chunk);
        const czesci = bufor.split('\n\n');
        bufor = czesci.pop() ?? '';
        for (const ramka of czesci) {
          const data = /^data: (.*)$/m.exec(ramka)?.[1];
          if (data !== undefined) zebrane.push(JSON.parse(data) as Record<string, unknown>);
        }
      });
      res.on('end', () => { zamkniety = true; });
      res.on('close', () => { zamkniety = true; });
    });
    open.add(req);
    req.on('error', () => { zamkniety = true; });
    req.on('close', () => { zamkniety = true; open.delete(req); });
    return {
      status,
      ramki: () => zebrane,
      async czekajNa(warunek, ms = 5_000) {
        const ok = await czekaj(() => zebrane.some(warunek), ms);
        const found = zebrane.find(warunek);
        if (!ok || found === undefined) {
          throw new Error(`strumień ${sciezka}: brak ramki po ${String(ms)} ms (typy: ${
            zebrane.map((r) => String(r['type'])).join(', ')})`);
        }
        return found;
      },
      zamkniety: (ms = 5_000) => czekaj(() => zamkniety, ms),
      fragmenty: () => fragmenty,
      zamknij() { req.destroy(); },
    };
  };

  const urzadzenia: Urzadzenie[] = [];
  const sparuj = async (label = 'iPhone·Rarog'): Promise<Urzadzenie> => {
    let code: string;
    if (kod !== null) {
      code = kod;
    } else if (store.active().length === 0) {
      code = pairing.issue('admin').code;
    } else {
      const wydawca = urzadzenia.find((u) => store.get(u.id) !== undefined);
      if (wydawca === undefined) throw new Error('stanowisko: brak aktywnego urządzenia do wydania kodu');
      const issued = await zadanie('POST', '/api/pairings', { body: {}, auth: wydawca.auth });
      if (issued.status !== 200) throw new Error(`stanowisko: POST /api/pairings → ${String(issued.status)}`);
      code = String(issued.json?.['code']);
    }
    const res = await zadanie('POST', '/api/pair', { body: { v: 1, code, label, build: '1' } });
    if (res.status !== 200) throw new Error(`stanowisko: POST /api/pair → ${String(res.status)}`);
    const id = String(res.json?.['deviceId']);
    const u = { id, auth: deviceAuthorization(id, String(res.json?.['secret'])) };
    urzadzenia.push(u);
    return u;
  };

  return {
    tryb, base: `http://127.0.0.1:${String(port)}`, port, config, manager, hub, notes, store, dataDir, logs,
    zawieraKod: (text) => kod !== null && text.includes(kod),
    wyciekiKodu,
    cialoParowania(label) {
      if (kod === null) throw new Error('stanowisko: kod recenzenta jest tylko w trybie recenzji');
      return { v: 1, code: kod, label, build: '1' };
    },
    sparuj, zadanie, strumien,
    async close() {
      for (const req of open) req.destroy();
      hub.closeAll();
      server.closeAllConnections();
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
      await manager.dispose();
      mock.dispose();
      await store.flush();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
