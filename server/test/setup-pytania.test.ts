/**
 * The questions of `rarog setup`: the plan screen asks `Continue? [Y/n]` once for what Rarog creates of its
 * own, the Settings step asks `[y/N/d]` once for the four Rarog entries and herdr's hook, and nothing asks about
 * project directories or the work area. Runs on the shared harness (`helpers/setup-harness.ts`).
 */
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SETTINGS_BACKUP_DIRNAME } from '../src/cli/claude-settings.ts';
import type { BatchQuestion } from '../src/cli/claude-settings.ts';
import { hooksCommand } from '../src/cli/hooks.ts';
import type { CliIo } from '../src/cli/io.ts';
import { configFileText } from '../src/cli/serve.ts';
import { visibleWidth } from '../src/cli/screen/style.ts';
import { KEY_PROMPT_NOTE } from '../src/cli/setup-screen.ts';
import { IROH_KEY_NOTE } from '../src/cli/setup-secrets.ts';
import { HERDR_DIFF_NOTE, SETTINGS_OPERATIONS, settingsNotes } from '../src/cli/setup-settings.ts';
import { TAILSCALE_ONLY_NOTES } from '../src/cli/setup-tailscale-only.ts';
import { AGENT_NOTE, AGENT_QUESTION, DICTATION_NOTE, DICTATION_QUESTION } from '../src/cli/setup-voice.ts';
import {
  HOOK_INSTALL_FILES, STATUSLINE_INSTALL_FILES, contextHookCommand, hookCommand, hookInstallDir, statuslineCommand,
  userSettingsPath,
} from '../src/herdr/hook-config.ts';
import {
  HAS_CHECKOUT, REPO, answers, bin, calls, checkoutOnly, configFile, copyHooks, dataDirOf, env, home,
  linuxInstalledButHerdrUnit, logs, markLoaded, plist, port, runSetup, state, stepLines, useSetupHarness,
  visibleLines, write, writeConfig, writeDump, writeSecrets, writeSettings,
} from './helpers/setup-harness.ts';
import type { KeyPrompt, VoiceAnswers } from './helpers/setup-harness.ts';
import { IS_MAC, macOnly } from './platform.ts';
import { fake, linuxSandbox } from './systemd-atrapy.ts';

useSetupHarness();

/** The step screen of a 60-column terminal without colour. */
const SCREEN = { verbose: false, terminal: { tty: true, columns: 60, color: false } } as const;

/** A settings file of the user in the writer's layout (no reformat clause in the question). */
const OPUS = `${JSON.stringify({ model: 'opus' }, null, 2)}\n`;

/** A foreign settings value that must never reach a log; not token-shaped on purpose. */
const MARKER = 'settings-file-content-never-in-a-log';

/** A machine with everything in place but the settings entries: config, secrets, hook and script copy, service. */
function installedButSettings(): void {
  writeConfig({ RAROG_ORIGINS: 'https://rarog.example.net', RAROG_PORT: String(port) });
  writeSecrets();
  copyHooks([...HOOK_INSTALL_FILES, ...STATUSLINE_INSTALL_FILES]);
  write(plist(), '<plist/>\n');
  markLoaded();
}

/**
 * A fake `herdr` whose Claude integration is `not installed` until `integration install claude` runs `install` (shell
 * lines, e.g. writing `current (v11)` to the state file, or failing).
 */
function herdrInstallable(install: readonly string[]): void {
  write(path.join(state, 'herdr-stan'), 'not installed\n');
  fake(path.join(bin, 'herdr'), [`printf '%s\\n' "$*" >> '${logs}/herdr'`,
    `if [ "$1 $2" = "integration status" ]; then printf 'claude: %s\\n' "$(cat '${state}/herdr-stan')"; exit 0; fi`,
    'if [ "$1 $2 $3" = "integration install claude" ]; then', ...install.map((one) => `  ${one}`), 'fi', 'exit 0']);
}

/** The install that makes the integration current. */
const herdrOk = (): readonly string[] => [`echo 'current (v11)' > '${state}/herdr-stan'`];
const herdrInstalls = (): string[] => calls('herdr').filter((one) => one.startsWith('integration install'));
const backups = (): string[] => {
  const dir = path.join(dataDirOf(), SETTINGS_BACKUP_DIRNAME);
  return existsSync(dir) ? readdirSync(dir) : [];
};
const logDir = (): string => path.join(dataDirOf(), 'logs');
const logText = (): string => (existsSync(logDir())
  ? readdirSync(logDir()).map((name) => readFileSync(path.join(logDir(), name), 'utf8')).join('\n') : '');

