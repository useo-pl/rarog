/**
 * `rarog update` (`server/src/cli/update.ts`, `server/src/cli/update-registry.ts`): the newest version from the npm
 * registry with the npm next to this installation's node (`npm i -g --ignore-scripts '@rarog/server@>this <=latest'`,
 * the age gate variables of the environment passed on), the installed version compared after the install (an npm
 * release age gate can leave the old one, and npm finding no version old enough is the same warning), a refusal before
 * any npm call when this installation is another package than `@rarog/server`, a refusal before the install
 * when the new version needs a newer Node or when npm installs into another prefix, then `rarog update --finish` of the
 * NEW version in its own process with the update lock's token and `installed`. An installation that already has the
 * newest version is only finished, in this process, with the hook copy question. The hook copy goes without its
 * question only when the update lock names this installation as just installed (rule 4 of
 * `hook-granica-guard.test.ts`).
 *
 * npm is a fake `npm-cli.js` (no network, no real global prefix); the new version it "installs" is a fake
 * `bin/rarog.mjs` that records how it was started. `launchctl` and `rarog restart` are fakes; `/health` is the
 * harness server on its own port.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { interruptOrExit } from '../src/cli/child-output.ts';
import type { CliIo, CliTerminal } from '../src/cli/io.ts';
import { renderServicePlist } from '../src/cli/service.ts';
import { UPDATE_LOCK_FILENAME, UPDATE_LOCK_TOKEN, updateLockBody } from '../src/cli/update-lock.ts';
import {
  ageGateText, ageGateWait, compareVersions, gateDaysOf, nodeSatisfies,
} from '../src/cli/update-registry.ts';
import {
  RELEASE_SOURCE, provenanceProblem, releaseIdentity, sha512OfIntegrity,
} from '../src/cli/update-provenance.ts';
import { updateCommand } from '../src/cli/update.ts';
import type { UpdateDeps } from '../src/cli/update.ts';
import {
  HOOK_INSTALL_FILES, HOOK_MANIFEST_FILENAME, STATUSLINE_INSTALL_FILES, hookInstallDir, statuslineCommand,
} from '../src/herdr/hook-config.ts';
import { installSdk } from '../src/install/sdk.ts';
import { readPackageVersion } from '../src/version.ts';
import {
  CHECK_TIMEOUT_MS, REPO, bin, configDir, copyHooks, dataDirOf, env, home, markLoaded, plist, port,
  questionOf, t, useSetupHarness, write, writeConfig, writeSettings,
} from './helpers/setup-harness.ts';
import type { Question } from './helpers/setup-harness.ts';
import { IS_MAC, macOnly } from './platform.ts';
import { testAuthority } from './helpers/fulcio-cert.ts';
import type { TestAuthority } from './helpers/fulcio-cert.ts';
import { scan } from './source-scan.ts';

useSetupHarness();

const TTY_60: CliTerminal = { tty: true, columns: 60, color: false };
const VERSION = readPackageVersion();
const TOKEN = 'abababababababababababababababab';

/** The screen as a person sees it: escape sequences removed, every redraw (`\r`) keeps only what comes after it. */
function visible(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]/gu, '').split('\n').map((line) => line.split('\r').at(-1) ?? '')
    .join('\n');
}

const lines = (screen: string): string[] => screen.replace(/\n$/u, '').split('\n');

/**
 * The screen with its wrapped lines joined: one space for every run of spaces, line ends and indents. A step that
 * takes 1 s or more on a loaded machine prints its time (`3 s`, `1 min 5 s`) in the step line's right column, which
 * lands inside the wrapped detail once the lines are joined, so the time drops out; no expected text holds one.
 */
const flat = (screen: string): string => screen.replace(/\s+/gu, ' ').replace(/ (?:\d+ min )?\d+ s(?= )/gu, '');

/** The text of the run logs of `rarog update` in the test data directory. */
function updateLogs(): string[] {
  const dir = path.join(dataDirOf(), 'logs');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.startsWith('update-')).sort()
    .map((name) => readFileSync(path.join(dir, name), 'utf8'));
}

/** The npm prefix of the fake registry tests and the package root under it. */
const prefix = (): string => path.join(t.home, 'prefix');
const npmRoot = (): string => path.join(prefix(), 'lib', 'node_modules', '@rarog', 'server');

/** Where the fake new version records how it was started (`null` = it never ran). */
const startRecord = (): string => path.join(t.home, 'new-version-started.json');
const oldRecord = (): string => path.join(t.home, 'old-version-started.json');

/** A `bin/rarog.mjs` that records its start (argv, node, token, the update lock at that moment) and exits `code`. */
function recordingBin(record: string, code = 0): string {
  return [
    "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
    "import path from 'node:path';",
    "const lock = path.join(process.env.HOME ?? '', '.config', 'rarog', 'update.lock');",
    `writeFileSync(${JSON.stringify(record)}, JSON.stringify({`,
    '  argv: process.argv.slice(1), node: process.execPath, cwd: process.cwd(),',
    `  token: process.env.${UPDATE_LOCK_TOKEN} ?? null,`,
    "  lock: existsSync(lock) ? readFileSync(lock, 'utf8') : null,",
    '}));',
    `process.exit(${String(code)});`,
    '',
  ].join('\n');
}

/**
 * An npm installation of version `version` (its own directory, not this repository); `name` = `null` leaves the name
 * out of its `package.json`.
 */
function npmInstallation(version = '0.1.0', root = npmRoot(), name: string | null = '@rarog/server'): string {
  write(path.join(root, 'package.json'), JSON.stringify(name === null ? { version } : { name, version }));
  write(path.join(root, 'bin', 'rarog.mjs'), recordingBin(oldRecord()));
  return root;
}

interface RegistryState {
  /** What `npm prefix -g` prints (default: {@link prefix}). */
  readonly prefix?: string;
  /** The `npm view … --json` object; `null` = offline (exit 1 with an npm error). */
  readonly view?: Record<string, unknown> | null;
  /**
   * The version `npm pack` of the install range downloads (default: the one of {@link view}) and the tarball's bytes
   * (default: `tarball of <version>`).
   */
  readonly pack?: { readonly version?: string; readonly bytes?: string };
  /** `npm pack` exits with this code (default 0) and writes {@link packStderr} (default `npm error code E500`). */
  readonly packCode?: number;
  readonly packStderr?: string;
  /** `dist.integrity` of `npm view @rarog/server@<version> dist` (default: the tarball's); `null` = the call fails. */
  readonly distIntegrity?: string | null;
  /** What `npm audit signatures --json --include-attestations` prints (default: a matching provenance). */
  readonly audit?: unknown;
  /** `npm audit signatures` exits with this code (default 0); its stderr is `npm error Failed to download`. */
  readonly auditCode?: number;
  /** Files `npm i -g` writes under the package root (path relative to it → text); absent = it writes nothing. */
  readonly install?: Readonly<Record<string, string>>;
  /** `npm i -g` exits with this code (default 0). */
  readonly installCode?: number;
  /** What a failed `npm i -g` writes to stderr (default `npm error code E500`). */
  readonly installStderr?: string;
  /** What `npm config get min-release-age before -g` prints; absent = the call fails (exit 1). */
  readonly gateConfig?: string;
  /** The `npm view @rarog/server time versions --json` value; absent = the call fails (exit 1). */
  readonly times?: unknown;
  /** This call (`config` or `view` of the times) marks `npm-hang` and runs until a signal ends it. */
  readonly hang?: 'config' | 'times';
}

/** npm's release age gate holds every version of the range back: `npm pack` of the range finds none old enough. */
const HELD: RegistryState = { packCode: 1, packStderr: 'npm error code ETARGET\n' };

/** The repository and workflow every release is built by (`RELEASE_SOURCE` of `update-provenance.ts`). */
const RELEASE = 'https://github.com/useo-pl/rarog';
const WORKFLOW = '.github/workflows/publish.yml';
const identityOf = (version: string, repository = RELEASE): string => `${repository}/${WORKFLOW}@refs/tags/v${version}`;
const sha512Hex = (text: string): string => createHash('sha512').update(text).digest('hex');
const sriOf = (text: string): string => `sha512-${createHash('sha512').update(text).digest('base64')}`;

/** The authority the tests' releases are signed under, in place of Sigstore's; {@link FOREIGN} is anyone else's. */
const AUTHORITY = testAuthority();
const FOREIGN = testAuthority();

interface Provenance {
  readonly version: string;
  /** Hex sha512 the statement names. */
  readonly sha512: string;
  /** The URIs of the signing certificate (default: {@link identityOf} the version and repository). */
  readonly certificate?: readonly string[];
  /** The repository the statement names (default {@link RELEASE}). */
  readonly repository?: string;
  /** The attestation form: 0.3 has `certificate`, 0.2 `x509CertificateChain` (default 0.3). */
  readonly chain?: boolean;
  /** Who issues the signing certificate (default {@link AUTHORITY}). */
  readonly authority?: TestAuthority;
  /** The envelope's signature: `forged` = by another certificate's key, `none` = empty (default: the certificate's). */
  readonly signature?: 'forged' | 'none';
  /** A second piece of verification material beside the certificate: a bare key, or the other certificate form. */
  readonly extra?: 'publicKey' | 'otherForm';
  /** The predicate type inside the signed statement (default the SLSA provenance). */
  readonly statementType?: string;
}

