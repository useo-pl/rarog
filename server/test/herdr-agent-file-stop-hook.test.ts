/**
 * A subagent file whose last line is the record of the `SubagentStop` hook (`agent-file.ts`), and what `merge.ts`
 * makes of it. With a `SubagentStop` hook configured, Claude Code (2.1.325–2.1.330) writes this record at every stop
 * of the agent, after its last entry: in a standby and after the report is handed back. Without its own time such a
 * file never gets the `settled` proof, so an agent left in standby never goes dormant. The same file carries copies of
 * API request messages without a time, whose `Monitor` call must not hold the agent forever.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BackgroundTask } from '@rarog/shared';
import { projectSlug } from '../src/cli-store.ts';
import { createAgentFileReader } from '../src/herdr/background/agent-file.ts';
import type { AgentFileReader } from '../src/herdr/background/agent-file.ts';
import { DORMANT_AFTER_MS, createTasksState, noteTasks } from '../src/herdr/background/merge.ts';
import type { TasksDeps } from '../src/herdr/background/merge.ts';

const CWD = '/Users/u/Projects/atlas';
const SESSION = '5b1e7c42-9d3a-4f60-8a2e-0c6b9d7f1e34';
const AGENT = 'a0f3c8e1d2b4a6978';
/** The standby notification in the main file; the other times count from it. */
const STANDBY = '2026-11-02T10:00:00.188Z';
const after = (ms: number): string => new Date(Date.parse(STANDBY) + ms).toISOString();

let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'rarog-stophook-'));
  await mkdir(join(root, projectSlug(CWD), SESSION, 'subagents'), { recursive: true });
  await writeFile(join(root, projectSlug(CWD), `${SESSION}.jsonl`), '{}\n');
});

const agentFile = (lines: string): Promise<void> =>
  writeFile(join(root, projectSlug(CWD), SESSION, 'subagents', `agent-${AGENT}.jsonl`), lines);

const reader = (): AgentFileReader => createAgentFileReader({ cwd: CWD, agentSessionId: SESSION, root, logger: () => undefined });

const line = (entry: Record<string, unknown>): string => `${JSON.stringify({ isSidechain: true, agentId: AGENT, ...entry })}\n`;

const called = (name: string, input: Record<string, unknown>, at: string): string => line({
  type: 'assistant', timestamp: at,
  message: { role: 'assistant', content: [{ type: 'tool_use', id: `toolu_${name}`, name, input }] },
});

const result = (name: string, at: string): string => line({
  type: 'user', timestamp: at,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${name}`, content: 'ok' }] },
});

/** The hook record as the CLI writes it (keys from a session file, CLI 2.1.330; values neutral). */
const hookRecord = (hookEvent: string, at: string): string => line({
  type: 'attachment', timestamp: at,
  attachment: {
    type: 'hook_success', hookName: hookEvent, hookEvent, toolUseID: 'toolu_hook', content: '',
    stdout: '{}\n', stderr: '', exitCode: 0, command: 'echo {}', durationMs: 15,
  },
});

/** A copy of a request message (CLI 2.1.330): no time, its tool calls repeat calls from ordinary entries. */
const requestCopy = (entry: string): string => {
  const { message } = JSON.parse(entry) as { message: unknown };
  return `${JSON.stringify({ type: 'api-request-blob', sessionId: SESSION, agentId: AGENT, hash: 'f00d', message })}\n`;
};

/** The end of a subagent that handed back its report: the call, its result, then the hook records. */
const handedBack = (): string => called('SubagentHandback', { message: 'report' }, after(-188))
  + result('SubagentHandback', after(-65))
  + hookRecord('PostToolUse', after(-65))
  + hookRecord('SubagentStop', after(-6));

describe('createAgentFileReader: the `SubagentStop` hook record at the end of the file', () => {
  it('gives the file its end: the proof `settled` is there', async () => {
    await agentFile(handedBack());
    expect(await reader().read(AGENT)).toEqual({ lastEntryAt: after(-6), commands: [], settled: {} });
  });

  /** `PostToolUse` records of parallel tool calls carry a time earlier than the entries before them. */
  it('another hook record at the end does not', async () => {
    await agentFile(called('Read', { file_path: 'a' }, after(-500)) + result('Read', after(-400))
      + hookRecord('PostToolUse', after(-450)));
    expect((await reader().read(AGENT))?.settled).toBeUndefined();
  });

  /** The copy has no time; read as a call it would hold the agent forever. */
  it('a request copy of a `Monitor` call does not move the deadline of other own tasks', async () => {
    const monitor = called('Monitor', { description: 'log', timeout_ms: 60_000, command: 'tail -f x' }, after(-120_000));
    await agentFile(monitor + requestCopy(monitor) + handedBack());
    expect((await reader().read(AGENT))?.settled).toEqual({ otherWorkUntil: Date.parse(after(-60_000)) });
  });
});

describe('merge.ts: a subagent that handed back its report while its monitor was alive', () => {
  /**
   * The CLI reports a standby 6 ms after the `SubagentStop` record, because the monitor is still alive, and
   * nothing about the agent follows: the monitor expiry stays in the main file's queue. The agent stays waiting until
   * the monitor's deadline, then goes dormant after a minute of quiet.
   */
  it('goes dormant a minute after the monitor deadline', async () => {
    const deadline = 15_000;
    const monitor = called('Monitor', { description: 'log', timeout_ms: 1_800_000, command: 'tail -f x' },
      after(deadline - 1_800_000));
    await agentFile(monitor + requestCopy(monitor) + handedBack());

    const state = createTasksState();
    const lists: BackgroundTask[][] = [];
    const pending: (() => void)[] = [];
    const clock = { now: Date.parse(STANDBY) + 1000 };
    const deps: TasksDeps = {
      reader: null, agentReader: reader(), pollMs: 5_000, disposed: () => false,
      scheduler: { setTimeout: (fn) => { pending.push(fn); return pending.length; }, clearTimeout: () => undefined, now: () => clock.now },
      emit: (tasks) => { lists.push([...tasks]); },
    };
    const settled = async (): Promise<void> => {
      while (state.polling) await new Promise((resolve) => setTimeout(resolve, 2));
    };
    const shown = (): string => (lists.at(-1)?.some((task) => task.id === AGENT) === true ? 'waiting' : 'gone');
    const during = async (ms: number): Promise<string[]> => {
      const states: string[] = [];
      for (let left = ms; left > 0; left -= 5_000) {
        clock.now += 5_000;
        for (const fn of pending.splice(0)) fn();
        await settled();
        states.push(shown());
      }
      return states;
    };

    const agent: BackgroundTask = {
      id: AGENT, kind: 'agent', description: 'Diagnose a test', startedAt: after(-2_000_000), waitingSince: STANDBY,
    };
    noteTasks(state, deps, { tasks: [agent], since: after(-3_000_000) });
    await settled();
    expect(shown()).toBe('waiting');

    expect(new Set(await during(deadline + DORMANT_AFTER_MS - 5_000)), 'before the deadline plus a minute')
      .toEqual(new Set(['waiting']));
    expect(await during(10_000)).toContain('gone');
    expect(shown()).toBe('gone');
  });
});
