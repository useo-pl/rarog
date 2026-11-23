/**
 * Serwer mówi o nowej wersji (obserwator `server/src/version-watch.ts`): plik `<dataDir>/versions-seen.json`,
 * jedna linia `server.log` na każdą nową wartość i jeden push `version-changed` na paczkę zmian.
 *
 * Źródła wersji: odczyt Claude Code co 30 s (`observeCliVersions` na czytniku z `cli-version.ts`, tu na prawdziwym
 * dowiązaniu w katalogu tymczasowym) i walidowany `ping` herdr na ticku resyncu (przypadek z nadzorcą:
 * `herdr-supervisor.test.ts`, „wersja herdr na ticku resyncu”). Push idzie atrapą wysyłki: ten plik nie dotyka APNs.
 * Ramka banera, którą dekoduje apka, to złota ramka `shared/fixtures/apns-v3/alert.version-changed.v3.json`.
 */
import {
  lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCliVersionReader } from '../src/cli-version.ts';
import type { TimerHandle } from '../src/drivers/runtime.ts';
import { MESSAGE_MAX_CHARS, buildVersionContent } from '../src/notify/content.ts';
import type { PushContent, SendOutcome } from '../src/notify/content.ts';
import {
  VERSIONS_SEEN_FILENAME, VERSION_PUSH_SETTLE_MS, createVersionWatch, observeCliVersions,
} from '../src/version-watch.ts';
import type { VersionWatch } from '../src/version-watch.ts';

/** Zegar wirtualny: timer okna sklejania zmian odpala `advance`. */
class FakeScheduler {
  #now = 0;
  #seq = 0;
  readonly #timers = new Map<number, { at: number; fn: () => void }>();

  setTimeout(fn: () => void, ms: number): TimerHandle {
    this.#seq += 1;
    this.#timers.set(this.#seq, { at: this.#now + ms, fn });
    return this.#seq;
  }

  clearTimeout(handle: TimerHandle): void {
    this.#timers.delete(handle as number);
  }

  advance(ms: number): void {
    const target = this.#now + ms;
    for (;;) {
      const due = [...this.#timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      this.#timers.delete(due[0]);
      this.#now = due[1].at;
      due[1].fn();
    }
    this.#now = target;
  }
}

interface Harness {
  watch: VersionWatch;
  scheduler: FakeScheduler;
  pushes: PushContent[];
  logs: string[];
  /** Obserwacje przetworzone, okno sklejania minęło, zapis i push skończone. */
  settle(): Promise<void>;
}

let dir = '';
const harnesses: VersionWatch[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rarog-wersje-'));
});

afterEach(() => {
  for (const watch of harnesses.splice(0)) watch.dispose();
  rmSync(dir, { recursive: true, force: true });
});

function harness(outcome: SendOutcome = 'delivered'): Harness {
  const scheduler = new FakeScheduler();
  const pushes: PushContent[] = [];
  const logs: string[] = [];
  const watch = createVersionWatch({
    dataDir: dir,
    scheduler,
    log: (line) => { logs.push(line); },
    send: (content) => {
      pushes.push(content);
      return Promise.resolve(outcome);
    },
  });
  harnesses.push(watch);
  return {
    watch, scheduler, pushes, logs,
    settle: async () => {
      await watch.idle();
      scheduler.advance(VERSION_PUSH_SETTLE_MS);
      await watch.idle();
    },
  };
}

const file = (): string => join(dir, VERSIONS_SEEN_FILENAME);
const seen = (): unknown => JSON.parse(readFileSync(file(), 'utf8'));
const seed = (versions: Record<string, string>): void => {
  writeFileSync(file(), `${JSON.stringify({ format: 1, versions })}\n`, { mode: 0o600 });
};

