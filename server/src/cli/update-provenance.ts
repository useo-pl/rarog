/**
 * The check `rarog update` makes on the one tarball it is about to install: the file npm
 * downloaded has the registry's `dist.integrity`, npm's own signature check (`npm audit signatures`, run in an empty
 * project that names only this version) passes, and the SLSA provenance npm hands over is checked here: Sigstore's
 * certificate authority issued its signing certificate, that certificate's key signed the statement, the certificate
 * names the publish workflow of this repository at the tag of that version, and the statement names this file. npm's
 * list of verified attestations is only where the attestation comes from: a registry can put its own text there. It
 * downloads and installs nothing itself: npm runs through the runner it gets, and the caller installs the file after
 * a pass.
 */
import { X509Certificate, createHash, verify } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { RAROG_PACKAGE_NAME } from '../install/repair.ts';
import { readRegularFileSync } from '../safe-read.ts';
import { VERSION_RE } from '../version.ts';

/**
 * Where every release of the package is built: the public repository and its publish workflow. The identity Fulcio
 * writes into the certificate of that workflow's run is `<repository>/<workflow>@refs/tags/v<version>`.
 */
export const RELEASE_SOURCE = {
  repository: 'https://github.com/useo-pl/rarog',
  workflow: '.github/workflows/publish.yml',
} as const;

/** Where to report a version that fails the check (the repository's security policy). */
export const REPORT_FIX = `do not install it by hand; report it at ${RELEASE_SOURCE.repository}/security`;

/**
 * The clause of {@link attestationSigner} for a certificate the pinned authority did not issue. From here a new
 * Sigstore certificate and a forged attestation look the same, so the clause names both.
 */
export const OTHER_AUTHORITY = 'has a certificate from another authority than the pinned one: Sigstore changed its'
  + ' certificate, or the attestation is forged';

/**
 * The fix of {@link OTHER_AUTHORITY}: a version that pins Sigstore's new certificate is announced on the releases
 * page of the repository. No install command: one typed from here would install without this check.
 */
export const OTHER_AUTHORITY_FIX = `check ${RELEASE_SOURCE.repository}/releases for a release with Sigstore's new`
  + ` certificate before you install a version by hand; if there is none, report it at ${RELEASE_SOURCE.repository}`
  + '/security';

/** The predicate type of the SLSA provenance npm keeps next to a version published from a CI run. */
const PROVENANCE = 'https://slsa.dev/provenance/v1';

/** The payload type of an in-toto statement in a DSSE envelope. */
const STATEMENT_TYPE = 'application/vnd.in-toto+json';

/**
 * The certificate authority that issues the signing certificate of a GitHub Actions run: the intermediate of
 * Sigstore's public Fulcio (`O=sigstore.dev, CN=sigstore-intermediate`, valid until October 2031), DER in base64 as
 * Sigstore's trust root (`trusted_root.json`) carries it. A provenance signed under another authority is refused
 * ({@link OTHER_AUTHORITY}); `scripts/sigstore-pin.ts` tells whether Sigstore still issues under this one.
 */
const FULCIO_INTERMEDIATE = [
  'MIICGjCCAaGgAwIBAgIUALnViVfnU0brJasmRkHrn/UnfaQwCgYIKoZIzj0EAwMwKjEVMBMGA1UEChMMc2lnc3RvcmUuZGV2MREw',
  'DwYDVQQDEwhzaWdzdG9yZTAeFw0yMjA0MTMyMDA2MTVaFw0zMTEwMDUxMzU2NThaMDcxFTATBgNVBAoTDHNpZ3N0b3JlLmRldjEe',
  'MBwGA1UEAxMVc2lnc3RvcmUtaW50ZXJtZWRpYXRlMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAE8RVS/ysH+NOvuDZyPIZtilgUF9Nl',
  'arYpAd9HP1vBBH1U5CV77LSS7s0ZiH4nE7Hv7ptS6LvvR/STk798LVgMzLlJ4HeIfF3tHSaexLcYpSASr1kS0N/RgBJz/9jWCiXn',
  'o3sweTAOBgNVHQ8BAf8EBAMCAQYwEwYDVR0lBAwwCgYIKwYBBQUHAwMwEgYDVR0TAQH/BAgwBgEB/wIBADAdBgNVHQ4EFgQU39Pp',
  'z1YkEZb5qNjpKFWixi4YZD8wHwYDVR0jBBgwFoAUWMAeX5FFpWapesyQoZMi0CrFxfowCgYIKoZIzj0EAwMDZwAwZAIwPCsQK4DY',
  'iZYDPIaDi5HFKnfxXx6ASSVmERfsynYBiX2X6SJRnZU84/9DZdnFvvxmAjBOt6QpBlc4J/0DxvkTCqpclvziL6BCCPnjdlIB3Pu3',
  'BxsPmygUY7Ii2zbdCdliiow=',
].join('');

