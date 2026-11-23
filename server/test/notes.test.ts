/**
 * Notatki projektu — magazyn JEDNEGO dokumentu i kontrakt HTTP.
 *
 * Dwa poziomy, bo dwie różne rzeczy mogą pójść źle. Magazyn (`notes/store.ts`) odpowiada za
 * tożsamość pliku, zapis atomowy, uprawnienia, wersjonowanie i MIGRACJĘ starego kształtu;
 * router — za bramkę katalogu, killswitch, kody odpowiedzi i ulotny event SSE. Prawdziwy
 * `node:http` na porcie efemerycznym i prawdziwy `dataDir` w katalogu tymczasowym: notatki są
 * plikiem, więc atrapa pliku sprawdzałaby atrapę.
 *
 * Konfiguracja jest tu NIE-DEMO (inaczej niż w większości testów routera) i to jest wymóg,
 * nie kaprys: demo trzyma notatki w PAMIĘCI procesu (`demo/notes.ts`), więc harness w demo nie
 * dotknąłby pliku. Magazyn demo ma własny blok testów niżej.
 */
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  NOTES_MAX_CHARS, notesConflictBodySchema, notesGetResponseSchema, notesPutResponseSchema,
} from '@rarog/shared';
import type { NotesDoc, ServerEvent } from '@rarog/shared';
import { loadConfig, parseNotesEnabled } from '../src/config.ts';
import { type Logger, createRouter } from '../src/router.ts';
import { SseHub } from '../src/sse.ts';
import {
  NOTES_DIRNAME, NotesFailure, mergeLegacyNotes, notesPath, readNotes, writeNotes,
} from '../src/notes/store.ts';
import {
  DEMO_NOTE_CWD, DEMO_NOTE_UPDATED_AT, createDemoNotes,
} from '../src/demo/notes.ts';
import { DEMO_PROJECTS_ROOT } from '../src/demo/seeds.ts';
import { FakeManager, makeSummary } from './fake-manager.ts';
import { createTestDevice } from './helpers/urzadzenie.ts';
import { demoContentPl } from '../src/demo/content/pl.ts';

const ORIGIN = 'http://localhost:8930';

interface Harness {
  base: string;
  auth: string;
  dataDir: string;
  project: string;
  /** Ramki rozesłane po `global` — dowód na ulotny event `notes` (i na brak treści w nim). */
  events: ServerEvent[];
  logs: string[];
  close(): Promise<void>;
}

