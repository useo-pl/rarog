/**
 * `permission_suggestions` of a `PermissionRequest` as data of the consent channel: the hook carries the stdin
 * value up to 16 KiB in the registration and the per-call dump; the server keeps it only as a whole list of documented
 * entries (`hook/suggestions.ts`), otherwise as no suggestions, and puts it on the card without changing `canAllow`.
 * An MCP tool with an empty list gets the marker, and its card has no allow button.
 *
 * The stdin lists come from the measured hook inputs in `fixtures/consent-dowod/` (CLI 2.1.311 and 2.1.322). The hook
 * runs as a child process against the real registry, cycle and socket (`helpers/hook-kanal.ts`).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../src/herdr/dialogs/hook/canon.ts';
import { HOOK_SHADOW_LOG_FILENAME } from '../src/herdr/dialogs/hook/contract.ts';
import type { HookCallDump } from '../src/herdr/dialogs/hook/contract.ts';
import {
  HOOK_SUGGESTIONS_MAX_BYTES, HOOK_SUGGESTIONS_MAX_ENTRIES, mcpEmptySuggestions, parseHookSuggestions,
} from '../src/herdr/dialogs/hook/suggestions.ts';
import type { HookSuggestions } from '../src/herdr/dialogs/hook/suggestions.ts';
import { consentCardVerdict } from '../src/herdr/dialogs/layer1/card.ts';
import { CONSENT_REGISTER_BODY_MAX_BYTES } from '../src/herdr/dialogs/layer1/contract.ts';
import { createConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import type { ConsentRegistry, ConsentRegistryEntry } from '../src/herdr/dialogs/layer1/registry.ts';
import { consentCardSha256 } from '../src/herdr/dialogs/layer1/sign.ts';
import { scanCallDumps } from '../src/herdr/dialogs/shadow/files.ts';
import {
  HOOK_PROMPT, HOOK_SESSION, hookExit, hookScene, readHookLog, removeHookDirs, startHook, stopHookRuns, until,
} from './helpers/hook-kanal.ts';
import type { HookScene } from './helpers/hook-kanal.ts';

const TIMEOUT = 15_000;
const FIXTURES = join(import.meta.dirname, 'fixtures', 'consent-dowod');
const ALLOW = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };

afterEach(stopHookRuns);
afterAll(removeHookDirs);

interface Stdin {
  readonly tool_name: string;
  readonly tool_input: unknown;
  readonly permission_suggestions?: unknown;
}

const stdinOf = (name: string): Stdin => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as Stdin;
const MEASURED = readdirSync(FIXTURES).filter((name) => name.endsWith('.hook.json')).sort();
const suggestionsOf = (name: string): HookSuggestions => stdinOf(name).permission_suggestions as HookSuggestions;

const RULE = {
  type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }], behavior: 'allow', destination: 'session',
};
const MODE = { type: 'setMode', mode: 'acceptEdits', destination: 'session' };

describe('`parseHookSuggestions`: a whole list of documented entries, anything else is no suggestions', () => {
  it('every measured stdin list is kept exactly as Claude Code sent it; without the field there is none', () => {
    expect(MEASURED.length).toBeGreaterThan(20);
    const kinds = new Set<string>();
    for (const name of MEASURED) {
      const raw = stdinOf(name).permission_suggestions;
      const parsed = parseHookSuggestions(raw);
      expect(parsed, name).toEqual(raw);
      for (const entry of parsed ?? []) kinds.add(entry.type);
    }
    expect([...kinds].sort()).toEqual(['addDirectories', 'addRules', 'setMode']);
  });

  it.each<[string, unknown]>([
    ['an empty list', []],
    ['a rule without `ruleContent` (a whole MCP tool)', [{ ...RULE, rules: [{ toolName: 'mcp__srv__tool' }] }]],
    ['the documented shapes outside the measured ones', [
      { ...RULE, type: 'replaceRules', behavior: 'deny', destination: 'projectSettings' },
      { ...MODE, mode: 'bypassPermissions', destination: 'userSettings' },
      { type: 'removeDirectories', directories: ['/srv/data'], destination: 'localSettings' },
    ]],
    [`${String(HOOK_SUGGESTIONS_MAX_ENTRIES)} entries`,
      Array.from({ length: HOOK_SUGGESTIONS_MAX_ENTRIES }, () => MODE)],
  ])('kept: %s', (_name, raw) => {
    expect(parseHookSuggestions(raw)).toEqual(raw);
  });

  it.each<[string, unknown]>([
    ['`null`', null],
    ['an object', { rarogTruncated: true }],
    ['a string', 'addRules'],
    ['an entry with a field the server does not know', [RULE, { ...MODE, extra: 1 }]],
    ['an entry of an unknown type, next to a good one', [{ type: 'grantAll', destination: 'session' }, MODE]],
    ['a destination outside the list', [{ ...MODE, destination: 'policySettings' }]],
    ['a tool name that is no identifier', [{ ...RULE, rules: [{ toolName: 'Bash; rm' }] }]],
    ['17 rules in one entry', [{ ...RULE, rules: Array.from({ length: 17 }, () => ({ toolName: 'Bash' })) }]],
    ['an empty directory list', [{ type: 'addDirectories', directories: [], destination: 'session' }]],
    [`${String(HOOK_SUGGESTIONS_MAX_ENTRIES + 1)} entries`,
      Array.from({ length: HOOK_SUGGESTIONS_MAX_ENTRIES + 1 }, () => MODE)],
    ['a list over the byte ceiling',
      [{ ...RULE, rules: [{ toolName: 'Bash', ruleContent: 'x'.repeat(HOOK_SUGGESTIONS_MAX_BYTES) }] }]],
  ])('dropped: %s', (_name, raw) => {
    expect(parseHookSuggestions(raw)).toBeUndefined();
  });
});

/** What this test uses from the hook's module (JS without types). */
interface HookConsent {
  readonly SUGGESTIONS_MAX_BYTES: number;
  carriedSuggestions(value: unknown): unknown;
}
const HOOK_CONSENT = join(import.meta.dirname, '..', '..', 'scripts', 'hooks', 'consent.mjs');
const hookConsent = async (): Promise<HookConsent> => (await import(pathToFileURL(HOOK_CONSENT).href)) as HookConsent;

