/**
 * `rarog setup` — instalacja serwera Rarog krok po kroku na nowym koncie (macOS albo Linux z `systemd --user`).
 *
 * One rule: setup CREATES only what is missing and changes nothing that exists. Rarog's own missing parts
 * (`config.json` with the server key, the clone's hook copy, the herdr agent or unit, the Claude SDK, the service) are
 * listed on the plan screen and covered by one `Continue? [Y/n]` (`setup-plan.ts`; EOF = no, nothing written; on a plan
 * of the herdr item alone it declines just that item); a foreign file or setting keeps its own question. „Brak” to
 * wyłącznie `lstat` = ENOENT; każdy inny stan (zepsuty JSON, brak dostępu, wiszące dowiązanie) jest stanem
 * istniejącym: diagnoza i komenda naprawy, bez zapisu. Zapis „tylko
 * gdy brak” idzie przez plik tymczasowy i `link` na docelową nazwę, więc dwa równoległe `setup` się nie nadpiszą
 * (`EEXIST` = ktoś był pierwszy, stop). Blokady przez pytania setup nie trzyma.
 *
 * Bez terminala (`CliIo.ask` brak) setup nie pyta i niczego nie zapisuje: wypisuje stan kroków i komendy dla
 * brakujących. Kod 0 = wszystkie kroki na miejscu, 1 = braki albo problemy (także po pytaniach w terminalu).
 * The tools check runs once, before the plan screen: a first setup (no `config.json`) in a terminal with a tool
 * missing stops there with one sentence and its fix, nothing written; otherwise the Tools step reports it.
 *
 * Transport (`setup-transport.ts`): with the iroh native module (`irohModuleInfo`, read from the manifests without
 * loading native code) a new `config.json` gets `RAROG_IROH=1` and `RAROG_IROH_RELAY` (the default relay or
 * `--iroh-relay`), and with `tailscale` in PATH also `RAROG_ORIGINS` from `tailscale status` on the first free port
 * of the pool for `tailscale serve` (step 4 maps it). No free port or a failing `tailscale status` leaves iroh only.
 * An Intel Mac has no module, so Tailscale only, and no free port there means no transport and no `config.json`. The server key `RAROG_IROH_KEY` is
 * written BEFORE `config.json`, both under one Rarog lock of the config directory (`secrets-file.ts`), so an
 * interrupted setup leaves at most the key without a config, and a retry takes that key. Exception to "changes
 * nothing that exists": a secrets file without the key gets the key line (the rest byte for byte, the atomic write
 * of `rarog dictation set-key`); an existing key is never changed. The key's value is never printed.
 *
 * W paczce npm setup pobiera też SDK Claude listy sesji (krok „Claude SDK”, `install/sdk.ts`) do katalogu danych
 * usługi (`install/data-dir.ts`, flaga `--data-dir`), a uruchomiony z cache `npx` albo przez `pnpm dlx` odmawia na
 * samym początku: usługa z takiej ścieżki znika przy czyszczeniu cache. Na końcu paczka dostaje zdanie
 * o aktualizacji: komenda menedżera, który ją położył, potem `rarog restart`.
 *
 * Kopię hooka i skryptu `statusLine` pisze tylko wtedy, gdy usługi nie ma albo startuje tę instalację: cel usługi
 * czyta przed pierwszym zapisem (`copyTargetRefusal` z `hooks.ts`), a usługa innej instalacji albo nieczytelny cel
 * to odmowa w obu krokach kopii, bez pytania.
 *
 * Wyjątek od „niczego istniejącego nie zmienia”: kopia hooka różna od źródła (po `npm update` albo nowym commicie
 * w `scripts/hooks/`). Krok 5 robi wtedy to, co `rarog hooks install`, z tymi samymi bramami
 * (`installHookCopy`): w klonie drukuje `git log <commit>..HEAD -- scripts/hooks` i pyta przed bramą stanu z commita,
 * w paczce pytanie stoi po różnicy kopii. Kopia zmieniona po instalacji (skrót różny od manifestu) to ostrzeżenie
 * doctora bez pytania i bez zapisu.
 *
 * Exception to "changes nothing that exists": `--tailscale` adds the Tailscale address (`RAROG_ORIGINS`) to an existing
 * `config.json` without one, as an item of the plan screen (`setup-tailscale-add.ts`); nothing else in the file changes.
 *
 * Exception to "changes nothing that exists": Rarog's own entries in `~/.claude/settings.json`. The Claude
 * settings step (`setup-settings.ts`) asks one `[y/N/d]` question for the five entries (permission and context
 * hooks, `statusLine`, `denyRead`, the write block) and herdr's session hook, writes Rarog's entries in one write with
 * one backup, then
 * runs `herdr integration install claude` (herdr writes its own entry). Without a terminal it writes nothing.
 *
 * Usługi nie instaluje, gdy jest JAKIKOLWIEK ślad usługi (plik albo załadowana etykieta) — wtedy tylko diagnoza
 * i komenda; instalacja wyłącznie przy braku obu i żywym gnieździe herdr. Platforma i ścieżki przychodzą z `CliIo`
 * (`platform`, `env.HOME`), więc gałęzie Linuksa testują się na macOS na atrapach.
 *
 * Steps 2 (`config.json`), 3 (the secrets file), 4 (`tailscale serve`) and 7 (`herdr.service` on Linux, the herdr
 * agent on macOS) live in their own modules (`setup-config.ts`, `setup-secrets.ts`, `setup-transport.ts`,
 * `setup-herdr-unit.ts`, `setup-herdr-agent.ts`), the context and the file helpers they share in `setup-context.ts`;
 * this file runs the steps in order and holds the remaining ones.
 */
import { lstatSync, readlinkSync } from 'node:fs';
import path from 'node:path';
import { irohRelayUrl } from '@rarog/shared/pairing-link';
import { HERDR_SOCKET_ENV } from '../config-env.ts';
import { gitReadEnv, spawnGitArgs } from '../git-status.ts';
import { HEALTH_PROBE_TTL_MS } from '../health.ts';
import {
  hookCopyReport, hookInstallDir, hookOriginText, installHookCopy, installMissingHookCopy, installStatuslineCopy,
  renderHookCopyReview, statuslineCopyReport,
} from '../herdr/hook-config.ts';
import type { HookCopyReport, HookInstallOptions, HookInstallResult } from '../herdr/hook-config.ts';
import { installDataDir } from '../install/data-dir.ts';
import type { InstallDataDir } from '../install/data-dir.ts';
import { INSTALL_MODE, INSTALL_ROOT } from '../install/mode.ts';
import type { InstallMode } from '../install/mode.ts';
import {
  PACKAGE_INSTALL, REPAIR, packageCommands, packageManagerOf, rarogCli, repairCommands, shellQuote,
} from '../install/repair.ts';
import {
  SDK_PACKAGE, installSdk, probeSdkDir, readSdkPin, sdkDirIssue, sdkRoot, sdkTempDirs, sdkVersionDir,
} from '../install/sdk.ts';
import { RAROG_BIN, transientInstall } from '../install/service-target.ts';
import { trackChild } from './child-output.ts';
import {
  changedAfterInstall, changedAfterInstallWarning, copyTargetRefusal, copyTargetRefusalOf, herdrClaudeIntegration,
  herdrIntegrationLine, sourceMovedLines,
} from './hooks.ts';
import type { CopyRefusal } from './hooks.ts';
import { EXIT_INTERRUPTED, EXIT_OK, EXIT_REFUSED, Usage, homeOf, out, platformOf } from './io.ts';
import type { CliIo } from './io.ts';
import {
  SERVICE_LABEL, accepts, installedServiceDataDir, loadState, nodeRequirement, onPath, serviceNodeVersionOk,
  servicePlistPath,
} from './restart.ts';
import { CONFIG_FILENAME, rarogConfigDir, readRarogConfig } from './serve.ts';
import type { RarogConfig } from './serve.ts';
import { launchdEnv, rarogLinkPath, serviceInstallIfAbsent } from './service.ts';
import { closingCheck, packageVersion, setupCliTarget } from './setup-check.ts';
import { stepConfig } from './setup-config.ts';
import { confirmPlan, sdkPlanEntry, tilde } from './setup-plan.ts';
import type { PlanEntry } from './setup-plan.ts';
import { SetupView } from './setup-screen.ts';
import { statusLineScriptOutOfDate, statusLineWaitsForScript, stepClaudeSettings } from './setup-settings.ts';
import {
  SCREEN_TITLE, SERVICE_UNDETERMINED, SetupInterrupted, configPort, configuredHerdrSocket, confirm, copyDirEmpty,
  declinedStep, entry, errnoCode, herdrSocket, isRecord, line, onShellPath, serviceStateFix, waitingStep,
} from './setup-context.ts';
import type { Ctx, SetupDeps, Step, StepState } from './setup-context.ts';
import { herdrAgentOffer, herdrAgentStart, stepHerdrAgent } from './setup-herdr-agent.ts';
import { HERDR_UNIT_NAME, herdrUnitOffer, stepHerdrUnit } from './setup-herdr-unit.ts';
import { stepSecrets } from './setup-secrets.ts';
import { tailscaleAddress } from './setup-tailscale-add.ts';
import type { TailscaleAddress } from './setup-tailscale-add.ts';
import { TAILSCALE_ONLY_FLAG, TAILSCALE_ONLY_PLAN_ITEM, tailscaleOnlyBeforePlan } from './setup-tailscale-only.ts';
import type { StopBeforePlan } from './setup-tailscale-only.ts';
import { stepTailscale, transportTools } from './setup-transport.ts';
import { UNIT_NAME, managerEnvironment, showUnit, unitFilePath, userUnitDir } from './systemd-unit.ts';
import { usageFor } from './screen/prose.ts';
import { wrapWords } from './screen/style.ts';

