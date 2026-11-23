import { randomBytes } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CLIENT_LOG_MAX_BYTES,
  appendClientLog,
  clearReviewClientLogs,
  clientLogPath,
  clientTag,
} from '../src/client-log.ts';
import { type RarogConfig, loadConfig } from '../src/config.ts';

let dir: string;
let config: RarogConfig;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'rarog-test-'));
  config = loadConfig({ RAROG_DEMO: '1', RAROG_DATA_DIR: dir });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('appendClientLog', () => {
  it('dopisuje NDJSON — jeden wiersz na zdarzenie', async () => {
    const written = await appendClientLog(config, [
      { at: '2026-08-21T10:00:00.000Z', level: 'error', msg: 'boom' },
      { at: '2026-08-21T10:00:01.000Z', level: 'info', msg: 'reconnect' },
    ], { now: () => new Date('2026-08-21T10:00:02.000Z') });

    expect(written).toBe(2);
    const lines = (await readFile(clientLogPath(config), 'utf8')).trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      at: '2026-08-21T10:00:00.000Z', level: 'error', msg: 'boom',
      receivedAt: '2026-08-21T10:00:02.000Z',
    });
  });

  it('znacznik klienta trafia do każdej linii paczki', async () => {
    await appendClientLog(config, [
      { at: 'a', level: 'debug', msg: 'natyw scena active' },
      { at: 'b', level: 'debug', msg: 'vp iw=1408' },
    ], { client: 'shell/0.1', now: () => new Date('2026-10-02T10:00:00.000Z') });
    const lines = (await readFile(clientLogPath(config), 'utf8')).trimEnd().split('\n');
    expect(lines.map((line) => (JSON.parse(line) as { client?: string }).client))
      .toEqual(['shell/0.1', 'shell/0.1']);
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      at: 'a', level: 'debug', msg: 'natyw scena active', client: 'shell/0.1',
      receivedAt: '2026-10-02T10:00:00.000Z',
    });
  });

  it('kolejne wywołania dopisują, nie nadpisują', async () => {
    await appendClientLog(config, [{ at: 'a', level: 'info', msg: 'raz' }]);
    await appendClientLog(config, [{ at: 'b', level: 'info', msg: 'dwa' }]);
    const content = await readFile(clientLogPath(config), 'utf8');
    expect(content.trimEnd().split('\n')).toHaveLength(2);
  });

  it('pusta paczka nie tworzy pliku', async () => {
    expect(await appendClientLog(config, [])).toBe(0);
    await expect(readFile(clientLogPath(config), 'utf8')).rejects.toThrow();
  });

  it('odrzuca paczkę powyżej 64 kB', async () => {
    await expect(appendClientLog(config, [
      { at: 'a', level: 'info', msg: 'x'.repeat(70_000) },
    ])).rejects.toThrow(/64 kB/);
  });

  it('pole `client` nie zjada limitu: paczka przyjmowana bez niego przechodzi i z nim', async () => {
    // 700 krótkich zdarzeń mieści się w 64 kB bez pola, a z polem `client` by go przekroczyło
    // (pomiar Codexa: 60 900 → 75 600 B).
    const events = Array.from({ length: 700 }, () => ({ at: 'a', level: 'info', msg: 'krótki wpis' }));
    await expect(appendClientLog(config, events, { client: 'shell/0.1' })).resolves.toBe(700);
  });

  it('rotuje plik po przekroczeniu limitu rozmiaru', async () => {
    const file = clientLogPath(config);
    await writeFile(file, 'x'.repeat(CLIENT_LOG_MAX_BYTES + 1), 'utf8');
    await appendClientLog(config, [{ at: 'a', level: 'info', msg: 'po rotacji' }]);

    expect(await readFile(`${file}.1`, 'utf8')).toHaveLength(CLIENT_LOG_MAX_BYTES + 1);
    expect(await readFile(file, 'utf8')).toContain('po rotacji');
  });
});

