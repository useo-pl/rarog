/**
 * Shared harness of the `rarog setup` tests (`rarog-setup.test.ts` and `setup-*.test.ts`): a temporary
 * `HOME`, fakes in `PATH` (`launchctl`, `tailscale`, `claude`, `herdr`, `bash` with a log), `/health` from a test
 * HTTP server (the closing check reads it, never the default port), and `runSetup`, which runs `setupCommand` in the
 * test process with injected answers, by default with `--verbose` (the detail lines and the `Summary:` block on
 * stdout). The dictation question of step 2 and the transport question before the plan get "n" unless a test gives
 * {@link RunOptions.voice} or {@link RunOptions.tailscaleOnly}, so the `config.json` of the other tests stays byte for
 * byte. A test file
 * calls {@link useSetupHarness} once at the top level; the state below is reset before each test. Each test starts on
 * a Mac whose herdr agent is written and running ({@link writeHerdrAgent}); the tests of that step remove it.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync,
  utimesSync, writeFileSync,
} from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import type { Server as NetServer } from 'node:net';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, expect } from 'vitest';
import type { CliIo, CliTerminal } from '../../src/cli/io.ts';
import { renderServicePlist } from '../../src/cli/service.ts';
import { HERDR_AGENT_LABEL, herdrAgentPlistPath, renderHerdrAgentPlist } from '../../src/cli/setup-herdr-agent.ts';
import { setupCommand } from '../../src/cli/setup.ts';
import type { SetupDeps } from '../../src/cli/setup.ts';
import {
  HOOK_INSTALL_FILES, STATUSLINE_INSTALL_FILES, contextHookCommand, denyReadBlock, hookBlock, hookCommand,
  hookInstallDir, pasteHookBlock, statuslineCommand, userSettingsPath, writeBlockRules,
} from '../../src/herdr/hook-config.ts';
import { IROH_PACKAGE } from '../../src/iroh/adapter.ts';
import type { IrohModuleInfo } from '../../src/iroh/adapter.ts';
import { readPackageVersion } from '../../src/version.ts';
import { realRarogDirsCreated, tempHome } from '../rarog-home.ts';
import type { TempHome } from '../rarog-home.ts';
import { fake } from '../systemd-atrapy.ts';
import type { LinuxSandbox } from '../systemd-atrapy.ts';

export const REPO = path.join(import.meta.dirname, '..', '..', '..');
export const CLI = path.join(REPO, 'bin', 'rarog.mjs');
export const HOOKS_SRC = path.join(REPO, 'scripts', 'hooks');
export const FAKE_SECRET = 'sztuczny-sekret-setupu-0123456789abcdef';
export const TS_HOST = 'rarog-test.example.ts.net';
/** This machine's Tailscale addresses in the fake `tailscale status --json` (`Self.TailscaleIPs`). */
export const TS_IPS = ['100.64.0.7', 'fd7a:115c:a1e0::7'] as const;
/**
 * The fake `tailscale status --json`: a running client with HTTPS on in the tailnet (`CertDomains` and the `https` key
 * of `Self.CapMap`, as measured on macOS). `fields` replaces top-level fields, `self` fields of `Self`; `undefined`
 * drops a field (an older client without it).
 */
export function tailscaleStatus(
  fields: Readonly<Record<string, unknown>> = {}, self: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return JSON.parse(JSON.stringify({
    BackendState: 'Running', CertDomains: [TS_HOST], ...fields,
    Self: {
      DNSName: `${TS_HOST}.`, TailscaleIPs: TS_IPS,
      CapMap: { https: null, 'https://tailscale.com/cap/funnel-ports?ports=443,8443,10000': null }, ...self,
    },
  })) as Record<string, unknown>;
}

/**
 * `tailscale serve status --json` with `tailscale serve --bg --https=<P> <target>` mappings in the shape Tailscale
 * 1.104.6 prints on macOS: `TCP["<P>"] = { HTTPS: true }` and `Web["<host>:<P>"].Handlers["/"].Proxy =
 * "http://127.0.0.1:<target>"`. Each entry is `[P, target]`; a target that is a string is the whole proxy URL.
 */
export function serveMappings(
  entries: readonly (readonly [number, number | string])[], host = TS_HOST,
): { TCP: Record<string, unknown>; Web: Record<string, unknown> } {
  const status = { TCP: {} as Record<string, unknown>, Web: {} as Record<string, unknown> };
  for (const [https, target] of entries) {
    status.TCP[String(https)] = { HTTPS: true };
    const proxy = typeof target === 'string' ? target : `http://127.0.0.1:${String(target)}`;
    status.Web[`${host}:${String(https)}`] = { Handlers: { '/': { Proxy: proxy } } };
  }
  return status;
}

