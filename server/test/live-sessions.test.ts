/**
 * Czytnik żywych sesji CLI (`claude agents --json`).
 *
 * Testy chodzą na PODMIENIONYM wejściu — żaden z nich nie uruchamia procesu. Sprawdzają to,
 * co w tym module jest nasze: parsowanie, pamięć podręczną i — najważniejsze — że awaria
 * znaczy „NIE WIEM", a nie „nic nie żyje". Ta różnica jest bramką przed dwoma pisarzami do
 * jednego pliku jsonl, więc ma własny test w obie strony.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  claudeCommand, createLiveSessionsReader, liveSessionsEnv, parseLiveSessions,
} from '../src/live-sessions.ts';

const OUTPUT = JSON.stringify([
  { id: '08924336', sessionId: '08924336-8d9a-4d02-a4b0-9de0457c5253', kind: 'background',
    cwd: '/Users/x/Projects/y', state: 'blocked' },
  { id: 'e3b1a670', sessionId: 'e3b1a670-6028-4cc6-985f-200ebf63afb8', kind: 'interactive',
    cwd: '/Users/x/Projects/z' },
]);

describe('parseLiveSessions', () => {
  it('bierze same identyfikatory sesji', () => {
    expect(parseLiveSessions(OUTPUT)).toEqual(new Set([
      '08924336-8d9a-4d02-a4b0-9de0457c5253',
      'e3b1a670-6028-4cc6-985f-200ebf63afb8',
    ]));
  });

  it('pusta tablica to PUSTO (wiemy, że nic nie żyje) — nie to samo co „nie wiem"', () => {
    expect(parseLiveSessions('[]')).toEqual(new Set());
  });

  it('śmieci na wyjściu to „nie wiem", nigdy wyjątek', () => {
    expect(parseLiveSessions('to nie json')).toBeNull();
    expect(parseLiveSessions('{"sessions":[]}')).toBeNull();
    expect(parseLiveSessions('')).toBeNull();
  });

  it('wpis bez identyfikatora pomija, reszty nie psuje', () => {
    expect(parseLiveSessions(JSON.stringify([{ cwd: '/x' }, { sessionId: 'a' }, null, 7])))
      .toEqual(new Set(['a']));
  });
});

describe('createLiveSessionsReader', () => {
  it('awaria komendy to „nie wiem" (null), a nie pusty zbiór', async () => {
    const read = createLiveSessionsReader({ probe: () => Promise.reject(new Error('ENOENT')) });
    expect(await read()).toBeNull();
  });

  it('trzyma wynik przez TTL i odświeża po jego upływie', async () => {
    let now = 1_000;
    const probe = vi.fn(async () => OUTPUT);
    const read = createLiveSessionsReader({ probe, ttlMs: 5_000, now: () => now });

    await read();
    await read();
    expect(probe).toHaveBeenCalledTimes(1);

    now += 5_001;
    await read();
    expect(probe).toHaveBeenCalledTimes(2);
  });

  /* Wejście na ekran potrafi odpalić kilka odczytów naraz, a każdy z nich to osobny proces. */
  it('równoległe wywołania dzielą JEDNO uruchomienie komendy', async () => {
    const probe = vi.fn(async () => OUTPUT);
    const read = createLiveSessionsReader({ probe });
    await Promise.all([read(), read(), read()]);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  /*
   * Nieudany odczyt jest zapamiętywany KRÓTKO i celowo: ponowienie i tak nie oddałoby wiedzy,
   * a kosztowałoby pełny timeout przy każdej próbie wznowienia (bramka pyta `fresh`). Po
   * upływie `failTtlMs` pytamy normalnie — awaria programu `claude` nie może być stanem trwałym.
   */
  it('„nie wiem" milknie na krótko, a potem próbuje znowu', async () => {
    let now = 1_000;
    let fail = true;
    const probe = vi.fn(async () => {
      if (fail) throw new Error('padło');
      return OUTPUT;
    });
    const read = createLiveSessionsReader({ probe, ttlMs: 60_000, failTtlMs: 1_000, now: () => now });

    expect(await read()).toBeNull();
    fail = false;
    // W oknie ciszy komenda NIE jest wołana drugi raz.
    expect(await read()).toBeNull();
    expect(probe).toHaveBeenCalledTimes(1);

    now += 1_001;
    expect(await read()).not.toBeNull();
    expect(probe).toHaveBeenCalledTimes(2);
  });

  /*
   * Bramka przed dwoma pisarzami czyta ŚWIEŻO: pięć sekund starych danych wystarczy,
   * żeby przepuścić wznowienie sesji, która ruszyła w międzyczasie w gołym tmuxie.
   */
  it('`fresh` omija pamięć podręczną wyniku udanego', async () => {
    const probe = vi.fn(async () => OUTPUT);
    const read = createLiveSessionsReader({ probe, ttlMs: 60_000 });
    await read();
    await read();
    expect(probe).toHaveBeenCalledTimes(1);
    await read({ fresh: true });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('env potomka jest zamknięty — sekrety Raroga nie wchodzą do `claude`', () => {
    const env = liveSessionsEnv({
      HOME: '/Users/x', PATH: '/usr/bin', LANG: 'pl_PL.UTF-8',
      SONIOX_API_KEY: 'sekret',
      // Kanał APNs: ścieżka klucza i Key ID też są w env serwera — i też nie przechodzą.
      RAROG_APNS_KEY_PATH: '/Users/x/.secrets.d/klucz', RAROG_APNS_KEY_ID: 'ABC123DEFG',
    });
    expect(Object.keys(env).sort()).toEqual(['HOME', 'LANG', 'PATH']);
  });
});

/*
 * Under launchd the server's `PATH` has no `~/.local/bin`, so a bare `claude` would end in ENOENT and the reader would
 * ALWAYS answer "don't know": a restart on a new Claude Code would refuse and the second resume gate would stay silent.
 * The native installer is called by its full path.
 */
describe('claudeCommand', () => {
  it('bierze binarkę instalatora natywnego z pełnej ścieżki, gdy istnieje', () => {
    const bin = '/Users/x/.local/bin/claude';
    expect(claudeCommand(bin, (path) => path === bin)).toBe(bin);
  });

  it('bez niej wraca do `claude` z PATH (instalacja z npm)', () => {
    expect(claudeCommand('/Users/x/.local/bin/claude', () => false)).toBe('claude');
  });
});
