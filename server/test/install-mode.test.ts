/**
 * Tryb i korzeń instalacji (`server/src/install/`) oraz wywołania, które z nich korzystają: korzeń klonu, wejście `bin/rarog.mjs`, kształt argv usługi i zdania naprawy. Granice katalogu
 * pilnuje `install-guard.test.ts`.
 */
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HOOK_REPAIR_COPY, HOOK_REPAIR_ENTRY } from '../src/cli/hooks.ts';
import type { CliIo } from '../src/cli/io.ts';
import {
  MIN_NODE_23_MINOR, MIN_NODE_MINOR, NODE_MAX_MAJOR, RESTART_PARAMS, nodeRequirement, nodeVersionOk, scriptEnv, serviceNodeVersionOk,
} from '../src/cli/restart.ts';
import { IROH_PROBE_ENTRY, SERVER_ENTRY, TSX_BIN, irohProbeCommand, serverExec } from '../src/cli/serve.ts';
import { PLIST_TEMPLATE, RAROG_BIN as SERVICE_RAROG_BIN, renderServicePlist } from '../src/cli/service.ts';
import { UNIT_TEMPLATE } from '../src/cli/systemd-unit.ts';
import { repoRoot } from '../src/herdr/hook-config.ts';
import {
  INSTALL_MODE, INSTALL_ROOT, ROOT_PACKAGE_JSON, installModeAt, installModeOf, installRootOf,
} from '../src/install/mode.ts';
import {
  PACKAGE_INSTALL, REPAIR, RESTART_HOOK_REPAIR, installationCli, npmBinDir, npmSelfUpdate, otherPackageFix,
  packageCommands, packageManagerOf, rarogCli, repairCommands, restartHookRepair,
} from '../src/install/repair.ts';
import {
  RAROG_BIN, homebrewOptNode, serviceArgv, serviceArgvBin, serviceArgvNode, serviceArgvWrapper, serviceInstallation,
  serviceTarget,
} from '../src/install/service-target.ts';
import { ROOT_PACKAGE_JSON as VERSION_PACKAGE_JSON } from '../src/version.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('tryb instalacji', () => {
  it('rozszerzenie modułu: `.ts` = klon, `.js` = paczka; adres jako napis i jako URL', () => {
    expect(installModeOf('file:///opt/rarog/server/src/install/mode.ts')).toBe('clone');
    expect(installModeOf(new URL('file:///opt/rarog/server/src/install/mode.ts'))).toBe('clone');
    expect(installModeOf('file:///opt/rarog/server/src/install/mode.js')).toBe('package');
    expect(installModeOf(new URL('file:///opt/rarog/server/src/install/mode.js'))).toBe('package');
    expect(installModeOf('file:///opt/rarog/server/src/install/mode.mts')).toBe('clone');
    expect(installModeOf('file:///opt/rarog.js/server/src/install/mode.ts')).toBe('clone');
  });

  it('korzeń: trzy poziomy nad `server/src/install/`, bez końcowego `/`, ze spacją w ścieżce', () => {
    expect(installRootOf('file:///opt/rarog/server/src/install/mode.ts')).toBe('/opt/rarog');
    expect(installRootOf(pathToFileURL('/Users/a b/rarog/server/src/install/mode.js'))).toBe('/Users/a b/rarog');
  });

  it('ten proces (tsx) to klon, korzeń to katalog repo z `package.json` serwera', () => {
    expect(INSTALL_MODE).toBe('clone');
    expect(INSTALL_ROOT).toBe(REPO);
    expect(fileURLToPath(ROOT_PACKAGE_JSON)).toBe(path.join(REPO, 'package.json'));
    const pkg = JSON.parse(readFileSync(ROOT_PACKAGE_JSON, 'utf8')) as { name?: unknown };
    expect(pkg.name).toBe('rarog');
  });
});