export type { SetupDeps } from './setup-context.ts';
export { SetupInterrupted } from './setup-context.ts';

export const SETUP_USAGE = `  rarog setup [--tailscale] [--tailscale-only] [--iroh-relay <https url>] [--data-dir <dir>] [--verbose]
      Step-by-step installation: checks the tools and creates only what is missing (config.json with the iroh
      server key and your home folder as the work area, the hook copy and the statusLine script, the herdr agent
      on macOS or the herdr.service unit on Linux, with the npm package the Claude SDK for the sessions list, the
      service), after one Continue? [Y/n] for the plan shown first; answer n to stop with nothing changed (on a plan
      of the herdr item alone, n skips just that item). Of what exists it changes only a hook copy that differs from
      the source (after its diff, in a clone the git log of the hook changes) and the secrets file, to which it
      adds a missing iroh server key and the voice keys, each after a question, and the Rarog entries in
      ~/.claude/settings.json
      (hooks, statusLine, sandbox.filesystem.denyRead, the permissions.deny rules that keep Claude Code sessions
      from writing the data directory and ~/.config/rarog; one backup in the data directory) after one [y/N/d]
      question, where d shows the full diff; without herdr's Claude integration the same answer then runs herdr
      integration install claude (herdr writes its own entry). On Linux, with herdr not running and no herdr.service
      unit, the plan lists that unit; setup writes it to ~/.config/systemd/user and does not enable it. On macOS,
      without the herdr agent ai.rarog.herdr, the plan lists that LaunchAgent; setup writes it to
      ~/Library/LaunchAgents, which starts herdr at each login, and with herdr not running it also loads it, which
      starts herdr now. Transport of a new config.json: iroh when this machine has the iroh native module (RAROG_IROH=1,
      the default relay, a new server key RAROG_IROH_KEY in the secrets file, never printed), and the HTTPS
      address from tailscale status on the first free port of 8931-8960 for tailscale serve when tailscale is in
      PATH (no free port leaves iroh only); an Intel Mac has no iroh module, so Tailscale only. With both, a first
      setup in a terminal first asks whether the app connects only through Tailscale; "y" writes RAROG_IROH=0 with
      the relay, the Tailscale address and no server key, and writes nothing before Continue?. Before a new
      config.json it asks about dictation with Soniox and, with a Soniox key, about the voice agent (an OpenAI
      key, paid); each key at a hidden prompt, never printed, and with both keys RAROG_COMPANION=1. Without a
      terminal it asks nothing and writes nothing; code 1 when something is missing.
      --tailscale: an existing config.json without an address (iroh only) gets the HTTPS address from tailscale
      status on the first free port of 8931-8960 in RAROG_ORIGINS, as an item of the plan; this is the one change
      setup makes to an existing config.json. Then tailscale serve maps it after its own question. The server reads
      the address after rarog restart; devices paired before get it from a new pairing:
      rarog devices revoke --all, then rarog pair.
      --tailscale-only: the "y" of that question without asking it, for a new config.json only (it stops before
      the plan when Tailscale is missing, logged out or stopped; with --tailscale it is --tailscale-only alone).
      With an existing config.json it changes nothing; docs/server-config.md, "Tailscale only", says how to switch
      by hand.
      --iroh-relay: your own iroh relay instead of the default one.
      --data-dir: the installation's data directory from rarog serve --data-dir.
      --verbose: every detail line on the screen, and the summary at the end (otherwise one line per step; the
      details go to the log <data directory>/logs/setup-<time>.log, written from the first yes on).`;

/** The production iroh relay (`relay-vps/`) as the `RAROG_IROH_RELAY` value, in the canonical `irohRelayUrl` form. */
export const DEFAULT_IROH_RELAY = 'https://relay.rarog.ai/';

/** Ile setup czeka na `/health` usługi, która już jest. */
const HEALTH_TIMEOUT_MS = 3000;

/** `/health` answered, but its herdr ping failed: the server runs, herdr does not. */
const HERDR_DOWN = 'herdr: false';

const DEFAULT_DEPS: SetupDeps = {
  serviceInstall: (io, precheck, output) => serviceInstallIfAbsent(io, precheck, undefined,
    output === undefined ? {} : { output }),
};

/**
 * Pierwszy plik wykonywalny o tej nazwie w `PATH`, potem w `~/.local/bin`; `null` = brak. Plik znaleziony tylko
 * w `~/.local/bin` leży poza `PATH` tej powłoki ({@link onShellPath}), więc panel herdr może go nie widzieć.
 */
function findExecutable(name: string, ctx: Ctx): string | null {
  const dirs = [...(ctx.io.env['PATH'] ?? '').split(':'), path.join(ctx.home, '.local', 'bin')];
  for (const dir of dirs) {
    if (!path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, name);
    if (onPath(name, { PATH: dir })) return candidate;
  }
  return null;
}

function parseFlags(argv: readonly string[]): {
  irohRelay: string | null; dataDir: string | null; verbose: boolean; tailscale: boolean; tailscaleOnly: boolean;
} {
  let irohRelay: string | null = null;
  let dataDir: string | null = null;
  let verbose = false;
  let tailscale = false;
  let tailscaleOnly = false;
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--verbose') {
      verbose = true;
      continue;
    }
    if (arg === '--tailscale') {
      tailscale = true;
      continue;
    }
    if (arg === TAILSCALE_ONLY_FLAG) {
      tailscaleOnly = true;
      continue;
    }
    if (arg === '--iroh-relay') {
      const value = argv[i + 1];
      if (value === undefined || value === '') throw new Usage('rarog setup: --iroh-relay needs an address.');
      if (irohRelay !== null) throw new Usage('rarog setup: --iroh-relay given twice.');
      // The canonical form of `RAROG_IROH_RELAY` in the server and of the pairing link's `r` field.
      irohRelay = irohRelayUrl(value);
      if (irohRelay === null) {
        throw new Usage(`rarog setup: --iroh-relay "${value}" is not an iroh relay address: https://host[:port]/`
          + ' without a path.');
      }
      i += 1;
      continue;
    }
    if (arg === '--data-dir') {
      const value = argv[i + 1];
      if (value === undefined || value === '') throw new Usage('rarog setup: --data-dir needs a directory.');
      if (!path.isAbsolute(value)) throw new Usage(`rarog setup: --data-dir "${value}" is not an absolute path.`);
      if (dataDir !== null) throw new Usage('rarog setup: --data-dir given twice.');
      dataDir = path.resolve(value);
      i += 1;
      continue;
    }
    throw new Usage(`rarog setup: unknown argument "${arg}".`);
  }
  return { irohRelay, dataDir, verbose, tailscale, tailscaleOnly };
}

/** Środowisko usługi: Linux — menedżer `systemd --user` (bez magistrali jak macOS), macOS — jak pod launchd. */
function serviceEnvOf(io: CliIo, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  if (platform === 'linux') {
    const manager = managerEnvironment(io);
    if ('env' in manager) return { ...launchdEnv(io.env), ...manager.env };
  }
  return launchdEnv(io.env);
}

// ---------------------------------------------------------------------------
// Krok 1: narzędzia
// ---------------------------------------------------------------------------

/**
 * A missing tool: its name on the step's screen line, what to do on its `Fix:` line, and its `MISSING` detail line
 * (the run log, and the screen with `--verbose`).
 */
interface MissingTool {
  readonly name: string;
  readonly fix: string;
  readonly text: string;
}

const missingTool = (name: string, fix: string, text = `${name} — ${fix}`): MissingTool => ({ name, fix, text });

/**
 * The Tools step's result. The summary keeps the `--verbose` wording, which points at the `MISSING` and `PROBLEM`
 * lines; the screen line names the tools itself, because the step screen hides those lines.
 */
function toolsResult(missing: readonly MissingTool[]): Step {
  const title = 'tools';
  const count = String(missing.length);
  const names = missing.length === 0 ? '' : `${count} missing: ${missing.map((one) => one.name).join(', ')}`;
  const fixes = [...new Set(missing.map((one) => one.fix))];
  const fix = fixes.length === 0 ? {} : { fix: `${fixes.join('; ')}; then rarog setup` };
  return missing.length === 0
    ? { title, state: 'ok', summary: 'tools: all present' }
    : { title, state: 'missing', summary: `tools: ${count} missing (list above)`, result: names, ...fix };
}