/** A sigstore attestation of a SLSA provenance as npm's attestations endpoint serves it, signed like a real one. */
function provenanceAttestation(p: Provenance): unknown {
  const statement = {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [{ name: `pkg:npm/%40rarog/server@${p.version}`, digest: { sha512: p.sha512 } }],
    predicateType: p.statementType ?? 'https://slsa.dev/provenance/v1',
    predicate: { buildDefinition: { externalParameters: { workflow: {
      ref: `refs/tags/v${p.version}`, repository: p.repository ?? RELEASE, path: WORKFLOW,
    } } } },
  };
  const issued = (p.authority ?? AUTHORITY).issue(p.certificate ?? [identityOf(p.version, p.repository)]);
  const raw = issued.certificate.toString('base64');
  const payload = Buffer.from(JSON.stringify(statement));
  const type = 'application/vnd.in-toto+json';
  // DSSE: the signature covers the payload type and the payload with their lengths.
  const signed = Buffer.concat([Buffer.from(`DSSEv1 ${String(type.length)} ${type} ${String(payload.length)} `), payload]);
  const signer = p.signature === 'forged' ? AUTHORITY.issue(['https://example.test/other']) : issued;
  const chain = { x509CertificateChain: { certificates: [{ rawBytes: raw }] } };
  const certificate = { certificate: { rawBytes: raw }, tlogEntries: [] };
  return {
    mediaType: `application/vnd.dev.sigstore.bundle${p.chain === true ? '+json;version=0.2' : '.v0.3+json'}`,
    verificationMaterial: {
      ...(p.chain === true ? chain : certificate),
      ...(p.extra === 'publicKey' ? { publicKey: { hint: 'SHA256:registry' } } : {}),
      ...(p.extra === 'otherForm' ? { ...chain, ...certificate } : {}),
    },
    dsseEnvelope: { payload: payload.toString('base64'), payloadType: type,
      signatures: [{ sig: p.signature === 'none' ? '' : signer.sign(signed).toString('base64'), keyid: '' }] },
  };
}

/**
 * What `npm audit signatures --json --include-attestations` prints after verifying the version: the publish
 * attestation and the provenance of `p`; `null` = a version with a registry signature and no attestation.
 */
function auditReport(p: Provenance | null, version = p?.version ?? '0.2.0'): unknown {
  const verified = p === null ? [] : [{
    name: '@rarog/server', version, location: 'node_modules/@rarog/server', registry: 'https://registry.npmjs.org/',
    attestations: { url: `https://registry.npmjs.org/-/npm/v1/attestations/@rarog%2fserver@${version}`,
      provenance: { predicateType: 'https://slsa.dev/provenance/v1' } },
    attestationBundles: [
      { predicateType: 'https://github.com/npm/attestation/tree/main/specs/publish/v0.1', bundle: {} },
      { predicateType: 'https://slsa.dev/provenance/v1', bundle: provenanceAttestation(p) },
    ],
  }];
  return { invalid: [], missing: [], verified };
}

/** The marker of a hanging fake npm call (`RegistryState.hang`). */
const hangMarker = (): string => path.join(t.home, 'npm-registry', 'npm-hang');

/** Registry publication times: 0.1.0 long ago, 0.2.0 three days and a few hours before `NOW` of the age tests. */
const REGISTRY_TIME: Readonly<Record<string, string>> = {
  created: '2026-10-01T08:00:00.000Z', modified: '2026-11-11T09:30:00.000Z',
  '0.1.0': '2026-10-01T08:00:00.000Z', '0.2.0': '2026-11-11T09:30:00.000Z',
};

/**
 * What `npm view @rarog/server time versions --json` prints: `time` and the versions on the registry, which are every
 * version of `time` except `unpublished` (npm unpublish keeps the time and removes the version).
 */
function timesView(time: Readonly<Record<string, string>>, unpublished: readonly string[] = []): unknown {
  const versions = Object.keys(time).filter((key) => !['created', 'modified', ...unpublished].includes(key));
  return { time, versions };
}

/**
 * Fake `npm-cli.js` of the registry tests; every call is logged with its node and its `npm_config_*` variables to
 * `npm-calls`.
 */
function fakeRegistryNpm(state: RegistryState, root = npmRoot()): string {
  const dir = path.join(t.home, 'npm-registry');
  const file = path.join(dir, 'npm-cli.js');
  mkdirSync(dir, { recursive: true });
  const view = state.view === undefined ? { version: '0.2.0' } : state.view;
  const packVersion = state.pack?.version ?? (typeof view?.version === 'string' ? view.version : '0.2.0');
  const packBytes = state.pack?.bytes ?? `tarball of ${packVersion}`;
  writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    prefix: state.prefix ?? prefix(), view,
    packVersion, packBytes, packCode: state.packCode ?? 0, packStderr: state.packStderr ?? 'npm error code E500\n',
    dist: state.distIntegrity === null ? null : { integrity: state.distIntegrity ?? sriOf(packBytes) },
    audit: state.audit === undefined ? auditReport({ version: packVersion, sha512: sha512Hex(packBytes) }) : state.audit,
    auditCode: state.auditCode ?? 0,
    install: state.install ?? null, installCode: state.installCode ?? 0,
    installStderr: state.installStderr ?? 'npm error code E500\n', root,
    gateConfig: state.gateConfig ?? null, times: state.times === undefined ? null : state.times,
    hang: state.hang ?? null,
  }));
  writeFileSync(file, [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const state = JSON.parse(fs.readFileSync(path.join(__dirname, 'state.json'), 'utf8'));",
    'const args = process.argv.slice(2);',
    'const config = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^npm_config_/i.test(name)));',
    '// The audit project as npm finds it, and the sha512 of the file an install gets at that moment.',
    'const seen = {};',
    "if (args[0] === 'audit') {",
    "  seen.project = JSON.parse(fs.readFileSync('package.json', 'utf8'));",
    "  seen.installed = JSON.parse(fs.readFileSync('node_modules/@rarog/server/package.json', 'utf8'));",
    '}',
    "if (args[0] === 'i' && fs.existsSync(args[args.length - 1])) {",
    "  seen.sha512 = require('node:crypto').createHash('sha512').update(fs.readFileSync(args[args.length - 1]))",
    "    .digest('hex');",
    '}',
    "fs.appendFileSync(path.join(__dirname, 'npm-calls'),",
    "  JSON.stringify({ args, node: process.execPath, config, cwd: process.cwd(), ...seen }) + '\\n');",
    "if (args[0] === 'prefix') { process.stdout.write(state.prefix + '\\n'); process.exit(0); }",
    "const call = args[0] === 'config' ? 'config' : args[0] === 'view' && args.includes('time') ? 'times' : null;",
    'if (call !== null && call === state.hang) {',
    "  fs.writeFileSync(path.join(__dirname, 'npm-hang'), call);",
    '  setInterval(() => {}, 1000);',
    "} else if (call === 'config') {",
    "  if (state.gateConfig === null) { process.stderr.write('npm error code EUNKNOWN\\n'); process.exit(1); }",
    '  process.stdout.write(state.gateConfig);',
    '  process.exit(0);',
    "} else if (call === 'times') {",
    "  if (state.times === null) { process.stderr.write('npm error code ENOTFOUND\\n'); process.exit(1); }",
    "  process.stdout.write(JSON.stringify(state.times, null, 2) + '\\n');",
    '  process.exit(0);',
    "} else if (args[0] === 'pack') {",
    "  if (state.packCode !== 0) { process.stderr.write(state.packStderr); process.exit(state.packCode); }",
    "  const filename = 'rarog-server-' + state.packVersion + '.tgz';",
    "  fs.writeFileSync(path.join(args[args.indexOf('--pack-destination') + 1], filename), state.packBytes);",
    "  process.stdout.write(JSON.stringify([{ id: '@rarog/server@' + state.packVersion, name: '@rarog/server',",
    "    version: state.packVersion, filename, files: [] }], null, 2) + '\\n');",
    '  process.exit(0);',
    "} else if (args[0] === 'view' && args.includes('dist')) {",
    "  if (state.dist === null) { process.stderr.write('npm error code ENOTFOUND\\n'); process.exit(1); }",
    "  process.stdout.write(JSON.stringify(state.dist, null, 2) + '\\n');",
    '  process.exit(0);',
    "} else if (args[0] === 'audit') {",
    "  if (state.auditCode !== 0) { process.stderr.write('npm error Failed to download\\n'); process.exit(state.auditCode); }",
    "  process.stdout.write(JSON.stringify(state.audit, null, 2) + '\\n');",
    // Like npm: an invalid or a missing signature is exit 1 with the same JSON.
    '  process.exit((state.audit.invalid ?? []).length + (state.audit.missing ?? []).length > 0 ? 1 : 0);',
    "} else if (args[0] === 'view') {",
    "  if (state.view === null) {",
    "    process.stderr.write('npm error code ENOTFOUND\\n');",
    '    process.exit(1);',
    '  }',
    "  process.stdout.write(JSON.stringify(state.view, null, 2) + '\\n');",
    '  process.exit(0);',
    "} else if (args[0] === 'i') {",
    '  if (state.installCode !== 0) { process.stderr.write(state.installStderr); process.exit(state.installCode); }',
    '  for (const [name, text] of Object.entries(state.install ?? {})) {',
    '    fs.mkdirSync(path.dirname(path.join(state.root, name)), { recursive: true });',
    '    fs.writeFileSync(path.join(state.root, name), text);',
    '  }',
    "  process.stdout.write('changed 1 package in 2s\\n');",
    '  process.exit(0);',
    '} else {',
    '  process.exit(2);',
    '}',
    '',
  ].join('\n'));
  return file;
}