describe.skipIf(!IS_MAC)(macOnly('rarog setup: the plan screen and the questions', 'launchd'), () => {
  it.skipIf(!HAS_CHECKOUT)(checkoutOnly('a fresh HOME without tailscale: "Continue?", the dictation question, then settings; home as root'), async () => {
    rmSync(path.join(bin, 'tailscale'));
    const run = await runSetup(SCREEN);
    expect(run.asked).toEqual(['continue', 'dictation', 'settings']);
    expect(run.stdout).toContain('? Continue? [Y/n] ');
    expect(run.stdout).toContain('Work area: home (RAROG_PROJECT_ROOTS in config.json).');
    const config = JSON.parse(readFileSync(configFile(), 'utf8')) as { env: Record<string, string> };
    expect(config.env['RAROG_PROJECT_ROOTS']).toBe(home);
    expect(config.env['RAROG_HERDR_ROOTS']).toBe(home);
    const settings = readFileSync(userSettingsPath(home), 'utf8');
    for (const one of [hookCommand(home), contextHookCommand(home), statuslineCommand(home), 'denyRead']) {
      expect(settings).toContain(JSON.stringify(one).slice(1, -1));
    }
  });

  it('an existing config.json with narrow roots: no question about directories, the file byte for byte', async () => {
    const text = configFileText({ version: 1, env: {
      RAROG_ORIGINS: 'https://rarog.example.net', RAROG_PORT: String(port),
      RAROG_PROJECT_ROOTS: path.join(home, 'Projects'), RAROG_HERDR_ROOTS: path.join(home, 'Projects'),
    } });
    installedButSettings();
    write(configFile(), text, 0o600);
    writeSettings(statuslineCommand(home), home, { denyRead: true });
    const run = await runSetup(SCREEN);
    expect(run.asked).toEqual([]);
    expect(readFileSync(configFile(), 'utf8')).toBe(text);
    expect(run.code).toBe(0);
  });

  for (const reply of ['n', null] as const) {
    it(`${reply === null ? 'EOF' : '"n"'} on "Continue?": no config.json, no hook copy, no log directory, code 1`, async () => {
      const run = await runSetup({ ...SCREEN, answer: () => reply });
      expect(run.asked).toEqual(['tailscale-only', 'continue']);
      expect(existsSync(configFile())).toBe(false);
      expect(existsSync(path.join(home, '.claude', 'hooks', 'rarog'))).toBe(false);
      expect(existsSync(logDir())).toBe(false);
      // The refusal of the plan is the one sentence.
      expect(run.stdout).toMatch(/(?:^|\] )Nothing changed\.\n$/mu);
      expect(run.stdout).not.toContain('step by step');
      expect(run.code).toBe(1);
    });
  }

  it('settings "d": the Rarog diff and the herdr sentence, then the same question; "y": one write, one backup, herdr', async () => {
    installedButSettings();
    write(userSettingsPath(home), OPUS);
    herdrInstallable(herdrOk());
    const run = await runSetup({ ...SCREEN, answer: answers({ settings: ['d', 'y'] }) });
    expect(run.asked).toEqual(['settings', 'settings']);
    const prompts = run.stdout.split('? Add ');
    expect(prompts).toHaveLength(3);
    const [, first = '', second = ''] = prompts;
    const question = first.slice(0, first.indexOf('[y/N/d] ')).replace(/\s+/gu, ' ');
    // The count, herdr's hook and the file; the names of the entries only under `d`, no backup sentence.
    expect(question).toBe('5 Rarog entries and herdr\'s hook to ~/.claude/settings.json? ');
    expect(second.replace(/\s+/gu, ' ').startsWith(question)).toBe(true);
    const shown = first.slice(first.indexOf('[y/N/d] '));
    expect(shown).toContain('  5 Rarog entries: permission and context hooks, status line, sandbox read block,'
      + ' state write block\n');
    expect(shown).toContain('+++ ');
    expect(shown.replace(/\s+/gu, ' ')).toContain(HERDR_DIFF_NOTE);
    expect(backups()).toHaveLength(1);
    const settings = readFileSync(userSettingsPath(home), 'utf8');
    for (const one of [hookCommand(home), contextHookCommand(home), statuslineCommand(home)]) {
      expect(settings).toContain(JSON.stringify(one).slice(1, -1));
    }
    expect(settings).toContain('"model": "opus"');
    expect(herdrInstalls()).toEqual(['integration install claude']);
    expect(run.code).toBe(0);
  });

  it('settings "n": the file byte for byte, no herdr call, the step skipped with the way by hand', async () => {
    installedButSettings();
    write(userSettingsPath(home), OPUS);
    herdrInstallable(herdrOk());
    const run = await runSetup({ ...SCREEN, answer: answers({ settings: ['n'] }) });
    expect(run.asked).toEqual(['settings']);
    expect(readFileSync(userSettingsPath(home), 'utf8')).toBe(OPUS);
    expect(backups()).toEqual([]);
    expect(herdrInstalls()).toEqual([]);
    expect(run.stdout).toMatch(/– Settings +skipped \(add by hand: rarog hooks print\)/u);
    expect(run.code).toBe(1);
  });

  it.skipIf(!HAS_CHECKOUT)(checkoutOnly('the statusLine script copy written, settings "n": no "nothing changed" line'), async () => {
    writeConfig({ RAROG_ORIGINS: 'https://rarog.example.net', RAROG_PORT: String(port) });
    writeSecrets();
    copyHooks(HOOK_INSTALL_FILES);
    // The service starts this installation, so setup may write the script copy (a bare plist would refuse it).
    write(plist(), '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>Label</key>'
      + '<string>ai.rarog.server</string><key>ProgramArguments</key><array><string>/opt/n/bin/node</string>'
      + `<string>${path.join(REPO, 'bin', 'rarog.mjs')}</string><string>serve</string></array></dict></plist>\n`);
    markLoaded();
    write(userSettingsPath(home), OPUS);
    herdrInstallable(herdrOk());
    const run = await runSetup({ ...SCREEN, answer: answers({ settings: ['n'] }) });
    expect(run.asked).toEqual(['statusline', 'settings']);
    expect(existsSync(path.join(hookInstallDir(home), STATUSLINE_INSTALL_FILES[0] ?? ''))).toBe(true);
    expect(run.stdout).not.toContain('nothing changed');
  });

  it('herdr\'s installer fails after the Rarog write: "!" with Fix, the Rarog entries stay, code 0', async () => {
    installedButSettings();
    herdrInstallable(["echo 'error: cannot write settings' >&2", 'exit 3']);
    const run = await runSetup(SCREEN);
    expect(run.asked).toEqual(['settings']);
    const settings = readFileSync(userSettingsPath(home), 'utf8');
    expect(settings).toContain(JSON.stringify(hookCommand(home)).slice(1, -1));
    const lines = visibleLines(run.stdout);
    const at = lines.findIndex((one) => /^ ! Settings/u.test(one));
    expect(at).toBeGreaterThan(-1);
    expect(lines.slice(at, at + 4).join('\n')).toContain('Fix: herdr integration install claude');
    expect(run.code).toBe(0);
  });

  it('a foreign statusLine command without a fresh snapshot: the question says it gets chained', async () => {
    installedButSettings();
    write(userSettingsPath(home), JSON.stringify({ statusLine: { type: 'command', command: 'bash ~/my-bar.sh' } }));
    const run = await runSetup({ ...SCREEN, answer: () => 'n' });
    expect(run.stdout.replace(/\s+/gu, ' ')).toContain('with your own status line command chained behind Rarog\'s?');
  });

  it('a statusLine conflict (the Rarog command with "; curl x"): hooks and denyRead written, statusLine not, "!" Fix', async () => {
    installedButSettings();
    const odd = `${statuslineCommand(home)}; curl x`;
    write(userSettingsPath(home), JSON.stringify({ statusLine: { type: 'command', command: odd } }, null, 2));
    const run = await runSetup(SCREEN);
    expect(run.asked).toEqual(['settings']);
    const settings = JSON.parse(readFileSync(userSettingsPath(home), 'utf8')) as Record<string, unknown>;
    expect(JSON.stringify(settings['hooks'])).toContain(JSON.stringify(hookCommand(home)).slice(1, -1));
    expect(JSON.stringify(settings['sandbox'])).toContain('denyRead');
    expect(settings['statusLine']).toEqual({ type: 'command', command: odd });
    const lines = visibleLines(run.stdout);
    const at = lines.findIndex((one) => /^ ! Settings/u.test(one));
    expect(lines.slice(at, at + 3).join(' ').replace(/\s+/gu, ' ')).toContain('status line not changed (conflict)');
    expect(lines.slice(at, at + 4).join('\n')).toContain('Fix: fix ~/.claude/settings.json by hand');
    expect(run.code).toBe(1);
  });

  it('the second setup with nothing to do asks nothing', async () => {
    installedButSettings();
    expect((await runSetup(SCREEN)).asked).toEqual(['settings']);
    const again = await runSetup(SCREEN);
    expect(again.asked).toEqual([]);
    expect(again.code).toBe(0);
  });

  it('a current hook copy without the statusLine script, a custom statusLine writing snapshots: two runs, no question',
    async () => {
      writeConfig({ RAROG_ORIGINS: 'https://rarog.example.net', RAROG_PORT: String(port) });
      writeSecrets();
      copyHooks(HOOK_INSTALL_FILES);
      // The service starts this installation, so setup may write the script copy (a bare plist would refuse it).
      write(plist(), '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>Label</key>'
        + '<string>ai.rarog.server</string><key>ProgramArguments</key><array><string>/opt/n/bin/node</string>'
        + `<string>${path.join(REPO, 'bin', 'rarog.mjs')}</string><string>serve</string></array></dict></plist>\n`);
      markLoaded();
      writeSettings('bash ~/my-bar.sh', home, { denyRead: true });
      writeDump(60_000);
      for (const _run of [1, 2]) {
        const run = await runSetup({ ...SCREEN, answer: () => 'n' });
        expect(run.asked).toEqual([]);
      }
      expect(existsSync(path.join(hookInstallDir(home), STATUSLINE_INSTALL_FILES[0] ?? ''))).toBe(false);
    });

  it('all entries in place and herdr current: the step says "entries match"', async () => {
    installedButSettings();
    writeSettings(statuslineCommand(home), home, { denyRead: true });
    herdrInstallable([]);
    write(path.join(state, 'herdr-stan'), 'current (v11)\n');
    const run = await runSetup(SCREEN);
    expect(run.asked).toEqual([]);
    // An unchanged step has no line of its own, only the one line before Check.
    expect(stepLines(visibleLines(run.stdout), 'Settings')).toBe('(no line of Settings)');
    expect(visibleLines(run.stdout)).toContainEqual(expect.stringMatching(/^ ✓ [0-9]+ checks ok, nothing changed$/u));
    expect(herdrInstalls()).toEqual([]);
  });

  it('a statusLine conflict and a failing herdr installer: both problems and both fixes on the step line', async () => {
    installedButSettings();
    const odd = `${statuslineCommand(home)}; curl x`;
    write(userSettingsPath(home), JSON.stringify({ statusLine: { type: 'command', command: odd } }, null, 2));
    herdrInstallable(["echo 'error: cannot write settings' >&2", 'exit 3']);
    const run = await runSetup(SCREEN);
    expect(run.asked).toEqual(['settings']);
    expect(herdrInstalls()).toEqual(['integration install claude']);
    const block = stepLines(visibleLines(run.stdout), 'Settings');
    expect(block).toMatch(/^ ! Settings/u);
    expect(block).toContain('status line not changed (conflict)');
    expect(block).toContain('herdr\'s hook not added');
    const fix = block.slice(block.indexOf('Fix:'));
    expect(fix).toContain('fix ~/.claude/settings.json by hand');
    expect(fix).toContain('herdr integration install claude');
  });

  for (const reply of ['y', 'n', 'd'] as const) {
    it(`a foreign settings value never reaches the run log after "${reply}"`, async () => {
      writeConfig({ RAROG_ORIGINS: 'https://rarog.example.net', RAROG_PORT: String(port) });
      writeSecrets();
      copyHooks([...HOOK_INSTALL_FILES, ...STATUSLINE_INSTALL_FILES]);
      // One line, so the whole file is one changed line of the diff.
      write(userSettingsPath(home), JSON.stringify({ env: { SOME_TOKEN: MARKER } }));
      // The missing service puts "Continue?" first, so the log file exists before the settings question.
      const run = await runSetup({
        verbose: false, answer: answers({ settings: reply === 'd' ? ['d', 'n'] : [reply] }),
      });
      expect(run.asked[0]).toBe('continue');
      expect(readdirSync(logDir()).length).toBeGreaterThan(0);
      if (reply === 'd') expect(run.stdout).toContain(MARKER);
      expect(logText()).not.toContain(MARKER);
      expect(logText()).toContain('claude settings: permission');
    });
  }
});

