/**
 * `alive.json` trybu cienia po stronie serwera (`server/src/herdr/dialogs/shadow/alive.ts`): zapis atomowy, lista
 * sesji, rytm 10 s, `mode: "off"` przy zatrzymaniu, porażka zapisu bez wyjątku, `markers: true` tylko z opcją serwera
 * z kanałem zgód i trybem `main`. Dziennik przejść `alive.jsonl` (`alive-log.ts`): linia tylko przy przejściu, kształt,
 * prawa, ponowienie po porażce. Kształt pliku musi przejść ten sam test, którym hook decyduje o czekaniu (`aliveVeto`
 * w `scripts/hooks/rarog-pending.mjs`): wszystkie pola obecne i właściwego typu. Opis: `docs/dialogs.md`, „Server in
 * shadow mode”.
 */
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  ALIVE_SESSIONS_MAX, ALIVE_WRITE_INTERVAL_MS, aliveSessions, createAliveWriter, writeAliveFile,
} from '../src/herdr/dialogs/shadow/alive.ts';
import {
  ALIVE_LOG_FILENAME, ALIVE_LOG_QUEUE_MAX, parseAliveLog, sameAliveState,
} from '../src/herdr/dialogs/shadow/alive-log.ts';
import type { AliveLogLine } from '../src/herdr/dialogs/shadow/alive-log.ts';
import { HOOK_ALIVE_FILENAME, HOOK_CHANNEL_MODE_MAIN } from '../src/herdr/dialogs/hook/contract.ts';
import type { HookAliveFile, HookChannelMode } from '../src/herdr/dialogs/hook/contract.ts';

const S1 = '550e8400-e29b-41d4-a716-446655440000';
const S2 = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const S3 = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  vi.useRealTimers();
});

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rarog-alive-'));
  dirs.push(dir);
  return dir;
}

function readAlive(dir: string): HookAliveFile {
  return JSON.parse(readFileSync(join(dir, HOOK_ALIVE_FILENAME), 'utf8')) as HookAliveFile;
}

describe('alive.json: kształt i lista sesji', { timeout: 5_000 }, () => {
  it('lista sesji: tylko poprawne identyfikatory, bez powtórzeń, posortowana, z sufitem', () => {
    expect(aliveSessions([S2, S1, S2, '', '../etc', 'a b'])).toEqual([S1, S2]);
    const many = Array.from({ length: ALIVE_SESSIONS_MAX + 10 }, (_, i) => `s-${String(i).padStart(4, '0')}`);
    expect(aliveSessions(many)).toHaveLength(ALIVE_SESSIONS_MAX);
  });

  it('zapis atomowy: komplet pól, prawa 0600, żadnego pliku tymczasowego obok', () => {
    const dir = dataDir();
    expect(writeAliveFile(dir, { ts: 1, bootId: 'b', mode: 'shadow', send: true, sessions: [S1] })).toBe(true);
    expect(readAlive(dir)).toEqual({ ts: 1, bootId: 'b', mode: 'shadow', send: true, sessions: [S1] });
    expect(readdirSync(dir)).toEqual([HOOK_ALIVE_FILENAME]);
  });

  it('nieudany zapis oddaje `false`, nie rzuca', () => {
    const dir = dataDir();
    // Plik zwykły w miejscu katalogu danych: `mkdir` i `open` padają.
    const blocked = join(dir, 'zajete');
    writeFileSync(blocked, 'x');
    expect(writeAliveFile(blocked, { ts: 1, bootId: 'b', mode: 'off', send: true, sessions: [] })).toBe(false);
  });
});

