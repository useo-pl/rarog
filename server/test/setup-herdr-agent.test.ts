/**
 * `rarog setup`, the herdr agent step on macOS (`setup-herdr-agent.ts`): the plist from its template (through the real
 * `plutil`), the `launchctl print` fields the step reads, then the step itself on the shared harness with the fake
 * `launchctl` (`helpers/setup-harness.ts`): the agent is an item of the plan screen, so setup writes it only after "y"
 * to `Continue?`, with no question of its own; it loads it only while herdr is down and waits for herdr's ping;
 * it never overwrites, unloads or restarts an agent. Also the doctor line and the command that starts herdr through a
 * loaded agent.
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { CliIo } from '../src/cli/io.ts';
import { Refusal } from '../src/cli/io.ts';
import {
  HERDR_AGENT_LABEL, herdrAgentDoctorLine, herdrAgentPlistPath, herdrAgentStart, parseAgentPrint,
  renderHerdrAgentPlist,
} from '../src/cli/setup-herdr-agent.ts';
import { PLAN_DECLINED } from '../src/cli/setup-plan.ts';
import { rarogCli } from '../src/install/repair.ts';
import {
  answers, bin, calls, configFile, dataDirOf, env, home, listenHerdr, loadHerdrAgent, macInstalled, removeHerdrAgent,
  runSetup, setHealthBody, state, stepLines, t, useSetupHarness, visibleLines, writeConfig,
  writeHerdrAgent,
} from './helpers/setup-harness.ts';
import type { Question, Result, RunOptions } from './helpers/setup-harness.ts';
import { IS_MAC, macOnly } from './platform.ts';

useSetupHarness();

const UID = String(process.getuid?.() ?? 0);
const TARGET = `gui/${UID}/${HERDR_AGENT_LABEL}`;
const AGENT_FILE = '~/Library/LaunchAgents/ai.rarog.herdr.plist';
const ROOT = process.getuid?.() === 0;

/** The plist as a JSON object, through the real `plutil`. */
function plistJson(file: string): Record<string, unknown> {
  const converted = spawnSync('plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' });
  expect(converted.status, converted.stderr).toBe(0);
  return JSON.parse(converted.stdout) as Record<string, unknown>;
}

describe.skipIf(!IS_MAC)(macOnly('herdr agent: the plist from its template', 'plutil'), () => {
  const write = (text: string): string => {
    const file = path.join(t.home, 'agent.plist');
    writeFileSync(file, text);
    expect(spawnSync('plutil', ['-lint', file], { encoding: 'utf8' }).status).toBe(0);
    return file;
  };

  it('herdr\'s default socket: no EnvironmentVariables, no KeepAlive, herdr server once at load', () => {
    const file = write(renderHerdrAgentPlist({ herdr: '/opt/herdr/bin/herdr', home: '/Users/u', socket: null }));
    expect(plistJson(file)).toEqual({
      Label: HERDR_AGENT_LABEL, ProgramArguments: ['/opt/herdr/bin/herdr', 'server'], WorkingDirectory: '/Users/u',
      RunAtLoad: true, ProcessType: 'Interactive', StandardOutPath: '/Users/u/Library/Logs/rarog-herdr.log',
      StandardErrorPath: '/Users/u/Library/Logs/rarog-herdr.log',
    });
  });

  it('another socket: HERDR_SOCKET_PATH alone; XML characters and a field name in a value come through unchanged', () => {
    const herdr = '/Users/u/A & <B>/{{HOME}}/herdr';
    const socket = '/Users/u/"s\'ock".sock';
    const file = write(renderHerdrAgentPlist({ herdr, home: '/Users/u', socket }));
    const json = plistJson(file);
    expect(json['EnvironmentVariables']).toEqual({ HERDR_SOCKET_PATH: socket });
    expect(json['ProgramArguments']).toEqual([herdr, 'server']);
    expect(json['WorkingDirectory']).toBe('/Users/u');
  });

  it('a control character XML cannot carry: a refusal, no plist', () => {
    expect(() => renderHerdrAgentPlist({ herdr: '/a\u0001b/herdr', home: '/Users/u', socket: null })).toThrow(Refusal);
  });
});

