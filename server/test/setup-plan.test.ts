/**
 * The plan screen of `rarog setup` (`server/src/cli/setup-plan.ts`) and the width of every setup question: the
 * plan has at most 7 lines above `Continue?` at 60 columns, also with the herdr agent or unit item, names the
 * machine as the user calls it (a Linux machine is not "this Mac"), and each question without its clauses fits
 * one line of a 60-column terminal. "n" stops the run, but on a plan of the herdr item alone it declines just
 * that item and the run goes on.
 */
import { describe, expect, it } from 'vitest';
import { entriesQuestion } from '../src/cli/claude-settings.ts';
import type { BatchQuestion, SettingsOperation } from '../src/cli/claude-settings.ts';
import { ANSWER_HINTS, questionPrompt } from '../src/cli/screen/ask.ts';
import type { QuestionForm } from '../src/cli/screen/ask.ts';
import type { Ctx } from '../src/cli/setup-context.ts';
import { herdrAgentPlanEntry } from '../src/cli/setup-herdr-agent.ts';
import { herdrUnitPlanEntry } from '../src/cli/setup-herdr-unit.ts';
import {
  PLAN_DECLINED, PLAN_QUESTION, confirmPlan, planHeader, sdkPlanEntry, workAreaSentence,
} from '../src/cli/setup-plan.ts';
import type { PlanEntry } from '../src/cli/setup-plan.ts';
import { copyQuestion } from '../src/cli/setup.ts';
import { IROH_KEY_QUESTION } from '../src/cli/setup-secrets.ts';
import { HERDR_ONLY_QUESTION, SETTINGS_OPERATIONS, settingsQuestion } from '../src/cli/setup-settings.ts';
import { AGENT_QUESTION, DICTATION_QUESTION, OPENAI_PROMPT, SONIOX_PROMPT } from '../src/cli/setup-voice.ts';

/** The herdr item of `platform`: the herdr agent on macOS, `herdr.service` on Linux. */
const herdr = (platform: NodeJS.Platform): PlanEntry =>
  (platform === 'darwin' ? herdrAgentPlanEntry('/h') : herdrUnitPlanEntry('/h'));

/** What the plan of a first package setup offers: `config.json` with its key, the herdr item, the SDK, the service. */
const packagePlan = (platform: NodeJS.Platform): readonly PlanEntry[] => [
  { item: 'config', what: 'config and server key', where: '~/.config/rarog' },
  herdr(platform),
  sdkPlanEntry('0.3.247'),
  { item: 'service', what: 'background service', where: platform === 'darwin' ? 'ai.rarog.server' : 'rarog.service' },
];

/** The same for a repo clone: the hook copy instead of the SDK. */
const clonePlan = (platform: NodeJS.Platform): readonly PlanEntry[] => [
  { item: 'config', what: 'config and server key', where: '~/.config/rarog' },
  { item: 'hook', what: 'permission hook copy', where: '~/.claude/hooks/rarog' },
  herdr(platform),
  { item: 'service', what: 'background service', where: platform === 'darwin' ? 'ai.rarog.server' : 'rarog.service' },
];

/** The plan screen at `width` columns answered with `answer`: whether the run goes on, the shown lines, the prompt. */
async function answered(platform: NodeJS.Platform, entries: readonly PlanEntry[], answer: string | null, width = 60):
Promise<{
  readonly goesOn: boolean;
  readonly shown: string[];
  readonly prompt: string;
  readonly accepted: ReadonlySet<string>;
  readonly declined: ReadonlySet<string>;
}> {
  const shown: string[] = [];
  let prompt = '';
  const accepted = new Set<string>();
  const declined = new Set<string>();
  const ctx = {
    platform, home: '/h', io: { env: {} }, accepted, declined,
    ask: (text: string) => { prompt = text; return Promise.resolve(answer); },
    view: { block: (text: string) => { shown.push(text); }, screen: { layout: { width } }, accepted: () => {} },
  } as unknown as Ctx;
  const goesOn = await confirmPlan(ctx, entries);
  return { goesOn, shown, prompt, accepted, declined };
}

/** The plan screen at `width` columns with the answer "n": the lines above the question and the question. */
async function plan(platform: NodeJS.Platform, entries: readonly PlanEntry[], width = 60): Promise<{
  readonly lines: string[];
  readonly prompt: string;
}> {
  const { goesOn, shown, prompt } = await answered(platform, entries, 'n', width);
  expect(goesOn).toBe(false);
  // The line after "n" is not part of the plan.
  expect(shown.at(-1)).toBe(PLAN_DECLINED);
  return { lines: shown.slice(0, -1), prompt };
}

