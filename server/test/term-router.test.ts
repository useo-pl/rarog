/**
 * Terminal PTY — kontrakt HTTP (`POST /api/term`, `DELETE /api/term/:id`, `termEnabled`).
 *
 * Prawdziwy `node:http` na porcie efemerycznym, ale ficzer podstawiony ATRAPĄ: tu badamy
 * bramkę routera (auth, Origin, korzenie, killswitch), a nie tmuxa. Spawny mają własny plik
 * (`term-integration.test.ts`) za bramką środowiskową.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { say } from '@rarog/shared/sentences';
import {
  TERM_HISTORY_DEFAULT_LINES, TERM_HISTORY_MAX_LINES, TERM_SLOTS_MAX,
  termHistoryResponseSchema, termListResponseSchema, termOpenResponseSchema,
} from '@rarog/shared';
import type { TermRole } from '@rarog/shared';
import { type RarogConfig, loadConfig } from '../src/config.ts';
import { type Logger, createRouter } from '../src/router.ts';
import { SseHub } from '../src/sse.ts';
import type {
  TermFeature, TermHistoryResult, TermOpenResult, TermSlotRequest,
} from '../src/term/index.ts';
import { FakeManager, makeSummary } from './fake-manager.ts';
import { createTestDevice } from './helpers/urzadzenie.ts';

const ORIGIN = 'http://localhost:8930';

/** Atrapa ficzeru: notuje wywołania, nie dotyka ani tmuxa, ani PTY. */
class FakeTerm implements TermFeature {
  readonly enabled = true as const;
  /** Żniwiarz i adopcja są tu bezprzedmiotowe — obietnica jest gotowa od razu. */
  readonly ready = Promise.resolve();
  /**
   * Trójki `(cwd, slot, role)`, z którymi router zawołał ficzer — kontrakt slotów I ROLI
   * jest tu asercją: rola musi dojechać do rejestru dosłownie, bo to ona
   * rozstrzyga tożsamość panelu.
   */
  readonly opened: { cwd: string; slot: TermSlotRequest; role: TermRole }[] = [];
  readonly closed: string[] = [];
  result: TermOpenResult = { ok: true, id: '0123456789abcdef', slot: 1, role: 'shell' };
  closeResult = true;

  /** Lista dla `GET /api/term` — atrapa oddaje to, co test jej włoży. */
  listResult: {
    id: string; cwd: string; live: boolean; slot: number; proc: string; role: TermRole;
  }[] = [];

  open(cwd: string, slot: TermSlotRequest = 1, role: TermRole = 'shell'): TermOpenResult {
    this.opened.push({ cwd, slot, role });
    return this.result;
  }

  list(): {
    id: string; cwd: string; live: boolean; slot: number; proc: string; role: TermRole;
  }[] {
    return this.listResult;
  }

  close(id: string): boolean {
    this.closed.push(id);
    return this.closeResult;
  }

  /** Wywołania `GET /api/term/:id/history` — id i ŚCIĘTA już liczba linii. */
  readonly historyCalls: { id: string; lines: number }[] = [];
  historyResult: TermHistoryResult = { ok: true, text: 'historia\n', truncated: false };

  history(id: string, lines: number): Promise<TermHistoryResult> {
    this.historyCalls.push({ id, lines });
    return Promise.resolve(this.historyResult);
  }

  handleUpgrade(): void { /* upgrade ma własny test integracyjny */ }
  closeOwner(): number { return 0; }
  dispose(): void { /* nic do sprzątania */ }
}

interface Harness {
  base: string;
  term: FakeTerm;
  /** Linie `server.log` — strażnik reguły „zero logowania treści terminala". */
  logs: string[];
  config: RarogConfig;
  auth: string;
  root: string;
  project: string;
  close(): Promise<void>;
}

