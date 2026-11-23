/**
 * Shared ground of the `rarog setup` steps (`setup.ts` and the step modules `setup-*.ts`): the step result, the
 * context one run carries from step to step, the dependencies tests replace, and the file helpers behind the rule
 * "create only what is missing". No step lives here; the steps and their order stay in `setup.ts`.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, linkSync, lstatSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_PORT, defaultHerdrSocket, parseHerdrSocket } from '../config.ts';
import { HERDR_SOCKET_ENV } from '../config-env.ts';
import { hookInstallDir } from '../herdr/hook-config.ts';
import type { InstallDataDir } from '../install/data-dir.ts';
import type { InstallMode } from '../install/mode.ts';
import type { SdkDirProbe, SdkInstallOptions, SdkInstallResult } from '../install/sdk.ts';
import type { IrohModuleInfo } from '../iroh/adapter.ts';
import type { ChildSink } from './child-output.ts';
import type { ConfigWrites } from './config-rewrite.ts';
import type { CopyRefusal, HerdrIntegration } from './hooks.ts';
import type { CliIo } from './io.ts';
import { SERVICE_LABEL, launchdTarget } from './restart.ts';
import { confirm as confirmForm } from './screen/ask.ts';
import type { RarogConfig } from './serve.ts';
import type { InstallPrecheck } from './service.ts';
import type { SetupView } from './setup-screen.ts';
import { UNIT_NAME } from './systemd-unit.ts';

/**
 * Wynik kroku: `ok` i `info` nie psują kodu wyjścia; `missing` i `problem` tak. `warn` = something outside Rarog's
 * own writes did not work (herdr's installer after the Rarog entries): `!` on the screen, the exit code stays.
 */
export type StepState = 'ok' | 'info' | 'warn' | 'missing' | 'problem';

/**
 * What the plan screen covers with its one "Continue?" (`setup-plan.ts`): created without a question of their own.
 * `herdr` = the herdr agent on macOS (`setup-herdr-agent.ts`), `herdr.service` on Linux (`setup-herdr-unit.ts`);
 * `tailscale` = the Tailscale address `rarog setup --tailscale` adds to an existing `config.json`
 * (`setup-tailscale-add.ts`).
 */
export type PlanItem = 'config' | 'hook' | 'sdk' | 'service' | 'herdr' | 'tailscale';

export interface Step {
  readonly title: string;
  readonly state: StepState;
  /** Jedno zdanie do podsumowania (co jest albo czego brak i jaką komendą to naprawić). */
  readonly summary: string;
  /**
   * The result on the step's screen line when the summary points at detail lines (`message above`), which the step
   * screen hides, or carries detail the line has no room for (a path, the backup), which the run log keeps; by default
   * the summary. The `Summary:` block of `--verbose` keeps the summary.
   */
  readonly result?: string;
  /** Command that fixes a failed step (`Fix:` under its screen line). */
  readonly fix?: string;
  /**
   * The user said no to it, it waits for an earlier step, or it is not used: `–` on the screen instead of `!` or `✓`
   * (the state still counts for the exit code).
   */
  readonly skipped?: boolean;
  /**
   * The step wrote, downloaded, installed or restarted something (default `false`). The step sets it itself; the
   * screen never guesses it from the text. An `ok` step without a change has no line of its own.
   */
  readonly changed?: boolean;
}

/** Screen titles other steps name when they wait for one (`– Service waits for Claude SDK`). */
export const SCREEN_TITLE = {
  tools: 'Tools', config: 'Config', secrets: 'Secrets', sdk: 'Claude SDK', service: 'Service', restart: 'Restart',
} as const;

/**
 * A step that cannot run because an earlier step did not finish: `– <Step> waits for <step>` on the screen, without
 * a command (the earlier step carries the one fix); `summary` keeps the `--verbose` wording.
 */
export function waitingStep(title: string, state: StepState, summary: string, on: string): Step {
  return { title, state, summary, result: `waits for ${on}`, skipped: true };
}