describe('clientTag', () => {
  const IPAD_PWA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';

  it('bez znacznika apki: etykieta urządzenia', () => {
    expect(clientTag(IPAD_PWA, 'Mac')).toBe('Mac');
    expect(clientTag(undefined, 'inne urządzenie')).toBe('inne urządzenie');
    expect(clientTag('', 'inne urządzenie')).toBe('inne urządzenie');
  });

  it('śmieci w buildzie są ucinane, pusty build nie jest apką', () => {
    expect(clientTag('RarogApp/42<script>alert(1)</script>', 'Mac')).toBe('app/42');
    expect(clientTag(`RarogApp/${'9'.repeat(40)}`, 'Mac')).toBe(`app/${'9'.repeat(16)}`);
    expect(clientTag('RarogApp/', 'Mac')).toBe('Mac');
  });

  it('dawny znacznik powłoki WKWebView nie daje własnego prefiksu', () => {
    expect(clientTag(`${IPAD_PWA} RarogShell/0.1`, 'Mac')).toBe('Mac');
  });

  it('natywna apka: numer builda z User-Agenta', () => {
    // URLSession dokleja własny ogon (CFNetwork, Darwin) — liczy się wyłącznie znacznik apki.
    expect(clientTag('RarogApp/42 CFNetwork/3896 Darwin/27.0.0', 'Mac')).toBe('app/42');
    expect(clientTag('RarogApp/1.0.7', 'iPhone')).toBe('app/1.0.7');
  });

  it('obcy znacznik w User-Agencie nie daje builda', () => {
    expect(clientTag('XRarogApp42', 'Mac')).toBe('Mac');
    expect(clientTag('OtherApp/42 CFNetwork/3896 Darwin/27.0.0', 'Mac')).toBe('Mac');
  });

  it('apka: śmieci ucinane, pusty build nie jest apką', () => {
    expect(clientTag('RarogApp/42"};alert(1)', 'Mac')).toBe('app/42');
    expect(clientTag(`RarogApp/${'7'.repeat(40)}`, 'Mac')).toBe(`app/${'7'.repeat(16)}`);
    expect(clientTag('RarogApp/', 'Mac')).toBe('Mac');
    expect(clientTag('RarogApp 42', 'Mac')).toBe('Mac');
  });
});

/*
 * Kasowanie `client.log` przy starcie trybu recenzji. `index.ts` woła funkcję przy każdym
 * starcie; decyzję „tylko tryb recenzji” podejmuje ona sama, więc zwykłe demo i serwer sprawdza się tutaj. Kod
 * recenzenta jest losowy w czasie biegu.
 */
describe('clearReviewClientLogs', () => {
  const TRESC = 'zdarzenie apki recenzenta';
  const recenzja = (): ReturnType<typeof loadConfig> => loadConfig({
    RAROG_DEMO: '1', RAROG_DATA_DIR: dir, RAROG_DEMO_REVIEW_CODE: randomBytes(32).toString('base64url'),
    RAROG_ORIGINS: 'https://demo.example',
  });
  const oba = async (): Promise<void> => {
    await writeFile(clientLogPath(config), TRESC, 'utf8');
    await writeFile(`${clientLogPath(config)}.1`, TRESC, 'utf8');
  };
  const istnieje = async (file: string): Promise<boolean> => access(file).then(() => true, () => false);

  it('tryb recenzji: kasuje `client.log` i `client.log.1`, zwraca ich nazwy', async () => {
    await oba();
    await expect(clearReviewClientLogs(recenzja())).resolves.toEqual(['client.log', 'client.log.1']);
    expect(await istnieje(clientLogPath(config))).toBe(false);
    expect(await istnieje(`${clientLogPath(config)}.1`)).toBe(false);
  });

  it('tryb recenzji: brak plików (`ENOENT`) to nic do zrobienia, także brak samego `client.log`', async () => {
    await expect(clearReviewClientLogs(recenzja())).resolves.toEqual([]);
    await writeFile(`${clientLogPath(config)}.1`, TRESC, 'utf8');
    await expect(clearReviewClientLogs(recenzja())).resolves.toEqual(['client.log.1']);
  });

  it('tryb recenzji: inny błąd kasowania rzuca zdaniem z nazwą pliku i kodem błędu, bez treści i ścieżki', async () => {
    await oba();
    const proby: string[] = [];
    const unlink = (file: string): Promise<void> => {
      proby.push(path.basename(file));
      return Promise.reject(Object.assign(new Error(`EACCES: permission denied, unlink '${file}' ${TRESC}`), {
        code: 'EACCES',
      }));
    };
    const blad = await clearReviewClientLogs(recenzja(), { unlink }).then(() => null, (err: unknown) => err);
    expect(blad).toBeInstanceOf(Error);
    expect((blad as Error).message).toBe('review demo: could not delete client.log (EACCES)');
    // Pierwszy błąd kończy kasowanie: start i tak pada.
    expect(proby).toEqual(['client.log']);
  });

  it('tryb recenzji: błąd bez kodu daje `unknown error`', async () => {
    const unlink = (): Promise<void> => Promise.reject(new Error(TRESC));
    await expect(clearReviewClientLogs(recenzja(), { unlink }))
      .rejects.toThrow(/^review demo: could not delete client\.log \(unknown error\)$/u);
  });

  it('zwykłe demo i serwer: oba pliki zostają, `unlink` nie jest wołany', async () => {
    await oba();
    const unlink = (): Promise<void> => Promise.reject(new Error('unlink poza trybem recenzji'));
    await expect(clearReviewClientLogs(config, { unlink })).resolves.toEqual([]);
    await expect(clearReviewClientLogs(loadConfig({ RAROG_DATA_DIR: dir, RAROG_ORIGINS: 'https://rarog.example' }), { unlink })).resolves.toEqual([]);
    expect(await readFile(clientLogPath(config), 'utf8')).toBe(TRESC);
    expect(await readFile(`${clientLogPath(config)}.1`, 'utf8')).toBe(TRESC);
  });
});