describe('przeniesione wywołania liczą korzeń z `install/mode.ts`', () => {
  it('wersja, źródło kopii hooka, wejście `rarog`, szablony usług i tsx', () => {
    expect(VERSION_PACKAGE_JSON.href).toBe(ROOT_PACKAGE_JSON.href);
    expect(repoRoot()).toBe(INSTALL_ROOT);
    expect(RAROG_BIN).toBe(path.join(REPO, 'bin', 'rarog.mjs'));
    expect(SERVICE_RAROG_BIN).toBe(RAROG_BIN);
    expect(existsSync(RAROG_BIN)).toBe(true);
    expect(PLIST_TEMPLATE).toBe(path.join(REPO, 'server/src/cli/templates/launchd.plist'));
    expect(UNIT_TEMPLATE).toBe(path.join(REPO, 'server/src/cli/templates/rarog.service'));
    expect(existsSync(PLIST_TEMPLATE) && existsSync(UNIT_TEMPLATE)).toBe(true);
    expect(TSX_BIN).toBe(path.join(REPO, 'node_modules/.bin/tsx'));
  });
});

describe('start serwera i próba iroh per tryb (`rarog serve`)', () => {
  const NODE = '/opt/node/bin/node';

  it('klon: `execve` na shim tsx z `index.ts`, próba iroh z `--import tsx`; ten proces to klon', () => {
    expect(serverExec('clone', NODE)).toEqual({ file: TSX_BIN, argv: [TSX_BIN, 'server/src/index.ts'] });
    expect(irohProbeCommand('clone', NODE)).toEqual([NODE, '--import', 'tsx', 'server/src/iroh/module-probe.ts']);
    expect(SERVER_ENTRY).toBe('server/src/index.ts');
    expect(IROH_PROBE_ENTRY).toBe('server/src/iroh/module-probe.ts');
  });

  it('paczka: `execve` na węzeł z `index.js` (wzorzec stopu `restart.sh`), próba iroh bez tsx', () => {
    const exec = serverExec('package', NODE);
    expect(exec).toEqual({ file: NODE, argv: [NODE, 'server/src/index.js'] });
    expect(exec.argv.join(' ')).toContain('node server/src/index.js');
    expect(readFileSync(path.join(REPO, 'scripts/restart.sh'), 'utf8')).toContain('"node server/src/index.js"');
    expect(irohProbeCommand('package', NODE)).toEqual([NODE, 'server/src/iroh/module-probe.js']);
    for (const entry of ['server/src/index.ts', 'server/src/iroh/module-probe.ts']) {
      expect(existsSync(path.join(REPO, entry)), `${entry} ma źródło emisji .js`).toBe(true);
    }
  });
});

