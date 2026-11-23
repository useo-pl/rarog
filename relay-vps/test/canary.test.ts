/**
 * Kanarek relaya `scripts/relay-canary.mjs`: czyste części bez sieci (klucze z sekretu, werdykt transferu,
 * argumenty). Przebieg na żywo idzie z CI (workflow kanarka) albo ręcznie.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeTransfer, judgeTransfer, parseKeys } from '../../scripts/relay-canary.mjs';

const CANARY = path.resolve(import.meta.dirname, '..', '..', 'scripts', 'relay-canary.mjs');
const KEY_A = '0a'.repeat(32);
const KEY_B = '0b'.repeat(32);

describe('relay-canary.mjs: klucze z RELAY_CANARY_KEYS', () => {
  it('pusty sekret = brak kluczy (kroki z kluczami mówią „skipped”), dwa klucze hex = bajty', () => {
    expect(parseKeys(undefined)).toEqual({ keys: [] });
    expect(parseKeys('  ')).toEqual({ keys: [] });
    const res = parseKeys(` ${KEY_A.toUpperCase()} , ${KEY_B}`);
    expect(res.keys).toHaveLength(2);
    expect(res.keys?.[0]).toEqual(Array(32).fill(0x0a));
  });

  it('jeden klucz, trzy albo zły hex = błąd bez wartości klucza w komunikacie', () => {
    for (const raw of [KEY_A, `${KEY_A},${KEY_B},${KEY_A}`, `${KEY_A},xyz`]) {
      const res = parseKeys(raw);
      expect(res.error).toMatch(/two keys of 64 hex characters/);
      expect(res.error).not.toContain('0a0a');
    }
  });
});

describe('relay-canary.mjs: werdykt kroku `rate`', () => {
  const ok = { bytes: 60_000_000, burstMs: 1640, totalMs: 15_370 };
  it('całość 14–18 s (burst 16 MB, potem 3 MB/s); szybkość klienta bez znaczenia, byle ponad 4,5 MB/s', () => {
    expect(judgeTransfer(ok)).toBeNull();
    // Nadawca i odbiorca w jednym procesie na VPS relaya: ok. 4,8 MB/s na starcie, całość 15,3 s.
    expect(judgeTransfer({ ...ok, burstMs: 3318, totalMs: 15_281 })).toBeNull();
    expect(judgeTransfer({ ...ok, totalMs: 6000 })).toMatch(/the rx limit does not work/);
    expect(judgeTransfer({ ...ok, burstMs: 1640, totalMs: 20_100 })).toMatch(/no 16 MB burst/);
    expect(judgeTransfer({ ...ok, burstMs: 5333, totalMs: 20_000 })).toMatch(/client or network too slow/);
    // Stałe 4 MB/s bez limitu i bez burstu: 15 s mieści się w oknie, ale pomiar nie odróżnia limitu od sieci.
    expect(judgeTransfer({ ...ok, burstMs: 4000, totalMs: 15_000 })).toMatch(/measurement invalid/);
    // Klient 4,5 MB/s bez limitu kończy w 13,3 s, więc wypada jako brak limitu, nie jako zaliczenie.
    expect(judgeTransfer({ ...ok, burstMs: 3556, totalMs: 13_333 })).toMatch(/the rx limit does not work/);
    expect(judgeTransfer({ ...ok, bytes: 59_000_000 })).toMatch(/received 59000000/);
  });

  it('opis transferu: czasy i tempo obu części', () => {
    expect(describeTransfer(ok)).toBe('60 MB in 15370 ms; first 16 MB in 1640 ms (9.76 MB/s), rest 3.20 MB/s');
  });
});

describe('relay-canary.mjs: argumenty', () => {
  it.each([
    [['--inny'], {}, 'unknown argument --inny'],
    [[], { RELAY_CANARY_MODE: 'open' }, 'RELAY_CANARY_MODE must be shadow or enforce'],
    [[], { RELAY_CANARY_KEYS: KEY_A }, 'RELAY_CANARY_KEYS: expected two keys'],
  ])('%j %j: kod 2 bez sieci', (args, env, message) => {
    const res = spawnSync(process.execPath, [CANARY, ...args], {
      encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...env }, timeout: 10_000,
    });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain(message);
  });
});
