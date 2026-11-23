/**
 * Step 2 of `rarog setup`: `config.json`. An existing file is only read and checked here (the one change to it, the
 * Tailscale address of `rarog setup --tailscale`, is step 4's, `setup-tailscale-add.ts`); a missing one is
 * written when the plan screen was accepted (`setup-plan.ts`), with the transport (`setup-transport.ts`) and home as
 * the project directory (no question), through the write-if-missing path (`link`), so two runs never overwrite
 * each other. With iroh the server key goes into the secrets file first, under the same Rarog lock
 * (`setup-secrets.ts`); so do the voice keys of the questions right before it (`setup-voice.ts`), and with both of
 * them `RAROG_COMPANION=1`.
 */
import { statSync } from 'node:fs';
import path from 'node:path';
import {
  COMPANION_ENV, HERDR_BIN_ENV, HERDR_LAUNCH_ENV, HERDR_ROOTS_ENV, IROH_KEY_ENV, IROH_RELAY_ENV, PROJECT_ROOTS_ENV,
  PUSH_ENV, PUSH_RELAY_URL_ENV, TERM_ENV,
} from '../config-env.ts';
import { repairCommands } from '../install/repair.ts';
import { Refusal } from './io.ts';
import {
  CONFIG_FILENAME, PRIVATE_ENV_FILENAME, SECRET_DIRNAME, configFileText, rarogConfigDir, readRarogConfig,
} from './serve.ts';
import { SCREEN_TITLE, ensureDir, entry, line, unsafeDir, waitingStep, writeIfMissing } from './setup-context.ts';
import { tilde } from './setup-plan.ts';
import type { Ctx, Step } from './setup-context.ts';
import { ensureIrohKey, irohKeyState, keyPlan, underLock } from './setup-secrets.ts';
import { chooseTransport, printTransportPlan, transportEnv, transportOrigin } from './setup-transport.ts';
import { askVoice, noVoiceWrites, reportVoice, writeVoiceKeys } from './setup-voice.ts';

/** The production push relay: `RAROG_PUSH_RELAY_URL` in the `config.json` setup creates. */
export const DEFAULT_PUSH_RELAY_URL = 'https://push.rarog.ai';