describe('cel usługi', () => {
  it('argv: wrapper, węzeł tego procesu, `bin/rarog.mjs`, argumenty; węzeł odczytany z powrotem', () => {
    // Węzeł z Homebrew (`Cellar`) przechodzi na `opt/<formuła>`; to ten sam plik co węzeł tego procesu.
    const node = serviceTarget().node;
    expect(realpathSync(node)).toBe(realpathSync(process.execPath));
    const wrapper = ['/usr/local/bin/wrapper', '--only', 'X', '--'];
    const argv = serviceArgv(wrapper, ['serve', '--check']);
    expect(argv).toEqual([...wrapper, node, RAROG_BIN, 'serve', '--check']);
    expect(serviceArgvNode(argv)).toBe(node);
    expect(serviceArgv([], ['serve'])).toEqual([node, RAROG_BIN, 'serve']);
    expect(serviceArgvNode(serviceArgv([], ['serve']))).toBe(node);
  });

  it('sklep pnpm: plist wskazuje plik `bin/rarog.mjs` w korzeniu paczki, nie polecenie `rarog` menedżera', () => {
    const root = '/Users/a/Library/pnpm/store/v11/links/@/rarog/0.1.0/abc123/node_modules/rarog';
    const target = serviceTarget('/Users/a/.nvm/versions/node/v22.22.3/bin/node', root);
    expect(target).toEqual({ node: '/Users/a/.nvm/versions/node/v22.22.3/bin/node', bin: `${root}/bin/rarog.mjs` });
    const programArguments = serviceArgv([], ['serve'], target);
    expect(programArguments).toEqual([target.node, `${root}/bin/rarog.mjs`, 'serve']);
    const plist = renderServicePlist({ programArguments, workingDirectory: root, log: '/d/server.log' });
    expect(plist).toContain(`<string>${root}/bin/rarog.mjs</string>`);
    expect(plist).not.toMatch(/<string>[^<]*\/bin\/rarog<\/string>/u);
    expect(serviceArgvBin(programArguments)).toBe(`${root}/bin/rarog.mjs`);
  });

  it('węzeł z argv innej instalacji; brak wejścia albo nic przed nim = `undefined`', () => {
    expect(serviceArgvNode(['/opt/node/bin/node', '/inna/sciezka/bin/rarog.mjs', 'serve'])).toBe('/opt/node/bin/node');
    expect(serviceArgvNode(['/inna/sciezka/bin/rarog.mjs', 'serve'])).toBeUndefined();
    expect(serviceArgvNode(['/opt/node/bin/node', '/opt/rarog/server.mjs'])).toBeUndefined();
    expect(serviceArgvNode([])).toBeUndefined();
  });

  it('wrapper z argv usługi: elementy przed węzłem; bez wrappera albo bez wejścia pusta lista', () => {
    const wrapper = ['/usr/local/bin/w', '--only', 'A,B', '--'];
    expect(serviceArgvWrapper([...wrapper, '/opt/node', '/x/bin/rarog.mjs', 'serve'])).toEqual(wrapper);
    expect(serviceArgvWrapper(['/opt/node', '/x/bin/rarog.mjs', 'serve'])).toEqual([]);
    expect(serviceArgvWrapper(['/x/bin/rarog.mjs', 'serve'])).toEqual([]);
    expect(serviceArgvWrapper(['/usr/local/bin/w', '/opt/node', 'serve'])).toEqual([]);
  });

  it('komenda innej instalacji: jej węzeł i wejście w cudzysłowie powłoki, bez PATH i bez cd', () => {
    expect(installationCli({ node: '/opt/n o/node', bin: "/p/it's/bin/rarog.mjs" }, 'service install'))
      .toBe("'/opt/n o/node' '/p/it'\\''s/bin/rarog.mjs' service install");
  });
});

describe('tryb innej instalacji na dysku (`installModeAt`)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'rarog-tryb-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('zbudowany `server/src/cli/main.js` = paczka (reguła `bin/rarog.mjs`); bez niego, ten klon i brak katalogu = klon', () => {
    expect(installModeAt(dir)).toBe('clone');
    mkdirSync(path.join(dir, 'server', 'src', 'cli'), { recursive: true });
    writeFileSync(path.join(dir, 'server', 'src', 'cli', 'main.ts'), '');
    expect(installModeAt(dir)).toBe('clone');
    writeFileSync(path.join(dir, 'server', 'src', 'cli', 'main.js'), '');
    expect(installModeAt(dir)).toBe('package');
    expect(installModeAt(REPO)).toBe('clone');
    expect(installModeAt(path.join(dir, 'nie-ma'))).toBe('clone');
    expect(readFileSync(path.join(REPO, 'bin', 'rarog.mjs'), 'utf8'))
      .toContain("existsSync(path.join(root, 'server', 'src', 'cli', 'main.js'))");
  });
});