describe('rarog setup on Linux: the herdr unit, an item of the plan', () => {
  it('"y" writes herdr.service; the second setup asks nothing and leaves the file byte for byte', async () => {
    const sb = linuxSandbox('rsp-');
    try {
      linuxInstalledButHerdrUnit(sb, path.join(sb.homeDir, 'hs.sock'));
      const linux = { ...SCREEN, env: sb.env(), platform: 'linux' } as const;
      const first = await runSetup({ ...linux, answer: answers({ continue: ['y'] }) });
      expect(first.asked).toEqual(['continue']);
      const unit = path.join(sb.homeDir, '.config', 'systemd', 'user', 'herdr.service');
      const written = readFileSync(unit, 'utf8');
      const again = await runSetup({ ...linux, answer: answers({}) });
      expect(again.asked).toEqual([]);
      expect(readFileSync(unit, 'utf8')).toBe(written);
      // The file is there, not enabled: the state check of an existing unit says what to run.
      expect(stepLines(visibleLines(again.stdout), 'herdr unit')).toContain('systemctl --user enable --now herdr.service');
    } finally {
      sb.cleanup();
    }
  });
});

describe('rarog hooks print: all four entries', () => {
  it('hooks, SessionStart, statusLine and the denyRead paths in one block', async () => {
    let stdout = '';
    const io: CliIo = { stdout: (text) => { stdout += text; }, stderr: (text) => { stdout += text; }, env: env(), cwd: home };
    expect(await hooksCommand(['print'], io, 'usage', 64)).toBe(0);
    for (const one of ['"PermissionRequest"', '"PreToolUse"', '"SessionStart"', '"statusLine"', '"denyRead"']) {
      expect(stdout).toContain(one);
    }
    expect(stdout).toContain(JSON.stringify(statuslineCommand(home)).slice(1, -1));
  });
});

