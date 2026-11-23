/**
 * Które projekty MAJĄ notatkę — bit w ramce `sessions-snapshot` (ikona notatki w wierszu
 * projektu w sidebarze).
 *
 * Dlaczego ramka, a nie nowa trasa: sidebar pokazuje kilkanaście wierszy naraz, a dotychczasowa
 * droga do tego bitu (`GET /api/notes?cwd=`, sonda paska pigułek) odpowiada o JEDEN katalog.
 * Ramka startowa jedzie i tak, zna komplet katalogów i otwiera się kilkadziesiąt razy dziennie
 * (iOS zrywa SSE przy każdym uśpieniu) — czyli dokładnie wtedy, kiedy ten bit jest potrzebny.
 *
 * Dwie rzeczy pod testem: liczenie (`projectsWithNotes` — co jest notatką, a co pustką) i to,
 * że killswitch `RAROG_NOTES` gasi całe pole, a nie zostawia pustej obietnicy.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerEvent } from '@rarog/shared';
import { PROTOCOL_VERSION, parseServerEvent } from '@rarog/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NOTES_DIRNAME, projectsWithNotes, writeNotes } from '../src/notes/store.ts';
import { SseHub, type SseResponse } from '../src/sse.ts';
import { FakeManager, makeSummary } from './fake-manager.ts';

let dataDir = '';
let projects: string[] = [];

/** Katalog projektu MUSI istnieć: klucz pliku notatek to `sha256(realpath(cwd))`. */
function project(name: string): string {
  const path = join(dataDir, 'projekty', name);
  mkdirSync(path, { recursive: true });
  projects.push(path);
  return path;
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'rarog-notatki-'));
  projects = [];
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('projectsWithNotes — jeden bit na katalog, zero treści', () => {
  it('wymienia katalogi z niepustym dokumentem, pomija resztę', () => {
    const zNotatka = project('rarog');
    const bezNotatki = project('ember');
    writeNotes(dataDir, zNotatka, 'deploy wymaga restartu herdr', 0);
    expect(projectsWithNotes(dataDir, [zNotatka, bezNotatki])).toEqual([zNotatka]);
  });

  /*
   * Pustkę liczy `notesEmpty` z kontraktu — ta sama definicja, którą niesie bit `empty`
   * w evencie `notes`. Gdyby serwer liczył ją tutaj po swojemu, ikona gasłaby po zapisie
   * i zapalała się po reconnekcie dla tego samego dokumentu.
   */
  it('sam biały znak to wciąż BRAK notatki', () => {
    const cwd = project('rarog');
    writeNotes(dataDir, cwd, '\n  \n', 0);
    expect(projectsWithNotes(dataDir, [cwd])).toEqual([]);
  });

  it('katalog bez pliku notatek nie jest błędem — po prostu go nie ma na liście', () => {
    expect(projectsWithNotes(dataDir, [project('swiezy')])).toEqual([]);
  });

  /** Dwie sesje w jednym katalogu dają ten sam `cwd` dwa razy — wynik ma go wymienić RAZ. */
  it('duplikaty na wejściu schodzą z wyjścia', () => {
    const cwd = project('rarog');
    writeNotes(dataDir, cwd, 'jedna notatka', 0);
    expect(projectsWithNotes(dataDir, [cwd, cwd, cwd])).toEqual([cwd]);
  });

  /*
   * Katalog skasowany z dysku (a wciąż na liście projektów z historii CLI) rzuca w `realpath`.
   * Lista sesji nie ma prawa zginąć przez notatki, więc taki katalog po prostu wypada.
   */
  it('katalog, którego nie ma, nie przewraca liczenia', () => {
    const zyje = project('rarog');
    writeNotes(dataDir, zyje, 'żyje', 0);
    const duch = join(dataDir, 'projekty', 'duch');
    expect(projectsWithNotes(dataDir, [duch, zyje])).toEqual([zyje]);
  });

  it('pliki notatek leżą w `<dataDir>/notes/` — ta ścieżka jest cytowana w runbooku', () => {
    const cwd = project('rarog');
    writeNotes(dataDir, cwd, 'x', 0);
    expect(NOTES_DIRNAME).toBe('notes');
    expect(projectsWithNotes(join(dataDir, 'inny-katalog-danych'), [cwd])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Ramka startowa
// ---------------------------------------------------------------------------

/** Minimalna atrapa odpowiedzi SSE — interesuje nas wyłącznie ramka `sessions-snapshot`. */
class FakeRes implements SseResponse {
  chunks: string[] = [];

  writeHead(): unknown {
    return this;
  }

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  end(): unknown {
    return this;
  }

  on(): unknown {
    return this;
  }

  /** Wszystkie sparsowane ramki w kolejności wysyłki. */
  events(): ServerEvent[] {
    const out: ServerEvent[] = [];
    for (const raw of this.chunks.join('').split('\n\n')) {
      const data = /^data: (.*)$/m.exec(raw);
      const event = data === null ? null : parseServerEvent(data[1] ?? '');
      if (event !== null) out.push(event);
    }
    return out;
  }

  snapshot(): Extract<ServerEvent, { type: 'sessions-snapshot' }> {
    for (const event of this.events()) if (event.type === 'sessions-snapshot') return event;
    throw new Error('brak ramki sessions-snapshot');
  }

  /** OSTATNIA ramka danego typu — testy „co przyszło po evencie z managera". */
  last<T extends ServerEvent['type']>(type: T): Extract<ServerEvent, { type: T }> | null {
    const hits = this.events().filter((e): e is Extract<ServerEvent, { type: T }> => e.type === type);
    return hits.at(-1) ?? null;
  }
}

describe('ramka `sessions-snapshot` niesie katalogi z notatką', () => {
  const RAROG = '/tmp/rarog-demo/rarog';
  const WILLOW = '/tmp/rarog-demo/willow';

  function hub(
    notesFor?: (cwds: readonly string[]) => readonly string[],
  ): { hub: SseHub; manager: FakeManager } {
    const manager = new FakeManager([
      makeSummary({ id: 'a', cwd: RAROG, title: 'rarog' }),
      makeSummary({ id: 'b', cwd: WILLOW, title: 'willow' }),
      // Druga sesja tego samego projektu — katalog ma pojawić się w ramce RAZ.
      makeSummary({ id: 'c', cwd: RAROG, title: 'rarog' }),
    ]);
    const created = new SseHub({
      manager, serverStartId: 'start-1', protocolVersion: PROTOCOL_VERSION, heartbeatMs: 0,
      ...(notesFor === undefined ? {} : { notesFor }),
    });
    created.start();
    return { hub: created, manager };
  }

  it('pyta o katalogi Z TEJ RAMKI i oddaje odpowiedź polem `notesCwds`', () => {
    const pytania: readonly string[][] = [];
    const res = new FakeRes();
    hub((cwds) => {
      (pytania as string[][]).push([...cwds]);
      return cwds.filter((cwd) => cwd === RAROG);
    }).hub.openGlobal(res);

    expect(res.snapshot().notesCwds).toEqual([RAROG]);
    /*
     * Katalogi idą z listy sesji — nie ma tu skanu katalogu notatek ani żadnego innego źródła.
     * BEZ POWTÓRZEŃ: trzecia sesja stoi w katalogu pierwszej, a pytanie jest o katalog
     * i kosztuje odczyt z dysku.
     */
    expect(pytania[0]).toEqual([RAROG, WILLOW]);
  });

  /*
   * PUSTA TABLICA jest odpowiedzią, nie brakiem odpowiedzi: klient gasi nią ikony zapalone
   * przed reconnectem (notatka skasowana na drugim urządzeniu, gdy telefon spał).
   */
  it('żaden projekt bez notatki = pole PUSTE, a nie nieobecne', () => {
    const res = new FakeRes();
    hub(() => []).hub.openGlobal(res);
    const snapshot = res.snapshot();
    expect('notesCwds' in snapshot).toBe(true);
    expect(snapshot.notesCwds).toEqual([]);
  });

  /*
   * KILLSWITCH `RAROG_NOTES=0`: `index.ts` nie podaje wtedy funkcji, więc pola NIE MA —
   * a klient odróżnia „nie wiemy" od „nie ma" i nie rysuje ani jednej ikony.
   */
  it('wyłączone notatki nie zostawiają w ramce żadnego pola', () => {
    const res = new FakeRes();
    hub().hub.openGlobal(res);
    expect('notesCwds' in res.snapshot()).toBe(false);
  });

  /*
   * Powyższy test mówi o HUBIE („bez funkcji nie ma pola"), a bramka stoi w `bootstrap/sse.ts` — więc
   * bez tej asercji uproszczenie spreadu na bezwarunkowe `notesFor` zostawiłoby komplet testów
   * na zielono, a `RAROG_NOTES=0` zacząłby po cichu wysyłać `notesCwds`.
   * Skan źródła, a nie start serwera: bramka jest jedną linijką składania, nie zachowaniem HTTP.
   */
  it('to `bootstrap/sse.ts` trzyma bramkę: `notesFor` wchodzi TYLKO pod `config.notesEnabled`', () => {
    const source = readFileSync(join(import.meta.dirname, '..', 'src', 'bootstrap', 'sse.ts'), 'utf8');
    const at = source.indexOf('notesFor:');
    expect(at, 'wstrzyknięcie `notesFor` w `bootstrap/sse.ts`').toBeGreaterThan(-1);
    // Jedno wstrzyknięcie, jedna bramka — i warunek stoi w TYM SAMYM wyrażeniu, tuż przed nim.
    expect(source.indexOf('notesFor:', at + 1)).toBe(-1);
    expect(source.slice(Math.max(0, at - 120), at)).toContain('config.notesEnabled');
  });
});

// ---------------------------------------------------------------------------
// Ramki PO starcie: snapshot z managera i nowy katalog w strumieniu
// ---------------------------------------------------------------------------

/**
 * The notes bit must come with every snapshot, not only the one from `openGlobal`:
 *
 * 1. a snapshot emitted by the manager (session close) without the field would make a client,
 *    which reads "no field" as a disabled killswitch, clear every icon;
 * 2. a session in a project that was not on the list would get no bit at all, and the icon
 *    would wait for a reconnect or the pill bar probe.
 */
describe('bit o notatkach po otwarciu strumienia', () => {
  const RAROG = '/tmp/rarog-demo/rarog';
  const NOWY = '/tmp/rarog-demo/nowy';

  /** Hub z jedną sesją i licznikiem pytań o notatki — wołany ZAWSZE przez `openGlobal`. */
  function live(withNotes: readonly string[], enabled = true): {
    hub: SseHub; manager: FakeManager; res: FakeRes; pytania: string[][];
  } {
    const manager = new FakeManager([makeSummary({ id: 'a', cwd: RAROG, title: 'rarog' })]);
    const pytania: string[][] = [];
    const notesFor = (cwds: readonly string[]): readonly string[] => {
      pytania.push([...cwds]);
      return cwds.filter((cwd) => withNotes.includes(cwd));
    };
    const hub = new SseHub({
      manager, serverStartId: 'start-1', protocolVersion: PROTOCOL_VERSION, heartbeatMs: 0,
      ...(enabled ? { notesFor } : {}),
    });
    hub.start();
    const res = new FakeRes();
    hub.openGlobal(res);
    return { hub, manager, res, pytania };
  }

  it('snapshot Z MANAGERA (zamknięta sesja) też niesie pole, więc nie gasi ikon', () => {
    const { manager, res } = live([RAROG]);
    manager.emit('global', null, { type: 'sessions-snapshot', sessions: manager.list() });
    const last = res.last('sessions-snapshot');
    expect(last?.notesCwds).toEqual([RAROG]);
  });

  it('NOWY katalog w `session-changed` dostaje event `notes` z bitem', () => {
    const { manager, res, pytania } = live([NOWY]);
    manager.emit('global', null, {
      type: 'session-changed', session: makeSummary({ id: 'b', cwd: NOWY, title: 'nowy' }),
    });
    expect(res.last('notes')).toEqual({ type: 'notes', cwd: NOWY, empty: false });
    // Odczyt dotyczy JEDNEGO katalogu — ramka startowa pytała o `RAROG`, ta o `NOWY`.
    expect(pytania).toEqual([[RAROG], [NOWY]]);
  });

  /*
   * Odczyt z dysku ma lecieć RAZ na katalog: `session-changed` przychodzi kilkanaście razy
   * na minutę pracującej sesji (zmiana stanu, aktywność, model).
   */
  it('znany katalog nie kosztuje ani odczytu, ani ramki', () => {
    const { manager, res, pytania } = live([RAROG]);
    manager.emit('global', null, {
      type: 'session-changed', session: makeSummary({ id: 'a', cwd: RAROG, state: 'waiting-input' }),
    });
    manager.emit('global', null, {
      type: 'session-changed', session: makeSummary({ id: 'a', cwd: RAROG, state: 'running' }),
    });
    expect(res.last('notes')).toBeNull();
    expect(pytania).toEqual([[RAROG]]);
  });

  /** Powtórka nowego katalogu: bit leci raz, druga ramka już go nie powtarza. */
  it('drugi `session-changed` w tym samym nowym katalogu nie powtarza odczytu', () => {
    const { manager, res, pytania } = live([]);
    for (const state of ['starting', 'running'] as const) {
      manager.emit('global', null, {
        type: 'session-changed', session: makeSummary({ id: 'b', cwd: NOWY, state }),
      });
    }
    expect(res.events().filter((e) => e.type === 'notes')).toHaveLength(1);
    expect(pytania).toEqual([[RAROG], [NOWY]]);
  });

  /** Killswitch `RAROG_NOTES=0`: nie ma funkcji, więc nie ma ani odczytu, ani ramki `notes`. */
  it('wyłączone notatki nie rozgłaszają bitu dla nowego katalogu', () => {
    const { manager, res } = live([NOWY], false);
    manager.emit('global', null, {
      type: 'session-changed', session: makeSummary({ id: 'b', cwd: NOWY }),
    });
    expect(res.last('notes')).toBeNull();
    expect('notesCwds' in res.snapshot()).toBe(false);
  });
});