describe('wersje widziane: pierwszy start, restart, null', () => {
  it('pierwszy start bez pliku: zapis obu wersji, zero pushy i zero linii', async () => {
    const h = harness();
    h.watch.observe('claude-code', '2.1.321');
    h.watch.observe('herdr', '0.9.5');
    await h.settle();
    expect(seen()).toEqual({ format: 1, versions: { 'claude-code': '2.1.321', herdr: '0.9.5' } });
    expect(statSync(file()).mode & 0o777).toBe(0o600);
    expect(h.pushes).toEqual([]);
    expect(h.logs).toEqual([]);
  });

  it('restart z tą samą wersją: zero pushy, zero linii, plik nietknięty', async () => {
    const first = harness();
    first.watch.observe('claude-code', '2.1.321');
    first.watch.observe('herdr', '0.9.5');
    await first.settle();
    first.watch.dispose();
    const inode = statSync(file()).ino;

    const second = harness();
    second.watch.observe('claude-code', '2.1.321');
    second.watch.observe('herdr', '0.9.5');
    await second.settle();
    expect(second.pushes).toEqual([]);
    expect(second.logs).toEqual([]);
    expect(statSync(file()).ino).toBe(inode);
  });

  it('`null`, brak wersji i wersja spoza wzorca: plik bez zmian, zero pushy', async () => {
    seed({ 'claude-code': '2.1.321', herdr: '0.9.5' });
    const before = readFileSync(file(), 'utf8');
    const inode = statSync(file()).ino;
    const h = harness();
    h.watch.observe('claude-code', null);
    h.watch.observe('herdr', undefined);
    h.watch.observe('herdr', 'v 0.9.6; rm -rf');
    h.watch.observe('claude-code', '2.1.321');
    await h.settle();
    expect(readFileSync(file(), 'utf8')).toBe(before);
    expect(statSync(file()).ino).toBe(inode);
    expect(h.pushes).toEqual([]);
    expect(h.logs).toEqual([]);
  });

  it.each([
    ['nie-JSON', 'versions{'],
    ['zły kształt', JSON.stringify({ format: 1, versions: { herdr: 42 } })],
    ['inny format', JSON.stringify({ format: 2, versions: { herdr: '0.9.5' } })],
  ])('zepsuty plik (%s): zapis od nowa bez pushu i jedna linia w logu', async (_name, broken) => {
    writeFileSync(file(), broken);
    const h = harness();
    h.watch.observe('claude-code', '2.1.322');
    h.watch.observe('herdr', '0.9.6');
    await h.settle();
    expect(seen()).toEqual({ format: 1, versions: { 'claude-code': '2.1.322', herdr: '0.9.6' } });
    expect(h.pushes).toEqual([]);
    expect(h.logs).toEqual(['versions: versions-seen.json unreadable — starting over without a push']);
  });

  it('dowiązanie pod nazwą pliku: nieczytelny, cel nietknięty, w miejsce dowiązania plik zwykły', async () => {
    const target = join(dir, 'cel.json');
    writeFileSync(target, JSON.stringify({ format: 1, versions: { 'claude-code': '2.1.300' } }));
    symlinkSync(target, file());
    const h = harness();
    h.watch.observe('claude-code', '2.1.322');
    await h.settle();
    expect(lstatSync(file()).isSymbolicLink()).toBe(false);
    expect(seen()).toEqual({ format: 1, versions: { 'claude-code': '2.1.322' } });
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ format: 1, versions: { 'claude-code': '2.1.300' } });
    expect(h.pushes).toEqual([]);
    expect(h.logs).toEqual(['versions: versions-seen.json unreadable — starting over without a push']);
  });
});

