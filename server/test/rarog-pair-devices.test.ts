/**
 * `rarog pair` i `rarog devices list|revoke` (kod w `server/src/cli/devices.ts`) jako PROCES POTOMNY (`node bin/rarog.mjs …`) przeciw prawdziwemu gniazdu administracyjnemu
 * w katalogu tymczasowym — prawdziwy magazyn `devices.json`, prawdziwe parowanie, zegar magazynu sterowany z testu.
 *
 * Sprawdza: QR i link `https://rarog.ai/pair#v=1&u=…&c=…` (ten sam co `pairingLink` serwera — CLI woła tę funkcję),
 * czekanie na PIERWSZE uwierzytelnione żądanie nowego urządzenia („Sparowano”), odmowę przy aktywnym urządzeniu
 * ze zdaniem o parowaniu z apki, sierotę (kod użyty, brak żądania przez 10 min → „sparuj ponownie”), restart
 * serwera w trakcie, listę i odpinanie (jedno, nieznane, `--all`), ostrzeżenie o adresie bez https i kod 2 przy
 * braku serwera. Serwer iroh: link z `k=`/`r=` obok `u=` albo bez niego, relay w postaci kanonicznej, odmowa
 * tylko bez adresu i bez iroh.
 * A real SIGINT, SIGTERM or SIGHUP while `rarog pair` waits cancels the code through the admin socket: the line after
 * it, the exit code 128 + the signal number, a code redeemed just before, a refused or silent socket, a second signal.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PAIRING_LINK_HOST, parsePairingLink } from '@rarog/shared/pairing-link';
import type { ServerIroh } from '@rarog/shared/rest';
import {
  DEVICE_ORPHAN_MS, PAIRING_CODE_TTL_MS, createAdminHandler, createDeviceStore, createPairing, pairingLink,
  startAdminSocket,
} from '../src/auth/index.ts';
import type { AdminSocket, DeviceStore, Pairing } from '../src/auth/index.ts';
import { realRarogDirsCreated, tempHome } from './rarog-home.ts';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bin');
const CLI = path.join(BIN, 'rarog.mjs');
const HOME = tempHome('rarog-cli-home-');
const T0 = Date.parse('2026-10-21T10:00:00.000Z');
/** Start of the link `rarog pair` prints, as a regular expression; the host comes from the contract constant. */
const LINK_PREFIX = `https://${PAIRING_LINK_HOST.replaceAll('.', '\\.')}/pair#`;
/** Linia z linkiem w wyjściu `rarog pair`. */
const LINK_LINE = new RegExp(`^${LINK_PREFIX}`);
/**
 * Limit testu: test startuje `node bin/rarog.mjs` kilka razy, a jeden start CLI (tsx i moduły serwera) trwa ok.
 * 0,15 s na Macu i 0,31–0,41 s na runnerach GitHuba (zmierzone z czasów testów: siedem startów listy 2,9 s, blisko
 * domyślnych 5 s vitest); 30 s to kilkukrotny zapas nad najgorszym zmierzonym testem.
 */
const CLI_TEST_TIMEOUT_MS = 30_000;

interface Run {
  /** Czeka na linię stdout spełniającą warunek. */
  line(match: RegExp, timeoutMs?: number): Promise<string>;
  readonly done: Promise<{ code: number | null; stdout: string; stderr: string }>;
  /** Sygnał do procesu CLI (Ctrl-C = `SIGINT`). */
  kill(signal: NodeJS.Signals): void;
}

function run(args: string[]): Run {
  const child = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: HOME.env });
  let stdout = '';
  let stderr = '';
  const waiters: (() => void)[] = [];
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
    for (const wake of waiters.splice(0)) wake();
  });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    child.on('close', (code) => { resolve({ code, stdout, stderr }); });
  });
  return {
    done,
    kill: (signal) => { child.kill(signal); },
    async line(match, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const hit = stdout.split('\n').find((l) => match.test(l));
        if (hit !== undefined) return hit;
        if (Date.now() > deadline) throw new Error(`brak linii ${String(match)}; stdout:\n${stdout}\nstderr:\n${stderr}`);
        await new Promise<void>((resolve) => { waiters.push(resolve); setTimeout(resolve, 100); });
      }
    },
  };
}