/**
 * A question the user said no to: `! <Step> declined` on the screen, with the command that offers it again as the fix,
 * so the screen rewrites it like every other fix (the absolute form outside `PATH`) and it copies whole.
 */
export function declinedStep(fix: string): { readonly result: string; readonly fix: string } {
  return { result: 'declined', fix };
}

/** The one sentence of a service whose state launchd or `systemctl --user` did not give (their message: the run log). */
export const SERVICE_UNDETERMINED = 'state undetermined';

/**
 * The fix of a service whose state launchd or `systemctl --user` did not give: the command that shows it, run in a
 * regular terminal (a sandbox or another session refuses it), then `again`.
 */
export function serviceStateFix(platform: NodeJS.Platform, again: string): string {
  const show = platform === 'linux' ? `systemctl --user status ${UNIT_NAME}`
    : `launchctl print ${launchdTarget(SERVICE_LABEL) ?? SERVICE_LABEL}`;
  return `check ${show} in a regular terminal, then ${again}`;
}

/** TCP connection to a port on one address: accepted, refused, or neither (timeout, other error). */
export type TcpProbe = 'listening' | 'refused' | 'unknown';

/** Zależności, które testy podmieniają (instalacja usługi ma własne testy). */
export interface SetupDeps {
  /**
   * `rarog service install` z `precheck` wołanym pod blokadą instalatora (napis = odmowa bez zmian); `output` takes
   * the `restart.sh` lines (the run log, or the screen with `--verbose`); `dataDir` is the `--data-dir` of `rarog
   * update --finish`, which the new service must use (`ServiceDeps.dataDir`).
   */
  readonly serviceInstall: (
    io: CliIo, precheck: InstallPrecheck, output?: ChildSink, dataDir?: string,
  ) => Promise<number>;
  /** Port of `/health` for the Service step and the closing check (default: `RAROG_PORT` of `config.json`; tests give
   * their own server, never the owner's live one). */
  readonly checkPort?: number;
  /** Ceiling of the closing check's wait for `/health` (default `CHECK_HEALTH_TIMEOUT_MS`, 30 s). */
  readonly checkTimeoutMs?: number;
  /** Tryb i korzeń instalacji (domyślnie tej, z `install/mode.ts`). */
  readonly mode?: InstallMode;
  readonly installRoot?: string;
  /** Pobranie SDK (domyślnie `installSdk`). */
  readonly sdkInstall?: (options: SdkInstallOptions) => Promise<SdkInstallResult>;
  /** Sonda katalogu SDK (domyślnie `probeSdkDir` ze środowiskiem usługi). */
  readonly sdkProbe?: SdkDirProbe;
  /** Sufit `herdr integration install claude` w kroku 1 (domyślnie 30 s; testy przekroczenia podają krótszy). */
  readonly herdrInstallTimeoutMs?: number;
  /** Ceiling of the wait for herdr's ping after the herdr agent's `launchctl bootstrap` (default 20 s). */
  readonly herdrStartTimeoutMs?: number;
  /** Native iroh module from the manifests (default `irohModuleInfo`; tests give a ready one or the Intel case). */
  readonly irohModule?: () => IrohModuleInfo;
  /**
   * TCP probe of a port of the Tailscale pool on one address before `tailscale serve` (default: a connection to
   * `<host>:<port>`).
   */
  readonly tcpProbe?: (host: string, port: number) => Promise<TcpProbe>;
  /** Ceiling of each `tailscale` call (default 30 s; the test of a `serve` that waits gives a shorter one). */
  readonly tailscaleTimeoutMs?: number;
  /** Steps of the `config.json` rewrite of `--tailscale` (default `CONFIG_WRITES`; tests inject a failure). */
  readonly configWrites?: ConfigWrites;
}

/** Tailscale's own state that leaves it out of this run. */
export type TailscaleDown = 'logged out' | 'stopped' | 'not running';