describe('`carriedSuggestions` in the hook: the stdin value up to the ceiling, nothing above it', () => {
  it('the hook\'s ceiling is the server\'s', async () => {
    expect((await hookConsent()).SUGGESTIONS_MAX_BYTES).toBe(HOOK_SUGGESTIONS_MAX_BYTES);
  });

  it.each<[string, unknown, unknown]>([
    ['no field', undefined, undefined],
    ['the measured list as it is', suggestionsOf('read.hook.json'), suggestionsOf('read.hook.json')],
    ['any value under the ceiling (the server checks it)', { not: 'a list' }, { not: 'a list' }],
    ['a list over the ceiling',
      [{ ...RULE, rules: [{ toolName: 'Bash', ruleContent: 'x'.repeat(HOOK_SUGGESTIONS_MAX_BYTES) }] }], undefined],
  ])('%s', async (_name, value, expected) => {
    expect((await hookConsent()).carriedSuggestions(value)).toEqual(expected);
  });
});

describe('MCP marker: a raw fact, an MCP tool with an empty list', () => {
  it.each<[string, string, unknown, boolean]>([
    ['measured MCP with `requiresUserInteraction` (`[]`)', 'mcp__pomiar__echo_osobiscie',
      stdinOf('mcp-osobiscie.hook.json').permission_suggestions, true],
    ['measured plain MCP (a rule for the tool)', 'mcp__pomiar__echo', stdinOf('mcp.hook.json').permission_suggestions,
      false],
    ['`Bash` with `[]`', 'Bash', [], false],
    ['MCP without the field', 'mcp__srv__tool', undefined, false],
    ['MCP with a dropped value', 'mcp__srv__tool', { rarogTruncated: true }, false],
    ['MCP with a list of bad entries', 'mcp__srv__tool', [{ type: 'grantAll' }], false],
  ])('%s → %s', (_name, toolName, raw, expected) => {
    expect(mcpEmptySuggestions(toolName, parseHookSuggestions(raw))).toBe(expected);
  });
});