/**
 * The HTTPS ports of other `tailscale serve` mappings as measured on a Mac with Tailscale 1.104.6 (seven sites, each
 * with `TCP` and a `/` proxy in `Web`): none on 443 and none in the pool 8931–8960.
 */
export const OTHER_SERVE_PORTS = [3000, 3001, 4321, 4322, 8737, 8788, 8899] as const;

/** The seven other mappings of {@link OTHER_SERVE_PORTS}, each proxied to the same local port. */
export const otherMappings = (): readonly (readonly [number, number])[] => OTHER_SERVE_PORTS.map((one) => [one, one]);

/** What the fake `tailscale serve status --json` prints next (a value is written as JSON, a string as it is). */
export function writeServeStatus(json: unknown): void {
  writeFileSync(path.join(state, 'serve-status'), typeof json === 'string' ? json : JSON.stringify(json));
}

/**
 * The fake client's change of its serve config, run by node: `add <file> <--https=P|target> [target]` adds the mapping
 * of `serve --bg` (port 443 without `--https=`) to what the file holds, `off <file> --https=<P>` removes the mapping of
 * that port. Other mappings stay, as with the client.
 */
const SERVE_CONFIG_SCRIPT = `import { readFileSync, writeFileSync } from 'node:fs';
const [mode, file, first, second] = process.argv.slice(2);
let status = {};
try {
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) status = parsed;
} catch {}
const https = first.startsWith('--https=') ? first.slice('--https='.length) : '443';
const site = ${JSON.stringify(TS_HOST)} + ':' + https;
status.TCP = { ...status.TCP };
status.Web = { ...status.Web };
if (mode === 'add') {
  const target = first.startsWith('--https=') ? second : first;
  status.TCP[https] = { HTTPS: true };
  status.Web[site] = { Handlers: { '/': { Proxy: 'http://127.0.0.1:' + target } } };
} else {
  delete status.TCP[https];
  delete status.Web[site];
}
for (const key of ['TCP', 'Web']) if (Object.keys(status[key]).length === 0) delete status[key];
writeFileSync(file, JSON.stringify(status));
`;

/** The native iroh module from the manifests: ready by default (Apple silicon), so tests do not depend on the host. */
export const IROH_READY: IrohModuleInfo = {
  version: '1.2.0', platformPackage: `${IROH_PACKAGE}-darwin-arm64`, platformVersion: '1.2.0',
};
/** An Intel Mac: the package is there, the platform package is not (darwin-x64 has no native module). */
export const IROH_INTEL: IrohModuleInfo = { version: '1.2.0', platformPackage: null, platformVersion: null };
/** A fake iroh key (64 hex); the tests never know a real key. */
export const FAKE_IROH_KEY = '5a'.repeat(32);
/** The iroh key line in the secrets file. */
export const KEY_LINE = /^RAROG_IROH_KEY=([0-9a-f]{64})$/m;

export let t: TempHome;
/** `HOME` setupu; atrapy, logi i stan atrap leżą obok, poza drzewem, którego skróty liczy test. */
export let home = '';
export let bin = '';
export let logs = '';
export let state = '';
export let health: HttpServer | null = null;
export let herdr: NetServer | null = null;
export let healthBody: unknown = {};
export let port = 0;

/**
 * Kopia hooka bierze wyłącznie stan z commita (`git status` i bloby `HEAD` w korzeniu repo), więc w drzewie
 * bez `.git` (eksport bez historii) odmawia. Testy, które sprawdzają skopiowane pliki, pomijają się tam jawnie.
 */
export const HAS_CHECKOUT = existsSync(path.join(REPO, '.git'));
export const checkoutOnly = (title: string): string => `${title} (requires a git checkout: the hook copy from the committed state)`;