describe('alive.json: pisarz serwera', { timeout: 5_000 }, () => {
  it('start pisze od razu, potem co 10 s; sesja zamknięta znika przy następnym zapisie', () => {
    vi.useFakeTimers();
    const dir = dataDir();
    let sessions = [S1, S2];
    let clock = 1_000;
    const writer = createAliveWriter({
      dataDir: dir, mode: 'shadow', send: () => true, bootId: 'boot-1', sessions: () => sessions, now: () => clock,
    });
    writer.start();
    expect(readAlive(dir)).toEqual({ ts: 1_000, bootId: 'boot-1', mode: 'shadow', send: true, sessions: [S1, S2] });
    sessions = [S2];
    clock = 11_000;
    vi.advanceTimersByTime(ALIVE_WRITE_INTERVAL_MS);
    expect(readAlive(dir)).toMatchObject({ ts: 11_000, sessions: [S2] });
    writer.stop();
  });

  it('tryb `off` też pisze plik: hook dowiaduje się z niego, że ma nie czekać', () => {
    const dir = dataDir();
    const writer = createAliveWriter({
      dataDir: dir, mode: 'off', send: () => true, bootId: 'boot-2', sessions: () => [S1],
    });
    writer.start();
    expect(readAlive(dir)).toMatchObject({ mode: 'off', sessions: [S1], bootId: 'boot-2' });
    writer.stop();
  });

  it('`send` czytany przy każdym zapisie (killswitch `RAROG_HERDR_SEND`)', () => {
    const dir = dataDir();
    let send = true;
    const writer = createAliveWriter({
      dataDir: dir, mode: 'shadow', send: () => send, bootId: 'b', sessions: () => [S1],
    });
    writer.start();
    expect(readAlive(dir).send).toBe(true);
    send = false;
    writer.writeNow();
    expect(readAlive(dir).send).toBe(false);
    writer.stop();
  });

  it('stop pisze `mode: "off"` z pustą listą i zatrzymuje rytm', () => {
    vi.useFakeTimers();
    const dir = dataDir();
    const writer = createAliveWriter({
      dataDir: dir, mode: 'shadow', send: () => true, bootId: 'boot-3', sessions: () => [S1], now: () => 5,
    });
    writer.start();
    writer.stop();
    expect(readAlive(dir)).toEqual({ ts: 5, bootId: 'boot-3', mode: 'off', send: true, sessions: [] });
    // Po stopie żaden tik nie przywraca `shadow`.
    vi.advanceTimersByTime(ALIVE_WRITE_INTERVAL_MS * 3);
    expect(readAlive(dir).mode).toBe('off');
    expect(writer.writeNow()).toBe(false);
  });

  it('`markers: true` tylko z opcją `markers` i trybem `main`; przy `shadow`, `off`, po stopie i bez opcji pola nie ma,'
    + ' a dziennik przejść go nie niesie', () => {
    const dir = dataDir();
    let mode: HookChannelMode = HOOK_CHANNEL_MODE_MAIN;
    const writer = createAliveWriter({
      dataDir: dir, mode: () => mode, send: () => true, bootId: 'boot-m', sessions: () => [S1], markers: true,
      now: () => 7,
    });
    writer.start();
    expect(readAlive(dir)).toEqual({ ts: 7, bootId: 'boot-m', mode: 'main', send: true, sessions: [S1], markers: true });
    mode = 'shadow';
    writer.writeNow();
    expect(readAlive(dir)).toEqual({ ts: 7, bootId: 'boot-m', mode: 'shadow', send: true, sessions: [S1] });
    mode = 'off';
    writer.writeNow();
    expect(readAlive(dir)).toEqual({ ts: 7, bootId: 'boot-m', mode: 'off', send: true, sessions: [S1] });
    mode = HOOK_CHANNEL_MODE_MAIN;
    writer.writeNow();
    expect(readAlive(dir).markers).toBe(true);
    writer.stop();
    expect(readAlive(dir)).toEqual({ ts: 7, bootId: 'boot-m', mode: 'off', send: true, sessions: [] });
    expect(readLog(dir).map((line) => Object.keys(line).includes('markers'))).toEqual([false, false, false, false, false]);

    const plain = dataDir();
    const without = createAliveWriter({
      dataDir: plain, mode: HOOK_CHANNEL_MODE_MAIN, send: () => true, bootId: 'boot-p', sessions: () => [S1], now: () => 8,
    });
    without.start();
    expect(readAlive(plain)).toEqual({ ts: 8, bootId: 'boot-p', mode: 'main', send: true, sessions: [S1] });
    without.stop();
  });

  it('wyjątek listy sesji = zapis z pustą listą; porażka zapisu idzie do logu raz, powrót też raz', () => {
    const dir = dataDir();
    const lines: string[] = [];
    const target = join(dir, 'dane');
    mkdirSync(target);
    let fail = true;
    const writer = createAliveWriter({
      dataDir: target, mode: 'shadow', send: () => true, bootId: 'b',
      sessions: () => { if (fail) throw new Error('nadzorca'); return [S1]; },
      log: (line) => { lines.push(line); },
    });
    writer.start();
    expect(readAlive(target).sessions).toEqual([]);
    fail = false;
    chmodSync(target, 0o500);
    try {
      expect(writer.writeNow()).toBe(false);
      expect(writer.writeNow()).toBe(false);
    } finally {
      chmodSync(target, 0o700);
    }
    expect(writer.writeNow()).toBe(true);
    expect(readAlive(target).sessions).toEqual([S1]);
    expect(lines).toEqual([
      'shadow: failed to write alive.json — the hook will not wait',
      'shadow: alive.json written again',
    ]);
    writer.stop();
  });
});

