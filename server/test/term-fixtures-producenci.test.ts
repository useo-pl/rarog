/**
 * Złote ramki terminala, strona SERWERA: gniazdo WS → pliki
 * `shared/fixtures/term/server.*.json`.
 *
 * Ramki produkuje KOD: prawdziwy ficzer terminala (`createTermFeature`: rejestr, `ws.ts`,
 * backend panelowy) za prawdziwym `http.Server` i klientem `ws`, z atrapą gniazda herdr i procesu
 * kontrolera (`fake-term-herdr.ts`). `hello` to pierwsza ramka tekstowa po udanym `attach`, `err`
 * to odmowa sufitu `RAROG_TERM_MAX` przy drugim żywym strumieniu, `exit` to nieplanowany koniec
 * kontrolera powłoki, `err.taken-over` to przejęcie panelu przez obcy kontroler herdr (zdanie z kodem,
 * `msgRef`). Domyślnie test PORÓWNUJE ramki z plikami; `RAROG_FIXTURES_WRITE=1` je
 * nadpisuje. Ramki klienta i wektory cięcia to zamrożona specyfikacja bez producenta, lustro bez
 * importów z `server/` to
 * `shared/test/term-fixtures.test.ts`.
 *
 * Sandbox: test woła `listen()`, więc w sandboksie Claude Code idzie poza nim.
 */
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { termServerFrameSchema } from '@rarog/shared';
import { loadConfig } from '../src/config.ts';
import type { Logger } from '../src/router.ts';
import { createTermFeature } from '../src/term/index.ts';
import { FakeController, FakeHerdr } from './fake-term-herdr.ts';
import { createTestDevice } from './helpers/urzadzenie.ts';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../shared/fixtures/term');
const WRITE = process.env.RAROG_FIXTURES_WRITE === '1';
const ORIGIN = 'http://localhost:8930';
const silent: Logger = { info: () => {}, error: () => {} };

const manifest = JSON.parse(readFileSync(path.join(DIR, 'manifest.json'), 'utf8')) as
  Record<string, { kind: string; t?: string }>;

const serialize = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** Zbieracz ramek TEKSTOWYCH podpięty PRZED handshake'em (`hello` leci razem z odpowiedzią upgrade'u). */
function textFrames(ws: WebSocket): () => Promise<unknown> {
  const seen: unknown[] = [];
  const waiting: ((frame: unknown) => void)[] = [];
  ws.on('message', (data: Buffer, isBinary: boolean) => {
    if (isBinary) return;
    const frame = JSON.parse(data.toString('utf8')) as unknown;
    const wake = waiting.shift();
    if (wake === undefined) seen.push(frame);
    else wake(frame);
  });
  return () => new Promise<unknown>((resolve, reject) => {
    const frame = seen.shift();
    if (frame !== undefined) {
      resolve(frame);
      return;
    }
    const timer = setTimeout(() => { reject(new Error('brak ramki tekstowej')); }, 10_000);
    waiting.push((next) => {
      clearTimeout(timer);
      resolve(next);
    });
  });
}

/** Czeka, aż warunek stanie się prawdą (spawn kontrolera idzie przez obietnicę uchwytu). */
async function until(condition: () => boolean): Promise<void> {
  for (let round = 0; round < 500; round += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
  }
  throw new Error('warunek nie nadszedł');
}