describe('nowa wersja: jeden push i jedna linia na wartość', () => {
  it('zmiana wersji Claude Code w atrapie dowiązania: jeden push i jedna linia', async () => {
    const home = join(dir, 'home');
    const versions = join(home, '.local', 'share', 'claude', 'versions');
    const bin = join(home, '.local', 'bin');
    mkdirSync(versions, { recursive: true });
    mkdirSync(bin, { recursive: true });
    mkdirSync(join(home, '.claude', 'sessions'), { recursive: true });
    writeFileSync(join(versions, '2.1.321'), '');
    writeFileSync(join(versions, '2.1.322'), '');
    const link = join(bin, 'claude');
    symlinkSync(join(versions, '2.1.321'), link);

    const h = harness();
    const reader = observeCliVersions(
      createCliVersionReader({ binLink: link, registryDir: join(home, '.claude', 'sessions') }), h.watch,
    );
    expect((await reader()).installed).toBe('2.1.321');
    await h.settle();
    expect(h.pushes).toEqual([]);

    // Instalator przestawia dowiązanie; szybki tik rejestru (`registryOnly`) dowiązania nie czyta.
    unlinkSync(link);
    symlinkSync(join(versions, '2.1.322'), link);
    await reader({ registryOnly: true });
    expect((await reader()).installed).toBe('2.1.322');
    await reader();
    await h.settle();

    expect(h.pushes).toHaveLength(1);
    expect(h.pushes[0]).toMatchObject({
      kind: 'version-changed',
      title: '🔄 Version changed',
      titleRef: { code: 'push.version-title' },
      body: 'Claude Code 2.1.321 → 2.1.322',
      bodyRef: { code: 'push.version-body.claude-code', args: ['2.1.321', '2.1.322'] },
    });
    expect(h.logs).toEqual(['versions: Claude Code 2.1.321 → 2.1.322 (push: delivered)']);
    expect(seen()).toEqual({ format: 1, versions: { 'claude-code': '2.1.322' } });
  });

  it('jednoczesna zmiana Claude Code i herdr: jeden push z obiema, linia na każdą', async () => {
    seed({ 'claude-code': '2.1.321', herdr: '0.9.5' });
    const h = harness();
    h.watch.observe('claude-code', '2.1.322');
    h.watch.observe('herdr', '0.9.6');
    await h.settle();
    expect(h.pushes).toHaveLength(1);
    expect(h.pushes[0]).toMatchObject({
      kind: 'version-changed',
      body: 'Claude Code 2.1.321 → 2.1.322, herdr 0.9.5 → 0.9.6',
      bodyRef: { code: 'push.version-body.both', args: ['2.1.321', '2.1.322', '0.9.5', '0.9.6'] },
    });
    expect(h.logs).toEqual([
      'versions: Claude Code 2.1.321 → 2.1.322 (push: delivered)',
      'versions: herdr 0.9.5 → 0.9.6 (push: delivered)',
    ]);
    expect(seen()).toEqual({ format: 1, versions: { 'claude-code': '2.1.322', herdr: '0.9.6' } });
  });

  it('downgrade: jeden push', async () => {
    seed({ 'claude-code': '2.1.322', herdr: '0.9.5' });
    const h = harness();
    h.watch.observe('claude-code', '2.1.321');
    h.watch.observe('herdr', '0.9.5');
    await h.settle();
    expect(h.pushes).toHaveLength(1);
    expect(h.pushes[0]).toMatchObject({ body: 'Claude Code 2.1.322 → 2.1.321' });
    expect(h.logs).toEqual(['versions: Claude Code 2.1.322 → 2.1.321 (push: delivered)']);
  });

  it('kolejne odczyty tej samej nowej wersji w oknie i po nim: dalej jeden push', async () => {
    seed({ herdr: '0.9.5' });
    const h = harness();
    h.watch.observe('herdr', '0.9.6');
    h.watch.observe('herdr', '0.9.6');
    await h.settle();
    h.watch.observe('herdr', '0.9.6');
    await h.settle();
    expect(h.pushes).toHaveLength(1);
    expect(h.logs).toHaveLength(1);
  });

  it('brak odbiorcy albo błąd wysyłki: linia mówi wynik, plik zapisany, następny odczyt bez pushu', async () => {
    seed({ herdr: '0.9.5' });
    const h = harness('no-receiver');
    h.watch.observe('herdr', '0.9.6');
    await h.settle();
    expect(h.logs).toEqual(['versions: herdr 0.9.5 → 0.9.6 (push: no-receiver)']);
    expect(seen()).toEqual({ format: 1, versions: { herdr: '0.9.6' } });

    const throwing = createVersionWatch({
      dataDir: dir, log: () => {}, send: () => Promise.reject(new Error('sink')), settleMs: 0,
    });
    harnesses.push(throwing);
    throwing.observe('herdr', '0.9.7');
    await throwing.idle();
    await new Promise<void>((resolve) => { setTimeout(resolve, 5); });
    await throwing.idle();
    expect(seen()).toEqual({ format: 1, versions: { herdr: '0.9.7' } });
  });

  it('nieudany zapis po pushu: następny odczyt tej samej wersji zapisuje plik bez pushu, restart nie powtarza', async () => {
    seed({ herdr: '0.9.5' });
    const h = harness();
    h.watch.observe('herdr', '0.9.5');
    await h.watch.idle();
    // Katalog pod nazwą pliku stanu: `rename` pliku tymczasowego pada (awaria dysku w miniaturze).
    rmSync(file());
    mkdirSync(file());
    h.watch.observe('herdr', '0.9.6');
    await h.settle();
    expect(h.pushes).toHaveLength(1);
    expect(h.logs).toContainEqual(expect.stringMatching(/^versions: versions-seen\.json not written \(/u));
    rmSync(file(), { recursive: true });
    h.watch.observe('herdr', '0.9.6');
    await h.settle();
    expect(seen()).toEqual({ format: 1, versions: { herdr: '0.9.6' } });
    expect(h.pushes).toHaveLength(1);

    const restart = harness();
    restart.watch.observe('herdr', '0.9.6');
    await restart.settle();
    expect(restart.pushes).toEqual([]);
  });

  it('pierwszy start z przesuniętymi odczytami: okno liczy się od pierwszej zmiany, wspólna aktualizacja = jeden push', async () => {
    const h = harness();
    h.watch.observe('herdr', '0.9.5');
    await h.watch.idle();
    h.scheduler.advance(1_000);
    h.watch.observe('claude-code', '2.1.321');
    await h.watch.idle();
    // Oba programy zaktualizowane w t≈30,5 s; odczyty przychodzą w t=31 s (herdr) i t=60 s (Claude Code).
    h.scheduler.advance(30_000);
    h.watch.observe('herdr', '0.9.6');
    await h.watch.idle();
    h.scheduler.advance(29_000);
    await h.watch.idle();
    h.watch.observe('claude-code', '2.1.322');
    await h.settle();
    expect(h.pushes).toHaveLength(1);
    expect(h.pushes[0]?.body).toContain('herdr 0.9.5 → 0.9.6');
    expect(h.pushes[0]?.body).toContain('Claude Code 2.1.321 → 2.1.322');
  });
});

describe('treść pushu `version-changed`', () => {
  it('bez sesji, pilny, doba w APNs; treść z kodem mieści się na banerze przy najdłuższych wersjach', () => {
    const long = '12345678901234567890';
    const content = buildVersionContent([
      { product: 'claude-code', from: long, to: long },
      { product: 'herdr', from: long, to: long },
    ]);
    expect(content).toMatchObject({ kind: 'version-changed', urgency: 'high', ttl: 24 * 60 * 60 });
    expect('sessionId' in content).toBe(false);
    expect(content.badge).toBeUndefined();
    expect(content.body.length).toBeLessThanOrEqual(MESSAGE_MAX_CHARS);
    expect(content.bodyRef?.code).toBe('push.version-body.both');
    expect(buildVersionContent([{ product: 'herdr', from: '0.9.5', to: '0.9.6' }])).toMatchObject({
      body: 'herdr 0.9.5 → 0.9.6', bodyRef: { code: 'push.version-body.herdr', args: ['0.9.5', '0.9.6'] },
    });
  });
});