/*
 * A new session reaches `alive.json` at once, not with the next 10 s tick: a hook whose session is not on the list
 * leaves without the consent channel, so the tick would send the first request of a new session to the terminal.
 * A session that left waits for the tick.
 */
describe('alive.json: sessions changed', { timeout: 5_000 }, () => {
  it('published list empty, current list not → written now', () => {
    const dir = dataDir();
    let sessions: string[] = [];
    let clock = 1_000;
    const writer = createAliveWriter({
      dataDir: dir, mode: 'all', send: () => true, bootId: 'b', sessions: () => sessions, now: () => clock,
    });
    writer.start();
    expect(readAlive(dir)).toMatchObject({ ts: 1_000, sessions: [] });
    sessions = [S1];
    clock = 1_050;
    expect(writer.sessionsChanged()).toBe(true);
    expect(readAlive(dir)).toMatchObject({ ts: 1_050, sessions: [S1] });
    writer.stop();
  });

  it('a session joins a published list → written now with the current list, also when another one left', () => {
    const dir = dataDir();
    let sessions = [S1];
    let clock = 1_000;
    const writer = createAliveWriter({
      dataDir: dir, mode: 'all', send: () => true, bootId: 'b', sessions: () => sessions, now: () => clock,
    });
    writer.start();
    sessions = [S1, S2];
    clock = 1_050;
    expect(writer.sessionsChanged()).toBe(true);
    expect(readAlive(dir)).toMatchObject({ ts: 1_050, sessions: [S1, S2] });
    // The same list again: a signal that brings no new session writes nothing.
    clock = 1_075;
    expect(writer.sessionsChanged()).toBe(false);
    expect(readAlive(dir)).toMatchObject({ ts: 1_050 });
    sessions = [S2, S3];
    clock = 1_100;
    expect(writer.sessionsChanged()).toBe(true);
    expect(readAlive(dir)).toMatchObject({ ts: 1_100, sessions: [S2, S3] });
    writer.stop();
  });

  it('a session leaves and none joins → nothing written now, the tick writes the shorter list', () => {
    vi.useFakeTimers();
    const dir = dataDir();
    let sessions = [S1, S2];
    let clock = 1_000;
    const writer = createAliveWriter({
      dataDir: dir, mode: 'all', send: () => true, bootId: 'b', sessions: () => sessions, now: () => clock,
    });
    writer.start();
    sessions = [S1];
    clock = 1_050;
    expect(writer.sessionsChanged()).toBe(false);
    expect(readAlive(dir)).toMatchObject({ ts: 1_000, sessions: [S1, S2] });
    clock = 11_000;
    vi.advanceTimersByTime(ALIVE_WRITE_INTERVAL_MS);
    expect(readAlive(dir)).toMatchObject({ ts: 11_000, sessions: [S1] });
    writer.stop();
  });

  it('a failed write does not count as published: the next signal writes the new session', () => {
    const dir = dataDir();
    let sessions = [S1];
    let clock = 1_000;
    let sendFails = false;
    const writer = createAliveWriter({
      dataDir: dir, mode: 'all', bootId: 'b', sessions: () => sessions, now: () => clock,
      send: () => { if (sendFails) throw new Error('send unreadable'); return true; },
    });
    writer.start();
    sessions = [S1, S2];
    sendFails = true;
    expect(writer.sessionsChanged()).toBe(false);
    expect(readAlive(dir)).toMatchObject({ ts: 1_000, sessions: [S1] });
    sendFails = false;
    clock = 1_050;
    expect(writer.sessionsChanged()).toBe(true);
    expect(readAlive(dir)).toMatchObject({ ts: 1_050, sessions: [S1, S2] });
    writer.stop();
  });

  it('still empty → nothing written; before start and after stop → nothing written', () => {
    const dir = dataDir();
    let sessions: string[] = [];
    const writer = createAliveWriter({
      dataDir: dir, mode: 'all', send: () => true, bootId: 'b', sessions: () => sessions, now: () => 7,
    });
    sessions = [S1];
    expect(writer.sessionsChanged()).toBe(false);
    expect(existsSync(join(dir, HOOK_ALIVE_FILENAME))).toBe(false);
    sessions = [];
    writer.start();
    expect(writer.sessionsChanged()).toBe(false);
    writer.stop();
    sessions = [S1];
    expect(writer.sessionsChanged()).toBe(false);
    expect(readAlive(dir)).toMatchObject({ mode: 'off', sessions: [] });
  });
});