describe('komendy naprawcze klonu', () => {
  it('wartości i zdania są te same co przed przeniesieniem do `install/repair.ts`', () => {
    expect(REPAIR).toEqual({
      cli: 'node bin/rarog.mjs',
      hooksInstall: 'pnpm run hooks:install',
      hooksPrint: 'pnpm run hooks:print',
      hooksPrintLocal: 'pnpm run hooks:print -- --local',
      hooksDoctor: 'pnpm run hooks:doctor',
      restart: 'pnpm run restart',
      afterUpdate: 'pnpm run restart',
      dependencies: 'pnpm install',
    });
    expect(rarogCli('service install')).toBe('node bin/rarog.mjs service install');
    expect(HOOK_REPAIR_COPY).toBe('Fix: `pnpm run hooks:install` in your own terminal (outside the Claude Code sandbox).');
    expect(HOOK_REPAIR_ENTRY).toBe('Fix: `pnpm run hooks:install` in a terminal (hook code copy, then the entries in'
      + ' ~/.claude/settings.json after one question, d shows the diff); a conflict it shows needs a hand edit (block:'
      + ' `pnpm run hooks:print`).');
    expect(RESTART_HOOK_REPAIR).toBe('review the changes (pnpm run hooks:doctor), then pnpm run hooks:install');
  });

  it('zdanie naprawy hooka dla `restart.sh` idzie zawsze od frontu, a cudza wartość z otoczenia odpada', () => {
    expect(RESTART_PARAMS).toContain('RAROG_RESTART_HOOK_REPAIR');
    const io = { env: { PATH: '/usr/bin', RAROG_RESTART_HOOK_REPAIR: 'rm -rf ~' } } as unknown as CliIo;
    const env = scriptEnv(io, { RAROG_RESTART_PORT: '8930' });
    expect(env.RAROG_RESTART_HOOK_REPAIR).toBe(RESTART_HOOK_REPAIR);
    expect(env.RAROG_RESTART_PORT).toBe('8930');
    expect(env.PATH).toBe('/usr/bin');
    expect(RESTART_HOOK_REPAIR.length).toBeLessThanOrEqual(300);
    // Znak sterujący `restart.sh` odrzuca kodem 64.
    expect(RESTART_HOOK_REPAIR).not.toMatch(/[\u0000-\u001f\u007f]/u);
  });
});

