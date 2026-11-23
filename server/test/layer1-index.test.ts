/**
 * Spięcie kanału zgód w `server/src/index.ts`: prawdziwy serwer z katalogiem danych i domem w katalogu
 * testu, atrapa herdr na gnieździe Unix (NDJSON, jedno żądanie na połączenie, subskrypcja trzyma połączenie),
 * rejestr sesji CLI w domu testu (`~/.claude/sessions/<pid>.json`), transkrypt w magazynie CLI domu, hook jako
 * proces `sleep` z rejestracją na prawdziwym `consent.sock` i zrzutem w `pending/`.
 *
 * Przypadki: zgoda do `applied` z dowodem z transkryptu (1), to samo z restartem po `claimed` (2),
 * start z rekordem niekońcowym bez błędu odzyskiwania (3), restart z kartą `sent` (4), 65 rejestracji po śmierci
 * hooków (5) i sekret rejestracji poza logiem, odpowiedziami gniazd, SSE i `/health` (7). Przypadek 6
 * (`revokeSession`) ma testy w `layer1-cycle.test.ts`. Port końca tury managera (`turnEnded`): zgoda
 * odebrana przez hook, potem `/exit` bez wyniku narzędzia w transkrypcie; karta schodzi z urządzeń po końcu sesji (8)
 * i nie wraca po restarcie serwera na wznowionej rozmowie (9). Przy trybie `all`: przypadek (1) tą samą
 * drogą i prośba subagenta bez dowodu wracająca do biurka podpisanym `release` (10).
 *
 * Restart grace (`RAROG_CONSENT_RESTART_GRACE`): case (3) with G = 0 and G > 0, and the real hook
 * (`scripts/hooks/rarog-pending.mjs` from the home copy) that waits through `dispose → start` with a `sent` card and
 * with a `pending` one.
 *
 * Przycisk zgody wymaga zdjętej blokady startu (świeży rejestr bez `waiting` co najmniej
 * `REGISTRY_SLACK_MS` po starcie serwera) i wierzchu ekranu z tożsamością prośby: rejestr CLI mówi `busy`, aż serwer
 * zapisze w logu zdjęcie blokady, a potem atrapa herdr oddaje w `agent.read` dialog `Bash` z całą ramką komendy hooka.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync,
  rmSync, writeFileSync,
} from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adminSocketPath, consentSocketPath, deviceAuthorization } from '../src/auth/index.ts';
import {
  CONSENT_CHANNEL_ENV, CONSENT_RESTART_GRACE_ENV, HERDR_LAUNCH_ENV, HERDR_ROOTS_ENV, HERDR_SEND_ENV, HERDR_SOCKET_ENV,
  HERDR_TAB_LABELS_ENV, MIN_CLIENT_BUILD_ENV, PUSH_ENV, TERM_ENV,
} from '../src/config-env.ts';
import { canonicalSha256 } from '../src/herdr/dialogs/hook/canon.ts';
import { HOOK_PENDING_DIRNAME } from '../src/herdr/dialogs/hook/contract.ts';
import type { HookCallDump } from '../src/herdr/dialogs/hook/contract.ts';
import {
  CONSENT_DENY_MESSAGE, CONSENT_DIRNAME, CONSENT_REGISTER_ROUTE, CONSENT_SECRET_BYTES, CONSENT_SUBAGENT_GRACE_MS,
} from '../src/herdr/dialogs/layer1/contract.ts';
import { createConsentCycle } from '../src/herdr/dialogs/layer1/cycle.ts';
import { readConsentRecords } from '../src/herdr/dialogs/layer1/records.ts';
import type { ConsentRecord } from '../src/herdr/dialogs/layer1/records.ts';
import { createConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import { consentCardSha256, verifyConsentFile } from '../src/herdr/dialogs/layer1/sign.ts';
import {
  HOOK_INSTALL_DIR_REL, HOOK_INSTALL_FILES, HOOK_SOURCE_DIR_REL, hookCommand, renderHookBlock,
} from '../src/herdr/hook-config.ts';
import { SUBSCRIBE_METHOD, TESTED_PROTOCOL } from '../src/herdr/socket.ts';
import { DATA_DIR_ENV } from '../../shared/src/data-dir.mjs';
import { standingWithRead } from './helpers/dowod-z-odczytem.ts';
import { readHookLog } from './helpers/hook-kanal.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURES = path.join(REPO, 'server', 'test', 'fixtures', 'consent-dowod');
const ORIGIN = 'https://serwer.example';
/** Sesja silnika i tura fixture'u `bash-krotki` (CLI 2.1.314). */
const ENGINE = '00000000-0000-4000-9000-000000000001';
const PROMPT = '00000000-0000-4000-9000-000000000036';
const PANE = 'w1:p1';

interface HookInput {
  readonly tool_name: string;
  readonly tool_input: unknown;
  readonly cwd: string;
  readonly permission_mode?: string;
}
const HOOK_INPUT = JSON.parse(readFileSync(path.join(FIXTURES, 'bash-krotki.hook.json'), 'utf8')) as HookInput;
/** Dialog `Bash` z pomiaru (CLI 2.1.293) z całą ramką komendy hooka: wierzch ekranu z tożsamością prośby. */
const BASH_TOP = ((): string => {
  const lines = readFileSync(path.join(REPO, 'server', 'test', 'fixtures', 'herdr', 'measured', 'zgoda-bash-2.1.293.txt'),
    'utf8').split('\n');
  const top = lines.findIndex((line) => line.startsWith('╌'));
  const bottom = lines.findIndex((line, index) => index > top && line.startsWith('╌'));
  const { command } = HOOK_INPUT.tool_input as { command: string };
  return [...lines.slice(0, top + 1), ` ${command}`, ...lines.slice(bottom)].join('\n');
})();
const TURN = readFileSync(path.join(FIXTURES, 'bash-krotki.jsonl'), 'utf8').split('\n').filter((line) => line !== '');
const RESULT_AT = TURN.findIndex((line) => line.includes('"tool_result"'));

let dir = '';
const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(() => { dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'l1i-'))); });
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

// ── Atrapa herdr

interface FakeHerdr {
  readonly socketPath: string;
  readonly calls: Array<{ method: string; params: Record<string, unknown> }>;
  /** Agenci z `agent.list`; pusta lista = panel zamknięty (`gone` przy najbliższym resyncu). */
  readonly agents: Array<Record<string, unknown>>;
  /** Ekran panelu z `agent.read`; pusty = bez dialogu. */
  screen: string;
}