async function startHarness(withTerm: boolean): Promise<Harness> {
  // Korzeń po `realpath`: na macOS katalog tymczasowy (`$TMPDIR`) jest dowiązaniem pod `/private`,
  // a `validateProjectCwd` porównuje granicę także po rozwiązaniu dowiązań.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rarog-term-router-')));
  const project = join(root, 'projekt');
  await mkdtemp(join(root, 'projekt'));
  const config = loadConfig({
    RAROG_DEMO: '1',
    RAROG_PROJECT_ROOTS: root,
  });
  const device = createTestDevice(config.dataDir, { epoch: config.epoch });
  const manager = new FakeManager([makeSummary({ id: 's1' })]);
  const hub = new SseHub({ manager, serverStartId: 'start', protocolVersion: 1, heartbeatMs: 0 });
  const term = new FakeTerm();
  // Log ZBIERANY, nie wyciszony: bez tego reguły „ani jeden znak treści do `server.log`"
  // nie da się sprawdzić inaczej niż czytaniem kodu.
  const logs: string[] = [];
  const logger: Logger = {
    info: (msg: string) => { logs.push(msg); },
    error: (msg: string) => { logs.push(msg); },
  };
  const server = http.createServer(createRouter({
    config,
    manager,
    hub,
    serverStartId: 'start',
    startedAtMs: Date.now(),
    logger,
    devices: device.identity,
    ...(withTerm ? { term } : {}),
  }));
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${String(port)}`,
    term,
    logs,
    config,
    auth: device.authorization,
    root,
    project,
    close: async () => {
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
      await rm(root, { recursive: true, force: true });
    },
  };
}

let h: Harness;

describe('POST /api/term — bramka katalogu i sufitu', () => {
  beforeEach(async () => { h = await startHarness(true); });
  afterEach(async () => { await h.close(); });

  const post = (body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
    fetch(`${h.base}/api/term`, {
      method: 'POST',
      headers: { Origin: ORIGIN, Authorization: h.auth, 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  /*
   * ZGODNOŚĆ WSTECZ: gołe `{cwd}` (klient sprzed tabów, bundle sprzed deployu) ma trafić
   * w SLOT 1, czyli w dokładnie ten terminal, który projekt miał dotąd — id slotu 1 to
   * niezmieniony `sha256(realpath(cwd))`.
   */
  it('gołe `{cwd}` oddaje id i slot 1 (klient sprzed tabów)', async () => {
    const res = await post({ cwd: h.root });
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(termOpenResponseSchema.safeParse(body).success).toBe(true);
    expect(body).toEqual({ id: '0123456789abcdef', slot: 1, role: 'shell' });
    expect(h.term.opened).toEqual([{ cwd: h.root, slot: 1, role: 'shell' }]);
  });

  it('`slot: 3` jedzie do ficzeru dosłownie', async () => {
    await post({ cwd: h.root, slot: 3 });
    expect(h.term.opened).toEqual([{ cwd: h.root, slot: 3, role: 'shell' }]);
  });

  it('`slot: \'next\'` jedzie do ficzeru dosłownie, a numer wraca w odpowiedzi', async () => {
    h.term.result = { ok: true, id: 'abcdefabcdef0123', slot: 2, role: 'shell' };
    const res = await post({ cwd: h.root, slot: 'next' });
    expect(h.term.opened).toEqual([{ cwd: h.root, slot: 'next', role: 'shell' }]);
    expect(await res.json()).toEqual({ id: 'abcdefabcdef0123', slot: 2, role: 'shell' });
  });

  /*
   * Zakresu pilnuje SCHEMAT, nie rejestr: numer spoza kontraktu ma odpaść na bramce ciała
   * i nie dotknąć rejestru w ogóle (ta sama zasada co przy `cwd` spoza korzeni).
   */
  it.each([0, TERM_SLOTS_MAX + 1, 1.5, 'ostatni'])(
    'slot %s to 400 i ficzer NIE dostaje pytania', async (slot) => {
      const res = await post({ cwd: h.root, slot });
      expect(res.status).toBe(400);
      expect(h.term.opened).toEqual([]);
    },
  );

  it('bez klucza urządzenia odpowiada 401 i NIE dotyka rejestru', async () => {
    const res = await fetch(`${h.base}/api/term`, {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: h.root }),
    });
    expect(res.status).toBe(401);
    expect(h.term.opened).toEqual([]);
  });

  it('origin spoza allow-listy to 403 (CSRF)', async () => {
    const res = await post({ cwd: h.root }, { Origin: 'https://zly.example' });
    expect(res.status).toBe(403);
    expect(h.term.opened).toEqual([]);
  });

  it('katalog spoza RAROG_PROJECT_ROOTS to 400 — ścieżka nie wchodzi do rejestru', async () => {
    const res = await post({ cwd: '/etc' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'cwd-not-allowed' });
    expect(h.term.opened).toEqual([]);
  });

  it('nieistniejący katalog w korzeniu też jest 400', async () => {
    const res = await post({ cwd: join(h.root, 'nie-ma') });
    expect(res.status).toBe(400);
    expect(h.term.opened).toEqual([]);
  });

  it('ciało bez `cwd` to 400 z kontraktu', async () => {
    expect((await post({})).status).toBe(400);
  });

  it('ponad sufit żywych PTY to 409 z powodem', async () => {
    h.term.result = { ok: false, error: 'limit', sentence: say('term.open-limit', { max: 4 }) };
    const res = await post({ cwd: h.root });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'term-limit' });
  });

  it('GET oddaje listę terminali z rejestru (sidebar)', async () => {
    h.term.listResult = [
      { id: '0123456789abcdef', cwd: h.project, live: true, slot: 1, proc: 'nvim', role: 'shell' },
      { id: 'fedcba9876543210', cwd: h.project, live: false, slot: 2, proc: '', role: 'shell' },
    ];
    const res = await fetch(`${h.base}/api/term`, { headers: { Authorization: h.auth } });
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    // Schemat, a nie samo `toEqual`: `slot` i `proc` są częścią kontraktu,
    // a pusty `proc` znaczy „backend jeszcze nie wie", nie „brak pola".
    expect(termListResponseSchema.safeParse(body).success).toBe(true);
    expect(body).toEqual({ terminals: h.term.listResult });
  });

  /*
   * ROLE POPUPOWE (`lazygit`, `popup`): panele poza slotami projektu. Router ma je
   * przepuścić DOSŁOWNIE — to rola rozstrzyga tożsamość panelu (`termIdFor` z rolą), więc
   * zgubiona po drodze oznaczałaby wejście popupu w slot 1 projektu, czyli w cudzą powłokę.
   */
  it.each(['lazygit', 'popup'] as const)(
    '`role: %s` jedzie do ficzeru, a odpowiedź niesie `slot: 0` i rolę',
    async (role) => {
      h.term.result = { ok: true, id: 'aaaabbbbccccdddd', slot: 0, role };
      const res = await post({ cwd: h.root, role });
      expect(res.status).toBe(200);
      const body: unknown = await res.json();
      // Schemat dopuszcza `slot: 0` WYŁĄCZNIE razem z rolą — stąd walidacja, a nie samo `toEqual`.
      expect(termOpenResponseSchema.safeParse(body).success).toBe(true);
      expect(body).toEqual({ id: 'aaaabbbbccccdddd', slot: 0, role });
      expect(h.term.opened).toEqual([{ cwd: h.root, slot: 1, role }]);
    },
  );

  /*
   * `slot` przy roli popupowej jest ZABRONIONY, a nie ignorowany: cicho pominięty numer kazałby
   * klientowi wierzyć, że dostał tab, o który prosił. Odpada na bramce ciała, więc rejestr
   * nie dostaje pytania w ogóle.
   */
  it.each([
    ['lazygit', 1], ['lazygit', 'next'], ['popup', 1], ['popup', 'next'],
  ])('`role: %s` ze `slot: %s` to 400 i ficzer bez pytania', async (role, slot) => {
    const res = await post({ cwd: h.root, slot, role });
    expect(res.status).toBe(400);
    expect(h.term.opened).toEqual([]);
  });

  it('rola spoza kontraktu to 400', async () => {
    const res = await post({ cwd: h.root, role: 'htop' });
    expect(res.status).toBe(400);
    expect(h.term.opened).toEqual([]);
  });

  it('`role: \'shell\'` ze slotem przechodzi — zakaz dotyczy WYŁĄCZNIE ról popupowych', async () => {
    const res = await post({ cwd: h.root, slot: 2, role: 'shell' });
    expect(res.status).toBe(200);
    expect(h.term.opened).toEqual([{ cwd: h.root, slot: 2, role: 'shell' }]);
  });

  it('GET niesie rolę każdego wpisu, a panele popupowe stoją na `slot: 0`', async () => {
    h.term.listResult = [
      { id: '0123456789abcdef', cwd: h.project, live: true, slot: 1, proc: 'zsh', role: 'shell' },
      {
        id: 'aaaabbbbccccdddd', cwd: h.project, live: true, slot: 0, proc: 'lazygit',
        role: 'lazygit',
      },
      {
        id: 'bbbbccccddddeeee', cwd: h.project, live: true, slot: 0, proc: 'zsh',
        role: 'popup',
      },
    ];
    const res = await fetch(`${h.base}/api/term`, { headers: { Authorization: h.auth } });
    const body: unknown = await res.json();
    expect(termListResponseSchema.safeParse(body).success).toBe(true);
    expect(body).toEqual({ terminals: h.term.listResult });
  });

  it('PUT na tę ścieżkę to 405 — a bez Origin nawet tam nie dochodzi', async () => {
    /*
     * `PUT` stoi w bramce CSRF razem z `PUT /api/notes` (jest równie mutujący
     * co POST). Kolejność jest więc taka jak przy POST: najpierw origin, potem metoda.
     */
    const bezOrigin = await fetch(`${h.base}/api/term`, {
      method: 'PUT', headers: { Authorization: h.auth },
    });
    expect(bezOrigin.status).toBe(403);
    const res = await fetch(`${h.base}/api/term`, {
      method: 'PUT', headers: { Authorization: h.auth, Origin: ORIGIN },
    });
    expect(res.status).toBe(405);
  });
});

