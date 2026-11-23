/**
 * How the app reaches the server, as `rarog setup` sets it up. For a new `config.json` (step 2) the transport is chosen
 * before the write: iroh when this machine has the iroh native module (`RAROG_IROH=1` and the relay), and the HTTPS
 * address from `tailscale status` on a port of the pool 8931–8960 (`setup-tailscale-port.ts`: one already mapped to
 * this server, else 443 already mapped to it, which keeps the address without a port, else the first free one). No
 * port, or a failing `tailscale status`, leaves iroh only; without the iroh module that is a refusal (no transport).
 * Tailscale only (`setup-tailscale-only.ts`) leaves iroh out on any machine: `RAROG_IROH=0` with the relay, and no
 * address, HTTPS off in the tailnet, or a mapping of this server that Tailscale Funnel publishes, is a refusal too.
 * Step 4 maps the address with `tailscale serve --bg --https=<P>`, only after a question, only for a pool port taken in
 * this run (or found by `rarog setup --tailscale`, `setup-tailscale-add.ts`) and still free right before the command;
 * a foreign or unknown mapping stays untouched. An existing `config.json` keeps its transport; only `--tailscale` adds
 * the address to one without it. Tailscale says why it is left out (logged out, stopped, not running), HTTPS off in
 * the tailnet stops step 4 before `serve`, and a `serve` that exits 0 counts only with the mapping in place, because
 * the client exits 0 without mapping anything when a feature is off in the tailnet.
 */
import { spawnSync } from 'node:child_process';
import { isIP } from 'node:net';
import path from 'node:path';
import { IROH_ENV, IROH_RELAY_ENV } from '../config-env.ts';
import { irohModuleInfo } from '../iroh/adapter.ts';
import { describeModule } from './doctor.ts';
import type { IrohModuleRead } from './doctor.ts';
import { onPath } from './restart.ts';
import { CONFIG_FILENAME, rarogConfigDir } from './serve.ts';
import {
  SCREEN_TITLE, configPort, confirm, declinedStep, entry, errnoCode, isRecord, line, waitingStep,
} from './setup-context.ts';
import type { Ctx, Step, TailscaleDown, TailscaleStatus } from './setup-context.ts';
import {
  POOL_TEXT, TAILSCALE_PORTS, choosePort, classifyPorts, httpsPortOf, mappingOf, readServeStatus, serveCommand,
  tailscaleTimeout,
} from './setup-tailscale-port.ts';

/**
 * `BackendState` values that leave Tailscale out of this run; `NeedsMachineAuth` waits for an admin
 * like a logged-out client waits for a login. Any other value (`Running`, `Starting`, `NoState`) goes on to the
 * address.
 */
const BACKEND_DOWN: Readonly<Record<string, TailscaleDown>> = {
  NeedsLogin: 'logged out', NeedsMachineAuth: 'logged out', Stopped: 'stopped',
};

/**
 * HTTPS off in the tailnet, each field its own proof: `CertDomains` present and empty (or `null`), or `Self.CapMap`
 * an object without the `https` key (`CapMap` is `omitempty` in the client's output, so its absence proves nothing).
 * Neither field = a client of another version, and setup goes on as before.
 */
function httpsOff(status: Record<string, unknown>, self: Record<string, unknown>): boolean {
  const domains = status['CertDomains'];
  const noDomains = Object.hasOwn(status, 'CertDomains')
    && (domains === null || (Array.isArray(domains) && domains.length === 0));
  const caps = self['CapMap'];
  return noDomains || (isRecord(caps) && !Object.hasOwn(caps, 'https'));
}

/**
 * The address from `tailscale status --json` (`Self.DNSName` without the trailing dot) with this machine's Tailscale
 * IPs (`Self.TailscaleIPs`, valid ones only) and whether HTTPS is off in the tailnet, or why there is no address: the
 * client's `BackendState` first (a stopped client still has its DNS name), a call that fails = the daemon does not
 * answer.
 */
