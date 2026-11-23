/**
 * The lock path of `server/src/cli/secrets-file.ts`: a process takes the Rarog lock once (`lockSecrets`) and writes
 * secret lines under that held lock (`writeSecretLine`). The lock ignores its own PID, so a nested acquire would take
 * the held lock over; here it throws instead. Every test runs in a temporary `HOME`.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireLock } from '../src/cli/lock.ts';
import { SECRET_WRITES, lockSecrets, unlockSecrets, withSecretsLock, writeSecretLine } from '../src/cli/secrets-file.ts';
import { realRarogDirsCreated, tempHome } from './rarog-home.ts';
import type { TempHome } from './rarog-home.ts';

let t: TempHome;
let env: NodeJS.ProcessEnv = {};
beforeEach(() => {
  t = tempHome('rarog-secrets-file-');
  env = { HOME: t.home };
});
afterEach(() => { t.cleanup(); });
afterAll(() => { expect(realRarogDirsCreated()).toEqual([]); });

const configDir = (): string => path.join(t.home, '.config', 'rarog');
const lockFile = (): string => path.join(configDir(), 'lock');
const secretFile = (): string => path.join(configDir(), 'secret', 'private.env');

function writeSecrets(text: string): void {
  mkdirSync(path.dirname(secretFile()), { recursive: true });
  chmodSync(configDir(), 0o700);
  chmodSync(path.dirname(secretFile()), 0o700);
  writeFileSync(secretFile(), text, { mode: 0o600 });
}

describe('secrets-file: the lock held once per process', () => {
  it('a second lockSecrets in the same process throws and leaves the first lock held', () => {
    mkdirSync(configDir(), { recursive: true, mode: 0o700 });
    const lock = lockSecrets(env, 'first');
    try {
      expect(() => lockSecrets(env, 'second')).toThrow('already holds the lock');
      expect(readFileSync(lockFile(), 'utf8')).toBe(`${String(process.pid)}\n`);
    } finally {
      unlockSecrets(lock);
    }
    expect(existsSync(lockFile())).toBe(false);
    unlockSecrets(lockSecrets(env, 'again'));
  });

  it('withSecretsLock releases the lock when its function throws', () => {
    mkdirSync(configDir(), { recursive: true, mode: 0o700 });
    expect(() => withSecretsLock(env, 'test', () => { throw new Error('boom'); })).toThrow('boom');
    expect(existsSync(lockFile())).toBe(false);
    expect(withSecretsLock(env, 'test', () => 'ran')).toBe('ran');
  });

  it('writeSecretLine under the held lock: the line appended, other lines byte for byte', () => {
    writeSecrets('# keep\r\nSONIOX_API_KEY=soniox-test');
    const saved = withSecretsLock(env, 'test', (held) => writeSecretLine(held, env, SECRET_WRITES, {
      name: 'OPENAI_API_KEY', value: 'sk-test-1', statusCommand: 'voice-agent status',
    }));
    expect(saved).toEqual({ file: secretFile(), replaced: false });
    expect(readFileSync(secretFile(), 'utf8')).toBe('# keep\r\nSONIOX_API_KEY=soniox-test\nOPENAI_API_KEY=sk-test-1\n');
  });

  it('writeSecretLine with a lock not taken through lockSecrets throws, nothing written', () => {
    writeSecrets('SONIOX_API_KEY=soniox-test\n');
    const foreign = acquireLock(configDir(), 'test');
    try {
      expect(() => writeSecretLine(foreign, env, SECRET_WRITES, {
        name: 'OPENAI_API_KEY', value: 'sk-test-1', statusCommand: 'voice-agent status',
      })).toThrow('is not the held lock');
    } finally {
      foreign.release();
    }
    expect(readFileSync(secretFile(), 'utf8')).toBe('SONIOX_API_KEY=soniox-test\n');
  });
});