describe('the plan screen', () => {
  it('first package setup on macOS: at most 7 lines at 60 columns, none wider, the work area in one line', async () => {
    const { lines, prompt } = await plan('darwin', packagePlan('darwin'));
    expect(lines.length, lines.join('\n')).toBeLessThanOrEqual(7);
    expect(lines[0]).toBe('Rarog will set up on this Mac:');
    for (const line of lines) expect(line.length, line).toBeLessThanOrEqual(60);
    expect(lines.at(-1)).toBe(workAreaSentence());
    expect(workAreaSentence()).toBe('Work area: home (RAROG_PROJECT_ROOTS in config.json).');
    expect(prompt).toBe(`? ${PLAN_QUESTION} [Y/n] `);
  });

  it('Linux: "on this machine", never "Mac" or "macOS-protected"', async () => {
    const { lines } = await plan('linux', packagePlan('linux'));
    expect(lines[0]).toBe('Rarog will set up on this machine:');
    expect(lines.join('\n')).not.toMatch(/Mac|macOS/u);
    expect(lines.length).toBeLessThanOrEqual(7);
    expect(planHeader('linux')).toBe('Rarog will set up on this machine:');
  });

  it('a repo clone: the hook copy instead of the SDK, also at most 7 lines', async () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const { lines } = await plan(platform, clonePlan(platform));
      expect(lines.length, lines.join('\n')).toBeLessThanOrEqual(7);
      for (const line of lines) expect(line.length, line).toBeLessThanOrEqual(60);
    }
  });

  it('the herdr item is one line, what and where; the macOS folder window is not in the plan', async () => {
    const mac = (await answered('darwin', [herdr('darwin')], 'y')).shown;
    expect(mac).toEqual(['Rarog will set up on this Mac:', '  • herdr agent            ~/Library/LaunchAgents']);
    const linux = (await answered('linux', [herdr('linux')], 'y')).shown;
    expect(linux).toEqual(['Rarog will set up on this machine:', '  • herdr.service          ~/.config/systemd/user']);
    for (const lines of [mac, linux]) expect(lines.join('\n')).not.toMatch(/folder|Documents|ask once/u);
  });

  for (const answer of ['n', null] as const) {
    it(`${answer === null ? 'EOF' : '"n"'} on a plan of the herdr item alone: the run goes on with the item declined,`
      + ' no "Nothing changed." (K4b revision)', async () => {
      for (const platform of ['darwin', 'linux'] as const) {
        const run = await answered(platform, [herdr(platform)], answer);
        expect(run.goesOn).toBe(true);
        expect(run.declined).toEqual(new Set(['herdr']));
        expect(run.accepted).toEqual(new Set());
        expect(run.shown).not.toContain(PLAN_DECLINED);
      }
    });
  }

  it('"n" on a plan with the herdr item and another one: "Nothing changed.", the run stops, nothing declined',
    async () => {
      for (const item of ['config', 'hook', 'sdk', 'service'] as const) {
        const other = packagePlan('darwin').find((one) => one.item === item)
          ?? clonePlan('darwin').find((one) => one.item === item);
        expect(other).toBeDefined();
        const run = await answered('darwin', [herdr('darwin'), ...other === undefined ? [] : [other]], 'n');
        expect(run.goesOn).toBe(false);
        expect(run.shown.at(-1)).toBe(PLAN_DECLINED);
        expect(run.declined).toEqual(new Set());
        expect(run.accepted).toEqual(new Set());
      }
    });

  it('"y" accepts every item, the herdr item too; nothing declined', async () => {
    const run = await answered('linux', clonePlan('linux'), 'y');
    expect(run.goesOn).toBe(true);
    expect(run.accepted).toEqual(new Set(['config', 'hook', 'herdr', 'service']));
    expect(run.declined).toEqual(new Set());
  });

  it('nothing to create: no plan and no question', async () => {
    const ctx = { ask: () => Promise.reject(new Error('asked')) } as unknown as Ctx;
    expect(await confirmPlan(ctx, [])).toBe(true);
  });
});

describe('every setup question without its clauses fits one line at 60 columns', () => {
  const batch = (changes: readonly SettingsOperation[]): BatchQuestion => ({
    changes, chains: false, reformatted: false, newFile: false, diff: [],
  });
  const QUESTIONS: readonly (readonly [string, QuestionForm])[] = [
    [PLAN_QUESTION, 'Y/n'],
    [DICTATION_QUESTION, 'y/N'],
    [AGENT_QUESTION, 'y/N'],
    [IROH_KEY_QUESTION, 'y/N'],
    ['Run tailscale serve --bg --https=8931 8930?', 'y/N'],
    [copyQuestion('install', '~/.claude/hooks/rarog'), 'y/N'],
    [copyQuestion('update', '~/.claude/hooks/rarog'), 'y/N'],
    [copyQuestion('statusLine', '~/.claude/hooks/rarog'), 'y/N'],
    [settingsQuestion(batch(SETTINGS_OPERATIONS), false), 'y/N/d'],
    [HERDR_ONLY_QUESTION, 'y/N/d'],
    [entriesQuestion(batch(['permission'])), 'y/N/d'],
    [entriesQuestion(batch(['remove'])), 'y/N/d'],
  ];

  for (const [question, form] of QUESTIONS) {
    it(question, () => {
      const [first = '', ...rest] = questionPrompt(question, form, 60).split('\n');
      // The sentence fits the first line; only the answer hint may take a second one, because questions wrap one
      // column short of the width.
      expect(first.startsWith(`? ${question}`)).toBe(true);
      expect(rest.map((one) => one.trim())).toEqual(rest.length === 0 ? [] : [ANSWER_HINTS[form].trim()]);
      for (const one of [first, ...rest]) expect(one.trimEnd().length).toBeLessThan(60);
    });
  }

  it('the settings question with herdr\'s hook: two lines at 60 columns, the only longer one', () => {
    const prompt = questionPrompt(settingsQuestion(batch(SETTINGS_OPERATIONS), true), 'y/N/d', 60);
    expect(prompt).toBe('? Add 5 Rarog entries and herdr\'s hook to\n  ~/.claude/settings.json? [y/N/d] ');
  });

  it('the hidden key prompts start with "? " like every question', () => {
    expect(SONIOX_PROMPT).toBe('? Soniox EU key (hidden): ');
    expect(OPENAI_PROMPT).toBe('? OpenAI API key (hidden): ');
  });
});