function readLog(dir: string): AliveLogLine[] {
  const parsed = parseAliveLog(readFileSync(join(dir, ALIVE_LOG_FILENAME), 'utf8'));
  expect(parsed.skipped).toBe(0);
  return parsed.lines;
}

describe('alive.jsonl: dziennik przejść', { timeout: 5_000 }, () => {
  it('linia tylko przy przejściu: start, zmiana send i listy sesji, stop; ten sam stan co 10 s nic nie dopisuje', () => {
    vi.useFakeTimers();
    const dir = dataDir();
    let sessions = [S1];
    let send = true;
    let clock = 1_000;
    const writer = createAliveWriter({
      dataDir: dir, mode: 'shadow', send: () => send, bootId: 'boot-log', sessions: () => sessions, now: () => clock,
    });
    writer.start();
    for (let i = 0; i < 3; i += 1) {
      clock += ALIVE_WRITE_INTERVAL_MS;
      vi.advanceTimersByTime(ALIVE_WRITE_INTERVAL_MS);
    }
    // Ta sama lista w innej kolejności to ten sam stan.
    sessions = [S2, S1];
    clock = 50_000;
    writer.writeNow();
    sessions = [S1, S2];
    writer.writeNow();
    send = false;
    clock = 60_000;
    writer.writeNow();
    clock = 70_000;
    writer.stop();
    expect(readLog(dir)).toEqual([
      { at: 1_000, ev: 'start', bootId: 'boot-log', mode: 'shadow', send: true, sessions: [S1] },
      { at: 50_000, ev: 'zmiana', bootId: 'boot-log', mode: 'shadow', send: true, sessions: [S1, S2] },
      { at: 60_000, ev: 'zmiana', bootId: 'boot-log', mode: 'shadow', send: false, sessions: [S1, S2] },
      { at: 70_000, ev: 'stop', bootId: 'boot-log', mode: 'off', send: false, sessions: [] },
    ]);
    // `at` linii to `ts` zapisu `alive.json`, który hook przeczytał.
    expect(readAlive(dir).ts).toBe(70_000);
    expect(statSync(join(dir, ALIVE_LOG_FILENAME)).mode & 0o777).toBe(0o600);
  });

  it('tryb `off` też ma linię `start`; drugi proces dopisuje swoje linie pod swoim bootId', () => {
    const dir = dataDir();
    const first = createAliveWriter({ dataDir: dir, mode: 'off', send: () => true, bootId: 'b1', sessions: () => [] });
    first.start();
    first.stop();
    const second = createAliveWriter({
      dataDir: dir, mode: 'shadow', send: () => true, bootId: 'b2', sessions: () => [S1],
    });
    second.start();
    second.stop();
    expect(readLog(dir).map((line) => [line.bootId, line.ev, line.mode])).toEqual([
      ['b1', 'start', 'off'], ['b1', 'stop', 'off'], ['b2', 'start', 'shadow'], ['b2', 'stop', 'off'],
    ]);
  });

  it('nieudane dopisanie: linia czeka z pierwotnym `at` i idzie w kolejności, także powrót stanu sprzed porażki', () => {
    const dir = dataDir();
    const lines: string[] = [];
    // Katalog w miejscu dziennika: `appendFileSync` pada, `alive.json` obok zapisuje się normalnie.
    mkdirSync(join(dir, ALIVE_LOG_FILENAME));
    let clock = 1;
    let sessions = [S1];
    const writer = createAliveWriter({
      dataDir: dir, mode: 'shadow', send: () => true, bootId: 'b', sessions: () => sessions, now: () => clock,
      log: (line) => { lines.push(line); },
    });
    writer.start();
    expect(readAlive(dir).ts).toBe(1);
    // Sesja znika i wraca, zanim dziennik znowu przyjmie linię: oba przejścia czekają, żadne nie przepada.
    sessions = [];
    clock = 2;
    expect(writer.writeNow()).toBe(true);
    sessions = [S1];
    clock = 3;
    writer.writeNow();
    rmSync(join(dir, ALIVE_LOG_FILENAME), { recursive: true });
    clock = 4;
    writer.writeNow();
    expect(readLog(dir)).toEqual([
      { at: 1, ev: 'start', bootId: 'b', mode: 'shadow', send: true, sessions: [S1] },
      { at: 2, ev: 'zmiana', bootId: 'b', mode: 'shadow', send: true, sessions: [] },
      { at: 3, ev: 'zmiana', bootId: 'b', mode: 'shadow', send: true, sessions: [S1] },
    ]);
    expect(lines).toEqual([
      'shadow: failed to append alive.jsonl — the line waits in the queue',
      'shadow: alive.jsonl appended again',
    ]);
    // `alive.json` nie wszedł: hook go nie widział, więc i dziennik milczy.
    chmodSync(dir, 0o500);
    try {
      clock = 5;
      sessions = [];
      expect(writer.writeNow()).toBe(false);
    } finally {
      chmodSync(dir, 0o700);
    }
    clock = 6;
    writer.stop();
    expect(readLog(dir).map((line) => [line.ev, line.at])).toEqual([['start', 1], ['zmiana', 2], ['zmiana', 3], ['stop', 6]]);
  });

  it('przepełniona kolejka wyrzuca najstarsze linie, a pierwsza dopisana niesie `luka: true`', () => {
    const dir = dataDir();
    const lines: string[] = [];
    mkdirSync(join(dir, ALIVE_LOG_FILENAME));
    let clock = 1;
    let sessions = [S1];
    const writer = createAliveWriter({
      dataDir: dir, mode: 'shadow', send: () => true, bootId: 'b', sessions: () => sessions, now: () => clock,
      log: (line) => { lines.push(line); },
    });
    writer.start();
    // Start i jeszcze `ALIVE_LOG_QUEUE_MAX + 4` przejść: pięć najstarszych linii nie mieści się w kolejce.
    for (let i = 0; i < ALIVE_LOG_QUEUE_MAX + 4; i += 1) {
      clock += 1;
      sessions = sessions.length === 0 ? [S1] : [];
      writer.writeNow();
    }
    rmSync(join(dir, ALIVE_LOG_FILENAME), { recursive: true });
    writer.writeNow();
    const log = readLog(dir);
    expect(log).toHaveLength(ALIVE_LOG_QUEUE_MAX);
    expect(log[0]).toMatchObject({ at: 6, ev: 'zmiana', luka: true });
    expect(log.slice(1).some((line) => line.luka === true)).toBe(false);
    expect(log.at(-1)?.at).toBe(clock);
    expect(lines).toEqual([
      'shadow: failed to append alive.jsonl — the line waits in the queue',
      'shadow: alive.jsonl queue overflowed — gap in the transition history',
      'shadow: alive.jsonl appended again',
    ]);
    writer.stop();
  });

  it('stop przy nieudanym zapisie alive.json i tak opróżnia kolejkę dziennika, bez linii stop', () => {
    const dir = dataDir();
    mkdirSync(join(dir, ALIVE_LOG_FILENAME));
    let clock = 1;
    const writer = createAliveWriter({
      dataDir: dir, mode: 'shadow', send: () => true, bootId: 'b', sessions: () => [S1], now: () => clock,
    });
    writer.start();
    rmSync(join(dir, ALIVE_LOG_FILENAME), { recursive: true });
    // Dziennik znowu przyjmuje linie, a `alive.json` nie da się podmienić (katalog w jego miejscu).
    rmSync(join(dir, HOOK_ALIVE_FILENAME));
    mkdirSync(join(dir, HOOK_ALIVE_FILENAME));
    clock = 2;
    writer.stop();
    expect(readLog(dir)).toEqual([{ at: 1, ev: 'start', bootId: 'b', mode: 'shadow', send: true, sessions: [S1] }]);
  });

  it('czytnik: zła linia (nie JSON, nieznane `ev` albo `mode`, brak pola) pominięta i policzona; stany jako zbiory', () => {
    const good = { at: 1, ev: 'zmiana', bootId: 'b', mode: 'shadow', send: true, sessions: [S1] };
    const gap = { ...good, at: 2, luka: true };
    const text = [
      '{"at":', JSON.stringify(good), '[]', JSON.stringify({ ...good, ev: 'tik' }), JSON.stringify({ ...good, mode: 'wszystko' }),
      JSON.stringify({ ...good, sessions: [1] }), JSON.stringify({ ...good, bootId: '' }), '', JSON.stringify(gap),
      JSON.stringify({ ...good, luka: false }),
    ].join('\n');
    // Położenie złej linii: `at` sąsiednich dobrych (audyt wie, czy mogła ukrywać przejście w oknie).
    const middle = { after: 1, before: 2 };
    expect(parseAliveLog(text)).toEqual({
      lines: [good, gap], skipped: 7,
      skippedAt: [{ after: null, before: 1 }, middle, middle, middle, middle, middle, { after: 2, before: null }],
    });
    expect(sameAliveState({ mode: 'shadow', send: true, sessions: [S1, S2] }, { mode: 'shadow', send: true, sessions: [S2, S1] }))
      .toBe(true);
    expect(sameAliveState({ mode: 'shadow', send: true, sessions: [S1, S1] }, { mode: 'shadow', send: true, sessions: [S1, S2] }))
      .toBe(false);
    expect(existsSync(join(dataDir(), ALIVE_LOG_FILENAME))).toBe(false);
  });
});
