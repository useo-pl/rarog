/**
 * `rarog setup`, step 9 on Linux (`setup-herdr-unit.ts`): the PATH of an existing `herdr.service` read the way systemd
 * reads it and the PATH of herdr panes in the unit setup writes (pure functions), then the step itself on the shared
 * harness with the fake `systemd --user` (`helpers/setup-harness.ts`, `systemd-atrapy.ts`): the unit is an item of the
 * plan screen, so setup writes it only after "y" to `Continue?`, with no question of its own, and never enables
 * or starts it.
 */
import {
  chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync,
} from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { herdrUnitFilePath, herdrUnitPath, renderHerdrUnit } from '../src/cli/setup-herdr-unit.ts';
import { PLAN_DECLINED } from '../src/cli/setup-plan.ts';
import { rarogCli } from '../src/install/repair.ts';
import {
  answers, configFile, dataDirOf, linuxInstalledButHerdrUnit, listenHerdr, runSetup, setHealthBody, stepLines,
  useSetupHarness, visibleLines, write,
} from './helpers/setup-harness.ts';
import type { Question, Result } from './helpers/setup-harness.ts';
import { MANAGER_PATH, linuxSandbox } from './systemd-atrapy.ts';
import type { LinuxSandbox } from './systemd-atrapy.ts';

useSetupHarness();

describe('jednostka herdr.service: PATH z pliku istniejącej jednostki', () => {
  const home = '/h';
  /** Tekst w sekcji `[Service]`: tylko tam `Environment=` ustawia środowisko usługi. */
  const service = (body: string): string => `[Unit]\nDescription=x\n\n[Service]\n${body}`;

  it('forma z wydruku i bez cudzysłowu; %% to %, %h to dom; późniejsza linia wygrywa', () => {
    expect(herdrUnitFilePath(service('Environment="PATH=/a b:/pro%%cent"\n'), home)).toEqual(['/a b', '/pro%cent']);
    expect(herdrUnitFilePath(service('Environment=PATH=%h/.local/bin:/usr/bin\r\n'), home))
      .toEqual(['/h/.local/bin', '/usr/bin']);
    expect(herdrUnitFilePath(service('Environment=PATH=/stary\nEnvironment="PATH=/nowy"\n'), home)).toEqual(['/nowy']);
    expect(herdrUnitFilePath(service('Environment="PATH=%%h"\n'), home)).toEqual(['%h']);
  });

  it('bez linii PATH = „brak”; inna zmienna z PATH w nazwie i komentarz się nie liczą', () => {
    expect(herdrUnitFilePath(service('ExecStart="/h/herdr" server\n'), home)).toBe('missing');
    expect(herdrUnitFilePath(service('Environment=MANPATH=/x\n#Environment=PATH=/y\n'), home)).toBe('missing');
  });

  it('Environment= poza [Service] się nie liczy; puste Environment= zeruje wcześniejszy PATH', () => {
    expect(herdrUnitFilePath(`${service('ExecStart="/h/herdr" server\n')}\n[Install]\nEnvironment="PATH=/h/x"\n`, home))
      .toBe('missing');
    expect(herdrUnitFilePath('Environment="PATH=/h/x"\n', home)).toBe('missing');
    expect(herdrUnitFilePath(service('Environment="PATH=/h/x"\nEnvironment=\n'), home)).toBe('missing');
    expect(herdrUnitFilePath(service('Environment="PATH=/h/x"\nEnvironment=\nEnvironment=PATH=/h/y\n'), home))
      .toEqual(['/h/y']);
  });

  it('linia z \\ na końcu łączy się z następną jak w systemd: kilka przypisań po sklejeniu = „nie wiem”', () => {
    // systemd ustawia tu PATH=/usr/bin, więc katalogi z pierwszej linii nie mogą dać „ok”.
    const text = service('Environment="PATH=/h/.local/bin:/opt/node/bin:/usr/bin"\nEnvironment="A=1" \\\n'
      + '  "PATH=/usr/bin"\n');
    expect(herdrUnitFilePath(text, home)).toBe('unknown');
    expect(herdrUnitFilePath(service('Environment=\\\n  "PATH=/h/z"\n'), home)).toEqual(['/h/z']);
    // Parzysta liczba `\` na końcu to nie kontynuacja: `\` w wartości, forma, której setup nie czyta.
    expect(herdrUnitFilePath(service('Environment="PATH=/h/x\\\\"\n'), home)).toBe('unknown');
  });

  it('komentarz (#, ;) wewnątrz kontynuacji wypada, a linia łączy się z tą po nim', () => {
    expect(herdrUnitFilePath(service('Environment=\\\n# komentarz\n  ; drugi\n  PATH=/h/y\n'), home)).toEqual(['/h/y']);
    expect(herdrUnitFilePath(service('Environment="PATH=/h/x"\nEnvironment="B=2" \\\n# k\n  "PATH=/h/y"\n'), home))
      .toBe('unknown');
  });

  it('linia w formie, której setup nie czyta = „nie wiem”', () => {
    for (const text of ['Environment=FOO=1 PATH=/a', 'Environment="PATH=/a" "FOO=b"', 'Environment="PATH=%u/bin"',
      'Environment=\'PATH=/a\'', 'Environment="PATH=/a\\x"']) {
      expect(herdrUnitFilePath(service(`${text}\n`), home)).toBe('unknown');
    }
  });
});