describe('DELETE /api/term/:id — jawne zamknięcie sesji tmux', () => {
  beforeEach(async () => { h = await startHarness(true); });
  afterEach(async () => { await h.close(); });

  const del = (id: string, headers: Record<string, string> = {}): Promise<Response> =>
    fetch(`${h.base}/api/term/${id}`, {
      method: 'DELETE',
      headers: { Origin: ORIGIN, Authorization: h.auth, ...headers },
    });

  it('200 i `kill-session` dla znanego id', async () => {
    const res = await del('0123456789abcdef');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    expect(h.term.closed).toEqual(['0123456789abcdef']);
  });

  it('404 dla id spoza rejestru', async () => {
    h.term.closeResult = false;
    expect((await del('ffffffffffffffff')).status).toBe(404);
  });

  it('bez klucza urządzenia 401', async () => {
    const res = await del('0123456789abcdef', { Authorization: '' });
    expect(res.status).toBe(401);
    expect(h.term.closed).toEqual([]);
  });

  /*
   * DELETE zabija sesję tmux, więc jest równie mutujący co POST i ma tę samą bramkę Origin.
   * Bez niej obca strona z ważnym cookie zamknęłaby cudzy terminal.
   */
  it('origin spoza allow-listy to 403 (CSRF) — sesja NIE ginie', async () => {
    const res = await del('0123456789abcdef', { Origin: 'https://zly.example' });
    expect(res.status).toBe(403);
    expect(h.term.closed).toEqual([]);
  });

  it('DELETE bez nagłówka Origin też jest 403', async () => {
    const res = await fetch(`${h.base}/api/term/0123456789abcdef`, {
      method: 'DELETE', headers: { Authorization: h.auth },
    });
    expect(res.status).toBe(403);
    expect(h.term.closed).toEqual([]);
  });
});