/** {@link FULCIO_INTERMEDIATE} as DER bytes: the default authority of {@link provenanceProblem}. */
export function fulcioAuthority(): Buffer {
  return Buffer.from(FULCIO_INTERMEDIATE, 'base64');
}

/** Ceiling of the tarball read for its hash. */
const TARBALL_MAX = 256 * 1024 * 1024;

/** `npm audit signatures` with the attestations npm verified, as JSON. */
export const AUDIT_ARGS = ['audit', 'signatures', '--json', '--include-attestations'] as const;

/** One npm call as the caller ran it. */
export interface NpmCall {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly interrupted: boolean;
  readonly error?: string;
}

/** `npm <args>` in `cwd` with the caller's node, npm and environment. */
export type NpmRunner = (args: readonly string[], cwd: string) => Promise<NpmCall>;

/** The certificate identity of the publish workflow's run at the tag of `version`. */
export function releaseIdentity(version: string): string {
  return `${RELEASE_SOURCE.repository}/${RELEASE_SOURCE.workflow}@refs/tags/v${version}`;
}

/** A JSON object that is not an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Text from npm or a certificate as it may go on a terminal: printable ASCII only, else a placeholder. */
function printable(text: string): string {
  return /^[\x20-\x7e]{1,200}$/u.test(text) ? text : 'an unreadable name';
}

/** The hex sha512 of an SRI string (`sha512-<base64>`, other algorithms beside it ignored); `null` without one. */
export function sha512OfIntegrity(integrity: unknown): string | null {
  if (typeof integrity !== 'string') return null;
  for (const part of integrity.trim().split(/\s+/u)) {
    const match = /^sha512-([A-Za-z0-9+/]{86}==)(?:\?.*)?$/u.exec(part);
    if (match?.[1] !== undefined) return Buffer.from(match[1], 'base64').toString('hex');
  }
  return null;
}

/** The hex sha512 of the regular file `file` (no symlink followed); `null` when it is unreadable or too large. */
export function sha512OfFile(file: string): string | null {
  try {
    const read = readRegularFileSync(file, { maxBytes: TARBALL_MAX, followSymlink: false });
    return read === null || read.truncated ? null : createHash('sha512').update(read.bytes).digest('hex');
  } catch {
    return null;
  }
}

/** The tarball `npm pack --json` wrote into `dir`. */
export interface PackedTarball {
  readonly version: string;
  readonly file: string;
}

/**
 * The tarball of {@link RAROG_PACKAGE_NAME} from `npm pack --json` output: one entry with this name, a version and a
 * plain file name; `null` for any other output.
 */
export function packedTarball(stdout: string, dir: string): PackedTarball | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) return null;
  const [entry] = parsed as unknown[];
  if (!isRecord(entry) || entry.name !== RAROG_PACKAGE_NAME) return null;
  const { version, filename } = entry;
  if (typeof version !== 'string' || !VERSION_RE.test(version)) return null;
  if (typeof filename !== 'string' || !/^[A-Za-z0-9._-]+\.tgz$/u.test(filename)) return null;
  return { version, file: path.join(dir, filename) };
}

/**
 * An npm project in `dir` that depends on exactly `version` of the package and has it "installed" as its bare
 * `package.json`: `npm audit signatures` checks the registry's signature and attestations of a name and version it
 * finds installed, so the package's dependencies need not be there.
 */