/**
 * `tailscale status --json` as setup read it (`setup-transport.ts`): the server address with this machine's Tailscale
 * IPs and whether HTTPS is off in the tailnet, or why there is no address (`down` = the client's state, `null` when
 * the output does not say).
 */
export type TailscaleStatus =
  | { readonly origin: string; readonly ips: readonly string[]; readonly httpsOff: boolean }
  | { readonly failure: string; readonly down: TailscaleDown | null };

export interface Ctx {
  /**
   * `CliIo` of the steps: its stdout and stderr carry blocks to paste (they stay on the screen and never reach the
   * log); spawned tools get its `env`.
   */
  readonly io: CliIo;
  /** Screen and run log of this run: {@link line} goes there. */
  readonly view: SetupView;
  readonly platform: NodeJS.Platform;
  readonly home: string;
  readonly ask: ((prompt: string) => Promise<string | null>) | null;
  /** iroh relay of a new `config.json` in the canonical form: `--iroh-relay` or `DEFAULT_IROH_RELAY` of `setup.ts`. */
  readonly irohRelay: string;
  /** `--iroh-relay` given in this call. */
  readonly irohRelayGiven: boolean;
  readonly deps: SetupDeps;
  /** Ścieżka herdr znaleziona w kroku 1 (`PATH` albo `~/.local/bin/herdr`). */
  herdr: string | null;
  /** herdr's Claude integration read in step 1; the settings step offers its installer when it is not current. */
  herdrIntegration: HerdrIntegration | null;
  /** What the user accepted on the plan screen ("Continue?"); empty without a terminal or after "n". */
  readonly accepted: Set<PlanItem>;
  /**
   * What the user declined on the plan screen while the run goes on: "n" on a plan of the herdr item alone declines
   * just that item; any other plan stops on "n". Empty otherwise.
   */
  readonly declined: Set<PlanItem>;
  /**
   * The config directory was missing when the plan was read: a directory that is a symlink at the write was planted
   * after the question, so step 2 writes nothing into it.
   */
  configDirAbsent: boolean;
  /** Ścieżka `claude` znaleziona w kroku 1; jej katalog idzie do `PATH` jednostki herdr. */
  claude: string | null;
  /** `tailscale` w `PATH` (krok 1). */
  tailscale: boolean;
  /** iroh native module from step 1: ready (the package and platform package manifests) and its line text. */
  iroh: { readonly ready: boolean; readonly text: string };
  /**
   * Tailscale only for a new `config.json` (`--tailscale-only`, or "y" to the question before the plan,
   * `setup-tailscale-only.ts`): iroh off with `relay` kept in the file for a switch back; `null` = the transport the
   * machine gives.
   */
  tailscaleOnly: { readonly relay: string } | null;
  /**
   * The address taken in THIS run from `tailscale status`, or the pool address of this machine that `--tailscale`
   * found in `config.json`: only for it, and only with a pool port, step 4 runs `tailscale serve` itself (after its
   * question and a fresh check of that port).
   */
  originFromTailscale: string | null;
  /** Why a `config.json` created in this run has no Tailscale address (step 4 prints it), `null` = it has one. */
  transportNote: string | null;
  /** This machine's Tailscale addresses (`Self.TailscaleIPs`) read in this run: the pool port probes try them. */
  tailscaleIps: readonly string[];
  /**
   * `tailscale status --json` read in step 2, after the plan question, for step 4 (why Tailscale is left out, HTTPS
   * off); `null` = not read. The read before the plan only decides the refusal and is not kept.
   */
  tailscaleStatus: TailscaleStatus | null;
  /** `config.json` po walidacji (istniejący albo utworzony w kroku 2). */
  config: RarogConfig | null;
  /** Plik sekretów w porządku, nieobecny (opcjonalny) albo zbędny (wrapper); `false` = plik jest, ale wadliwy. */
  secretsOk: boolean;
  readonly mode: InstallMode;
  /** Korzeń instalacji: źródło kopii hooka (`<korzeń>/scripts/hooks/`). */
  readonly installRoot: string;
  /** Środowisko, które dostanie usługa (macOS: jak pod launchd; Linux: menedżer `systemd --user`). */
  readonly serviceEnv: NodeJS.ProcessEnv;
  /** Katalog danych usługi (`install/data-dir.ts`) albo powód, dla którego go nie ma. */
  readonly dataDir: InstallDataDir;
  /** `--data-dir` z wywołania. */
  readonly dataDirFlag: string | null;
  /** SDK gotowy (krok „SDK Claude” zielony albo klon repo): bez niego setup nie instaluje usługi. */
  sdkReady: boolean;
  /** The service after the service step, for the closing check: running, none (skipped), or neither is clear. */
  service: 'running' | 'skipped' | 'other';
  /** Step 2 wrote `config.json` in this run (the Tailscale step then says that the new file does not use it). */
  configCreated: boolean;
  /** This run wrote the iroh server key into the secrets file (step 2, or step 3 after its question). */
  irohKeyCreated: boolean;
  /**
   * Screen title of the step that left this run without `config.json` (`Tools` when a tool for it is missing, else
   * `Config`); the steps that need the file wait for it. `null` = the file is there.
   */
  configWaits: string | null;
  /**
   * Screen title of the step the closing Check waits for when no service runs (the step whose problem stopped the
   * service); `null` = the Service step.
   */
  checkWaits: string | null;
  /**
   * Screen title of the step the Service step waits for when the service manager does not answer (`Tools`, whose
   * line names `systemctl --user`); `null` = the Service step reads the service state itself.
   */
  serviceWaits: string | null;
  /**
   * Screen title of the herdr step (`herdr unit`, `herdr agent`) that wrote its file in this run and still carries a
   * fix: with herdr not running the Service step waits for it instead of a second fix; `null` = none.
   */
  herdrWaits: string | null;
  /**
   * Cel usługi wobec tej instalacji, odczytany przed pierwszym zapisem setupu ({@link copyTargetRefusal}): napis =
   * usługa startuje inną instalację albo jej celu nie da się odczytać, więc kroki hooka i `statusLine` kopii nie
   * piszą i o nią nie pytają. Instalator kopii sprawdza cel jeszcze raz sam. `rarog update --finish` reads it again
   * after it pointed the service at this installation.
   */
  copyRefusal: CopyRefusal | null;
  /**
   * `rarog update --finish` of the version its update run has just installed (the update lock's `installed` names this
   * installation): a hook or statusLine copy that differs from it is written after its diff (in the run
   * log) without a question. `false` everywhere else, so `rarog setup`, `rarog hooks install` and a finish by hand ask.
   */
  readonly copyWithoutQuestion: boolean;
}