describe('komendy naprawcze paczki npm', () => {
  const NPM_ROOT = '/Users/a/.nvm/versions/node/v22.22.3/lib/node_modules/@rarog/server';
  const PNPM_ROOT = '/Users/a/Library/pnpm/store/v11/links/@rarog/server/0.1.0/abc123/node_modules/@rarog/server';

  it('menedżer z układu katalogu: sklep pnpm 11, `lib/node_modules` npm, zakres pnpm; inny układ = nie wiadomo', () => {
    expect(packageManagerOf(NPM_ROOT)).toBe('npm');
    expect(packageManagerOf('/opt/homebrew/lib/node_modules/rarog')).toBe('npm');
    expect(packageManagerOf(PNPM_ROOT)).toBe('pnpm');
    expect(packageManagerOf('/Users/a/Library/pnpm/store/v11/links/@/rarog/0.1.0/abc123/node_modules/rarog'))
      .toBe('pnpm');
    expect(packageManagerOf('/s/v11/links/@rarog-org/rarog/0.1.0/abc/node_modules/@rarog-org/rarog')).toBe('pnpm');
    expect(packageManagerOf('/Users/a/Projects/rarog')).toBeNull();
    expect(packageManagerOf('/s/links/rarog/node_modules/rarog')).toBeNull();
  });

  it.each([
    ['/p/lib/node_modules/@rarog/server', '/p/bin'],
    ['/p/lib/node_modules/rarog', '/p/bin'],
    ['/p/node_modules/@rarog/server', null],
    ['/g/5/node_modules/.pnpm/@rarog+server@1.0.0/node_modules/@rarog/server', null],
    ['/p/lib/node_modules/x/node_modules/@rarog/server', null],
    // The name is not checked; a scope alone is no package, and neither is a scope inside a scope.
    ['/p/lib/node_modules/@other/tool', '/p/bin'],
    ['/p/lib/node_modules/@rarog', null],
    ['/p/lib/node_modules/@rarog/@server', null],
    [PNPM_ROOT, null],
  ])('npm commands directory of the package root %s: %s', (root, bin) => {
    expect(npmBinDir(root)).toBe(bin);
  });

  it('npmSelfUpdate: the command updates the npm that runs, in its own prefix; another layout has no command', () => {
    // Node and its npm in one prefix, the package in another (`prefix` in `.npmrc`): the npm to update is Node's.
    expect(npmSelfUpdate('/opt/node/lib/node_modules/npm/bin/npm-cli.js'))
      .toBe("npm i -g --prefix '/opt/node' npm@latest");
    expect(npmSelfUpdate('/usr/share/nodejs/npm/bin/npm-cli.js')).toBeNull();
    expect(npmSelfUpdate('/opt/node/lib/node_modules/other/bin/npm-cli.js')).toBeNull();
  });

  it('paczka: `rarog <komenda>`, zależności przez aktualizację menedżerem; nieznany menedżer = obie komendy', () => {
    expect(repairCommands('package', NPM_ROOT)).toEqual({
      cli: 'rarog',
      hooksInstall: 'rarog hooks install',
      hooksPrint: 'rarog hooks print',
      hooksPrintLocal: 'rarog hooks print --local',
      hooksDoctor: 'rarog hooks doctor',
      restart: 'rarog restart',
      afterUpdate: 'rarog restart',
      dependencies: "npm i -g --prefix '/Users/a/.nvm/versions/node/v22.22.3' @rarog/server@latest",
    });
    expect(repairCommands('package', PNPM_ROOT).dependencies).toBe('pnpm add -g @rarog/server@latest');
    // A pnpm update moves the package to another store directory, where rarog restart refuses the old service.
    expect(repairCommands('package', PNPM_ROOT).afterUpdate).toBe('rarog service install');
    expect(repairCommands('package', '/x/rarog').afterUpdate).toBe('rarog service install');
    expect(repairCommands('clone', PNPM_ROOT).afterUpdate).toBe('pnpm run restart');
    expect(repairCommands('package', '/x/rarog').dependencies)
      .toBe('npm i -g @rarog/server@latest or pnpm add -g @rarog/server@latest');
    expect(repairCommands('clone', PNPM_ROOT)).toEqual(REPAIR);
    expect(rarogCli('service install', 'package')).toBe('rarog service install');
    expect(packageCommands('npm')).toEqual({
      install: 'npm i -g @rarog/server', update: 'npm i -g @rarog/server@latest',
      uninstall: 'npm uninstall -g @rarog/server',
    });
    expect(packageCommands('pnpm')).toEqual({
      install: 'pnpm add -g @rarog/server', update: 'pnpm add -g @rarog/server@latest',
      uninstall: 'pnpm remove -g @rarog/server',
    });
    expect(packageCommands(null).uninstall).toBe('npm uninstall -g @rarog/server or pnpm remove -g @rarog/server');
    // Z korzeniem npm komendy celują w prefiks tej instalacji, nie w prefiks węzła bieżącej powłoki.
    expect(packageCommands('npm', NPM_ROOT)).toEqual({
      install: 'npm i -g @rarog/server',
      update: "npm i -g --prefix '/Users/a/.nvm/versions/node/v22.22.3' @rarog/server@latest",
      uninstall: "npm uninstall -g --prefix '/Users/a/.nvm/versions/node/v22.22.3' @rarog/server",
    });
    expect(packageCommands('npm', '/p/lib/node_modules/rarog').update).toBe("npm i -g --prefix '/p' @rarog/server@latest");
    expect(packageCommands('npm', "/Users/a/it's/lib/node_modules/@rarog/server").uninstall)
      .toBe("npm uninstall -g --prefix '/Users/a/it'\\''s' @rarog/server");
    expect(packageCommands('pnpm', PNPM_ROOT)).toEqual(packageCommands('pnpm'));
    expect(packageCommands('npm', '/x/rarog')).toEqual(packageCommands('npm'));
    expect(PACKAGE_INSTALL).toEqual({ npm: 'npm i -g @rarog/server', pnpm: 'pnpm add -g @rarog/server' });
    const hook = restartHookRepair(repairCommands('package', NPM_ROOT));
    expect(hook).toBe('review the changes (rarog hooks doctor), then rarog hooks install');
    expect(hook.length).toBeLessThanOrEqual(300);
  });

  // npm refuses @rarog/server while another package of the prefix owns the command `rarog` (EEXIST), so the package
  // this installation is goes first; a name that is no npm package name never reaches the shell or the terminal.
  it.each([
    ['npm', '/p/lib/node_modules/rarog', 'rarog',
      "npm uninstall -g --prefix '/p' rarog, then npm i -g --prefix '/p' @rarog/server@latest"],
    ['npm', '/p/lib/node_modules/@rarog/publish-trial', '@rarog/publish-trial',
      "npm uninstall -g --prefix '/p' @rarog/publish-trial, then npm i -g --prefix '/p' @rarog/server@latest"],
    ['pnpm', '/s/v11/links/@/rarog/0.1.0/abc/node_modules/rarog', 'rarog',
      'pnpm remove -g rarog, then pnpm add -g @rarog/server@latest'],
    [null, '/x/rarog', 'rarog', 'npm uninstall -g rarog or pnpm remove -g rarog, then npm i -g @rarog/server@latest'
      + ' or pnpm add -g @rarog/server@latest'],
    ['npm', '/p/lib/node_modules/rarog', undefined, "npm i -g --prefix '/p' @rarog/server@latest"],
    ['npm', '/p/lib/node_modules/rarog', 7, "npm i -g --prefix '/p' @rarog/server@latest"],
    ['npm', '/p/lib/node_modules/rarog', 'Rarog', "npm i -g --prefix '/p' @rarog/server@latest"],
    ['npm', '/p/lib/node_modules/rarog', 'rarog; rm -rf ~', "npm i -g --prefix '/p' @rarog/server@latest"],
    ['npm', '/p/lib/node_modules/rarog', 'rarog\u001b[2J', "npm i -g --prefix '/p' @rarog/server@latest"],
    ['npm', '/p/lib/node_modules/rarog', 'a'.repeat(215), "npm i -g --prefix '/p' @rarog/server@latest"],
  ] as const)('another package (%s, %s, name %j): %s', (manager, root, name, fix) => {
    expect(otherPackageFix(manager, root, name)).toBe(fix);
  });
});