export async function stepConfig(ctx: Ctx): Promise<Step> {
  const title = 'config.json';
  const dir = rarogConfigDir(ctx.io.env);
  const file = path.join(dir, CONFIG_FILENAME);
  const state = entry(file);
  if (state !== 'missing') {
    if (typeof state !== 'string') {
      line(ctx, `${file}: unreadable (${state.code})`);
      return { title, state: 'problem', summary: `${file}: unreadable (${state.code}); check the directory permissions` };
    }
    try {
      ctx.config = readRarogConfig(ctx.io.env);
    } catch (failure) {
      if (!(failure instanceof Refusal)) throw failure;
      line(ctx, failure.message);
      // One sentence on the screen, the whole refusal (and the jq hint) in the run log.
      return {
        title, state: 'problem', summary: `${file}: ${failure.message} Fix the file; setup does not change it.`,
        result: refusalHead(failure.message, file), fix: `fix ${tilde(file, ctx.home)} by hand, then rarog setup`,
      };
    }
    if (ctx.config === null) {
      // `lstat` sees the entry, the read through the symlink does not: a dangling symlink.
      line(ctx, `${file}: dangling symlink`);
      return {
        title, state: 'problem',
        summary: `${file} points to a file that does not exist; restore the target or remove the symlink (setup does`
          + ' not change it)',
      };
    }
    line(ctx, `${file}: present${ctx.config.wrapper === null ? '' : ' (with service.wrapper)'}`);
    if (ctx.irohRelayGiven) {
      line(ctx, `--iroh-relay ignored: config.json exists and setup does not change its relay; set ${IROH_RELAY_ENV} in`
        + ' it by hand');
    }
    return { title, state: 'ok', summary: `${file}: present` };
  }
  line(ctx, `${file}: missing`);
  // Missing when the plan screen read it (the question came before this step) or now.
  const dirWasMissing = ctx.configDirAbsent || entry(dir) === 'missing';
  if (!dirWasMissing) {
    let isDir = false;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      line(ctx, `${dir}: exists and is not a directory (or is a dangling symlink)`);
      return { title, state: 'problem', summary: `${dir}: expected a directory; setup does not change it` };
    }
  }
  const missing: Step = { title, state: 'missing', summary: `${file} missing: run rarog setup in a terminal` };
  if (ctx.ask === null) return missing;
  // In a terminal the Tools step carries the fix of a missing tool; this step only waits for it.
  const waitsForTools = (): Step => {
    ctx.configWaits = SCREEN_TITLE.tools;
    return waitingStep(title, 'missing', `${file} missing: waits for the tools above`, SCREEN_TITLE.tools);
  };
  if (ctx.herdr === null) {
    line(ctx, 'without herdr there is nothing to put in RAROG_HERDR_BIN — install herdr first');
    return waitsForTools();
  }
  const plan = chooseTransport(ctx);
  if (plan === null) return waitsForTools();
  const secrets = path.join(dir, SECRET_DIRNAME, PRIVATE_ENV_FILENAME);
  let keyLine = '';
  if (plan.iroh) {
    // The key state before the question is only for the plan and for a refusal without a question; the read under
    // the lock decides the write.
    const key = irohKeyState(ctx.io.env);
    if (typeof key !== 'string') {
      line(ctx, key.problem);
      return { title, state: 'problem', summary: `config.json not created: ${key.problem}` };
    }
    keyLine = keyPlan(key, secrets);
  }
  printTransportPlan(ctx, plan, keyLine);
  if (!ctx.accepted.has('config')) return missing;

  const origin = await transportOrigin(ctx, plan);
  if ('failure' in origin) {
    line(ctx, origin.failure);
    return { title, state: 'problem', summary: origin.failure, result: origin.result, fix: origin.fix };
  }
  // Home is the work area (no question): hidden folders directly in it and the macOS-protected ones stay out;
  // the plan screen says how to narrow it. Also with a hook copy that differs from the install, which the hook step
  // offers to update.
  const roots = path.resolve(ctx.home);
  line(ctx, `project directories: ${roots}`);
  const env = transportEnv(ctx, plan, origin.origin, {
    [HERDR_LAUNCH_ENV]: '1',
    [TERM_ENV]: '1',
    [PUSH_ENV]: '1',
    [PUSH_RELAY_URL_ENV]: DEFAULT_PUSH_RELAY_URL,
    [PROJECT_ROOTS_ENV]: roots,
    [HERDR_ROOTS_ENV]: roots,
    [HERDR_BIN_ENV]: ctx.herdr,
  });
  // The voice questions come only now, when config.json is about to be written; they write nothing themselves.
  const voice = await askVoice(ctx);
  const voiceWrites = noVoiceWrites();
  ensureDir(dir, 0o700);
  // The directory was missing before the question and is a symlink now: someone planted it meanwhile, no write.
  const unsafe = dirWasMissing ? unsafeDir(dir, null) : null;
  if (unsafe !== null) {
    line(ctx, `${unsafe} — writing nothing`);
    return { title, state: 'problem', summary: `${unsafe}; check the directory, then rarog setup` };
  }
  // The keys before config.json, all under one lock: an interrupted setup leaves at most keys, which a retry takes as
  // they are. Another run that wrote config.json during the questions wins: this one writes nothing, keys included.
  const written = underLock(ctx, (held): 'written' | 'taken' | { readonly problem: string } => {
    if (entry(file) !== 'missing') return 'taken';
    if (plan.iroh) {
      const key = ensureIrohKey(ctx, held);
      if ('problem' in key) return key;
      if (key.done !== 'kept') {
        ctx.irohKeyCreated = true;
        line(ctx, `${secrets}: ${IROH_KEY_ENV} ${key.done === 'created' ? 'written' : 'added'}`);
      }
    }
    let withVoice = env;
    if (voice !== null) {
      const keys = writeVoiceKeys(ctx, held, voice, voiceWrites);
      if ('problem' in keys) return keys;
      if (keys.flag) withVoice = { ...env, [COMPANION_ENV]: '1' };
    }
    return writeIfMissing(file, configFileText({ version: 1, env: withVoice }), 0o600) ? 'written' : 'taken';
  });
  if (voice !== null) reportVoice(ctx, voice, voiceWrites, written === 'written');
  if (typeof written !== 'string') {
    line(ctx, `${written.problem} — config.json not created`);
    return { title, state: 'problem', summary: `config.json not created: ${written.problem}` };
  }
  if (written === 'taken') {
    line(ctx, `${file} appeared meanwhile (a second rarog setup?) — overwriting nothing`);
    return { title, state: 'problem', summary: `${file} appeared meanwhile; run rarog setup again` };
  }
  try {
    ctx.config = readRarogConfig(ctx.io.env);
  } catch (failure) {
    if (!(failure instanceof Refusal)) throw failure;
    return { title, state: 'problem', summary: `${file}: written, but ${failure.message}` };
  }
  line(ctx, `${file}: written`);
  // A service from before this config.json (a trace on the plan screen) does not read it until a restart; setup
  // restarts nothing.
  if (!ctx.accepted.has('service')) {
    ctx.view.note(`If the service runs: ${repairCommands(ctx.mode, ctx.installRoot).restart}, to read config.json.`);
  }
  ctx.configCreated = true;
  return { title, state: 'ok', summary: `${file}: created`, changed: true };
}

/** The first clause of a `config.json` refusal, without the file name and the hint after it: one screen sentence. */
function refusalHead(message: string, file: string): string {
  const text = message.startsWith(`${file}: `) ? message.slice(file.length + 2) : message;
  return text.split(' (')[0]?.replace(/\.$/u, '') ?? text;
}