/**
 * Ctrl-C ended a step (its installer already released the lock): setup stops with 130, no summary, no doctor;
 * `rarog update --finish` the same.
 */
export class SetupInterrupted extends Error {}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function errnoCode(failure: unknown): string {
  return isRecord(failure) && typeof failure['code'] === 'string' ? failure['code'] : 'error';
}

/** Stan wpisu według `lstat`: `missing` (ENOENT), `present` (dowolny rodzaj, także dowiązanie) albo błąd z kodem. */
export function entry(file: string): 'missing' | 'present' | { readonly code: string } {
  try {
    lstatSync(file);
    return 'present';
  } catch (failure) {
    const code = errnoCode(failure);
    return code === 'ENOENT' ? 'missing' : { code };
  }
}

/** Katalog kopii pusty albo brak — tylko wtedy setup sam instaluje kopię (inaczej coś by nadpisał). */
export function copyDirEmpty(home: string): boolean {
  const dir = hookInstallDir(home);
  const state = entry(dir);
  if (state === 'missing') return true;
  try {
    return lstatSync(dir).isDirectory() && readdirSync(dir).length === 0;
  } catch {
    return false;
  }
}

/**
 * Zapis pliku TYLKO gdy go brak: plik tymczasowy z losowym sufiksem (`wx`, prawa `mode`), `link` na docelową nazwę,
 * plik tymczasowy usunięty. `false` = nazwa zajęta (`EEXIST`: drugi `setup` był pierwszy); inne błędy rzuca.
 */