/** Agent Claude w kształcie `agent.list` (fixture `herdr/agent-list.json`) z sesją {@link ENGINE}. */
function agentOf(cwd: string): Record<string, unknown> {
  return {
    agent: 'claude',
    agent_session: { agent: 'claude', kind: 'id', source: 'herdr:claude', value: ENGINE },
    agent_status: 'working', cwd, focused: false, foreground_cwd: cwd, pane_id: PANE, revision: 1,
    state_change_seq: 1, tab_id: 'w1:t1', terminal_id: 'term_0000000000000001', terminal_title: 'zgoda',
    terminal_title_stripped: 'zgoda', workspace_id: 'w1',
  };
}

async function fakeHerdr(cwd: string): Promise<FakeHerdr> {
  const socketPath = path.join(dir, 'h.sock');
  const calls: FakeHerdr['calls'] = [];
  const agent = agentOf(cwd);
  const agents = [agent];
  const fake: FakeHerdr = { socketPath, calls, agents, screen: '' };
  const open = new Set<net.Socket>();
  const reply = (conn: net.Socket, frame: Record<string, unknown>, keep = false): void => {
    conn.write(`${JSON.stringify(frame)}\n`);
    if (!keep) conn.end();
  };
  const server = net.createServer((conn) => {
    open.add(conn);
    conn.on('close', () => { open.delete(conn); });
    conn.on('error', () => { /* klient zrywa połączenie po odpowiedzi */ });
    let buffer = '';
    conn.setEncoding('utf8');
    conn.on('data', (chunk: string) => {
      buffer += chunk;
      let at = buffer.indexOf('\n');
      while (at >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        at = buffer.indexOf('\n');
        const frame = JSON.parse(line) as { id: string; method: string; params?: Record<string, unknown> };
        const params = frame.params ?? {};
        calls.push({ method: frame.method, params });
        const id = frame.id;
        switch (frame.method) {
          case 'ping': reply(conn, { id, result: { type: 'pong', version: '0.9.0', protocol: TESTED_PROTOCOL } }); break;
          case SUBSCRIBE_METHOD: reply(conn, { id, result: { type: 'subscription_started' } }, true); break;
          case 'agent.list': reply(conn, { id, result: { agents } }); break;
          case 'agent.get':
            reply(conn, agents.length > 0 ? { id, result: { agent } } : { id, error: { code: 'not_found', message: 'gone' } });
            break;
          case 'agent.read': reply(conn, { id, result: { read: { text: fake.screen } } }); break;
          case 'pane.read': reply(conn, { id, result: { read: { text: '', truncated: false } } }); break;
          case 'pane.list':
            reply(conn, { id, result: { panes: [{ pane_id: PANE, tab_id: 'w1:t1', workspace_id: 'w1', cwd }] } });
            break;
          case 'agent.send_keys': reply(conn, { id, result: {} }); break;
          default: reply(conn, { id, error: { code: 'not_found', message: `no ${frame.method} in the test` } });
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  cleanups.push(() => new Promise<void>((resolve) => {
    for (const conn of open) conn.destroy();
    server.close(() => { resolve(); });
  }));
  return fake;
}

// ── Dom, rejestr CLI, transkrypt, hook

interface Place {
  readonly home: string;
  readonly dataDir: string;
  readonly cwd: string;
  readonly herdr: FakeHerdr;
}

/** Dom z wpisem hooka `PermissionRequest` i kopią równą repo (status hooka `ok`). */
function installHook(home: string): void {
  const copy = path.join(home, HOOK_INSTALL_DIR_REL);
  mkdirSync(copy, { recursive: true });
  for (const name of HOOK_INSTALL_FILES) copyFileSync(path.join(REPO, HOOK_SOURCE_DIR_REL, name), path.join(copy, name));
  mkdirSync(path.join(home, '.claude'), { recursive: true });
  writeFileSync(path.join(home, '.claude', 'settings.json'), renderHookBlock(hookCommand(home)));
}

async function place(): Promise<Place> {
  const home = path.join(dir, 'h');
  const dataDir = path.join(dir, 'd');
  const cwd = path.join(dir, 'p', 'projekt');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  installHook(home);
  return { home, dataDir, cwd, herdr: await fakeHerdr(cwd) };
}

/** Wpis rejestru sesji CLI procesu testu (żywy pid) dla {@link ENGINE}. */
function cliRegistry(home: string, status: 'waiting' | 'busy'): void {
  const at = path.join(home, '.claude', 'sessions');
  mkdirSync(at, { recursive: true });
  writeFileSync(path.join(at, `${String(process.pid)}.json`), JSON.stringify({
    pid: process.pid, sessionId: ENGINE, version: '2.1.314', status, startedAt: Date.now() - 60_000,
    ...(status === 'waiting' ? { waitingFor: 'permission prompt' } : {}),
  }));
}

const transcriptPath = (home: string): string => path.join(home, '.claude', 'projects', 'projekt', `${ENGINE}.jsonl`);

/** Linie tury fixture'u z `timestamp` z bieżącej chwili (wynik ma stać po starcie procesu hooka). */
function stamped(lines: readonly string[]): string {
  return lines.map((line) => JSON.stringify({ ...JSON.parse(line) as object, timestamp: new Date().toISOString() }))
    .map((line) => `${line}\n`).join('');
}

/** Początek tury: prompt i otwarte `tool_use`. */
function transcriptStart(home: string): void {
  mkdirSync(path.dirname(transcriptPath(home)), { recursive: true });
  writeFileSync(transcriptPath(home), stamped(TURN.slice(0, RESULT_AT)));
}

/** Reszta tury: wynik `hook/accept` i `system/turn_duration`. */
function transcriptRest(home: string): void {
  appendFileSync(transcriptPath(home), stamped(TURN.slice(RESULT_AT)));
}

interface Hook {
  readonly pid: number;
  readonly startedAt: number;
  kill(): Promise<void>;
}

/** Proces hooka: żywy `sleep` z pidem i chwilą startu. */
async function hookProcess(): Promise<Hook> {
  const startedAt = Date.now();
  const child = spawn('/bin/sleep', ['600'], { stdio: 'ignore' });
  const exited = new Promise<void>((resolve) => { child.on('exit', () => { resolve(); }); });
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  const pid = child.pid ?? 0;
  let alive = true;
  const kill = async (): Promise<void> => {
    if (!alive) return;
    alive = false;
    child.kill('SIGKILL');
    await exited;
  };
  cleanups.push(kill);
  return { pid, startedAt, kill };
}

/** Pid i chwila startu procesu, który już nie żyje. */
async function deadProcess(): Promise<{ pid: number; startedAt: number }> {
  const startedAt = Date.now();
  const child = spawn('/usr/bin/true', [], { stdio: 'ignore' });
  await new Promise<void>((resolve) => { child.on('exit', () => { resolve(); }); });
  return { pid: child.pid ?? 0, startedAt };
}

function dumpFor(hook: { pid: number; startedAt: number }, nonce: string): HookCallDump {
  const toolInput = HOOK_INPUT.tool_input;
  return {
    key: `${PROMPT}-${nonce}`, sessionId: ENGINE, promptId: PROMPT, pid: hook.pid, startedAt: hook.startedAt,
    toolName: HOOK_INPUT.tool_name, toolInput, cwd: HOOK_INPUT.cwd, at: hook.startedAt + 20,
    inputSha256: canonicalSha256(toolInput), permissionMode: HOOK_INPUT.permission_mode ?? 'default',
  };
}

const dumpPath = (dataDir: string, key: string): string => path.join(dataDir, HOOK_PENDING_DIRNAME, ENGINE, `${key}.json`);

function writeDump(dataDir: string, dump: HookCallDump): void {
  mkdirSync(path.dirname(dumpPath(dataDir, dump.key)), { recursive: true, mode: 0o700 });
  writeFileSync(dumpPath(dataDir, dump.key), JSON.stringify(dump), { mode: 0o600 });
}

const cardShaOf = (dump: HookCallDump): string => consentCardSha256({
  sessionId: dump.sessionId, toolName: dump.toolName, toolInput: dump.toolInput, cwd: dump.cwd,
  agentId: dump.agentId ?? null, permissionMode: dump.permissionMode ?? null,
});

const newSecret = (): string => randomBytes(CONSENT_SECRET_BYTES).toString('hex');

// ── Serwer i klient

interface Server {
  readonly port: number;
  output(): string;
  stop(): Promise<void>;
}

/**
 * Serwer z trybem kanału `mode` (konfiguracja = efektywny przy komplecie warunków); gotowy po linii trybu. `grace`:
 * the restart grace in whole seconds (`RAROG_CONSENT_RESTART_GRACE`); no value = the default.
 */
async function startServer(at: Place, mode: 'main' | 'all' = 'main', grace?: string): Promise<Server> {
  const child = spawn(path.join(REPO, 'node_modules', '.bin', 'tsx'), ['server/src/index.ts'], {
    cwd: REPO,
    env: {
      PATH: process.env['PATH'] ?? '', HOME: at.home, TMPDIR: tmpdir(), RAROG_ORIGINS: ORIGIN, RAROG_PORT: '0',
      [DATA_DIR_ENV]: at.dataDir, [HERDR_SOCKET_ENV]: at.herdr.socketPath, [HERDR_ROOTS_ENV]: path.dirname(at.cwd),
      [HERDR_SEND_ENV]: '1', [HERDR_LAUNCH_ENV]: '0', [HERDR_TAB_LABELS_ENV]: '0', [PUSH_ENV]: '0', [TERM_ENV]: '0',
      [CONSENT_CHANNEL_ENV]: mode, [MIN_CLIENT_BUILD_ENV]: '100',
      ...(grace === undefined ? {} : { [CONSENT_RESTART_GRACE_ENV]: grace }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let stopped = false;
  const exited = new Promise<void>((resolve) => { child.on('close', () => { resolve(); }); });
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    child.kill('SIGTERM');
    await exited;
  };
  cleanups.push(stop);
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error(`serwer nie wstał:\n${output}`)); }, 90_000);
    const onData = (chunk: Buffer): void => {
      output += chunk.toString('utf8');
      const listening = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
      if (listening !== null && output.includes(`consent: effective mode ${mode}`)) {
        clearTimeout(timer);
        resolve(Number(listening[1]));
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
  });
  return { port, output: () => output, stop };
}

/** Żądanie przez gniazdo Unix. */
function socketCall(socketPath: string, method: string, route: string, body?: unknown): Promise<{
  status: number; text: string; body: Record<string, unknown> | null;
}> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({
      socketPath, path: route, method, headers: { 'Content-Length': String(Buffer.byteLength(payload)) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => { chunks.push(chunk); });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, text, body: text === '' ? null : JSON.parse(text) as Record<string, unknown> });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

/** Rejestracja hooka na `consent.sock` w kształcie hooka. */
function register(dataDir: string, dump: HookCallDump, secret: string): ReturnType<typeof socketCall> {
  return socketCall(consentSocketPath(dataDir), 'POST', CONSENT_REGISTER_ROUTE, {
    key: dump.key, sessionId: dump.sessionId, promptId: dump.promptId, secret, inputSha256: dump.inputSha256,
    cardSha256: cardShaOf(dump), pid: dump.pid, startedAt: dump.startedAt,
    ...(dump.agentId === undefined ? {} : { agentId: dump.agentId }),
  });
}

/** Sparowane urządzenie: nagłówki żądań apki. */
async function pairDevice(port: number, dataDir: string): Promise<Record<string, string>> {
  const issued = await socketCall(adminSocketPath(dataDir), 'POST', '/api/admin/pairings');
  const paired = await fetch(`http://127.0.0.1:${String(port)}/api/pair`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ v: 1, code: issued.body?.['code'], label: 'iPhone·Test' }),
  });
  const device = await paired.json() as Record<string, unknown>;
  return { Origin: ORIGIN, Authorization: deviceAuthorization(String(device['deviceId']), String(device['secret'])) };
}

interface Stream {
  readonly frames: Array<Record<string, unknown>>;
  raw(): string;
}

/** Strumień SSE: ramki `data:` jako obiekty i surowy tekst; zamyka go sprzątanie testu. */
function openStream(port: number, route: string, headers: Record<string, string>): Stream {
  const frames: Array<Record<string, unknown>> = [];
  let raw = '';
  let buffer = '';
  const req = http.get({ host: '127.0.0.1', port, path: route, headers, agent: false }, (res) => {
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      raw += chunk;
      buffer += chunk;
      let at = buffer.indexOf('\n\n');
      while (at >= 0) {
        const data = buffer.slice(0, at).split('\n').filter((line) => line.startsWith('data: '))
          .map((line) => line.slice('data: '.length)).join('\n');
        buffer = buffer.slice(at + 2);
        at = buffer.indexOf('\n\n');
        if (data !== '') frames.push(JSON.parse(data) as Record<string, unknown>);
      }
    });
    res.on('error', () => { /* zerwanie przy sprzątaniu */ });
  });
  req.on('error', () => { /* zerwanie przy sprzątaniu */ });
  cleanups.push(() => { req.destroy(); });
  return { frames, raw: () => raw };
}

async function waitUntil<T>(what: string, probe: () => T | null | undefined | false | Promise<T | null | undefined | false>,
  timeoutMs: number, context: () => string = () => ''): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() > until) throw new Error(`nie doczekano się: ${what}\n${context()}`);
    await new Promise((resolve) => { setTimeout(resolve, 100); });
  }
}

