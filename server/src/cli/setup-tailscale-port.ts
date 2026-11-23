/**
 * The HTTPS port of the Tailscale address for `rarog setup` (`setup-transport.ts`): one classifier of a port P for
 * picking it from the pool 8931–8960 (step 2) and for step 4. `tailscale serve status --json` says whether P is ours,
 * foreign or unmapped, and which mappings of this server Tailscale Funnel publishes; a TCP probe of P on this
 * machine's Tailscale addresses says whether another server holds it; `lsof` only names that server. It reads state
 * only: it never runs `tailscale serve` and never writes `config.json`.
 */
import { spawnSync } from 'node:child_process';
import { connect } from 'node:net';
import { errnoCode, isRecord, line } from './setup-context.ts';
import type { Ctx, TcpProbe } from './setup-context.ts';

/** How long setup waits for `tailscale` (status, serve). */
const TAILSCALE_TIMEOUT_MS = 30_000;
/** How long setup waits for `lsof`, and for the TCP probes of the ports (one deadline for all of them). */
const LSOF_TIMEOUT_MS = 10_000;
const TCP_TIMEOUT_MS = 2000;

export const tailscaleTimeout = (ctx: Ctx): number => ctx.deps.tailscaleTimeoutMs ?? TAILSCALE_TIMEOUT_MS;

/** The HTTPS ports setup offers `tailscale serve`, in order: 8931–8960 (8930, the server port, stays out). */
export const TAILSCALE_PORTS: readonly number[] = Array.from({ length: 30 }, (_unused, index) => 8931 + index);
export const POOL_TEXT = '8931–8960';

/** The HTTPS port of an address: its own port, or 443 without one. */
export const httpsPortOf = (origin: URL): number => (origin.port === '' ? 443 : Number(origin.port));

/** The command that maps HTTPS port `https` of the address to the server port (443: the form without `--https`). */
export function serveCommand(https: number, port: number): string {
  return https === 443 ? `tailscale serve --bg ${String(port)}`
    : `tailscale serve --bg --https=${String(https)} ${String(port)}`;
}

// ---------------------------------------------------------------------------
// tailscale serve status
// ---------------------------------------------------------------------------

/** `tailscale serve status --json` read once: the serve config (an empty output = `{}`), or why it cannot be read. */
export type ServeStatus = { readonly config: Readonly<Record<string, unknown>> } | { readonly failure: string };

export function readServeStatus(ctx: Ctx): ServeStatus {
  const status = spawnSync('tailscale', ['serve', 'status', '--json'], {
    env: ctx.io.env, encoding: 'utf8', timeout: tailscaleTimeout(ctx),
  });
  if (status.error !== undefined || status.status !== 0) {
    const text = (status.stderr ?? '').trim() || status.error?.message || `code ${String(status.status)}`;
    return { failure: `tailscale serve status --json: ${text}` };
  }
  const body = status.stdout.trim();
  if (body === '') return { config: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { failure: 'tailscale serve status --json: output is not JSON' };
  }
  if (!isRecord(parsed)) return { failure: 'tailscale serve status --json: unexpected shape' };
  return { config: parsed };
}

/** HTTPS port P in the serve config: mapped to this server, mapped to anything else, or not mapped at all. */
export type Mapping = 'ours' | 'foreign' | 'none';

const recordOf = (value: unknown): Readonly<Record<string, unknown>> => (isRecord(value) ? value : {});

/** The `Web` keys (`<host>:<port>`) on port `https`. */
const webKeysOn = (web: Readonly<Record<string, unknown>>, https: string): string[] =>
  Object.keys(web).filter((key) => key.slice(key.lastIndexOf(':') + 1) === https);

/**
 * Port `https` in the serve config (the structure of `ServeConfig` in Tailscale's `ipn/serve.go`, measured with
 * 1.104.6). Ours: `TCP["P"].HTTPS === true` and `Web` with one key on P, `<host>:P`, whose only handler `/` proxies to
 * `http://127.0.0.1:<port>` or `http://localhost:<port>`. Foreign: any other key on P in `TCP` or `Web`, or any key on
 * P in a foreground session (`Foreground.*.TCP`, `Foreground.*.Web`, a `tailscale serve` without `--bg`).
 */