export function writeIfMissing(file: string, text: string, mode: number): boolean {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(8).toString('hex')}.tmp`);
  try {
    writeFileSync(tmp, text, { flag: 'wx', mode });
    chmodSync(tmp, mode);
    linkSync(tmp, file);
    return true;
  } catch (failure) {
    if (errnoCode(failure) === 'EEXIST') return false;
    throw failure;
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // Sprzątanie best-effort.
    }
  }
}

/** Katalog `dir` (ostatni człon z prawami `mode`, rodzice domyślnie), gdy go brak; istniejącego nie rusza. */
export function ensureDir(dir: string, mode: number): void {
  mkdirSync(path.dirname(dir), { recursive: true });
  try {
    mkdirSync(dir, { mode });
    chmodSync(dir, mode);
  } catch (failure) {
    if (errnoCode(failure) !== 'EEXIST') throw failure;
  }
}

/**
 * Katalog zapisu po `ensureDir`, tuż przed zapisem: prawdziwy katalog tego użytkownika (nie dowiązanie, które mogło
 * powstać w trakcie pytania i przekierować zapis), z prawami `mode`, gdy podane. Napis = powód odmowy.
 */
export function unsafeDir(dir: string, mode: number | null): string | null {
  let info;
  try {
    info = lstatSync(dir);
  } catch (failure) {
    return `${dir}: ${errnoCode(failure)}`;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) return `${dir}: expected a real directory, not a symlink`;
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) return `${dir}: owned by another user`;
  if (mode !== null && (info.mode & 0o777) !== mode) return `${dir}: expected mode ${mode.toString(8)}`;
  return null;
}

/** Katalog jest w `PATH` tej powłoki. */
export function onShellPath(dir: string, ctx: Ctx): boolean {
  return (ctx.io.env['PATH'] ?? '').split(':').includes(dir);
}

/**
 * A `[y/N]` question in the step screen form (`? `, wrapped at the screen width, `screen/ask.ts`): `true` only for
 * "y"/"yes" (also t/tak); EOF, an empty answer and no terminal = no. `note` says in plain words what the question is
 * for, right above it ({@link SetupView.questionNote}); without a terminal there is neither.
 */
export async function confirm(ctx: Ctx, question: string, note: string | null = null): Promise<boolean> {
  if (ctx.ask === null) return false;
  if (note !== null) ctx.view.questionNote(note);
  return confirmForm(ctx.ask, question, 'y/N', { width: ctx.view.screen.layout.width });
}

/** A detail line of a step: the run log, and the screen with `--verbose`. */
export function line(ctx: Ctx, text: string): void {
  ctx.view.detail(`  ${text}`);
}

export function configPort(ctx: Pick<Ctx, 'config'>): number {
  const raw = ctx.config?.env.RAROG_PORT ?? '';
  return /^[0-9]{1,5}$/.test(raw) ? Number(raw) : DEFAULT_PORT;
}

export function herdrSocket(ctx: Ctx): string {
  return configuredHerdrSocket(ctx.config?.env[HERDR_SOCKET_ENV], ctx.home);
}

/**
 * The herdr socket the server would use for this `RAROG_HERDR_SOCKET`: its own rule (trimmed, `~` expanded, resolved).
 * A value the server refuses stays as written (trimmed): the config check reports it, and no socket answers there.
 */
export function configuredHerdrSocket(raw: string | undefined, home: string): string {
  try {
    return parseHerdrSocket(raw, { home, isSocket: () => null });
  } catch {
    return raw?.trim() ?? defaultHerdrSocket(home);
  }
}