/** Id sesji Raroga dla panelu {@link PANE} ze strumienia globalnego. */
async function sessionIdOf(port: number, headers: Record<string, string>, server: Server): Promise<string> {
  const global = openStream(port, '/api/stream', headers);
  return waitUntil('sesja panelu w strumieniu globalnym', () => {
    for (const frame of global.frames) {
      const sessions = frame['type'] === 'sessions-snapshot' ? frame['sessions'] as Array<Record<string, unknown>>
        : frame['type'] === 'session-changed' ? [frame['session'] as Record<string, unknown>] : [];
      const found = sessions.find((session) => session['paneId'] === PANE);
      if (found !== undefined) return String(found['id']);
    }
    return null;
  }, 30_000, server.output);
}

/** Ramki karty `permId` w strumieniu sesji (prośba, zmiany, zdjęcie). */
function cardFrames(stream: Stream, permId: string): Array<Record<string, unknown>> {
  return stream.frames.filter((frame) => {
    if (frame['type'] === 'permission-pending') return (frame['request'] as Record<string, unknown>)['permId'] === permId;
    return (frame['type'] === 'permission-settled' || frame['type'] === 'permission-resolved') && frame['permId'] === permId;
  });
}

/** Karty sesji z pierwszej ramki `transcript-snapshot` świeżego strumienia sesji. */
async function snapshotCards(port: number, sessionId: string, headers: Record<string, string>,
  server: Server): Promise<Array<Record<string, unknown>>> {
  const stream = openStream(port, `/api/sessions/${encodeURIComponent(sessionId)}/stream`, headers);
  return waitUntil('migawka sesji', () => {
    const snapshot = stream.frames.find((frame) => frame['type'] === 'transcript-snapshot');
    return snapshot === undefined ? null : snapshot['pendingPermissions'] as Array<Record<string, unknown>>;
  }, 20_000, server.output);
}