describe('card verdict: suggestions are data, the MCP marker takes the allow button away', () => {
  const KEY = `${HOOK_PROMPT}-${'a'.repeat(32)}`;

  function dumpOf(toolName: string, toolInput: unknown, raw: unknown): HookCallDump {
    const suggestions = parseHookSuggestions(raw);
    return {
      key: KEY, sessionId: HOOK_SESSION, promptId: HOOK_PROMPT, pid: 4242, startedAt: 1_000, permissionMode: 'default',
      toolName, toolInput, cwd: '/srv/projekt', at: 2_000, inputSha256: canonicalSha256(toolInput),
      ...(suggestions === undefined ? {} : { permissionSuggestions: suggestions }),
      ...(mcpEmptySuggestions(toolName, suggestions) ? { mcpEmptySuggestions: true as const } : {}),
    };
  }

  function verdictOf(dump: HookCallDump): ReturnType<typeof consentCardVerdict> {
    const registration: ConsentRegistryEntry = {
      key: dump.key, sessionId: dump.sessionId, promptId: dump.promptId, inputSha256: dump.inputSha256,
      cardSha256: consentCardSha256({
        sessionId: dump.sessionId, toolName: dump.toolName, toolInput: dump.toolInput, cwd: dump.cwd, agentId: null,
        permissionMode: 'default',
      }),
      pid: dump.pid, startedAt: dump.startedAt, acceptedAt: 1_500, blocked: false,
    };
    return consentCardVerdict({ dump, registration, signable: true, scope: 'main', standing: 'standing' });
  }

  it('`Bash` with the measured rule: the card carries it, `canAllow` as without it', () => {
    const stdin = stdinOf('bash-dlugi.hook.json');
    const without = verdictOf(dumpOf('Bash', stdin.tool_input, undefined));
    const carried = verdictOf(dumpOf('Bash', stdin.tool_input, stdin.permission_suggestions));
    expect(without).toMatchObject({ canAllow: true, unavailable: null });
    expect(without).not.toHaveProperty('permissionSuggestions');
    expect(carried).toEqual({ ...without, permissionSuggestions: stdin.permission_suggestions });
  });

  it('a dropped list: the card as without suggestions', () => {
    const toolInput = { command: 'npm test' };
    expect(verdictOf(dumpOf('Bash', toolInput, [{ ...MODE, extra: 1 }])))
      .toEqual(verdictOf(dumpOf('Bash', toolInput, undefined)));
  });

  it('measured MCP with `[]`: the marker, no allow button (`no-proof`), deny and release stay', () => {
    const stdin = stdinOf('mcp-osobiscie.hook.json');
    const dump = dumpOf(stdin.tool_name, stdin.tool_input, stdin.permission_suggestions);
    expect(dump.mcpEmptySuggestions).toBe(true);
    expect(verdictOf(dump)).toMatchObject({
      canAllow: false, unavailable: 'no-proof', canSign: true, permissionSuggestions: [],
    });
    expect(verdictOf(dumpOf(stdin.tool_name, stdin.tool_input, undefined))).toMatchObject({ canAllow: true });
  });

  it('measured MCP with a rule: no marker, the card as without suggestions', () => {
    const stdin = stdinOf('mcp.hook.json');
    const dump = dumpOf(stdin.tool_name, stdin.tool_input, stdin.permission_suggestions);
    expect(dump).not.toHaveProperty('mcpEmptySuggestions');
    const { permissionSuggestions, ...rest } = verdictOf(dump);
    expect(permissionSuggestions).toEqual(stdin.permission_suggestions);
    expect(rest).toEqual(verdictOf(dumpOf(stdin.tool_name, stdin.tool_input, undefined)));
    expect(rest).toMatchObject({ canAllow: true });
  });
});

