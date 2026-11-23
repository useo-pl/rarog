/**
 * The Settings step of `rarog setup`: the five Rarog entries in `~/.claude/settings.json` (permission
 * hooks, the `SessionStart` context hook, `statusLine`, the `sandbox.filesystem.denyRead` paths, the write block rules
 * in `permissions.deny`) and herdr's Claude integration, behind ONE question `[y/N/d]`. An installation with every
 * other entry gets the question for the missing ones alone. On "y" the settings writer makes one write with one
 * backup for the entries without a conflict, then herdr's own installer adds its hook (herdr writes that entry, not
 * Rarog). `d` shows the full diff on the screen and asks again; the diff and lines quoting the file never reach the
 * run log. An entry in conflict drops out with its own `!` and `Fix:`; the rest goes on. The step writes nothing else.
 */
import { spawnSync } from 'node:child_process';
import {
  STATUSLINE_FRESH_MS, isRarogStatuslineCommand, newestStatuslineDump, statuslineCopyReport, userSettingsPath,
  visibleLine,
} from '../herdr/hook-config.ts';
import { readRegularFileSync } from '../safe-read.ts';
import {
  ENTRY_NAMES, conflictWithoutQuote, entriesDiff, entriesQuestion, plannedOutcomes, writeClaudeSettingsBatch,
} from './claude-settings.ts';
import type { BatchQuestion, OperationOutcome, SettingsOperation } from './claude-settings.ts';
import { HERDR_INTEGRATION_INSTALL, herdrClaudeIntegration, herdrIntegrationLine } from './hooks.ts';
import { confirm as confirmForm } from './screen/ask.ts';
import { rarogConfigDir } from './serve.ts';
import { isRecord, line } from './setup-context.ts';
import type { Ctx, Step } from './setup-context.ts';

/** The operations of the step, in the order of the question and of the write. */
export const SETTINGS_OPERATIONS: readonly SettingsOperation[] = [
  'permission', 'context', 'statusLine', 'denyRead', 'writeBlock',
];

/** Sufit `herdr integration install claude` (komenda pisze dwa pliki, nie czeka na sieć). */
const HERDR_INSTALL_TIMEOUT_MS = 30_000;

/** What `d` adds under the Rarog diff when herdr's installer runs after the write. */
export const HERDR_DIFF_NOTE = `After the Rarog entries, herdr runs \`${HERDR_INTEGRATION_INSTALL}\`, which adds its own`
  + ' SessionStart hook; that change is not in this diff.';

/** Keys of `~/.claude/settings.json` each operation writes, for the structural log line. */
const SETTINGS_KEYS: Readonly<Record<SettingsOperation, string>> = {
  permission: 'hooks (permission entries)', context: 'hooks.SessionStart',
  statusLine: 'statusLine', denyRead: 'sandbox.filesystem.denyRead', writeBlock: 'permissions.deny',
  remove: 'Rarog entries',
};

/** Where the user finds all five entries to add by hand. */
const BY_HAND = 'rarog hooks print';

/** herdr's hook in the question, when its installer runs after the Rarog write. */
const HERDR_HOOK = 'herdr\'s hook';

/** The question when no Rarog entry changes and only herdr's installer is left. */
export const HERDR_ONLY_QUESTION = 'Let herdr add its hook to ~/.claude/settings.json?';

/**
 * The one question ({@link entriesQuestion}) with herdr's hook when its installer runs after the write;
 * `question` = `null` when no Rarog entry changes and only herdr's installer is left.
 */
export function settingsQuestion(question: BatchQuestion | null, herdr: boolean): string {
  return question === null ? HERDR_ONLY_QUESTION : entriesQuestion(question, herdr ? HERDR_HOOK : null);
}

/**
 * What the question is for, one sentence per line right above it: the permission entries let the phone answer
 * Claude's permission prompts (herdr's hook alone lets the app see the sessions; other entries alone get no such
 * line), and nothing else in the file changes. A removal has none.
 */
export function settingsNotes(question: BatchQuestion | null): readonly string[] {
  if (question?.changes.includes('remove') === true) return [];
  const purpose = question === null ? ['So the app can list your Claude sessions.']
    : question.changes.includes('permission') ? ['So your phone can answer Claude\'s permission prompts.'] : [];
  return [...purpose, 'Your other settings stay as they are; d shows the change.'];
}

/**
 * The question `[y/N/d]` under {@link settingsNotes}; `d` puts the entry names, the diff and the herdr sentence on the
 * screen, never into the log.
 */