describe('złote ramki terminala: serwer → pliki', () => {
  const produced = new Map<string, unknown>();
  let root = '';

  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), 'rarog-term-fixtures-')));
    const project = path.join(root, 'rarog');
    await mkdir(project);
    const config = loadConfig({
      RAROG_ORIGINS: ORIGIN, RAROG_PROJECT_ROOTS: root, RAROG_TERM: '1',
      // Sufit JEDNEGO żywego strumienia: drugi `attach` dostaje odmowę `limit` z ramką `err`.
      RAROG_TERM_MAX: '1',
      RAROG_HERDR_LAUNCH: '1', RAROG_HERDR_SEND: '1', RAROG_HERDR_BIN: '/usr/bin/true',
      RAROG_DATA_DIR: path.join(root, '.dane'), HOME: root, PATH: '/usr/bin:/bin', TMPDIR: root,
    });
    const device = createTestDevice(config.dataDir, { epoch: config.epoch });
    const controllers: FakeController[] = [];
    const herdr = new FakeHerdr();
    const term = await createTermFeature(config, silent, {
      devices: device.store,
      herdrLaunchClient: () => herdr,
      herdrSpawn: () => {
        const controller = new FakeController();
        controllers.push(controller);
        return controller;
      },
    });
    if (term === null) throw new Error('createTermFeature oddało null mimo RAROG_TERM=1');
    const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
    server.on('upgrade', (req, socket, head) => { term.handleUpgrade(req, socket, head); });
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    const base = `ws://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    const headers = { ...device.headers, Origin: ORIGIN };
    const connect = async (id: string): Promise<{ ws: WebSocket; next: () => Promise<unknown> }> => {
      const ws = new WebSocket(`${base}/api/term/${id}?fresh=1&c=104&r=41`, { headers });
      const next = textFrames(ws);
      await new Promise<void>((resolve, reject) => { ws.on('open', () => { resolve(); }); ws.on('error', reject); });
      return { ws, next };
    };
    const sockets: WebSocket[] = [];
    try {
      const first = term.open(project);
      const second = term.open(project, 'next');
      if (!first.ok || !second.ok) throw new Error('open nieudany');
      const live = await connect(first.id);
      sockets.push(live.ws);
      produced.set('server.hello.json', await live.next());
      await until(() => controllers.length === 1);
      // Drugi żywy strumień ponad `RAROG_TERM_MAX`: `ws.ts` mówi zdaniem rejestru i zamyka gniazdo.
      const refused = await connect(second.id);
      sockets.push(refused.ws);
      produced.set('server.err.json', await refused.next());
      // Kontroler powłoki kończy się sam (nie planowo): pierwszy pad pod bezpiecznikiem = `exit`.
      controllers[0]?.emit('exit', 1, null);
      produced.set('server.exit.json', await live.next());
      // Nowe gniazdo wskrzesza powłokę (drugi kontroler), potem obcy kontroler herdr przejmuje panel: rejestr kładzie
      // wpis w `failed` i mówi zdaniem z kodem (`msgRef`).
      const again = await connect(first.id);
      sockets.push(again.ws);
      await again.next();
      await until(() => controllers.length === 2);
      controllers[1]?.stdout.write(`${JSON.stringify({ type: 'terminal.closed', reason: 'taken over by another client' })}\n`);
      produced.set('server.err.taken-over.json', await again.next());
    } finally {
      for (const ws of sockets) ws.terminate();
      term.dispose();
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
    }
  }, 60_000);

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('kod produkuje dokładnie ramki serwera z manifestu', () => {
    const mine = Object.entries(manifest).filter(([, entry]) => entry.kind === 'server').map(([name]) => name);
    expect([...produced.keys()].sort()).toEqual(mine.sort());
  });

  it.each(Object.entries(manifest).filter(([, entry]) => entry.kind === 'server'))(
    '%s: typ z manifestu, ścisły schemat bez strat',
    (name, entry) => {
      const frame = produced.get(name);
      expect((frame as { t?: string } | undefined)?.t).toBe(entry.t);
      expect(termServerFrameSchema.parse(frame)).toEqual(frame);
    },
  );

  it.each(Object.entries(manifest).filter(([, entry]) => entry.kind === 'server').map(([name]) => name))(
    '%s = to, co dziś produkuje kod (odśwież: RAROG_FIXTURES_WRITE=1)',
    (name) => {
      const file = path.join(DIR, name);
      if (WRITE) writeFileSync(file, serialize(produced.get(name)));
      expect(JSON.parse(readFileSync(file, 'utf8')) as unknown).toEqual(produced.get(name));
    },
  );
});