describe('jednostka herdr.service: PATH paneli', () => {
  it('katalogi z kroku 1 pierwsze, potem PATH menedżera i systemowe, bez powtórzeń', () => {
    expect(herdrUnitPath(['/h/.local/bin', '/opt/node/bin', '/h/.local/bin'], '/usr/bin:/snap/bin::rel:/usr/bin'))
      .toEqual(['/h/.local/bin', '/opt/node/bin', '/usr/bin', '/snap/bin', '/usr/local/sbin', '/usr/local/bin',
        '/usr/sbin', '/sbin', '/bin']);
  });

  it('katalog, którego PATH albo jednostka nie przeniesie, wypada; spacja i % przechodzą', () => {
    const dirs = herdrUnitPath(['/a:b', '/q"x', '/back\\slash', '/trail ', 'rel', '/z spacją', '/pro%cent'], '');
    expect(dirs.slice(0, 2)).toEqual(['/z spacją', '/pro%cent']);
    const unit = renderHerdrUnit('/h/.local/bin/herdr', dirs);
    expect(unit).toContain('\nExecStart="/h/.local/bin/herdr" server\n');
    // `herdr server stop` kończy się kodem 0: `on-failure` zostawiłby serwer martwy.
    expect(unit).toContain('\nRestart=always\n');
    expect(unit).not.toContain('on-failure');
    expect(unit).toContain('\nEnvironment="PATH=/z spacją:/pro%%cent:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin'
      + ':/sbin:/bin"\n');
  });
});

/** Writes are refused for root, so a test that needs a write error cannot run as root. */
const ROOT = process.getuid?.() === 0;