/** What the tools check found: its detail lines (written by the Tools step, or by a refusal) and the missing tools. */
interface ToolsCheck {
  readonly lines: readonly string[];
  readonly missing: readonly MissingTool[];
}

/**
 * The tools check, once per run and before the plan screen: what it finds goes to the context (`claude`,
 * `herdr`, the herdr integration, the transport), its detail lines come back for the Tools step to write under its
 * header. It reads only: `PATH`, `herdr integration status`, `systemctl --user` on Linux, the iroh module manifests.
 */
function checkTools(ctx: Ctx): ToolsCheck {
  const lines: string[] = [];
  const say = (text: string): void => { lines.push(text); };
  const missing: MissingTool[] = [];
  if (!serviceNodeVersionOk(process.version)) {
    missing.push(missingTool(`Node ${process.version}`, `Node ${nodeRequirement()} (e.g. nvm install --lts)`,
      `Node ${process.version} — requires ${nodeRequirement()} (e.g. nvm install --lts)`));
  } else {
    say(`node ${process.version}`);
  }
  const claude = findExecutable('claude', ctx);
  ctx.claude = claude;
  if (claude === null) missing.push(missingTool('claude', 'install Claude Code'));
  else say(`claude: ${claude}`);
  const outside = claude === null || onShellPath(path.dirname(claude), ctx) ? null : path.dirname(claude);
  if (outside !== null) {
    say(ctx.platform === 'linux'
      ? `  ${outside} is outside this shell's PATH; step 9 checks the PATH of herdr panes`
      : `WARNING: ${outside} is outside this shell's PATH — a herdr pane may not find claude (a session started from`
        + ' the app will not come up); add this directory to PATH in your shell startup file');
  }
  ctx.herdr = findExecutable('herdr', ctx);
  if (ctx.herdr === null) {
    missing.push(missingTool('herdr', 'install herdr (default ~/.local/bin/herdr)'));
  } else {
    say(`herdr: ${ctx.herdr}`);
    // Its installer runs in the Settings step, after the one settings question (it writes the same file).
    ctx.herdrIntegration = herdrClaudeIntegration(ctx.herdr, ctx.io.env);
    if (ctx.herdrIntegration.state === 'current' || ctx.herdrIntegration.state === 'unknown') {
      say(herdrIntegrationLine(ctx.herdrIntegration));
    }
  }
  if (onPath('curl', ctx.io.env)) say('curl: found');
  else missing.push(missingTool('curl', 'install curl (restart checks /health with it)'));
  if (ctx.platform === 'linux') {
    for (const tool of ['ps', 'pgrep']) {
      if (onPath(tool, ctx.io.env)) say(`${tool}: found`);
      else missing.push(missingTool(tool, 'install procps'));
    }
    const shown = showUnit(ctx.io, ['LoadState']);
    if ('failure' in shown) {
      // Its message stays in the MISSING line (the run log); the fix is one phrase. The service step,
      // which asks the same manager, waits for this step.
      missing.push(missingTool('systemctl --user', 'log in with a systemd user session',
        `systemctl --user unreachable (${shown.failure}) — the Rarog service is a systemd --user unit`));
      ctx.serviceWaits = SCREEN_TITLE.tools;
    } else {
      say('systemctl --user: responds');
    }
    if (!onPath('lsof', ctx.io.env) && !onPath('ss', ctx.io.env)) {
      say('hint: neither lsof nor ss — restart cannot find the process on the port (install iproute2)');
    }
  }
  const transport = transportTools(ctx);
  lines.push(...transport.lines);
  if (transport.missing !== null) missing.push(transport.missing);
  for (const one of missing) say(`MISSING ${one.text}`);
  return { lines, missing };
}

/** The Tools step: the lines and the result of the check that ran before the plan ({@link checkTools}). */
function stepTools(ctx: Ctx, check: ToolsCheck): Step {
  for (const text of check.lines) line(ctx, text);
  return toolsResult(check.missing);
}

/** `   Fix: ` of the step screen (`screen/steps.ts`): the refusal's fix stands as under a step line. */
const FIX_LABEL = '   Fix: ';