let dir = '';
let clock = T0;
let store: DeviceStore;
let pairing: Pairing;
let socket: AdminSocket | null = null;
/** A test's own answer to an admin socket request; `false` passes the request to the real handler. */
let intercept: ((req: IncomingMessage, res: ServerResponse) => boolean) | null = null;

async function serve(
  { publicUrl = 'https://rarog.example.net', iroh = null }: { publicUrl?: string | null; iroh?: ServerIroh | null } = {},
): Promise<void> {
  pairing = createPairing({ store, epoch: '1', now: () => clock });
  const handler = createAdminHandler({ store, pairing, publicUrl, iroh, log: () => {}, now: () => clock });
  socket = await startAdminSocket(dir, (req, res) => {
    if (intercept?.(req, res) !== true) handler(req, res);
  }, () => {});
  if (socket === null) throw new Error('gniazdo nie wstało');
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'p2-cli-'));
  clock = T0;
  intercept = null;
  store = createDeviceStore({ dataDir: dir, epoch: '1', now: () => clock });
  await serve();
});
afterEach(async () => {
  await socket?.close();
  socket = null;
  await store.flush();
  rmSync(dir, { recursive: true, force: true });
});
afterAll(() => {
  HOME.cleanup();
  expect(realRarogDirsCreated()).toEqual([]);
});

/** Kod z linku wypisanego przez CLI. */
const codeOf = (link: string): string => /[#&]c=([A-Za-z0-9_-]{43})$/.exec(link.trim())?.[1] ?? '';

describe('rarog pair', { timeout: CLI_TEST_TIMEOUT_MS }, () => {
  it('rysuje QR, wypisuje link i kończy się „Sparowano” dopiero po pierwszym żądaniu urządzenia', async () => {
    const cli = run(['pair', '--data-dir', dir]);
    const link = await cli.line(LINK_LINE);
    expect(link).toMatch(new RegExp(`^${LINK_PREFIX}v=1&u=https%3A%2F%2Frarog\\.example\\.net&c=[A-Za-z0-9_-]{43}$`));
    // Ten sam link, który złożyłby serwer (gniazdo admin, trasa demo).
    expect(link).toBe(pairingLink('https://rarog.example.net', null, codeOf(link)));
    const label = 'iPhone·Rarog';
    const redeemed = pairing.redeem({ code: codeOf(link), label });
    if (!redeemed.ok) throw new Error('kod z CLI nie przeszedł');
    await cli.line(new RegExp(`Code used by "${label}"`));
    store.touch(redeemed.record.id);
    const result = await cli.done;
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`Paired: ${label} (${redeemed.record.id})`);
    // QR w terminalu: bloki połówkowe, kilkanaście linii.
    expect(result.stdout).toMatch(/[▀▄█]/);
    expect(result.stderr).toBe('');
  });

  it('serwer z aktywnym urządzeniem odmawia: zdanie o parowaniu z apki, kod 1', async () => {
    const issued = pairing.issue('admin');
    const redeemed = pairing.redeem({ code: issued.code, label: 'iPhone' });
    expect(redeemed.ok).toBe(true);
    const result = await run(['pair', '--data-dir', dir]).done;
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('The server already has a paired device; pair new ones from the app');
  });

  it('kod użyty, ale bez żądania przez 10 min (zgubiona odpowiedź): „sparuj ponownie”, kod 1', async () => {
    const cli = run(['pair', '--data-dir', dir]);
    const link = await cli.line(LINK_LINE);
    expect(pairing.redeem({ code: codeOf(link), label: 'iPad' }).ok).toBe(true);
    await cli.line(/Code used/);
    clock += DEVICE_ORPHAN_MS;
    const result = await cli.done;
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('did not connect within 10 min');
  });

  it('restart serwera w trakcie: oczekujące parowanie znika, CLI mówi to wprost', async () => {
    const cli = run(['pair', '--data-dir', dir]);
    await cli.line(LINK_LINE);
    await socket?.close();
    await serve();
    const result = await cli.done;
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/did it restart in the meantime|stopped responding/);
  });

  it('Ctrl-C w trakcie czekania kończy CLI kodem 130', async () => {
    const cli = run(['pair', '--data-dir', dir]);
    await cli.line(LINK_LINE);
    cli.kill('SIGINT');
    expect((await cli.done).code).toBe(130);
  });

  it('`--url` bez https: ostrzeżenie, link z podanym adresem', async () => {
    const cli = run(['pair', '--data-dir', dir, '--url', 'http://127.0.0.1:8931']);
    const link = await cli.line(LINK_LINE);
    expect(link).toContain('u=http%3A%2F%2F127.0.0.1%3A8931');
    expect(pairing.redeem({ code: codeOf(link), label: 'demo' }).ok).toBe(true);
    clock += DEVICE_ORPHAN_MS;
    const result = await cli.done;
    expect(result.stderr).toContain('is not https');
  });
});

