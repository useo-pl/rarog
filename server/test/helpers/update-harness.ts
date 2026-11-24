/**
 * The npm registry fake and the runner of the `rarog update` tests: a fake `npm-cli.js` that answers the calls of
 * the Download step from a state file and logs every call, the installation it updates, the fake new version that
 * records how it was started, and `runUpdate`, which runs the command in the test process on a 60-column terminal.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CliIo, CliTerminal } from '../../src/cli/io.ts';
import { UPDATE_LOCK_FILENAME, UPDATE_LOCK_TOKEN } from '../../src/cli/update-lock.ts';
import { updateCommand } from '../../src/cli/update.ts';
import type { UpdateDeps } from '../../src/cli/update.ts';
import { installSdk } from '../../src/install/sdk.ts';
import {
  CHECK_TIMEOUT_MS, bin, configDir, dataDirOf, env, home, port, questionOf, t, write, writeConfig,
} from './setup-harness.ts';
import type { Question } from './setup-harness.ts';
import { testAuthority } from './fulcio-cert.ts';
import type { TestAuthority } from './fulcio-cert.ts';

export const TTY_60: CliTerminal = { tty: true, columns: 60, color: false };

/** The screen as a person sees it: escape sequences removed, every redraw (`\r`) keeps only what comes after it. */
export function visible(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]/gu, '').split('\n').map((line) => line.split('\r').at(-1) ?? '')
    .join('\n');
}

export const lines = (screen: string): string[] => screen.replace(/\n$/u, '').split('\n');

/**
 * The screen with its wrapped lines joined: one space for every run of spaces, line ends and indents. A step that
 * takes 1 s or more on a loaded machine prints its time (`3 s`, `1 min 5 s`) in the step line's right column, which
 * lands inside the wrapped detail once the lines are joined, so the time drops out; no expected text holds one.
 */
export const flat = (screen: string): string => screen.replace(/\s+/gu, ' ').replace(/ (?:\d+ min )?\d+ s(?= )/gu, '');

/** The text of the run logs of `rarog update` in the test data directory. */
export function updateLogs(): string[] {
  const dir = path.join(dataDirOf(), 'logs');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.startsWith('update-')).sort()
    .map((name) => readFileSync(path.join(dir, name), 'utf8'));
}

/** The npm prefix of the fake registry tests and the package root under it. */
export const prefix = (): string => path.join(t.home, 'prefix');
export const npmRoot = (): string => path.join(prefix(), 'lib', 'node_modules', '@rarog', 'server');

/** Where the fake new version records how it was started (`null` = it never ran). */
export const startRecord = (): string => path.join(t.home, 'new-version-started.json');
export const oldRecord = (): string => path.join(t.home, 'old-version-started.json');