/** `a`, `a and b`, `a, b and c`. */
function namesOf(names: readonly string[]): string {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`;
}

/**
 * A first setup (no `config.json`) in a terminal with a tool missing stops before the plan screen: one
 * sentence with the missing tools and their `Fix:`, exit 1, nothing written and no run log. Without it the plan would
 * promise a config and a service the run cannot create, and still write the hook copy and the settings entries.
 * `null` = go on: an existing installation, a run without a terminal or nothing missing keep the step report.
 */
function refusalBeforePlan(ctx: Ctx, check: ToolsCheck): number | null {
  if (ctx.ask === null || check.missing.length === 0) return null;
  if (entry(path.join(rarogConfigDir(ctx.io.env), CONFIG_FILENAME)) !== 'missing') return null;
  return stopBeforePlan(ctx, {
    lines: check.lines,
    sentence: `Rarog cannot run without ${namesOf(check.missing.map((one) => one.name))}; nothing changed.`,
    fix: toolsResult(check.missing).fix ?? '',
  });
}

/**
 * A stop before the plan screen: the detail lines, one sentence and its `Fix:` under it, exit 1, nothing written and no
 * run log.
 */
function stopBeforePlan(ctx: Ctx, stop: StopBeforePlan): number {
  // `--verbose` shows the detail lines; otherwise they stay in memory, because the log file opens only at a "yes".
  for (const text of stop.lines) line(ctx, text);
  const width = ctx.view.screen.layout.width;
  for (const part of wrapWords(stop.sentence, width, width)) ctx.view.closing(part);
  const [first = '', ...commands] = ctx.view.screenFix(stop.fix).split('\n');
  const room = width - FIX_LABEL.length;
  const sentenceLines = first === '' ? [] : wrapWords(first, room, room);
  ctx.view.closing(`${FIX_LABEL}${sentenceLines[0] ?? ''}`.trimEnd());
  for (const part of sentenceLines.slice(1)) ctx.view.closing(`${' '.repeat(FIX_LABEL.length)}${part}`);
  for (const command of commands) ctx.view.closing(`     ${command}`);
  return EXIT_REFUSED;
}

// ---------------------------------------------------------------------------
// Krok 5: hook
// ---------------------------------------------------------------------------

function gitRunner(ctx: Ctx): ReturnType<typeof spawnGitArgs> {
  return spawnGitArgs(gitReadEnv({ PATH: ctx.io.env['PATH'] ?? '', HOME: ctx.home }));
}

/**
 * The `[y/N]` questions about the hook copy in `~/.claude/hooks/rarog` (the hook files and the statusLine script):
 * install a missing copy, update a differing one, or add only the missing script. One line at 60 columns;
 * the review of the files goes to the run log and, with `--verbose`, to the screen.
 */
export function copyQuestion(kind: 'install' | 'update' | 'statusLine', dir: string): string {
  switch (kind) {
    case 'install':
      return `Install the hook copy in ${dir}?`;
    case 'update':
      return `Update the hook copy in ${dir}?`;
    case 'statusLine':
      return `Add the status line script to ${dir}?`;
  }
}

/**
 * Kopia po pytaniu `[y/N]` (`install` to instalator: brakującej kopii „tylko gdy brak” albo aktualizacja kopii różnej
 * od źródła, `installHookCopy`). W klonie pytanie stoi przed instalatorem, bo brama stanu z commita nie pyta.
 * W paczce instalator najpierw czyta źródło i pokazuje różnicę wobec kopii, a to samo pytanie stoi po niej;
 * `askFirst` stawia je też przed instalatorem, gdy różnicy plików nie będzie (instalator pisze kopię równą
 * źródłu bez pytania, a usunąłby plik z poprzedniej instalacji). `null` = „nie”, EOF albo brak terminala: nic nie
 * zapisane. Usługa innej instalacji ({@link Ctx.copyRefusal}) = odmowa bez pytania i bez zapisu.
 */
async function installAfterQuestion(
  ctx: Ctx, question: string | null, install: (opts: HookInstallOptions) => Promise<HookInstallResult>,
  askFirst = false,
): Promise<HookInstallResult | null> {
  if (ctx.copyRefusal !== null) return { ok: false, reason: ctx.copyRefusal.text };
  const opts: HookInstallOptions = {
    home: ctx.home, root: ctx.installRoot, mode: ctx.mode, git: gitRunner(ctx),
    serviceRefusal: () => copyTargetRefusal(ctx.io, { mode: ctx.mode, root: ctx.installRoot }),
  };
  // `null` = the plan screen covered it ("Continue?"): no question of its own, the review stays a detail line. The
  // update run that has just installed this package writes its copy the same way.
  const ok = async (): Promise<boolean> => (question === null || ctx.copyWithoutQuestion ? ctx.ask !== null
    : confirm(ctx, question));
  if ((ctx.mode !== 'package' || askFirst) && !await ok()) return null;
  if (ctx.mode !== 'package') return install(opts);
  if (ctx.ask === null) return null;
  const result = await install({
    ...opts,
    review: async (review) => {
      for (const text of renderHookCopyReview(review).trimEnd().split('\n')) line(ctx, text);
      return ok();
    },
  });
  return !result.ok && result.declined === true ? null : result;
}

/** Podsumowanie kopii, której setup nie zaktualizował: przegląd w doctorze, potem `rarog hooks install`. */
const COPY_OUT_OF_DATE = 'hook copy out of date: review rarog hooks doctor, then rarog hooks install';

/** Pliki kopii różne od źródła i pliki z poprzedniej instalacji do usunięcia, jednym członem zdania. */
function copyDifferences(report: HookCopyReport, script: HookCopyReport): string {
  const files = [...report.files, ...script.files].filter((one) => one.state !== 'match').map((one) => {
    if (one.state === 'missing') return `${one.name} (missing)`;
    return one.state === 'unreadable' ? `${one.name} (not a regular file)` : one.name;
  });
  return [...files, ...report.leftovers.map((name) => `${name} (from a previous install, to be removed)`)].join(', ');
}

/**
 * Kopia hooka różna od źródła: to, co `rarog hooks install`, z tymi samymi bramami
 * (`installHookCopy`: brama źródła trybu, cel usługi, w paczce różnica i pytanie). Kopia zmieniona po instalacji
 * (skrót pliku różny od manifestu, także skryptu `statusLine`, który instalator też nadpisuje) to ostrzeżenie doctora
 * bez pytania; usługa innej instalacji to odmowa przed `git log` i różnicą. Potem w klonie `git log` od commita kopii
 * i pytanie przed bramą stanu z commita, w paczce pytanie po różnicy. Katalog kopii, który nie jest katalogiem
 * (dowiązanie), zostaje: instalator i tak by odmówił.
 */
async function updateCopy(
  ctx: Ctx, report: HookCopyReport,
): Promise<{
  readonly state: StepState; readonly summary: string; readonly result?: string; readonly fix?: string;
  readonly changed?: boolean;
}> {
  if (report.dirKind !== 'dir') {
    line(ctx, `${report.dir} is a symlink or not a directory — setup does not replace it`);
    return { state: 'problem', summary: COPY_OUT_OF_DATE };
  }
  const script = statuslineCopyReport(ctx.home, ctx.installRoot);
  line(ctx, `hook copy in ${report.dir} differs from ${ctx.mode === 'package' ? 'the package' : 'the repo'}:`
    + ` ${copyDifferences(report, script)}`);
  const written = [...report.files, ...script.files];
  const changed = changedAfterInstall(written);
  if (changed.length > 0) {
    line(ctx, changedAfterInstallWarning(changed));
    return {
      state: 'problem',
      summary: 'hook copy changed after the install: review rarog hooks doctor, then rarog hooks install',
    };
  }
  if (ctx.copyRefusal !== null) return refusedCopy(ctx, ctx.copyRefusal);
  for (const text of sourceMovedLines(report, { mode: ctx.mode, root: ctx.installRoot })) line(ctx, text);
  const result = await installAfterQuestion(ctx,
    copyQuestion('update', tilde(report.dir, ctx.home)),
    (opts) => installHookCopy(opts), written.every((one) => one.state === 'match'));
  if (result === null) {
    if (ctx.ask === null) {
      line(ctx, 'without a terminal setup does not update the copy');
      return { state: 'problem', summary: COPY_OUT_OF_DATE };
    }
    line(ctx, 'copy not updated');
    // The user said no: `!` like a declined install, with the command that offers it again.
    return { state: 'missing', summary: COPY_OUT_OF_DATE, ...declined(ctx) };
  }
  if (!result.ok) {
    line(ctx, `refused: ${result.reason}`);
    // An installer that fails after writing code files (the manifest) still changed the copy.
    const after = hookCopyReport(ctx.home, ctx.installRoot);
    const now = [...after.files, ...statuslineCopyReport(ctx.home, ctx.installRoot).files];
    const wrote = now.some((one) => written.some((before) => before.name === one.name && before.copySha !== one.copySha));
    return { state: 'problem', summary: `hook copy: ${result.reason}`, ...wrote ? { changed: true } : {} };
  }
  line(ctx, `copy updated (${hookOriginText(result)})`);
  for (const name of result.removed) line(ctx, `${name}: removed (file from a previous install)`);
  for (const warning of result.warnings) line(ctx, `WARNING: ${warning}`);
  return { state: 'ok', summary: '', result: 'updated to this version' };
}

/**
 * The service starts another installation (or its target is unreadable), so the copy is not written: one sentence and
 * the fix on the screen, the whole refusal in the run log.
 */
function refusedCopy(ctx: Ctx, refusal: CopyRefusal): {
  readonly state: StepState; readonly summary: string; readonly result: string; readonly fix: string;
} {
  line(ctx, `refused: ${refusal.text}`);
  return { state: 'problem', summary: `hook copy: ${refusal.text}`, result: refusal.result, fix: refusal.fix };
}

/** A hook copy the user said no to: `declined`, with the command that offers it again ({@link declinedStep}). */
function declined(ctx: Ctx): { readonly result: string; readonly fix: string } {
  return declinedStep(repairCommands(ctx.mode, ctx.installRoot).hooksInstall);
}

async function stepHook(ctx: Ctx): Promise<Step> {
  const title = 'hook copy';
  const report = hookCopyReport(ctx.home, ctx.installRoot);
  let copyState: StepState = 'ok';
  let copySummary = '';
  /** What the step did, for its screen line; `undefined` = the summary. */
  let shown: string | undefined;
  /** The command after a declined question. */
  let fix: string | undefined;
  if (report.ok) {
    line(ctx, `hook copy: ${report.dir} matches the repo`);
  } else if (copyDirEmpty(ctx.home)) {
    line(ctx, `no hook copy in ${report.dir}`);
    copyState = 'missing';
    copySummary = 'hook copy: rarog hooks install';
    // The clone's copy is a plan item; the package's copy asks after its review. A service of another
    // installation refuses here without a question.
    const question = ctx.mode === 'package'
      ? copyQuestion('install', tilde(report.dir, ctx.home)) : null;
    const result = question !== null || ctx.accepted.has('hook') || ctx.copyRefusal !== null
      ? await installAfterQuestion(ctx, question, (opts) => installMissingHookCopy(opts)) : null;
    if (result?.ok === true) {
      line(ctx, `copy written (${hookOriginText(result)})`);
      for (const warning of result.warnings) line(ctx, `WARNING: ${warning}`);
      copyState = 'ok';
      copySummary = '';
      shown = 'installed';
    } else if (result === null && question !== null && ctx.ask !== null) {
      ({ result: shown, fix } = declined(ctx));
    } else if (result !== null && !result.ok && ctx.copyRefusal !== null) {
      ({ state: copyState, summary: copySummary, result: shown, fix } = refusedCopy(ctx, ctx.copyRefusal));
    } else if (result !== null && !result.ok) {
      line(ctx, `refused: ${result.reason}`);
      copyState = 'problem';
      copySummary = `hook copy: ${result.reason}`;
    }
  } else {
    const update = await updateCopy(ctx, report);
    copyState = update.state;
    copySummary = update.summary;
    shown = update.result;
    fix = update.fix;
  }
  return {
    title, state: copyState, summary: copyState === 'ok' ? 'hook copy: matches the source' : copySummary,
    ...shown === undefined ? {} : { result: shown }, ...fix === undefined ? {} : { fix },
    changed: copyState === 'ok' && shown !== undefined,
  };
}

// ---------------------------------------------------------------------------
// Krok 6: ustawienia Claude Code (`setup-settings.ts`)
// ---------------------------------------------------------------------------

/**
 * Brakujący skrypt `statusLine` w zgodnej kopii hooka (kopia sprzed skryptu) po pytaniu, zanim pisarz wpisze komendę,
 * która go wskazuje. Only when the `statusLine` operation waits for that copy (`statusLineWaitsForScript`): a custom
 * command that writes its own snapshots stays, so the script is not offered and nothing is asked on every run.
 * `true` = skrypt zapisany.
 */
async function offerStatuslineCopy(ctx: Ctx): Promise<boolean> {
  if (!statusLineWaitsForScript(ctx)) return false;
  const copy = statuslineCopyReport(ctx.home, ctx.installRoot);
  const scriptState = copy.files[0]?.state ?? 'missing';
  if (scriptState === 'missing' && copy.dirKind !== 'symlink' && copy.dirKind !== 'other'
    && hookCopyReport(ctx.home, ctx.installRoot).ok) {
    const result = await installAfterQuestion(ctx,
      copyQuestion('statusLine', tilde(copy.dir, ctx.home)),
      (opts) => installStatuslineCopy(opts));
    if (result !== null) line(ctx, result.ok ? 'script copy written' : `refused: ${result.reason}`);
    return result?.ok === true;
  }
  if (scriptState !== 'match' && scriptState !== 'missing') {
    line(ctx, 'script copy differs from the repo — review rarog hooks doctor, then rarog hooks install');
  }
  return false;
}

/** The settings step, after the statusLine script copy it points at. */
async function stepSettings(ctx: Ctx): Promise<Step> {
  const wrote = await offerStatuslineCopy(ctx);
  const step = await stepClaudeSettings(ctx);
  // The script copy written before the settings question is a change of this step, whatever the answer.
  return wrote ? { ...step, changed: true } : step;
}

/** Start of every summary of the settings step. */
const SETTINGS_PREFIX = 'Settings: ';
/** Fix of a hook copy the update could not finish. */
const COPY_FIX = 'rarog hooks doctor, then rarog hooks install';

/**
 * The settings step of `rarog update --finish`: a new version can change only the statusLine script, so a script copy
 * that the settings run and that differs from this installation, next to hook files that match, goes through
 * {@link updateCopy} first (the installer's diff and question; no question for a copy changed after the
 * install). "n" or a refusal leaves the copy, and the settings step reports the script out of date. An installer that
 * fails after writing the code files (the manifest) leaves a script the settings check sees as current, so its
 * problem stays on the step with its fix and the step fails.
 */
async function stepFinishSettings(ctx: Ctx): Promise<Step> {
  const report = hookCopyReport(ctx.home, ctx.installRoot);
  const copy = report.ok && statusLineScriptOutOfDate(ctx) ? await updateCopy(ctx, report) : null;
  const settings = await stepSettings(ctx);
  if (copy?.state === 'ok' && (settings.state === 'ok' || settings.state === 'info')) {
    // The script this run wrote is a change of this step: its own line, not the folded checks.
    const own = settings.changed === true && settings.result !== undefined ? `${settings.result}; ` : '';
    return { ...settings, result: `${own}status line script updated`, changed: true };
  }
  if (copy?.state !== 'problem') return settings;
  const failed = settings.state === 'problem' || settings.state === 'missing';
  // The settings step already reports a script still out of date, with the same fix.
  if (failed && statusLineScriptOutOfDate(ctx)) return settings;
  const own = settings.summary.startsWith(SETTINGS_PREFIX)
    ? settings.summary.slice(SETTINGS_PREFIX.length) : settings.summary;
  return {
    title: settings.title, state: 'problem',
    summary: `${SETTINGS_PREFIX}${own}; ${copy.summary}`,
    result: `${settings.result ?? own}; ${copy.summary}`,
    fix: [...new Set([...settings.fix === undefined ? [] : [settings.fix], COPY_FIX])].join('; '),
    ...settings.changed === true || copy.changed === true ? { changed: true } : {},
  };
}

// ---------------------------------------------------------------------------
// Krok 10: SDK Claude (paczka npm)
// ---------------------------------------------------------------------------

/** `rarog setup` of this installation, with the `--data-dir` given to this run. */
function setupAgain(ctx: Ctx): string {
  return rarogCli(ctx.dataDirFlag === null ? 'setup' : `setup --data-dir ${shellQuote(ctx.dataDirFlag)}`, ctx.mode);
}

/** Rozmiar w MB z jednym miejscem po kropce dziesiętnej. */
function megabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/** Wiek w minutach, godzinach albo dniach. */
function age(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 120) return `${String(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${String(hours)} h` : `${String(Math.floor(hours / 24))} days`;
}

/**
 * SDK Claude listy sesji (`install/sdk.ts`): w klonie repo z workspace (pnpm), w paczce npm z
 * `<katalog danych usługi>/sdk/<wersja>/`. Brak (ENOENT) = pytanie i pobranie; katalog jest = sonda w osobnym
 * procesie ze środowiskiem usługi. Katalogu istniejącego setup nie zmienia ani nie kasuje.
 */
async function stepSdk(ctx: Ctx): Promise<Step> {
  const title = 'Claude SDK';
  if (ctx.mode === 'clone') {
    line(ctx, `${SDK_PACKAGE} from the repo workspace (${REPAIR.dependencies})`);
    ctx.sdkReady = true;
    return { title, state: 'info', summary: 'SDK: from the workspace' };
  }
  if (!ctx.dataDir.ok) {
    line(ctx, ctx.dataDir.message);
    return {
      title, state: 'problem', summary: 'SDK: data directory undetermined (message above)',
      result: `data directory undetermined: ${ctx.dataDir.message}`,
    };
  }
  const pin = readSdkPin();
  const dataDir = ctx.dataDir.dir;
  const dir = sdkVersionDir(dataDir, pin.version);
  const again = setupAgain(ctx);
  const probe = ctx.deps.sdkProbe ?? ((versionDir, version) => probeSdkDir(versionDir, version, ctx.serviceEnv));
  const state = entry(dir);
  if (state === 'present') {
    const issue = sdkDirIssue(sdkRoot(dataDir)) ?? sdkDirIssue(dir);
    if (issue !== null) {
      line(ctx, issue);
      return { title, state: 'problem', summary: `SDK: ${issue}` };
    }
    if (entry(path.join(dir, 'node_modules', ...SDK_PACKAGE.split('/'), 'package.json')) !== 'present') {
      line(ctx, `${dir} is present, but has no ${SDK_PACKAGE} package.json — setup does not change it; check what it`
        + ' contains');
      return { title, state: 'problem', summary: `SDK: ${dir} has no package.json for the package` };
    }
    const probed = await probe(dir, pin.version);
    if (!probed.ok) {
      line(ctx, `${dir}: ${probed.reason}`);
      return {
        title, state: 'problem', summary: `SDK ${pin.version}: probe failed (message above)`,
        result: `${pin.version}: probe failed: ${probed.reason}`,
      };
    }
    line(ctx, `${SDK_PACKAGE} ${pin.version}: ${dir}`);
    ctx.sdkReady = true;
    return { title, state: 'ok', summary: `SDK: ${pin.version}` };
  }
  if (typeof state !== 'string') {
    line(ctx, `${dir}: unreadable (${state.code})`);
    return { title, state: 'problem', summary: `SDK: ${dir} unreadable (${state.code})` };
  }
  line(ctx, `${dir}: missing`);
  for (const temp of sdkTempDirs(dataDir)) {
    line(ctx, `work directory of another or interrupted download: ${temp.dir} (${age(temp.ageMs)}, ${megabytes(temp.bytes)})`);
  }
  const missing: Step = {
    title, state: 'missing', summary: `SDK: ${again} in a terminal downloads ${SDK_PACKAGE} ${pin.version}`,
  };
  // The plan screen named the package, its size and Anthropic's terms (`sdkPlanEntry`).
  if (!ctx.accepted.has('sdk')) return missing;
  ctx.view.screen.progress('downloading…');
  const result = await (ctx.deps.sdkInstall ?? installSdk)({ dataDir, env: ctx.io.env, probe, pin, trackChild });
  if (!result.ok && result.interrupted === true) throw new SetupInterrupted(result.reason);
  if (!result.ok) {
    line(ctx, `download failed: ${result.reason}`);
    if (result.noNpm === true) {
      // A node without npm next to it (`pnpm env use`) fails the same way again; the network has nothing to do with it.
      line(ctx, 'The sessions list in the app stays empty until the SDK is downloaded; setup downloads it with the npm'
        + ' that comes with Node.');
      return {
        title, state: 'problem', summary: `SDK: download failed (${result.reason})`, result: 'no npm next to node',
        fix: `install Node with npm (nodejs.org or nvm), then ${again}`,
      };
    }
    line(ctx, `The sessions list in the app stays empty until the SDK is downloaded; once online, run ${again}.`);
    // One sentence on the screen: npm's error code; the rest of its message stays in the run log.
    const code = /\b(E[A-Z0-9]{3,})\b/u.exec(result.reason)?.[1];
    return {
      title, state: 'problem', summary: `SDK: download failed (${result.reason})`,
      result: code === undefined ? 'download failed' : `download failed (${code})`, fix: `check the network, then ${again}`,
    };
  }
  line(ctx, result.raced ? `another rarog setup downloaded ${pin.version} first: ${result.dir}`
    : `downloaded: ${result.dir}`);
  ctx.sdkReady = true;
  return { title, state: 'ok', summary: `SDK: ${pin.version} downloaded`, changed: !result.raced };
}

// ---------------------------------------------------------------------------
// Krok 11: usługa
// ---------------------------------------------------------------------------

/** `/health` of the running service: healthy or why not, and the version it reports (`undefined` = none read). */
async function healthOf(
  port: number,
): Promise<{ readonly ok: boolean; readonly text: string; readonly version?: string }> {
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (!response.ok) return { ok: false, text: `HTTP ${String(response.status)}` };
    const body: unknown = await response.json();
    if (!isRecord(body)) return { ok: false, text: 'the response is not a JSON object' };
    const version = typeof body['version'] === 'string' ? { version: body['version'] } : {};
    return body['herdr'] === true
      ? { ok: true, text: 'healthy', ...version } : { ok: false, text: HERDR_DOWN, ...version };
  } catch (failure) {
    const cause = isRecord(failure) ? failure['cause'] : undefined;
    return { ok: false, text: `not responding (${errnoCode(cause ?? failure)})` };
  }
}

/**
 * Dowiązanie `~/.local/bin/rarog` do innego checkoutu albo nieczytelne: `service install` klonu przestawiłby je na
 * swoim końcu, a setup niczego istniejącego nie zmienia. `null` = brak dowiązania, nasze, nie-dowiązanie (to
 * `service install` zostawia) albo paczka npm: jej `service install` dowiązania nie zakłada ani nie rusza, a
 * dowiązanie, które przesłania paczkę w `PATH`, pokazuje `rarog doctor`.
 */
function foreignRarogLink(home: string, mode: InstallMode): string | null {
  if (mode === 'package') return null;
  const link = rarogLinkPath(home);
  try {
    if (!lstatSync(link).isSymbolicLink()) return null;
    const target = readlinkSync(link);
    if (target === RAROG_BIN) return null;
    return `${link} points to ${target}, but the service would set it to ${RAROG_BIN}; setup does not change it —`
      + ' repoint or remove it yourself, then rarog setup';
  } catch (failure) {
    const code = errnoCode(failure);
    return code === 'ENOENT' ? null : `${link}: unreadable (${code}); check it, then rarog setup`;
  }
}

/** Ślad usługi na tej platformie: obecny (plik albo załadowana etykieta), brak obu albo nie wiadomo. */
export type ServiceTrace =
  { readonly kind: 'present'; readonly loaded: boolean; readonly detail: string }
  | { readonly kind: 'absent' } | { readonly kind: 'unknown'; readonly detail: string };

/** Ślad usługi na tej platformie ({@link ServiceTrace}). */
function serviceTrace(ctx: Ctx): ServiceTrace {
  if (ctx.platform === 'linux') {
    const file = unitFilePath(ctx.home);
    const fileState = entry(file);
    const shown = showUnit(ctx.io, ['LoadState']);
    if ('failure' in shown) return { kind: 'unknown', detail: shown.failure };
    const load = shown.values.get('LoadState') ?? '';
    if (fileState === 'missing' && load === 'not-found') return { kind: 'absent' };
    return {
      kind: 'present', loaded: load === 'loaded',
      detail: `${file}: ${fileState === 'missing' ? 'missing' : 'present'}, LoadState=${load}`,
    };
  }
  const plist = entry(servicePlistPath(ctx.home));
  const loaded = loadState(SERVICE_LABEL, ctx.io, ctx.platform);
  if (typeof loaded !== 'string') return { kind: 'unknown', detail: `launchctl print ${SERVICE_LABEL}: ${loaded.unknown}` };
  if (plist === 'missing' && loaded === 'absent') return { kind: 'absent' };
  return {
    kind: 'present', loaded: loaded === 'loaded',
    detail: `plist ${SERVICE_LABEL}: ${plist === 'missing' ? 'missing' : 'present'}, ${SERVICE_LABEL}: ${loaded}`,
  };
}

/**
 * The herdr step of the platform: the herdr agent on macOS, the herdr unit on Linux. A herdr step with a fix, written
 * in this run or found as it is, carries the one fix; the Service step waits for it while herdr is down.
 */
async function stepHerdr(ctx: Ctx): Promise<Step | null> {
  const step = ctx.platform === 'darwin' ? await stepHerdrAgent(ctx) : await stepHerdrUnit(ctx);
  if (step?.fix !== undefined) {
    ctx.herdrWaits = ctx.platform === 'darwin' ? HERDR_AGENT_TITLE : HERDR_UNIT_TITLE;
  }
  return step;
}

async function stepService(ctx: Ctx): Promise<Step> {
  const title = 'service';
  const trace = serviceTrace(ctx);
  if (trace.kind === 'unknown') {
    ctx.service = 'other';
    line(ctx, `service state undetermined (${trace.detail}) — installing nothing`);
    const summary = `service: ${trace.detail}`;
    if (ctx.serviceWaits !== null) {
      ctx.checkWaits = ctx.serviceWaits;
      return waitingStep(title, 'problem', summary, ctx.serviceWaits);
    }
    // One sentence and a fix; the tool's own message stays in the detail line above (the run log).
    return {
      title, state: 'problem', summary, result: SERVICE_UNDETERMINED,
      fix: serviceStateFix(ctx.platform, setupAgain(ctx)),
    };
  }
  const port = ctx.deps.checkPort ?? configPort(ctx);
  if (trace.kind === 'present') {
    line(ctx, trace.detail);
    ctx.service = trace.loaded ? 'running' : 'other';
    const install = rarogCli('service install', ctx.mode);
    if (!trace.loaded) {
      return {
        title, state: 'problem',
        summary: `service: a trace is present, but our service is not loaded — run ${install} by hand`,
        result: 'installed, but not loaded', fix: install,
      };
    }
    let health = await healthOf(port);
    line(ctx, `/health 127.0.0.1:${String(port)}: ${health.text}`);
    if (health.text === HERDR_DOWN && await accepts({ path: herdrSocket(ctx) })) {
      // /health keeps its herdr ping for HEALTH_PROBE_TTL_MS: a herdr started moments ago (the herdr agent step of this
      // run) can still read false there. One more read past that window before judging the service.
      await new Promise<void>((resolve) => { setTimeout(resolve, HEALTH_PROBE_TTL_MS + 500); });
      health = await healthOf(port);
      line(ctx, `/health again after the herdr ping window: ${health.text}`);
    }
    if (health.ok) return { title, state: 'ok', summary: 'service: running' };
    // The fix stands on this line; the closing Check waits for this step instead of repeating it.
    ctx.service = 'other';
    // `rarog restart` restarts only this installation's service: a service that starts another installation (its
    // target, or the version its /health reports) gets the command that points it here (`afterUpdate`).
    const commands = repairCommands(ctx.mode, ctx.installRoot);
    const other = ctx.copyRefusal !== null || (health.version !== undefined && health.version !== packageVersion());
    // herdr: false with herdr's socket silent: the server reconnects to herdr by itself once herdr runs, and a
    // restart does not start herdr. herdr 0.9.5 has no service of its own; on Linux setup knows `herdr.service`, on
    // macOS a loaded herdr agent.
    // A socket that answers means the server does not see this herdr (a socket path changed after its start, or
    // its herdr runtime failed to load): the restart reloads both.
    const socket = herdrSocket(ctx);
    const herdrDown = !other && health.text === HERDR_DOWN && !await accepts({ path: socket });
    const herdrStart = herdrAgentStart(ctx.io, ctx.home, ctx.platform)
      ?? (ctx.platform === 'linux' && entry(path.join(userUnitDir(ctx.home), HERDR_UNIT_NAME)) === 'present'
        ? `systemctl --user start ${HERDR_UNIT_NAME}` : 'run herdr in a terminal');
    const fix = other ? commands.afterUpdate : herdrDown ? `${herdrStart}, then ${setupAgain(ctx)}` : commands.restart;
    if (other) line(ctx, `the service runs ${health.version ?? 'another installation'}, not this installation`);
    if (herdrDown) line(ctx, 'the service runs, herdr does not; it reconnects once herdr starts, without a restart');
    else if (!other && health.text === HERDR_DOWN) {
      line(ctx, `herdr answers on ${socket}, but the service does not reach it; a restart reloads its configuration`);
    }
    if (herdrDown && ctx.herdrWaits !== null) {
      ctx.checkWaits = ctx.herdrWaits;
      return waitingStep(title, 'problem', `service unhealthy (${health.text}): ${fix}`, ctx.herdrWaits);
    }
    return {
      title, state: 'problem', summary: `service unhealthy (${health.text}): ${fix}`, result: health.text, fix,
    };
  }
  line(ctx, 'no service');
  const missing: Step = { title, state: 'missing', summary: `service: ${rarogCli('service install', ctx.mode)}` };
  // A service that waits for an earlier step names it, without a command: that step carries the fix.
  const waits = (on: string): Step => {
    ctx.checkWaits = on;
    return waitingStep(title, 'missing', missing.summary, on);
  };
  if (ctx.config === null) {
    line(ctx, 'config.json and a valid secrets file first (steps above)');
    return waits(ctx.configWaits ?? SCREEN_TITLE.config);
  }
  if (!ctx.secretsOk) {
    line(ctx, 'config.json and a valid secrets file first (steps above)');
    return waits(SCREEN_TITLE.secrets);
  }
  if (!ctx.sdkReady) {
    line(ctx, 'the Claude SDK first (step above): without it rarog serve --check refuses');
    return waits(SCREEN_TITLE.sdk);
  }
  const socket = herdrSocket(ctx);
  if (!await accepts({ path: socket })) {
    line(ctx, `herdr is not running (socket ${socket} does not respond). Start herdr and run rarog setup again.`);
    if (ctx.herdrWaits !== null) return waits(ctx.herdrWaits);
    // The socket stays in the detail line above (the run log); the screen says what to do.
    return {
      title, state: 'missing', summary: `service: herdr first (socket ${socket}), then rarog setup`,
      result: 'herdr is not running', fix: `start herdr, then ${setupAgain(ctx)}`,
    };
  }
  const link = foreignRarogLink(ctx.home, ctx.mode);
  if (link !== null) {
    line(ctx, link);
    return { title, state: 'problem', summary: `service: ${link}` };
  }
  if (!ctx.accepted.has('service')) return missing;
  const what = ctx.platform === 'linux' ? `the systemd --user unit ${UNIT_NAME}` : `the launchd service ${SERVICE_LABEL}`;
  line(ctx, `installing ${what} (rarog service install)`);
  // Pod blokadą instalatora jeszcze raz: usługa albo dowiązanie mogły powstać w trakcie pytania.
  const precheck = (): string | null => {
    const again = serviceTrace(ctx);
    if (again.kind === 'present') return `the service appeared during the question (${again.detail}) — changing nothing`;
    if (again.kind === 'unknown') return `service state undetermined (${again.detail}) — changing nothing`;
    return foreignRarogLink(ctx.home, ctx.mode);
  };
  // Its own lines and those of restart.sh are details: the run log, and the screen with --verbose.
  const code = await ctx.deps.serviceInstall(ctx.view.detailIo(), precheck, (text) => { ctx.view.detail(text); });
  if (code === EXIT_INTERRUPTED) throw new SetupInterrupted('rarog service install was interrupted (Ctrl-C)');
  ctx.service = code === EXIT_OK ? 'running' : 'other';
  return code === EXIT_OK
    ? { title, state: 'ok', summary: 'service: installed', changed: true }
    : {
      title, state: 'problem', summary: `service: rarog service install, code ${String(code)} (message above)`,
      result: `rarog service install failed (code ${String(code)})`, fix: 'rarog service install',
    };
}

// ---------------------------------------------------------------------------
// Komenda
// ---------------------------------------------------------------------------

const MARK: Readonly<Record<StepState, string>> = {
  ok: 'ok     ', info: 'info   ', warn: 'WARNING', missing: 'MISSING', problem: 'PROBLEM',
};

/**
 * Zdanie o aktualizacji paczki npm: komenda menedżera, który ją położył, potem komenda, po której usługa startuje
 * nową wersję (`afterUpdate` z `install/repair.ts`: restart pod npm, `rarog service install` pod pnpm). Klon repo
 * aktualizuje się własną procedurą, więc `null`.
 */
export function updateSentence(mode: InstallMode, root: string): string | null {
  if (mode !== 'package') return null;
  const { update } = packageCommands(packageManagerOf(root), root);
  return `To update Rarog: ${update}, then ${repairCommands(mode, root).afterUpdate}; to go back to an older version,`
    + ' run the same command with its number instead of latest.';
}

/**
 * Step titles on the screen (at most 14 characters) next to the headers `--verbose` keeps. The seventh step is the
 * herdr unit on Linux and the herdr agent on macOS; elsewhere it has no line on the step screen.
 */
function stepTitles(platform: NodeJS.Platform): readonly (readonly [header: string, title: string])[] {
  return [
    ['tools', SCREEN_TITLE.tools], ['config.json', SCREEN_TITLE.config], ['secrets file', SCREEN_TITLE.secrets],
    ['tailscale serve', 'Tailscale'], ['hook copy', 'Hook copy'], ['Settings', 'Settings'],
    platform === 'darwin' ? ['herdr agent (macOS)', HERDR_AGENT_TITLE] : ['herdr.service (Linux)', HERDR_UNIT_TITLE],
    ['Claude SDK', SCREEN_TITLE.sdk], ['service', SCREEN_TITLE.service],
  ];
}

const HERDR_AGENT_TITLE = 'herdr agent';
const HERDR_UNIT_TITLE = 'herdr unit';

/** The step has a line on the step screen of `platform` (`--verbose` keeps every header). */
function onScreen(title: string, platform: NodeJS.Platform): boolean {
  return title !== HERDR_UNIT_TITLE || platform === 'linux';
}

/** Lines the step screen counts on `platform`: the steps it shows and the closing Check. */
function screenTotal(platform: NodeJS.Platform): number {
  return stepTitles(platform).filter(([, title]) => onScreen(title, platform)).length + 1;
}

/** Steps that wait on a child process or the network: their live line has a spinner. */
const ANIMATED = new Set(['Claude SDK', 'Service', HERDR_AGENT_TITLE]);

/**
 * The herdr socket of an existing `config.json` for the plan screen, read before the Config step validates the file.
 * A missing or unreadable file gives herdr's default, as the steps use without `config.json`.
 */
function planHerdrSocket(ctx: Ctx): string {
  let config: RarogConfig | null = null;
  try {
    config = readRarogConfig(ctx.io.env);
  } catch {
    // The Config step reports the file; the plan reads it only for the socket.
  }
  return configuredHerdrSocket(config?.env[HERDR_SOCKET_ENV], ctx.home);
}

/**
 * What the plan screen offers to create (`setup-plan.ts`), from a read of the disk without writes: a missing
 * `config.json`, a missing hook copy this installation may write, the herdr agent (macOS) or unit (Linux) under the
 * conditions its step writes it, the Claude SDK of the package, the service. In the order of the steps.
 */
async function planEntries(ctx: Ctx): Promise<PlanEntry[]> {
  const entries: PlanEntry[] = [];
  const short = (file: string): string => (file.startsWith(`${ctx.home}/`) ? `~/${file.slice(ctx.home.length + 1)}`
    : file);
  const dir = rarogConfigDir(ctx.io.env);
  ctx.configDirAbsent = entry(dir) === 'missing';
  if (entry(path.join(dir, CONFIG_FILENAME)) === 'missing') {
    entries.push({
      item: 'config', what: ctx.tailscaleOnly === null ? 'config and server key' : TAILSCALE_ONLY_PLAN_ITEM,
      where: short(dir),
    });
  }
  // In the package the copy keeps its own question after the review of the package files.
  if (ctx.mode !== 'package' && copyDirEmpty(ctx.home) && ctx.copyRefusal === null) {
    entries.push({ item: 'hook', what: 'permission hook copy', where: short(hookInstallDir(ctx.home)) });
  }
  const socket = planHerdrSocket(ctx);
  const herdr = ctx.platform === 'darwin' ? herdrAgentOffer(ctx, socket) : await herdrUnitOffer(ctx, socket);
  if (herdr !== null) entries.push(herdr);
  if (ctx.mode === 'package' && ctx.dataDir.ok) {
    const pin = readSdkPin();
    if (entry(sdkVersionDir(ctx.dataDir.dir, pin.version)) === 'missing') {
      entries.push(sdkPlanEntry(pin.version));
    }
  }
  if (serviceTrace(ctx).kind === 'absent') {
    entries.push({
      item: 'service', what: 'background service', where: ctx.platform === 'linux' ? UNIT_NAME : SERVICE_LABEL,
    });
  }
  return entries;
}

/** `rarog setup` — `argv` zaczyna się od `setup`; `deps` podają testy. */
export async function setupCommand(
  argv: readonly string[], io: CliIo, deps: SetupDeps = DEFAULT_DEPS,
): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    out(io, usageFor(io, `Usage:\n${SETUP_USAGE}`));
    return EXIT_OK;
  }
  const flags = parseFlags(argv);
  const platform = platformOf(io);
  if (platform !== 'darwin' && platform !== 'linux') {
    out(io, `rarog setup supports macOS and Linux (systemd --user); this platform is ${platform}.`);
    return EXIT_REFUSED;
  }
  const mode = deps.mode ?? INSTALL_MODE;
  const transient = transientInstall(mode, deps.installRoot ?? INSTALL_ROOT, io.env);
  if (transient !== null) {
    out(io, `rarog setup: started from ${transient}. The service would point to a directory that disappears when the`
      + ` package manager cache is cleared. Install it permanently: ${PACKAGE_INSTALL.npm} (or ${PACKAGE_INSTALL.pnpm}),`
      + ' then rarog setup.');
    return EXIT_REFUSED;
  }
  const startedAt = Date.now();
  const home = homeOf(io.env);
  const installRoot = deps.installRoot ?? INSTALL_ROOT;
  const { serviceEnv, dataDir } = runDataDir(io, platform, flags.dataDir);
  // The closing Check is one more step line (none with --verbose, which keeps the old output).
  const view = new SetupView({
    io, home, verbose: flags.verbose, dataDir, total: screenTotal(platform),
    cliTarget: setupCliTarget({ mode, installRoot, home, io }),
  });
  const ctx: Ctx = {
    io: view.blockIo(), view, platform, home, ask: view.ask, deps,
    irohRelay: flags.irohRelay ?? DEFAULT_IROH_RELAY, irohRelayGiven: flags.irohRelay !== null,
    herdr: null, herdrIntegration: null, accepted: new Set(), declined: new Set(), configDirAbsent: false, claude: null,
    tailscale: false, iroh: { ready: false, text: 'not checked' }, tailscaleOnly: null, originFromTailscale: null,
    transportNote: null, tailscaleIps: [], tailscaleStatus: null,
    config: null, secretsOk: false,
    mode, installRoot, serviceEnv, dataDirFlag: flags.dataDir, sdkReady: false, service: 'skipped', dataDir,
    configCreated: false, irohKeyCreated: false, configWaits: null, checkWaits: null, serviceWaits: null,
    herdrWaits: null,
    // Przed pierwszym zapisem (krok config.json): kopię hooka obok usługi pisze tylko instalacja, którą ona startuje.
    copyRefusal: copyTargetRefusalOf(io, { mode, root: installRoot }), copyWithoutQuestion: false,
  };
  const stopWatching = view.watchInterrupt();
  try {
    // `--tailscale-only` with `--tailscale` is `--tailscale-only` alone: it never adds an address to a config.json.
    const address = flags.tailscale && !flags.tailscaleOnly ? tailscaleAddress(ctx, deps.configWrites) : null;
    return await runSteps(ctx, view, startedAt, address, flags.tailscaleOnly);
  } finally {
    stopWatching();
  }
}

/**
 * The service environment and the data directory of a run: `--data-dir`, otherwise the directory of the installed
 * service's log, otherwise the rule on the service environment (`install/data-dir.ts`). Setup and `rarog update
 * --finish` alike.
 */
export function runDataDir(
  io: CliIo, platform: NodeJS.Platform, flag: string | null,
): { readonly serviceEnv: NodeJS.ProcessEnv; readonly dataDir: InstallDataDir } {
  const home = homeOf(io.env);
  const serviceEnv = serviceEnvOf(io, platform);
  return {
    serviceEnv,
    dataDir: installDataDir({
      home, shellEnv: io.env, serviceEnv, flag: flag ?? undefined,
      serviceDir: installedServiceDataDir(io, platform, home),
    }),
  };
}

/**
 * Setup's steps for `rarog update --finish` (`update.ts`), each as in setup, over an installation that is already set
 * up: no plan screen, and no `config.json`, secrets, Tailscale or herdr unit step, so the work area and the roots stay
 * byte for byte. The Claude SDK downloads without a question (an update needs the version it pins); the Rarog entries
 * keep their question, the hook copy too unless the update run has just installed this package, and
 * herdr's integration is not offered (an update does not change it).
 */
export interface FinishSteps {
  readonly ctx: Ctx;
  /** The pinned Claude SDK: probed when present, downloaded when missing. */
  sdk(): Promise<Step>;
  /** The hook copy: a missing or differing copy after its diff and question; refused next to another installation. */
  hook(): Promise<Step>;
  /**
   * Rarog's entries in `~/.claude/settings.json`: one question only when an entry changes; first the statusLine script
   * copy they run, when it differs from this installation (its diff and question).
   */
  settings(): Promise<Step>;
  /** The service on this platform. */
  service(): ServiceTrace;
  /** The service now starts this installation: the hook copy steps may write next to it. */
  serviceMoved(): void;
}

/** {@link FinishSteps} of `rarog update --finish` in `view`, for an existing `config.json`. */
export function finishSteps(io: CliIo, view: SetupView, run: {
  readonly platform: NodeJS.Platform;
  readonly dataDirFlag: string | null;
  readonly serviceEnv: NodeJS.ProcessEnv;
  readonly dataDir: InstallDataDir;
  readonly config: RarogConfig;
  /** The update lock names this installation as just installed: copies without their question. */
  readonly copyWithoutQuestion: boolean;
}, deps: SetupDeps): FinishSteps {
  const mode = deps.mode ?? INSTALL_MODE;
  const installRoot = deps.installRoot ?? INSTALL_ROOT;
  const target = { mode, root: installRoot };
  const ctx: Ctx = {
    io: view.blockIo(), view, platform: run.platform, home: homeOf(io.env), ask: view.ask, deps,
    irohRelay: DEFAULT_IROH_RELAY, irohRelayGiven: false, herdr: null, herdrIntegration: null,
    accepted: new Set(['sdk']), declined: new Set(), configDirAbsent: false, claude: null, tailscale: false,
    iroh: { ready: false, text: 'not checked' }, tailscaleOnly: null, originFromTailscale: null, transportNote: null,
    tailscaleIps: [], tailscaleStatus: null, config: run.config, secretsOk: true, mode, installRoot,
    serviceEnv: run.serviceEnv, dataDirFlag: run.dataDirFlag, sdkReady: false, service: 'skipped', dataDir: run.dataDir,
    configCreated: false, irohKeyCreated: false, configWaits: null, checkWaits: null, serviceWaits: null,
    herdrWaits: null,
    copyRefusal: copyTargetRefusalOf(io, target), copyWithoutQuestion: run.copyWithoutQuestion,
  };
  return {
    ctx,
    sdk: async () => stepSdk(ctx),
    hook: async () => stepHook(ctx),
    settings: async () => stepFinishSettings(ctx),
    service: () => serviceTrace(ctx),
    serviceMoved: () => { ctx.copyRefusal = copyTargetRefusalOf(io, target); },
  };
}

/**
 * The steps in order, the summary and the closing check (`setup-check.ts`) with the update sentence; `address` =
 * `--tailscale` (its plan item, step 4 and its notes), `tailscaleOnly` = `--tailscale-only`.
 */
async function runSteps(
  ctx: Ctx, view: SetupView, startedAt: number, address: TailscaleAddress | null, tailscaleOnly: boolean,
): Promise<number> {
  view.header(ctx.ask === null
    ? 'rarog setup without a terminal: checks only, no questions and no writes.'
    : 'rarog setup: creates only what is missing, after one Continue? for the plan; of what exists it changes only'
      + ' a hook copy that differs from the source and the Rarog entries in ~/.claude/settings.json (one question,'
      + ' then herdr\'s own entry through herdr\'s installer), and adds a missing iroh server key and the voice keys'
      + ' to the secrets file after their questions; with --tailscale, the Tailscale address to a config.json without'
      + ' one.');
  const tools = checkTools(ctx);
  const refused = refusalBeforePlan(ctx, tools);
  if (refused !== null) return refused;
  const only = await tailscaleOnlyBeforePlan(ctx, { flag: tailscaleOnly, relay: DEFAULT_IROH_RELAY });
  if (only !== null) return stopBeforePlan(ctx, only);
  const entries = [...address === null ? [] : await address.plan(), ...await planEntries(ctx)];
  if (!await confirmPlan(ctx, entries)) return EXIT_REFUSED;
  const runners: readonly ((c: Ctx) => Step | null | Promise<Step | null>)[] = [
    (c) => stepTools(c, tools), stepConfig, stepSecrets, address === null ? stepTailscale : async () => address.step(),
    stepHook, stepSettings, stepHerdr, stepSdk, stepService,
  ];
  const titles = stepTitles(ctx.platform);
  const steps: Step[] = [];
  // The step screen counts the closing Check too, and the log's headers use its total; --verbose keeps its own.
  const total = view.verbose ? runners.length : screenTotal(ctx.platform);
  let number = 0;
  try {
    for (const [index, run] of runners.entries()) {
      const [header, title] = titles[index] ?? ['', ''];
      if (!view.verbose && !onScreen(title, ctx.platform)) {
        // A step of another platform: one log line, no line on the step screen.
        view.detail(`${header}: not applicable on this platform`);
        continue;
      }
      number += 1;
      view.startStep(`[${String(number)}/${String(total)}] ${header}`, title, ANIMATED.has(title));
      const step = await run(ctx);
      view.endStep(step, ctx.home);
      if (step !== null) steps.push(step);
      // The steps after it that need config.json wait for the step that left the run without it.
      if (run === stepConfig && ctx.config === null) ctx.configWaits ??= SCREEN_TITLE.config;
    }
  } catch (failure) {
    if (!(failure instanceof SetupInterrupted)) throw failure;
    return view.interrupted();
  }
  view.detail('');
  view.detail('Summary:');
  for (const step of steps) view.detail(`  ${MARK[step.state]}  ${step.summary}`);
  address?.notes();
  const problems = steps.some((step) => step.state === 'missing' || step.state === 'problem');
  const check = await closingCheck(ctx, {
    startedAt, service: ctx.service, update: updateSentence(ctx.mode, ctx.installRoot), stepsOk: !problems,
  });
  return problems || check !== EXIT_OK ? EXIT_REFUSED : EXIT_OK;
}