const recordOf = (dataDir: string, key: string): ConsentRecord | undefined =>
  readConsentRecords(dataDir).find((record) => record.key === key);

const answerPath = (dataDir: string, key: string, suffix: string): string =>
  path.join(dataDir, CONSENT_DIRNAME, ENGINE, `${key}${suffix}`);

async function healthText(port: number): Promise<string> {
  return (await fetch(`http://127.0.0.1:${String(port)}/health`)).text();
}

async function decide(port: number, sessionId: string, permId: string, headers: Record<string, string>,
  decision: 'allow' | 'deny'): Promise<{ status: number; text: string }> {
  const response = await fetch(`http://127.0.0.1:${String(port)}/api/sessions/${encodeURIComponent(sessionId)}`
    + `/permissions/${encodeURIComponent(permId)}`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ decision }),
  });
  return { status: response.status, text: await response.text() };
}

/** A decision from the device; one refused with `card-changed` (the observation tick came late) is tried again. */
function decideTaken(server: Server, sessionId: string, permId: string, headers: Record<string, string>,
  decision: 'allow' | 'deny'): Promise<{ status: number; text: string }> {
  return waitUntil(`decision ${decision} taken`, async () => {
    const reply = await decide(server.port, sessionId, permId, headers, decision);
    return reply.status === 409 && reply.text.includes('card-changed') ? null : reply;
  }, 15_000, server.output);
}

/**
 * Karta od zrzutu do `sent`: rejestr CLI `busy` do zdjęcia blokady startu, potem dialog `Bash` hooka na ekranie
 * i rejestr `waiting`; hook żyje, rejestracja na gnieździe, zrzut, karta z przyciskiem zgody w strumieniu sesji, zgoda
 * z urządzenia. `holdMs` = czekanie między kartą a zgodą (zamiatanie rejestru po drodze). Dowód z wierzchu ma termin
 * 2 s od odczytu ekranu, a takt obserwacji to 1,5 s: zgodę odrzuconą `card-changed` (takt spóźniony pod obciążeniem
 * maszyny testów) test ponawia.
 */
async function cardToSent(at: Place, server: Server, nonce: string, holdMs = 0): Promise<{
  dump: HookCallDump; hook: Hook; secret: string; sessionId: string; headers: Record<string, string>;
  stream: Stream; registered: string; decided: string;
}> {
  const headers = await pairDevice(server.port, at.dataDir);
  const sessionId = await sessionIdOf(server.port, headers, server);
  const stream = openStream(server.port, `/api/sessions/${encodeURIComponent(sessionId)}/stream`, headers);
  await waitUntil('blokada startu zdjęta', () => server.output().includes(`consent: session ${ENGINE} start lock released`),
    30_000, server.output);
  at.herdr.screen = BASH_TOP;
  cliRegistry(at.home, 'waiting');
  const hook = await hookProcess();
  const dump = dumpFor(hook, nonce);
  const secret = newSecret();
  const registered = await register(at.dataDir, dump, secret);
  expect(registered.status, registered.text).toBe(200);
  writeDump(at.dataDir, dump);
  await waitUntil('karta z przyciskiem zgody', () => cardFrames(stream, dump.key).some((frame) =>
    (frame['type'] === 'permission-pending' && (frame['request'] as Record<string, unknown>)['canAllow'] === true)
    || (frame['type'] === 'permission-settled' && frame['canAllow'] === true)), 30_000, server.output);
  if (holdMs > 0) await new Promise((resolve) => { setTimeout(resolve, holdMs); });
  const decided = await decideTaken(server, sessionId, dump.key, headers, 'allow');
  expect(decided.status, decided.text).toBe(200);
  expect(recordOf(at.dataDir, dump.key)?.state).toBe('sent');
  return { dump, hook, secret, sessionId, headers, stream, registered: registered.text, decided: decided.text };
}

/** Hook przejmuje podpisaną odpowiedź (`rename` na `.claimed`) i sprawdza podpis swoim sekretem. */
function hookClaims(dataDir: string, dump: HookCallDump, secret: string): void {
  const claimed = answerPath(dataDir, dump.key, '.claimed');
  renameSync(answerPath(dataDir, dump.key, '.json'), claimed);
  const file = JSON.parse(readFileSync(claimed, 'utf8')) as unknown;
  expect(verifyConsentFile(file, {
    secret, sessionId: ENGINE, key: dump.key, inputSha256: dump.inputSha256, cardSha256: cardShaOf(dump),
    notBefore: dump.startedAt - 60_000,
  })).toMatchObject({ ok: true, file: { decision: 'allow' } });
}

/** Hook wychodzi: proces kończy się, a zrzut znika (tak sprząta hook w `finishCycle`). */
async function hookExits(at: Place, hook: Hook, dump: HookCallDump): Promise<void> {
  await hook.kill();
  rmSync(dumpPath(at.dataDir, dump.key), { force: true });
  cliRegistry(at.home, 'busy');
}

