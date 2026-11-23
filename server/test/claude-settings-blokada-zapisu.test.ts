/**
 * The write block of the settings writer: the two `Edit` deny rules for the data directory and
 * `~/.config/rarog` at the end of `permissions.deny`, their removal on uninstall, and the one setup question that offers
 * the block alone to an installation with every other Rarog entry. A Claude Code session that loads the user settings
 * then gets no write access to the Rarog state, from Bash in the sandbox or from the Write and Edit tools.
 *
 * Everything runs in a temporary HOME (`tempHome`); the writer gets that home as an argument.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { entriesQuestion, writeClaudeSettings, writeClaudeSettingsBatch } from '../src/cli/claude-settings.ts';
import type { SettingsOperation, SettingsWriteResult } from '../src/cli/claude-settings.ts';
import { SETTINGS_OPERATIONS } from '../src/cli/setup-settings.ts';
import {
  contextHookCommand, denyReadBlock, hookCommand, pasteHookBlock, statuslineCommand, userSettingsPath, writeBlockRules,
} from '../src/herdr/hook-config.ts';
import { realRarogDirsCreated, tempHome } from './rarog-home.ts';
import type { TempHome } from './rarog-home.ts';

const REPO = path.join(import.meta.dirname, '..', '..');

let t: TempHome;
let home = '';
let data = '';

beforeEach(() => {
  t = tempHome('rarog-wb-');
  home = path.join(t.home, 'h');
  data = path.join(t.home, 'dane');
  mkdirSync(path.join(home, '.claude'), { recursive: true });
});

afterEach(() => { t.cleanup(); });

afterAll(() => { expect(realRarogDirsCreated()).toEqual([]); });

/** The two rules for the test's data directory and home. */
function rules(dir = data): readonly string[] {
  const built = writeBlockRules(dir, home);
  if (!built.ok) throw new Error(built.reason);
  return built.rules;
}

const settings = (): string => userSettingsPath(home);
const text = (): string => readFileSync(settings(), 'utf8');
const json = (): Record<string, unknown> => JSON.parse(text()) as Record<string, unknown>;

function put(value: unknown): string {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(settings(), body);
  return body;
}

const writerBase = (dir: string, questions: string[]) => ({
  home, root: REPO, dataDir: { ok: true, dir } as const,
  lock: { dir: path.join(home, '.config', 'rarog'), what: 'rarog setup' },
  confirm: async (question: Parameters<typeof entriesQuestion>[0]) => {
    questions.push(entriesQuestion(question));
    return true;
  },
  print: () => {},
  again: 'rarog setup',
});

/** One operation after "y"; `questions` = the questions asked. */
async function write(operation: SettingsOperation, dir = data): Promise<{
  readonly result: SettingsWriteResult; readonly questions: readonly string[];
}> {
  const questions: string[] = [];
  const result = await writeClaudeSettings({ ...writerBase(dir, questions), operation });
  return { result, questions };
}

describe('settings writer: the write block in permissions.deny', () => {
  it('no permissions: permissions.deny appears with both rules, the rest stays', async () => {
    put({ model: 'opus' });
    expect((await write('writeBlock')).result.kind).toBe('written');
    expect(json()).toEqual({ model: 'opus', permissions: { deny: rules() } });
  });

  it('foreign rules and other permission keys stay; both rules go at the end of deny', async () => {
    put({ permissions: { allow: ['Bash(ls)'], deny: ['Read(~/.aws/**)'], defaultMode: 'acceptEdits' } });
    expect((await write('writeBlock')).result.kind).toBe('written');
    expect(json()).toEqual({
      permissions: { allow: ['Bash(ls)'], deny: ['Read(~/.aws/**)', ...rules()], defaultMode: 'acceptEdits' },
    });
  });

  it('one rule already there: only the other one is added, no duplicate', async () => {
    const [dataRule, configRule] = rules();
    put({ permissions: { deny: [configRule, 'Bash(rm *)'] } });
    expect((await write('writeBlock')).result.kind).toBe('written');
    expect(json()).toEqual({ permissions: { deny: [configRule, 'Bash(rm *)', dataRule] } });
  });

  it('both rules there: no question and no write', async () => {
    const body = put({ permissions: { deny: ['Bash(rm *)', ...rules()] } });
    const run = await write('writeBlock');
    expect(run.result).toEqual({ kind: 'unchanged' });
    expect(run.questions).toEqual([]);
    expect(text()).toBe(body);
  });

  for (const [name, permissions, reason] of [
    ['permissions: []', [], '"permissions" is an array, not an object'],
    ['permissions: null', null, '"permissions" is null, not an object'],
    ['deny: "x"', { deny: 'x' }, '"permissions.deny" is a string, not an array'],
  ] as const) {
    it(`${name}: refused with the level named, nothing written`, async () => {
      const body = put({ permissions });
      const run = await write('writeBlock');
      expect(run.result.kind === 'refused' ? run.result.reason : '').toContain(reason);
      expect(run.questions).toEqual([]);
      expect(text()).toBe(body);
    });
  }

  it('removal (rarog service uninstall): exactly the two rules go, foreign rules and foreign empty keys stay', async () => {
    // A rule in another spelling is the user's own: the writer never wrote it.
    const own = `Edit(${data}/**)`;
    put({ permissions: { deny: ['Read(~/.aws/**)', ...rules(), own], allow: [] } });
    expect((await write('remove')).result.kind).toBe('written');
    expect(json()).toEqual({ permissions: { deny: ['Read(~/.aws/**)', own], allow: [] } });
    put({ model: 'opus', permissions: { deny: rules() } });
    expect((await write('remove')).result.kind).toBe('written');
    expect(json()).toEqual({ model: 'opus' });
  });

  it('every other Rarog entry in place: the setup operations offer the block alone, as one entry', async () => {
    const before = {
      ...pasteHookBlock(hookCommand(home), contextHookCommand(home)) as object,
      statusLine: { type: 'command', command: statuslineCommand(home) },
      ...denyReadBlock(data) as object,
    };
    put(before);
    const questions: string[] = [];
    const batch = await writeClaudeSettingsBatch({ ...writerBase(data, questions), operations: SETTINGS_OPERATIONS });
    expect(SETTINGS_OPERATIONS.filter((one) => batch.outcomes.get(one)?.kind === 'change')).toEqual(['writeBlock']);
    expect(questions).toEqual(['Add a Rarog entry to ~/.claude/settings.json?']);
    expect(batch.write.kind).toBe('written');
    expect(json()).toEqual({ ...before, permissions: { deny: rules() } });
  });

  it('a data directory with a pattern character: that entry is refused with the path, the others are written', async () => {
    const odd = path.join(t.home, 'state[1]');
    put({});
    const questions: string[] = [];
    const batch = await writeClaudeSettingsBatch({
      ...writerBase(odd, questions), operations: ['denyRead', 'writeBlock'],
    });
    const outcome = batch.outcomes.get('writeBlock');
    expect(outcome?.kind).toBe('refused');
    expect(outcome?.kind === 'refused' ? outcome.reason : '').toContain(JSON.stringify(odd));
    expect(batch.write.kind).toBe('written');
    expect(json()).toEqual({ ...denyReadBlock(odd) as object });
  });
});