describe('węzeł usługi z Homebrew: `opt/<formuła>` zamiast `Cellar` (każdy prefiks)', () => {
  let base = '';
  beforeEach(() => { base = mkdtempSync(path.join(tmpdir(), 'rarog-brew-')); });
  afterEach(() => { rmSync(base, { recursive: true, force: true }); });

  /** Węzeł `<prefiks>/Cellar/<formuła>/<wersja>/bin/node` i dowiązanie `opt/<formuła>` → `../Cellar/<formuła>/<cel>`. */
  function brew(prefix: string, formula: string, version: string, optTarget: string | null = version): string {
    const node = path.join(base, prefix, 'Cellar', formula, version, 'bin', 'node');
    mkdirSync(path.dirname(node), { recursive: true });
    writeFileSync(node, '');
    if (optTarget !== null) {
      mkdirSync(path.join(base, prefix, 'opt'), { recursive: true });
      mkdirSync(path.join(base, prefix, 'Cellar', formula, optTarget, 'bin'), { recursive: true });
      symlinkSync(path.join('..', 'Cellar', formula, optTarget), path.join(base, prefix, 'opt', formula));
    }
    return node;
  }

  it('`/opt/homebrew`, `/usr/local` i Linuxbrew: węzeł z `Cellar` → `<prefiks>/opt/<formuła>/bin/node`', () => {
    for (const [prefix, formula, version] of [
      ['opt/homebrew', 'node', '26.10.0_2'], ['usr/local', 'node@22', '22.22.0'],
      ['home/linuxbrew/.linuxbrew', 'node', '24.11.1'],
    ] as const) {
      const node = brew(prefix, formula, version);
      const opt = path.join(base, prefix, 'opt', formula, 'bin', 'node');
      expect(homebrewOptNode(node)).toBe(opt);
      expect(serviceTarget(node, '/r').node).toBe(opt);
      // Usługa z węzłem przez `opt` i komenda uruchomiona węzłem z `Cellar` to ta sama instalacja.
      expect(serviceInstallation([opt, '/r/bin/rarog.mjs', 'serve'], { node, bin: '/r/bin/rarog.mjs' }).otherNode)
        .toBe(false);
    }
  });

  it('`opt` wskazuje inną wersję albo go nie ma: zostaje ścieżka z `Cellar`; węzeł spoza Homebrew bez zmian', () => {
    const moved = brew('opt/homebrew', 'node', '26.10.0_2', '27.0.0');
    expect(homebrewOptNode(moved)).toBe(moved);
    const lonely = brew('usr/local', 'node', '22.22.0', null);
    expect(homebrewOptNode(lonely)).toBe(lonely);
    expect(homebrewOptNode('/Users/a/.nvm/versions/node/v22.22.3/bin/node'))
      .toBe('/Users/a/.nvm/versions/node/v22.22.3/bin/node');
    expect(homebrewOptNode('/opt/homebrew/Cellar/node/26.10.0_2/bin/nodejs')).toBe('/opt/homebrew/Cellar/node/26.10.0_2/bin/nodejs');
  });
});