describe('registry: the checked list in the entry, a dropped one only named in the log', () => {
  const body = (extra: Record<string, unknown>): Record<string, unknown> => ({
    key: `${HOOK_PROMPT}-${'b'.repeat(32)}`, sessionId: HOOK_SESSION, promptId: HOOK_PROMPT, secret: 'c'.repeat(64),
    inputSha256: 'd'.repeat(64), cardSha256: 'e'.repeat(64), pid: 4242, startedAt: 1_000, ...extra,
  });

  function registryWithLog(): { readonly registry: ConsentRegistry; readonly lines: string[] } {
    const lines: string[] = [];
    const registry = createConsentRegistry({
      bootId: 'boot', send: () => true, sessions: () => [HOOK_SESSION], log: (line) => { lines.push(line); },
    });
    registry.setScope('main');
    return { registry, lines };
  }

  it.each<[string, unknown, HookSuggestions | undefined]>([
    ['the measured list', suggestionsOf('webfetch.hook.json'), suggestionsOf('webfetch.hook.json')],
    ['an empty list', [], []],
    ['a list with a bad entry', [RULE, { ...MODE, extra: 'secret-rule-text' }], undefined],
    ['no field (an older hook)', undefined, undefined],
  ])('%s', (_name, raw, expected) => {
    const { registry, lines } = registryWithLog();
    const outcome = registry.register(body(raw === undefined ? {} : { permissionSuggestions: raw }));
    expect(outcome.status).toBe(200);
    const entry = registry.entry(HOOK_SESSION, `${HOOK_PROMPT}-${'b'.repeat(32)}`);
    if (expected === undefined) expect(entry).not.toHaveProperty('permissionSuggestions');
    else expect(entry?.permissionSuggestions).toEqual(expected);
    const dropped = raw !== undefined && expected === undefined;
    expect(lines.some((line) => line.includes('permission_suggestions dropped'))).toBe(dropped);
    expect(lines.join('\n')).not.toMatch(/secret-rule-text|npm test|WebFetch\(|domain:/u);
  });

  it('a repeat with the same list is the same registration; another list blocks the key', () => {
    const { registry } = registryWithLog();
    const list = suggestionsOf('webfetch.hook.json');
    expect(registry.register(body({ permissionSuggestions: list })).status).toBe(200);
    expect(registry.register(body({ permissionSuggestions: list })).status).toBe(200);
    expect(registry.register(body({ permissionSuggestions: [] })).status).toBe(409);
  });
});

/**
 * The card verdict of the hook's real dump and registration with the proof "the dialog stands". An MCP request takes
 * the proof from the screen top, which these tests have no screen for, so they give it directly.
 */
function cardOf(s: HookScene, dump: HookCallDump): ReturnType<typeof consentCardVerdict> {
  return consentCardVerdict({
    dump, registration: s.registry.entry(HOOK_SESSION, dump.key),
    signable: s.registry.secretOf(HOOK_SESSION, dump.key) !== null, scope: 'main', standing: 'standing',
  });
}

/** Waits for the hook's dump and registration. */
async function carried(s: HookScene): Promise<{ readonly dump: HookCallDump; readonly entry: ConsentRegistryEntry }> {
  await until(() => readHookLog(s.dir).find((line) => line.ev === 'czekam'), 'the hook waiting');
  const dump = await until(() => scanCallDumps(s.dir, HOOK_SESSION).dumps[0], 'the per-call dump');
  const entry = await until(() => s.registry.entry(HOOK_SESSION, dump.key), 'the registration');
  return { dump, entry };
}

describe('hook: `permission_suggestions` in the registration, the per-call dump and the card', () => {
  it('`Bash` with the measured rule: carried checked, the card has it and the allow button; `allow` as without'
    + ' them; the hook log carries no rule', async () => {
    const stdin = stdinOf('bash-dlugi.hook.json');
    const s = await hookScene();
    const run = startHook(s.dir, s.project, {
      toolName: 'Bash', toolInput: stdin.tool_input, extra: { permission_suggestions: stdin.permission_suggestions },
    });
    const { dump, entry } = await carried(s);
    expect(dump.permissionSuggestions).toEqual(stdin.permission_suggestions);
    expect(dump).not.toHaveProperty('mcpEmptySuggestions');
    expect(entry.permissionSuggestions).toEqual(stdin.permission_suggestions);

    expect(await s.cycle.observe(HOOK_SESSION, dump.key, 'standing', dump))
      .toMatchObject({ canAllow: true, unavailable: null, permissionSuggestions: stdin.permission_suggestions });
    expect(await s.cycle.decide(HOOK_SESSION, dump.key, 'allow')).toEqual({ ok: true, state: 'sent' });
    const outcome = await run.done;
    expect(JSON.parse(outcome.stdout)).toEqual(ALLOW);
    expect(hookExit(s.dir)).toMatchObject({ powod: 'odbior' });
    const log = readFileSync(join(s.dir, HOOK_SHADOW_LOG_FILENAME), 'utf8');
    expect(log).not.toContain('localSettings');
    expect(log).not.toContain('addRules');
  }, TIMEOUT);

  it('measured MCP with `[]`: the dump has the marker, the card no allow button, deny and release stay', async () => {
    const stdin = stdinOf('mcp-osobiscie.hook.json');
    const s = await hookScene();
    startHook(s.dir, s.project, {
      toolName: stdin.tool_name, toolInput: stdin.tool_input,
      extra: { permission_suggestions: stdin.permission_suggestions },
    });
    const { dump, entry } = await carried(s);
    expect(dump).toMatchObject({ permissionSuggestions: [], mcpEmptySuggestions: true });
    expect(entry.permissionSuggestions).toEqual([]);
    expect(cardOf(s, dump)).toMatchObject({ canAllow: false, unavailable: 'no-proof', canSign: true });
  }, TIMEOUT);

  it('measured MCP with `[]` at the first observation: the request goes back at once (`release`, `releaseCause:'
    + ' mcp-interaction`) and the hook leaves without a decision: the dialog stands at the desk (N4)', async () => {
    const stdin = stdinOf('mcp-osobiscie.hook.json');
    const s = await hookScene();
    const run = startHook(s.dir, s.project, {
      toolName: stdin.tool_name, toolInput: stdin.tool_input,
      extra: { permission_suggestions: stdin.permission_suggestions },
    });
    const { dump } = await carried(s);
    expect(await s.cycle.observe(HOOK_SESSION, dump.key, 'standing', dump))
      .toMatchObject({ state: 'sent', canAllow: false });
    expect(s.cycle.record(HOOK_SESSION, dump.key)).toMatchObject({
      state: 'sent', decision: 'release', reasonId: 'release', releaseCause: 'mcp-interaction',
    });
    const outcome = await run.done;
    expect(outcome).toMatchObject({ code: 0, stdout: '' });
    expect(hookExit(s.dir)).toMatchObject({ powod: 'release' });
  }, TIMEOUT);

  it('measured MCP with a rule: no marker, the allow button as without suggestions', async () => {
    const stdin = stdinOf('mcp.hook.json');
    const s = await hookScene();
    startHook(s.dir, s.project, {
      toolName: stdin.tool_name, toolInput: stdin.tool_input,
      extra: { permission_suggestions: stdin.permission_suggestions },
    });
    const { dump } = await carried(s);
    expect(dump).not.toHaveProperty('mcpEmptySuggestions');
    expect(cardOf(s, dump)).toMatchObject({
      canAllow: true, unavailable: null, permissionSuggestions: stdin.permission_suggestions,
    });
  }, TIMEOUT);

  it.each<[string, unknown]>([
    ['a list over 16 KiB (the hook drops it)', Array.from({ length: 40 }, (_, i) => ({
      ...RULE, rules: [{ toolName: 'Bash', ruleContent: `${'y'.repeat(500)}${String(i)}` }],
    }))],
    ['a list in a bad shape (the server drops it)', [RULE, { ...MODE, extra: 1 }]],
  ])('%s: no field anywhere, the registration accepted, the card with the allow button', async (_name, raw) => {
    const s = await hookScene();
    startHook(s.dir, s.project, { toolName: 'Bash', toolInput: { command: 'echo x' }, extra: {
      permission_suggestions: raw,
    } });
    const { dump, entry } = await carried(s);
    expect(dump).not.toHaveProperty('permissionSuggestions');
    expect(entry).not.toHaveProperty('permissionSuggestions');
    const card = await s.cycle.observe(HOOK_SESSION, dump.key, 'standing', dump);
    expect(card).toMatchObject({ canAllow: true });
    expect(card).not.toHaveProperty('permissionSuggestions');
  }, TIMEOUT);

  it('a list under 16 KiB in a body over the former 4096 B: carried whole through the socket', async () => {
    const near = Array.from({ length: 12 }, (_, i) => ({
      ...RULE, rules: [{ toolName: 'Bash', ruleContent: `${'z'.repeat(1_000)}${String(i)}` }],
    }));
    expect(Buffer.byteLength(JSON.stringify(near))).toBeGreaterThan(4096);
    expect(Buffer.byteLength(JSON.stringify(near)) + 1024).toBeLessThan(CONSENT_REGISTER_BODY_MAX_BYTES);
    const s = await hookScene();
    startHook(s.dir, s.project, { toolName: 'Bash', toolInput: { command: 'echo near' }, extra: {
      permission_suggestions: near,
    } });
    const { entry } = await carried(s);
    expect(entry.permissionSuggestions).toEqual(near);
  }, TIMEOUT);

  it('stdin without the field (`ExitPlanMode`, an older CLI): no field in the dump, the registration or the card',
    async () => {
      const s = await hookScene();
      startHook(s.dir, s.project, { toolName: 'mcp__srv__tool', toolInput: { text: 'x' } });
      const { dump, entry } = await carried(s);
      expect(dump).not.toHaveProperty('permissionSuggestions');
      expect(dump).not.toHaveProperty('mcpEmptySuggestions');
      expect(entry).not.toHaveProperty('permissionSuggestions');
      expect(cardOf(s, dump)).toMatchObject({ canAllow: true, unavailable: null });
    }, TIMEOUT);
});