export function mappingOf(
  config: Readonly<Record<string, unknown>>, host: string, https: number, port: number,
): Mapping {
  const key = String(https);
  for (const session of Object.values(recordOf(config['Foreground']))) {
    const one = recordOf(session);
    if (Object.hasOwn(recordOf(one['TCP']), key) || webKeysOn(recordOf(one['Web']), key).length > 0) return 'foreign';
  }
  const tcp = recordOf(config['TCP']);
  const web = recordOf(config['Web']);
  const sites = webKeysOn(web, key);
  if (!Object.hasOwn(tcp, key) && sites.length === 0) return 'none';
  const entry = recordOf(tcp[key]);
  const site = sites.length === 1 && sites[0]?.toLowerCase() === `${host}:${key}`.toLowerCase()
    ? recordOf(web[sites[0]]) : {};
  const handlers = recordOf(site['Handlers']);
  const root = recordOf(handlers['/']);
  const proxy = typeof root['Proxy'] === 'string' ? root['Proxy'].replace(/\/$/, '') : '';
  const ours = entry['HTTPS'] === true && Object.keys(handlers).length === 1
    && [`http://127.0.0.1:${String(port)}`, `http://localhost:${String(port)}`].includes(proxy);
  return ours ? 'ours' : 'foreign';
}

/**
 * The HTTPS ports whose mapping to this server (`mappingOf` ours) Tailscale Funnel publishes on the internet:
 * `AllowFunnel["<host>:<P>"] === true` in the serve config (`ServeConfig.AllowFunnel` in `ipn/serve.go`). Funnel on a
 * mapping of another site does not reach this server and does not count.
 */
export function funnelPorts(config: Readonly<Record<string, unknown>>, host: string, port: number): number[] {
  const out: number[] = [];
  for (const [key, on] of Object.entries(recordOf(config['AllowFunnel']))) {
    const at = key.lastIndexOf(':');
    const https = key.slice(at + 1);
    const onHost = at > 0 && key.slice(0, at).toLowerCase() === host.toLowerCase();
    if (on !== true || !onHost || !/^\d+$/u.test(https)) continue;
    if (mappingOf(config, host, Number(https), port) === 'ours') out.push(Number(https));
  }
  return [...new Set(out)].sort((one, other) => one - other);
}

// ---------------------------------------------------------------------------
// TCP probes and lsof
// ---------------------------------------------------------------------------

/**
 * A failed connection: refused, or the address does not exist on this machine (IPv6 off, no route), where nothing can
 * listen either; any other error proves nothing.
 */
const NO_LISTENER_CODES: ReadonlySet<string> = new Set(['ECONNREFUSED', 'EADDRNOTAVAIL', 'ENETUNREACH', 'EAFNOSUPPORT']);

export function tcpFailureOf(code: string | undefined): TcpProbe {
  return code !== undefined && NO_LISTENER_CODES.has(code) ? 'refused' : 'unknown';
}

/** A connection to `<host>:<port>`: sees a listener of any user on that address, which `lsof` without root does not. */
export function probeTcp(host: string, port: number): Promise<TcpProbe> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (result: TcpProbe): void => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(TCP_TIMEOUT_MS, () => { done('unknown'); });
    socket.once('connect', () => { done('listening'); });
    socket.once('error', (failure) => { done(tcpFailureOf(errnoCode(failure))); });
  });
}

/** One port after the probes: the Tailscale addresses that accept, or no answer from one of them, or all refused. */
type Probed = { readonly kind: 'taken'; readonly on: readonly string[] } | { readonly kind: 'unknown' | 'free' };

/**
 * TCP probes of `ports` on this machine's Tailscale addresses, all at once under one deadline: an address that
 * accepts = taken, one without an answer by then = not checked, all refused = free. An address silent on every port
 * of several proves nothing and drops out, also for later probes of the run (macOS does not answer a connection to
 * its own Tailscale IPv6 address, mapped port or not). `tailscale serve` binds (Tailscale address, port), so a server
 * on loopback only does not take the port and is not probed; no address = not checked.
 */