export function writeAuditProject(dir: string, version: string): void {
  writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({
    name: 'rarog-update-check', version: '0.0.0', private: true, dependencies: { [RAROG_PACKAGE_NAME]: version },
  })}\n`);
  const installed = path.join(dir, 'node_modules', ...RAROG_PACKAGE_NAME.split('/'));
  mkdirSync(installed, { recursive: true });
  writeFileSync(path.join(installed, 'package.json'), `${JSON.stringify({ name: RAROG_PACKAGE_NAME, version })}\n`);
}

/** The one signing certificate of a sigstore attestation: `certificate` (format 0.3) or the chain's first (0.2). */
function certificateOf(material: Record<string, unknown>): X509Certificate | null {
  const chain = isRecord(material.x509CertificateChain) ? material.x509CertificateChain.certificates : undefined;
  // Both forms at once is not an attestation Sigstore writes: which one signed would be a guess.
  if (material.certificate !== undefined && material.x509CertificateChain !== undefined) return null;
  const leaf: unknown = material.certificate !== undefined ? material.certificate
    : Array.isArray(chain) ? chain[0] : undefined;
  if (!isRecord(leaf) || typeof leaf.rawBytes !== 'string') return null;
  try {
    return new X509Certificate(Buffer.from(leaf.rawBytes, 'base64'));
  } catch {
    return null;
  }
}

/** Who signed an attestation and what, after {@link attestationSigner}'s checks. */
export interface AttestationSigner {
  /** The certificate's subject alternative names as Node prints them (`URI:<identity>` for a workflow run). */
  readonly names: string;
  /** The in-toto statement the certificate's key signed. */
  readonly statement: Record<string, unknown>;
}

/**
 * The signer and statement of a sigstore attestation, or what is wrong with it (a clause for a sentence). Nothing in
 * `signed` is trusted: the attestation has one signing certificate and no bare key, `authority` (DER) issued that
 * certificate, and the certificate's key made the envelope's one signature over the statement (DSSE: the signed
 * bytes are `DSSEv1 <length> <type> <length> <payload>`). The certificate's ten minutes of validity are not compared
 * with a clock: its key exists only inside the run it was issued to, and npm's check reads the transparency log.
 */
export function attestationSigner(signed: unknown, authority: Buffer): AttestationSigner | string {
  if (!isRecord(signed) || !isRecord(signed.verificationMaterial)) return 'has no signing certificate';
  if (signed.verificationMaterial.publicKey !== undefined) return 'is signed with a key, not a certificate';
  const certificate = certificateOf(signed.verificationMaterial);
  if (certificate === null) return 'has no readable signing certificate';
  const envelope = signed.dsseEnvelope;
  if (!isRecord(envelope) || envelope.payloadType !== STATEMENT_TYPE || typeof envelope.payload !== 'string'
    || !Array.isArray(envelope.signatures) || envelope.signatures.length !== 1) {
    return 'has no single signed statement';
  }
  const [signature] = envelope.signatures as unknown[];
  if (!isRecord(signature) || typeof signature.sig !== 'string') return 'has no single signed statement';
  const payload = Buffer.from(envelope.payload, 'base64');
  const signedBytes = Buffer.concat([
    Buffer.from(`DSSEv1 ${String(Buffer.byteLength(STATEMENT_TYPE))} ${STATEMENT_TYPE} ${String(payload.length)} `),
    payload,
  ]);
  try {
    const issuer = new X509Certificate(authority);
    if (!certificate.checkIssued(issuer) || !certificate.verify(issuer.publicKey)) return OTHER_AUTHORITY;
    if (!verify('sha256', signedBytes, certificate.publicKey, Buffer.from(signature.sig, 'base64'))) {
      return 'has a signature its certificate did not make';
    }
  } catch {
    return 'has a signature that cannot be checked';
  }
  try {
    const statement = JSON.parse(payload.toString('utf8')) as unknown;
    return isRecord(statement) ? { names: certificate.subjectAltName ?? '', statement } : 'has no readable statement';
  } catch {
    return 'has no readable statement';
  }
}

/** A provenance that does not match: what does not match and what to do. */
export interface ProvenanceRefusal {
  readonly summary: string;
  readonly fix: string;
}

/** What the tarball about to be installed is. */
export interface ExpectedTarball {
  readonly version: string;
  /** Hex sha512 of the downloaded file. */
  readonly sha512: string;
}

/**
 * What in the provenance npm hands over (`npm audit signatures --json --include-attestations` output) does not match
 * the tarball and the release source; `null` = it all matches. npm's own findings refuse first. Then the one SLSA
 * provenance of this version passes {@link attestationSigner} under `authority`, its certificate's only subject
 * alternative name is {@link releaseIdentity}, and the signed statement is a provenance that names this package
 * version, this file's sha512 and the same repository, workflow and tag. The certificate decides, because the
 * statement is text the signing run wrote. Every refusal has {@link REPORT_FIX}, except a certificate of another
 * authority ({@link OTHER_AUTHORITY_FIX}): that one can be a new Sigstore certificate.
 */
export function provenanceProblem(
  audit: unknown, expected: ExpectedTarball, authority = fulcioAuthority(),
): ProvenanceRefusal | null {
  const problem = (summary: string): ProvenanceRefusal => ({ summary, fix: REPORT_FIX });
  const id = `${RAROG_PACKAGE_NAME} ${expected.version}`;
  if (!isRecord(audit)) return problem(`npm gave no signature check result for ${id}`);
  const { invalid, missing, verified } = audit;
  if (Array.isArray(invalid) && invalid.length > 0) {
    return problem(`npm found an invalid signature or attestation of ${id}`);
  }
  if (Array.isArray(missing) && missing.length > 0) return problem(`npm found no registry signature of ${id}`);
  const thisVersion = (one: unknown): boolean => isRecord(one) && one.name === RAROG_PACKAGE_NAME
    && one.version === expected.version;
  const entry = Array.isArray(verified) ? verified.find(thisVersion) : undefined;
  const attestations: unknown = isRecord(entry) ? entry.attestationBundles : undefined;
  const provenances = Array.isArray(attestations)
    ? attestations.filter((one: unknown) => isRecord(one) && one.predicateType === PROVENANCE)
    : [];
  const [provenance] = provenances as unknown[];
  if (!isRecord(provenance)) return problem(`${id} has no verified provenance`);
  if (provenances.length !== 1) return problem(`${id} has more than one provenance`);
  const signer = attestationSigner(provenance.bundle, authority);
  if (signer === OTHER_AUTHORITY) return { summary: `the provenance of ${id} ${signer}`, fix: OTHER_AUTHORITY_FIX };
  if (typeof signer === 'string') return problem(`the provenance of ${id} ${signer}`);
  const identity = releaseIdentity(expected.version);
  if (signer.names !== `URI:${identity}`) {
    const single = /^URI:([^,\s]+)$/u.exec(signer.names)?.[1];
    const shown = single === undefined ? 'a certificate with other names' : printable(single);
    return problem(`${id} was signed by ${shown}, not by ${identity}`);
  }
  const { statement } = signer;
  if (statement.predicateType !== PROVENANCE) return problem(`the provenance of ${id} is another kind of statement`);
  const subjects = statement.subject;
  const purl = `pkg:npm/${RAROG_PACKAGE_NAME.replace(/^@/u, '%40')}@${expected.version}`;
  const subject = Array.isArray(subjects) && subjects.length === 1 ? subjects[0] as unknown : undefined;
  if (!isRecord(subject) || subject.name !== purl || !isRecord(subject.digest)
    || subject.digest.sha512 !== expected.sha512) {
    return problem(`the provenance of ${id} names another tarball`);
  }
  const { predicate } = statement;
  const definition = isRecord(predicate) ? predicate.buildDefinition : undefined;
  const parameters = isRecord(definition) ? definition.externalParameters : undefined;
  const workflow = isRecord(parameters) ? parameters.workflow : undefined;
  if (!isRecord(workflow) || workflow.repository !== RELEASE_SOURCE.repository
    || workflow.path !== RELEASE_SOURCE.workflow || workflow.ref !== `refs/tags/v${expected.version}`) {
    return problem(`the provenance of ${id} names another workflow than ${identity}`);
  }
  return null;
}

/** The outcome of {@link verifyTarball}. */
export type TarballCheck =
  /** The file is the attested release: install it. */
  | { readonly kind: 'verified' }
  /** npm's signature check lists no attestations (`--include-attestations` came with npm 11.12): npm is too old. */
  | { readonly kind: 'old-npm' }
  /** An npm call failed (`what` failed, npm `command`): the caller reports it like any npm failure. */
  | { readonly kind: 'npm-failed'; readonly what: string; readonly command: string; readonly result: NpmCall }
  /** The file or its provenance does not match: refused, nothing installed. */
  | { readonly kind: 'refused'; readonly summary: string; readonly fix: string };

export interface TarballCheckInput {
  readonly npm: NpmRunner;
  /** The tarball npm downloaded and its version. */
  readonly tarball: PackedTarball;
  /** An empty directory for the audit project. */
  readonly auditDir: string;
  /** npm's working directory for the registry query. */
  readonly cwd: string;
  /** One line to the run log. */
  readonly log: (text: string) => void;
  /** The certificate authority of the provenance, DER (tests give their own); default {@link fulcioAuthority}. */
  readonly authority?: Buffer;
}

/**
 * The checks before the install of `tarball`: its sha512 against `dist.integrity` of `npm view`, then npm's signature
 * check of that version and the provenance ({@link provenanceProblem}).
 */
export async function verifyTarball(input: TarballCheckInput): Promise<TarballCheck> {
  const { version, file } = input.tarball;
  const id = `${RAROG_PACKAGE_NAME} ${version}`;
  const dist = await input.npm(['view', `${RAROG_PACKAGE_NAME}@${version}`, 'dist', '--json'], input.cwd);
  if (dist.code !== 0 || dist.interrupted) {
    return { kind: 'npm-failed', what: 'registry check', command: 'view', result: dist };
  }
  let integrity: unknown;
  try {
    const parsed = JSON.parse(dist.stdout) as unknown;
    integrity = isRecord(parsed) ? parsed.integrity : undefined;
  } catch {
    integrity = undefined;
  }
  const registry = sha512OfIntegrity(integrity);
  if (registry === null) return { kind: 'refused', summary: `npm gave no sha512 integrity of ${id}`, fix: REPORT_FIX };
  const sha512 = sha512OfFile(file);
  if (sha512 !== registry) {
    const summary = `the tarball of ${id} differs from the registry's dist.integrity`;
    return { kind: 'refused', summary, fix: REPORT_FIX };
  }
  input.log(`  npm: ${id} tarball sha512 matches dist.integrity`);
  writeAuditProject(input.auditDir, version);
  const audit = await input.npm(AUDIT_ARGS, input.auditDir);
  for (const text of audit.stderr.split('\n')) if (text.trim() !== '') input.log(`  npm: ${text.trimEnd()}`);
  let report: unknown;
  try {
    report = JSON.parse(audit.stdout) as unknown;
  } catch {
    report = null;
  }
  // npm exits 1 both when it could not check and when it found an invalid or a missing signature; its findings are
  // the package's problem and not the network's, so they are read before the exit code.
  const found = isRecord(report)
    && [report.invalid, report.missing].some((list) => Array.isArray(list) && list.length > 0);
  if (audit.interrupted || (audit.code !== 0 && !found)) {
    return { kind: 'npm-failed', what: 'signature check', command: 'audit signatures', result: audit };
  }
  // npm before 11.12 ignores `--include-attestations` and prints only `invalid` and `missing`: the tool is too old,
  // which says nothing about the package.
  if (isRecord(report) && !found && !Array.isArray(report.verified)) return { kind: 'old-npm' };
  const refusal = provenanceProblem(report, { version, sha512 }, input.authority);
  if (refusal !== null) return { kind: 'refused', ...refusal };
  input.log(`  npm: ${id} provenance verified: ${releaseIdentity(version)}`);
  return { kind: 'verified' };
}