describe('killswitch: bez ficzeru endpointów NIE MA', () => {
  beforeEach(async () => { h = await startHarness(false); });
  afterEach(async () => { await h.close(); });

  it('POST /api/term oddaje 404', async () => {
    const res = await fetch(`${h.base}/api/term`, {
      method: 'POST',
      headers: { Origin: ORIGIN, Authorization: h.auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: h.root }),
    });
    expect(res.status).toBe(404);
  });

  it('DELETE /api/term/:id oddaje 404', async () => {
    const res = await fetch(`${h.base}/api/term/0123456789abcdef`, {
      method: 'DELETE', headers: { Origin: ORIGIN, Authorization: h.auth },
    });
    expect(res.status).toBe(404);
  });

  it('`GET /api/version` mówi `termEnabled: false` — klient nie pokaże martwego wiersza', async () => {
    const res = await fetch(`${h.base}/api/version`, { headers: { Authorization: h.auth } });
    expect(await res.json()).toMatchObject({ termEnabled: false });
  });
});

describe('`GET /api/version` z ficzerem', () => {
  beforeEach(async () => { h = await startHarness(true); });
  afterEach(async () => { await h.close(); });

  it('mówi `termEnabled: true`', async () => {
    const res = await fetch(`${h.base}/api/version`, { headers: { Authorization: h.auth } });
    expect(await res.json()).toMatchObject({ termEnabled: true });
  });
});