interface NpmCall {
  readonly args: string[];
  readonly node: string;
  /** The `npm_config_*` variables npm got. */
  readonly config: Record<string, string>;
  readonly cwd: string;
  /** `npm audit`: the project's `package.json` and the installed package's. */
  readonly project?: unknown;
  readonly installed?: unknown;
  /** `npm i`: the sha512 of the file it got, when its last argument is a file. */
  readonly sha512?: string;
}

const npmCalls = (): NpmCall[] => {
  const file = path.join(t.home, 'npm-registry', 'npm-calls');
  return existsSync(file)
    ? readFileSync(file, 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as NpmCall)
    : [];
};

const npmArgs = (): string[] => npmCalls().map((call) => call.args.join(' '));

/** The update's temporary directory: `npm pack` downloads into its `tarball/` ('' = no pack call). */
const workDir = (): string => {
  const pack = npmCalls().find((call) => call.args[0] === 'pack');
  return pack === undefined ? '' : path.dirname(pack.args[pack.args.indexOf('--pack-destination') + 1] ?? '');
};

/** The new version 0.2.0 as `npm i -g` lays it out: its `package.json` and a recording `bin/rarog.mjs`. */
const newVersion = (version = '0.2.0', code = 0): Record<string, string> => ({
  'package.json': JSON.stringify({ name: '@rarog/server', version }),
  'bin/rarog.mjs': recordingBin(startRecord(), code),
});

interface Started {
  readonly argv: string[];
  readonly node: string;
  readonly token: string | null;
  readonly lock: string | null;
}

const started = (file = startRecord()): Started | null =>
  (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Started : null);

/** `config.json` of an installed machine, so the command has an installation to update. */
function configured(): void {
  writeConfig({ RAROG_ORIGINS: 'https://rarog.example.net', RAROG_PORT: String(port) });
}

interface UpdateRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly screen: string;
  readonly asked: Question[];
  readonly order: string[];
}

interface UpdateOptions {
  readonly root: string;
  readonly argv?: readonly string[];
  /** `null` = no terminal. */
  readonly answer?: ((question: Question) => string) | null;
  readonly env?: NodeJS.ProcessEnv;
  readonly npmCli?: string;
  readonly deps?: Partial<UpdateDeps>;
}

/** `rarog update …` in the test process on a 60-column terminal; the answer to every question is "y". */
async function runUpdate(options: UpdateOptions): Promise<UpdateRun> {
  let stdout = '';
  let stderr = '';
  let screen = '';
  const asked: Question[] = [];
  const order: string[] = [];
  const answer = options.answer === undefined ? (): string => 'y' : options.answer;
  const io: CliIo = {
    stdout: (text) => { stdout += text; screen += text; },
    stderr: (text) => { stderr += text; screen += text; },
    env: options.env ?? env(home, { PATH: `${bin}:${path.join(prefix(), 'bin')}:/usr/bin:/bin` }),
    cwd: t.home,
    terminal: TTY_60,
    ...(answer === null ? {} : {
      ask: (prompt: string) => {
        const question = questionOf(prompt);
        asked.push(question);
        order.push(`ask:${question}`);
        const given = answer(question);
        stdout += `${prompt}${given}\n`;
        screen += `${prompt}${given}\n`;
        return Promise.resolve(given);
      },
    }),
  };
  const deps: UpdateDeps = {
    mode: 'package', installRoot: options.root, provenanceAuthority: AUTHORITY.certificate,
    ...(options.npmCli === undefined ? {} : { npmCli: options.npmCli }),
    serviceInstall: () => {
      order.push('service install');
      return Promise.resolve(0);
    },
    restart: (_io: CliIo, output: (text: string) => void) => {
      order.push('restart');
      output('restart-fake line');
      return Promise.resolve(0);
    },
    sdkInstall: (sdk) => {
      order.push('sdk download');
      return installSdk({ ...sdk, npmCli: fakeSdkNpm() });
    },
    sdkProbe: () => Promise.resolve({ ok: true }),
    checkPort: port,
    checkTimeoutMs: CHECK_TIMEOUT_MS,
    ...options.deps,
  };
  const code = await updateCommand(['update', ...(options.argv ?? [])], io, deps);
  return { code, stdout, stderr, screen: visible(screen), asked, order };
}

/** Fake `npm-cli.js` for the Claude SDK download (`npm ci`): leaves only the SDK package. */
function fakeSdkNpm(): string {
  const dir = path.join(t.home, 'npm-sdk');
  const file = path.join(dir, 'npm-cli.js');
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, [
    "const fs = require('node:fs');",
    "fs.mkdirSync('node_modules/@anthropic-ai/claude-agent-sdk', { recursive: true });",
    "fs.writeFileSync('node_modules/@anthropic-ai/claude-agent-sdk/package.json', '{}');",
    '',
  ].join('\n'));
  return file;
}

/** The step lines of the screen (` <mark> <title> …`), the new-terminal line excluded. */
const stepLines = (screen: string): string[] => lines(screen)
  .filter((line) => /^ [✓✗!–] \S/u.test(line) && !line.includes('In a new terminal'));

const lockFile = (): string => path.join(configDir(), UPDATE_LOCK_FILENAME);


/**
 * A refusal on the 60-column terminal of these runs as one sentence: it wraps at the screen width (a path breaks
 * after a `/`), so the lines go back together; each of them fits 60 columns.
 */
function oneSentence(stderr: string): string {
  const lines = stderr.trimEnd().split('\n');
  for (const line of lines) expect([...line].length, line).toBeLessThanOrEqual(60);
  return `${lines.join(' ').replace(/\/ /gu, '/')}\n`;
}