async function probePorts(ctx: Ctx, ports: readonly number[]): Promise<ReadonlyMap<number, Probed>> {
  const addresses = [...new Set(ctx.tailscaleIps)];
  const out = new Map<number, Probed>();
  if (addresses.length === 0) {
    for (const port of ports) out.set(port, { kind: 'unknown' });
    return out;
  }
  const probe = ctx.deps.tcpProbe ?? probeTcp;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<TcpProbe>((resolve) => {
    timer = setTimeout(() => { resolve('unknown'); }, TCP_TIMEOUT_MS);
  });
  const jobs = ports.flatMap((port) => addresses.map((address) => ({ port, address })));
  let results: TcpProbe[];
  try {
    results = await Promise.all(jobs.map(({ address, port }) => Promise.race([
      Promise.resolve().then(() => probe(address, port)).catch((): TcpProbe => 'unknown'), deadline,
    ])));
  } finally {
    clearTimeout(timer);
  }
  // Only a probe of several ports tells a silent address from a silent port; the later probes skip that address.
  const answering = new Set(jobs.filter((_, index) => results[index] !== 'unknown').map((job) => job.address));
  const silent = ports.length > 1 && answering.size > 0 ? addresses.filter((one) => !answering.has(one)) : [];
  if (silent.length > 0) {
    line(ctx, `Tailscale address ${silent.join(', ')} answered no probe; the ports go by ${[...answering].join(', ')}`);
    ctx.tailscaleIps = ctx.tailscaleIps.filter((one) => answering.has(one));
  }
  for (const port of ports) {
    const own = jobs.flatMap((job, index) =>
      (job.port === port && !silent.includes(job.address) ? [{ address: job.address, said: results[index] }] : []));
    const on = own.filter((one) => one.said === 'listening').map((one) => one.address);
    if (on.length > 0) out.set(port, { kind: 'taken', on });
    else out.set(port, { kind: own.some((one) => one.said !== 'refused') ? 'unknown' : 'free' });
  }
  return out;
}

const LOOPBACK = /^(?:127\.|\[::1\]$|localhost$)/u;

/**
 * Who listens on `ports` as `lsof` shows to this user (`-F pcn`: `p<pid>`, `c<command>`, `n<address>:<port>`):
 * port → `command (PID n)`, loopback listeners left out. Only for the reason line: without `lsof`, or when it shows
 * nothing, the port stays as the probe found it.
 */
function lsofNames(ctx: Ctx, ports: readonly number[]): ReadonlyMap<number, string> {
  const names = new Map<number, string[]>();
  if (ports.length === 0) return new Map();
  const range = `${String(Math.min(...ports))}-${String(Math.max(...ports))}`;
  const result = spawnSync('lsof', ['-nP', `-iTCP:${range}`, '-sTCP:LISTEN', '-Fpcn'], {
    env: ctx.io.env, encoding: 'utf8', timeout: LSOF_TIMEOUT_MS,
  });
  let pid = '';
  let command = '';
  for (const field of (result.stdout ?? '').split('\n')) {
    if (field.startsWith('p')) pid = field.slice(1);
    else if (field.startsWith('c')) command = field.slice(1);
    else if (field.startsWith('n')) {
      const at = field.lastIndexOf(':');
      const port = Number(field.slice(at + 1));
      if (at <= 1 || !ports.includes(port) || LOOPBACK.test(field.slice(1, at))) continue;
      const who = `${command} (PID ${pid})`;
      const list = names.get(port) ?? [];
      if (!list.includes(who)) names.set(port, [...list, who]);
    }
  }
  return new Map([...names].map(([port, list]) => [port, list.join(', ')]));
}

// ---------------------------------------------------------------------------
// The classifier
// ---------------------------------------------------------------------------

/**
 * Port P for `tailscale serve`: mapped to this server (ours), mapped to anything else (foreign), another server on a
 * Tailscale address (in use, with who), a probe without an answer or no address (not checked), or free.
 */
export type PortState = { readonly kind: 'ours' | 'foreign' | 'unknown' | 'free' }
  | { readonly kind: 'taken'; readonly who: string };

/**
 * `ports` of the address `host` for the server port `port`, by one serve status: its mapping first, then the TCP
 * probes of the unmapped ones. A status that cannot be read leaves every port not checked (and probes none).
 */
