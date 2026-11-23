/**
 * `rarog setup --tailscale`: an existing `config.json` without an address (`RAROG_ORIGINS` empty, blank or only
 * entries the server skips) gets the Tailscale address on a port of the pool (`choosePort`), as an item of the plan
 * screen and only after its "y"; the write adds the address in front of `RAROG_ORIGINS` and keeps every other byte
 * (`replaceConfig`, under the Rarog lock). Step 4 then maps it with `tailscale serve`, as for an address of a new
 * `config.json`; so does a run that finds a pool address of this machine in the file (one written before the run was
 * cut short). It restarts nothing: the closing notes say how the server and the paired devices get the address.
 */
import path from 'node:path';
import { DEFAULT_PORT, parseOrigins } from '../config/listen.ts';
import { rarogCli, repairCommands, shellQuote } from '../install/repair.ts';
import { CONFIG_WRITES, NOTHING_CHANGED, readSetupConfig, replaceConfig } from './config-rewrite.ts';
import type { ConfigWrites } from './config-rewrite.ts';
import { Refusal } from './io.ts';
import { CONFIG_FILENAME, rarogConfigDir, readRarogConfig } from './serve.ts';
import type { RarogConfig } from './serve.ts';
import { configPort, line } from './setup-context.ts';
import type { Ctx, Step } from './setup-context.ts';
import { tilde } from './setup-plan.ts';
import type { PlanEntry } from './setup-plan.ts';
import { underLock } from './setup-secrets.ts';
import { TAILSCALE_PORTS, choosePort, httpsPortOf } from './setup-tailscale-port.ts';
import { firstOrigin, stepTailscale, tailscaleOrigin } from './setup-transport.ts';

const TITLE = 'tailscale serve';
const ORIGINS = 'RAROG_ORIGINS';
/** `args` of a `rarog` command for this installation, with the run's `--data-dir` when it had one. */
const cliFor = (ctx: Ctx, args: string): string => rarogCli(
  ctx.dataDirFlag === null ? args : `${args} --data-dir ${shellQuote(ctx.dataDirFlag)}`, ctx.mode);
/** The command that offers the address again. */
const again = (ctx: Ctx): string => cliFor(ctx, 'setup --tailscale');

/** What the run does with `--tailscale`, decided before the plan screen. */
type Found =
  /** No usable `config.json` before the plan: the flag adds nothing; why goes to the log. */
  | { readonly kind: 'skip'; readonly why: string }
  /** The file has an address already. */
  | { readonly kind: 'present'; readonly origin: string }
  /** Nothing to add now: the step reports it (Tailscale not usable, no free port, no terminal). */
  | { readonly kind: 'step'; readonly step: Step }
  /** The address the plan screen offers. */
  | { readonly kind: 'add'; readonly origin: string };

/** The addresses the server takes from a `RAROG_ORIGINS` value (an entry it skips is no address). */
function addressesOf(raw: string | undefined): readonly string[] {
  try {
    return parseOrigins(raw, false, DEFAULT_PORT, true).allowed;
  } catch {
    return [];
  }
}

const problem = (summary: string, result: string, fix: string): Step => ({
  title: TITLE, state: 'problem', summary: `${TITLE}: ${summary}`, result, fix,
});

/**
 * The address for this machine now: `tailscale status` (its state kept for step 4: the Tailscale IPs to probe, HTTPS
 * off), then the port `choosePort` gives for the server port `port`; or the step that says why there is none.
 */