/** Registers the harness hooks in the calling test file: fresh `HOME`, fakes and `/health` before each test. */
export function useSetupHarness(): void {
  beforeEach(async () => {
    t = tempHome('rs-');
    home = path.join(t.home, 'h');
    bin = path.join(t.home, 'a');
    logs = path.join(t.home, 'l');
    state = path.join(t.home, 's');
    for (const dir of [home, bin, logs, state]) mkdirSync(dir);
    const log = (name: string): string => `printf '%s\\n' "$*" >> '${logs}/${name}'`;
    fake(path.join(bin, 'launchctl'), [
      log('launchctl'),
      ...herdrAgentLaunchctl(state),
      `if [ "$1" = print ] && [ -f '${state}/launchctl-odmowa' ]; then echo "Operation not permitted" >&2; exit 1; fi`,
      'if [ "$1" = print ]; then',
      `  grep -qxF "\${2##*/}" '${state}/loaded' 2>/dev/null || exit 113`,
      // The loaded definition ({@link markLoaded}) in the shape of `launchctl print gui/<uid>/<label>` (macOS 27.2).
      `  if [ -f '${state}/loaded-args' ]; then`,
      String.raw`    printf '%s = {\n\tstate = running\n\targuments = {\n' "$2"`,
      String.raw`    while IFS= read -r line; do printf '\t\t%s\n' "$line"; done < '${state}/loaded-args'`,
      String.raw`    printf '\t}\n\n\tenvironment = {\n\t\tXPC_SERVICE_NAME => %s\n\t}\n}\n' "${'$'}{2##*/}"`,
      '  fi',
      '  exit 0',
      'fi',
      'exit 1',
    ]);
    // `tailscale` as the client behaves: `status --json` prints `status-json` when a test writes one;
    // `serve status --json` fails with `serve-status-err` or prints `serve-status`; `serve --bg [--https=P] <port>`
    // prints `serve-out` on stdout, then fails with `serve-err` on stderr (code 1), exits with `serve-code`, hangs on
    // `serve-hang`, or adds the mapping of the address on P (443 without `--https=`) to the port to the other
    // mappings (`serve status` shows it) unless `serve-noop` says it changed nothing (the client's exit 0 when the
    // feature is off in the tailnet); `serve --https=P off` removes the mapping on P.
    writeFileSync(path.join(state, 'serve-config.mjs'), SERVE_CONFIG_SCRIPT);
    const serveConfig = `'${process.execPath}' "$S/serve-config.mjs"`;
    fake(path.join(bin, 'tailscale'), [
      log('tailscale'),
      `S='${state}'`,
      'case "$1 $2" in',
      '  "status --json")',
      '    if [ -f "$S/status-err" ]; then cat "$S/status-err" >&2; exit 1; fi',
      '    if [ -f "$S/status-json" ]; then cat "$S/status-json"; exit 0; fi',
      `    echo '${JSON.stringify(tailscaleStatus())}' ;;`,
      '  "serve status")',
      '    if [ -f "$S/serve-status-err" ]; then cat "$S/serve-status-err" >&2; exit 1; fi',
      '    cat "$S/serve-status" 2>/dev/null || echo "{}" ;;',
      '  "serve --bg")',
      '    if [ -f "$S/serve-out" ]; then cat "$S/serve-out"; fi',
      '    if [ -f "$S/serve-hang" ]; then exec sleep 30; fi',
      '    if [ -f "$S/serve-err" ]; then cat "$S/serve-err" >&2; exit 1; fi',
      '    if [ -f "$S/serve-code" ]; then exit "$(cat "$S/serve-code")"; fi',
      `    if [ ! -f "$S/serve-noop" ]; then ${serveConfig} add "$S/serve-status" "$3" "$4" || exit 1; fi`,
      '    echo "Available within your tailnet" ;;',
      '  "serve --https="*)',
      '    [ "$3" = off ] || exit 1',
      `    ${serveConfig} off "$S/serve-status" "$2" || exit 1 ;;`,
      '  *) exit 1 ;;',
      'esac',
    ]);
    // `restart.sh` szedłby przez `bash`; atrapa tylko loguje i oddaje prawdziwemu.
    fake(path.join(bin, 'bash'), [log('bash'), 'exec /bin/bash "$@"']);
    for (const name of ['claude', 'herdr']) fake(path.join(bin, name), [log(name), 'exit 0']);
    // `lsof` finds no listener unless a test writes its `-F` output (who holds a port of the pool) to `lsof-out`.
    fake(path.join(bin, 'lsof'), [log('lsof'), `if [ -f '${state}/lsof-out' ]; then cat '${state}/lsof-out'; exit 0; fi`,
      'exit 1']);
    fake(path.join(bin, 'ps'), [log('ps'), 'exit 1']);
    healthBody = {
      ok: true, version: readPackageVersion(), uptime: 1, herdr: true, term: true, hook: 'ok', authStore: 'ok', sdk: 'ok',
    };
    health = createHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      // A function body answers per request (a value that changes between two reads).
      res.end(JSON.stringify(typeof healthBody === 'function' ? (healthBody as () => unknown)() : healthBody));
    });
    await new Promise<void>((resolve) => { health?.listen(0, '127.0.0.1', resolve); });
    const address = health.address();
    port = typeof address === 'object' && address !== null ? address.port : 0;
    writeHerdrAgent();
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => { if (health === null) resolve(); else health.close(() => { resolve(); }); });
    await new Promise<void>((resolve) => { if (herdr === null) resolve(); else herdr.close(() => { resolve(); }); });
    health = null;
    herdr = null;
    t.cleanup();
  });

  afterAll(() => { expect(realRarogDirsCreated()).toEqual([]); });
}

/** Body of the test `/health` (a test sets an unhealthy one; the harness resets it before each test). */
export function setHealthBody(body: unknown): void {
  healthBody = body;
}

// ---------------------------------------------------------------------------
// Pomocnicze
// ---------------------------------------------------------------------------