export function tailscaleOrigin(ctx: Ctx): TailscaleStatus {
  const result = spawnSync('tailscale', ['status', '--json'], {
    env: ctx.io.env, encoding: 'utf8', timeout: tailscaleTimeout(ctx),
  });
  if (result.error !== undefined || result.status !== 0) {
    const stderr = (result.stderr ?? '').trim();
    const said = result.error?.message ?? (stderr === '' ? `code ${String(result.status)}` : stderr);
    return { failure: `tailscale status --json: ${said}`, down: 'not running' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return { failure: 'tailscale status --json: output is not JSON', down: null };
  }
  const status = isRecord(parsed) ? parsed : {};
  const backend = status['BackendState'];
  const down = typeof backend === 'string' && Object.hasOwn(BACKEND_DOWN, backend) ? BACKEND_DOWN[backend] : undefined;
  if (down !== undefined) {
    return { failure: `tailscale status --json: BackendState ${String(backend)} (${down})`, down };
  }
  const self = isRecord(status['Self']) ? status['Self'] : {};
  const dns = typeof self['DNSName'] === 'string' ? self['DNSName'].replace(/\.$/, '') : '';
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(dns)) {
    const failure = 'tailscale status --json: no Self.DNSName (is the machine logged in to the tailnet?)';
    return { failure, down: null };
  }
  const listed = Array.isArray(self['TailscaleIPs']) ? self['TailscaleIPs'] : [];
  const ips = listed.filter((ip): ip is string => typeof ip === 'string' && isIP(ip) !== 0);
  return { origin: `https://${dns.toLowerCase()}`, ips, httpsOff: httpsOff(status, self) };
}

/** Native iroh module from the manifests (the `describeModule` of `rarog doctor`): ready, or why not. */
function irohModuleOf(ctx: Ctx): { readonly ready: boolean; readonly text: string } {
  let info: IrohModuleRead;
  try {
    info = (ctx.deps.irohModule ?? irohModuleInfo)();
  } catch (failure) {
    info = { failure: failure instanceof Error ? failure.message : String(failure) };
  }
  return describeModule(info);
}

/**
 * Transport tools of the tools check (step 1): `tailscale` in PATH and the iroh native module go to the context.
 * Only a new `config.json` needs a transport (an existing one stays, and `rarog doctor` checks its module), so only
 * then there are detail lines. The check runs before the plan screen, so the lines come back for the step to write.
 * `missing` = the missing item (its name, fix and detail line), or `null`: without the iroh module
 * `tailscale` is required, and in a terminal a logged-out or stopped Tailscale counts as missing too, so the
 * first setup stops before its plan. That read serves only the refusal: step 2 reads the state again after the plan
 * question, because the client can change (another tailnet, another name) while the question waits.
 */
export function transportTools(ctx: Ctx): {
  readonly lines: readonly string[];
  readonly missing: { readonly name: string; readonly fix: string; readonly text: string } | null;
} {
  ctx.tailscale = onPath('tailscale', ctx.io.env);
  ctx.iroh = irohModuleOf(ctx);
  if (entry(path.join(rarogConfigDir(ctx.io.env), CONFIG_FILENAME)) !== 'missing') return { lines: [], missing: null };
  const lines = [ctx.iroh.ready ? `iroh: ${ctx.iroh.text}`
    : `iroh: no native module on this machine (${ctx.iroh.text}) — the server address comes from Tailscale`];
  const why = 'this machine has no iroh native module, so the server address comes from tailscale status';
  if (ctx.iroh.ready) return { lines, missing: null };
  if (!ctx.tailscale) {
    const fix = 'install Tailscale (no iroh native module on this machine)';
    return { lines, missing: { name: 'tailscale', fix, text: `tailscale — ${why}` } };
  }
  // Without a terminal nothing is written anyway; the Tools step reports the tools alone.
  if (ctx.ask === null) return { lines, missing: null };
  const status = tailscaleOrigin(ctx);
  if (!('failure' in status) || (status.down !== 'logged out' && status.down !== 'stopped')) {
    return { lines, missing: null };
  }
  const fix = status.down === 'logged out' ? 'log in to Tailscale (tailscale up)' : 'start Tailscale (tailscale up)';
  return {
    lines,
    missing: {
      name: status.down === 'logged out' ? 'a logged-in Tailscale' : 'a running Tailscale',
      fix, text: `${status.failure} — ${why}`,
    },
  };
}