/** Klawisze wysłane do panelu: przy efektywnym `main` żadnej cyfry zgody. */
function digitKeys(herdr: FakeHerdr): string[] {
  return herdr.calls.filter((call) => call.method === 'agent.send_keys')
    .flatMap((call) => (call.params['keys'] as string[] | undefined) ?? [])
    .filter((key) => /^[0-9]$/.test(key));
}

const NONCE_A = 'a'.repeat(32);
const NONCE_B = 'b'.repeat(32);

interface RealHook {
  readonly done: Promise<{ code: number | null; stdout: string }>;
  signal(name: NodeJS.Signals): void;
}

/** The `PermissionRequest` hook from the home copy, as Claude Code runs it, with the fixture's request in the project. */
function realHook(at: Place): RealHook {
  const child = spawn(process.execPath, [path.join(at.home, HOOK_INSTALL_DIR_REL, 'rarog-pending.mjs')], {
    env: { PATH: process.env['PATH'] ?? '', HOME: at.home, [DATA_DIR_ENV]: at.dataDir },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  let stdout = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
  const done = new Promise<{ code: number | null; stdout: string }>((resolve) => {
    child.on('close', (code) => { resolve({ code, stdout }); });
  });
  cleanups.push(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGCONT');
    child.kill('SIGKILL');
    await done;
  });
  child.stdin.end(JSON.stringify({
    session_id: ENGINE, cwd: at.cwd, prompt_id: PROMPT, permission_mode: HOOK_INPUT.permission_mode ?? 'default',
    hook_event_name: 'PermissionRequest', tool_name: HOOK_INPUT.tool_name, tool_input: HOOK_INPUT.tool_input,
  }));
  return { done, signal: (name) => { child.kill(name); } };
}

/** The events of `shadow.jsonl` (the hook's cycle lines). */
const hookEvents = (at: Place): string[] => readHookLog(at.dataDir).map((line) => line.ev);

/**
 * The real hook's card with the allow button, before any decision: the start lock released, the `Bash` dialog on the
 * screen and the CLI registry `waiting`, then the hook registers, dumps and waits.
 */
async function realHookCard(at: Place, server: Server): Promise<{
  hook: RealHook; key: string; sessionId: string; headers: Record<string, string>;
}> {
  const headers = await pairDevice(server.port, at.dataDir);
  const sessionId = await sessionIdOf(server.port, headers, server);
  const stream = openStream(server.port, `/api/sessions/${encodeURIComponent(sessionId)}/stream`, headers);
  await waitUntil('start lock released', () => server.output().includes(`consent: session ${ENGINE} start lock released`),
    30_000, server.output);
  at.herdr.screen = BASH_TOP;
  cliRegistry(at.home, 'waiting');
  const hook = realHook(at);
  const key = await waitUntil('the hook waits', () => readHookLog(at.dataDir).find((line) => line.ev === 'czekam')?.key,
    15_000, server.output);
  await waitUntil('card with the allow button', () => cardFrames(stream, key).some((frame) =>
    (frame['type'] === 'permission-pending' && (frame['request'] as Record<string, unknown>)['canAllow'] === true)
    || (frame['type'] === 'permission-settled' && frame['canAllow'] === true)), 30_000, server.output);
  return { hook, key, sessionId, headers };
}

/** The hook's line `pauza`: it saw the old server's stop write and waits for the next one. */
const hookPaused = (at: Place, server: Server): Promise<true> => waitUntil('the pause line', () =>
  hookEvents(at).includes('pauza') || null, 10_000, server.output);

describe('kanał zgód spięty w `index.ts`', () => {
  // Przy `all` prośba wątku głównego idzie tą samą drogą co przy `main`.
  it.each(['main', 'all'] as const)('(1, 5b, 7) [%s] zgoda → `claimed` → wyjście hooka → wynik w transkrypcie →'
    + ' `unknown` (`no-receipt`), karta zdjęta; rejestracja żywego hooka przeżywa zamiatanie; sekret poza logiem,'
    + ' gniazdami, SSE i `/health`; zero cyfr', async (mode) => {
    const at = await place();
    // Agent pracuje, zanim zapyta: dialog i rejestr `waiting` ustawia `cardToSent` po zdjęciu blokady startu.
    cliRegistry(at.home, 'busy');
    transcriptStart(at.home);
    const server = await startServer(at, mode);
    // Zgoda dopiero po co najmniej jednym przebiegu zamiatania rejestru (co 5 s): wpis żywego hooka zostaje.
    const card = await cardToSent(at, server, NONCE_A, 6_000);
    const { dump, hook, secret } = card;
    hookClaims(at.dataDir, dump, secret);
    await waitUntil('rekord `claimed`', () => recordOf(at.dataDir, dump.key)?.state === 'claimed', 15_000, server.output);
    expect(recordOf(at.dataDir, dump.key)?.checkpoint).toMatchObject({ file: transcriptPath(at.home), lineStart: 0 });

    // Do wyjścia hooka wpis rejestru żyje (zgoda podpisana po zamiataniu); zapomina go dopiero śmierć procesu.
    expect(server.output()).not.toContain(`registration of key ${dump.key} forgotten`);
    await hookExits(at, hook, dump);
    await waitUntil('rekord `running`', () => recordOf(at.dataDir, dump.key)?.state === 'running', 15_000, server.output);
    transcriptRest(at.home);
    // Przegląd tury co 30 s (`CONSENT_EVIDENCE_SCAN_INTERVAL_MS`) plus tik.
    // Bez potwierdzenia odbioru od hooka wynik `hook` zostaje `unknown` (`no-receipt`).
    await waitUntil('rekord `unknown`', () => recordOf(at.dataDir, dump.key)?.cause === 'no-receipt', 45_000, server.output);
    expect(recordOf(at.dataDir, dump.key)).toMatchObject({
      state: 'unknown', cause: 'no-receipt', correlation: 'bound', toolUseId: 'toolu_000000000000000000000005',
    });
    await waitUntil('karta zdjęta (`permission-resolved`)', () => cardFrames(card.stream, dump.key)
      .some((frame) => frame['type'] === 'permission-resolved'), 10_000, server.output);
    expect((await snapshotCards(server.port, card.sessionId, card.headers, server))
      .map((request) => request['permId'])).not.toContain(dump.key);

    expect(server.output()).toContain(`registration of key ${dump.key} forgotten (hook dead)`);
    expect(server.output()).not.toContain('record recovery failed');
    expect(digitKeys(at.herdr)).toEqual([]);
    const seen = [server.output(), card.registered, card.decided, card.stream.raw(), await healthText(server.port)];
    for (const text of seen) expect(text).not.toContain(secret);
  }, 180_000);

  it('(2) restart serwera po `claimed`: przegląd rusza od zapisanego checkpointu, rekord `unknown` (`no-receipt`)', async () => {
    const at = await place();
    // Agent pracuje, zanim zapyta: dialog i rejestr `waiting` ustawia `cardToSent` po zdjęciu blokady startu.
    cliRegistry(at.home, 'busy');
    transcriptStart(at.home);
    const first = await startServer(at);
    const { dump, hook, secret } = await cardToSent(at, first, NONCE_A);
    hookClaims(at.dataDir, dump, secret);
    await waitUntil('rekord `claimed`', () => recordOf(at.dataDir, dump.key)?.state === 'claimed', 15_000, first.output);
    const checkpoint = await waitUntil('checkpoint rekordu', () => recordOf(at.dataDir, dump.key)?.checkpoint,
      15_000, first.output);
    expect(checkpoint).toMatchObject({ file: transcriptPath(at.home), sessionId: ENGINE, lineStart: 0 });
    await first.stop();

    await hookExits(at, hook, dump);
    transcriptRest(at.home);
    const second = await startServer(at);
    await waitUntil('rekord `unknown` po restarcie', () => recordOf(at.dataDir, dump.key)?.cause === 'no-receipt',
      30_000, second.output);
    expect(recordOf(at.dataDir, dump.key)).toMatchObject({ state: 'unknown', cause: 'no-receipt',
      toolUseId: 'toolu_000000000000000000000005', checkpoint });
    expect(second.output()).not.toContain('record recovery failed');
    expect(second.output()).not.toContain('transcript check');
  }, 180_000);

  it.each([
    ['0', 'revoked at recovery (`restart`)'],
    ['3', 'waits for its hook, then revoked by the observation (`dialog-gone`)'],
  ] as const)('(3) [G = %s s] start with non-final records: no recovery error, `pending` of a live hook %s,'
    + ' `claimed` → `running` without a card in the session snapshot', async (grace, _what) => {
    const at = await place();
    cliRegistry(at.home, 'busy');
    // Rekordy poprzedniego procesu: cykl i rejestr w procesie testu nad katalogiem danych serwera.
    const reg = createConsentRegistry({ bootId: 'poprzedni', send: () => true, sessions: () => [ENGINE], log: () => {} });
    reg.setScope('main');
    // Krok `standing` bez odczytu dostaje odczyt dowodu bez terminu drogą produkcyjną (`helpers/dowod-z-odczytem.ts`).
    const cycle = standingWithRead(createConsentCycle({ dataDir: at.dataDir, bootId: 'poprzedni', registry: reg }));
    const live = await hookProcess();
    const pending = dumpFor(live, NONCE_A);
    const taken = dumpFor(live, NONCE_B);
    for (const dump of [pending, taken]) {
      expect(reg.register({
        key: dump.key, sessionId: ENGINE, promptId: PROMPT, secret: newSecret(), inputSha256: dump.inputSha256,
        cardSha256: cardShaOf(dump), pid: dump.pid, startedAt: dump.startedAt,
      }).status).toBe(200);
      await cycle.observe(ENGINE, dump.key, 'standing', dump);
    }
    expect(await cycle.decide(ENGINE, taken.key, 'allow')).toMatchObject({ ok: true, state: 'sent' });
    renameSync(answerPath(at.dataDir, taken.key, '.json'), answerPath(at.dataDir, taken.key, '.claimed'));
    await cycle.tick();
    expect(recordOf(at.dataDir, pending.key)?.state).toBe('pending');
    expect(recordOf(at.dataDir, taken.key)?.state).toBe('claimed');
    // The hook of `pending` still waits, so its per-call dump stays.
    writeDump(at.dataDir, pending);

    const server = await startServer(at, 'main', grace);
    await waitUntil('linia odzyskania rekordów', () => server.output().includes('consent: recovered 2 records'),
      15_000, server.output);
    expect(server.output()).not.toContain('record recovery failed');
    expect(server.output()).not.toContain('ReferenceError');
    const waits = `consent: key ${pending.key} (pending) waits for its hook after the restart`;
    if (grace === '0') {
      expect(server.output()).not.toContain(waits);
      expect(recordOf(at.dataDir, pending.key)).toMatchObject({ state: 'revoked', cause: 'restart' });
    } else {
      // The hook `ps` finds alive may still register again, so recovery does not revoke the record. The CLI registry
      // shows no dialog, so the observation revokes it as any card whose dialog went.
      expect(server.output()).toContain(waits);
      await waitUntil('`pending` revoked', () => recordOf(at.dataDir, pending.key)?.state === 'revoked', 15_000,
        server.output);
      expect(recordOf(at.dataDir, pending.key)).toMatchObject({ state: 'revoked', cause: 'dialog-gone' });
    }
    const headers = await pairDevice(server.port, at.dataDir);
    const sessionId = await sessionIdOf(server.port, headers, server);
    // Odpowiedź odebrana, rejestr bez `waiting`: dialog zniknął, karta schodzi z urządzeń przy `running`.
    await waitUntil('rekord `running`', () => recordOf(at.dataDir, taken.key)?.state === 'running', 15_000,
      server.output);
    const cards = await snapshotCards(server.port, sessionId, headers, server);
    expect(cards).toEqual([]);
  }, 180_000);

  it('(4) restart `index → dispose → start` z kartą `sent`: karta `server-restart`, zero podpisanych `deny`',
    async () => {
      const at = await place();
      // Agent pracuje, zanim zapyta: dialog i rejestr `waiting` ustawia `cardToSent` po zdjęciu blokady startu.
      cliRegistry(at.home, 'busy');
      transcriptStart(at.home);
      const first = await startServer(at);
      const { dump, sessionId, headers } = await cardToSent(at, first, NONCE_A);
      await first.stop();
      expect(existsSync(answerPath(at.dataDir, dump.key, '.json'))).toBe(true);

      // Urządzenie sparowane przed restartem (klucze urządzeń leżą w katalogu danych).
      const second = await startServer(at);
      await waitUntil('linia odzyskania rekordów', () => second.output().includes('consent: recovered 1 records'),
        15_000, second.output);
      expect(second.output()).not.toContain('record recovery failed');
      expect(await sessionIdOf(second.port, headers, second)).toBe(sessionId);
      const cards = await snapshotCards(second.port, sessionId, headers, second);
      expect(cards).toEqual([expect.objectContaining({
        permId: dump.key, state: 'sent', unavailable: 'server-restart', canAllow: false,
      })]);
      expect(recordOf(at.dataDir, dump.key)?.state).toBe('sent');
      // Pliki odpowiedzi tej sesji: jedyna podpisana odpowiedź to zgoda sprzed restartu.
      const answers = readdirSync(path.join(at.dataDir, CONSENT_DIRNAME, ENGINE));
      expect(answers).toEqual([`${dump.key}.json`]);
      const decisions = answers.map((name) => (JSON.parse(readFileSync(
        path.join(at.dataDir, CONSENT_DIRNAME, ENGINE, name), 'utf8')) as Record<string, unknown>)['decision']);
      expect(decisions).toEqual(['allow']);
      expect(digitKeys(at.herdr)).toEqual([]);
    }, 180_000);

  it('(5) 65 rejestracji jednej sesji, każda po śmierci hooka poprzedniej: zamiatanie zwalnia miejsca, 65. przyjęta',
    async () => {
      const at = await place();
      cliRegistry(at.home, 'busy');
      const server = await startServer(at);
      const headers = await pairDevice(server.port, at.dataDir);
      await sessionIdOf(server.port, headers, server);
      const replies: string[] = [];
      for (let i = 0; i < 64; i += 1) {
        const dump = dumpFor(await deadProcess(), i.toString(16).padStart(32, '0'));
        const reply = await register(at.dataDir, dump, newSecret());
        replies.push(reply.text);
        expect(reply.status, reply.text).toBe(200);
      }
      const last = dumpFor(await deadProcess(), 'f'.repeat(32));
      const secret = newSecret();
      const accepted = await waitUntil('65. rejestracja przyjęta', async () => {
        const reply = await register(at.dataDir, last, secret);
        replies.push(reply.text);
        return reply.status === 200;
      }, 20_000, server.output);
      expect(accepted).toBe(true);
      expect(server.output().match(/consent: registration of key \S+ forgotten \(hook dead\)/g)?.length)
        .toBeGreaterThanOrEqual(64);
      for (const text of [...replies, server.output(), await healthText(server.port)]) expect(text).not.toContain(secret);
    }, 180_000);
  it('(8) zgoda `claimed`, potem `/exit` bez `tool_result`: panel `gone`, koniec tury rozlicza rekord (`unknown`),'
    + ' karta schodzi z urządzeń, migawka sesji `done` bez karty kanału', async () => {
      const at = await place();
      // Agent pracuje, zanim zapyta: dialog i rejestr `waiting` ustawia `cardToSent` po zdjęciu blokady startu.
      cliRegistry(at.home, 'busy');
      transcriptStart(at.home);
      const server = await startServer(at);
      const card = await cardToSent(at, server, NONCE_B);
      hookClaims(at.dataDir, card.dump, card.secret);
      await waitUntil('rekord `claimed`', () => recordOf(at.dataDir, card.dump.key)?.state === 'claimed', 15_000,
        server.output);
      // `/exit`: panel znika z `agent.list`, transkrypt kończy się przed wynikiem narzędzia (resync co 30 s).
      at.herdr.agents.length = 0;
      await waitUntil('rekord `unknown`', () => recordOf(at.dataDir, card.dump.key)?.state === 'unknown', 60_000,
        server.output);
      await waitUntil('karta zdjęta (`permission-resolved`, `expired` od `system`)', () => cardFrames(card.stream,
        card.dump.key).some((frame) => frame['type'] === 'permission-resolved' && frame['decision'] === 'expired'
        && frame['by'] === 'system'), 10_000, server.output);
      expect(cardFrames(card.stream, card.dump.key)
        .filter((frame) => frame['type'] === 'permission-settled' && frame['state'] === 'unknown')).toEqual([]);
      expect((await snapshotCards(server.port, card.sessionId, card.headers, server))
        .map((request) => request['permId'])).not.toContain(card.dump.key);
      expect(server.output()).not.toContain('turn end of session');
      expect(readdirSync(path.join(at.dataDir, CONSENT_DIRNAME, ENGINE)).filter((n) => n.endsWith('.json'))).toEqual([]);
      expect(digitKeys(at.herdr)).toEqual([]);
      await card.hook.kill();
    }, 180_000);

  it('(9) karta zdjęta po `/exit` nie wraca po restarcie: rekord `unknown` z polem zdjęcia, wznowiona rozmowa bez'
    + ' karty w migawce i w zdarzeniach, decyzja 410', async () => {
      const at = await place();
      // Agent pracuje, zanim zapyta: dialog i rejestr `waiting` ustawia `cardToSent` po zdjęciu blokady startu.
      cliRegistry(at.home, 'busy');
      transcriptStart(at.home);
      const first = await startServer(at);
      const card = await cardToSent(at, first, NONCE_A);
      hookClaims(at.dataDir, card.dump, card.secret);
      await waitUntil('rekord `claimed`', () => recordOf(at.dataDir, card.dump.key)?.state === 'claimed', 15_000,
        first.output);
      const panel = at.herdr.agents[0];
      at.herdr.agents.length = 0;
      await waitUntil('karta zdjęta (`permission-resolved`, `expired` od `system`)', () => cardFrames(card.stream,
        card.dump.key).some((frame) => frame['type'] === 'permission-resolved' && frame['by'] === 'system'), 60_000,
        first.output);
      const retired = await waitUntil('rekord `unknown` z polem zdjęcia', () => {
        const record = recordOf(at.dataDir, card.dump.key) as (ConsentRecord & { retired?: unknown }) | undefined;
        return record?.state === 'unknown' && record.retired !== undefined ? record.retired : null;
      }, 15_000, first.output);
      await first.stop();

      // Rozmowa wznowiona w panelu (ta sama sesja silnika), hook karty dalej żyje ze zrzutem w `pending/`.
      if (panel !== undefined) at.herdr.agents.push(panel);
      const second = await startServer(at);
      await waitUntil('linia odzyskania rekordów', () => second.output().includes('consent: recovered 1 records'),
        15_000, second.output);
      expect(await sessionIdOf(second.port, card.headers, second)).toBe(card.sessionId);
      const stream = openStream(second.port, `/api/sessions/${encodeURIComponent(card.sessionId)}/stream`,
        card.headers);
      const cards = await snapshotCards(second.port, card.sessionId, card.headers, second);
      expect(cards.map((request) => request['permId'])).not.toContain(card.dump.key);
      for (const decision of ['allow', 'deny'] as const) {
        expect(await decide(second.port, card.sessionId, card.dump.key, card.headers, decision), decision)
          .toMatchObject({ status: 410 });
      }
      // Obserwacja kanału na drugim serwerze (odczyt rejestru co 1,5 s) widzi zrzut karty, ale niczego nie ogłasza.
      await new Promise((resolve) => { setTimeout(resolve, 4_000); });
      expect(cardFrames(stream, card.dump.key)).toEqual([]);
      expect(recordOf(at.dataDir, card.dump.key)).toMatchObject({ state: 'unknown', retired });
      expect(readdirSync(path.join(at.dataDir, CONSENT_DIRNAME, ENGINE)).filter((n) => n.endsWith('.json'))).toEqual([]);
      expect(digitKeys(at.herdr)).toEqual([]);
      expect(second.output()).not.toContain('record recovery failed');
      await card.hook.kill();
    }, 240_000);

  it('(10) przy `all` prośba subagenta bez dowodu (rejestr `busy`): rejestracja przyjęta, karta bez przycisku zgody,'
    + ' po terminie łaski subagenta podpisane `release`, hook je przejmuje, rekord `released` z `releaseCause`; zero cyfr', async () => {
    const at = await place();
    cliRegistry(at.home, 'busy');
    transcriptStart(at.home);
    const server = await startServer(at, 'all');
    const headers = await pairDevice(server.port, at.dataDir);
    const sessionId = await sessionIdOf(server.port, headers, server);
    const stream = openStream(server.port, `/api/sessions/${encodeURIComponent(sessionId)}/stream`, headers);
    await waitUntil('blokada startu zdjęta', () => server.output().includes(`consent: session ${ENGINE} start lock released`),
      30_000, server.output);
    const hook = await hookProcess();
    const dump: HookCallDump = { ...dumpFor(hook, NONCE_A), agentId: 'agent-tlo-1' };
    const secret = newSecret();
    const registeredAt = Date.now();
    const registered = await register(at.dataDir, dump, secret);
    expect(registered.status, registered.text).toBe(200);
    writeDump(at.dataDir, dump);
    await waitUntil('karta subagenta w strumieniu sesji', () => cardFrames(stream, dump.key)
      .some((frame) => frame['type'] === 'permission-pending'), 30_000, server.output);
    const pendingFrame = cardFrames(stream, dump.key).find((frame) => frame['type'] === 'permission-pending');
    expect((pendingFrame?.['request'] as Record<string, unknown>)['canAllow']).toBe(false);
    expect(recordOf(at.dataDir, dump.key)).toMatchObject({ state: 'pending', agentId: 'agent-tlo-1' });

    await waitUntil('podpisany `release`', () => existsSync(answerPath(at.dataDir, dump.key, '.json')), 30_000,
      server.output);
    const sentAt = Date.now();
    expect(sentAt - registeredAt).toBeGreaterThanOrEqual(CONSENT_SUBAGENT_GRACE_MS);
    expect(recordOf(at.dataDir, dump.key)).toMatchObject({
      state: 'sent', decision: 'release', reasonId: 'release', releaseCause: 'desk-fallback',
    });
    const claimed = answerPath(at.dataDir, dump.key, '.claimed');
    renameSync(answerPath(at.dataDir, dump.key, '.json'), claimed);
    expect(verifyConsentFile(JSON.parse(readFileSync(claimed, 'utf8')) as unknown, {
      secret, sessionId: ENGINE, key: dump.key, inputSha256: dump.inputSha256, cardSha256: cardShaOf(dump),
      notBefore: dump.startedAt - 60_000,
    })).toMatchObject({ ok: true, file: { decision: 'release', reasonId: 'release' } });
    await hookExits(at, hook, dump);
    await waitUntil('rekord `released`', () => recordOf(at.dataDir, dump.key)?.state === 'released', 15_000,
      server.output);
    expect(recordOf(at.dataDir, dump.key)).toMatchObject({ state: 'released', releaseCause: 'desk-fallback' });
    expect(digitKeys(at.herdr)).toEqual([]);
    for (const text of [server.output(), registered.text, stream.raw(), await healthText(server.port)]) {
      expect(text).not.toContain(secret);
    }
  }, 180_000);
});

describe('restart grace with the real hook (`rarog-pending.mjs`): `dispose → start` while the hook waits', () => {
  it('`sent` before the restart → the hook pauses, registers again (`resumed`), takes the file → `allow` on'
    + ' stdout with the new server\'s receipt, record `applied`', async () => {
    const at = await place();
    cliRegistry(at.home, 'busy');
    transcriptStart(at.home);
    const first = await startServer(at);
    const card = await realHookCard(at, first);
    // A frozen hook: the signed `allow` stays on disk through the restart instead of being taken at once.
    card.hook.signal('SIGSTOP');
    const decided = await decideTaken(first, card.sessionId, card.key, card.headers, 'allow');
    expect(decided.status, decided.text).toBe(200);
    expect(recordOf(at.dataDir, card.key)?.state).toBe('sent');
    await first.stop();
    card.hook.signal('SIGCONT');
    await hookPaused(at, first);

    const second = await startServer(at);
    const outcome = await card.hook.done;
    expect(JSON.parse(outcome.stdout)).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
    expect(second.output()).toContain(`consent: key ${card.key} (sent) waits for its hook after the restart`);
    expect(second.output()).toContain(`key ${card.key} (resumed after the restart)`);
    expect(hookEvents(at)).toEqual(['start', 'czekam', 'pauza', 'czekam', 'odbior', 'wyjscie']);
    // The CLI runs the tool: the dialog goes, the result lands in the transcript (evidence pass every 30 s).
    at.herdr.screen = '';
    cliRegistry(at.home, 'busy');
    transcriptRest(at.home);
    await waitUntil('record `applied`', () => recordOf(at.dataDir, card.key)?.state === 'applied', 60_000,
      second.output);
    expect(second.output()).not.toContain('record recovery failed');
    expect(digitKeys(at.herdr)).toEqual([]);
  }, 240_000);

  it('`pending` before the restart → resumed card without Allow (`canAllow: false`, `allow` refused); `deny` from'
    + ' the device reaches the hook', async () => {
    const at = await place();
    cliRegistry(at.home, 'busy');
    transcriptStart(at.home);
    const first = await startServer(at);
    const card = await realHookCard(at, first);
    await first.stop();
    await hookPaused(at, first);

    const second = await startServer(at);
    await waitUntil('the resumed registration', () => second.output()
      .includes(`key ${card.key} (resumed after the restart)`), 30_000, second.output);
    expect(second.output()).toContain(`consent: key ${card.key} (pending) waits for its hook after the restart`);
    const cards = await snapshotCards(second.port, card.sessionId, card.headers, second);
    expect(cards).toEqual([expect.objectContaining({ permId: card.key, canAllow: false })]);
    const allow = await decide(second.port, card.sessionId, card.key, card.headers, 'allow');
    expect(allow.status, allow.text).not.toBe(200);
    expect(recordOf(at.dataDir, card.key)?.state).toBe('pending');
    const denied = await decideTaken(second, card.sessionId, card.key, card.headers, 'deny');
    expect(denied.status, denied.text).toBe(200);
    const outcome = await card.hook.done;
    expect(JSON.parse(outcome.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: CONSENT_DENY_MESSAGE },
      },
    });
    expect(hookEvents(at)).toEqual(['start', 'czekam', 'pauza', 'czekam', 'odbior', 'wyjscie']);
    expect(digitKeys(at.herdr)).toEqual([]);
  }, 240_000);
});