export const configDir = (h = home): string => path.join(h, '.config', 'rarog');
export const configFile = (h = home): string => path.join(configDir(h), 'config.json');
export const secretFile = (h = home): string => path.join(configDir(h), 'secret', 'private.env');
export const plist = (h = home): string => path.join(h, 'Library', 'LaunchAgents', 'ai.rarog.server.plist');

export const calls = (name: string, dir = logs): string[] => {
  const file = path.join(dir, name);
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((line) => line !== '') : [];
};

export const write = (file: string, text: string, mode = 0o644): void => {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, text, { mode });
  chmodSync(file, mode);
};

export function env(h = home, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: `${bin}:/usr/bin:/bin`, HOME: h, USER: 'znajomy', LOGNAME: 'znajomy', SHELL: '/bin/zsh',
    ...(process.env['TMPDIR'] === undefined ? {} : { TMPDIR: process.env['TMPDIR'] }),
    ...extra,
  };
}

/**
 * Rodzaj pytania po jego treści (odpowiedzi testu wybiera się po rodzaju, nie po kolejności): `continue` = the plan
 * screen (`[Y/n]`, `setup-plan.ts`; it also covers the herdr agent on macOS and `herdr.service` on Linux, which have
 * no question of their own), `settings` = the one question about `~/.claude/settings.json` (`[y/N/d]`, the Rarog
 * entries and herdr's hook, `setup-settings.ts`), `statusline` = kopia skryptu paska statusu w zgodnej kopii
 * hooka, `hook` = aktualizacja kopii hooka różnej od źródła, `tailscale-only` = the transport question before the plan
 * screen (`setup-tailscale-only.ts`).
 */
export type Question = 'key' | 'continue' | 'settings' | 'tailscale' | 'tailscale-only' | 'hook'
  | 'statusline' | 'dictation' | 'agent' | KeyPrompt | 'inne';

/** The hidden key prompts of step 2 (`setup-voice.ts`): the Soniox key and the OpenAI key. */
export type KeyPrompt = 'soniox-key' | 'openai-key';

export function questionOf(prompt: string): Question {
  // The forms of the step screen end in their hint; a wrapped question may split any other phrase.
  if (prompt.endsWith('[Y/n] ')) return 'continue';
  if (prompt.endsWith('[y/N/d] ')) return 'settings';
  // The `[y/N]` questions wrap at the screen width too: their lines joined with one space.
  const text = prompt.replace(/\s+/gu, ' ');
  // `key` = the iroh server key in step 3 (an existing `config.json` with `RAROG_IROH=1` and no key).
  if (text.includes('RAROG_IROH_KEY')) return 'key';
  if (text.includes('tailscale serve --bg')) return 'tailscale';
  if (text.includes('the hook copy')) return 'hook';
  if (text.includes('the status line script')) return 'statusline';
  // `dictation` and `agent` = the voice questions of step 2, before config.json (`setup-voice.ts`).
  if (text.includes('Set up dictation with Soniox')) return 'dictation';
  if (text.includes('Set up the voice agent')) return 'agent';
  if (text.includes('only through Tailscale')) return 'tailscale-only';
  return 'inne';
}

/** Which hidden prompt asks: the Soniox key or the OpenAI key. */
export function keyPromptOf(prompt: string): KeyPrompt {
  const text = prompt.replace(/^\? /u, '');
  if (text.startsWith('Soniox')) return 'soniox-key';
  if (text.startsWith('OpenAI')) return 'openai-key';
  throw new Error(`unknown hidden prompt: ${prompt}`);
}

export interface Result {
  readonly code: number;
  readonly stdout: string;
  readonly asked: Question[];
  readonly installs: number;
  /** Odmowy `precheck` pod blokadą instalatora (atrapa instalatora woła go jak prawdziwy). */
  readonly refusals: string[];
}

/** Odpowiedź „t” na wszystko. */
export const YES = (_question: Question): string | null => 't';

/**
 * Answers of the voice questions of step 2 and of their hidden key prompts. An answer left out of `dictation` or
 * `agent` is "n"; `key` gives the typed key of a prompt (`null` = Ctrl-D, a throw of `SecretInputInterrupted` =
 * Ctrl-C); a prompt without `key` fails the test.
 */
export interface VoiceAnswers {
  readonly dictation?: string | null;
  readonly agent?: string | null;
  readonly key?: (prompt: KeyPrompt) => string | null | Promise<string | null>;
}