describe('herdr agent: fields of launchctl print', () => {
  it('pid and last exit code of the service itself; deeper blocks do not count', () => {
    expect(parseAgentPrint(`${TARGET} = {\n\tstate = running\n\tpid = 71716\n\tlast exit code = (never exited)\n}\n`))
      .toEqual({ pid: '71716', lastExit: '(never exited)' });
    expect(parseAgentPrint(`${TARGET} = {\n\tstate = not running\n\tlast exit code = 1\n\tendpoints = {\n`
      + '\t\tpid = 9\n\t}\n}\n')).toEqual({ pid: null, lastExit: '1' });
  });
});

describe.skipIf(!IS_MAC)(macOnly('rarog setup: the herdr agent step', 'launchd'), () => {
  const socket = (): string => path.join(home, '.config', 'herdr', 'herdr.sock');
  const agentFile = (): string => herdrAgentPlistPath(home);
  const expectedPlist = (): string => renderHerdrAgentPlist({ herdr: path.join(bin, 'herdr'), home, socket: null });
  const again = rarogCli('setup');

  beforeEach(() => {
    macInstalled();
    removeHerdrAgent();
  });

  /** The step screen of a 60-column terminal without colour. */
  const onScreen = (
    answer: RunOptions['answer'], deps: RunOptions['deps'] = {},
  ): Promise<Result> => runSetup({
    verbose: false, terminal: { tty: true, columns: 60, color: false }, answer, deps,
  });
  /** The step's line and its Fix, without the run log's `Log:` line that may follow the last one with a fix. */
  const stepOf = (run: Result, title = 'herdr agent'): string =>
    stepLines(visibleLines(run.stdout), title).replace(/ Log: \S+$/u, '');
  /** What setup asked launchd beyond `print`. */
  const changes = (): string[] => calls('launchctl').filter((one) => !one.startsWith('print '));
  /** The herdr agent's line of the plan screen: what and where, nothing about the folder window of macOS. */
  const PLAN_LINE = '  • herdr agent            ~/Library/LaunchAgents';
  const TCC = 'macOS may ask once to let herdr into folders such as Documents';
  /** The run logs of setup, with their text. */
  const logText = (): string => {
    const dir = path.join(dataDirOf(), 'logs');
    return existsSync(dir) ? readdirSync(dir).map((name) => readFileSync(path.join(dir, name), 'utf8')).join('\n') : '';
  };

  /** Starts herdr `delayMs` after setup's `launchctl bootstrap`: answering pings, or only accepting connections. */
  function herdrAfterBootstrap(delayMs: number, ping: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + 20_000;
      const poll = setInterval(() => {
        if (calls('launchctl').some((one) => one.startsWith('bootstrap '))) {
          clearInterval(poll);
          setTimeout(() => { listenHerdr(socket(), { ping }).then(resolve, reject); }, delayMs);
        } else if (Date.now() > deadline) {
          clearInterval(poll);
          resolve();
        }
      }, 20);
    });
  }

  it('the step has its own line and number: [7/10] on the screen without a terminal', async () => {
    const run = await runSetup({ verbose: false, answer: null });
    expect(run.stdout).toMatch(/^\[7\/10\] warn +herdr agent: no agent; rarog setup in a terminal writes it$/mu);
    expect(run.stdout).toMatch(/^\[10\/10\] ok +Check: /mu);
    expect(run.stdout).not.toContain('/9]');
  });

  it('no agent, herdr not running: an item of the plan, "y" to Continue? writes the plist 0644, bootstrap, herdr answers'
    + ' later than one ping → ✓ herdr started', async () => {
      const started = herdrAfterBootstrap(600, true);
      const run = await onScreen(answers({ continue: ['y'] }), { herdrStartTimeoutMs: 10_000 });
      await started;
      // The plan question alone: the step has no question of its own.
      expect(run.asked).toEqual(['continue']);
      const screen = visibleLines(run.stdout);
      expect(screen).toContain('Rarog will set up on this Mac:');
      expect(screen).toContain(PLAN_LINE);
      expect(run.stdout).not.toContain('[y/N/d]');
      expect(run.stdout).not.toContain(TCC);
      expect(readFileSync(agentFile(), 'utf8')).toBe(expectedPlist());
      expect(statSync(agentFile()).mode & 0o777).toBe(0o644);
      expect(spawnSync('plutil', ['-lint', agentFile()]).status).toBe(0);
      // Only the plist and the service's: the temporary file of the write is gone.
      expect(readdirSync(path.dirname(agentFile())).sort()).toEqual(['ai.rarog.herdr.plist', 'ai.rarog.server.plist']);
      expect(changes()).toEqual([`bootstrap gui/${UID} ${agentFile()}`]);
      expect(stepOf(run)).toMatch(/^ ✓ herdr agent herdr started( [0-9]+ s)?$/u);
      // herdr runs before the Service step reads /health: no false failure there.
      expect(stepOf(run, 'Service')).toBe('(no line of Service)');
      expect(run.code).toBe(0);
      expect(run.stdout).not.toContain('<key>Label</key>');
      // The plist and the folder window of macOS: the run log.
      expect(logText()).toContain('<key>Label</key>');
      expect(logText()).toContain(TCC);
    });

  it('herdr accepts connections but never answers: "!" after the ceiling, the log in Fix', async () => {
    const started = herdrAfterBootstrap(0, false);
    const run = await onScreen(answers({}), { herdrStartTimeoutMs: 1500 });
    await started;
    expect(existsSync(agentFile())).toBe(true);
    expect(stepOf(run)).toMatch(new RegExp(`^ ! herdr agent started, herdr does not answer( [0-9]+ s)? Fix: check`
      + ` ~/Library/Logs/rarog-herdr\\.log, then ${again}$`, 'u'));
    expect(run.code).toBe(1);
  });

  it('herdr already running, "y" to the plan: the plist without bootstrap, ✓ starts at next login', async () => {
    await listenHerdr(socket());
    const run = await onScreen(answers({ continue: ['y'] }));
    expect(run.asked).toEqual(['continue']);
    expect(visibleLines(run.stdout)).toContain(PLAN_LINE);
    expect(readFileSync(agentFile(), 'utf8')).toBe(expectedPlist());
    expect(changes()).toEqual([]);
    expect(stepOf(run)).toBe(' ✓ herdr agent written, starts at next login');
    expect(run.code).toBe(0);
  });

  it('a second setup after the write: no question, no line, nothing written', async () => {
    await listenHerdr(socket());
    await onScreen(answers({}));
    // launchd loads the agent at the next login; herdr runs from it.
    loadHerdrAgent('running');
    const before = readFileSync(agentFile(), 'utf8');
    const run = await onScreen(answers({}));
    expect(run.asked).toEqual([]);
    expect(stepOf(run)).toBe('(no line of herdr agent)');
    expect(readFileSync(agentFile(), 'utf8')).toBe(before);
    expect(run.code).toBe(0);
  });

  it('the plan question has no "d": [Y/n]; the written plist goes to the run log, to the screen with --verbose',
    async () => {
      await listenHerdr(socket());
      const run = await onScreen(answers({}));
      expect(run.stdout).toContain('? Continue? [Y/n] ');
      expect(run.stdout).not.toContain('<key>Label</key>');
      for (const one of expectedPlist().split('\n').filter((text) => text.trim() !== '')) {
        expect(logText()).toContain(`${one}\n`);
      }
      removeHerdrAgent();
      const verbose = await runSetup({ answer: answers({}) });
      expect(verbose.asked).toEqual(['continue']);
      for (const one of expectedPlist().split('\n').filter((text) => text.trim() !== '')) {
        expect(verbose.stdout).toContain(`${one}\n`);
      }
    });

  for (const [name, answer] of [['"n"', 'n'], ['EOF (Ctrl-D)', null]] as const) {
    it(`${name} on a plan of the agent alone: no plist, no bootstrap, "–" without a Fix, the run goes on`, async () => {
      const run = await onScreen((question: Question) => (question === 'continue' ? answer : 'y'));
      expect(run.asked).toEqual(['continue']);
      expect(existsSync(agentFile())).toBe(false);
      expect(changes()).toEqual([]);
      expect(stepOf(run)).toBe(' – herdr agent not written');
      expect(run.stdout).not.toContain(PLAN_DECLINED);
      expect(visibleLines(run.stdout).some((one) => one.startsWith('Done in '))).toBe(true);
      expect(run.code).toBe(0);
    });
  }

  it('"n" on a plan with another item too: Nothing changed., code 1, no plist and no step', async () => {
    rmSync(configFile());
    const run = await onScreen(answers({ continue: ['n'] }));
    expect(run.asked).toEqual(['tailscale-only', 'continue']);
    expect(visibleLines(run.stdout)).toContain(PLAN_LINE);
    expect(run.stdout).toContain(PLAN_DECLINED);
    expect(stepOf(run)).toBe('(no line of herdr agent)');
    expect(existsSync(agentFile())).toBe(false);
    expect(existsSync(configFile())).toBe(false);
    expect(changes()).toEqual([]);
    expect(run.code).toBe(1);
  });

  it('no terminal: no question, no plist, no bootstrap; with herdr running "–"', async () => {
    const run = await runSetup({ verbose: false, answer: null });
    expect(existsSync(agentFile())).toBe(false);
    expect(changes()).toEqual([]);
    expect(run.code).toBe(1);
    await listenHerdr(socket());
    const alive = await runSetup({ verbose: false, answer: null });
    expect(alive.stdout).toMatch(/^\[7\/10\] skip +herdr agent: no agent; rarog setup in a terminal writes it$/mu);
    expect(existsSync(agentFile())).toBe(false);
    expect(changes()).toEqual([]);
  });

  /** Verdicts on an existing agent: no question and nothing but `launchctl print` in any of them. */
  const existing: readonly {
    readonly name: string;
    readonly arrange: () => void | Promise<void>;
    readonly line: string;
  }[] = [
    {
      name: 'loaded and running: ✓, no line on the screen',
      arrange: () => { writeHerdrAgent(); },
      line: '(no line of herdr agent)',
    },
    {
      name: 'present, not loaded, herdr running: "–" starts at next login',
      arrange: async () => {
        writeHerdrAgent({ load: 'absent' });
        await listenHerdr(socket());
      },
      line: ' – herdr agent starts at next login',
    },
    {
      name: 'present, not loaded, herdr not running: "!" with launchctl bootstrap',
      arrange: () => { writeHerdrAgent({ load: 'absent' }); },
      line: ` ! herdr agent not loaded, herdr is not running Fix: launchctl bootstrap gui/${UID} ${AGENT_FILE},`
        + ` then ${again}`,
    },
    {
      name: 'loaded without a process, herdr not running: "!" with launchctl kickstart',
      arrange: () => { writeHerdrAgent({ load: 'stopped' }); },
      line: ` ! herdr agent herdr is not running Fix: launchctl kickstart ${TARGET}, then ${again}`,
    },
    {
      name: 'loaded without a process, herdr running: "–" herdr runs outside the agent',
      arrange: async () => {
        writeHerdrAgent({ load: 'stopped' });
        await listenHerdr(socket());
      },
      line: ' – herdr agent herdr runs outside the agent',
    },
    {
      name: 'its socket is not the one in config.json: "!" with bootout and rm',
      arrange: () => { writeHerdrAgent({ socket: path.join(t.home, 'other.sock') }); },
      line: ` ! herdr agent its herdr socket is not the one in config.json Fix: launchctl bootout ${TARGET} && rm`
        + ` ${AGENT_FILE}, then ${again}`,
    },
  ];
  for (const one of existing) {
    it(one.name, async () => {
      await one.arrange();
      const before = existsSync(agentFile()) ? readFileSync(agentFile(), 'utf8') : null;
      const run = await onScreen(answers({}));
      expect(run.asked).toEqual([]);
      expect(stepOf(run)).toBe(one.line);
      expect(changes()).toEqual([]);
      expect(existsSync(agentFile()) ? readFileSync(agentFile(), 'utf8') : null).toBe(before);
    });
  }

  it('its herdr is gone: "!", the Fix unloads the old definition first, the log says why; nothing changed', async () => {
    const gone = path.join(t.home, 'gone', 'herdr');
    writeHerdrAgent({ program: gone });
    const before = readFileSync(agentFile(), 'utf8');
    const run = await runSetup({ answer: answers({}) });
    expect(run.asked).toEqual([]);
    expect(changes()).toEqual([]);
    expect(readFileSync(agentFile(), 'utf8')).toBe(before);
    expect(run.stdout).toContain(`MISSING  herdr agent: herdr missing at ${gone}: launchctl bootout ${TARGET} && rm`
      + ` ${AGENT_FILE}, then ${again}`);
    expect(run.stdout).toContain('the loaded definition stays in launchd until launchctl bootout');
    // Not loaded: nothing to unload, only the file.
    loadHerdrAgent('absent');
    const absent = await runSetup({ answer: answers({}) });
    expect(absent.stdout).toContain(`MISSING  herdr agent: herdr missing at ${gone}: rm ${AGENT_FILE}, then ${again}`);
  });

  it('the socket of config.json differs from herdr\'s default: the new plist names it', async () => {
    const custom = path.join(t.home, 'hs.sock');
    writeConfig({ RAROG_ORIGINS: 'https://rarog.example.net', RAROG_PORT: String(5), RAROG_HERDR_SOCKET: custom });
    await listenHerdr(custom);
    await onScreen(answers({}));
    expect(readFileSync(agentFile(), 'utf8'))
      .toBe(renderHerdrAgentPlist({ herdr: path.join(bin, 'herdr'), home, socket: custom }));
  });

  it('a socket written with ~ and spaces in config.json: the live socket blocks bootstrap, the plist gets the resolved path', async () => {
    const custom = path.join(home, 'hs.sock');
    writeConfig({ RAROG_ORIGINS: 'https://rarog.example.net', RAROG_PORT: String(5), RAROG_HERDR_SOCKET: ' ~/hs.sock ' });
    await listenHerdr(custom);
    await onScreen(answers({}));
    expect(readFileSync(agentFile(), 'utf8'))
      .toBe(renderHerdrAgentPlist({ herdr: path.join(bin, 'herdr'), home, socket: custom }));
    expect(calls('launchctl').filter((one) => one.startsWith('bootstrap '))).toEqual([]);
  });

  for (const [code, line] of [
    ['5', ` ✗ herdr agent state undetermined Fix: check launchctl print ${TARGET} in a regular terminal, then ${again}`],
    ['112', ` ✗ herdr agent no GUI login session Fix: log in on the Mac itself, then ${again}`],
  ] as const) {
    it(`launchctl print exits with ${code}: no question, no plist, no bootstrap, the advice`, async () => {
      writeFileSync(path.join(state, 'agent-code'), code);
      const run = await onScreen(answers({}));
      expect(run.asked).toEqual([]);
      expect(stepOf(run)).toBe(line);
      expect(existsSync(agentFile())).toBe(false);
      expect(changes()).toEqual([]);
    });
  }

  it('the label loaded without its plist: no question, no write, "!" with bootout', async () => {
    loadHerdrAgent('running');
    const run = await onScreen(answers({}));
    expect(run.asked).toEqual([]);
    expect(stepOf(run)).toBe(` ! herdr agent loaded without its plist Fix: launchctl bootout ${TARGET}, then ${again}`);
    expect(existsSync(agentFile())).toBe(false);
    expect(changes()).toEqual([]);
  });

  it('the plan did not list the agent (a plist then, gone before the step): nothing written, "!" with setup again',
    async () => {
      writeHerdrAgent({ load: 'absent' });
      // config.json missing: the plan has an item of its own, so its question comes.
      rmSync(configFile());
      const run = await onScreen((question: Question) => {
        if (question === 'continue') rmSync(agentFile());
        return 'y';
      });
      expect(run.asked.slice(0, 2)).toEqual(['tailscale-only', 'continue']);
      expect(visibleLines(run.stdout)).not.toContain(PLAN_LINE);
      expect(existsSync(agentFile())).toBe(false);
      expect(changes()).toEqual([]);
      expect(stepOf(run)).toBe(` ! herdr agent not written: not in the plan Fix: ${again}`);
    });

  it('a plist appears during the plan question: not overwritten, its own verdict', async () => {
    const theirs = '<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>x</string></dict></plist>\n';
    const run = await onScreen((question: Question) => {
      if (question === 'continue') writeFileSync(agentFile(), theirs);
      return 'y';
    });
    expect(readFileSync(agentFile(), 'utf8')).toBe(theirs);
    expect(changes()).toEqual([]);
    expect(stepOf(run)).toBe(` ✗ herdr agent plist unreadable Fix: check ${AGENT_FILE}, then ${again}`);
  });

  it('~/Library/LaunchAgents is a symlink: refusal, nothing written through it, no bootstrap', async () => {
    const dir = path.dirname(agentFile());
    const real = path.join(t.home, 'elsewhere');
    renameSync(dir, real);
    symlinkSync(real, dir);
    const run = await onScreen(answers({}));
    expect(existsSync(path.join(real, 'ai.rarog.herdr.plist'))).toBe(false);
    expect(changes()).toEqual([]);
    expect(stepOf(run)).toMatch(/^ ✗ herdr agent not written: expected a real directory, not a symlink Fix: check/u);
  });

  it('no ~/Library/LaunchAgents yet: created, then the plist', async () => {
    rmSync(path.dirname(agentFile()), { recursive: true });
    await listenHerdr(socket());
    const run = await onScreen(answers({}));
    expect(readFileSync(agentFile(), 'utf8')).toBe(expectedPlist());
    expect(stepOf(run)).toBe(' ✓ herdr agent written, starts at next login');
  });

  // A write error: no plist and no temporary file left, "✗" with the directory, no bootstrap.
  it.skipIf(ROOT)('a write error: nothing written (skipped as root: chmod does not stop root)', async () => {
    const dir = path.dirname(agentFile());
    chmodSync(dir, 0o500);
    try {
      const run = await onScreen(answers({}));
      expect(stepOf(run)).toBe(` ✗ herdr agent not written: EACCES Fix: check ~/Library/LaunchAgents, then ${again}`);
      expect(readdirSync(dir)).toEqual(['ai.rarog.server.plist']);
      expect(changes()).toEqual([]);
    } finally {
      chmodSync(dir, 0o755);
    }
  });

  it('launchctl bootstrap fails: the plist stays, "!" with the command', async () => {
    writeFileSync(path.join(state, 'agent-bootstrap-fail'), 'Bootstrap failed: 5: Input/output error\n');
    const run = await onScreen(answers({}), { herdrStartTimeoutMs: 500 });
    expect(readFileSync(agentFile(), 'utf8')).toBe(expectedPlist());
    expect(stepOf(run)).toBe(` ! herdr agent written, launchctl bootstrap failed Fix: launchctl bootstrap gui/${UID}`
      + ` ${AGENT_FILE}, then ${again}`);
  });

  // The agent written in this run carries the one fix; the Service step waits for it.
  it('bootstrap fails and the service reports herdr: false: Service waits for the agent, one fix', async () => {
    writeFileSync(path.join(state, 'agent-bootstrap-fail'), 'Bootstrap failed: 5: Input/output error\n');
    setHealthBody({ ok: true, herdr: false });
    const run = await onScreen(answers({}), { herdrStartTimeoutMs: 500 });
    expect(stepOf(run, 'Service')).toBe(' – Service waits for herdr agent');
    expect(visibleLines(run.stdout).filter((one) => one.includes('Fix:'))).toHaveLength(1);
    expect(run.code).toBe(1);
  });

  it('no herdr found: no item in the plan, the step waits for Tools, no plist', async () => {
    rmSync(path.join(bin, 'herdr'));
    const run = await runSetup({ answer: null });
    expect(run.stdout).toMatch(/MISSING +herdr agent: herdr first/u);
    // In a terminal: nothing else to create, so no plan screen and no question.
    const terminal = await onScreen(answers({}));
    expect(terminal.asked).toEqual([]);
    expect(stepOf(terminal)).toBe(' – herdr agent waits for Tools');
    expect(existsSync(agentFile())).toBe(false);
    expect(changes()).toEqual([]);
  });

  // One cause, one fix: an agent that is already there but leaves herdr down carries the fix, the Service step waits.
  it.each([
    {
      name: 'loaded, not running', load: 'stopped' as const,
      result: 'herdr is not running', fix: `launchctl kickstart ${TARGET}`,
    },
    {
      name: 'present, not loaded', load: 'absent' as const,
      result: 'not loaded, herdr is not running', fix: `launchctl bootstrap gui/${UID} ${AGENT_FILE}`,
    },
  ])('herdr: false with an agent $name: the agent carries the one fix, Service waits for it', async (c) => {
    writeHerdrAgent({ load: c.load });
    setHealthBody({ ok: true, herdr: false });
    const run = await onScreen(answers({}));
    expect(stepOf(run)).toBe(` ! herdr agent ${c.result} Fix: ${c.fix}, then ${again}`);
    expect(stepOf(run, 'Service')).toBe(' – Service waits for herdr agent');
    expect(visibleLines(run.stdout).filter((one) => one.includes('Fix:'))).toHaveLength(1);
  });

  it('an agent with a fix while herdr answers: the Service step does not wait for it', async () => {
    writeHerdrAgent({ socket: path.join(t.home, 'other.sock') });
    await listenHerdr(socket());
    const run = await onScreen(answers({}));
    expect(stepOf(run)).toContain('its herdr socket is not the one in config.json');
    expect(stepOf(run, 'Service')).not.toContain('waits for');
  });
});