describe('rarog setup on Linux: herdr.service, an item of the plan, written after Continue?, never enabled', () => {
  let sb: LinuxSandbox;
  let socket = '';

  beforeEach(() => {
    sb = linuxSandbox('rhu-');
    socket = path.join(sb.homeDir, 'hs.sock');
    linuxInstalledButHerdrUnit(sb, socket);
  });

  afterEach(() => { sb.cleanup(); });

  const unitDir = (): string => path.join(sb.homeDir, '.config', 'systemd', 'user');
  const unitFile = (): string => path.join(unitDir(), 'herdr.service');
  /** Another directory of the fake manager's `UnitPath`. */
  const otherUnitFile = (): string => path.join(sb.homeDir, '.local', 'share', 'systemd', 'user', 'herdr.service');
  /** The unit for this sandbox: the herdr and claude fakes, the test's node, the manager's `PATH`. */
  const expectedUnit = (): string => renderHerdrUnit(path.join(sb.bin, 'herdr'),
    herdrUnitPath([sb.bin, path.dirname(process.execPath), sb.bin], MANAGER_PATH));
  const herdrState = (name: string, value: string | null): void => { sb.set(`herdr.service.${name}`, value); };

  /** The step screen of a 60-column terminal without colour. */
  const onScreen = (answer: (question: Question) => string | null): Promise<Result> => runSetup({
    verbose: false, terminal: { tty: true, columns: 60, color: false }, answer, env: sb.env(), platform: 'linux',
  });
  const stepOf = (run: Result): string => stepLines(visibleLines(run.stdout), 'herdr unit');
  /** Setup asks systemd only: never `enable`, `start` or `daemon-reload`. */
  const onlyShown = (): void => {
    expect(sb.calls('systemctl').filter((one) => !one.startsWith('--user show '))).toEqual([]);
  };
  /** The herdr unit's line of the plan screen: what and where. */
  const PLAN_LINE = '  • herdr.service          ~/.config/systemd/user';
  /** The run logs of setup in the sandbox's data directory, with their text. */
  const logText = (): string => {
    const dir = path.join(dataDirOf(sb.homeDir), 'logs');
    return existsSync(dir) ? readdirSync(dir).map((name) => readFileSync(path.join(dir, name), 'utf8')).join('\n') : '';
  };

  for (const dirExists of [true, false]) {
    it(`no unit, herdr not running${dirExists ? '' : ', no unit directory'}: an item of the plan, "y" to Continue?`
      + ' writes the file 0644, "!" with enable --now', async () => {
        if (dirExists) mkdirSync(unitDir(), { recursive: true });
        expect(existsSync(unitDir())).toBe(dirExists);
        const run = await onScreen(answers({ continue: ['y'] }));
        // The plan question alone: the step has no question of its own.
        expect(run.asked).toEqual(['continue']);
        expect(visibleLines(run.stdout)).toContain('Rarog will set up on this machine:');
        expect(visibleLines(run.stdout)).toContain(PLAN_LINE);
        expect(run.stdout).not.toContain('[y/N/d]');
        expect(readFileSync(unitFile(), 'utf8')).toBe(expectedUnit());
        expect(statSync(unitFile()).mode & 0o777).toBe(0o644);
        // Only the unit: the temporary file of the write is gone.
        expect(readdirSync(unitDir())).toEqual(['herdr.service']);
        expect(stepOf(run)).toBe(' ! herdr unit written, not enabled Fix: systemctl --user enable --now herdr.service');
        // The unit is not on the step screen; the run log has it.
        expect(run.stdout).not.toContain('ExecStart=');
        for (const one of expectedUnit().split('\n').filter((text) => text !== '')) expect(logText()).toContain(one);
        onlyShown();
      });
  }

  // A unit written in this run carries the one fix; the Service step waits for it and the exit stays 1.
  const noService = (): void => { sb.set('LoadState', null); };
  const fixes = (run: Result): string[] => visibleLines(run.stdout).filter((one) => one.includes('Fix:'));

  it('no Rarog service, herdr not running, "y": one fix at the unit, Service "–" waits for it', async () => {
    noService();
    const run = await onScreen(answers({}));
    expect(run.asked).toEqual(['continue']);
    expect(stepLines(visibleLines(run.stdout), 'Service')).toBe(' – Service waits for herdr unit');
    expect(fixes(run)).toEqual(['   Fix: systemctl --user enable --now herdr.service']);
    expect(run.code).toBe(1);
  });

  it('the Rarog service reports herdr: false, "n" on the plan of the unit alone: Service as before, its own fix',
    async () => {
      setHealthBody({ ok: true, herdr: false });
      const run = await onScreen(answers({ continue: ['n'] }));
      expect(stepOf(run)).toBe(' – herdr unit not written');
      // The run log's `Log:` line after the last fix is not part of the step.
      expect(stepLines(visibleLines(run.stdout), 'Service').replace(/ Log: \S+$/u, ''))
        .toBe(` ✗ Service herdr: false Fix: run herdr in a terminal, then ${rarogCli('setup')}`);
    });

  it('the Rarog service reports herdr: false, "y": Service waits for the unit instead of a second fix', async () => {
    setHealthBody({ ok: true, herdr: false });
    const run = await onScreen(answers({}));
    expect(stepLines(visibleLines(run.stdout), 'Service')).toBe(' – Service waits for herdr unit');
    expect(fixes(run)).toEqual(['   Fix: systemctl --user enable --now herdr.service']);
    expect(run.code).toBe(1);
  });

  it('the plan question has no "d": [Y/n]; the written unit is on the screen with --verbose', async () => {
    const run = await runSetup({ answer: answers({}), env: sb.env(), platform: 'linux' });
    expect(run.asked).toEqual(['continue']);
    expect(run.stdout).toContain('? Continue? [Y/n] ');
    for (const one of expectedUnit().split('\n').filter((text) => text !== '')) expect(run.stdout).toContain(`${one}\n`);
    expect(readFileSync(unitFile(), 'utf8')).toBe(expectedUnit());
  });

  for (const [name, answer] of [['"n"', 'n'], ['EOF (Ctrl-D)', null]] as const) {
    it(`${name} on a plan of the unit alone: no file, "–" without a Fix, the run goes on`, async () => {
      const run = await onScreen((question) => (question === 'continue' ? answer : 'y'));
      expect(run.asked).toEqual(['continue']);
      expect(existsSync(unitFile())).toBe(false);
      expect(stepOf(run)).toBe(' – herdr unit not written');
      expect(run.stdout).not.toContain(PLAN_DECLINED);
      expect(visibleLines(run.stdout).some((one) => one.startsWith('Done in '))).toBe(true);
      onlyShown();
    });
  }

  it('"n" on a plan with another item too: Nothing changed., code 1, no unit', async () => {
    rmSync(configFile(sb.homeDir));
    const run = await onScreen(answers({ continue: ['n'] }));
    expect(run.asked).toEqual(['continue']);
    expect(visibleLines(run.stdout)).toContain(PLAN_LINE);
    expect(run.stdout).toContain(PLAN_DECLINED);
    expect(existsSync(unitFile())).toBe(false);
    expect(run.code).toBe(1);
    onlyShown();
  });

  it('the socket of config.json, not herdr\'s default, decides: herdr answering there means no item', async () => {
    await listenHerdr(socket);
    const run = await onScreen(answers({}));
    expect(run.asked).toEqual([]);
    expect(run.stdout).not.toContain(PLAN_LINE);
  });

  it('herdr runs without a unit: no question, no write, "–" as before, the unit not printed', async () => {
    await listenHerdr(socket);
    const run = await onScreen(answers({}));
    expect(run.asked).toEqual([]);
    expect(existsSync(unitFile())).toBe(false);
    expect(stepOf(run)).toMatch(/^ – herdr unit not used \(herdr runs without it\)/u);
    expect(run.stdout).not.toContain('ExecStart=');
  });

  const elsewhere: readonly { name: string; arrange: () => void; summary: RegExp; warning?: () => string }[] = [
    {
      name: 'a file in another UnitPath directory, unknown to the manager',
      arrange: () => { write(otherUnitFile(), expectedUnit()); },
      summary: /MISSING .*the file is present, the manager does not know it: systemctl --user daemon-reload/u,
    },
    {
      name: 'a file in another UnitPath directory, loaded, PATH without claude',
      arrange: () => {
        write(otherUnitFile(), '[Service]\nEnvironment="PATH=/usr/bin"\n');
        for (const [name, value] of [['LoadState', 'loaded'], ['FragmentPath', otherUnitFile()], ['active', '1'],
          ['enabled', '1']] as const) herdrState(name, value);
      },
      summary: /info .*active and enabled, but the pane PATH lacks /u,
      warning: () => `WARNING: the unit PATH lacks ${sb.bin} (claude)`,
    },
    {
      name: 'a unit known to the manager only (no file in UnitPath)',
      arrange: () => {
        for (const [name, value] of [['LoadState', 'loaded'], ['FragmentPath', '/run/user/1001/systemd/transient/x'],
          ['active', '1'], ['enabled', '1']] as const) herdrState(name, value);
      },
      summary: /ok .*herdr.service: active and enabled$/u,
    },
  ];
  for (const one of elsewhere) {
    it(`${one.name}: no question, no write, the state check of that unit`, async () => {
      one.arrange();
      const run = await runSetup({ answer: answers({}), env: sb.env(), platform: 'linux' });
      expect(run.asked).toEqual([]);
      expect(existsSync(unitFile())).toBe(false);
      const summary = run.stdout.slice(run.stdout.indexOf('Summary:')).split('\n')
        .find((line) => line.includes('herdr.service')) ?? '';
      expect(summary).toMatch(one.summary);
      if (one.warning !== undefined) expect(run.stdout).toContain(one.warning());
    });
  }

  for (const where of ['the unit directory', 'another UnitPath directory'] as const) {
    it(`herdr.service appears in ${where} during the plan question: nothing overwritten, the state of that file`,
      async () => {
        const target = where === 'the unit directory' ? unitFile() : otherUnitFile();
        const foreign = '[Service]\nExecStart=/opt/own/herdr server\n';
        const run = await onScreen((question) => {
          if (question === 'continue') write(target, foreign);
          return 'y';
        });
        expect(run.asked).toEqual(['continue']);
        expect(readFileSync(target, 'utf8')).toBe(foreign);
        if (target !== unitFile()) expect(existsSync(unitFile())).toBe(false);
        expect(stepOf(run)).not.toContain('written');
        onlyShown();
      });
  }

  it('the plan did not list the unit (a unit then, gone before the step): nothing written, "!" with setup again',
    async () => {
      write(otherUnitFile(), expectedUnit());
      // config.json missing: the plan has an item of its own, so its question comes.
      rmSync(configFile(sb.homeDir));
      const run = await onScreen((question) => {
        if (question === 'continue') rmSync(otherUnitFile());
        return 'y';
      });
      expect(run.asked[0]).toBe('continue');
      expect(visibleLines(run.stdout)).not.toContain(PLAN_LINE);
      expect(existsSync(unitFile())).toBe(false);
      expect(stepOf(run)).toMatch(/^ ! herdr unit not written: not in the plan Fix: \S.* setup$/u);
      onlyShown();
    });

  it('the unit directory is a symlink: refused after "y", nothing written behind it', async () => {
    const behind = path.join(sb.homeDir, 'elsewhere');
    mkdirSync(behind);
    mkdirSync(path.dirname(unitDir()), { recursive: true });
    symlinkSync(behind, unitDir());
    const run = await onScreen(answers({}));
    expect(run.asked).toEqual(['continue']);
    expect(readdirSync(behind)).toEqual([]);
    expect(stepOf(run)).toMatch(/^ ✗ herdr unit .* Fix: /u);
  });

  it('the unit directory is a file: refused after "y", the file byte for byte', async () => {
    write(unitDir(), 'not a directory\n');
    const run = await onScreen(answers({}));
    expect(run.asked).toEqual(['continue']);
    expect(readFileSync(unitDir(), 'utf8')).toBe('not a directory\n');
    expect(stepOf(run)).toMatch(/^ ✗ herdr unit .* Fix: /u);
  });

  it.skipIf(ROOT)('a write error: no file under the target name, no temporary file, "✗" (skipped as root: chmod does not stop root)', async () => {
    mkdirSync(unitDir(), { recursive: true });
    chmodSync(unitDir(), 0o500);
    try {
      const run = await onScreen(answers({}));
      expect(run.asked).toEqual(['continue']);
      expect(readdirSync(unitDir())).toEqual([]);
      expect(stepOf(run)).toMatch(/^ ✗ herdr unit .* Fix: /u);
    } finally {
      chmodSync(unitDir(), 0o700);
    }
  });

  it('the manager\'s UnitPath unreadable: no question, no write, "✗" with a Fix', async () => {
    sb.set('busctl-down', '1');
    const run = await onScreen(answers({}));
    expect(run.asked).toEqual([]);
    expect(existsSync(unitFile())).toBe(false);
    expect(stepOf(run)).toMatch(/^ ✗ herdr unit state undetermined Fix: /u);
  });

  it('the manager\'s UnitPath lacks ~/.config/systemd/user: no question, no write, "✗", exit 1', async () => {
    // A manager with another XDG_CONFIG_HOME: a unit in ~/.config/systemd/user would be invisible to it.
    const file = path.join(sb.state, 'manager-UnitPath.json');
    const measured = JSON.parse(readFileSync(file, 'utf8')) as { type: string; data: string[] };
    const other = path.join(sb.homeDir, 'other-config', 'systemd', 'user');
    expect(measured.data).toContain(unitDir());
    sb.set('manager-UnitPath.json', JSON.stringify({ ...measured,
      data: measured.data.map((dir) => (dir === unitDir() ? other : dir)) }));
    const run = await onScreen(answers({}));
    expect(run.asked).toEqual([]);
    expect(existsSync(unitFile())).toBe(false);
    expect(existsSync(path.join(other, 'herdr.service'))).toBe(false);
    expect(stepOf(run)).toMatch(/^ ✗ herdr unit .*~\/\.config\/systemd\/user.* Fix: /u);
    expect(run.code).toBe(1);
    onlyShown();
  });

  it('a UnitPath directory that cannot be searched (ELOOP): no question, no write, "✗" with a Fix', async () => {
    // A symlink loop fails lstat with ELOOP for any user, root too (a 0o000 directory would not stop root).
    const loop = path.join(sb.homeDir, '.config', 'systemd', 'user.control');
    mkdirSync(path.dirname(loop), { recursive: true });
    symlinkSync(loop, loop);
    const run = await onScreen(answers({}));
    expect(run.asked).toEqual([]);
    expect(existsSync(unitFile())).toBe(false);
    expect(stepOf(run)).toMatch(/^ ✗ herdr unit state undetermined Fix: /u);
    onlyShown();
  });

  it('the manager stops answering during the plan question: after "y" nothing written, "✗" with a Fix', async () => {
    const run = await onScreen((question) => {
      if (question === 'continue') sb.set('busctl-down', '1');
      return 'y';
    });
    expect(run.asked).toEqual(['continue']);
    expect(existsSync(unitFile())).toBe(false);
    expect(stepOf(run)).toMatch(/^ ✗ herdr unit state undetermined Fix: /u);
    onlyShown();
  });

  it('without a terminal: no write, one line, the unit not printed', async () => {
    const run = await runSetup({ verbose: false, answer: null, env: sb.env(), platform: 'linux' });
    expect(existsSync(unitFile())).toBe(false);
    const lines = run.stdout.split('\n');
    const at = lines.findIndex((one) => one.includes('herdr unit'));
    expect(lines[at]).toMatch(/^\[[0-9]+\/10\] warn +herdr unit: /u);
    expect(lines.filter((one) => one.includes('herdr unit'))).toHaveLength(1);
    expect(lines[at + 1]).not.toMatch(/^ +Fix:/u);
    expect(run.stdout).not.toContain('ExecStart=');
  });
});
