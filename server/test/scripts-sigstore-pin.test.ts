/**
 * The check of the pinned Sigstore certificate authority against Sigstore's trust root (`scripts/sigstore-pin.ts`).
 * `rarog update` refuses every provenance whose certificate another authority issued, so the check has to see a
 * new Fulcio certificate before releases are signed under it. The fixture is Sigstore's public trust root
 * (`trusted_root.json` from its TUF repository); the other cases change that file.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fulcioAuthority } from '../src/cli/update-provenance.ts';
import { testAuthority } from './helpers/fulcio-cert.ts';

const REPO = path.resolve(import.meta.dirname, '../..');
const SCRIPT = path.join(REPO, 'scripts', 'sigstore-pin.ts');
const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'sigstore-trusted-root.json');

// Modules under `scripts/` load by a dynamic import by path (they do not belong to the `server` project), so the
// types of what the test uses stand here.
type PinCheck =
  | { readonly kind: 'active'; readonly since: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'inactive' | 'moving' | 'unreadable'; readonly reason: string };
interface PinScript {
  checkPin(text: string, pin: Buffer, now: Date): PinCheck;
  main(argv: readonly string[], out: (line: string) => void, now?: Date): number;
}
const { checkPin, main } = await import(pathToFileURL(SCRIPT).href) as PinScript;

interface Authority {
  uri: string;
  certChain: { certificates: { rawBytes: string }[] };
  validFor: { start: string; end?: string };
}
interface TrustedRoot { certificateAuthorities: Authority[] }

const NOW = new Date('2026-11-24T12:00:00Z');
const PIN = fulcioAuthority();
const PIN_BASE64 = PIN.toString('base64');
const FULCIO = 'https://fulcio.sigstore.dev';

/** A fresh copy of the fixture, `change` applied to it. */
function trustedRoot(change: (root: TrustedRoot) => void = () => {}): TrustedRoot {
  const root = JSON.parse(readFileSync(FIXTURE, 'utf8')) as TrustedRoot;
  change(root);
  return root;
}

/** The fixture's authority whose chain starts with the pinned certificate. */
function pinned(root: TrustedRoot): Authority {
  const found = root.certificateAuthorities.find((ca) => ca.certChain.certificates[0]?.rawBytes === PIN_BASE64);
  if (found === undefined) throw new Error('the fixture has no authority with the pinned certificate');
  return found;
}

/** An authority of another certificate (a fresh test one) at `uri`. */
function otherAuthority(uri: string, validFor: Authority['validFor']): Authority {
  return { uri, certChain: { certificates: [{ rawBytes: testAuthority().certificate.toString('base64') }] }, validFor };
}

const check = (root: TrustedRoot | string, pin = PIN): PinCheck =>
  checkPin(typeof root === 'string' ? root : JSON.stringify(root, null, 2), pin, NOW);