/** A `bin/rarog.mjs` that records its start (argv, node, token, the update lock at that moment) and exits `code`. */
export function recordingBin(record: string, code = 0): string {
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
export function npmInstallation(version = '0.1.0', root = npmRoot(), name: string | null = '@rarog/server'): string {
  write(path.join(root, 'package.json'), JSON.stringify(name === null ? { version } : { name, version }));
  write(path.join(root, 'bin', 'rarog.mjs'), recordingBin(oldRecord()));
  return root;
}

/** A version on the fake registry: the manifest fields `npm view @rarog/server@<version>` prints besides `version`. */
export interface RegistryVersion {
  readonly engines?: unknown;
  /** npm's deprecation message; absent = not deprecated (npm prints the field only when it is set). */
  readonly deprecated?: string;
}

export interface RegistryState {
  /** What `npm prefix -g` prints (default: {@link prefix}). */
  readonly prefix?: string;
  /**
   * The `npm view @rarog/server@latest … --json` object; `null` = offline (exit 1 with an npm error). Default: the
   * version of `dist-tags.latest` with its fields when {@link versions} is given, `{ version: '0.2.0' }` otherwise.
   */
  readonly view?: Record<string, unknown> | null;
  /**
   * The versions on the registry. With them `npm pack` picks the version of its spec by npm's rule (see
   * {@link fakeRegistryNpm}), every version has its own tarball, `dist.integrity` and matching provenance, and
   * `npm i -g` without {@link install} lays out the version of the tarball it gets.
   */
  readonly versions?: Readonly<Record<string, RegistryVersion>>;
  /** What `npm view @rarog/server dist-tags --json` prints (default `{ latest: <version of view> }`). */
  readonly distTags?: Readonly<Record<string, string>>;
  /** Versions npm's release age gate holds back: `npm pack` of a spec passes over them (with {@link versions}). */
  readonly held?: readonly string[];
  /**
   * The version `npm pack` downloads whatever its spec (default: the pick from {@link versions}, without them the one
   * of {@link view}) and the tarball's bytes (default: `tarball of <version>`).
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
export const HELD: RegistryState = { packCode: 1, packStderr: 'npm error code ETARGET\n' };

/** The repository and workflow every release is built by (`RELEASE_SOURCE` of `update-provenance.ts`). */
export const RELEASE = 'https://github.com/useo-pl/rarog';
export const WORKFLOW = '.github/workflows/publish.yml';
export const identityOf = (version: string, repository = RELEASE): string => `${repository}/${WORKFLOW}@refs/tags/v${version}`;
export const sha512Hex = (text: string): string => createHash('sha512').update(text).digest('hex');
export const sriOf = (text: string): string => `sha512-${createHash('sha512').update(text).digest('base64')}`;

/** The authority the tests' releases are signed under, in place of Sigstore's; {@link FOREIGN} is anyone else's. */
export const AUTHORITY = testAuthority();
export const FOREIGN = testAuthority();

export interface Provenance {
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
export function provenanceAttestation(p: Provenance): unknown {
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
export function auditReport(p: Provenance | null, version = p?.version ?? '0.2.0'): unknown {
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
export const hangMarker = (): string => path.join(t.home, 'npm-registry', 'npm-hang');

/** Registry publication times: 0.1.0 long ago, 0.2.0 three days and a few hours before `NOW` of the age tests. */
export const REGISTRY_TIME: Readonly<Record<string, string>> = {
  created: '2026-10-01T08:00:00.000Z', modified: '2026-11-11T09:30:00.000Z',
  '0.1.0': '2026-10-01T08:00:00.000Z', '0.2.0': '2026-11-11T09:30:00.000Z',
};

/**
 * What `npm view @rarog/server time versions --json` prints: `time` and the versions on the registry, which are every
 * version of `time` except `unpublished` (npm unpublish keeps the time and removes the version).
 */
export function timesView(time: Readonly<Record<string, string>>, unpublished: readonly string[] = []): unknown {
  const versions = Object.keys(time).filter((key) => !['created', 'modified', ...unpublished].includes(key));
  return { time, versions };
}

/**
 * How the fake picks the version of an `npm pack` spec from `state.registry` (plain JS inside the fake): the versions
 * of the spec that the age gate does not hold back, a version without deprecation first, then the highest.
 */
const FAKE_PICK = String.raw`
const parse = (v) => {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v);
  return m === null ? null : { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] === undefined ? [] : m[4].split('.') };
};
const order = (a, b) => {
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i += 1) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i];
  if (x.pre.length === 0 || y.pre.length === 0) return (x.pre.length === 0 ? 1 : 0) - (y.pre.length === 0 ? 1 : 0);
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i += 1) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
};
const satisfies = (v, spec) => {
  const parts = spec.trim().split(/\s+/).map((part) => /^(>=|<=|>|<|=)?(.+)$/.exec(part));
  const ok = parts.every(([, op, bound]) => {
    const o = order(v, bound);
    return op === '>' ? o > 0 : op === '>=' ? o >= 0 : op === '<' ? o < 0 : op === '<=' ? o <= 0 : o === 0;
  });
  if (!ok || parse(v).pre.length === 0) return ok;
  return parts.some(([, , bound]) => parse(bound).pre.length > 0 && parse(bound).core.join('.') === parse(v).core.join('.'));
};
const deprecated = (v) => (state.registry[v].manifest.deprecated === undefined ? 0 : 1);
const pick = (spec) => Object.keys(state.registry).filter((v) => !state.held.includes(v) && satisfies(v, spec))
  .sort((a, b) => deprecated(a) - deprecated(b) || order(b, a))[0] ?? null;
`;

/**
 * Fake `npm-cli.js` of the registry tests; every call is logged with its node and its `npm_config_*` variables to
 * `npm-calls`.
 *
 * With {@link RegistryState.versions} it answers as npm 11.20.0 did against the public registry, for a package with
 * stable versions and pre-releases of a later `X.Y.Z`:
 * - `npm view <name> dist-tags --json` prints one object, tag → version;
 * - `npm view '<name>@>A <=B' version --json` lists a pre-release of the range only when a bound is a pre-release of
 *   the same `X.Y.Z` (`>A <=X.Y.Z` lists `X.Y.Z` alone, `>X.Y.Z-beta.0 <=X.Y.Z` also every `X.Y.Z-beta.N` and `-rc.N`);
 * - `npm pack '<name>@<range>' --before <date>` picks one version: the highest of the range published before the date,
 *   by the same pre-release rule; none is `ETARGET`, and so is an exact version published after the date;
 * - `npm view <name>@<version> version engines deprecated --json` has `deprecated` only for a deprecated version.
 * That a version without deprecation goes first is the sort order of npm-pick-manifest (npm's version picker), not a
 * measurement.
 */
export function fakeRegistryNpm(state: RegistryState, root = npmRoot()): string {
  const dir = path.join(t.home, 'npm-registry');
  const file = path.join(dir, 'npm-cli.js');
  mkdirSync(dir, { recursive: true });
  const versions = state.versions ?? null;
  const latestTag = state.distTags?.latest;
  const latestFields = latestTag === undefined ? undefined : versions?.[latestTag];
  const view = state.view !== undefined ? state.view : versions !== null && latestTag !== undefined
    ? { version: latestTag, ...(latestFields?.engines === undefined ? {} : { engines: latestFields.engines }) }
    : { version: '0.2.0' };
  // Each version of the registry has its own tarball, integrity and provenance; a fixed pack keeps the old answers.
  const registry = versions === null ? null : Object.fromEntries(Object.entries(versions).map(([version, fields]) => {
    const bytes = `tarball of ${version}`;
    return [version, { manifest: { version, ...fields }, bytes, dist: { integrity: sriOf(bytes) },
      audit: auditReport({ version, sha512: sha512Hex(bytes) }) }];
  }));
  const packVersion = state.pack?.version
    ?? (registry !== null ? null : typeof view?.version === 'string' ? view.version : '0.2.0');
  const packBytes = packVersion === null ? null : state.pack?.bytes ?? `tarball of ${packVersion}`;
  writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    prefix: state.prefix ?? prefix(), view, registry, held: state.held ?? [],
    distTags: state.distTags ?? (typeof view?.version === 'string' ? { latest: view.version } : {}),
    packVersion, packBytes, packCode: state.packCode ?? 0, packStderr: state.packStderr ?? 'npm error code E500\n',
    dist: state.distIntegrity === null ? null : state.distIntegrity !== undefined ? { integrity: state.distIntegrity }
      : packBytes === null ? 'by-version' : { integrity: sriOf(packBytes) },
    audit: state.audit !== undefined ? state.audit : packBytes === null || packVersion === null ? 'by-version'
      : auditReport({ version: packVersion, sha512: sha512Hex(packBytes) }),
    auditCode: state.auditCode ?? 0,
    install: state.install ?? null, installCode: state.installCode ?? 0, installBin: recordingBin(startRecord()),
    installStderr: state.installStderr ?? 'npm error code E500\n', root,
    gateConfig: state.gateConfig ?? null, times: state.times === undefined ? null : state.times,
    hang: state.hang ?? null,
  }));
  writeFileSync(file, [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const state = JSON.parse(fs.readFileSync(path.join(__dirname, 'state.json'), 'utf8'));",
    'const args = process.argv.slice(2);',
    FAKE_PICK,
    "const versionOf = (spec) => (spec ?? '').slice('@rarog/server@'.length);",
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
    '  const spec = versionOf(args[1]);',
    '  const version = state.packVersion ?? pick(spec);',
    '  if (version === null) {',
    "    process.stderr.write('npm error code ETARGET\\nnpm error notarget No matching version found for '",
    "      + args[1] + '.\\n');",
    '    process.exit(1);',
    '  }',
    "  const filename = 'rarog-server-' + version + '.tgz';",
    "  fs.writeFileSync(path.join(args[args.indexOf('--pack-destination') + 1], filename),",
    '    state.packBytes ?? state.registry[version].bytes);',
    "  process.stdout.write(JSON.stringify([{ id: '@rarog/server@' + version, name: '@rarog/server',",
    "    version, filename, files: [] }], null, 2) + '\\n');",
    '  process.exit(0);',
    "} else if (args[0] === 'view' && args.includes('dist')) {",
    "  const dist = state.dist === 'by-version' ? state.registry[versionOf(args[1])]?.dist ?? null : state.dist;",
    "  if (dist === null) { process.stderr.write('npm error code ENOTFOUND\\n'); process.exit(1); }",
    "  process.stdout.write(JSON.stringify(dist, null, 2) + '\\n');",
    '  process.exit(0);',
    "} else if (args[0] === 'audit') {",
    "  if (state.auditCode !== 0) { process.stderr.write('npm error Failed to download\\n'); process.exit(state.auditCode); }",
    "  const audit = state.audit === 'by-version' ? state.registry[seen.project.dependencies['@rarog/server']].audit",
    '    : state.audit;',
    "  process.stdout.write(JSON.stringify(audit, null, 2) + '\\n');",
    // Like npm: an invalid or a missing signature is exit 1 with the same JSON.
    '  process.exit((audit.invalid ?? []).length + (audit.missing ?? []).length > 0 ? 1 : 0);',
    "} else if (args[0] === 'view' && args[1] === '@rarog/server' && args.includes('dist-tags')) {",
    "  process.stdout.write(JSON.stringify(state.distTags, null, 2) + '\\n');",
    '  process.exit(0);',
    "} else if (args[0] === 'view' && state.registry !== null && versionOf(args[1]) !== 'latest') {",
    '  const found = state.registry[versionOf(args[1])];',
    "  if (found === undefined) { process.stderr.write('npm error code E404\\n'); process.exit(1); }",
    "  process.stdout.write(JSON.stringify(found.manifest, null, 2) + '\\n');",
    '  process.exit(0);',
    "} else if (args[0] === 'view') {",
    "  if (state.view === null) {",
    "    process.stderr.write('npm error code ENOTFOUND\\n');",
    '    process.exit(1);',
    '  }',
    "  process.stdout.write(JSON.stringify(state.view, null, 2) + '\\n');",
    '  process.exit(0);',
    "} else if (args[0] === 'i') {",
    '  if (state.installCode !== 0) { process.stderr.write(state.installStderr); process.exit(state.installCode); }',
    "  const got = path.basename(args[args.length - 1]).replace(/^rarog-server-/, '').replace(/\\.tgz$/, '');",
    '  const laid = state.install ?? (state.registry === null ? {} : {',
    "    'package.json': JSON.stringify({ name: '@rarog/server', version: got }), 'bin/rarog.mjs': state.installBin,",
    '  });',
    '  for (const [name, text] of Object.entries(laid)) {',
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

export interface NpmCall {
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

export const npmCalls = (): NpmCall[] => {
  const file = path.join(t.home, 'npm-registry', 'npm-calls');
  return existsSync(file)
    ? readFileSync(file, 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as NpmCall)
    : [];
};

export const npmArgs = (): string[] => npmCalls().map((call) => call.args.join(' '));

/** The update's temporary directory: `npm pack` downloads into its `tarball/` ('' = no pack call). */
export const workDir = (): string => {
  const pack = npmCalls().find((call) => call.args[0] === 'pack');
  return pack === undefined ? '' : path.dirname(pack.args[pack.args.indexOf('--pack-destination') + 1] ?? '');
};

/** The new version 0.2.0 as `npm i -g` lays it out: its `package.json` and a recording `bin/rarog.mjs`. */
export const newVersion = (version = '0.2.0', code = 0): Record<string, string> => ({
  'package.json': JSON.stringify({ name: '@rarog/server', version }),
  'bin/rarog.mjs': recordingBin(startRecord(), code),
});

export interface Started {
  readonly argv: string[];
  readonly node: string;
  readonly token: string | null;
  readonly lock: string | null;
}

export const started = (file = startRecord()): Started | null =>
  (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Started : null);

/** `config.json` of an installed machine, so the command has an installation to update. */
export function configured(): void {
  writeConfig({ RAROG_ORIGINS: 'https://rarog.example.net', RAROG_PORT: String(port) });
}

export interface UpdateRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly screen: string;
  readonly asked: Question[];
  readonly order: string[];
}

export interface UpdateOptions {
  readonly root: string;
  readonly argv?: readonly string[];
  /** `null` = no terminal. */
  readonly answer?: ((question: Question) => string) | null;
  readonly env?: NodeJS.ProcessEnv;
  readonly npmCli?: string;
  readonly deps?: Partial<UpdateDeps>;
}

/** `rarog update …` in the test process on a 60-column terminal; the answer to every question is "y". */
export async function runUpdate(options: UpdateOptions): Promise<UpdateRun> {
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
export function fakeSdkNpm(): string {
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
export const stepLines = (screen: string): string[] => lines(screen)
  .filter((line) => /^ [✓✗!–] \S/u.test(line) && !line.includes('In a new terminal'));

export const lockFile = (): string => path.join(configDir(), UPDATE_LOCK_FILENAME);
