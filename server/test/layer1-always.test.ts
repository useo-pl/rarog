/**
 * The "always" option of a consent channel card: `allow` with `updatedPermissions` that adds only the
 * updates of a closed list, exactly as the hook's own `permission_suggestions` carry them, shown on the card with the
 * destination they are written to.
 *
 * Closed list (`layer1/always.ts`): `addRules` with `behavior: allow` in `session` or `localSettings`, `setMode`
 * `acceptEdits` in `session`, `addDirectories` in `session`. Any other entry takes the "always" option off the card.
 * The suggestion lists come from the measured hook inputs in `fixtures/consent-dowod/` (CLI 2.1.311 and 2.1.322).
 *
 * The real registry and cycle in `$TMPDIR`; the hook as a child process: `hook-always.test.ts`.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, parseConsentAlways } from '../src/config.ts';
import { canonicalSha256 } from '../src/herdr/dialogs/hook/canon.ts';
import type { HookCallDump } from '../src/herdr/dialogs/hook/contract.ts';
import { parseHookSuggestions } from '../src/herdr/dialogs/hook/suggestions.ts';
import type { HookSuggestions } from '../src/herdr/dialogs/hook/suggestions.ts';
import {
  CONSENT_ALWAYS_VERSION, consentAlwaysEntries, consentPermissionsSha256,
} from '../src/herdr/dialogs/layer1/always.ts';
import { CONSENT_DIRNAME, CONSENT_SECRET_BYTES } from '../src/herdr/dialogs/layer1/contract.ts';
import type { ConsentCycle } from '../src/herdr/dialogs/layer1/cycle.ts';
import { readConsentRecords } from '../src/herdr/dialogs/layer1/records.ts';
import { createConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import type { ConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import { consentCardSha256, signConsentFile, verifyConsentFile } from '../src/herdr/dialogs/layer1/sign.ts';
import { createCycleWithRead } from './helpers/dowod-z-odczytem.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'consent-dowod');
const ENGINE = '77777777-7777-4777-8777-777777777777';
const PROMPT = '88888888-8888-4888-8888-888888888888';
const PROJECT = '/Users/u/Projects/atlas';
const BOOT = 'boot-always';

interface Measured {
  readonly tool_name: string;
  readonly tool_input: unknown;
  readonly permission_suggestions?: unknown;
}

function measured(name: string): Measured {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.hook.json`), 'utf8')) as Measured;
}

function suggestionsOf(name: string): HookSuggestions {
  const list = parseHookSuggestions(measured(name).permission_suggestions);
  if (list === undefined) throw new Error(`${name}: no suggestions`);
  return list;
}

const READ_RULE = '//private/tmp/folders/xx/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx/T/m5.O253cg/przebieg3/zewn/**';

describe('closed list of "always" updates (`consentAlwaysEntries`)', () => {
  it.each([
    ['read', 'Read', [{ kind: 'rule', value: `Read(${READ_RULE})`, destination: 'session' }]],
    ['webfetch', 'WebFetch', [{ kind: 'rule', value: 'WebFetch(domain:example.com)', destination: 'localSettings' }]],
    ['bash-dlugi', 'Bash', [
      { kind: 'rule', value: "Bash(node -e 'setTimeout(() => {}, 120000)')", destination: 'localSettings' },
      { kind: 'rule', value: 'Bash(echo m5-dlugi *)', destination: 'localSettings' },
    ]],
    ['edit', 'Edit', [{ kind: 'mode', value: 'acceptEdits', destination: 'session' }]],
    ['write', 'Write', [{ kind: 'mode', value: 'acceptEdits', destination: 'session' }]],
    ['bash-cd', 'Bash', [{
      kind: 'directory', value: '/private/tmp/folders/xx/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx/T/m5.O253cg/przebieg3/sesja',
      destination: 'session',
    }]],
    ['mcp', 'mcp__pomiar__echo', [{ kind: 'rule', value: 'mcp__pomiar__echo', destination: 'localSettings' }]],
  ] as const)('%s (%s): the literal updates with their destination', (name, tool, expected) => {
    expect(measured(name).tool_name).toBe(tool);
    expect(consentAlwaysEntries(tool, suggestionsOf(name))).toEqual(expected);
  });

  const rule = { toolName: 'Bash', ruleContent: 'npm test' };
  it.each([
    ['replaceRules', { type: 'replaceRules', rules: [rule], behavior: 'allow', destination: 'session' }],
    ['removeRules', { type: 'removeRules', rules: [rule], behavior: 'allow', destination: 'session' }],
    ['addRules deny', { type: 'addRules', rules: [rule], behavior: 'deny', destination: 'session' }],
    ['addRules ask', { type: 'addRules', rules: [rule], behavior: 'ask', destination: 'session' }],
    ['addRules projectSettings', { type: 'addRules', rules: [rule], behavior: 'allow', destination: 'projectSettings' }],
    ['addRules userSettings', { type: 'addRules', rules: [rule], behavior: 'allow', destination: 'userSettings' }],
    ['setMode bypassPermissions', { type: 'setMode', mode: 'bypassPermissions', destination: 'session' }],
    ['setMode default', { type: 'setMode', mode: 'default', destination: 'session' }],
    ['setMode acceptEdits localSettings', { type: 'setMode', mode: 'acceptEdits', destination: 'localSettings' }],
    ['addDirectories localSettings', { type: 'addDirectories', directories: ['/x'], destination: 'localSettings' }],
    ['removeDirectories', { type: 'removeDirectories', directories: ['/x'], destination: 'session' }],
    ['a hidden character in a rule', { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm‮test' }],
      behavior: 'allow', destination: 'session' }],
  ])('a suggestion outside the list (%s): no "always", also next to an entry on the list', (_name, entry) => {
    const good = { type: 'addRules', rules: [rule], behavior: 'allow', destination: 'localSettings' };
    expect(consentAlwaysEntries('Bash', parseHookSuggestions([entry]))).toBeNull();
    expect(consentAlwaysEntries('Bash', parseHookSuggestions([good, entry]))).toBeNull();
    expect(consentAlwaysEntries('Bash', parseHookSuggestions([good]))).not.toBeNull();
  });

  it('no list, an empty list and the plan card: no "always"', () => {
    expect(consentAlwaysEntries('Bash', undefined)).toBeNull();
    expect(consentAlwaysEntries('Bash', [])).toBeNull();
    expect(consentAlwaysEntries('ExitPlanMode', suggestionsOf('edit'))).toBeNull();
  });

  it('the digest of the updates is the canonical sha256 of the list, key order aside', () => {
    const list = suggestionsOf('webfetch');
    expect(consentPermissionsSha256(list)).toBe(canonicalSha256(measured('webfetch').permission_suggestions));
    expect(consentPermissionsSha256(list)).toBe(canonicalSha256([{
      type: 'addRules', rules: [{ toolName: 'WebFetch', ruleContent: 'domain:example.com' }], behavior: 'allow',
      destination: 'localSettings',
    }]));
  });
});

describe('answer file of "always": signature over the digest of the updates', () => {
  const secret = randomBytes(CONSENT_SECRET_BYTES).toString('hex');
  const digest = (seed: string): string => createHash('sha256').update(seed).digest('hex');
  const base = {
    key: `${PROMPT}-${'a'.repeat(32)}`, sessionId: ENGINE, decision: 'allow' as const, inputSha256: digest('in'),
    cardSha256: digest('card'), at: 1_700_000_000_000,
  };
  const expected = {
    secret, sessionId: ENGINE, key: base.key, inputSha256: base.inputSha256, cardSha256: base.cardSha256,
    notBefore: 0, permissionsSha256: digest('rules'),
  };

  it('`allow-always` carries `permissionsSha256` in the signature; another digest = `permissions`', () => {
    const file = signConsentFile(secret, { ...base, reasonId: 'allow-always', permissionsSha256: digest('rules') });
    expect(Object.keys(file).sort()).toEqual([
      'at', 'cardSha256', 'decision', 'inputSha256', 'key', 'mac', 'permissionsSha256', 'reasonId', 'sessionId',
    ]);
    expect(verifyConsentFile(file, expected)).toMatchObject({ ok: true });
    expect(verifyConsentFile(file, { ...expected, permissionsSha256: digest('other') }))
      .toEqual({ ok: false, reason: 'permissions' });
    expect(verifyConsentFile(file, { ...expected, permissionsSha256: null })).toEqual({ ok: false, reason: 'permissions' });
    // The digest is signed: swapping it breaks the signature.
    expect(verifyConsentFile({ ...file, permissionsSha256: digest('other') }, expected))
      .toEqual({ ok: false, reason: 'mac' });
  });

  it('a plain `allow` does not carry the digest; dropping the digest from `allow-always` is not a plain `allow`', () => {
    expect(() => signConsentFile(secret, { ...base, reasonId: 'allow-always' })).toThrow(TypeError);
    expect(() => signConsentFile(secret, { ...base, reasonId: 'allow', permissionsSha256: digest('rules') }))
      .toThrow(TypeError);
    const always = signConsentFile(secret, { ...base, reasonId: 'allow-always', permissionsSha256: digest('rules') });
    const { permissionsSha256: _dropped, ...stripped } = always;
    expect(verifyConsentFile(stripped, expected)).toEqual({ ok: false, reason: 'shape' });
    expect(verifyConsentFile({ ...stripped, reasonId: 'allow' }, expected)).toEqual({ ok: false, reason: 'mac' });
  });
});

describe('the "always" option in the consent cycle', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rarog-always-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function setup(options: { always?: boolean } = {}): { cycle: ConsentCycle; reg: ConsentRegistry } {
    const reg = createConsentRegistry({ bootId: BOOT, send: () => true, sessions: () => [ENGINE], log: () => {} });
    reg.setScope('main');
    const cycle = createCycleWithRead({
      dataDir: dir, bootId: BOOT, registry: reg, mode: () => 'main', always: options.always ?? true,
    });
    return { cycle, reg };
  }

  function dumpOf(seed: string, name: string, suggestions: unknown = measured(name).permission_suggestions): HookCallDump {
    const { tool_name: toolName, tool_input: toolInput } = measured(name);
    const nonce = createHash('sha256').update(seed).digest('hex').slice(0, 32);
    const startedAt = Date.now() - 1_000;
    const list = parseHookSuggestions(suggestions);
    return {
      key: `${PROMPT}-${nonce}`, sessionId: ENGINE, promptId: PROMPT, pid: process.pid, startedAt, toolName, toolInput,
      cwd: PROJECT, at: startedAt + 100, inputSha256: canonicalSha256(toolInput), permissionMode: 'default',
      ...(list === undefined ? {} : { permissionSuggestions: list }),
    };
  }

  /** Registration as the hook sends it; `alwaysVersion: null` = a hook copy from before the "always" option. */
  function register(
    reg: ConsentRegistry, dump: HookCallDump,
    options: { suggestions?: unknown; alwaysVersion?: number | null } = {},
  ): void {
    const cardSha256 = consentCardSha256({
      sessionId: dump.sessionId, toolName: dump.toolName, toolInput: dump.toolInput, cwd: dump.cwd, agentId: null,
      permissionMode: dump.permissionMode ?? null,
    });
    const suggestions = 'suggestions' in options ? options.suggestions : dump.permissionSuggestions;
    const version = options.alwaysVersion === undefined ? CONSENT_ALWAYS_VERSION : options.alwaysVersion;
    const outcome = reg.register({
      key: dump.key, sessionId: dump.sessionId, promptId: dump.promptId,
      secret: randomBytes(CONSENT_SECRET_BYTES).toString('hex'), inputSha256: dump.inputSha256, cardSha256,
      pid: dump.pid, startedAt: dump.startedAt,
      ...(suggestions === undefined ? {} : { permissionSuggestions: suggestions }),
      ...(version === null ? {} : { alwaysVersion: version }),
    });
    expect(outcome.status).toBe(200);
  }

  function answerOf(key: string): Record<string, unknown> | null {
    const file = join(dir, CONSENT_DIRNAME, ENGINE, `${key}.json`);
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> : null;
  }

  it.each(['read', 'webfetch', 'bash-dlugi', 'edit', 'write', 'bash-cd'])('%s: the card carries the updates,'
    + ' `allow-always` signs'
    + ' their digest and the record keeps every update written', async (name) => {
    const { cycle, reg } = setup();
    const dump = dumpOf(name, name);
    register(reg, dump);
    const view = await cycle.observe(ENGINE, dump.key, 'standing', dump);
    expect(view).toMatchObject({ canAllow: true, always: consentAlwaysEntries(dump.toolName, suggestionsOf(name)) });
    expect(await cycle.decide(ENGINE, dump.key, 'allow-always')).toEqual({ ok: true, state: 'sent' });
    const file = answerOf(dump.key);
    expect(file).toMatchObject({
      decision: 'allow', reasonId: 'allow-always', permissionsSha256: canonicalSha256(measured(name).permission_suggestions),
    });
    const record = readConsentRecords(dir).find((r) => r.key === dump.key);
    expect(record).toMatchObject({
      state: 'sent', decision: 'allow', reasonId: 'allow-always',
      permissions: { sha256: file?.['permissionsSha256'], updates: suggestionsOf(name) },
    });
  });

  it('a suggestion outside the list: the card has `allow` without "always"; `allow-always` = `no-always`, no file',
    async () => {
      const { cycle, reg } = setup();
      const dump = dumpOf('poza', 'bash-dlugi', [
        { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }], behavior: 'allow',
          destination: 'projectSettings' },
      ]);
      register(reg, dump);
      const view = await cycle.observe(ENGINE, dump.key, 'standing', dump);
      expect(view).toMatchObject({ canAllow: true });
      expect(view).not.toHaveProperty('always');
      expect(await cycle.decide(ENGINE, dump.key, 'allow-always')).toEqual({ ok: false, error: 'no-always', state: 'pending' });
      expect(answerOf(dump.key)).toBeNull();
    });

  it('a hook copy without "always" (registration without `alwaysVersion`): no "always", plain `allow` as before',
    async () => {
      const { cycle, reg } = setup();
      const dump = dumpOf('stary-hook', 'read');
      register(reg, dump, { alwaysVersion: null });
      const view = await cycle.observe(ENGINE, dump.key, 'standing', dump);
      expect(view).toMatchObject({ canAllow: true });
      expect(view).not.toHaveProperty('always');
      expect(await cycle.decide(ENGINE, dump.key, 'allow-always')).toMatchObject({ ok: false, error: 'no-always' });
      expect(await cycle.decide(ENGINE, dump.key, 'allow')).toEqual({ ok: true, state: 'sent' });
      const file = answerOf(dump.key);
      expect(file).toMatchObject({ decision: 'allow', reasonId: 'allow' });
      expect(file).not.toHaveProperty('permissionsSha256');
      expect(readConsentRecords(dir).find((r) => r.key === dump.key)).not.toHaveProperty('permissions');
    });

  it('an `alwaysVersion` the server does not know: the registration is refused (the hook does not wait)', () => {
    const { reg } = setup();
    const dump = dumpOf('obca-wersja', 'read');
    const cardSha256 = consentCardSha256({
      sessionId: dump.sessionId, toolName: dump.toolName, toolInput: dump.toolInput, cwd: dump.cwd, agentId: null,
      permissionMode: 'default',
    });
    expect(reg.register({
      key: dump.key, sessionId: ENGINE, promptId: PROMPT, secret: randomBytes(CONSENT_SECRET_BYTES).toString('hex'),
      inputSha256: dump.inputSha256, cardSha256, pid: dump.pid, startedAt: dump.startedAt,
      permissionSuggestions: dump.permissionSuggestions, alwaysVersion: CONSENT_ALWAYS_VERSION + 1,
    }).status).toBe(400);
  });

  it('`RAROG_CONSENT_ALWAYS=off` (cycle without "always"): no "always" on any card', async () => {
    const { cycle, reg } = setup({ always: false });
    const dump = dumpOf('flaga-off', 'webfetch');
    register(reg, dump);
    const view = await cycle.observe(ENGINE, dump.key, 'standing', dump);
    expect(view).toMatchObject({ canAllow: true });
    expect(view).not.toHaveProperty('always');
    expect(await cycle.decide(ENGINE, dump.key, 'allow-always')).toMatchObject({ ok: false, error: 'no-always' });
  });

  it('suggestions of the dump other than the registration\'s: no "always"', async () => {
    const { cycle, reg } = setup();
    const dump = dumpOf('rozjazd', 'webfetch');
    register(reg, dump, { suggestions: measured('read').permission_suggestions });
    const view = await cycle.observe(ENGINE, dump.key, 'standing', dump);
    expect(view).not.toHaveProperty('always');
  });

  it('`allow-always` without the approve button (no proof, truncated dump) = `card-changed`, as `allow`', async () => {
    const { cycle, reg } = setup();
    const blind = dumpOf('bez-dowodu', 'read');
    register(reg, blind);
    await cycle.observe(ENGINE, blind.key, 'unknown', blind);
    expect(await cycle.decide(ENGINE, blind.key, 'allow-always')).toMatchObject({ ok: false, error: 'card-changed' });
    const cut = { ...dumpOf('przyciety', 'read'), toolInput: { rarogTruncated: true, bytes: 2_000_000 } };
    register(reg, cut);
    const view = await cycle.observe(ENGINE, cut.key, 'standing', cut);
    expect(view).toMatchObject({ canAllow: false, unavailable: 'truncated' });
    expect(view).not.toHaveProperty('always');
    expect(await cycle.decide(ENGINE, cut.key, 'allow-always')).toMatchObject({ ok: false, error: 'card-changed' });
    expect([answerOf(blind.key), answerOf(cut.key)]).toEqual([null, null]);
  });
});

describe('flag `RAROG_CONSENT_ALWAYS`', () => {
  it('`on` by default, `on` and `off` with surrounding whitespace; anything else stops the start', () => {
    expect(parseConsentAlways(undefined)).toBe(true);
    expect(parseConsentAlways('')).toBe(true);
    expect(parseConsentAlways(' on ')).toBe(true);
    expect(parseConsentAlways('off')).toBe(false);
    expect(() => parseConsentAlways('1')).toThrow(ConfigError);
    expect(() => parseConsentAlways('OFF')).toThrow(ConfigError);
  });
});