describe('rarog update: a new version from the npm registry', () => {
  it('registry 0.2.0, installed 0.1.0: npm pack of @rarog/server@>0.1.0 <=0.2.0, its provenance checked, the file'
    + ' installed with npm i -g --ignore-scripts and this node, then the NEW version finishes in its own process with'
    + ' the lock token and installed', async () => {
    const root = npmInstallation('0.1.0');
    configured();
    const npmCli = fakeRegistryNpm({ view: { version: '0.2.0', engines: { node: '>=22.15 <23 || >=23.11' } },
      install: newVersion() });
    const run = await runUpdate({ root, npmCli });
    expect(run.code, run.screen).toBe(0);
    const work = workDir();
    expect(npmArgs()).toEqual(['prefix -g', 'view @rarog/server@latest version engines --json',
      `pack @rarog/server@>0.1.0 <=0.2.0 --ignore-scripts --json --pack-destination ${work}/tarball`,
      'view @rarog/server@0.2.0 dist --json', 'audit signatures --json --include-attestations',
      `i -g --ignore-scripts ${work}/tarball/rarog-server-0.2.0.tgz`]);
    for (const call of npmCalls()) expect(call.node).toBe(process.execPath);
    const child = started();
    expect(child, 'the new version was started').not.toBeNull();
    expect(child?.node).toBe(process.execPath);
    expect(child?.argv).toEqual([path.join(root, 'bin', 'rarog.mjs'), 'update', '--finish']);
    // The child inherits the lock: its token, and `installed` naming this root and the new version.
    expect(child?.token).toMatch(/^[0-9a-f]{32}$/u);
    expect(child?.lock).toContain(`token=${child?.token ?? ''}\n`);
    expect(child?.lock).toContain('installed.version=0.2.0\n');
    expect(child?.lock).toContain(`installed.root=${root}\n`);
    // The old process ran nothing of the finish itself and never started the old version.
    expect(run.order).toEqual([]);
    expect(started(oldRecord())).toBeNull();
    expect(run.asked).toEqual([]);
    expect(lines(run.screen)[0]).toBe('Rarog update 0.1.0 → 0.2.0');
    expect(stepLines(run.screen)).toEqual([expect.stringMatching(/^ ✓ Download {7}rarog 0\.2\.0 from npm/u)]);
    for (const line of lines(run.screen)) expect([...line].length, line).toBeLessThanOrEqual(60);
    expect(existsSync(lockFile()), 'the lock is released after the child').toBe(false);
  });

  it('--data-dir and --verbose go to the new version; its exit code is the command\'s', async () => {
    const root = npmInstallation('0.1.0');
    configured();
    const custom = path.join(home, 'data');
    const npmCli = fakeRegistryNpm({ install: newVersion('0.2.0', 1) });
    const run = await runUpdate({ root, npmCli, argv: ['--data-dir', custom, '--verbose'] });
    expect(run.code, run.screen).toBe(1);
    expect(started()?.argv).toEqual([path.join(root, 'bin', 'rarog.mjs'), 'update', '--finish', '--data-dir', custom,
      '--verbose']);
    expect(existsSync(lockFile())).toBe(false);
  });

  it('npm installs the checked file, but the package root still has 0.1.0 → ✗ Download, code 1, nothing finished',
    async () => {
      const root = npmInstallation('0.1.0');
      configured();
      const npmCli = fakeRegistryNpm({ view: { version: '0.2.0' } });
      const run = await runUpdate({ root, npmCli });
      expect(run.code, run.screen).toBe(1);
      expect(npmArgs().at(-1)).toMatch(/^i -g --ignore-scripts \S+\/rarog-server-0\.2\.0\.tgz$/u);
      expect(flat(run.screen.replace(/\/\n +/gu, '/')))
        .toContain(`✗ Download after npm, ${root} has 0.1.0, not 0.2.0`);
      expect(started()).toBeNull();
      expect(started(oldRecord())).toBeNull();
      expect(run.order).toEqual([]);
      expect(existsSync(lockFile())).toBe(false);
    });

  it('installed 0.1.1, registry 0.2.0: the download spec is one argument, above this version up to the latest, so an'
    + ' age gate can never pick an older one', async () => {
    const root = npmInstallation('0.1.1');
    configured();
    const npmCli = fakeRegistryNpm({ install: newVersion() });
    const run = await runUpdate({ root, npmCli });
    expect(run.code, run.screen).toBe(0);
    expect(npmCalls().find((call) => call.args[0] === 'pack')?.args.slice(0, 2))
      .toEqual(['pack', '@rarog/server@>0.1.1 <=0.2.0']);
  });

  it('an age gate set in the environment reaches every npm call of the update; prefix, global and scripts do not',
    async () => {
      const root = npmInstallation('0.1.0');
      configured();
      const npmCli = fakeRegistryNpm({ install: newVersion() });
      const run = await runUpdate({ root, npmCli, env: env(home, {
        PATH: `${bin}:${path.join(prefix(), 'bin')}:/usr/bin:/bin`,
        npm_config_min_release_age: '7', npm_config_before: '2026-11-01',
        NPM_CONFIG_MIN_RELEASE_AGE_EXCLUDE: 'left-pad',
        npm_config_prefix: '/x', npm_config_global: 'false', npm_config_ignore_scripts: 'false',
      }) });
      expect(run.code, run.screen).toBe(0);
      expect(npmArgs()).toHaveLength(6);
      for (const call of npmCalls()) {
        expect(call.config, call.args.join(' ')).toEqual({
          npm_config_min_release_age: '7', npm_config_before: '2026-11-01',
          NPM_CONFIG_MIN_RELEASE_AGE_EXCLUDE: 'left-pad',
        });
      }
    });

  it.each([
    ['ETARGET', 'npm error code ETARGET\nnpm error notarget No matching version found for @rarog/server@>0.1.0 <=0.2.0'
      + ' with a'
      + ' date before 11/6/2026, 10:00:00 AM.\nnpm error notarget In most cases you or one of your dependencies are'
      + " requesting\nnpm error notarget a package version that doesn't exist.\n"],
    ['ENOVERSIONS', 'npm error code ENOVERSIONS\nnpm error No versions available for rarog\n'],
  ])('npm finds no version old enough (%s, exit 1) → ! not installed yet, code 0, nothing finished',
    async (_code, stderr) => {
      const root = npmInstallation('0.1.0');
      configured();
      const npmCli = fakeRegistryNpm({ packCode: 1, packStderr: stderr, install: newVersion() });
      const run = await runUpdate({ root, npmCli });
      expect(run.code, run.screen).toBe(0);
      expect(npmArgs()[2]).toMatch(/^pack @rarog\/server@>0\.1\.0 <=0\.2\.0 /u);
      expect(npmArgs().some((args) => args.startsWith('i '))).toBe(false);
      expect(existsSync(workDir()), 'the temporary directory is removed').toBe(false);
      expect(stepLines(run.screen)).toEqual([expect.stringMatching(/^ ! Download {7}rarog 0\.2\.0 not installed/u)]);
      expect(flat(run.screen)).toContain('! Download rarog 0.2.0 not installed yet (npm age gate)');
      expect(run.screen).not.toMatch(/Fix:/u);
      expect(started()).toBeNull();
      expect(started(oldRecord())).toBeNull();
      expect(run.order).toEqual([]);
      expect(existsSync(lockFile())).toBe(false);
    });

  describe('the date of the npm age gate', () => {
    /** The test's clock (only `Date`: the timers of the harness and of npm stay real). */
    const NOW = '2026-11-14T12:00:00.000Z';
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(NOW));
    });
    afterEach(() => { vi.useRealTimers(); });

    const TIME = REGISTRY_TIME;
    const GATE_7 = 'min-release-age=7\nbefore=null\n';
    const ENV_7 = (): NodeJS.ProcessEnv => env(home, {
      PATH: `${bin}:${path.join(prefix(), 'bin')}:/usr/bin:/bin`, npm_config_min_release_age: '7',
    });

    it('min-release-age 7, 0.2.0 published 3 days ago → its age and the day npm installs it, wrapped at 60 columns;'
      + ' npm asked with the environment and -g of the install', async () => {
      const root = npmInstallation('0.1.0');
      configured();
      const npmCli = fakeRegistryNpm({ ...HELD, gateConfig: GATE_7, times: timesView(TIME) });
      const run = await runUpdate({ root, npmCli, env: ENV_7() });
      expect(run.code, run.screen).toBe(0);
      expect(lines(run.screen).slice(1)).toEqual([
        ' ! Download       rarog 0.2.0 is 3 days old; npm installs it',
        '                  from 2026-11-18',
      ]);
      expect(npmArgs()).toEqual(['prefix -g', 'view @rarog/server@latest version engines --json',
        `pack @rarog/server@>0.1.0 <=0.2.0 --ignore-scripts --json --pack-destination ${workDir()}/tarball`,
        'config get min-release-age before -g', 'view @rarog/server time versions --json']);
      const config = npmCalls().map((call) => call.config);
      expect(config[3]).toEqual({ npm_config_min_release_age: '7' });
      expect(config[3]).toEqual(config[2]);
      expect(started()).toBeNull();
      expect(started(oldRecord())).toBeNull();
      expect(existsSync(lockFile())).toBe(false);
    });

    it('npm finds no version old enough (ETARGET): the same date', async () => {
      const root = npmInstallation('0.1.0');
      configured();
      const npmCli = fakeRegistryNpm({ gateConfig: GATE_7, times: timesView(TIME), packCode: 1,
        packStderr: 'npm error code ETARGET\n' });
      const run = await runUpdate({ root, npmCli });
      expect(run.code, run.screen).toBe(0);
      expect(flat(run.screen)).toContain('! Download rarog 0.2.0 is 3 days old; npm installs it from 2026-11-18');
    });

    it('a version between this one and the latest is older: the date of the earliest', async () => {
      const root = npmInstallation('0.1.0');
      configured();
      const npmCli = fakeRegistryNpm({ ...HELD, gateConfig: GATE_7,
        times: timesView({ ...TIME, '0.1.5': '2026-11-09T20:00:00.000Z' }) });
      const run = await runUpdate({ root, npmCli });
      expect(run.code, run.screen).toBe(0);
      expect(flat(run.screen)).toContain('! Download rarog 0.1.5 is 4 days old; npm installs it from 2026-11-16');
    });

    it('an unpublished 0.1.5 older than 0.2.0 (in time, not in versions): the date and the name are 0.2.0\'s',
      async () => {
        const root = npmInstallation('0.1.0');
        configured();
        const npmCli = fakeRegistryNpm({ ...HELD, gateConfig: GATE_7,
          times: timesView({ ...TIME, '0.1.5': '2026-11-09T20:00:00.000Z' }, ['0.1.5']) });
        const run = await runUpdate({ root, npmCli });
        expect(run.code, run.screen).toBe(0);
        expect(flat(run.screen)).toContain('! Download rarog 0.2.0 is 3 days old; npm installs it from 2026-11-18');
      });

    it.each(['config', 'times'] as const)('Ctrl-C while npm reads the gate (%s) → 130, the lock released, nothing'
      + ' after it', async (hang) => {
      const root = npmInstallation('0.1.0');
      configured();
      const npmCli = fakeRegistryNpm({ ...HELD, gateConfig: GATE_7, times: timesView(TIME), hang });
      const running = runUpdate({ root, npmCli });
      await vi.waitFor(() => { expect(existsSync(hangMarker())).toBe(true); }, { timeout: 10_000, interval: 20 });
      interruptOrExit(() => { throw new Error('the command must not exit while npm runs'); });
      const run = await running;
      expect(run.code, run.screen).toBe(130);
      expect(npmArgs().at(-1)).toBe(hang === 'config' ? 'config get min-release-age before -g'
        : 'view @rarog/server time versions --json');
      expect(existsSync(lockFile()), 'the lock is released').toBe(false);
      expect(started()).toBeNull();
      expect(started(oldRecord())).toBeNull();
      expect(run.order).toEqual([]);
    });

    it('installed 0.1.2, 0.2.0 not yet → the same form with the age and the date', async () => {
      const root = npmInstallation('0.1.0');
      configured();
      const npmCli = fakeRegistryNpm({ gateConfig: GATE_7, install: newVersion('0.1.2'), pack: { version: '0.1.2' },
        times: timesView({ ...TIME, '0.1.2': '2026-10-20T08:00:00.000Z' }) });
      const run = await runUpdate({ root, npmCli });
      expect(run.code, run.screen).toBe(0);
      expect(npmArgs().slice(6))
        .toEqual(['config get min-release-age before -g', 'view @rarog/server time versions --json']);
      expect(flat(run.screen))
        .toContain('! Download rarog 0.1.2 installed, 0.2.0 is 3 days old; npm installs it from 2026-11-18');
      expect(started()?.argv.slice(1)).toEqual(['update', '--finish']);
    });

    it.each([
      ['before is set', { gateConfig: 'min-release-age=7\nbefore=Sun Nov 01 2026 01:00:00 GMT+0100\n',
        times: timesView(TIME) }],
      ['npm config get fails', { times: timesView(TIME) }],
      ['npm view time fails', { gateConfig: GATE_7 }],
    ])('%s → the text without a date, code 0 as without it', async (_case, state: RegistryState) => {
      const root = npmInstallation('0.1.0');
      configured();
      const run = await runUpdate({ root, npmCli: fakeRegistryNpm({ ...HELD, ...state }) });
      expect(run.code, run.screen).toBe(0);
      expect(flat(run.screen)).toContain('! Download rarog 0.2.0 not installed yet (npm age gate)');
      expect(run.screen).not.toMatch(/Fix:/u);
      expect(started()).toBeNull();
    });

    it('before is set: npm view time is not asked', async () => {
      const root = npmInstallation('0.1.0');
      configured();
      await runUpdate({ root, npmCli: fakeRegistryNpm({ ...HELD, gateConfig: 'min-release-age=7\nbefore=2026-11-01\n',
        times: timesView(TIME) }) });
      expect(npmArgs().at(-1)).toBe('config get min-release-age before -g');
    });
  });

  // The provenance rule: only the one tarball npm downloaded, whose sha512 is the registry's dist.integrity and
  // whose provenance the certificate authority issued for the publish workflow of useo-pl/rarog at the version's tag.
  describe('only the attested tarball is installed (provenance)', () => {
    const REPORT = 'Fix: do not install it by hand; report it at https://github.com/useo-pl/rarog/security';

    /** The run refused before any install: code 1, this version untouched, nothing finished, the work dir gone. */
    function refusedBeforeInstall(run: UpdateRun, root: string, summary: string): void {
      expect(run.code, run.screen).toBe(1);
      expect(npmArgs().some((args) => args.startsWith('i ')), npmArgs().join('\n')).toBe(false);
      expect(stepLines(run.screen)).toEqual([expect.stringMatching(/^ ✗ Download {7}\S/u)]);
      const screen = flat(run.screen.replace(/\/\n +/gu, '/'));
      expect(screen).toContain(`✗ Download ${summary}`);
      expect(screen).toContain(REPORT);
      expect(JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))).toMatchObject({ version: '0.1.0' });
      expect(started()).toBeNull();
      expect(started(oldRecord())).toBeNull();
      expect(run.order).toEqual([]);
      expect(existsSync(workDir()), 'the temporary directory is removed').toBe(false);
    }

    it('1. the age gate picks an older version, 0.1.5, that has no attestation → refused before any install',
      async () => {
        const root = npmInstallation('0.1.0');
        configured();
        const npmCli = fakeRegistryNpm({ pack: { version: '0.1.5' }, audit: auditReport(null, '0.1.5'),
          install: newVersion('0.1.5') });
        const run = await runUpdate({ root, npmCli });
        expect(npmArgs().slice(3)).toEqual(['view @rarog/server@0.1.5 dist --json',
          'audit signatures --json --include-attestations']);
        refusedBeforeInstall(run, root, '@rarog/server 0.1.5 has no verified provenance');
      });

    it('2. a tarball whose sha512 differs from dist.integrity → refused before the signature check', async () => {
      const root = npmInstallation('0.1.0');
      configured();
      const npmCli = fakeRegistryNpm({ distIntegrity: sriOf('another tarball'), install: newVersion() });
      const run = await runUpdate({ root, npmCli });
      expect(npmArgs().at(-1)).toBe('view @rarog/server@0.2.0 dist --json');
      refusedBeforeInstall(run, root, 'the tarball of @rarog/server 0.2.0 differs from the registry\'s dist.integrity');
    });

    const BYTES = 'tarball of 0.2.0';
    it.each([
      ['an attestation of another repository', { version: '0.2.0', sha512: sha512Hex(BYTES),
        repository: 'https://github.com/someone/rarog' },
      `@rarog/server 0.2.0 was signed by ${identityOf('0.2.0', 'https://github.com/someone/rarog')}, not by`
        + ` ${identityOf('0.2.0')}`],
      ['a statement that names this repository, signed by another one', { version: '0.2.0', sha512: sha512Hex(BYTES),
        certificate: [identityOf('0.2.0', 'https://github.com/someone/rarog')] },
      `@rarog/server 0.2.0 was signed by ${identityOf('0.2.0', 'https://github.com/someone/rarog')}`],
      ['this workflow at another tag', { version: '0.2.0', sha512: sha512Hex(BYTES),
        certificate: [identityOf('0.1.9')] },
      `@rarog/server 0.2.0 was signed by ${identityOf('0.1.9')}`],
      ['a provenance of another tarball', { version: '0.2.0', sha512: sha512Hex('another tarball') },
        'the provenance of @rarog/server 0.2.0 names another tarball'],
      // What a registry can put into npm's list of verified attestations on its own: every name right, its own keys.
      ['a provenance with the right names that the certificate authority did not issue',
        { version: '0.2.0', sha512: sha512Hex(BYTES), authority: FOREIGN },
        'the provenance of @rarog/server 0.2.0 has a certificate Sigstore did not issue'],
    ])('3. %s → refused before any install', async (_case, provenance: Provenance, summary) => {
      const root = npmInstallation('0.1.0');
      configured();
      const npmCli = fakeRegistryNpm({ audit: auditReport(provenance), install: newVersion() });
      const run = await runUpdate({ root, npmCli });
      expect(npmArgs().at(-1)).toBe('audit signatures --json --include-attestations');
      refusedBeforeInstall(run, root, summary);
    });

    it('4. a matching provenance and sha512 → npm installs exactly the checked file, then the new version finishes',
      async () => {
        const root = npmInstallation('0.1.0');
        configured();
        const npmCli = fakeRegistryNpm({ install: newVersion() });
        const run = await runUpdate({ root, npmCli });
        expect(run.code, run.screen).toBe(0);
        const [audit, install] = npmCalls().slice(4);
        // npm checks signatures in a project that names only this version, installed as its bare package.json.
        expect(audit?.cwd.endsWith(path.join(path.basename(workDir()), 'audit')), audit?.cwd).toBe(true);
        expect(audit?.project).toMatchObject({ dependencies: { '@rarog/server': '0.2.0' } });
        expect(audit?.installed).toEqual({ name: '@rarog/server', version: '0.2.0' });
        expect(install?.args).toEqual(['i', '-g', '--ignore-scripts',
          path.join(workDir(), 'tarball', 'rarog-server-0.2.0.tgz')]);
        expect(install?.sha512).toBe(sha512Hex(BYTES));
        expect(started()?.argv.slice(1)).toEqual(['update', '--finish']);
        expect(existsSync(workDir()), 'the temporary directory is removed').toBe(false);
        expect(updateLogs().join('\n')).toContain(`provenance verified: ${identityOf('0.2.0')}`);
      });

    it('npm finds an invalid attestation (exit 1 with its findings) → refused as the package\'s problem, not the'
      + ' network\'s', async () => {
      const root = npmInstallation('0.1.0');
      configured();
      const audit = { invalid: [{ name: '@rarog/server', version: '0.2.0', code: 'EATTESTATIONVERIFY' }], missing: [],
        verified: [] };
      const run = await runUpdate({ root, npmCli: fakeRegistryNpm({ audit, install: newVersion() }) });
      refusedBeforeInstall(run, root, 'npm found an invalid signature or attestation of @rarog/server 0.2.0');
    });

    it('an npm that does not list attestations (before 11.12) → ✗ Download names npm, not the package; nothing'
      + ' installed', async () => {
      const root = npmInstallation('0.1.0');
      configured();
      const npmCli = fakeRegistryNpm({ audit: { invalid: [], missing: [] }, install: newVersion() });
      const run = await runUpdate({ root, npmCli });
      expect(run.code, run.screen).toBe(1);
      expect(npmArgs().some((args) => args.startsWith('i '))).toBe(false);
      expect(flat(run.screen)).toContain('✗ Download this npm does not list attestations (it needs npm 11.12 or newer)');
      // The test's npm is no global installation, so the fix names the node whose npm it is.
      expect(flat(run.screen.replace(/\/\n +/gu, '/')))
        .toContain(`Fix: update the npm next to ${process.execPath} to 11.12 or newer, then rarog update`);
      expect(run.screen).not.toContain('report it at');
    });

    it('npm cannot check the signatures (the sigstore TUF host offline: exit 1) → ✗ Download with the network fix,'
      + ' nothing installed', async () => {
      const root = npmInstallation('0.1.0');
      configured();
      const npmCli = fakeRegistryNpm({ auditCode: 1, install: newVersion() });
      const run = await runUpdate({ root, npmCli });
      expect(run.code, run.screen).toBe(1);
      expect(npmArgs().some((args) => args.startsWith('i '))).toBe(false);
      expect(stepLines(run.screen)).toEqual([expect.stringMatching(/^ ✗ Download {7}\S/u)]);
      expect(flat(run.screen)).toContain('✗ Download signature check failed (npm audit signatures, exit 1)');
      expect(run.screen).toMatch(/^ {3}Fix: check the network, then rarog update$/mu);
      expect(updateLogs().join('\n')).toContain('npm error Failed to download');
      expect(existsSync(workDir())).toBe(false);
    });
  });

  it('npm install fails another way (ECONNREFUSED, exit 1) → ✗ Download with the network fix, code 1', async () => {
    const root = npmInstallation('0.1.0');
    configured();
    const npmCli = fakeRegistryNpm({ installCode: 1, installStderr: 'npm error code ECONNREFUSED\n'
      + 'npm error errno ECONNREFUSED\n'
      + 'npm error request to https://registry.npmjs.org/rarog failed, reason: connect ECONNREFUSED\n' });
    const run = await runUpdate({ root, npmCli });
    expect(run.code, run.screen).toBe(1);
    expect(stepLines(run.screen))
      .toEqual([expect.stringMatching(/^ ✗ Download {7}install failed \(npm install, exit 1\)/u)]);
    expect(run.screen).toMatch(/^ {3}Fix: check the network, then rarog update$/mu);
    expect(started()).toBeNull();
    expect(run.order).toEqual([]);
  });

  it('offline: npm view fails → ✗ Download with Fix: and Log:, no install, code 1', async () => {
    const root = npmInstallation('0.1.0');
    configured();
    const npmCli = fakeRegistryNpm({ view: null });
    const run = await runUpdate({ root, npmCli });
    expect(run.code, run.screen).toBe(1);
    expect(npmArgs()).toEqual(['prefix -g', 'view @rarog/server@latest version engines --json']);
    expect(stepLines(run.screen)).toEqual([expect.stringMatching(/^ ✗ Download {7}\S/u)]);
    expect(run.screen).toMatch(/^ {3}Fix: check the network, then rarog update$/mu);
    expect(run.screen).toMatch(/^ {3}Log: ~\/\.local\/share\/rarog\/logs\/update-/mu);
    expect(started()).toBeNull();
  });

  it('engines needs a newer Node: refused before the install, code 1', async () => {
    const root = npmInstallation('0.1.0');
    configured();
    const npmCli = fakeRegistryNpm({ view: { version: '0.2.0', engines: { node: '>=99' } }, install: newVersion() });
    const run = await runUpdate({ root, npmCli });
    expect(run.code, run.screen).toBe(1);
    expect(npmArgs()).toEqual(['prefix -g', 'view @rarog/server@latest version engines --json']);
    expect(flat(run.screen)).toContain(`✗ Download rarog 0.2.0 needs Node >=99; this is ${process.versions.node}`);
    expect(JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))).toMatchObject({ version: '0.1.0' });
    expect(started()).toBeNull();
  });

  it('npm installs into another prefix than this installation: refused before the registry, code 1', async () => {
    const root = npmInstallation('0.1.0');
    configured();
    const npmCli = fakeRegistryNpm({ prefix: path.join(t.home, 'other-prefix'), install: newVersion() });
    const run = await runUpdate({ root, npmCli });
    expect(run.code, run.screen).toBe(1);
    expect(npmArgs()).toEqual(['prefix -g']);
    expect(stepLines(run.screen)).toEqual([expect.stringMatching(/^ ✗ Download {7}npm installs into\b/u)]);
    // A path in a wrapped Fix: sentence breaks after a slash.
    expect(flat(run.screen.replace(/\/\n +/gu, '/')))
      .toContain(`--prefix '${prefix()}' @rarog/server@latest, then rarog update --finish`);
    expect(started()).toBeNull();
  });

  it('a pnpm installation: refused with the pnpm command, nothing installed', async () => {
    const root = path.join(t.home, 'pnpm', 'store', 'v11', 'links', '@rarog', 'server', '0.1.0', 'abc',
      'node_modules', '@rarog', 'server');
    write(path.join(root, 'package.json'), JSON.stringify({ name: '@rarog/server', version: '0.1.0' }));
    configured();
    const npmCli = fakeRegistryNpm({ install: newVersion() }, root);
    const run = await runUpdate({ root, npmCli });
    expect(run.code, run.screen).toBe(1);
    expect(npmArgs()).toEqual([]);
    expect(flat(run.screen.replace(/\/\n +/gu, '/')))
      .toContain('Fix: pnpm add -g @rarog/server@latest, then rarog update --finish');
  });

  // The registry is asked only about @rarog/server, and npm refuses it next to a package that owns the command
  // `rarog` (EEXIST), so the fix removes this installation's package first.
  it.each([
    ['rarog, the owner\'s local tarball', ['rarog'], 'rarog',
      (p: string) => `npm uninstall -g --prefix '${p}' rarog, then npm i -g --prefix '${p}' @rarog/server@latest`],
    ['a trial package of the scope', ['@rarog', 'publish-trial'], '@rarog/publish-trial',
      (p: string) => `npm uninstall -g --prefix '${p}' @rarog/publish-trial, then npm i -g --prefix '${p}'`
        + ' @rarog/server@latest'],
    ['a package.json without a name', ['@rarog', 'server'], null,
      (p: string) => `npm i -g --prefix '${p}' @rarog/server@latest`],
  ])('another package than @rarog/server (%s): refused before any npm call, nothing installed, code 1',
    async (_what, segments, name, fix) => {
      const root = npmInstallation('0.1.0', path.join(prefix(), 'lib', 'node_modules', ...segments), name);
      const before = readFileSync(path.join(root, 'package.json'), 'utf8');
      configured();
      const npmCli = fakeRegistryNpm({ install: newVersion() }, root);
      const run = await runUpdate({ root, npmCli });
      expect(run.code, run.screen).toBe(1);
      expect(npmCalls()).toEqual([]);
      expect(stepLines(run.screen)).toEqual([expect.stringMatching(/^ ✗ Download {7}\S/u)]);
      expect(flat(run.screen.replace(/\/\n +/gu, '/')))
        .toContain(`Fix: ${fix(prefix())}, then rarog service install, then rarog update --finish`);
      expect(readFileSync(path.join(root, 'package.json'), 'utf8')).toBe(before);
      expect(started()).toBeNull();
      expect(started(oldRecord())).toBeNull();
      expect(run.order).toEqual([]);
    });

  // The fix removes this installation, so its absolute `rarog.mjs` (the form of a Node version manager's prefix) would
  // name a deleted file: the commands after the install are the `rarog` of the new package.
  it('another package under a Node version manager: the fix does not run the removed installation', async () => {
    const nvmPrefix = path.join(home, '.nvm', 'versions', 'node', 'v22.0.0');
    const root = npmInstallation('0.1.0', path.join(nvmPrefix, 'lib', 'node_modules', 'rarog'), 'rarog');
    configured();
    const run = await runUpdate({ root, npmCli: fakeRegistryNpm({ install: newVersion() }, root) });
    expect(run.code, run.screen).toBe(1);
    const screen = flat(run.screen.replace(/\/\n +/gu, '/'));
    expect(screen).toContain(', then rarog service install, then rarog update --finish');
    expect(screen).not.toContain(path.join(root, 'bin', 'rarog.mjs'));
  });

  it('another package with --verbose: the reason and the fix are on the screen', async () => {
    const root = npmInstallation('0.1.0', path.join(prefix(), 'lib', 'node_modules', 'rarog'), 'rarog');
    configured();
    const npmCli = fakeRegistryNpm({ install: newVersion() }, root);
    const run = await runUpdate({ root, npmCli, argv: ['--verbose'] });
    expect(run.code, run.screen).toBe(1);
    const screen = flat(run.screen);
    expect(screen).toContain('this installation is the package rarog, not @rarog/server');
    expect(screen).toContain(`fix: npm uninstall -g --prefix '${prefix()}' rarog, then npm i -g --prefix '${prefix()}'`
      + ' @rarog/server@latest, then rarog service install, then rarog update --finish');
  });

  it('a second live update: one sentence on stderr, npm never called', async () => {
    const root = npmInstallation('0.1.0');
    configured();
    const npmCli = fakeRegistryNpm({ install: newVersion() });
    write(lockFile(), `${String(process.ppid)}\ntoken=${TOKEN}\n`, 0o600);
    const run = await runUpdate({ root, npmCli });
    expect(run.code).toBe(1);
    expect(oneSentence(run.stderr)).toBe(`rarog update: another update is running (PID ${String(process.ppid)}, lock`
      + ` ${lockFile()}); wait until it ends.\n`);
    expect(npmCalls()).toEqual([]);
  });

  it('no terminal: refused with one sentence, npm never called', async () => {
    const root = npmInstallation('0.1.0');
    configured();
    const npmCli = fakeRegistryNpm({ install: newVersion() });
    const run = await runUpdate({ root, npmCli, answer: null });
    expect(run.code).toBe(1);
    expect(oneSentence(run.stderr))
      .toBe('rarog update: no terminal, so nothing was changed; run rarog update in a terminal.\n');
    expect(npmCalls()).toEqual([]);
    expect(existsSync(lockFile())).toBe(false);
  });

  it('the old process loads no module after the install: no dynamic import or require in the update modules', () => {
    for (const file of ['server/src/cli/update.ts', 'server/src/cli/update-registry.ts',
      'server/src/cli/update-provenance.ts']) {
      const { code } = scan(readFileSync(path.join(REPO, file), 'utf8'));
      expect(code, file).not.toMatch(/\bimport\s*\(|\brequire\s*\(|\bcreateRequire\b/u);
    }
  });
});