async function startHarness(notes = true): Promise<Harness> {
  // Korzeń po `realpath`: na macOS katalog tymczasowy (`$TMPDIR`) jest dowiązaniem pod `/private`,
  // a magazyn liczy tożsamość pliku właśnie z `realpath` (tak samo jak rejestr terminali).
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rarog-notes-')));
  const project = await mkdtemp(join(root, 'projekt-'));
  const dataDir = await mkdtemp(join(root, 'dane-'));
  const config = loadConfig({
    RAROG_ORIGINS: ORIGIN,
    RAROG_PROJECT_ROOTS: root,
    RAROG_DATA_DIR: dataDir,
    ...(notes ? {} : { RAROG_NOTES: '0' }),
  });
  const device = createTestDevice(config.dataDir, { epoch: config.epoch });
  const manager = new FakeManager([makeSummary({ id: 's1' })]);
  const hub = new SseHub({ manager, serverStartId: 'start', protocolVersion: 1, heartbeatMs: 0 });
  const events: ServerEvent[] = [];
  const broadcast = hub.broadcast.bind(hub);
  hub.broadcast = (scope, seq, event): void => {
    events.push(event);
    broadcast(scope, seq, event);
  };
  const logs: string[] = [];
  const logger: Logger = {
    info: (msg: string) => { logs.push(msg); },
    error: (msg: string) => { logs.push(msg); },
  };
  const server = http.createServer(createRouter({
    config, manager, hub, serverStartId: 'start', startedAtMs: Date.now(), logger, devices: device.identity,
  }));
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${String(port)}`,
    auth: device.authorization,
    dataDir,
    project,
    events,
    logs,
    close: async () => {
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
      await rm(root, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// Magazyn
// ---------------------------------------------------------------------------

describe('notes/store — dokument projektu', () => {
  let dataDir = '';
  let project = '';
  let root = '';

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'rarog-notes-store-')));
    dataDir = join(root, 'dane');
    project = await mkdtemp(join(root, 'projekt-'));
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('projekt bez notatek to pusty dokument, a nie błąd i nie plik', async () => {
    expect(readNotes(dataDir, project)).toEqual({ text: '', updatedAt: 0 });
    await expect(stat(join(dataDir, NOTES_DIRNAME))).rejects.toThrow();
  });

  it('nazwa pliku idzie od `realpath`, więc dowiązanie trafia w TEN SAM plik', () => {
    // Na macOS `/var` jest dowiązaniem do `/private/var` — bez `realpath` w magazynie ten sam
    // projekt otwarty dwiema drogami miałby dwa pliki notatek i człowiek zobaczyłby pustkę.
    const viaLink = project.replace('/private/var/', '/var/');
    if (viaLink === project) return;
    expect(notesPath(dataDir, viaLink)).toBe(notesPath(dataDir, project));
  });

  it('katalog, którego NIE MA, to `cwd-not-allowed`, nie awaria serwera', () => {
    // `checkCwd` przepuszcza ścieżki z listy projektów bez sprawdzania istnienia (lista pochodzi
    // z historii CLI), więc skasowany katalog musi dojechać tutaj i dostać 400, a nie 500.
    try {
      notesPath(dataDir, join(root, 'nie-ma-mnie'));
      expect.unreachable('notesPath miało rzucić');
    } catch (err) {
      expect(err).toBeInstanceOf(NotesFailure);
      expect((err as NotesFailure).code).toBe('cwd-not-allowed');
    }
  });

  it('zapis zakłada katalog `0700` i plik `0600`', async () => {
    writeNotes(dataDir, project, 'pierwsza', 0);
    const dirMode = (await stat(join(dataDir, NOTES_DIRNAME))).mode & 0o777;
    const fileMode = (await stat(notesPath(dataDir, project))).mode & 0o777;
    expect(dirMode).toBe(0o700);
    expect(fileMode).toBe(0o600);
  });

  it('plik niesie `cwd` — jedyna droga do odzyskania osieroconych notatek po przenosinach', async () => {
    writeNotes(dataDir, project, 'pierwsza', 0);
    const raw = JSON.parse(await readFile(notesPath(dataDir, project), 'utf8')) as { cwd: string };
    // Hash katalogu jest jednokierunkowy, więc po przeniesieniu projektu plik zostaje na dysku
    // bez żadnego widocznego adresu — to pole jest wtedy całą informacją, czyj on jest.
    expect(raw.cwd).toBe(project);
  });

  it('zapis oddaje NOWĄ wersję i ona jest kluczem do następnego zapisu', () => {
    const first = writeNotes(dataDir, project, 'a', 0, () => 5_000);
    expect(first).toEqual({ text: 'a', updatedAt: 5_000 });
    expect(readNotes(dataDir, project)).toEqual(first);
    // Zegar cofnięty: `updatedAt` i tak musi urosnąć, inaczej dwa zapisy w tej samej
    // milisekundzie dałyby wersję nie do odróżnienia od poprzedniej.
    const second = writeNotes(dataDir, project, 'b', first.updatedAt, () => 1_000);
    expect(second.updatedAt).toBeGreaterThan(first.updatedAt);
  });

  it('zapis ze STARĄ wersją to `conflict` z AKTUALNYM dokumentem w wyjątku', () => {
    const first = writeNotes(dataDir, project, 'przed', 0);
    const fresh = writeNotes(dataDir, project, 'z iPada', first.updatedAt);
    try {
      writeNotes(dataDir, project, 'z telefonu', first.updatedAt);
      expect.unreachable('writeNotes miało rzucić');
    } catch (err) {
      const failure = err as NotesFailure;
      expect(failure.code).toBe('conflict');
      // Bez treści z dysku człowiek nie ma jak zobaczyć, co właśnie napisało drugie urządzenie.
      expect(failure.current).toEqual(fresh);
    }
    // Cudza wersja stoi NIETKNIĘTA — odrzucony zapis nie zostawia po sobie ani pół zdania.
    expect(readNotes(dataDir, project)).toEqual(fresh);
  });

  it('PUSTY tekst jest zamiarem człowieka, a nie błędem — kasuje treść, zostawia wersję', () => {
    const first = writeNotes(dataDir, project, 'do skasowania', 0);
    const cleared = writeNotes(dataDir, project, '', first.updatedAt);
    expect(cleared.text).toBe('');
    expect(cleared.updatedAt).toBeGreaterThan(first.updatedAt);
    expect(readNotes(dataDir, project)).toEqual(cleared);
  });

  it('plik nieczytelny nie wywraca odczytu — pusty dokument i stary plik nietknięty', async () => {
    const path = notesPath(dataDir, project);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, '{ to nie jest JSON', 'utf8');
    expect(readNotes(dataDir, project)).toEqual({ text: '', updatedAt: 0 });
    expect(await readFile(path, 'utf8')).toBe('{ to nie jest JSON');
  });

  it('po zapisie nie zostaje żaden plik tymczasowy (`rename`, nie „prawie zapisane")', async () => {
    writeNotes(dataDir, project, 'x', 0);
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(join(dataDir, NOTES_DIRNAME)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Migracja starego kształtu (tablica notatek → jeden dokument)
  // -------------------------------------------------------------------------

  describe('migracja pliku w starym kształcie', () => {
    /** Zapis pliku w STARYM kształcie — dokładnie tak, jak robiła to poprzednia wersja. */
    const writeOldShape = async (notes: unknown[]): Promise<string> => {
      const path = notesPath(dataDir, project);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, `${JSON.stringify({ cwd: project, notes })}\n`, { mode: 0o600 });
      return path;
    };

    it('skleja treści NAJSTARSZA PIERWSZA, rozdzielone pustą linią', async () => {
      await writeOldShape([
        { id: 'b'.repeat(16), createdAt: 2_000, updatedAt: 2_500, source: 'text', text: 'druga' },
        { id: 'a'.repeat(16), createdAt: 1_000, updatedAt: 1_000, source: 'voice', text: 'pierwsza' },
        { id: 'c'.repeat(16), createdAt: 3_000, updatedAt: 3_100, source: 'text', text: 'trzecia' },
      ]);
      expect(readNotes(dataDir, project)).toEqual({
        text: 'pierwsza\n\ndruga\n\ntrzecia',
        // Wersja dokumentu to NAJWIĘKSZY znacznik z wpisów — inaczej migracja cofałaby wersję
        // i klient ze starym `updatedAt` nadpisałby sklejony tekst „zgodnie z kontraktem".
        updatedAt: 3_100,
      });
    });

    it('ODCZYT niczego nie zapisuje — nowy kształt ląduje dopiero przy pierwszej mutacji', async () => {
      const path = await writeOldShape([
        { id: 'a'.repeat(16), createdAt: 1, updatedAt: 1, source: 'text', text: 'stara' },
      ]);
      const before = await readFile(path, 'utf8');
      readNotes(dataDir, project);
      expect(await readFile(path, 'utf8')).toBe(before);

      const doc = readNotes(dataDir, project);
      writeNotes(dataDir, project, `${doc.text}\n\ndopisane`, doc.updatedAt);
      const after = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      expect(after.notes).toBeUndefined();
      expect(after.text).toBe('stara\n\ndopisane');
    });

    it('wpis bez `id` i `source` też przeżywa — migracja nie sądzi treści po metadanych', () => {
      expect(mergeLegacyNotes([
        { createdAt: 2, text: 'druga' },
        { text: 'bez znacznika czasu' },
        { createdAt: 1, updatedAt: 9, text: 'pierwsza' },
      ])).toEqual({
        // Wpis bez `createdAt` idzie na KONIEC („nie wiem kiedy" nie znaczy „najstarsze").
        text: 'pierwsza\n\ndruga\n\nbez znacznika czasu',
        updatedAt: 9,
      });
    });

    it('pusta i połamana tablica dają pusty dokument, a nie śmieci w polu', () => {
      expect(mergeLegacyNotes([])).toEqual({ text: '', updatedAt: 0 });
      expect(mergeLegacyNotes([null, { text: '' }, { text: 42 }, 'x']))
        .toEqual({ text: '', updatedAt: 0 });
      expect(mergeLegacyNotes('nie tablica')).toEqual({ text: '', updatedAt: 0 });
    });
  });
});

describe('killswitch RAROG_NOTES', () => {
  it('brak wartości = WŁĄCZONE; `0`/`false` gasi', () => {
    expect(parseNotesEnabled(undefined)).toBe(true);
    expect(parseNotesEnabled('')).toBe(true);
    expect(parseNotesEnabled('1')).toBe(true);
    expect(parseNotesEnabled('0')).toBe(false);
    expect(parseNotesEnabled('false')).toBe(false);
  });

  it('demo ma notatki jak poza demo (w pamięci procesu), `RAROG_NOTES=0` gasi je i tam', () => {
    expect(loadConfig({ RAROG_DEMO: '1' }).notesEnabled).toBe(true);
    expect(loadConfig({ RAROG_DEMO: '1', RAROG_NOTES: '0' }).notesEnabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

describe('demo/notes — magazyn w pamięci procesu (testy UI apki)', () => {
  it('zasiew: notatka w projekcie `rarog`, inne projekty puste; `withNotes` odsiewa duplikaty', () => {
    const notes = createDemoNotes(demoContentPl, () => 1_000);
    expect(notes.read(DEMO_NOTE_CWD)).toEqual({ text: demoContentPl.noteText, updatedAt: DEMO_NOTE_UPDATED_AT });
    expect(notes.read(`${DEMO_PROJECTS_ROOT}/willow`)).toEqual({ text: '', updatedAt: 0 });
    expect(notes.withNotes([DEMO_NOTE_CWD, DEMO_NOTE_CWD, `${DEMO_PROJECTS_ROOT}/willow`])).toEqual([DEMO_NOTE_CWD]);
  });

  it('wersjonowanie jak w magazynie plikowym: stara wersja to `conflict` z aktualnym dokumentem', () => {
    let clock = DEMO_NOTE_UPDATED_AT - 5;
    const notes = createDemoNotes(demoContentPl, () => clock);
    // Zegar „za" wersją zasiewu: wersja i tak rośnie (`prev + 1`), jak w `writeNotes`.
    const saved = notes.write(DEMO_NOTE_CWD, 'nowa', DEMO_NOTE_UPDATED_AT);
    expect(saved).toEqual({ text: 'nowa', updatedAt: DEMO_NOTE_UPDATED_AT + 1 });
    clock = DEMO_NOTE_UPDATED_AT + 100;
    let caught: unknown;
    try {
      notes.write(DEMO_NOTE_CWD, 'spóźniona', DEMO_NOTE_UPDATED_AT);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NotesFailure);
    expect((caught as NotesFailure).code).toBe('conflict');
    expect((caught as NotesFailure).current).toEqual(saved);
  });

  it('`writeRemote` zapisuje bez warunku wersji, `reset` wraca do zasiewu', () => {
    const notes = createDemoNotes(demoContentPl, () => DEMO_NOTE_UPDATED_AT + 50);
    expect(notes.writeRemote(DEMO_NOTE_CWD, 'z iPhone\'a').updatedAt).toBe(DEMO_NOTE_UPDATED_AT + 50);
    notes.write(DEMO_NOTE_CWD, '', DEMO_NOTE_UPDATED_AT + 50);
    expect(notes.withNotes([DEMO_NOTE_CWD])).toEqual([]);
    notes.reset();
    expect(notes.read(DEMO_NOTE_CWD).text).toBe(demoContentPl.noteText);
  });
});

describe('/api/notes — kontrakt HTTP', () => {
  let h: Harness;
  beforeEach(async () => { h = await startHarness(); });
  afterEach(async () => { await h.close(); });

  const get = (cwd: string): Promise<Response> =>
    fetch(`${h.base}/api/notes?cwd=${encodeURIComponent(cwd)}`, { headers: { Authorization: h.auth } });

  const put = (body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
    fetch(`${h.base}/api/notes`, {
      method: 'PUT',
      headers: { Origin: ORIGIN, Authorization: h.auth, 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  const save = async (text: string, updatedAt: number): Promise<number> => {
    const res = await put({ cwd: h.project, text, updatedAt });
    expect(res.status).toBe(200);
    const parsed = notesPutResponseSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    return parsed.success ? parsed.data.updatedAt : 0;
  };

  it('bez klucza urządzenia obie czynności to 401', async () => {
    const paths: [string, RequestInit][] = [
      [`/api/notes?cwd=${encodeURIComponent(h.project)}`, {}],
      ['/api/notes', { method: 'PUT', headers: { Origin: ORIGIN }, body: '{}' }],
    ];
    for (const [path, init] of paths) {
      expect((await fetch(`${h.base}${path}`, init)).status).toBe(401);
    }
  });

  it('PUT bez nagłówka Origin odpada na bramce CSRF', async () => {
    const res = await fetch(`${h.base}/api/notes`, {
      method: 'PUT',
      headers: { Authorization: h.auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: h.project, text: 'x', updatedAt: 0 }),
    });
    expect(res.status).toBe(403);
  });

  it('POST i DELETE już nie istnieją — zostaje 405 z listą metod', async () => {
    for (const method of ['POST', 'DELETE'] as const) {
      const res = await fetch(`${h.base}/api/notes`, {
        method,
        headers: { Origin: ORIGIN, Authorization: h.auth, 'Content-Type': 'application/json' },
        ...(method === 'POST' ? { body: '{}' } : {}),
      });
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('GET, PUT');
    }
  });

  it('ścieżki z `:id` nie ma — stary adres kończy się 404, a nie edycją czegokolwiek', async () => {
    const res = await fetch(`${h.base}/api/notes/0123456789abcdef`, {
      method: 'POST',
      headers: { Origin: ORIGIN, Authorization: h.auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: h.project, text: 'x', updatedAt: 0 }),
    });
    expect(res.status).toBe(404);
  });

  it('katalog spoza korzeni to 400 `cwd-not-allowed`, a nie pusty dokument', async () => {
    const res = await get('/etc');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('cwd-not-allowed');
    // Bez `cwd` w ogóle — `path.resolve('')` byłoby katalogiem SERWERA, więc to też 400.
    expect((await fetch(`${h.base}/api/notes`, { headers: { Authorization: h.auth } })).status).toBe(400);
  });

  it('pełny cykl: pusto → zapisz → odczytaj → nadpisz → wyczyść', async () => {
    const empty: unknown = await (await get(h.project)).json();
    expect(notesGetResponseSchema.safeParse(empty).success).toBe(true);
    expect(empty).toEqual({ text: '', updatedAt: 0 });

    const v1 = await save('deploy wymaga restartu herdr', 0);
    expect(await (await get(h.project)).json())
      .toEqual({ text: 'deploy wymaga restartu herdr', updatedAt: v1 });

    const v2 = await save('deploy: `pnpm run deploy`', v1);
    expect(v2).toBeGreaterThan(v1);

    const v3 = await save('', v2);
    expect(await (await get(h.project)).json()).toEqual({ text: '', updatedAt: v3 });
  });

  it('zapis z nieaktualnym `updatedAt` to 409 z AKTUALNĄ treścią w ciele', async () => {
    const v1 = await save('przed', 0);
    await save('z iPada', v1);
    const res = await put({ cwd: h.project, text: 'z telefonu', updatedAt: v1 });
    expect(res.status).toBe(409);
    const body: unknown = await res.json();
    const parsed = notesConflictBodySchema.safeParse(body);
    expect(parsed.success).toBe(true);
    expect((body as { current: NotesDoc }).current.text).toBe('z iPada');
    // Odrzucony zapis nie zostawia ani śladu — na dysku dalej stoi wersja z drugiego urządzenia.
    expect(((await (await get(h.project)).json()) as NotesDoc).text).toBe('z iPada');
  });

  it('każdy ZAPIS rozsyła ulotny `notes` z katalogiem i bitem `empty`; GET nie rozsyła nic', async () => {
    const v1 = await save('x', 0);
    const v2 = await save('y', v1);
    // Skasowanie treści (także do samego białego znaku) = `empty: true` → pigułka ✎ gaśnie.
    await save('  \n', v2);
    const before = h.events.length;
    await get(h.project);
    expect(h.events.length).toBe(before);

    const notes = h.events.filter((ev) => ev.type === 'notes');
    expect(notes).toHaveLength(3);
    expect(notes).toEqual([
      { type: 'notes', cwd: h.project, empty: false },
      { type: 'notes', cwd: h.project, empty: false },
      { type: 'notes', cwd: h.project, empty: true },
    ]);
    // Treści w ramce nie ma — bit to jedyne, co event mówi o dokumencie.
    for (const ev of notes) expect(JSON.stringify(ev)).not.toContain('"text"');
  });

  it('ODRZUCONY zapis (409) nie rozsyła eventu — nic się przecież nie zmieniło', async () => {
    const v1 = await save('x', 0);
    await save('y', v1);
    const before = h.events.length;
    expect((await put({ cwd: h.project, text: 'z', updatedAt: v1 })).status).toBe(409);
    expect(h.events.length).toBe(before);
  });

  it('tekst ponad sufit to 400 z bramki ciała, nie ucięty dokument', async () => {
    const res = await put({ cwd: h.project, text: 'x'.repeat(NOTES_MAX_CHARS + 1), updatedAt: 0 });
    expect(res.status).toBe(400);
    expect(await (await get(h.project)).json()).toEqual({ text: '', updatedAt: 0 });
  });

  it('dokument W GRANICACH sufitu przechodzi, także po polsku (UTF-8 to nie znaki)', async () => {
    // Sedno `NOTES_BODY_MAX_BYTES`: „ę" waży dwa bajty, więc dokument w granicach kontraktu
    // odbijałby się od globalnych 64 kB jako 413 — czyli odmową bez zdania o powodzie.
    const res = await put({ cwd: h.project, text: 'ę'.repeat(NOTES_MAX_CHARS), updatedAt: 0 });
    expect(res.status).toBe(200);
  });

  it('brak `updatedAt` w ciele to 400 — bez wersji nie ma czym wykryć rozjazdu', async () => {
    expect((await put({ cwd: h.project, text: 'x' })).status).toBe(400);
  });

  it('treść notatek nie trafia do logu serwera', async () => {
    await save('hasło do bazy leży w 1password', 0);
    expect(h.logs.join('\n')).not.toContain('1password');
  });

  it('`GET /api/version` mówi `notesEnabled: true`', async () => {
    const res = await fetch(`${h.base}/api/version`, { headers: { Authorization: h.auth } });
    expect(((await res.json()) as { notesEnabled: boolean }).notesEnabled).toBe(true);
  });
});

describe('/api/notes przy RAROG_NOTES=0', () => {
  let h: Harness;
  beforeEach(async () => { h = await startHarness(false); });
  afterEach(async () => { await h.close(); });

  it('obie ścieżki oddają 404 i nic nie ląduje na dysku', async () => {
    const list = await fetch(`${h.base}/api/notes?cwd=${encodeURIComponent(h.project)}`, {
      headers: { Authorization: h.auth },
    });
    expect(list.status).toBe(404);
    const write = await fetch(`${h.base}/api/notes`, {
      method: 'PUT',
      headers: { Origin: ORIGIN, Authorization: h.auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: h.project, text: 'x', updatedAt: 0 }),
    });
    expect(write.status).toBe(404);
    await expect(stat(join(h.dataDir, NOTES_DIRNAME))).rejects.toThrow();
  });

  it('`GET /api/version` mówi `notesEnabled: false` — apka nie pokazuje żadnego wejścia', async () => {
    const res = await fetch(`${h.base}/api/version`, { headers: { Authorization: h.auth } });
    expect(((await res.json()) as { notesEnabled: boolean }).notesEnabled).toBe(false);
  });
});