export interface RunOptions {
  /** `null` = bez terminala (bez `ask` i bez `askSecret`). */
  readonly answer?: ((question: Question) => string | null | Promise<string | null>) | null;
  /** The voice questions of step 2; absent = "n" to the dictation question. */
  readonly voice?: VoiceAnswers;
  /**
   * The answer to the transport question before the plan screen (asked on a first setup with the iroh module and
   * `tailscale` in `PATH`); absent = "n", so the `config.json` of the other tests keeps iroh with the address.
   */
  readonly tailscaleOnly?: string | null;
  readonly argv?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  /**
   * `--verbose` (default): the detail lines and the `Summary:` block the assertions read. `false` = the step screen
   * (`setup-screen.test.ts`).
   */
  readonly verbose?: boolean;
  /** What stdout is (default: not a terminal). */
  readonly terminal?: CliTerminal;
  /** The answer and a line end after each prompt, as a terminal echoes what the user typed (the screen budget). */
  readonly echo?: boolean;
  /**
   * Live columns of the terminal (`CliIo.columnsNow`): with them and `echo` the step screen takes answered questions
   * off the screen as on a real terminal; without them every question stays.
   */
  readonly columnsNow?: () => number;
  /**
   * Install mode and root, the SDK download, the iroh module, the TCP probe of a pool port and the `config.json`
   * rewrite of `--tailscale` (by default the test clone, {@link IROH_READY} and a refused connection, so the host's
   * own servers never change a test). A given
   * `serviceInstall` replaces the counting fake (`installs` and `refusals` then stay empty). The closing check reads
   * the test's `/health` ({@link port}) with a ceiling of {@link CHECK_TIMEOUT_MS}, unless the test gives its own.
   */
  readonly deps?:
    Pick<SetupDeps, 'mode' | 'installRoot' | 'sdkInstall' | 'sdkProbe' | 'herdrInstallTimeoutMs' | 'irohModule'
      | 'tcpProbe' | 'checkPort' | 'checkTimeoutMs' | 'tailscaleTimeoutMs' | 'herdrStartTimeoutMs' | 'configWrites'>
    & Partial<Pick<SetupDeps, 'serviceInstall'>>;
}

/** Ceiling of the closing check's wait in these tests (the product waits 30 s). */
export const CHECK_TIMEOUT_MS = 1000;

export async function runSetup(options: RunOptions = {}): Promise<Result> {
  let stdout = '';
  const asked: Question[] = [];
  let installs = 0;
  const refusals: string[] = [];
  const answer = options.answer === undefined ? YES : options.answer;
  const voice: VoiceAnswers = options.voice ?? {};
  const voiceAnswer = (question: 'dictation' | 'agent'): string | null =>
    (Object.hasOwn(voice, question) ? voice[question] ?? null : 'n');
  const onlyAnswer = options.tailscaleOnly === undefined ? 'n' : options.tailscaleOnly;
  const io: CliIo = {
    stdout: (text) => { stdout += text; },
    stderr: (text) => { stdout += text; },
    env: options.env ?? env(),
    cwd: t.home,
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.terminal === undefined ? {} : { terminal: options.terminal }),
    ...(options.columnsNow === undefined ? {} : { columnsNow: options.columnsNow }),
    ...(answer === null ? {} : {
      ask: async (prompt: string) => {
        const question = questionOf(prompt);
        asked.push(question);
        stdout += prompt;
        const given = question === 'dictation' || question === 'agent' ? voiceAnswer(question)
          : question === 'tailscale-only' ? onlyAnswer : await answer(question);
        if (options.echo === true) stdout += `${given ?? ''}\n`;
        return given;
      },
      // A terminal shows nothing of a hidden answer; the prompt ends with a line end, as `askSecretOn` writes one.
      askSecret: async (prompt: string) => {
        const which = keyPromptOf(prompt);
        asked.push(which);
        stdout += prompt;
        try {
          if (voice.key === undefined) throw new Error(`hidden prompt without an answer in the test: ${prompt}`);
          return await voice.key(which);
        } finally {
          stdout += '\n';
        }
      },
    }),
  };
  const deps: SetupDeps = {
    serviceInstall: async (_io, precheck) => {
      const reason = precheck();
      if (reason !== null) {
        refusals.push(reason);
        return 1;
      }
      installs += 1;
      return 0;
    },
    // Never the default port: that is the owner's live server.
    checkPort: port,
    checkTimeoutMs: CHECK_TIMEOUT_MS,
    irohModule: () => IROH_READY,
    tcpProbe: () => Promise.resolve('refused'),
    ...options.deps,
  };
  const verbose = options.verbose === false ? [] : ['--verbose'];
  const code = await setupCommand(['setup', ...verbose, ...(options.argv ?? [])], io, deps);
  return { code, stdout, asked, installs, refusals };
}