async function ask(ctx: Ctx, question: BatchQuestion | null, herdr: boolean): Promise<boolean> {
  if (ctx.ask === null) return false;
  for (const note of settingsNotes(question)) ctx.view.questionNote(note);
  return confirmForm(ctx.ask, settingsQuestion(question, herdr), 'y/N/d', {
    width: ctx.view.screen.layout.width,
    showDiff: () => {
      for (const one of question === null ? [] : entriesDiff(question)) ctx.view.block(`  ${one}`);
      if (herdr) ctx.view.block(`  ${HERDR_DIFF_NOTE}`);
    },
  });
}

/**
 * `herdr integration install claude` and a second status read: `null` = the integration is current now,
 * otherwise what went wrong. Arguments as an array, no shell; `herdr` is the full path from the tools step.
 */
function herdrInstall(ctx: Ctx, herdr: string): string | null {
  const timeout = ctx.deps.herdrInstallTimeoutMs ?? HERDR_INSTALL_TIMEOUT_MS;
  const result = spawnSync(herdr, ['integration', 'install', 'claude'], {
    env: ctx.io.env, encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const one of (result.stdout ?? '').split('\n')) if (one.trim() !== '') line(ctx, `  ${visibleLine(one)}`);
  const stderr = (result.stderr ?? '').split('\n').map((one) => one.trim()).filter((one) => one !== '')
    .map(visibleLine).join(' | ');
  const tail = stderr === '' ? '' : `: ${stderr}`;
  if (isRecord(result.error) && result.error['code'] === 'ETIMEDOUT') {
    return `no result within ${String(timeout / 1000)} s${tail}`;
  }
  if (result.error !== undefined) return `${visibleLine(result.error.message)}${tail}`;
  if (result.status !== 0) {
    return `${result.status === null ? `signal ${String(result.signal)}` : `code ${String(result.status)}`}${tail}`;
  }
  const again = herdrClaudeIntegration(herdr, ctx.io.env);
  return again.state === 'current' ? null : `finished, but the status still says: ${visibleLine(again.text)}`;
}

/** The `statusLine` command of the settings file, or `null` (no file, no key, unreadable: the writer says why). */
function statusLineCommand(home: string): string | null {
  try {
    const read = readRegularFileSync(userSettingsPath(home), { maxBytes: 4 * 1024 * 1024, followSymlink: true });
    if (read === null || read.truncated) return null;
    const parsed: unknown = JSON.parse(read.bytes.toString('utf8'));
    const status = isRecord(parsed) ? parsed['statusLine'] : undefined;
    const command = isRecord(status) ? status['command'] : undefined;
    return typeof command === 'string' && command.trim() !== '' ? command : null;
  } catch {
    return null;
  }
}

/**
 * The user's own `statusLine` command: the screen with `--verbose` shows it, never the log; a snapshot from the
 * last hour means it writes the snapshots itself and stays, otherwise it is chained behind the Rarog script.
 */
function noteStatusLine(ctx: Ctx): void {
  const command = statusLineCommand(ctx.home);
  if (command === null) {
    line(ctx, 'no statusLine in ~/.claude/settings.json — the app will not show plan limits or the context window size');
    return;
  }
  if (isRarogStatuslineCommand(command)) return;
  ctx.view.settingsDiff(`  custom statusLine command: ${command}`);
  const dump = newestStatuslineDump(ctx.home);
  if ('code' in dump) return;
  line(ctx, dump.newest !== null && Date.now() - dump.newest <= STATUSLINE_FRESH_MS
    ? 'it writes the snapshots ~/.claude/statusline/<session>.json that Rarog reads (one from the last hour is there),'
      + ' so setup leaves it'
    : 'no snapshot from the last hour in ~/.claude/statusline/: it is chained behind the Rarog script, gets the same'
      + ' payload on stdin after the dump, and its output stays on the status line');
}

/** The structural log line of one operation: what and where, never the file's content. */
function logLine(operation: SettingsOperation, outcome: OperationOutcome | undefined, write: string): string {
  const change: Readonly<Record<string, string>> = {
    written: 'added', declined: 'declined', 'no-terminal': 'not written (no terminal)',
  };
  const state = outcome === undefined ? 'not planned'
    : outcome.kind === 'change' ? change[write] ?? `not written (${write})`
      : outcome.kind === 'copy-not-ready' ? 'not written (copy not ready)' : outcome.kind;
  return `claude settings: ${operation}, ${SETTINGS_KEYS[operation]}: ${state}`;
}

/** One entry that did not go in, for the step line, and the command that fixes it. */
interface Issue {
  readonly text: string;
  readonly fix: string;
  /** The entry waits for the hook copy: such entries share one phrase of the step line. */
  readonly copy?: boolean;
}

/** Conflicts, refusals and missing copies of single operations: their lines, and one issue each. */
function issuesOf(ctx: Ctx, outcomes: ReadonlyMap<SettingsOperation, OperationOutcome>): Issue[] {
  const issues: Issue[] = [];
  const byHand = `fix ~/.claude/settings.json by hand (${BY_HAND}), then rarog setup`;
  for (const operation of SETTINGS_OPERATIONS) {
    const outcome = outcomes.get(operation);
    const what = ENTRY_NAMES[operation];
    if (outcome?.kind === 'conflict') {
      line(ctx, `conflict in ~/.claude/settings.json, ${what} not changed:`);
      // The step line carries the one sentence and the fix: each reason goes to the run log without the
      // command it may quote from the file, and whole to the screen with --verbose only.
      for (const reason of outcome.reasons) {
        ctx.view.logOnly(`    ${conflictWithoutQuote(reason)}`);
        ctx.view.settingsDiff(`    ${reason}`);
      }
      issues.push({ text: `${what} not changed (conflict)`, fix: byHand });
    } else if (outcome?.kind === 'refused') {
      line(ctx, `${what} not changed: ${outcome.reason}`);
      issues.push({ text: `${what} not changed (${outcome.reason})`, fix: byHand });
    } else if (outcome?.kind === 'copy-not-ready') {
      line(ctx, `${what} not written: ${outcome.reason}`);
      issues.push({ text: `${what} waits for the hook copy`, fix: 'rarog hooks install, then rarog setup', copy: true });
    }
  }
  if (outcomes.get('statusLine')?.kind === 'unchanged' && statusLineScriptOutOfDate(ctx)) {
    line(ctx, 'the statusLine command points to the script copy, but the copy differs from the repo or is missing');
    issues.push({ text: 'status line script out of date', fix: 'rarog hooks doctor, then rarog hooks install' });
  }
  return issues;
}

/** `statusLine` in the settings runs the Rarog script copy, and that copy differs from this installation or is missing. */
export function statusLineScriptOutOfDate(ctx: Ctx): boolean {
  const command = statusLineCommand(ctx.home);
  return command !== null && isRarogStatuslineCommand(command) && !statuslineCopyReport(ctx.home, ctx.installRoot).ok;
}

/** Entries the write added, herdr's hook and the backup, in one phrase for the step line; '' = nothing added. */
function writtenText(count: number, herdr: boolean, backup: boolean): string {
  const parts = [...count === 0 ? [] : [`${String(count)} ${count === 1 ? 'entry' : 'entries'}`],
    ...herdr ? ['herdr\'s hook'] : []];
  if (parts.length === 0) return '';
  return `${parts.join(' and ')} added${backup ? ', backup kept' : ''}`;
}

/**
 * The phrases of a step line with issues: `head` (what was added), the entries waiting for the hook copy as one phrase
 * after it (`1 entry added, 3 wait for the hook copy`; a single one keeps its name), then every other issue.
 */
function issueTexts(head: string, issues: readonly Issue[]): string[] {
  const waiting = issues.filter((one) => one.copy === true);
  const group = waiting.length === 0 ? '' : waiting.length === 1 ? waiting[0]?.text ?? ''
    : `${String(waiting.length)} ${head === '' ? 'entries ' : ''}wait for the hook copy`;
  const first = [head, group].filter((one) => one !== '').join(', ');
  return [...first === '' ? [] : [first], ...issues.filter((one) => one.copy !== true).map((one) => one.text)];
}

/**
 * The `statusLine` operation would write a command pointing at the script copy, and that copy is missing or differs
 * (its planned outcome waits for the copy): only then does setup offer the missing script before this step. A custom
 * command that stays, or a command already in place, needs no copy from this step.
 */
export function statusLineWaitsForScript(ctx: Ctx): boolean {
  const planned = plannedOutcomes({
    home: ctx.home, root: ctx.installRoot, operations: ['statusLine'], dataDir: ctx.dataDir, again: 'rarog setup',
  });
  return planned?.get('statusLine')?.kind === 'copy-not-ready';
}

/** The step: one question, one Rarog write, then herdr's installer. */
export async function stepClaudeSettings(ctx: Ctx): Promise<Step> {
  const title = 'Settings';
  const integration = ctx.herdrIntegration;
  const herdr = ctx.herdr !== null && integration !== null
    && (integration.state === 'missing' || integration.state === 'other') ? ctx.herdr : null;
  if (integration !== null && herdr !== null) line(ctx, herdrIntegrationLine(integration));
  noteStatusLine(ctx);
  const batch = await writeClaudeSettingsBatch({
    home: ctx.home, root: ctx.installRoot, operations: SETTINGS_OPERATIONS, dataDir: ctx.dataDir,
    lock: { dir: rarogConfigDir(ctx.io.env), what: 'rarog setup' },
    confirm: ctx.ask === null ? null : async (question) => ask(ctx, question, herdr !== null),
    print: (text) => { line(ctx, text); },
    // The diff quotes the user's file: the screen with --verbose, never the run log.
    printDiff: (text) => { ctx.view.settingsDiff(`  ${text}`); },
    again: 'rarog setup',
  });
  const { outcomes, write } = batch;
  for (const operation of SETTINGS_OPERATIONS) {
    ctx.view.logOnly(logLine(operation, outcomes.get(operation), write.kind));
  }
  const changes = SETTINGS_OPERATIONS.filter((one) => outcomes.get(one)?.kind === 'change');
  switch (write.kind) {
    case 'refused':
      line(ctx, `~/.claude/settings.json not changed: ${write.reason}`);
      return { title, state: 'problem', summary: `Settings: not changed (${write.reason})` };
    case 'declined':
      return {
        title, state: 'missing', skipped: true, summary: `Settings: skipped (add by hand: ${BY_HAND})`,
      };
    case 'no-terminal': {
      const also = herdr === null ? '' : ` and herdr's hook (${HERDR_INTEGRATION_INSTALL})`;
      return {
        title, state: 'missing',
        summary: `Settings: ${String(changes.length)} Rarog ${changes.length === 1 ? 'entry' : 'entries'}${also}`
          + `: run rarog setup in a terminal (or add by hand: ${BY_HAND})`,
      };
    }
    case 'unchanged':
    case 'written':
      break;
    default:
      // Single-operation outcomes never stand for the whole write.
      return { title, state: 'problem', summary: `Settings: ${write.kind}` };
  }
  const issues = issuesOf(ctx, outcomes);
  let herdrDone = false;
  let herdrProblem: string | null = null;
  if (herdr !== null) {
    if (write.kind === 'unchanged' && ctx.ask === null) {
      issues.push({ text: `herdr's hook: run rarog setup in a terminal`, fix: 'rarog setup' });
    } else if (write.kind === 'written' || await ask(ctx, null, true)) {
      herdrProblem = herdrInstall(ctx, herdr);
      herdrDone = herdrProblem === null;
      if (herdrProblem !== null) line(ctx, `${HERDR_INTEGRATION_INSTALL}: ${herdrProblem}`);
    } else {
      return {
        title, state: 'missing', skipped: true,
        summary: `Settings: herdr's hook skipped (${HERDR_INTEGRATION_INSTALL})`,
      };
    }
  }
  const added = write.kind === 'written' ? changes.length : 0;
  const written = writtenText(added, herdrDone, write.kind === 'written' && write.backup !== null);
  // The backup stays in the summary and in the log line of the write (`backup: <file>`), not on the screen line.
  const shown = writtenText(added, herdrDone, false);
  const done = written === '' ? 'entries match' : written;
  const changed = write.kind === 'written' || herdrDone;
  if (issues.length === 0 && herdrProblem === null) {
    return { title, state: 'ok', summary: `Settings: ${done}`, result: shown === '' ? done : shown, changed };
  }
  // Every problem and every fix on the step line: an entry that did not go in and a failed herdr installer. What was
  // written still counts as a change under the `!`.
  const head = (text: string): string => (issues.length === 0 && text === '' ? 'entries match' : text);
  const herdrText = 'herdr\'s hook not added';
  const fixes = [...issues.map((one) => one.fix), ...herdrProblem === null ? [] : [HERDR_INTEGRATION_INSTALL]];
  return {
    title, state: issues.length > 0 ? 'missing' : 'warn',
    summary: `Settings: ${[...issueTexts(head(written), issues),
      ...herdrProblem === null ? [] : [`${herdrText} (${herdrProblem})`]].join('; ')}`,
    result: [...issueTexts(head(shown), issues), ...herdrProblem === null ? [] : [herdrText]].join('; '),
    fix: [...new Set(fixes)].join('; '),
    changed,
  };
}