describe('rarog pair: a signal while waiting cancels the code', { timeout: CLI_TEST_TIMEOUT_MS }, () => {
  /** Exit code after a signal: 128 + its number. */
  const EXIT = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const;
  const lines = (text: string): string[] => text.split('\n').filter((line) => line !== '');
  const isCancel = (req: IncomingMessage): boolean =>
    req.method === 'DELETE' && (req.url ?? '').startsWith('/api/admin/pairings/');
  /** The time `rarog pair` names for a code issued at the test's start time, in the same form. */
  const expiresAt = new Date(T0 + PAIRING_CODE_TTL_MS).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

  it('SIGINT, SIGTERM and SIGHUP: the code is cancelled, the line says so, exit 128 + the signal number', async () => {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
      const cli = run(['pair', '--data-dir', dir]);
      const link = await cli.line(LINK_LINE);
      cli.kill(signal);
      const result = await cli.done;
      expect(result.code, signal).toBe(EXIT[signal]);
      expect(lines(result.stderr), signal).toEqual(['pairing code cancelled']);
      // The code is dead at once: redeeming it fails, which `POST /api/pair` answers with 404.
      expect(pairing.redeem({ code: codeOf(link), label: 'iPhone' }).ok, signal).toBe(false);
    }
  });

  it('a signal as the code gets used: the server says redeemed, the line says the device is paired', async () => {
    // Polls keep answering "pending", so the CLI has not seen the redemption when the signal comes.
    intercept = (req, res) => {
      if (req.method !== 'GET') return false;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ state: 'pending', expiresAt: new Date(T0 + PAIRING_CODE_TTL_MS).toISOString() }));
      return true;
    };
    const cli = run(['pair', '--data-dir', dir]);
    const link = await cli.line(LINK_LINE);
    const redeemed = pairing.redeem({ code: codeOf(link), label: 'iPhone' });
    if (!redeemed.ok) throw new Error('code not accepted');
    cli.kill('SIGTERM');
    const result = await cli.done;
    expect(result.code).toBe(EXIT.SIGTERM);
    const said = lines(result.stderr);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/already used/);
    expect(said[0]).toMatch(/paired/);
    expect(said[0]).toContain('rarog devices');
    expect(said[0]).not.toMatch(/expire|cancel/);
    expect(store.get(redeemed.record.id)).toBeDefined();
  });

  it('the server refuses or stays silent past 2 s: the line names the expiry time, the code stays alive', async () => {
    const variants: { name: string; answer: (res: ServerResponse) => void }[] = [
      { name: '500', answer: (res) => { res.writeHead(500); res.end('{"error":"internal","message":"Server error."}'); } },
      { name: 'silent', answer: () => {} },
    ];
    for (const { name, answer } of variants) {
      intercept = (req, res) => {
        if (!isCancel(req)) return false;
        answer(res);
        return true;
      };
      const cli = run(['pair', '--data-dir', dir]);
      const link = await cli.line(LINK_LINE);
      const signalledAt = Date.now();
      cli.kill('SIGINT');
      const result = await cli.done;
      expect(result.code, name).toBe(EXIT.SIGINT);
      expect(lines(result.stderr), name).toEqual([`could not cancel the pairing code; it expires at ${expiresAt}`]);
      expect(Date.now() - signalledAt, name).toBeLessThan(6_000);
      expect(pairing.redeem({ code: codeOf(link), label: 'iPhone' }).ok, name).toBe(true);
      store.revokeAll('admin');
    }
  });

  it('a second signal while the cancel request waits ends the command at once', async () => {
    let onCancel = (): void => {};
    const cancelSent = new Promise<void>((resolve) => { onCancel = resolve; });
    intercept = (req) => {
      if (!isCancel(req)) return false;
      onCancel();
      return true;
    };
    const cli = run(['pair', '--data-dir', dir]);
    await cli.line(LINK_LINE);
    cli.kill('SIGINT');
    await cancelSent;
    cli.kill('SIGTERM');
    const result = await cli.done;
    expect(result.code).toBe(EXIT.SIGTERM);
    expect(result.stderr).toBe('');
  });

  it('after the code was used nothing cancels: no request, no line', async () => {
    const methods: string[] = [];
    intercept = (req) => {
      methods.push(req.method ?? '');
      return false;
    };
    const cli = run(['pair', '--data-dir', dir]);
    const link = await cli.line(LINK_LINE);
    expect(pairing.redeem({ code: codeOf(link), label: 'iPad' }).ok).toBe(true);
    await cli.line(/Code used/);
    cli.kill('SIGINT');
    const result = await cli.done;
    expect(result.code).toBe(EXIT.SIGINT);
    expect(result.stderr).toBe('');
    expect(methods).not.toContain('DELETE');
  });
});