/** Skróty drzewa: rodzaj, prawa, czas modyfikacji i treść (plik) albo cel (dowiązanie) każdego wpisu. */
export function treeHash(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const info = lstatSync(full);
      let what = 'inny';
      if (info.isSymbolicLink()) what = `dowiązanie ${readlinkSync(full)}`;
      else if (info.isDirectory()) what = 'katalog';
      else if (info.isFile()) {
        try {
          what = `plik ${createHash('sha256').update(readFileSync(full)).digest('hex')}`;
        } catch {
          what = 'plik nieczytelny';
        }
      }
      out.set(path.relative(root, full), `${what} ${(info.mode & 0o7777).toString(8)} ${String(info.mtimeMs)}`);
      if (info.isDirectory()) walk(full);
    }
  };
  walk(root);
  return out;
}

/**
 * A herdr socket at `socket` (closed after the test): it accepts connections and, with `ping`, answers each request
 * line as herdr 0.9.5 answers `ping`; without it, it reads requests and never answers (a connection with unread data
 * would never see its end, and the close after the test would wait for it).
 */
export async function listenHerdr(socket: string, options: { readonly ping?: boolean } = {}): Promise<void> {
  mkdirSync(path.dirname(socket), { recursive: true });
  herdr = createNetServer((connection) => {
    let buffer = '';
    connection.on('data', (chunk) => {
      if (options.ping !== true) return;
      buffer += chunk.toString('utf8');
      for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
        const request = JSON.parse(buffer.slice(0, end)) as { readonly id: string };
        buffer = buffer.slice(end + 1);
        connection.write(`${JSON.stringify({ id: request.id, result: { version: '0.9.5', protocol: 22 } })}\n`);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    herdr?.once('error', reject);
    herdr?.listen(socket, resolve);
  });
}

/** Port, na którym nic nie słucha (serwer otwarty i zamknięty). */
export async function deadPort(): Promise<number> {
  const server = createHttpServer();
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  const free = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
  return free;
}

export function writeConfig(values: Record<string, string>, wrapper: string[] | null = null, h = home): void {
  write(configFile(h), JSON.stringify({ version: 1, env: values, ...(wrapper === null ? {} : { service: { wrapper } }) }),
    0o600);
}

export function writeSecrets(h = home): void {
  write(secretFile(h), `SONIOX_API_KEY=${FAKE_SECRET}\n`, 0o600);
  chmodSync(path.dirname(secretFile(h)), 0o700);
}

/**
 * Kopia plików z `scripts/hooks/` (bez gita), każdy pod tą samą nazwą; `manifest` = manifest z wpisami tylko tych
 * plików.
 */
export function copyHooks(names: readonly string[], manifest = true, h = home): void {
  const dir = hookInstallDir(h);
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  const files: Record<string, string> = {};
  for (const name of names) {
    copyFileSync(path.join(HOOKS_SRC, name), path.join(dir, name));
    files[name] = createHash('sha256').update(readFileSync(path.join(HOOKS_SRC, name))).digest('hex');
  }
  if (manifest) {
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ commit: '0'.repeat(40), at: 1, files }));
  }
}

/** Katalog danych setupu w tych testach: reguła bez zmiennych (`~/.local/share/rarog`), bo usługa nie ma logu. */
export const dataDirOf = (h = home): string => path.join(h, '.local', 'share', 'rarog');

/**
 * Ustawienia z kompletem bloków z `rarog hooks print` (zgody i hook kontekstu `SessionStart`) i opcjonalnym
 * `statusLine`; `context: false` = sam blok zgód (instalacja sprzed hooka kontekstu), `denyRead: true` = z blokiem
 * `sandbox.filesystem.denyRead` kroku 8. `writeBlock` (the two `permissions.deny` rules) follows `denyRead` unless
 * given: an installation with every entry has both.
 */
export function writeSettings(
  statusLine: string | null, h = home,
  options: { readonly context?: boolean; readonly denyRead?: boolean; readonly writeBlock?: boolean } = {},
): void {
  write(userSettingsPath(h), JSON.stringify({
    ...(options.context === false ? hookBlock(hookCommand(h)) : pasteHookBlock(hookCommand(h), contextHookCommand(h))) as object,
    ...(statusLine === null ? {} : { statusLine: { type: 'command', command: statusLine } }),
    ...(options.denyRead === true ? denyReadBlock(dataDirOf(h)) as object : {}),
    ...((options.writeBlock ?? options.denyRead) === true ? writeBlockOf(h) : {}),
  }, null, 2));
}

/** The write block as setup writes it for the data directory of these tests: `{ permissions: { deny: [two rules] } }`. */
export function writeBlockOf(h = home): { readonly permissions: { readonly deny: readonly string[] } } {
  const block = writeBlockRules(dataDirOf(h), h);
  if (!block.ok) throw new Error(block.reason);
  return { permissions: { deny: block.rules } };
}