describe('GET /api/term/:id/history — historia do zaznaczenia', () => {
  beforeEach(async () => { h = await startHarness(true); });
  afterEach(async () => { await h.close(); });

  const get = (query = '', headers: Record<string, string> = {}): Promise<Response> =>
    fetch(`${h.base}/api/term/0123456789abcdef/history${query}`, {
      headers: { Authorization: h.auth, ...headers },
    });

  it('oddaje `{ text, truncated }` zgodne z kontraktem', async () => {
    h.term.historyResult = { ok: true, text: 'wyjscie\n', truncated: true };
    const res = await get();
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(termHistoryResponseSchema.safeParse(body).success).toBe(true);
    expect(body).toEqual({ text: 'wyjscie\n', truncated: true });
  });

  it('bez `lines` bierze wartość domyślną z kontraktu', async () => {
    await get();
    expect(h.term.historyCalls)
      .toEqual([{ id: '0123456789abcdef', lines: TERM_HISTORY_DEFAULT_LINES }]);
  });

  /*
   * Sufit ŚCINA, nie odrzuca — ta sama reguła co przy `limit` w `/api/resumable/recent`:
   * „za dużo linii" nie jest błędem człowieka, tylko końcem tego, co Rarog umie pokazać.
   */
  it('`lines` ponad sufit jest ŚCINANE do TERM_HISTORY_MAX_LINES', async () => {
    await get('?lines=999999');
    expect(h.term.historyCalls[0]?.lines).toBe(TERM_HISTORY_MAX_LINES);
  });

  it('śmieć i wartości niedodatnie wracają do wartości domyślnej', async () => {
    await get('?lines=abc');
    await get('?lines=0');
    await get('?lines=-5');
    expect(h.term.historyCalls.map((call) => call.lines))
      .toEqual([TERM_HISTORY_DEFAULT_LINES, TERM_HISTORY_DEFAULT_LINES, TERM_HISTORY_DEFAULT_LINES]);
  });

  it('ułamek jest obcinany w dół — pół wiersza nie istnieje', async () => {
    await get('?lines=12.9');
    expect(h.term.historyCalls[0]?.lines).toBe(12);
  });

  /*
   * BRAMKA WŁASNOŚCI: ficzer oddaje `not-found` i wtedy, gdy id nie ma w rejestrze, i wtedy,
   * gdy panel spod uchwytu nie nosi już tokenu `rarog-term` tego terminala. Router robi z obu
   * jedno 404 — Rarog nie ma prawa zdradzić, że pod tym adresem stoi CUDZY panel.
   */
  it('cudzy albo nieobecny panel to 404 bez ani jednego znaku treści', async () => {
    h.term.historyResult = { ok: false, error: 'not-found', sentence: say('term.not-found') };
    const res = await get();
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'not-found' });
  });

  it('padnięte gniazdo herdr to 503 (stan przejściowy, wolno spróbować znowu)', async () => {
    h.term.historyResult = {
      ok: false, error: 'unavailable', sentence: say('term.history-unreadable'),
    };
    expect((await get()).status).toBe(503);
  });

  it('bez klucza urządzenia 401 i ficzer NIE dostaje pytania', async () => {
    const res = await fetch(`${h.base}/api/term/0123456789abcdef/history`);
    expect(res.status).toBe(401);
    expect(h.term.historyCalls).toEqual([]);
  });

  it('treść nie jest cache\'owana (`Cache-Control: no-store`)', async () => {
    // W ciele jedzie wyjście powłoki — pośrednik ani dysk przeglądarki nie mają go trzymać.
    expect((await get()).headers.get('cache-control')).toBe('no-store');
  });

  it('POST na tę ścieżkę to 405', async () => {
    const res = await fetch(`${h.base}/api/term/0123456789abcdef/history`, {
      method: 'POST', headers: { Origin: ORIGIN, Authorization: h.auth },
    });
    expect(res.status).toBe(405);
  });

  /*
   * Serwer NIE LOGUJE treści historii — reguła zero logów terminala. Router dostaje tekst
   * i oddaje go w ciele; do `server.log` nie idzie z niego ani jeden znak.
   */
  it('nie zostawia treści w logu serwera', async () => {
    h.term.historyResult = { ok: true, text: 'SEKRET-Z-EKRANU-42\n', truncated: false };
    await get();
    expect(h.logs.some((line) => line.includes('SEKRET-Z-EKRANU-42'))).toBe(false);
  });
});

describe('historia gaśnie razem z ficzerem (RAROG_TERM=0)', () => {
  beforeEach(async () => { h = await startHarness(false); });
  afterEach(async () => { await h.close(); });

  it('GET /api/term/:id/history oddaje 404', async () => {
    const res = await fetch(`${h.base}/api/term/0123456789abcdef/history`, {
      headers: { Authorization: h.auth },
    });
    expect(res.status).toBe(404);
  });
});