export async function classifyPorts(
  ctx: Ctx, status: ServeStatus, host: string, ports: readonly number[], port: number,
): Promise<ReadonlyMap<number, PortState>> {
  const out = new Map<number, PortState>();
  if ('failure' in status) {
    for (const one of ports) out.set(one, { kind: 'unknown' });
    return out;
  }
  const unmapped: number[] = [];
  for (const one of ports) {
    const mapping = mappingOf(status.config, host, one, port);
    if (mapping === 'none') unmapped.push(one);
    else out.set(one, { kind: mapping });
  }
  const probed = await probePorts(ctx, unmapped);
  const taken = unmapped.filter((one) => probed.get(one)?.kind === 'taken');
  const names = taken.length > 0 ? lsofNames(ctx, taken) : new Map<number, string>();
  for (const one of unmapped) {
    const result = probed.get(one) ?? { kind: 'unknown' };
    if (result.kind !== 'taken') {
      out.set(one, { kind: result.kind });
      continue;
    }
    const name = names.get(one);
    out.set(one, { kind: 'taken', who: name ?? `a process on ${result.on.join(', ')}` });
  }
  return new Map(ports.map((one) => [one, out.get(one) ?? { kind: 'unknown' }]));
}

/**
 * The Tailscale address's HTTPS port for a new `config.json`: a pool port ours already, else 443 ours already (the
 * address then has no port), else the first free pool port; or why there is none. `funnel` = the ports of this
 * server's mappings that Tailscale Funnel publishes (`funnelPorts`), from the same serve status.
 */
export type PortChoice =
  | { readonly kind: 'pool'; readonly port: number; readonly ours: boolean; readonly funnel: readonly number[] }
  | { readonly kind: 'plain'; readonly funnel: readonly number[] }
  | { readonly kind: 'none'; readonly why: string };

/** The skipped ports of the pool in one line: mapped, in use (with who), not checked. */
function skippedLine(states: readonly (readonly [number, PortState])[]): string {
  const of = (kinds: readonly string[]): (readonly [number, PortState])[] =>
    states.filter(([, state]) => kinds.includes(state.kind));
  const parts = [
    ['mapped', of(['foreign']).map(([one]) => String(one))],
    ['in use', of(['taken']).map(([one, state]) => `${String(one)} (${'who' in state ? state.who : ''})`)],
    ['not checked', of(['unknown']).map(([one]) => String(one))],
  ] as const;
  return parts.filter(([, list]) => list.length > 0).map(([name, list]) => `${name}: ${list.join(', ')}`).join('; ');
}

export async function choosePort(ctx: Ctx, host: string, port: number): Promise<PortChoice> {
  const status = readServeStatus(ctx);
  let funnel: readonly number[] = [];
  if ('failure' in status) line(ctx, status.failure);
  else {
    funnel = funnelPorts(status.config, host, port);
    // A mapping of this server already in place wins before any probe.
    const ours = TAILSCALE_PORTS.find((one) => mappingOf(status.config, host, one, port) === 'ours');
    if (ours !== undefined) return { kind: 'pool', port: ours, ours: true, funnel };
    if (mappingOf(status.config, host, 443, port) === 'ours') return { kind: 'plain', funnel };
    if (ctx.tailscaleIps.length === 0) {
      line(ctx, 'tailscale status --json lists no Tailscale IP of this machine, so no port can be checked');
    }
  }
  const states = await classifyPorts(ctx, status, host, TAILSCALE_PORTS, port);
  const free = TAILSCALE_PORTS.find((one) => states.get(one)?.kind === 'free');
  const skipped = [...states].filter(([one]) => free === undefined || one < free);
  if (skipped.length > 0) line(ctx, `tailscale serve ports skipped — ${skippedLine(skipped)}`);
  if (free !== undefined) return { kind: 'pool', port: free, ours: false, funnel };
  const count = (kind: PortState['kind']): number => [...states.values()].filter((one) => one.kind === kind).length;
  return {
    kind: 'none',
    why: `no free port in ${POOL_TEXT} for tailscale serve: ${String(count('foreign'))} mapped,`
      + ` ${String(count('taken'))} in use, ${String(count('unknown'))} not checked`,
  };
}