describe('rarog update: versions and the engines range', () => {
  it('compareVersions: core numbers, a pre-release below its release, build metadata ignored', () => {
    expect(compareVersions('0.2.0', '0.1.0')).toBeGreaterThan(0);
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0);
    expect(compareVersions('0.1.1-local.202611121943.654e2d6', '0.1.0')).toBeGreaterThan(0);
    expect(compareVersions('0.1.1', '0.1.1-local.202611121943.654e2d6')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-rc.2', '1.0.0-rc.10')).toBeLessThan(0);
    expect(compareVersions('1.0.0+abc', '1.0.0')).toBe(0);
    expect(compareVersions('v1.0.0', '1.0.0')).toBeNull();
  });

  it('nodeSatisfies: the package\'s own engines range, comparators, and an unknown form', () => {
    const range = (JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8')) as { engines: { node: string } })
      .engines.node;
    expect(nodeSatisfies('22.22.3', range)).toBe(true);
    expect(nodeSatisfies('22.14.9', range)).toBe(false);
    expect(nodeSatisfies('23.5.0', range)).toBe(false);
    expect(nodeSatisfies('23.11.0', range)).toBe(true);
    expect(nodeSatisfies('26.10.0', range)).toBe(true);
    expect(nodeSatisfies('22.22.3', '>=24')).toBe(false);
    expect(nodeSatisfies('24.0.0', '>24.0.0')).toBe(false);
    expect(nodeSatisfies('24.0.0', '<=24 >=24')).toBe(true);
    expect(nodeSatisfies('22.22.3', '^22.15.0')).toBeNull();
  });
});

describe('rarog update: the age gate date from what npm prints', () => {
  const NOW = Date.parse('2026-11-14T12:00:00.000Z');
  const TIME = REGISTRY_TIME;
  const wait = (time: Readonly<Record<string, string>>, days = 7, above = '0.1.0', upTo = '0.2.0'): unknown =>
    ageGateWait(timesView(time), { days, above, upTo, now: NOW });

  it('gateDaysOf: the days of min-release-age only without before; anything else is no gate to date', () => {
    expect(gateDaysOf('min-release-age=7\nbefore=null\n')).toBe(7);
    expect(gateDaysOf('min-release-age=1.5\nbefore=null')).toBe(1.5);
    for (const stdout of [
      'min-release-age=7\nbefore=Sun Nov 01 2026 01:00:00 GMT+0100\n', 'min-release-age=null\nbefore=null\n',
      'min-release-age=0\nbefore=null\n', 'min-release-age=-3\nbefore=null\n', 'min-release-age=NaN\nbefore=null\n',
      'min-release-age=seven\nbefore=null\n', 'min-release-age=\nbefore=null\n', 'min-release-age=7\n', '7\n', '',
    ]) expect(gateDaysOf(stdout), stdout).toBeNull();
  });

  it('ageGateWait: the earliest published version of >above <=upTo, its full days and its day of install (UTC)', () => {
    expect(wait(TIME)).toEqual({ version: '0.2.0', ageDays: 3, from: '2026-11-18' });
    // A version between is older than the latest: npm installs it first. Versions outside the range do not count.
    expect(wait({ ...TIME, '0.1.5': '2026-11-09T20:00:00.000Z', '0.1.0-rc.1': '2026-11-10T00:00:00.000Z',
      '0.2.0-rc.1': '2026-11-08T00:00:00.000Z', '0.3.0': '2026-11-07T00:00:00.000Z' }))
      .toEqual({ version: '0.1.5', ageDays: 4, from: '2026-11-16' });
    // A pre-release of the latest's own core is in npm's range when the latest is a pre-release.
    expect(wait({ ...TIME, '0.2.0-rc.1': '2026-11-12T00:00:00.000Z', '0.2.0-rc.2': '2026-11-13T00:00:00.000Z' }, 7,
      '0.1.0', '0.2.0-rc.2')).toEqual({ version: '0.2.0-rc.1', ageDays: 2, from: '2026-11-19' });
    // The UTC day: 23:30 UTC plus 7 days is still that day.
    expect(wait({ ...TIME, '0.2.0': '2026-11-13T23:30:00.000Z' }))
      .toEqual({ version: '0.2.0', ageDays: 0, from: '2026-11-20' });
  });

  const GATE = { days: 7, above: '0.1.0', upTo: '0.2.0', now: NOW };

  it('ageGateWait: a version npm unpublished (in time, not in versions) is no candidate', () => {
    expect(ageGateWait(timesView({ ...TIME, '0.1.5': '2026-11-09T20:00:00.000Z' }, ['0.1.5']), GATE))
      .toEqual({ version: '0.2.0', ageDays: 3, from: '2026-11-18' });
  });

  it('ageGateWait: another shape of npm\'s answer, no version in the range, or a day already past → no date', () => {
    const versions = ['0.1.0', '0.2.0'];
    for (const answer of [
      null, 'x', [timesView(TIME)], TIME, { time: TIME }, { versions }, { time: TIME, versions: '0.2.0' },
      { time: TIME, versions: ['0.1.0', 2] }, { time: [TIME], versions },
      { time: { ...TIME, '0.2.0': 1_700_000_000 }, versions }, { time: { ...TIME, '0.2.0': 'yesterday' }, versions },
      { time: { ...TIME, modified: { at: 1 } }, versions },
      // An available version of the range without a time: its day is unknown, and it may be the first one in.
      { time: TIME, versions: [...versions, '0.1.5'] },
      timesView({ created: '2026-10-01T08:00:00.000Z', '0.1.0': '2026-10-01T08:00:00.000Z' }),
      timesView({ ...TIME, '0.2.0': '2026-11-01T00:00:00.000Z' }),
      timesView({ ...TIME, '0.2.0': '2026-11-15T00:00:00.000Z' }),
    ]) expect(ageGateWait(answer, GATE), JSON.stringify(answer)).toBeNull();
  });

  it('ageGateText: day and days; the form with an installed version keeps it first', () => {
    expect(ageGateText({ version: '0.2.0', ageDays: 3, from: '2026-11-18' }))
      .toBe('rarog 0.2.0 is 3 days old; npm installs it from 2026-11-18');
    expect(ageGateText({ version: '0.2.0', ageDays: 1, from: '2026-11-20' }))
      .toBe('rarog 0.2.0 is 1 day old; npm installs it from 2026-11-20');
    expect(ageGateText({ version: '0.2.0', ageDays: 0, from: '2026-11-21' }))
      .toBe('rarog 0.2.0 is 0 days old; npm installs it from 2026-11-21');
    expect(ageGateText({ version: '0.2.0', ageDays: 3, from: '2026-11-18' }, '0.1.2'))
      .toBe('rarog 0.1.2 installed, 0.2.0 is 3 days old; npm installs it from 2026-11-18');
  });
});

describe('rarog update: the provenance npm verified', () => {
  const SHA = sha512Hex('tarball of 0.2.0');
  const expected = { version: '0.2.0', sha512: SHA };
  const report = (p: Partial<Provenance> = {}): unknown => auditReport({ version: '0.2.0', sha512: SHA, ...p });
  const problemOf = (audit: unknown): string | null => provenanceProblem(audit, expected, AUTHORITY.certificate);

  it('the release source is this repository and its publish workflow: an update after a rename would refuse every'
    + ' version', () => {
    const rootPkg = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8')) as { repository: { url: string } };
    expect(rootPkg.repository.url.replace(/^git\+/u, '').replace(/\.git$/u, '')).toBe(RELEASE_SOURCE.repository);
    expect(existsSync(path.join(REPO, RELEASE_SOURCE.workflow))).toBe(true);
    expect(releaseIdentity('1.2.3')).toBe(`${RELEASE}/${WORKFLOW}@refs/tags/v1.2.3`);
  });

  it('provenanceProblem: a match in both attestation forms; npm\'s own findings and a missing provenance refuse', () => {
    expect(problemOf(report())).toBeNull();
    expect(problemOf(report({ chain: true }))).toBeNull();
    const verified = { invalid: [], missing: [], verified: [] };
    for (const [audit, problem] of [
      [{ ...verified, invalid: [{ name: '@rarog/server' }] }, 'npm found an invalid signature or attestation of'],
      [{ ...verified, missing: [{ name: '@rarog/server' }] }, 'npm found no registry signature of'],
      [verified, '@rarog/server 0.2.0 has no verified provenance'],
      [auditReport({ version: '0.2.1', sha512: SHA }), '@rarog/server 0.2.0 has no verified provenance'],
      [null, 'npm gave no signature check result for'],
    ] as const) expect(problemOf(audit), JSON.stringify(audit)).toContain(problem);
  });

  it('provenanceProblem: the certificate decides; a second name or a control character is refused, never echoed raw',
    () => {
      expect(problemOf(report({ certificate: [identityOf('0.2.0'), 'https://example.test/x'] })))
        .toBe(`@rarog/server 0.2.0 was signed by a certificate with other names, not by ${identityOf('0.2.0')}`);
      const control = problemOf(report({ certificate: ['https://example.test/\u001b[2Jx'] }));
      expect(control).toMatch(/^@rarog\/server 0\.2\.0 was signed by \S+, not by /u);
      expect(control).not.toMatch(/[\u0000-\u001f\u007f]/u);
    expect(problemOf(report({ repository: 'https://github.com/someone/rarog',
      certificate: [identityOf('0.2.0')] })))
      .toBe(`the provenance of @rarog/server 0.2.0 names another workflow than ${identityOf('0.2.0')}`);
  });

  it('provenanceProblem: the attestation is checked here, whatever npm listed as verified', () => {
    const refused = (p: Partial<Provenance>): string | null => problemOf(report(p));
    // Without an authority given, the pinned one decides: a certificate of any other issuer is refused.
    expect(provenanceProblem(report(), expected))
      .toBe('the provenance of @rarog/server 0.2.0 has a certificate Sigstore did not issue');
    expect(refused({ authority: FOREIGN })).toContain('has a certificate Sigstore did not issue');
    expect(refused({ signature: 'forged' })).toContain('has a signature its certificate did not make');
    expect(refused({ signature: 'none' })).toContain('has a signature its certificate did not make');
    // A second piece of verification material: the signature checker and the name reader could pick different ones.
    expect(refused({ extra: 'publicKey' })).toContain('is signed with a key, not a certificate');
    expect(refused({ extra: 'otherForm' })).toContain('has no readable signing certificate');
    expect(refused({ statementType: 'https://example.test/other/v1' })).toContain('is another kind of statement');
    const twice = auditReport({ version: '0.2.0', sha512: SHA }) as { verified: { attestationBundles: unknown[] }[] };
    twice.verified[0]?.attestationBundles.push(twice.verified[0].attestationBundles[1]);
    expect(problemOf(twice)).toBe('@rarog/server 0.2.0 has more than one provenance');
  });

  it('sha512OfIntegrity: the sha512 of an SRI string beside other algorithms; anything else gives none', () => {
    expect(sha512OfIntegrity(sriOf('x'))).toBe(sha512Hex('x'));
    expect(sha512OfIntegrity(`sha1-AAAA ${sriOf('x')}`)).toBe(sha512Hex('x'));
    for (const value of ['sha256-AAAA', 'sha512-short', '', null, 5]) expect(sha512OfIntegrity(value)).toBeNull();
  });
});

/**
 * A package root under the npm prefix with this repository's files (its hook files, SDK pin and `bin/rarog.mjs`) and
 * the `package.json` of the published package: the repository's own one names the private workspace root.
 */
function repoPackageRoot(): string {
  const root = npmRoot();
  mkdirSync(root, { recursive: true });
  for (const entry of readdirSync(REPO)) {
    if (entry !== 'package.json') symlinkSync(path.join(REPO, entry), path.join(root, entry));
  }
  const manifest = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8')) as Record<string, unknown>;
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ ...manifest, name: '@rarog/server' }));
  return root;
}