async function chooseAddress(ctx: Ctx, port: number): Promise<{ readonly origin: string } | { readonly step: Step }> {
  if (!ctx.tailscale) {
    line(ctx, `--tailscale: tailscale not in PATH; ${NOTHING_CHANGED} in ${CONFIG_FILENAME}`);
    return { step: problem(`tailscale not in PATH; install Tailscale, then ${again(ctx)}`, 'tailscale not in PATH',
      `install Tailscale, then ${again(ctx)}`) };
  }
  const found = tailscaleOrigin(ctx);
  ctx.tailscaleStatus = found;
  if ('failure' in found) {
    line(ctx, `--tailscale: ${found.failure}; ${NOTHING_CHANGED} in ${CONFIG_FILENAME}`);
    const fix = found.down === 'logged out' ? `log in to Tailscale (tailscale up), then ${again(ctx)}`
      : found.down === null ? `check tailscale status, then ${again(ctx)}`
        : `start Tailscale (tailscale up), then ${again(ctx)}`;
    return { step: problem(`${found.failure}; ${fix}`, `Tailscale ${found.down ?? 'gives no address'}`, fix) };
  }
  if (found.httpsOff) {
    line(ctx, '--tailscale: HTTPS is off in this tailnet (tailscale status --json: no CertDomains or no https in'
      + ` Self.CapMap); ${NOTHING_CHANGED} in ${CONFIG_FILENAME}`);
    const fix = `enable HTTPS in the Tailscale admin console, then ${again(ctx)}`;
    return { step: problem(`HTTPS is off in your tailnet; ${fix}`, 'HTTPS is off in your tailnet', fix) };
  }
  ctx.tailscaleIps = found.ips;
  const choice = await choosePort(ctx, new URL(found.origin).hostname, port);
  if (choice.kind === 'none') {
    line(ctx, `--tailscale: ${choice.why}; ${NOTHING_CHANGED} in ${CONFIG_FILENAME}`);
    const fix = `free a port of ${TAILSCALE_PORTS[0] ?? ''}–${TAILSCALE_PORTS.at(-1) ?? ''} (tailscale serve status),`
      + ` then ${again(ctx)}`;
    return { step: problem(choice.why, choice.why.split(':')[0] ?? choice.why, fix) };
  }
  return { origin: choice.kind === 'plain' ? found.origin : `${found.origin}:${String(choice.port)}` };
}

/** `RAROG_PORT` of `config` as step 4 reads it (`configPort`). */
const portOf = (config: RarogConfig): number => configPort({ config });

/** `--tailscale` of one run: the plan item, step 4 and the closing notes. */
export interface TailscaleAddress {
  /** Before the plan screen: the item for the address, or none. */
  plan(): Promise<PlanEntry[]>;
  /** Step 4: the address written after the plan's "y", then `tailscale serve` (`stepTailscale`). */
  step(): Promise<Step>;
  /** After the steps: how the server and the paired devices get the address, when this run wrote or finished it. */
  notes(): void;
}