/** Zrzut paska statusu `ageMs` temu w `~/.claude/statusline/` (cudza komenda, która sama pisze zrzuty). */
export function writeDump(ageMs: number, h = home): void {
  const file = path.join(h, '.claude', 'statusline', 'sesja-1.json');
  write(file, '{"session_id":"sesja-1"}');
  const at = (Date.now() - ageMs) / 1000;
  utimesSync(file, at, at);
}

/** Wpisy drzewa (ścieżki względne), które różnią się między dwoma skrótami {@link treeHash}. */
export function changedEntries(before: Map<string, string>, after: Map<string, string>): string[] {
  return [...new Set([...before.keys(), ...after.keys()])].filter((key) => before.get(key) !== after.get(key)).sort();
}

/**
 * Lines of a `launchctl` fake for the herdr agent's label, ahead of its other cases: `print gui/<uid>/ai.rarog.herdr`
 * exits with the code in `agent-code` when a test writes one (112 = no GUI domain), else prints `agent-print` (the
 * label is loaded) or exits 113; `bootstrap` of its plist fails with `agent-bootstrap-fail` on stderr (code 5) or
 * leaves the label loaded and running; `kickstart` succeeds; `bootout` unloads it.
 */
export function herdrAgentLaunchctl(stateDir: string): string[] {
  const at = (name: string): string => `'${stateDir}/${name}'`;
  return [
    `case "$1 \${2##*/} \${3##*/}" in`,
    `  "print ${HERDR_AGENT_LABEL} "*)`,
    `    if [ -f ${at('agent-code')} ]; then echo "Could not find domain" >&2; exit "$(cat ${at('agent-code')})"; fi`,
    `    if [ -f ${at('agent-print')} ]; then cat ${at('agent-print')}; exit 0; fi`,
    '    exit 113 ;;',
    `  "bootstrap "*" ${HERDR_AGENT_LABEL}.plist")`,
    `    if [ -f ${at('agent-bootstrap-fail')} ]; then cat ${at('agent-bootstrap-fail')} >&2; exit 5; fi`,
    String.raw`    printf '%s = {\n\tstate = running\n\tpid = 4242\n\tlast exit code = (never exited)\n}\n' "$2"`
      + ` > ${at('agent-print')}`,
    '    exit 0 ;;',
    `  "kickstart ${HERDR_AGENT_LABEL} "*) exit 0 ;;`,
    `  "bootout ${HERDR_AGENT_LABEL} "*) rm -f ${at('agent-print')}; exit 0 ;;`,
    'esac',
  ];
}

/** How launchd has the herdr agent in {@link writeHerdrAgent}: running with a pid, loaded without one, or absent. */
export type HerdrAgentLoad = 'running' | 'stopped' | 'absent';

/**
 * The herdr agent's plist as setup writes it, for the fake `herdr` and the herdr socket `socket` (`null` = herdr's
 * default, no `EnvironmentVariables`), and its label in the fake `launchctl` as `load` says (default: running).
 */
export function writeHerdrAgent(
  options: { readonly socket?: string | null; readonly load?: HerdrAgentLoad; readonly program?: string } = {},
  h = home,
): void {
  const file = herdrAgentPlistPath(h);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, renderHerdrAgentPlist({
    herdr: options.program ?? path.join(bin, 'herdr'), home: h, socket: options.socket ?? null,
  }), { mode: 0o644 });
  loadHerdrAgent(options.load ?? 'running');
}

/** The herdr agent's label in the fake `launchctl` (see {@link herdrAgentLaunchctl}). */
export function loadHerdrAgent(load: HerdrAgentLoad): void {
  const file = path.join(state, 'agent-print');
  const target = `gui/${String(process.getuid?.() ?? 0)}/${HERDR_AGENT_LABEL}`;
  if (load === 'absent') rmSync(file, { force: true });
  else if (load === 'running') {
    writeFileSync(file, `${target} = {\n\tstate = running\n\tpid = 4242\n\tlast exit code = (never exited)\n}\n`);
  } else writeFileSync(file, `${target} = {\n\tstate = not running\n\tlast exit code = 1\n}\n`);
}

/** No herdr agent: neither its plist nor its label (the state of a Mac before the herdr agent step). */
export function removeHerdrAgent(h = home): void {
  rmSync(herdrAgentPlistPath(h), { force: true });
  loadHerdrAgent('absent');
}

/**
 * The service as launchd has it after `bootstrap`: loaded, with the program arguments `args`, by default those of the
 * plist on disk now (none without a readable plist). A later change of the plist does not reach the loaded
 * definition, as with launchd, until the next call.
 */
export function markLoaded(args?: readonly string[]): void {
  writeFileSync(path.join(state, 'loaded'), 'ai.rarog.server\n');
  const loaded = args ?? plistArguments(plist());
  const file = path.join(state, 'loaded-args');
  if (loaded === null) rmSync(file, { force: true });
  else writeFileSync(file, `${loaded.join('\n')}\n`);
}