describe('rarog pair: serwer iroh', { timeout: CLI_TEST_TIMEOUT_MS }, () => {
  const IROH: ServerIroh = { endpointId: 'e0'.repeat(32), relay: 'https://relay.example./' };

  /** Gniazdo z podanym adresem i serwerem iroh zamiast domyślnego. */
  async function reserve(options: { publicUrl?: string | null; iroh?: ServerIroh | null }): Promise<void> {
    await socket?.close();
    await serve(options);
  }

  /** Link z `rarog pair`, potem Ctrl-C (kod 130): test patrzy tylko na link. */
  async function linkOf(args: string[] = []): Promise<string> {
    const cli = run(['pair', '--data-dir', dir, ...args]);
    const link = await cli.line(LINK_LINE);
    cli.kill('SIGINT');
    expect((await cli.done).code).toBe(130);
    return link.trim();
  }

  it('adres i iroh: link z `u=`, `k=` i `r=`, ten sam co z `pairingLink` serwera', async () => {
    await reserve({ iroh: IROH });
    const link = await linkOf();
    expect(link).toBe(pairingLink('https://rarog.example.net', IROH, codeOf(link)));
    expect(link).toMatch(new RegExp(`^${LINK_PREFIX}v=1&u=https%3A%2F%2Frarog\\.example\\.net`
      + `&k=${IROH.endpointId}&r=https%3A%2F%2Frelay\\.example\\.%2F&c=[A-Za-z0-9_-]{43}$`));
    expect(parsePairingLink(link)).toEqual({
      ok: true, fields: { server: 'https://rarog.example.net', iroh: IROH, code: codeOf(link) },
    });
  });

  it('bez adresu HTTPS (bez RAROG_ORIGINS), z iroh: link z samym `k=`/`r=`, bez ostrzeżeń', async () => {
    await reserve({ publicUrl: null, iroh: IROH });
    const cli = run(['pair', '--data-dir', dir]);
    const link = (await cli.line(LINK_LINE)).trim();
    expect(link).toBe(`https://${PAIRING_LINK_HOST}/pair#v=1&k=${IROH.endpointId}&r=${encodeURIComponent(IROH.relay)}`
      + `&c=${codeOf(link)}`);
    expect(parsePairingLink(link)).toEqual({ ok: true, fields: { server: null, iroh: IROH, code: codeOf(link) } });
    // Link działa jak każdy inny: kod przechodzi, CLI czeka na pierwsze żądanie i kończy się „Sparowano”.
    const redeemed = pairing.redeem({ code: codeOf(link), label: 'iPhone·Rarog' });
    if (!redeemed.ok) throw new Error('kod z CLI nie przeszedł');
    store.touch(redeemed.record.id);
    const result = await cli.done;
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('`--url` z iroh: adres z flagi, `k=`/`r=` z serwera', async () => {
    await reserve({ publicUrl: null, iroh: IROH });
    const link = await linkOf(['--url', 'https://inny.example.net']);
    expect(link).toBe(pairingLink('https://inny.example.net', IROH, codeOf(link)));
  });

  it('relay change with two devices: refusal with both routes; revoking one is not enough; `revoke --all` and `pair` give the same `k` and a new `r`', async () => {
    await reserve({ publicUrl: null, iroh: IROH });
    const ids: string[] = [];
    // The first from the admin socket, the second with a code from the first (pairing from the app).
    for (const label of ['iPhone', 'iPad']) {
      const redeemed = pairing.redeem({ code: pairing.issue(ids[0] ?? 'admin').code, label });
      if (!redeemed.ok) throw new Error('code not accepted');
      ids.push(redeemed.record.id);
    }
    // The server after a change of RAROG_IROH_RELAY: the same key (EndpointId), another relay.
    const moved: ServerIroh = { endpointId: IROH.endpointId, relay: 'https://relay2.example./' };
    await reserve({ publicUrl: null, iroh: moved });
    const procedure = 'After a change of RAROG_IROH_RELAY an app that still reaches this server takes the new relay'
      + ' from it; a device that reaches it only over iroh and lost the way gets the new relay only from a new pairing'
      + ' link. If an app still reaches this server, pair the other devices'
      + ' from it: Settings → Pairing → Pair New Device. If none does, revoke them all (rarog devices revoke --all),'
      + ' run rarog pair for the first device and pair the rest from its app.';
    const refused = await run(['pair', '--data-dir', dir]).done;
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('The server already has a paired device');
    expect(refused.stderr).toContain(procedure);
    // One revoked, the other active: the server still refuses (any active device), the same sentence. The iPad goes:
    // revoking the iPhone would take the iPad with it.
    expect((await run(['devices', 'revoke', ids[1] ?? '', '--data-dir', dir]).done).code).toBe(0);
    const still = await run(['pair', '--data-dir', dir]).done;
    expect(still.code).toBe(1);
    expect(still.stderr).toContain(procedure);
    expect((await run(['devices', 'revoke', '--all', '--data-dir', dir]).done).code).toBe(0);
    const link = await linkOf();
    expect(parsePairingLink(link)).toEqual({ ok: true, fields: { server: null, iroh: moved, code: codeOf(link) } });
  });

  it('relay z serwera w innym zapisie trafia do linku w postaci kanonicznej', async () => {
    await reserve({ publicUrl: null, iroh: { endpointId: IROH.endpointId, relay: 'https://Relay.Example.:443' } });
    const link = await linkOf();
    expect(link).toContain(`&r=${encodeURIComponent('https://relay.example./')}&`);
  });

  const BAD_IROH: ServerIroh[] = [
    { endpointId: 'E0'.repeat(32), relay: IROH.relay }, { endpointId: IROH.endpointId, relay: 'http://relay.example' },
  ];

  it('zły kształt iroh z adresem: ostrzeżenie i link z samym `u=`, który apka przyjmie', async () => {
    for (const bad of BAD_IROH) {
      await reserve({ iroh: bad });
      const cli = run(['pair', '--data-dir', dir]);
      const link = (await cli.line(LINK_LINE)).trim();
      cli.kill('SIGINT');
      const result = await cli.done;
      expect(result.code, JSON.stringify(bad)).toBe(130);
      expect(link).toBe(pairingLink('https://rarog.example.net', null, codeOf(link)));
      expect(parsePairingLink(link).ok).toBe(true);
      expect(result.stderr).toContain('Warning: the server returned an iroh server in the wrong shape');
    }
  });

  it('zły kształt iroh bez adresu: odmowa, kod 1, bez linku', async () => {
    for (const bad of BAD_IROH) {
      await reserve({ publicUrl: null, iroh: bad });
      const result = await run(['pair', '--data-dir', dir]).done;
      expect(result.code, JSON.stringify(bad)).toBe(1);
      expect(result.stderr).toContain('Warning: the server returned an iroh server in the wrong shape');
      expect(result.stderr).toContain('The server does not know its address (RAROG_ORIGINS) and returned no valid iroh'
        + ' server; give the address: rarog pair --url https://…');
      expect(result.stdout.split('\n').some((line) => LINK_LINE.test(line))).toBe(false);
    }
  });

  it('bez adresu i bez iroh: odmowa z `--url`, kod 1, bez linku', async () => {
    await reserve({ publicUrl: null });
    const result = await run(['pair', '--data-dir', dir]).done;
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('The server does not know its address (RAROG_ORIGINS) and does not listen on iroh; give the'
      + ' address: rarog pair --url https://…');
    expect(result.stdout.split('\n').some((line) => LINK_LINE.test(line))).toBe(false);
  });
});

describe('rarog devices', { timeout: CLI_TEST_TIMEOUT_MS }, () => {
  it('lista, odpięcie jednego, nieznane id, `--all`', async () => {
    expect((await run(['devices', '--data-dir', dir]).done).stdout).toContain('No active devices');
    const first = pairing.redeem({ code: pairing.issue('admin').code, label: 'iPhone·Rarog' });
    if (!first.ok) throw new Error('parowanie');
    store.touch(first.record.id);
    const second = pairing.redeem({ code: pairing.issue(first.record.id).code, label: 'iPad·Rarog' });
    if (!second.ok) throw new Error('parowanie');
    const list = await run(['devices', 'list', '--data-dir', dir]).done;
    expect(list.code).toBe(0);
    expect(list.stdout).toContain('Active devices (2):');
    expect(list.stdout).toContain(`${second.record.id}  iPad·Rarog`);
    expect(list.stdout).toContain(`with a code from ${first.record.id}`);
    expect(list.stdout).toContain('no connection yet');

    const revoked = await run(['devices', 'revoke', second.record.id, '--data-dir', dir]).done;
    expect(revoked).toMatchObject({ code: 0 });
    expect(revoked.stdout).toContain(`Revoked: iPad·Rarog (${second.record.id})`);
    expect(store.tombstone(second.record.id)?.revokedBy).toBe('admin');
    const again = await run(['devices', 'revoke', second.record.id, '--data-dir', dir]).done;
    // A repeat writes devices.json again, so it also saves a revocation whose write failed (`persist-failed`).
    expect(again.code).toBe(0);
    expect(again.stdout.split('\n').filter((line) => line !== '')).toEqual([
      `Device ${second.record.id} was already revoked; the revocation is now saved to disk.`,
    ]);
    const unknown = await run(['devices', 'revoke', 'f'.repeat(32), '--data-dir', dir]).done;
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('No active device has this id');
    expect((await run(['devices', '--data-dir', dir]).done).stdout).toContain('Recently revoked (1 of 1)');

    const all = await run(['devices', 'revoke', '--all', '--data-dir', dir]).done;
    expect(all.stdout).toContain(`Revoked: iPhone·Rarog (${first.record.id})`);
    expect(store.active()).toEqual([]);
    expect((await run(['devices', 'revoke', '--all', '--data-dir', dir]).done).stdout)
      .toContain('There were no active devices');
  });

  it('a stored label with U+202E and build with ESC print without them, also as a tombstone', async () => {
    const rlo = String.fromCodePoint(0x202e);
    const esc = String.fromCodePoint(0x1b);
    const first = pairing.redeem({ code: pairing.issue('admin').code, label: 'iPhone' });
    if (!first.ok) throw new Error('code not accepted');
    const id = 'e'.repeat(32);
    store.add({ ...first.record, id, label: `iPad${rlo}evil`, build: `${esc}[2J1` });
    const list = await run(['devices', '--data-dir', dir]).done;
    expect(list.code).toBe(0);
    expect(list.stdout).toContain(`${id}  iPadevil`);
    expect(list.stdout).not.toContain(rlo);
    expect(list.stdout).not.toContain(esc);
    store.revoke(id, 'forget');
    const revoked = await run(['devices', '--data-dir', dir]).done;
    expect(revoked.stdout).toContain(`${id}  iPadevil — `);
    expect(revoked.stdout).not.toContain(rlo);
  });

  it('revoke lists the devices paired through the revoked one, with their pairing date', async () => {
    const ids: string[] = [];
    for (const label of ['iPhone·Rarog', 'iPad·Rarog', 'Mac·Rarog']) {
      const redeemed = pairing.redeem({ code: pairing.issue(ids.at(-1) ?? 'admin').code, label });
      if (!redeemed.ok) throw new Error('code not accepted');
      ids.push(redeemed.record.id);
      clock += 60_000;
    }
    const [phone = '', pad = '', desk = ''] = ids;
    const paired = (offset: number): string => new Date(T0 + offset * 60_000).toLocaleString('en-GB');
    const revoked = await run(['devices', 'revoke', phone, '--data-dir', dir]).done;
    expect(revoked.code).toBe(0);
    expect(revoked.stdout.split('\n').filter((line) => line !== '')).toEqual([
      `Revoked: iPhone·Rarog (${phone})`,
      'Revoked with it, paired through it (2):',
      `  ${pad}  iPad·Rarog — paired ${paired(1)}`,
      `  ${desk}  Mac·Rarog — paired ${paired(2)}`,
    ]);
    expect(store.active()).toEqual([]);
    expect([phone, pad, desk].map((id) => store.tombstone(id)?.revokedBy)).toEqual(['admin', 'admin', 'admin']);
  });

  it('revoke of a device that is no longer active revokes what was paired through it', async () => {
    const first = pairing.redeem({ code: pairing.issue('admin').code, label: 'iPhone·Rarog' });
    if (!first.ok) throw new Error('code not accepted');
    const second = pairing.redeem({ code: pairing.issue(first.record.id).code, label: 'iPad·Rarog' });
    if (!second.ok) throw new Error('code not accepted');
    store.revoke(first.record.id, 'forget');
    const revoked = await run(['devices', 'revoke', first.record.id, '--data-dir', dir]).done;
    expect(revoked.code).toBe(0);
    expect(revoked.stdout.split('\n').filter((line) => line !== '')).toEqual([
      `Device ${first.record.id} was no longer active.`,
      'Revoked with it, paired through it (1):',
      `  ${second.record.id}  iPad·Rarog — paired ${new Date(T0).toLocaleString('en-GB')}`,
    ]);
    expect(store.active()).toEqual([]);
  });

  it('złe wywołanie → 64; brak serwera na gnieździe → 2 ze zdaniem, co sprawdzić', async () => {
    expect((await run(['devices', 'revoke', '--data-dir', dir]).done).code).toBe(64);
    expect((await run(['devices', 'revoke', 'x', '--all', '--data-dir', dir]).done).code).toBe(64);
    expect((await run(['nieznana']).done).code).toBe(64);
    expect((await run([]).done).code).toBe(64);
    const empty = mkdtempSync(path.join(tmpdir(), 'p2-cli-pusty-'));
    try {
      const result = await run(['devices', '--data-dir', empty]).done;
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('does not answer on the socket');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('ścieżka gniazda dłuższa niż 103 B → 2 ze zdaniem o długości, bez `connect` i bez stosu', async () => {
    const deep = path.join(dir, 'x'.repeat(110));
    const result = await run(['devices', '--data-dir', deep]).done;
    expect(result.code).toBe(2);
    const socket = path.join(deep, 'run', 'admin.sock');
    expect(result.stderr).toContain(`Socket ${socket} does not exist: the path has ${String(Buffer.byteLength(socket))} B,`
      + ' and the server creates a socket of at most 103 B.');
    expect(result.stderr).not.toMatch(/\n\s+at /);
  });
});

describe('opcje przed nazwą komendy', { timeout: CLI_TEST_TIMEOUT_MS }, () => {
  it('`--data-dir` i `--url` przed `devices`/`pair` działają jak po nich', async () => {
    const first = pairing.redeem({ code: pairing.issue('admin').code, label: 'iPhone·Rarog' });
    if (!first.ok) throw new Error('parowanie');
    const before = await run(['--data-dir', dir, 'devices']).done;
    expect(before).toEqual(await run(['devices', '--data-dir', dir]).done);
    expect(before.code).toBe(0);
    expect(before.stdout).toContain(`${first.record.id}  iPhone·Rarog`);
    const refused = await run(['--url', 'https://a.example', '--data-dir', dir, 'pair']).done;
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('The server already has a paired device');
    expect((await run(['--data-dir', dir]).done).code).toBe(64);
  });
});