export function tailscaleAddress(ctx: Ctx, writes: ConfigWrites = CONFIG_WRITES): TailscaleAddress {
  const file = path.join(rarogConfigDir(ctx.io.env), CONFIG_FILENAME);
  let found: Found = { kind: 'skip', why: 'not read' };
  let written = false;
  /** A pool address of this machine found in the file: a run cut short after the write is being finished. */
  let resumed = false;

  /** The address of a `config.json` that has one: step 4 may run `serve` for a pool address of this machine. */
  const adopt = (): void => {
    const origin = firstOrigin(ctx);
    if (origin === null || ctx.ask === null || !ctx.tailscale) return;
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      return;
    }
    if (!url.hostname.endsWith('.ts.net') || !TAILSCALE_PORTS.includes(httpsPortOf(url))) return;
    const status = tailscaleOrigin(ctx);
    ctx.tailscaleStatus = status;
    if ('failure' in status) {
      line(ctx, `--tailscale: ${status.failure}`);
      return;
    }
    ctx.tailscaleIps = status.ips;
    if (new URL(status.origin).hostname !== url.hostname) {
      line(ctx, `--tailscale: ${origin} is not this machine's Tailscale name (${status.origin}); setup does not run`
        + ' tailscale serve for it');
      return;
    }
    ctx.originFromTailscale = origin;
  };

  /** A refused write: by hand for a file in another layout, otherwise the flag again. */
  const refusedStep = (why: string, origin: string): Step => {
    line(ctx, why);
    const fix = why.includes('by hand') ? `set "${ORIGINS}": "${origin}" in ${tilde(file, ctx.home)} by hand, then`
      + ` ${repairCommands(ctx.mode, ctx.installRoot).restart}` : again(ctx);
    return problem(`address not added: ${why}`, `address not added (${CONFIG_FILENAME} unchanged)`, fix);
  };

  /** Writes the address under the Rarog lock; the step that says why not, or `null` when written. */
  const write = (origin: string): Step | null => {
    const done = underLock(ctx, () => {
      const { first, parsed, env } = readSetupConfig(file, ctx.io.env, `"${ORIGINS}": "${origin}"`);
      const raw = typeof env[ORIGINS] === 'string' ? env[ORIGINS] : undefined;
      if (addressesOf(raw).length > 0) {
        throw new Refusal(`${file} has an address in ${ORIGINS} now; ${NOTHING_CHANGED}.`);
      }
      const kept = (raw ?? '').split(',').map((one) => one.trim()).filter((one) => one !== '');
      replaceConfig(first, { ...parsed, env: { ...env, [ORIGINS]: [origin, ...kept].join(',') } }, writes,
        'the Tailscale address');
      return 'written' as const;
    });
    return done === 'written' ? null : refusedStep(done.problem, origin);
  };

  return {
    async plan() {
      let config: RarogConfig | null;
      try {
        config = readRarogConfig(ctx.io.env);
      } catch (failure) {
        if (!(failure instanceof Refusal)) throw failure;
        found = { kind: 'skip', why: `${CONFIG_FILENAME} cannot be read` };
        return [];
      }
      if (config === null) {
        found = { kind: 'skip', why: `no ${CONFIG_FILENAME} yet; this run creates one with the transport it finds` };
        return [];
      }
      const present = addressesOf(config.env[ORIGINS]);
      if (present[0] !== undefined) {
        found = { kind: 'present', origin: present[0] };
        return [];
      }
      if (ctx.ask === null) {
        found = {
          kind: 'step',
          step: {
            title: TITLE, state: 'missing',
            summary: `${TITLE}: ${CONFIG_FILENAME} has no address; run ${again(ctx)} in a terminal`,
            result: 'no address (--tailscale asks in a terminal)', fix: `run ${again(ctx)} in a terminal`,
          },
        };
        return [];
      }
      const chosen = await chooseAddress(ctx, portOf(config));
      if ('step' in chosen) {
        found = { kind: 'step', step: chosen.step };
        return [];
      }
      // A file the writer refuses (another layout) gets no item: the step says what to set by hand.
      try {
        readSetupConfig(file, ctx.io.env, `"${ORIGINS}": "${chosen.origin}"`);
      } catch (failure) {
        if (!(failure instanceof Refusal)) throw failure;
        found = { kind: 'step', step: refusedStep(failure.message, chosen.origin) };
        return [];
      }
      found = { kind: 'add', origin: chosen.origin };
      return [{ item: 'tailscale', what: `Tailscale address in ${CONFIG_FILENAME}`, where: chosen.origin }];
    },

    async step() {
      const before = found;
      switch (before.kind) {
        case 'skip':
          ctx.view.note(`--tailscale adds nothing: ${before.why}.`);
          return stepTailscale(ctx);
        case 'present':
          ctx.view.note(`${CONFIG_FILENAME} already has an address (${before.origin}); --tailscale adds nothing.`);
          adopt();
          resumed = ctx.originFromTailscale === before.origin;
          return stepTailscale(ctx);
        case 'step':
          return before.step;
        case 'add':
          break;
      }
      const planned = before.origin;
      if (!ctx.accepted.has('tailscale') || ctx.config === null) {
        return problem(`address not added; run ${again(ctx)}`, 'address not added', again(ctx));
      }
      // The state again after the plan question: the address shown there, or nothing written.
      const now = await chooseAddress(ctx, configPort(ctx));
      if ('step' in now) return now.step;
      if (now.origin !== planned) {
        line(ctx, `--tailscale: the address is ${now.origin} now, not ${planned} as the plan said; ${NOTHING_CHANGED}`);
        return problem(`Tailscale changed during the question; run ${again(ctx)}`,
          'Tailscale changed during the question', again(ctx));
      }
      const refused = write(planned);
      if (refused !== null) return refused;
      written = true;
      ctx.config = readRarogConfig(ctx.io.env);
      ctx.originFromTailscale = planned;
      line(ctx, `${file}: ${ORIGINS} ${planned} added`);
      const serve = await stepTailscale(ctx);
      const bare = (text: string): string => text.replace(/^tailscale serve: /u, '');
      const said = bare(serve.result ?? serve.summary);
      return {
        ...serve,
        summary: `${TITLE}: address ${planned} added to ${CONFIG_FILENAME}; ${bare(serve.summary)}`,
        result: `address added; ${said === 'declined' ? 'tailscale serve declined' : said}`,
        changed: true,
      };
    },

    notes() {
      if (!written && !resumed) return;
      const { restart } = repairCommands(ctx.mode, ctx.installRoot);
      ctx.view.note(ctx.view.absoluteFix(`The server reads the new address at start: run ${restart}.`));
      ctx.view.note(ctx.view.absoluteFix('Devices paired before keep connecting over iroh. To give them the address:'
        + ` ${cliFor(ctx, 'devices revoke --all')}, then ${cliFor(ctx, 'pair')}, then pair the other devices from the`
        + ' first one\'s app (Settings → Pairing → Pair New Device). A revoked device loses its unsent messages and'
        + ' drafts.'));
    },
  };
}