/** `ProgramArguments` of a plist through the real `plutil`; `null` = no file or no such list. */
function plistArguments(file: string): readonly string[] | null {
  if (!existsSync(file)) return null;
  const converted = spawnSync('plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' });
  if (converted.status !== 0) return null;
  try {
    const args: unknown = (JSON.parse(converted.stdout) as Record<string, unknown>)['ProgramArguments'];
    return Array.isArray(args) && args.every((arg) => typeof arg === 'string') ? args : null;
  } catch {
    return null;
  }
}

/**
 * Linia podsumowania kroku (`ok`, `info`, `MISSING`, `PROBLEM`): najpierw ta, której zdanie zaczyna się od `text`,
 * potem pierwsza, która go zawiera (odmowa kopii hooka też mówi o usłudze, a „service” to zdanie kroku usługi).
 */
export function summaryLine(stdout: string, text: string): string {
  const lines = stdout.slice(stdout.indexOf('Summary:')).split('\n');
  return lines.find((line) => line.slice('  PROBLEM  '.length).startsWith(text))
    ?? lines.find((line) => line.includes(text)) ?? `(brak linii z „${text}”)`;
}

/** Answers in order per question kind; a kind without answers left gets "y". */
export function answers(script: Partial<Record<Question, string[]>>): (question: Question) => string | null {
  return (question) => script[question]?.shift() ?? 'y';
}

/** The screen as the user sees it at the end: no escape sequences, each line as its last redraw left it. */
export function visibleLines(stdout: string): string[] {
  return stdout.replace(/\x1b\[[0-9;]*[A-Za-z]/gu, '').split('\n').map((line) => line.split('\r').pop() ?? '');
}

/**
 * The step screen's lines of the step `title`, from its result line to the next step's line, joined with single
 * spaces (a wrapped result or `Fix:` reads as one sentence).
 */
export function stepLines(lines: readonly string[], title: string): string {
  const at = lines.findIndex((one) => new RegExp(`^ \\S ${title}`, 'u').test(one));
  if (at === -1) return `(no line of ${title})`;
  const next = lines.findIndex((one, index) => index > at && /^ \S \S/u.test(one));
  return lines.slice(at, next === -1 ? undefined : next).join(' ').replace(/ +/gu, ' ').trimEnd();
}

/**
 * A Mac set up: `config.json` (herdr's default socket), the secrets file, the hook and script copy, Rarog's settings
 * entries, herdr's Claude integration current, and the service of this clone (its plist) loaded and healthy on the
 * test `/health`; the herdr agent as {@link writeHerdrAgent} left it. `rarog setup` then has nothing to offer but the herdr agent.
 */
export function macInstalled(): void {
  fake(path.join(bin, 'herdr'), [
    `printf '%s\\n' "$*" >> '${logs}/herdr'`,
    'if [ "$1 $2" = "integration status" ]; then echo "claude: current (v11)"; fi', 'exit 0',
  ]);
  writeConfig({ RAROG_ORIGINS: 'https://rarog.example.net', RAROG_PORT: String(port) });
  writeSecrets();
  copyHooks([...HOOK_INSTALL_FILES, ...STATUSLINE_INSTALL_FILES]);
  writeSettings(statuslineCommand(home), home, { denyRead: true });
  write(plist(), renderServicePlist({
    programArguments: [process.execPath, CLI, 'serve'], workingDirectory: REPO,
    log: path.join(dataDirOf(), 'server.log'),
  }));
  markLoaded();
}

/**
 * A Linux machine set up but for the herdr unit (`linuxSandbox` of `systemd-atrapy.ts`): `config.json` with the herdr
 * socket `socket`, the secrets file, the hook and script copy, Rarog's settings entries, herdr's Claude integration
 * current, and `rarog.service` loaded in the fake manager without a file (so `~/.config/systemd/user` does not exist)
 * and healthy on the test `/health`. `rarog setup` then has nothing to offer but the herdr unit.
 */
export function linuxInstalledButHerdrUnit(sb: LinuxSandbox, socket: string): void {
  fake(path.join(sb.bin, 'claude'), ['exit 0']);
  fake(path.join(sb.bin, 'herdr'), [
    'if [ "$1 $2" = "integration status" ]; then echo "claude: current (v11)"; fi', 'exit 0',
  ]);
  writeConfig({ RAROG_ORIGINS: 'https://rarog.example.net', RAROG_PORT: String(port), RAROG_HERDR_SOCKET: socket },
    null, sb.homeDir);
  writeSecrets(sb.homeDir);
  copyHooks([...HOOK_INSTALL_FILES, ...STATUSLINE_INSTALL_FILES], true, sb.homeDir);
  writeSettings(statuslineCommand(sb.homeDir), sb.homeDir, { denyRead: true });
  sb.set('LoadState', 'loaded');
}