/** `RAROG_IROH=1` in `config.json` (existing or created in step 2). */
export const irohConfigured = (ctx: Ctx): boolean => (ctx.config?.env[IROH_ENV] ?? '').trim() === '1';

/** How the plan, the detail lines and the step summaries name Tailscale only (`setup-tailscale-only.ts`). */
export const TAILSCALE_ONLY_CHOSEN = 'Tailscale only (chosen)';

/** Transport of a new `config.json`: iroh, Tailscale or both. */
export interface TransportPlan {
  readonly iroh: boolean;
  readonly tailscale: boolean;
  /** Tailscale only (`ctx.tailscaleOnly`): `RAROG_IROH=0` with this relay kept for a switch back; `null` = not chosen. */
  readonly tailscaleOnly: { readonly relay: string } | null;
}

/**
 * Transport of a new `config.json`, chosen before the question from step 1 (`ctx.iroh`, `ctx.tailscale`) and the
 * Tailscale only choice (`ctx.tailscaleOnly`, which leaves iroh out). `null` = neither, the line says so and the step
 * stays missing. `--iroh-relay` without iroh gets a warning.
 */
export function chooseTransport(ctx: Ctx): TransportPlan | null {
  const only = ctx.tailscaleOnly;
  const iroh = ctx.iroh.ready && only === null;
  if (!iroh && !ctx.tailscale) {
    line(ctx, only === null
      ? 'transport: no iroh native module on this machine and no tailscale in PATH — install Tailscale'
      : `transport: ${TAILSCALE_ONLY_CHOSEN} and no tailscale in PATH — install Tailscale`);
    return null;
  }
  if (ctx.irohRelayGiven && !iroh) {
    line(ctx, `WARNING: --iroh-relay ignored: ${only === null ? 'no iroh native module on this machine'
      : TAILSCALE_ONLY_CHOSEN}`);
  }
  return { iroh, tailscale: ctx.tailscale, tailscaleOnly: only };
}

/** The plan before the question; `key` = what happens to the iroh server key (printed with the iroh line). */
export function printTransportPlan(ctx: Ctx, plan: TransportPlan, key: string): void {
  if (plan.iroh) line(ctx, `transport iroh: ${IROH_ENV}=1, relay ${ctx.irohRelay}; the server key ${key}`);
  if (plan.tailscaleOnly !== null) {
    line(ctx, `transport: ${TAILSCALE_ONLY_CHOSEN}; ${IROH_ENV}=0, relay ${plan.tailscaleOnly.relay} kept for a switch`
      + ' back to iroh');
  }
  if (!plan.tailscale) {
    line(ctx, 'no tailscale in PATH: no HTTPS address (RAROG_ORIGINS); the app connects over iroh only');
    return;
  }
  line(ctx, `transport Tailscale: RAROG_ORIGINS from tailscale status on a free port in ${POOL_TEXT}, then tailscale`
    + (plan.iroh ? ' serve (step 4); otherwise iroh only' : ' serve (step 4)'));
}

/**
 * What `config.json` gets after the question: the address, or `null` (iroh only), or a refusal (no transport): its
 * summary sentence, and for the step screen a shorter result with the `Fix:` line when the refusal has them.
 */
type OriginChoice = { readonly origin: string | null }
  | { readonly failure: string; readonly result?: string; readonly fix?: string };

/**
 * Tailscale only with a mapping of this server that Tailscale Funnel publishes: the server would be public on the
 * internet, so no `config.json`. Setup leaves the mapping and Funnel as they are; the fix turns Funnel off.
 */
function funnelRefusal(origin: string, ports: readonly number[], noTransport: string): OriginChoice {
  const addresses = ports.map((one) => (one === 443 ? origin : `${origin}:${String(one)}`));
  const result = `Tailscale Funnel makes ${addresses.join(' and ')} public on the internet`;
  const off = ports.map((one) => `tailscale funnel --https=${String(one)} off`).join(' && ');
  const fix = `${off}, then rarog setup`;
  return { failure: `${result}; ${noTransport}; ${fix}`, result, fix };
}

/** iroh only: the reason goes to the output now and to the step 4 summary (`ctx.transportNote`). */
function irohOnly(ctx: Ctx, why: string): OriginChoice {
  line(ctx, `${why} — no Tailscale address (RAROG_ORIGINS); the app connects over iroh`);
  ctx.transportNote = why;
  return { origin: null };
}