/** A machine where this version is fully installed and only the statusLine script copy is from the previous one. */
async function installedWithOldScript(root: string): Promise<Buffer> {
  configured();
  copyHooks([...HOOK_INSTALL_FILES, ...STATUSLINE_INSTALL_FILES]);
  writeSettings(statuslineCommand(home), home, { denyRead: true });
  const done = await installSdk({ dataDir: dataDirOf(), env: env(), npmCli: fakeSdkNpm(), probe: () =>
    Promise.resolve({ ok: true }) });
  expect(done.ok).toBe(true);
  write(plist(), renderServicePlist({
    programArguments: [process.execPath, path.join(root, 'bin', 'rarog.mjs'), 'serve'], workingDirectory: home,
    log: path.join(dataDirOf(), 'server.log'),
  }));
  markLoaded();
  const script = STATUSLINE_INSTALL_FILES[0] ?? '';
  const dir = hookInstallDir(home);
  const old = Buffer.from('// statusLine script of the previous version\n');
  writeFileSync(path.join(dir, script), old);
  const manifestFile = path.join(dir, HOOK_MANIFEST_FILENAME);
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as { files: Record<string, string> };
  manifest.files[script] = createHash('sha256').update(old).digest('hex');
  writeFileSync(manifestFile, JSON.stringify(manifest));
  return old;
}