describe('sigstore-pin: is the pinned certificate the authority Sigstore issues under', () => {
  it('the trust root Sigstore serves: the pinned intermediate is active, the authority that ended is ignored', () => {
    expect(check(readFileSync(FIXTURE, 'utf8'))).toEqual({ kind: 'active', since: '2022-04-13T20:06:15Z' });
  });

  it('several trust roots, one per line (gh attestation trusted-root): another instance\'s authorities are ignored',
    () => {
      const github = {
        certificateAuthorities: [otherAuthority('fulcio.githubapp.com', { start: '2026-06-12T00:00:00Z' })],
      };
      const lines = `${JSON.stringify(trustedRoot())}\n${JSON.stringify(github)}\n`;
      expect(check(lines)).toEqual({ kind: 'active', since: '2022-04-13T20:06:15Z' });
    });

  it('no authority carries the pinned certificate → missing', () => {
    const root = trustedRoot((r) => {
      r.certificateAuthorities = r.certificateAuthorities.filter((ca) => ca !== pinned(r));
    });
    expect(check(root)).toEqual({ kind: 'missing' });
  });

  it('the pinned authority ended, has not started, or its certificate expired → inactive', () => {
    expect(check(trustedRoot((r) => { pinned(r).validFor.end = '2026-11-01T00:00:00Z'; })))
      .toEqual({ kind: 'inactive', reason: 'the pinned authority ended on 2026-11-01T00:00:00Z' });
    expect(check(trustedRoot((r) => { pinned(r).validFor.start = '2027-01-01T00:00:00Z'; })))
      .toEqual({ kind: 'inactive', reason: 'the pinned authority starts on 2027-01-01T00:00:00Z' });
    // A test authority's certificate is valid for ten minutes, which end before NOW.
    const shortLived = testAuthority().certificate;
    const root = trustedRoot((r) => {
      pinned(r).certChain.certificates[0] = { rawBytes: shortLived.toString('base64') };
    });
    expect(check(root, shortLived)).toMatchObject({ kind: 'inactive', reason: expect.stringMatching(
      /^the pinned certificate expired on /u) as string });
  });

  it('Sigstore moves to another certificate: the pinned authority has an end ahead, or another authority of the'
    + ' same Fulcio starts after it → moving', () => {
    expect(check(trustedRoot((r) => { pinned(r).validFor.end = '2027-03-01T00:00:00Z'; })))
      .toEqual({ kind: 'moving', reason: 'the pinned authority ends on 2027-03-01T00:00:00Z' });
    for (const start of ['2026-10-01T00:00:00Z', '2027-02-01T00:00:00Z']) {
      const root = trustedRoot((r) => { r.certificateAuthorities.push(otherAuthority(FULCIO, { start })); });
      expect(check(root), start).toEqual({ kind: 'moving',
        reason: `another authority of ${FULCIO} starts on ${start}` });
    }
  });

  it('an authority that ended, started before the pinned one, or belongs to another Fulcio does not move it', () => {
    const root = trustedRoot((r) => {
      r.certificateAuthorities.push(
        otherAuthority(FULCIO, { start: '2023-01-01T00:00:00Z', end: '2023-06-01T00:00:00Z' }),
        otherAuthority(FULCIO, { start: '2021-01-01T00:00:00Z' }),
        otherAuthority('https://fulcio.example.test', { start: '2026-10-01T00:00:00Z' }),
      );
    });
    expect(check(root)).toEqual({ kind: 'active', since: '2022-04-13T20:06:15Z' });
  });

  it('a file that is no trust root is unreadable, never active', () => {
    for (const text of ['', 'not json', '{}', '[]', JSON.stringify({ certificateAuthorities: [] }),
      JSON.stringify({ certificateAuthorities: [{ uri: FULCIO }] }),
      JSON.stringify(trustedRoot((r) => { pinned(r).validFor.start = 'yesterday'; }))]) {
      expect(check(text).kind, text.slice(0, 80)).toBe('unreadable');
    }
  });

  it('main: exit 2 without exactly one file argument or with a file it cannot read', () => {
    const out: string[] = [];
    expect(main([], (line) => out.push(line), NOW)).toBe(2);
    expect(main([FIXTURE, FIXTURE], (line) => out.push(line), NOW)).toBe(2);
    expect(main([path.join(REPO, 'no-such-trusted-root.json')], (line) => out.push(line), NOW)).toBe(2);
    expect(out.join('\n')).toMatch(/usage: .*sigstore-pin\.ts <trusted_root\.json>/u);
  });
});

describe('sigstore-pin: the exit code of the command', () => {
  const run = (root: TrustedRoot | null): { status: number | null; output: string } => {
    let file = FIXTURE;
    if (root !== null) {
      file = path.join(mkdtempSync(path.join(tmpdir(), 'sigstore-pin-')), 'trusted_root.json');
      writeFileSync(file, JSON.stringify(root, null, 2));
    }
    const result = spawnSync(process.execPath, ['--import', 'tsx', SCRIPT, file],
      { cwd: REPO, encoding: 'utf8', timeout: 25_000 });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  };

  it('the saved trust root with the pinned authority active → 0', () => {
    const { status, output } = run(null);
    expect(status, output).toBe(0);
    expect(output).toContain('the pinned Sigstore certificate authority is active');
  });

  it('a trust root without the pinned authority → 1, and the output says what rarog update does then', () => {
    const { status, output } = run(trustedRoot((r) => {
      r.certificateAuthorities = r.certificateAuthorities.filter((ca) => ca !== pinned(r));
    }));
    expect(status, output).toBe(1);
    expect(output).toContain('rarog update refuses every release signed under another authority');
  });

  it('a trust root whose pinned authority ended → 1', () => {
    const { status, output } = run(trustedRoot((r) => { pinned(r).validFor.end = '2023-01-01T00:00:00Z'; }));
    expect(status, output).toBe(1);
    expect(output).toContain('the pinned authority ended on 2023-01-01T00:00:00Z');
  });
});