/**
 * After the question, before any write: the HTTPS address from `tailscale status` with the port `choosePort` gives
 * (the table in the module header), `null` = iroh only. Without the iroh module a failure is a refusal with the whole
 * summary sentence. The address of this run lets step 4 run `tailscale serve`. The state is read here, after the plan
 * question, and kept for step 4 (its reason when Tailscale is left out, HTTPS off, the Tailscale IPs to probe).
 */
export async function transportOrigin(ctx: Ctx, plan: TransportPlan): Promise<OriginChoice> {
  if (!plan.tailscale) return { origin: null };
  const noTransport = `no transport: ${plan.tailscaleOnly === null ? 'this machine has no iroh native module'
    : TAILSCALE_ONLY_CHOSEN}`;
  const found = tailscaleOrigin(ctx);
  ctx.tailscaleStatus = found;
  if ('failure' in found) {
    return plan.iroh
      ? irohOnly(ctx, found.failure)
      : { failure: `${found.failure}; start Tailscale (tailscale up), then rarog setup again` };
  }
  // Tailscale only with HTTPS off in the tailnet: step 4 could not map the address, and nothing else reaches the
  // server, so no config.json.
  if (plan.tailscaleOnly !== null && found.httpsOff) {
    return {
      failure: `HTTPS is off in your tailnet; ${noTransport}; enable HTTPS in the Tailscale admin console, then`
        + ' rarog setup again',
    };
  }
  ctx.tailscaleIps = found.ips;
  const choice = await choosePort(ctx, new URL(found.origin).hostname, configPort(ctx));
  if (choice.kind === 'none') return plan.iroh ? irohOnly(ctx, choice.why) : { failure: `${choice.why}; ${noTransport}` };
  // Tailscale only promises a server reachable only in the tailnet; Funnel on any mapping of it breaks that.
  if (plan.tailscaleOnly !== null && choice.funnel.length > 0) {
    return funnelRefusal(found.origin, choice.funnel, noTransport);
  }
  const origin = choice.kind === 'plain' ? found.origin : `${found.origin}:${String(choice.port)}`;
  ctx.originFromTailscale = origin;
  const mapped = choice.kind === 'plain' || choice.ours ? ' (tailscale serve maps it to this server already)' : '';
  line(ctx, `server address: ${origin}${mapped}`);
  return { origin };
}

/**
 * `config.json` env of a new file: the transport entries around `base`, `RAROG_ORIGINS` first and the iroh ones
 * last. The UDP port (`RAROG_IROH_PORT`) stays with the port the system gives: a fixed port is the owner's firewall
 * rule. Tailscale only writes `RAROG_IROH=0` with the relay, so a switch back to iroh changes one value.
 */
export function transportEnv(
  ctx: Ctx, plan: TransportPlan, origin: string | null, base: Readonly<Record<string, string>>,
): Record<string, string> {
  const iroh: Record<string, string> = plan.iroh ? { [IROH_ENV]: '1', [IROH_RELAY_ENV]: ctx.irohRelay }
    : plan.tailscaleOnly === null ? {} : { [IROH_ENV]: '0', [IROH_RELAY_ENV]: plan.tailscaleOnly.relay };
  return {
    ...(origin === null ? {} : { RAROG_ORIGINS: origin }),
    ...base,
    ...iroh,
  };
}

// ---------------------------------------------------------------------------
// Step 4: tailscale serve
// ---------------------------------------------------------------------------

/** The first entry of `RAROG_ORIGINS` in `config.json`: the address step 4 judges. */
export function firstOrigin(ctx: Ctx): string | null {
  const raw = ctx.config?.env.RAROG_ORIGINS ?? '';
  const first = raw.split(',').map((part) => part.trim()).find((part) => part !== '');
  return first ?? null;
}

/**
 * `Fix:` when HTTPS is off in the tailnet: the serve command itself, because the next setup finds an
 * existing `config.json` and does not run `serve` (the same fix as for an existing one without a mapping).
 */