const scriptCopy = (): Buffer => readFileSync(path.join(hookInstallDir(home), STATUSLINE_INSTALL_FILES[0] ?? ''));
const scriptSource = (): Buffer => readFileSync(path.join(REPO, 'scripts', 'hooks', STATUSLINE_INSTALL_FILES[0] ?? ''));

describe.skipIf(!IS_MAC)(macOnly('rarog update: finishing this version and the hook copy question', 'launchd'), () => {
  it('installed = the newest on npm: no install, only the finish here, with the hook copy question', async () => {
    const root = repoPackageRoot();
    await installedWithOldScript(root);
    const npmCli = fakeRegistryNpm({ view: { version: VERSION } }, root);
    const run = await runUpdate({ root, npmCli });
    expect(run.code, run.screen).toBe(0);
    expect(npmArgs()).toEqual(['prefix -g', 'view @rarog/server@latest version engines --json']);
    expect(run.asked).toEqual(['hook']);
    expect(run.order).toEqual(['ask:hook', 'restart']);
    expect(scriptCopy()).toEqual(scriptSource());
    expect(lines(run.screen)[0]).toBe(`Rarog update ${VERSION}`);
    expect(stepLines(run.screen)[0]).toMatch(new RegExp(`^ – Download {7}rarog ${VERSION} is the latest`, 'u'));
    for (const line of lines(run.screen)) expect([...line].length, line).toBeLessThanOrEqual(60);
    expect(existsSync(lockFile())).toBe(false);
  });

  it('--finish with the lock naming this installation as just installed → the copy without a'
    + ' question', async () => {
    const root = repoPackageRoot();
    await installedWithOldScript(root);
    const body = updateLockBody({ token: TOKEN, installed: { version: VERSION, root } });
    write(lockFile(), `${String(process.ppid)}\n${body}`, 0o600);
    const run = await runUpdate({ root, argv: ['--finish'], env: env(home, { [UPDATE_LOCK_TOKEN]: TOKEN }) });
    expect(run.code, run.screen).toBe(0);
    expect(run.asked).toEqual([]);
    expect(scriptCopy()).toEqual(scriptSource());
    // The script the run wrote is the settings step's change.
    expect(updateLogs().join('')).toMatch(/\] ok {6}Settings: status line script updated/u);
  });

  it('the question stays: --finish by hand, an inherited lock without installed, installed naming another root',
    async () => {
      const root = repoPackageRoot();
      const old = await installedWithOldScript(root);
      const other = path.join(t.home, 'elsewhere', 'lib', 'node_modules', 'rarog');
      const bodies: (string | null)[] = [
        null,
        updateLockBody({ token: TOKEN, installed: null }),
        updateLockBody({ token: TOKEN, installed: { version: VERSION, root: other } }),
      ];
      for (const body of bodies) {
        if (body !== null) write(lockFile(), `${String(process.ppid)}\n${body}`, 0o600);
        const run = await runUpdate({
          root, argv: ['--finish'], answer: () => 'n',
          ...(body === null ? {} : { env: env(home, { [UPDATE_LOCK_TOKEN]: TOKEN }) }),
        });
        expect(run.asked, body ?? 'by hand').toEqual(['hook']);
        expect(scriptCopy()).toEqual(old);
      }
    });
});