describe.skipIf(!IS_MAC)(macOnly('herdr agent: doctor and the start command', 'launchd'), () => {
  const io = (): CliIo => ({ stdout: () => undefined, stderr: () => undefined, env: env(), cwd: t.home });
  const defaultSocket = (): string => path.join(home, '.config', 'herdr', 'herdr.sock');

  it('no plist: no doctor line, no start command (the caller keeps its own advice)', async () => {
    removeHerdrAgent();
    expect(await herdrAgentDoctorLine(io(), home, 'darwin', null)).toBeNull();
    expect(herdrAgentStart(io(), home, 'darwin')).toBeNull();
  });

  it('running: ok; loaded without a process and herdr down: bad with kickstart, the start command kickstart', async () => {
    expect(await herdrAgentDoctorLine(io(), home, 'darwin', null))
      .toEqual({ verdict: 'ok', text: `herdr agent: ${HERDR_AGENT_LABEL} running (pid 4242)` });
    loadHerdrAgent('stopped');
    const line = await herdrAgentDoctorLine(io(), home, 'darwin', { RAROG_HERDR_SOCKET: defaultSocket() });
    expect(line).toMatchObject({
      verdict: 'bad', text: `herdr agent: ${HERDR_AGENT_LABEL} herdr is not running`,
      repair: `launchctl kickstart ${TARGET}`,
    });
    expect(herdrAgentStart(io(), home, 'darwin')).toBe(`launchctl kickstart ${TARGET}`);
  });

  it('not loaded: info when herdr runs, no start command; launchd does not tell: unknown', async () => {
    loadHerdrAgent('absent');
    await listenHerdr(defaultSocket());
    expect(await herdrAgentDoctorLine(io(), home, 'darwin', null)).toMatchObject({
      verdict: 'info', text: `herdr agent: ${HERDR_AGENT_LABEL} starts at next login`,
    });
    expect(herdrAgentStart(io(), home, 'darwin')).toBeNull();
    writeFileSync(path.join(state, 'agent-code'), '5');
    expect(await herdrAgentDoctorLine(io(), home, 'darwin', null)).toMatchObject({ verdict: 'unknown' });
  });

  it('a socket other than the server\'s: bad with bootout and rm', async () => {
    const line = await herdrAgentDoctorLine(io(), home, 'darwin', { RAROG_HERDR_SOCKET: path.join(t.home, 'x.sock') });
    expect(line).toMatchObject({ verdict: 'bad', text: `herdr agent: ${HERDR_AGENT_LABEL} its herdr socket is not the one`
      + ' in config.json' });
    expect(line?.repair).toMatch(new RegExp(`^launchctl bootout ${TARGET} && rm ${AGENT_FILE}, then `, 'u'));
  });

  it('not macOS: nothing, although the plist exists', async () => {
    expect(existsSync(herdrAgentPlistPath(home))).toBe(true);
    expect(await herdrAgentDoctorLine(io(), home, 'linux', null)).toBeNull();
    expect(herdrAgentStart(io(), home, 'linux')).toBeNull();
  });
});