const httpsFix = (command: string): string => `enable HTTPS in the Tailscale admin console, then ${command}`;
/** `Fix:` of a `tailscale serve` that failed for a reason setup does not recognise: the state, then setup again. */
const SERVE_STATUS_FIX = 'tailscale serve status, then rarog setup';

export async function stepTailscale(ctx: Ctx): Promise<Step> {
  const title = 'tailscale serve';
  const origin = firstOrigin(ctx);
  if (origin === null && irohConfigured(ctx)) {
    line(ctx, 'not used: config.json has no RAROG_ORIGINS, the app connects over iroh');
    const note = ctx.transportNote === null ? '' : `; ${ctx.transportNote}`;
    const summary = `tailscale serve: not used (iroh only${note})`;
    // A config.json created now without Tailscale is news (`–`; the reason stays in the log), and
    // Tailscale's own state says why when it is the reason; one from before is the steady state, without a line
    // of its own.
    const status = ctx.tailscaleStatus;
    const down = status !== null && 'failure' in status ? status.down : null;
    return ctx.configCreated
      ? { title, state: 'info', summary, result: `${down ?? 'not used'} (iroh only)`, skipped: true }
      : { title, state: 'info', summary };
  }
  if (origin === null) {
    line(ctx, 'skipped: no address (config.json first)');
    if (ctx.config === null) {
      return waitingStep(title, 'info', 'tailscale serve: depends on config.json', ctx.configWaits ?? SCREEN_TITLE.config);
    }
    return { title, state: 'info', summary: 'tailscale serve: depends on config.json' };
  }
  let url: URL | null = null;
  try {
    url = new URL(origin);
  } catch {
    url = null;
  }
  if (url === null || !url.hostname.endsWith('.ts.net')) {
    line(ctx, `not applicable: ${origin} is not a Tailscale address (your own proxy provides HTTPS)`);
    return { title, state: 'ok', summary: 'tailscale serve: not applicable' };
  }
  const port = configPort(ctx);
  const https = httpsPortOf(url);
  const command = serveCommand(https, port);
  if (!ctx.tailscale) {
    line(ctx, `tailscale not in PATH; after installing it: ${command}`);
    // A `!` says what is missing in one sentence; the command stands in Fix:.
    return {
      title, state: 'missing', summary: `tailscale serve: ${command}`, result: 'tailscale not in PATH',
      fix: `install Tailscale, then ${command}`,
    };
  }
  // Only HTTPS port P of the address counts (`mappingOf`): mappings on other ports belong to other sites.
  const status = readServeStatus(ctx);
  if ('failure' in status) {
    line(ctx, status.failure);
    return {
      title, state: 'problem',
      summary: `tailscale serve: state unknown; check tailscale serve status, then ${command}`,
    };
  }
  const mapping = mappingOf(status.config, url.hostname, https, port);
  if (mapping === 'ours') {
    line(ctx, `mapping ${url.host} → port ${String(port)}: present`);
    return { title, state: 'ok', summary: `tailscale serve: mapping to port ${String(port)}` };
  }
  if (mapping === 'foreign') {
    line(ctx, `tailscale serve has a mapping other than ${url.host} → port ${String(port)} — leaving it alone`);
    return {
      title, state: 'problem',
      summary: `tailscale serve: foreign mapping; check tailscale serve status, then ${command}`,
    };
  }
  // No mapping on P. Setup runs `serve` itself only for an address with a pool port from `tailscale status` taken in
  // THIS run (a new `config.json`, or `--tailscale`); any other address gets the command.
  const missing: Step = {
    title, state: 'missing', summary: `tailscale serve: ${command}`, result: 'no mapping to this server', fix: command,
  };
  if (ctx.originFromTailscale !== origin || !TAILSCALE_PORTS.includes(https)) {
    line(ctx, `no mapping; run: ${command}`);
    return missing;
  }
  if (ctx.ask === null) return missing;
  // HTTPS off in the tailnet: the client would print an address to enable it and exit 0 (or wait), mapping nothing,
  // so setup says it before the question and does not run serve.
  const read = ctx.tailscaleStatus;
  if (read !== null && 'httpsOff' in read && read.httpsOff) {
    line(ctx, 'HTTPS is off in this tailnet (tailscale status --json: no CertDomains or no https in Self.CapMap)'
      + ` — not running ${command}`);
    return {
      title, state: 'problem', summary: `tailscale serve: HTTPS is off in your tailnet; ${httpsFix(command)}`,
      result: 'HTTPS is off in your tailnet', fix: httpsFix(command),
    };
  }
  if (!await confirm(ctx, `Run ${command}?`)) return { ...missing, ...declinedStep(command) };
  // Port P again, right before serve, with the classifier of step 2: a mapping made during the question (a second
  // setup, a manual `tailscale serve`) changes nothing, and a server that took P on a Tailscale address since step 2
  // would lose its tailnet traffic to `serve`. Only a still free port goes on.
  const again = readServeStatus(ctx);
  const now = (await classifyPorts(ctx, again, url.hostname, [https], port)).get(https) ?? { kind: 'unknown' };
  if ('failure' in again || now.kind === 'ours' || now.kind === 'foreign') {
    line(ctx, 'tailscale serve state changed during the question — changing nothing (tailscale serve status)');
    return {
      title, state: 'problem', summary: 'tailscale serve: state changed meanwhile; run rarog setup again',
    };
  }
  if (now.kind === 'taken') {
    line(ctx, `port ${String(https)} is in use by ${now.who} now — not running ${command}, it would take the port's`
      + ' tailnet traffic');
    return {
      title, state: 'problem', summary: `tailscale serve: port ${String(https)} is in use; free it, then ${command}`,
    };
  }
  if (now.kind === 'unknown') {
    line(ctx, `port ${String(https)} not checked now (a TCP probe on a Tailscale address got no answer) — not running`
      + ` ${command}`);
    return {
      title, state: 'problem',
      summary: `tailscale serve: port ${String(https)} not checked; check who listens on port ${String(https)}, then`
        + ` ${command}`,
    };
  }
  const args = https === 443 ? [String(port)] : [`--https=${String(https)}`, String(port)];
  const served = spawnSync('tailscale', ['serve', '--bg', ...args], {
    env: ctx.io.env, encoding: 'utf8', timeout: tailscaleTimeout(ctx),
  });
  // Verbatim, stdout and stderr: the client prints its reason on either (`--operator` on Linux without root on
  // stderr, the address that enables a feature off in the tailnet on stdout).
  const output = `${served.stdout ?? ''}${served.stderr ?? ''}${served.error?.message ?? ''}`.trimEnd();
  const message = output === '' ? [] : output.split('\n');
  const timedOut = errnoCode(served.error) === 'ETIMEDOUT';
  const outcome = timedOut ? 'timed out' : 'failed';
  if (served.error !== undefined || served.status !== 0) {
    line(ctx, `${command} ${outcome}:`);
    for (const text of message) line(ctx, `  ${text}`);
    // The step screen hides the lines above, so without a run log its line carries the message itself.
    const said = message.map((text) => text.trim()).filter((text) => text !== '').join(' ');
    // One sentence on the screen; tailscale's own message stays in the lines above (the run log). The
    // reason is not recognised here, so the fix points at the state, not at the command that failed.
    return {
      title, state: 'problem', summary: `${command} ${outcome} (message above)`,
      result: said === '' || ctx.view.log.path !== null ? `${command} ${outcome}` : `${command} ${outcome}: ${said}`,
      fix: SERVE_STATUS_FIX,
    };
  }
  line(ctx, `${command}: exit 0`);
  for (const text of message) line(ctx, `  ${text}`);
  // Exit 0 is not a mapping: with a feature off the client prints where to enable it and exits 0.
  const after = readServeStatus(ctx);
  const result = 'failure' in after ? after.failure : mappingOf(after.config, url.hostname, https, port);
  if (result !== 'ours') {
    line(ctx, `tailscale serve status shows no mapping ${url.host} → port ${String(port)} after ${command}`
      + ` (${result === 'none' ? 'empty' : result})`);
    return {
      title, state: 'problem',
      summary: `tailscale serve: no mapping after ${command} (message above); ${SERVE_STATUS_FIX}`,
      result: `${command} added no mapping`, fix: SERVE_STATUS_FIX,
    };
  }
  return { title, state: 'ok', summary: `tailscale serve: mapping to port ${String(port)}`, changed: true };
}