/** A question of the settings step with these operations (only `changes` decides the explanation). */
const batchOf = (changes: BatchQuestion['changes']): BatchQuestion =>
  ({ changes, chains: false, reformatted: false, newFile: false, diff: [] });

/**
 * Every question of `rarog setup` a user may not understand has a short explanation right above it, and the first key
 * prompt one about the hidden input; the questions themselves are unchanged.
 */
describe('rarog setup: what each question is for', () => {
  const ALL_NOTES = [
    DICTATION_NOTE, AGENT_NOTE, KEY_PROMPT_NOTE, IROH_KEY_NOTE, ...settingsNotes(batchOf(SETTINGS_OPERATIONS)),
    ...settingsNotes(null), ...TAILSCALE_ONLY_NOTES,
  ];

  it('each explanation is one line narrower than a 60-column terminal, so it leaves the screen with its question', () => {
    for (const note of ALL_NOTES) expect(visibleWidth(`  ${note}`), note).toBeLessThan(60);
  });

  it('the settings question: two lines with the permission entries, one without them, none for a removal', () => {
    expect(settingsNotes(batchOf(SETTINGS_OPERATIONS))).toHaveLength(2);
    expect(settingsNotes(null)).toHaveLength(2);
    expect(settingsNotes(null)[0]).not.toBe(settingsNotes(batchOf(SETTINGS_OPERATIONS))[0]);
    expect(settingsNotes(batchOf(['statusLine']))).toEqual(settingsNotes(batchOf(SETTINGS_OPERATIONS)).slice(1));
    expect(settingsNotes(batchOf(['remove']))).toEqual([]);
  });

  describe.skipIf(!IS_MAC)(macOnly('the first setup in a terminal', 'launchd'), () => {
    const BOTH: VoiceAnswers = {
      dictation: 'y', agent: 'y', key: (prompt: KeyPrompt) => (prompt === 'soniox-key' ? 'SONIOX-X' : 'sk-test-X'),
    };
    /** A first setup with "y" everywhere, in a 60-column terminal that keeps its questions (no live columns). */
    const firstSetup = (color: boolean) => runSetup({
      ...SCREEN, terminal: { tty: true, columns: 60, color }, echo: true, voice: BOTH,
      answer: answers({}),
    });
    /** The lines right above the first screen line that starts with `start`. */
    const above = (lines: readonly string[], start: string, count: number): string[] => {
      const at = lines.findIndex((one) => one.startsWith(start));
      expect(at, `${start}\n${lines.join('\n')}`).toBeGreaterThan(count - 1);
      return lines.slice(at - count, at);
    };

    it.skipIf(!HAS_CHECKOUT)(checkoutOnly('each explanation stands right above its question; the key one once, above the first key prompt'), async () => {
      rmSync(path.join(bin, 'tailscale'));
      const run = await firstSetup(false);
      expect(run.asked).toEqual(['continue', 'dictation', 'soniox-key', 'agent', 'openai-key', 'settings']);
      const lines = visibleLines(run.stdout);
      expect(above(lines, '? Continue?', 1)[0]).not.toMatch(/^ {2}\S/u);
      expect(above(lines, `? ${DICTATION_QUESTION}`, 1)).toEqual([`  ${DICTATION_NOTE}`]);
      expect(above(lines, '? Soniox', 1)).toEqual([`  ${KEY_PROMPT_NOTE}`]);
      expect(above(lines, `? ${AGENT_QUESTION}`, 1)).toEqual([`  ${AGENT_NOTE}`]);
      expect(above(lines, '? OpenAI', 1)).not.toEqual([`  ${KEY_PROMPT_NOTE}`]);
      expect(lines.filter((one) => one === `  ${KEY_PROMPT_NOTE}`)).toHaveLength(1);
      expect(above(lines, '? Add ', 2)).toEqual(settingsNotes(batchOf(SETTINGS_OPERATIONS)).map((one) => `  ${one}`));
    });

    it('without colour not a single escape byte on their lines', async () => {
      rmSync(path.join(bin, 'tailscale'));
      const mono = await firstSetup(false);
      const noted = mono.stdout.split('\n').filter((one) => ALL_NOTES.some((note) => one.includes(note)));
      expect(noted.length).toBeGreaterThan(0);
      // The clear of the live line (`ESC[2K`) before each line is the screen's, not the explanation's.
      for (const one of noted) expect(one.split('\r').at(-1)?.replace(/^\x1b\[2K/u, '')).not.toContain('\x1b');
    });

    it.skipIf(!HAS_CHECKOUT)(checkoutOnly('cyan on a terminal with colour'), async () => {
      rmSync(path.join(bin, 'tailscale'));
      // "n" to dictation: the harness reads a key prompt without colour.
      const color = await runSetup({
        ...SCREEN, terminal: { tty: true, columns: 60, color: true }, echo: true, answer: answers({}),
      });
      for (const note of [DICTATION_NOTE, ...settingsNotes(batchOf(SETTINGS_OPERATIONS))]) {
        expect(color.stdout).toContain(`\x1b[36m  ${note}\x1b[39m`);
      }
    });

    it('without a terminal: no question, so no explanation on the screen or in the log', async () => {
      rmSync(path.join(bin, 'tailscale'));
      const run = await runSetup({ ...SCREEN, answer: null, terminal: undefined });
      expect(run.asked).toEqual([]);
      for (const note of ALL_NOTES) {
        expect(run.stdout).not.toContain(note);
        expect(logText()).not.toContain(note);
      }
    });

    it('the iroh key question of an existing config.json has its explanation right above it', async () => {
      writeConfig({ RAROG_IROH: '1' });
      const run = await runSetup({ ...SCREEN, echo: true, answer: answers({ key: ['n'] }) });
      expect(run.asked).toContain('key');
      expect(above(visibleLines(run.stdout), '? Create the iroh', 1)).toEqual([`  ${IROH_KEY_NOTE}`]);
    });
  });
});
