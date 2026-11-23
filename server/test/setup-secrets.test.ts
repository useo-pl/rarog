/**
 * `rarog setup`, step 3 (`setup-secrets.ts`): a present secrets file is checked with the server's rules; with iroh
 * it only gets a missing iroh key appended, the rest byte for byte, and without the iroh module it is never changed;
 * a secrets directory that is a symlink is a problem, with no write and no service question. Runs on the shared
 * harness (`helpers/setup-harness.ts`).
 */
import { chmodSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  IROH_INTEL, KEY_LINE, configDir, home, listenHerdr, runSetup, secretFile, summaryLine, t, useSetupHarness, write,
} from './helpers/setup-harness.ts';
import { IS_MAC, macOnly } from './platform.ts';

useSetupHarness();

// ---------------------------------------------------------------------------
// Pusty dom: pytania, odpowiedzi, zapisy
// ---------------------------------------------------------------------------

describe.skipIf(!IS_MAC)(macOnly('rarog setup w pustym domu', 'launchd'), () => {
  beforeEach(async () => {
    mkdirSync(path.join(home, 'Projects'));
    await listenHerdr(path.join(home, '.config', 'herdr', 'herdr.sock'));
  });

  it('secrets file present (only SONIOX_API_KEY, no final newline): iroh key appended, the rest byte for byte', async () => {
    write(secretFile(), 'SONIOX_API_KEY=sztuczny-klucz', 0o600);
    chmodSync(path.dirname(secretFile()), 0o700);
    const run = await runSetup();
    expect(run.installs).toBe(1);
    expect(run.asked).not.toContain('key');
    const after = readFileSync(secretFile(), 'utf8');
    expect(after).toMatch(/^SONIOX_API_KEY=sztuczny-klucz\nRAROG_IROH_KEY=[0-9a-f]{64}\n$/);
    expect(statSync(secretFile()).mode & 0o777).toBe(0o600);
    expect(run.stdout).toContain(`RAROG_IROH_KEY is added to ${secretFile()}`);
    expect(summaryLine(run.stdout, 'private.env')).toMatch(/^ {2}ok {7}\/.*private\.env: present$/);
    expect(run.stdout).not.toContain('sztuczny-klucz');
    expect(run.stdout).not.toContain(KEY_LINE.exec(after)?.[1] ?? 'no key');
  });

  it('without the iroh module (Intel) the secrets file stays unchanged: checked and ok, no question', async () => {
    write(secretFile(), 'SONIOX_API_KEY=sztuczny-klucz\n', 0o600);
    chmodSync(path.dirname(secretFile()), 0o700);
    const before = readFileSync(secretFile(), 'utf8');
    const run = await runSetup({ deps: { irohModule: () => IROH_INTEL } });
    expect(run.installs).toBe(1);
    expect(readFileSync(secretFile(), 'utf8')).toBe(before);
    expect(summaryLine(run.stdout, 'private.env')).toMatch(/^ {2}ok {7}\/.*private\.env: present$/);
    expect(run.stdout).not.toContain('sztuczny-klucz');
  });

  it('katalog sekretów jako dowiązanie: PROBLEM z reguły pliku sekretów, bez zapisu i bez pytania o usługę', async () => {
    const elsewhere = path.join(t.home, 'gdzie-indziej');
    write(path.join(elsewhere, 'private.env'), 'SONIOX_API_KEY=sztuczny-klucz\n', 0o600);
    chmodSync(elsewhere, 0o700);
    mkdirSync(configDir(), { recursive: true, mode: 0o700 });
    symlinkSync(elsewhere, path.dirname(secretFile()));
    const run = await runSetup();
    expect(run.installs).toBe(0);
    expect(readdirSync(elsewhere)).toEqual(['private.env']);
    expect(summaryLine(run.stdout, '/secret')).toMatch(/PROBLEM .*\/secret: expected a directory \(symlinks and other types/);
  });
});