describe('usługa wobec tej instalacji (`serviceInstallation`)', () => {
  const NODE = process.execPath;

  it('ta sama instalacja: wejście i węzeł tej komendy, także ze wrapperem przed węzłem', () => {
    expect(serviceInstallation(serviceArgv(['/usr/local/bin/w', '--'], ['serve']))).toEqual({
      bin: RAROG_BIN, node: serviceTarget().node, otherBin: false, otherNode: false,
    });
  });

  it('inna ścieżka wejścia, ścieżka, której już nie ma, i argv bez wejścia = inna instalacja', () => {
    const other = '/nie/ma/takiej/instalacji/bin/rarog.mjs';
    expect(serviceInstallation([NODE, other, 'serve'])).toMatchObject({ bin: other, otherBin: true, otherNode: false });
    expect(serviceInstallation([NODE, path.join(REPO, 'bin', 'rarog.mjs'), 'serve']).otherBin).toBe(false);
    expect(serviceInstallation(['/opt/x/node', 'serve'])).toMatchObject({ bin: undefined, otherBin: true });
    expect(serviceInstallation(['/nie/ma/node', RAROG_BIN, 'serve'])).toMatchObject({ otherBin: false, otherNode: true });
  });
});

describe('węzeł usługi: wersja', () => {
  it('bez sufitu linii: Node 24.x i 26.x przyjęte, 22.14 i 20.x odrzucone; 22.15 to dolna granica', () => {
    expect(nodeVersionOk('v24.11.1', null)).toBe(true);
    expect(nodeVersionOk('26.10.0', null)).toBe(true);
    expect(nodeVersionOk('v25.9.0', null)).toBe(true);
    expect(nodeVersionOk('v22.15.0', null)).toBe(true);
    expect(nodeVersionOk('v22.14.0', null)).toBe(false);
    expect(nodeVersionOk('v20.19.0', null)).toBe(false);
    expect(nodeVersionOk('nie wersja', null)).toBe(false);
    expect(nodeRequirement(null)).toBe('≥ 22.15, 23.x ≥ 23.11');
  });

  it('linia 23 bez `process.execve` przed 23.11 → odrzucona; 23.11 przyjęta', () => {
    expect(nodeVersionOk('v23.0.0', null)).toBe(false);
    expect(nodeVersionOk('v23.10.0', null)).toBe(false);
    expect(nodeVersionOk('v23.11.0', null)).toBe(true);
    expect(nodeVersionOk('v23.11.1', 24)).toBe(true);
    expect(serviceNodeVersionOk('v23.10.0')).toBe(false);
  });

  it('z sufitem 22: tylko 22.x ≥ 22.15; ten sam tekst w komunikatach', () => {
    expect(nodeVersionOk('v22.22.3', 22)).toBe(true);
    expect(nodeVersionOk('v24.11.1', 22)).toBe(false);
    expect(nodeVersionOk('v22.14.0', 22)).toBe(false);
    expect(nodeRequirement(22)).toBe('22.x ≥ 22.15');
    expect(nodeRequirement(24)).toBe('22.15–24.x, 23.x ≥ 23.11');
  });

  it('granica usługi = bramka `bin/rarog.mjs` = `engines` w `package.json` (zmieniają się razem)', () => {
    const bin = readFileSync(path.join(REPO, 'bin', 'rarog.mjs'), 'utf8');
    const gate = {
      min: `${/const MIN_MAJOR = (\d+);/u.exec(bin)?.[1] ?? '?'}.${/const MIN_MINOR = (\d+);/u.exec(bin)?.[1] ?? '?'}`,
      min23: `23.${/const MIN_MINOR_23 = (\d+);/u.exec(bin)?.[1] ?? '?'}`,
      max: /const MAX_MAJOR = (\d+);/u.exec(bin)?.[1] ?? null,
    };
    const engines = (JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8')) as { engines: { node: string } })
      .engines.node;
    const min = `22.${String(MIN_NODE_MINOR)}`;
    const min23 = `23.${String(MIN_NODE_23_MINOR)}`;
    expect(gate).toEqual({ min, min23, max: NODE_MAX_MAJOR === null ? null : String(NODE_MAX_MAJOR) });
    const upper = NODE_MAX_MAJOR === null ? '' : ` <${String(NODE_MAX_MAJOR + 1)}`;
    expect(engines).toBe(NODE_MAX_MAJOR === 22 ? `>=${min} <23` : `>=${min} <23 || >=${min23}${upper}`);
    expect(serviceNodeVersionOk(process.version)).toBe(true);
    expect(serviceNodeVersionOk('v24.11.1')).toBe(NODE_MAX_MAJOR === null || NODE_MAX_MAJOR >= 24);
  });

  it('CI: każdy `setup-node` z jawną wersją (zakres `engines` nie ma sufitu), macierze Node od linii 22', () => {
    const dir = path.join(REPO, '.github', 'workflows');
    const files = readdirSync(dir).filter((name) => name.endsWith('.yml'));
    expect(files).toContain('check.yml');
    for (const name of files) {
      const text = readFileSync(path.join(dir, name), 'utf8');
      expect(text, name).not.toMatch(/^ +node-version-file:/mu);
      const setups = text.match(/uses: actions\/setup-node@/gu)?.length ?? 0;
      expect(text.match(/^ +node-version: \S/gmu)?.length ?? 0, name).toBe(setups);
    }
    const check = readFileSync(path.join(dir, 'check.yml'), 'utf8');
    const matrices = [...check.matchAll(/^ +node: \[([^\]]*)\]$/gmu)].map((match) => match[1]);
    // Lines 24 and 26 are checked only by the `package` job; the other jobs run Node 22
    // (`server/test/ci-check-workflow.test.ts`).
    expect(matrices, '`package` job matrix').toEqual(['22, 24, 26']);
  });
});
