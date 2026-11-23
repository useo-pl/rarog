/**
 * `rarog setup`: tworzy wyłącznie to, czego brak, każdą rzecz po pytaniu `[t/N]`, i niczego istniejącego nie zmienia.
 *
 * Najważniejszy jest test stanu właściciela: `config.json` jako dowiązanie z `service.wrapper`, zgodna kopia hooka
 * bez skryptu `statusLine`, własny `statusLine`, plist i załadowana `ai.rarog.server`. Na „t” do wszystkiego setup
 * ma tam zero pytań, zero zapisów (skróty drzewa `HOME` przed i po równe) i zero wywołań, które coś zmieniają.
 *
 * Wszystko na atrapach z `PATH` (`launchctl`, `tailscale`, `claude`, `herdr`, `bash` z logiem), `HOME` tymczasowy,
 * `/health` z serwera HTTP testu. Linux na atrapach `systemd --user` ze `systemd-atrapy.ts` (`CliIo.platform`).
 * Setup biegnie w procesie testów (`setupCommand` z wstrzykniętymi odpowiedziami i zależnościami); jeden test woła
 * prawdziwe `bin/rarog.mjs` bez terminala.
 *
 * The harness (fakes, `runSetup`, helpers) is shared with `setup-*.test.ts`: `helpers/setup-harness.ts`.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync,
  symlinkSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CliIo } from '../src/cli/io.ts';
import { main } from '../src/cli/main.ts';
import { serviceInstallIfAbsent } from '../src/cli/service.ts';
import { DEFAULT_PUSH_RELAY_URL } from '../src/cli/setup-config.ts';
import { DEFAULT_IROH_RELAY } from '../src/cli/setup.ts';
import { herdrUnitPath, renderHerdrUnit } from '../src/cli/setup-herdr-unit.ts';
import { escapeExecProgram, renderExecStart } from '../src/cli/systemd-unit.ts';
import { rarogCli } from '../src/install/repair.ts';
import {
  HOOK_INSTALL_FILES, STATUSLINE_INSTALL_FILES, contextHookCommand, denyReadBlock, denyReadPaths,
  hookBlock, hookCommand, hookInstallDir, pasteHookBlock, statuslineCommand, userSettingsPath,
} from '../src/herdr/hook-config.ts';
import { OLD_ENTRY_FILE } from '../src/herdr/hook-commands.ts';
import {
  CLI, HAS_CHECKOUT, HOOKS_SRC, KEY_LINE, REPO, TS_HOST, YES, bin, calls, changedEntries, checkoutOnly, configDir, configFile,
  copyHooks, dataDirOf, deadPort, env, home, listenHerdr, logs, markLoaded, plist, port, runSetup, secretFile,
  setHealthBody, state, summaryLine, t, treeHash, useSetupHarness, write, writeBlockOf, writeConfig, writeDump,
  writeHerdrAgent, writeSecrets, writeSettings,
} from './helpers/setup-harness.ts';
import type { Question, Result, RunOptions } from './helpers/setup-harness.ts';
import { IS_MAC, macOnly } from './platform.ts';
import { MANAGER_PATH, fake, linuxSandbox } from './systemd-atrapy.ts';
import type { LinuxSandbox } from './systemd-atrapy.ts';

useSetupHarness();

// ---------------------------------------------------------------------------
// Stan właściciela
// ---------------------------------------------------------------------------

describe.skipIf(!IS_MAC)(macOnly('rarog setup na instalacji właściciela: raport i wydruki, zero zmian', 'launchd'), () => {
  /** Instalacja właściciela; zwraca cel dowiązania `config.json`. */
  async function ownerInstall(healthPort: number): Promise<string> {
    const target = path.join(home, 'repo-konfiguracji', 'rarog', 'config.json');
    const socket = path.join(t.home, 'hs.sock');
    write(target, JSON.stringify({
      version: 1,
      env: {
        RAROG_ORIGINS: `https://${TS_HOST}`, RAROG_PORT: String(healthPort), RAROG_HERDR_SOCKET: socket,
        RAROG_PROJECT_ROOTS: path.join(home, 'Projects'), RAROG_HERDR_LAUNCH: '1', RAROG_TERM: '1',
      },
      service: { wrapper: ['/opt/sekrety/bin/uruchom', '--'] },
    }, null, 2), 0o640);
    mkdirSync(configDir(), { recursive: true, mode: 0o700 });
    symlinkSync(target, configFile());
    // Kopia sprzed skryptu `statusLine`: dwa pliki hooka i manifest bez wpisu skryptu. Własny pasek statusu sam pisze
    // zrzuty (zrzut z ostatniej godziny), a `denyRead` nie ma ścieżek Raroga.
    copyHooks(HOOK_INSTALL_FILES);
    writeSettings('bash ~/.claude/moj-pasek.sh');
    writeDump(5 * 60 * 1000);
    write(plist(), '<?xml version="1.0"?><plist version="1.0"><dict/></plist>\n');
    markLoaded();
    writeFileSync(path.join(state, 'serve-status'), JSON.stringify({
      TCP: { 443: { HTTPS: true } },
      Web: { [`${TS_HOST}:443`]: { Handlers: { '/': { Proxy: `http://127.0.0.1:${String(healthPort)}` } } } },
    }));
    mkdirSync(path.join(home, 'Projects'));
    writeHerdrAgent({ socket });
    await listenHerdr(socket);
    return target;
  }

  for (const variant of ['zdrowy', 'martwy', 'herdr: false'] as const) {
    it(`/health ${variant}: „t” na wszystko → jedno pytanie (denyRead, blokada zapisu), jeden zapis ustawień, poza nim zero zmian`, async () => {
      const healthPort = variant === 'martwy' ? await deadPort() : port;
      if (variant === 'herdr: false') setHealthBody({ ok: true, herdr: false });
      const target = await ownerInstall(healthPort);
      const before = treeHash(home);
      const targetBefore = { mode: statSync(target).mode, text: readFileSync(target, 'utf8') };
      const settingsBefore = readFileSync(userSettingsPath(home), 'utf8');

      const run = await runSetup({ deps: { checkPort: healthPort } });

      // `statusLine` bez zmian (cudza komenda ze świeżym zrzutem), `denyRead` dostaje dwie ścieżki po „t”, a
      // `permissions.deny` dwie reguły blokady zapisu.
      expect(run.asked).toEqual(['settings']);
      expect(run.installs).toBe(0);
      const settingsAfter = JSON.parse(readFileSync(userSettingsPath(home), 'utf8')) as Record<string, unknown>;
      expect(settingsAfter).toEqual({
        ...JSON.parse(settingsBefore) as object, sandbox: { filesystem: { denyRead: denyReadPaths(dataDirOf()) } },
        ...writeBlockOf(),
      });
      // Poza plikiem ustawień (i katalogiem `.claude`, w którym `rename` podmienia wpis) zmienia się tylko katalog
      // danych: kopia zapasowa oryginału, bajt w bajt.
      const backupDir = path.join(dataDirOf(), 'claude-settings-backup');
      const backups = readdirSync(backupDir);
      expect(backups).toHaveLength(1);
      expect(readFileSync(path.join(backupDir, backups[0] ?? ''), 'utf8')).toBe(settingsBefore);
      // Katalog konfiguracji zmienia tylko czas: blokada Raroga na czas zapisu powstaje w nim i znika.
      const changed = changedEntries(before, treeHash(home));
      expect(changed.filter((key) => !key.startsWith('.local')))
        .toEqual(['.claude', '.claude/settings.json', '.config/rarog']);
      expect(readdirSync(configDir()).sort()).toEqual(['config.json']);
      expect(changed.filter((key) => key.startsWith('.local')).every((key) => !before.has(key))).toBe(true);
      expect(summaryLine(run.stdout, 'Settings:')).toMatch(/^ {2}ok {7}Settings: 2 entries added, backup kept$/);
      expect(lstatSync(configFile()).isSymbolicLink()).toBe(true);
      expect(readlinkSync(configFile())).toBe(target);
      expect({ mode: statSync(target).mode, text: readFileSync(target, 'utf8') }).toEqual(targetBefore);
      // `launchctl` tylko odczyt, `tailscale` tylko stan mapowania, `bash` (restart.sh) wcale.
      expect(calls('launchctl').filter((line) => !line.startsWith('print '))).toEqual([]);
      expect(calls('tailscale')).toEqual(calls('tailscale').map(() => 'serve status --json'));
      expect(calls('tailscale').length).toBeGreaterThan(0);
      expect(calls('bash')).toEqual([]);

      expect(run.stdout).toContain('skipped: service.wrapper from config.json supplies the secrets');
      expect(run.stdout).toContain(`mapping ${TS_HOST} → port ${String(healthPort)}: present`);
      expect(run.stdout).toContain('custom statusLine command: bash ~/.claude/moj-pasek.sh');
      expect(summaryLine(run.stdout, 'hook copy:')).toMatch(/^ {2}ok {7}hook copy: matches the source$/);
      if (variant === 'zdrowy') {
        expect(summaryLine(run.stdout, 'service')).toContain('service: running');
        expect(run.code).toBe(0);
      } else {
        expect(summaryLine(run.stdout, 'service')).toMatch(/PROBLEM .*: pnpm run restart$/);
        expect(run.code).toBe(1);
      }
      // At the end the check reads /health (without writes) of a healthy service; an unhealthy one carries its fix on
      // the service step, and the check waits for that step.
      expect(run.stdout).toContain('Summary:');
      expect(run.stdout).toMatch(variant === 'zdrowy' ? /\ncheck: hook · SDK · herdr ok\n/u
        : /\ncheck: waits for Service\n/u);
    });
  }
});

// ---------------------------------------------------------------------------
// Pusty dom: pytania, odpowiedzi, zapisy
// ---------------------------------------------------------------------------

describe.skipIf(!IS_MAC)(macOnly('rarog setup w pustym domu', 'launchd'), () => {
  beforeEach(async () => {
    mkdirSync(path.join(home, 'Projects'));
    await listenHerdr(path.join(home, '.config', 'herdr', 'herdr.sock'));
  });

  it.skipIf(!HAS_CHECKOUT)(checkoutOnly('yes to everything: iroh key, config.json with iroh and Tailscale, tailscale serve, copy, hook entries, statusLine, denyRead, service; no blocks to paste'), async () => {
    const run = await runSetup();

    expect(run.asked).toEqual(['tailscale-only', 'continue', 'dictation', 'tailscale', 'settings']);
    const config = JSON.parse(readFileSync(configFile(), 'utf8')) as { version: number; env: Record<string, string> };
    expect(config).toEqual({
      version: 1,
      env: {
        RAROG_ORIGINS: `https://${TS_HOST}:8931`,
        RAROG_HERDR_LAUNCH: '1',
        RAROG_TERM: '1',
        RAROG_PUSH: '1',
        RAROG_PUSH_RELAY_URL: DEFAULT_PUSH_RELAY_URL,
        RAROG_PROJECT_ROOTS: home,
        RAROG_HERDR_ROOTS: home,
        RAROG_HERDR_BIN: path.join(bin, 'herdr'),
        RAROG_IROH: '1',
        RAROG_IROH_RELAY: DEFAULT_IROH_RELAY,
      },
    });
    expect(statSync(configFile()).mode & 0o777).toBe(0o600);
    expect(statSync(configDir()).mode & 0o777).toBe(0o700);

    // The iroh server key: a new secrets file 0600 in a 0700 directory with only the key line; the value never shows.
    const secrets = readFileSync(secretFile(), 'utf8');
    expect(secrets).toMatch(/^RAROG_IROH_KEY=[0-9a-f]{64}\n$/);
    expect(run.stdout).not.toContain(KEY_LINE.exec(secrets)?.[1] ?? 'no key');
    expect(statSync(secretFile()).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(secretFile())).mode & 0o777).toBe(0o700);
    expect(summaryLine(run.stdout, 'private.env')).toMatch(/^ {2}ok {7}\/.*private\.env: present$/);
    // The dictation key stays optional: a command instead of editing the file by hand.
    const secretsLine = run.stdout.split('\n').find((text) => text.includes('SONIOX_API_KEY'));
    expect(secretsLine).toContain(rarogCli('dictation set-key'));
    expect(secretsLine).not.toContain('SONIOX_API_KEY=');

    expect(calls('tailscale')).toEqual(['status --json', 'serve status --json', 'serve status --json',
      'serve status --json', 'serve --bg --https=8931 8930', 'serve status --json']);
    expect(readdirSync(hookInstallDir(home)).sort()).toEqual(
      [...HOOK_INSTALL_FILES, ...STATUSLINE_INSTALL_FILES, 'manifest.json'].sort());
    expect(run.installs).toBe(1);
    // Rarog's entries: one write of a new 0600 file with the five entries after one question; the set equals
    // the block of `rarog hooks print`. No block to paste.
    expect(JSON.parse(readFileSync(userSettingsPath(home), 'utf8'))).toEqual({
      ...pasteHookBlock(hookCommand(home), contextHookCommand(home)) as object,
      statusLine: { type: 'command', command: statuslineCommand(home) },
      ...denyReadBlock(dataDirOf()) as object,
      ...writeBlockOf(),
    });
    expect(statSync(userSettingsPath(home)).mode & 0o777).toBe(0o600);
    expect(run.stdout).toContain(`written: ${userSettingsPath(home)} (new file, mode 600`);
    // One write of a new file: no backup.
    expect(existsSync(path.join(dataDirOf(), 'claude-settings-backup'))).toBe(false);
    expect(summaryLine(run.stdout, 'hook copy:')).toMatch(/^ {2}ok {7}hook copy: matches the source$/);
    expect(summaryLine(run.stdout, 'Settings:')).toMatch(/^ {2}ok {7}Settings: 5 entries added$/);
    expect(run.stdout).not.toContain('merge it with the existing `hooks`');
    expect(run.stdout).not.toContain('Paste this block');
    expect(run.stdout).not.toContain('merge with the existing "sandbox"');
    expect(run.stdout).toContain(`+  "statusLine": {`);
    expect(run.stdout).toContain('+        "~/.config/rarog/secret",');
    // Wszystkie kroki `ok` albo `info`: bez wpisów do wklejenia setup kończy się kodem 0.
    expect(run.code).toBe(0);
    // Brak plików tymczasowych po zapisie przez `link`.
    expect(readdirSync(configDir()).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  for (const eof of [true, false]) {
    it(`${eof ? 'EOF' : '„n”'} na każde pytanie: zero zapisów, kod 1`, async () => {
      const before = treeHash(home);
      const run = await runSetup({ answer: () => (eof ? null : 'n') });
      // The transport question writes nothing; "n" on the plan stops the run before any step.
      expect(run.asked).toEqual(['tailscale-only', 'continue']);
      expect(treeHash(home)).toEqual(before);
      expect(calls('tailscale')).toEqual([]);
      expect(run.installs).toBe(0);
      expect(run.code).toBe(1);
    });
  }

  /** Odmowa (`n` albo EOF) jednego pytania przy „t” na resztę: czego ma nie być i co ma powstać mimo to. */
  const single: readonly {
    readonly question: Question;
    readonly absent: () => boolean;
    readonly still: () => boolean;
    /** `still` sprawdza kopię hooka. */
    readonly checkout?: true;
  }[] = [
    {
      question: 'tailscale', absent: () => !calls('tailscale').some((line) => line.startsWith('serve --bg')),
      still: () => existsSync(configFile()) && existsSync(hookInstallDir(home)), checkout: true,
    },
  ];
  for (const { question, absent, still, checkout } of single) {
    for (const reply of ['n', null] as const) {
      const title = `${reply === null ? 'EOF' : '„n”'} na pytanie ${question}: tej rzeczy nie ma, reszta powstaje`;
      it.skipIf(checkout === true && !HAS_CHECKOUT)(checkout === true ? checkoutOnly(title) : title, async () => {
        const run = await runSetup({ answer: (q) => (q === question ? reply : YES(q)) });
        expect(run.asked).toContain(question);
        expect(absent()).toBe(true);
        expect(still()).toBe(true);
      });
    }
  }

});

// ---------------------------------------------------------------------------
// Stan istniejący, ale nie w porządku: diagnoza bez zapisu
// ---------------------------------------------------------------------------

describe.skipIf(!IS_MAC)(macOnly('rarog setup: stan istniejący, ale zepsuty — diagnoza i komenda, bez zapisu', 'launchd'), () => {
  it.skipIf(!HAS_CHECKOUT)(checkoutOnly('zgodna kopia hooka bez skryptu i bez statusLine: „t” dokłada sam skrypt, hook i manifest bez zmian'), async () => {
    copyHooks(HOOK_INSTALL_FILES);
    writeSettings(null);
    const dir = hookInstallDir(home);
    const hookFiles = new Map([...HOOK_INSTALL_FILES, 'manifest.json'].map((name) => [
      name, readFileSync(path.join(dir, name), 'utf8'),
    ]));
    const run = await runSetup({ answer: (q) => (q === 'statusline' || q === 'continue' ? 't' : 'n') });
    expect(run.asked).toContain('statusline');
    expect(run.asked).not.toContain('hook');
    expect(readFileSync(path.join(dir, 'rarog-statusline.mjs'), 'utf8'))
      .toBe(readFileSync(path.join(HOOKS_SRC, 'rarog-statusline.mjs'), 'utf8'));
    for (const [name, text] of hookFiles) expect(readFileSync(path.join(dir, name), 'utf8')).toBe(text);
    expect(summaryLine(run.stdout, 'hook copy:')).toMatch(/ok {7}hook copy: matches the source/);
    expect(summaryLine(run.stdout, 'Settings:')).toMatch(/MISSING .*skipped \(add by hand: rarog hooks print\)/);
  });

  it('statusLine wskazuje kopię skryptu, a kopii brak: PROBLEM z komendą, bez pytania', async () => {
    copyHooks(HOOK_INSTALL_FILES);
    writeSettings(statuslineCommand(home));
    writeSettings(statuslineCommand(home), home, { denyRead: true });
    const run = await runSetup({ answer: null });
    expect(run.asked).toEqual([]);
    expect(summaryLine(run.stdout, 'Settings:')).toMatch(/MISSING .*status line script out of date/);
    expect(existsSync(path.join(hookInstallDir(home), 'rarog-statusline.mjs'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Usługa (macOS) i bez terminala
// ---------------------------------------------------------------------------

describe.skipIf(!IS_MAC)(macOnly('rarog setup: usługa launchd', 'launchd'), () => {
  beforeEach(() => {
    writeConfig({ RAROG_ORIGINS: 'https://rarog.example.net', RAROG_PORT: String(port) });
    writeSecrets();
  });

  it('plist jest, etykieta niezaładowana: PROBLEM, bez pytania i bez instalacji', async () => {
    write(plist(), '<plist/>\n');
    await listenHerdr(path.join(home, '.config', 'herdr', 'herdr.sock'));
    const run = await runSetup();
    expect(run.asked).not.toContain('service');
    expect(run.installs).toBe(0);
    expect(summaryLine(run.stdout, 'service')).toMatch(/PROBLEM .*run node bin\/rarog\.mjs service install by hand$/);
  });

  it('etykieta załadowana bez plistu: bez instalacji, stan z /health', async () => {
    markLoaded();
    const run = await runSetup();
    expect(run.installs).toBe(0);
    expect(summaryLine(run.stdout, 'service')).toContain('service: running');
  });

  it('launchctl print nie rozstrzyga: PROBLEM, bez instalacji', async () => {
    writeFileSync(path.join(state, 'launchctl-odmowa'), '');
    await listenHerdr(path.join(home, '.config', 'herdr', 'herdr.sock'));
    const run = await runSetup();
    expect(run.installs).toBe(0);
    expect(summaryLine(run.stdout, 'service')).toMatch(/PROBLEM .*Operation not permitted/);
  });

  it('brak usługi, herdr bez gniazda: bez pytania, instrukcja', async () => {
    const run = await runSetup();
    expect(run.asked).not.toContain('service');
    expect(run.installs).toBe(0);
    expect(run.stdout).toContain('herdr is not running');
    expect(summaryLine(run.stdout, 'service')).toMatch(/MISSING .*herdr first/);
  });

  it('brak usługi, żywe gniazdo herdr, „t”: rarog service install', async () => {
    await listenHerdr(path.join(home, '.config', 'herdr', 'herdr.sock'));
    const run = await runSetup();
    expect(run.asked).toContain('continue');
    expect(run.installs).toBe(1);
    expect(summaryLine(run.stdout, 'service')).toContain('service: installed');
  });

  it('Ctrl-C in rarog service install (code 130): setup ends with 130, no summary and no check', async () => {
    await listenHerdr(path.join(home, '.config', 'herdr', 'herdr.sock'));
    const run = await runSetup({ deps: { serviceInstall: () => Promise.resolve(130) } });
    expect(run.asked).toContain('continue');
    expect(run.code).toBe(130);
    expect(run.stdout).not.toContain('check: ');
    expect(run.stdout).not.toContain('Summary:');
    // The run log opened at the first "y", so the line also says where it is.
    expect(run.stdout).toMatch(/Interrupted\. Nothing after this step was changed\.\n {3}Log: \S+\/logs\/setup-\S+\.log\n$/u);
  });

  it('usługa zainstalowana w trakcie pytania o ustawienia: krok usługi ją widzi, bez instalacji', async () => {
    await listenHerdr(path.join(home, '.config', 'herdr', 'herdr.sock'));
    const run = await runSetup({
      answer: (q) => {
        if (q === 'settings') {
          write(plist(), '<plist/>\n');
          markLoaded();
        }
        return YES(q);
      },
    });
    expect(run.asked).toContain('settings');
    expect(run.installs).toBe(0);
    expect(run.refusals).toEqual([]);
    expect(summaryLine(run.stdout, 'service')).toMatch(/ok {7}service: running/);
  });

  it('dowiązanie rarog do innego checkoutu: bez pytania o usługę, dowiązanie bez zmian', async () => {
    await listenHerdr(path.join(home, '.config', 'herdr', 'herdr.sock'));
    const link = path.join(home, '.local', 'bin', 'rarog');
    mkdirSync(path.dirname(link), { recursive: true });
    symlinkSync('/opt/inny-checkout/bin/rarog.mjs', link);
    const run = await runSetup();
    expect(run.asked).not.toContain('service');
    expect(run.installs).toBe(0);
    expect(readlinkSync(link)).toBe('/opt/inny-checkout/bin/rarog.mjs');
    expect(summaryLine(run.stdout, 'service')).toMatch(/PROBLEM .*setup does not change it/);
  });

  it('paczka npm: dowiązanie rarog do innego checkoutu nie blokuje usługi (jej service install go nie zakłada)', async () => {
    await listenHerdr(path.join(home, '.config', 'herdr', 'herdr.sock'));
    const link = path.join(home, '.local', 'bin', 'rarog');
    mkdirSync(path.dirname(link), { recursive: true });
    symlinkSync('/opt/inny-checkout/bin/rarog.mjs', link);
    const run = await runSetup({
      deps: {
        mode: 'package', installRoot: '/opt/n/lib/node_modules/@rarog/server',
        sdkInstall: (options) => Promise.resolve({ ok: true, dir: options.dataDir, raced: false }),
      },
    });
    expect(run.asked).toContain('continue');
    expect(run.refusals).toEqual([]);
    expect(run.installs).toBe(1);
    expect(readlinkSync(link)).toBe('/opt/inny-checkout/bin/rarog.mjs');
  });

  it('paczka npm bez kopii hooka: różnica (nowe pliki) przed pytaniem, jedno pytanie, manifest z wersją paczki', async () => {
    const pkg = path.join(t.home, 'lib', 'node_modules', 'rarog');
    mkdirSync(path.join(pkg, 'scripts', 'hooks'), { recursive: true });
    writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'rarog', version: '3.1.4' }));
    for (const name of [...HOOK_INSTALL_FILES, ...STATUSLINE_INSTALL_FILES]) {
      copyFileSync(path.join(HOOKS_SRC, name), path.join(pkg, 'scripts', 'hooks', name));
    }
    const run = await runSetup({
      deps: {
        mode: 'package', installRoot: pkg,
        sdkInstall: (options) => Promise.resolve({ ok: true, dir: options.dataDir, raced: false }),
      },
    });
    expect(run.asked.filter((one) => one === 'hook')).toHaveLength(1);
    const diff = run.stdout.indexOf('against package version 3.1.4');
    expect(diff).toBeGreaterThan(-1);
    expect(run.stdout.indexOf('+ tall-dialog.mjs: new file')).toBeGreaterThan(diff);
    expect(run.stdout.indexOf('Install the hook copy')).toBeGreaterThan(run.stdout.indexOf('+ tall-dialog.mjs'));
    expect(run.stdout).toContain('copy written (version 3.1.4)');
    const manifest = JSON.parse(readFileSync(path.join(hookInstallDir(home), 'manifest.json'), 'utf8')) as
      Record<string, unknown>;
    expect(manifest['version']).toBe('3.1.4');
    expect(manifest).not.toHaveProperty('commit');
  });

  it('paczka npm, „nie” po różnicy: kopia nie powstaje, krok hooka zostaje „BRAK”', async () => {
    const pkg = path.join(t.home, 'lib', 'node_modules', 'rarog');
    mkdirSync(path.join(pkg, 'scripts', 'hooks'), { recursive: true });
    writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'rarog', version: '3.1.4' }));
    for (const name of [...HOOK_INSTALL_FILES, ...STATUSLINE_INSTALL_FILES]) {
      copyFileSync(path.join(HOOKS_SRC, name), path.join(pkg, 'scripts', 'hooks', name));
    }
    const run = await runSetup({
      answer: (q) => (q === 'hook' ? 'n' : YES(q)),
      deps: {
        mode: 'package', installRoot: pkg,
        sdkInstall: (options) => Promise.resolve({ ok: true, dir: options.dataDir, raced: false }),
      },
    });
    expect(run.asked.filter((one) => one === 'hook')).toHaveLength(1);
    expect(run.stdout).toContain('+ tall-dialog.mjs: new file');
    expect(existsSync(path.join(hookInstallDir(home), 'tall-dialog.mjs'))).toBe(false);
    expect(summaryLine(run.stdout, 'hook copy:')).toMatch(/MISSING .*hook copy: rarog hooks install/);
  });

  it('serviceInstallIfAbsent: odmowa precheck pod blokadą, zanim cokolwiek się zmieni', async () => {
    let stderr = '';
    const io: CliIo = { stdout: () => {}, stderr: (text) => { stderr += text; }, env: env(), cwd: t.home };
    const code = await serviceInstallIfAbsent(io, () => 'the service appeared during the question');
    expect(code).toBe(1);
    expect(stderr).toContain('rarog service install: the service appeared during the question');
    expect(calls('launchctl')).toEqual([]);
    expect(existsSync(plist())).toBe(false);
    // Blokada zwolniona: zostaje tylko katalog konfiguracji z plikami testu.
    expect(readdirSync(configDir()).sort()).toEqual(['config.json', 'secret']);
  });

  /** Plist w kształcie z `rarog service install` (bez wrappera): węzeł, wejście `bin` i `serve`. */
  const plistFor = (bin: string): string => '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>'
    + '<key>Label</key><string>ai.rarog.server</string><key>ProgramArguments</key><array>'
    + `<string>/opt/n/bin/node</string><string>${bin}</string><string>serve</string></array></dict></plist>\n`;
  const OTHER = '/opt/inna/bin/rarog.mjs';

  it('usługa startuje inną instalację: kopia hooka i skryptu statusLine bez pytania i bez zapisu, dom bez zmian', async () => {
    write(plist(), plistFor(OTHER));
    markLoaded();
    const before = treeHash(home);
    // The `denyRead` paths do not need the copy, so the settings step asks even with another installation's service;
    // "n" leaves home as it was.
    const run = await runSetup({ answer: (q) => (q === 'settings' ? 'n' : YES(q)) });
    expect(run.asked).not.toContain('hook');
    expect(run.asked).not.toContain('statusline');
    expect(run.asked).toContain('settings');
    expect(treeHash(home)).toEqual(before);
    expect(existsSync(hookInstallDir(home))).toBe(false);
    expect(summaryLine(run.stdout, 'hook copy')).toMatch(/PROBLEM .*hook copy: the service /);
    // The refusal in the hook copy step and in the summary, with the service's install command.
    expect(run.stdout.split(`: the service `)).toHaveLength(3);
    expect(run.stdout).toContain(`The service's installation installs the copy: \`'/opt/n/bin/node' '${OTHER}' hooks install\`.`);
    expect(summaryLine(run.stdout, 'service')).toContain('service: running');
  });

  it('krok statusLine przy zgodnej kopii hooka: usługa innej instalacji → skryptu nie ma, bez pytania', async () => {
    copyHooks(HOOK_INSTALL_FILES);
    writeSettings(null);
    write(plist(), plistFor(OTHER));
    markLoaded();
    const before = treeHash(home);
    const run = await runSetup({ answer: (q) => (q === 'settings' ? 'n' : YES(q)) });
    expect(run.asked).toEqual(['settings']);
    expect(treeHash(home)).toEqual(before);
    expect(existsSync(path.join(hookInstallDir(home), STATUSLINE_INSTALL_FILES[0]))).toBe(false);
    expect(run.stdout).toContain(': the service ');
    expect(summaryLine(run.stdout, 'hook copy:')).toMatch(/ok {7}hook copy: matches the source$/);
  });

  it('`.claude` dowiązane poza HOME (bez pliku usługi): kopia hooka i skryptu statusLine bez pytania i bez zapisu', async () => {
    const other = path.join(t.home, 'inny-dom', '.claude');
    mkdirSync(other, { recursive: true });
    rmSync(path.join(home, '.claude'), { recursive: true, force: true });
    symlinkSync(other, path.join(home, '.claude'));
    const run = await runSetup({ answer: (q) => (q === 'settings' ? 'n' : YES(q)) });
    expect(run.asked).not.toContain('hook');
    expect(run.asked).not.toContain('statusline');
    expect(run.asked).toContain('settings');
    expect(readdirSync(other)).toEqual([]);
    expect(summaryLine(run.stdout, 'hook copy')).toMatch(/PROBLEM .*hook copy: the copy directory leads outside HOME/);
  });

  it('plist bez ProgramArguments (celu nie widać): kopia hooka bez pytania i bez zapisu', async () => {
    write(plist(), '<?xml version="1.0"?><plist version="1.0"><dict/></plist>\n');
    const run = await runSetup();
    expect(run.asked).not.toContain('hook');
    expect(existsSync(hookInstallDir(home))).toBe(false);
    expect(summaryLine(run.stdout, 'hook copy')).toMatch(/PROBLEM .*cannot tell which installation the service starts/);
  });

  it.skipIf(!HAS_CHECKOUT)(checkoutOnly('usługa startuje tę instalację: kopia hooka z planu, jak bez usługi'), async () => {
    write(plist(), plistFor(path.join(REPO, 'bin', 'rarog.mjs')));
    markLoaded();
    const run = await runSetup();
    expect(run.asked).toEqual(['continue', 'settings']);
    expect(readdirSync(hookInstallDir(home)).sort()).toEqual(
      [...HOOK_INSTALL_FILES, ...STATUSLINE_INSTALL_FILES, 'manifest.json'].sort());
  });

  it('paczka npm obok usługi klonu: bez różnicy i pytania o kopię; odmowa podaje też przepięcie usługi', async () => {
    const pkg = path.join(t.home, 'lib', 'node_modules', 'rarog');
    mkdirSync(path.join(pkg, 'scripts', 'hooks'), { recursive: true });
    writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'rarog', version: '3.1.4' }));
    for (const name of [...HOOK_INSTALL_FILES, ...STATUSLINE_INSTALL_FILES]) {
      copyFileSync(path.join(HOOKS_SRC, name), path.join(pkg, 'scripts', 'hooks', name));
    }
    write(plist(), plistFor(path.join(REPO, 'bin', 'rarog.mjs')));
    markLoaded();
    const run = await runSetup({
      deps: {
        mode: 'package', installRoot: pkg,
        sdkInstall: (options) => Promise.resolve({ ok: true, dir: options.dataDir, raced: false }),
      },
    });
    expect(run.asked).not.toContain('hook');
    expect(run.asked).not.toContain('statusline');
    expect(run.stdout).not.toContain('against package version');
    expect(existsSync(hookInstallDir(home))).toBe(false);
    expect(run.stdout).toContain('or first point the service at this installation (`rarog service install`), then'
      + ' `rarog hooks install`.');
  });
});

// ---------------------------------------------------------------------------
// Aktualizacja kopii hooka
// ---------------------------------------------------------------------------

describe.skipIf(!IS_MAC)(macOnly('rarog setup: kopia hooka różna od źródła — aktualizacja po różnicy albo `git log` i „t”', 'launchd'), () => {
  const COPY_FILES = [...HOOK_INSTALL_FILES, ...STATUSLINE_INSTALL_FILES];
  const sha = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
  const source = (name: string): string => readFileSync(path.join(HOOKS_SRC, name), 'utf8');
  /** `tall-dialog.mjs` nowszej paczki: źródło z dopisaną linią. */
  const NEWER_TALL = `${source('tall-dialog.mjs')}// 3.2.0\n`;
  /** Commit kopii sprzed `HEAD`: `git log` go tylko drukuje (płytki klon CI nie ma przodków `HEAD`). */
  const OLD_COMMIT = 'c'.repeat(40);
  /** Plist usługi innej instalacji (kształt z `rarog service install`). */
  const OTHER_PLIST = '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>Label</key>'
    + '<string>ai.rarog.server</string><key>ProgramArguments</key><array><string>/opt/n/bin/node</string>'
    + '<string>/opt/inna/bin/rarog.mjs</string><string>serve</string></array></dict></plist>\n';

  /** „t” (albo `reply`) na kopię hooka, „t” na wpisy zgód, reszta „n”. */
  const hookOnly = (reply: string | null) => (question: Question): string | null =>
    question === 'hook' ? reply : question === 'settings' || question === 'continue' ? 't' : 'n';

  /**
   * Kopia hooka i skryptu `statusLine` RÓWNA swojemu manifestowi (stan po instalacji z `origin`): pliki ze
   * `scripts/hooks/`, w `changes` podmieniona treść; `extra` = dodatkowe pliki z wpisem w manifeście.
   */
  function copyWithManifest(
    origin: { readonly commit: string } | { readonly version: string },
    changes: Readonly<Record<string, string>> = {}, extra: Readonly<Record<string, string>> = {},
  ): string {
    const dir = hookInstallDir(home);
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    const files: Record<string, string> = {};
    for (const [name, text] of [...COPY_FILES.map((one) => [one, changes[one] ?? source(one)] as const),
      ...Object.entries(extra)]) {
      writeFileSync(path.join(dir, name), text);
      files[name] = sha(text);
    }
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ ...origin, at: 1, files }));
    return dir;
  }

  /** Paczka npm w wersji `version`: `scripts/hooks/` z repo, w `changes` podmieniona treść. */
  function npmPackage(version: string, changes: Readonly<Record<string, string>> = {}): string {
    const pkg = path.join(t.home, 'lib', 'node_modules', 'rarog');
    mkdirSync(path.join(pkg, 'scripts', 'hooks'), { recursive: true });
    writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'rarog', version }));
    for (const name of COPY_FILES) writeFileSync(path.join(pkg, 'scripts', 'hooks', name), changes[name] ?? source(name));
    return pkg;
  }

  const packageDeps = (pkg: string): RunOptions['deps'] => ({
    mode: 'package', installRoot: pkg,
    sdkInstall: (options) => Promise.resolve({ ok: true, dir: options.dataDir, raced: false }),
  });

  const manifestOf = (dir: string): Record<string, unknown> =>
    JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as Record<string, unknown>;

  it('paczka, kopia ze starszej wersji (równa manifestowi): różnica, „t” → kopia = paczka, manifest z nową wersją, krok ok, potem wpisy', async () => {
    const dir = copyWithManifest({ version: '3.1.4' });
    const pkg = npmPackage('3.2.0', { 'tall-dialog.mjs': NEWER_TALL });
    const run = await runSetup({ answer: hookOnly('t'), deps: packageDeps(pkg) });
    expect(run.asked.filter((one) => one === 'hook')).toHaveLength(1);
    expect(run.asked.indexOf('settings')).toBeGreaterThan(run.asked.indexOf('hook'));
    const moved = run.stdout.indexOf('The source changed the hook since the install (copy: version 3.1.4; source:'
      + ' package version 3.2.0).');
    expect(moved).toBeGreaterThan(-1);
    const diff = run.stdout.indexOf('~ tall-dialog.mjs: sha256');
    expect(diff).toBeGreaterThan(moved);
    expect(run.stdout.indexOf('Update the hook copy')).toBeGreaterThan(diff);
    for (const name of COPY_FILES) {
      expect(readFileSync(path.join(dir, name), 'utf8')).toBe(readFileSync(path.join(pkg, 'scripts', 'hooks', name), 'utf8'));
    }
    expect(manifestOf(dir)).toMatchObject({ version: '3.2.0' });
    expect(manifestOf(dir)).not.toHaveProperty('commit');
    expect(run.stdout).toContain('copy updated (version 3.2.0)');
    expect(JSON.parse(readFileSync(userSettingsPath(home), 'utf8'))).toMatchObject(hookBlock(hookCommand(home)) as object);
    expect(summaryLine(run.stdout, 'hook copy:')).toMatch(/^ {2}ok {7}hook copy: matches the source$/);
  });

  it.skipIf(!HAS_CHECKOUT)(checkoutOnly('klon, kopia z commita sprzed HEAD: `git log <commit>..HEAD` przed pytaniem, „t” → kopia z HEAD, potem wpisy'), async () => {
    const dir = copyWithManifest({ commit: OLD_COMMIT }, { 'tall-dialog.mjs': '// tall-dialog z poprzedniego commita\n' });
    const run = await runSetup({ answer: hookOnly('t') });
    const log = run.stdout.indexOf(`git log ${OLD_COMMIT}..HEAD -- scripts/hooks`);
    expect(log).toBeGreaterThan(-1);
    expect(run.stdout.indexOf('Update the hook copy')).toBeGreaterThan(log);
    expect(run.asked.filter((one) => one === 'hook')).toHaveLength(1);
    expect(run.asked.indexOf('settings')).toBeGreaterThan(run.asked.indexOf('hook'));
    for (const name of COPY_FILES) expect(readFileSync(path.join(dir, name), 'utf8')).toBe(source(name));
    const head = execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    expect(manifestOf(dir)).toMatchObject({ commit: head });
    expect(JSON.parse(readFileSync(userSettingsPath(home), 'utf8'))).toMatchObject(hookBlock(hookCommand(home)) as object);
    expect(summaryLine(run.stdout, 'hook copy:')).toMatch(/^ {2}ok {7}hook copy: matches the source$/);
  });

  it('klon, „n”: pytanie stoi przed bramą stanu z commita (git status nie wołany), kopia bez zmian', async () => {
    const dir = copyWithManifest({ commit: OLD_COMMIT }, { 'tall-dialog.mjs': '// tall-dialog z poprzedniego commita\n' });
    fake(path.join(bin, 'git'), [`printf '%s\\n' "$*" >> '${logs}/git'`, 'exec /usr/bin/git "$@"']);
    const before = treeHash(dir);
    const run = await runSetup({ answer: hookOnly('n') });
    expect(run.asked.filter((one) => one === 'hook')).toHaveLength(1);
    expect(calls('git').filter((one) => one.includes('status --porcelain'))).toEqual([]);
    expect(treeHash(dir)).toEqual(before);
    // "n" is a decline (`!` on the screen, like a declined install), not a problem.
    expect(summaryLine(run.stdout, 'hook copy')).toMatch(
      /MISSING .*hook copy out of date: review rarog hooks doctor, then rarog hooks install/);
  });

  it('kopia zmieniona po instalacji (skrót różny od manifestu): bez pytania, ostrzeżenie jak w doctorze, PROBLEM, nic nie zapisane', async () => {
    copyHooks(HOOK_INSTALL_FILES);
    const changed = path.join(hookInstallDir(home), 'tall-dialog.mjs');
    writeFileSync(changed, '// zmienione po instalacji\n');
    const before = treeHash(hookInstallDir(home));
    const run = await runSetup({ answer: hookOnly('t') });
    expect(run.asked).not.toContain('hook');
    expect(run.stdout).toContain('WARNING: copy changed AFTER the install (tall-dialog.mjs): hash differs from the'
      + ' manifest.');
    expect(run.stdout).not.toContain('git log');
    expect(treeHash(hookInstallDir(home))).toEqual(before);
    expect(summaryLine(run.stdout, 'hook copy')).toMatch(
      /PROBLEM .*hook copy changed after the install: review rarog hooks doctor, then rarog hooks install/);
  });

  it('paczka: hook ze starszej wersji, a skrypt statusLine zmieniony po instalacji → bez pytania, ostrzeżenie o skrypcie', async () => {
    const dir = copyWithManifest({ version: '3.1.4' });
    writeFileSync(path.join(dir, 'rarog-statusline.mjs'), '// zmieniony skrypt\n');
    const pkg = npmPackage('3.2.0', { 'tall-dialog.mjs': NEWER_TALL });
    const before = treeHash(dir);
    const run = await runSetup({ answer: hookOnly('t'), deps: packageDeps(pkg) });
    expect(run.asked).not.toContain('hook');
    expect(run.stdout).toContain('WARNING: copy changed AFTER the install (rarog-statusline.mjs)');
    expect(run.stdout).not.toContain('against package version');
    expect(treeHash(dir)).toEqual(before);
  });

  it('usługa innej instalacji: odmowa przed różnicą i pytaniem, kopia bez zmian', async () => {
    const dir = copyWithManifest({ version: '3.1.4' });
    const pkg = npmPackage('3.2.0', { 'tall-dialog.mjs': NEWER_TALL });
    write(plist(), OTHER_PLIST);
    markLoaded();
    const before = treeHash(dir);
    const run = await runSetup({ answer: hookOnly('t'), deps: packageDeps(pkg) });
    expect(run.asked).not.toContain('hook');
    expect(run.stdout).not.toContain('against package version');
    expect(treeHash(dir)).toEqual(before);
    expect(summaryLine(run.stdout, 'hook copy')).toMatch(/PROBLEM .*hook copy: the service /);
  });

  for (const [name, answer] of [['„n”', hookOnly('n')], ['EOF', hookOnly(null)], ['bez terminala', null]] as const) {
    it(`${name} na aktualizację: kopia bez zmian, linia z rarog hooks install, ${answer === null ? 'PROBLEM' : 'MISSING (odmowa)'}, bez pytania o wpisy`, async () => {
      const dir = copyWithManifest({ version: '3.1.4' });
      const pkg = npmPackage('3.2.0', { 'tall-dialog.mjs': NEWER_TALL });
      const before = treeHash(dir);
      const run = await runSetup({ answer, deps: packageDeps(pkg) });
      expect(run.asked.filter((one) => one === 'hook')).toHaveLength(answer === null ? 0 : 1);
        expect(treeHash(dir)).toEqual(before);
      // Without a terminal setup cannot ask: a problem; "n" and EOF are the user's no.
      expect(summaryLine(run.stdout, 'hook copy')).toMatch(new RegExp(`${answer === null ? 'PROBLEM' : 'MISSING'} .*hook`
        + ' copy out of date: review rarog hooks doctor, then rarog hooks install', 'u'));
    });
  }

  it('paczka, kopia równa paczce, ale z plikiem wejściowym pod starą nazwą: pytanie bez różnicy plików; „n” zostawia, „t” usuwa', async () => {
    const dir = copyWithManifest({ version: '3.1.4' }, {}, { [OLD_ENTRY_FILE]: '// poprzednia instalacja\n' });
    const pkg = npmPackage('3.1.4');
    const declined = await runSetup({ answer: hookOnly('n'), deps: packageDeps(pkg) });
    expect(declined.asked.filter((one) => one === 'hook')).toHaveLength(1);
    expect(existsSync(path.join(dir, OLD_ENTRY_FILE))).toBe(true);
    const run = await runSetup({ answer: hookOnly('t'), deps: packageDeps(pkg) });
    expect(run.asked.filter((one) => one === 'hook')).toHaveLength(1);
    expect(existsSync(path.join(dir, OLD_ENTRY_FILE))).toBe(false);
    expect(run.stdout).toContain(`${OLD_ENTRY_FILE}: removed (file from a previous install)`);
    expect(summaryLine(run.stdout, 'hook copy:')).toMatch(/^ {2}ok {7}hook copy: matches the source$/);
  });

  it('klon, źródło dodało plik po instalacji (brak w kopii i w manifeście): `git log` przed pytaniem, „n” → kopia bez zmian', async () => {
    const added = HOOK_INSTALL_FILES[HOOK_INSTALL_FILES.length - 1] ?? '';
    const dir = copyWithManifest({ commit: OLD_COMMIT });
    rmSync(path.join(dir, added));
    const manifest = manifestOf(dir) as { files: Record<string, string> };
    delete manifest.files[added];
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
    const before = treeHash(dir);
    const run = await runSetup({ answer: hookOnly('n') });
    const log = run.stdout.indexOf(`git log ${OLD_COMMIT}..HEAD -- scripts/hooks`);
    expect(log).toBeGreaterThan(-1);
    expect(run.stdout.indexOf('Update the hook copy')).toBeGreaterThan(log);
    expect(run.asked.filter((one) => one === 'hook')).toHaveLength(1);
    expect(treeHash(dir)).toEqual(before);
  });

  it('paczka: pliki hooka równe paczce, pozostałość i starszy skrypt statusLine: jedno pytanie po różnicy skryptu', async () => {
    const dir = copyWithManifest({ version: '3.1.4' }, {}, { [OLD_ENTRY_FILE]: '// poprzednia instalacja\n' });
    const pkg = npmPackage('3.2.0', { 'rarog-statusline.mjs': `${source('rarog-statusline.mjs')}// 3.2.0\n` });
    const before = treeHash(dir);
    const declined = await runSetup({ answer: hookOnly('n'), deps: packageDeps(pkg) });
    expect(declined.asked.filter((one) => one === 'hook')).toHaveLength(1);
    const diff = declined.stdout.indexOf('~ rarog-statusline.mjs: sha256');
    expect(diff).toBeGreaterThan(-1);
    expect(declined.stdout.indexOf('Update the hook copy')).toBeGreaterThan(diff);
    expect(treeHash(dir)).toEqual(before);
    const run = await runSetup({ answer: hookOnly('t'), deps: packageDeps(pkg) });
    expect(run.asked.filter((one) => one === 'hook')).toHaveLength(1);
    expect(existsSync(path.join(dir, OLD_ENTRY_FILE))).toBe(false);
    expect(readFileSync(path.join(dir, 'rarog-statusline.mjs'), 'utf8'))
      .toBe(readFileSync(path.join(pkg, 'scripts', 'hooks', 'rarog-statusline.mjs'), 'utf8'));
  });

  it('kopia aktualna: bez pytania o kopię (jak dotąd)', async () => {
    copyHooks(COPY_FILES);
    const run = await runSetup({ answer: hookOnly('t') });
    expect(run.asked).not.toContain('hook');
    expect(run.stdout).toContain(`hook copy: ${hookInstallDir(home)} matches the repo`);
  });
});

describe.skipIf(!IS_MAC)(macOnly('rarog setup bez terminala: zero pytań i zapisów', 'launchd'), () => {
  it('pusty dom: lista braków z komendami, kod 1', async () => {
    const before = treeHash(home);
    const run = await runSetup({ answer: null });
    expect(run.stdout).toContain('rarog setup without a terminal');
    expect(run.asked).toEqual([]);
    expect(treeHash(home)).toEqual(before);
    expect(calls('tailscale')).toEqual([]);
    // The service waits for config.json; its summary keeps the clone's command.
    for (const text of ['run rarog setup in a terminal', 'rarog hooks install', 'rarog hooks print',
      'node bin/rarog.mjs service install']) {
      expect(run.stdout).toContain(text);
    }
    expect(run.code).toBe(1);
  });

  it('claude tylko w ~/.local/bin: UWAGA w kroku narzędzi, że panel herdr może go nie znaleźć', async () => {
    rmSync(path.join(bin, 'claude'));
    const local = path.join(home, '.local', 'bin');
    mkdirSync(local, { recursive: true });
    fake(path.join(local, 'claude'), ['exit 0']);
    const run = await runSetup({ answer: null });
    expect(run.stdout).toContain(`claude: ${path.join(local, 'claude')}\n  WARNING: ${local} is outside this shell's`
      + ' PATH — a herdr pane may not find claude');
  });

  it('pełna instalacja: kod 0', async () => {
    writeConfig({ RAROG_ORIGINS: 'https://rarog.example.net', RAROG_PORT: String(port) });
    writeSecrets();
    copyHooks([...HOOK_INSTALL_FILES, ...STATUSLINE_INSTALL_FILES]);
    writeSettings(statuslineCommand(home), home, { denyRead: true });
    write(plist(), '<plist/>\n');
    markLoaded();
    const before = treeHash(home);
    const run = await runSetup({ answer: null });
    expect(treeHash(home)).toEqual(before);
    expect(run.stdout).not.toMatch(/ (MISSING|PROBLEM) /);
    expect(run.code).toBe(0);
  });

  /** Pełna instalacja jak w teście „pełna instalacja: kod 0”; `context: false` = ustawienia bez wpisu kontekstu. */
  function fullInstall(options: { readonly context?: boolean } = {}): void {
    writeConfig({ RAROG_ORIGINS: 'https://rarog.example.net', RAROG_PORT: String(port) });
    writeSecrets();
    copyHooks([...HOOK_INSTALL_FILES, ...STATUSLINE_INSTALL_FILES]);
    writeSettings(statuslineCommand(home), home, { ...options, denyRead: true });
    write(plist(), '<plist/>\n');
    markLoaded();
  }

  /** Atrapa `herdr`, która na `integration status` wypisuje `lines` (kształt z herdr 0.9.5) i loguje wywołania. */
  function herdrWithStatus(lines: readonly string[]): void {
    fake(path.join(bin, 'herdr'), [`printf '%s\\n' "$*" >> '${logs}/herdr'`,
      'if [ "$1 $2" = "integration status" ]; then', ...lines.map((one) => `  echo '${one}'`), 'fi', 'exit 0']);
  }

  it('herdr z integracją `current`: linia stanu, narzędzia ok, kod 0', async () => {
    fullInstall();
    herdrWithStatus(['claude: current (v11) (/x/.claude/hooks/herdr-agent-state.sh)']);
    const run = await runSetup({ answer: null });
    expect(run.stdout).toContain('herdr integration for Claude Code: current (v11)');
    expect(run.stdout).not.toContain('herdr integration install claude');
    expect(run.code).toBe(0);
  });

  it('bez herdr: krok narzędzi jak dziś (MISSING herdr), bez sprawdzania integracji', async () => {
    fullInstall();
    rmSync(path.join(bin, 'herdr'));
    const run = await runSetup({ answer: null });
    expect(run.stdout).toContain('MISSING herdr — install herdr (default ~/.local/bin/herdr)');
    expect(run.stdout).not.toContain('herdr integration');
    expect(calls('herdr')).toEqual([]);
  });

  it('prawdziwe bin/rarog.mjs z rurami zamiast terminala: bez pytań, kod 1, dom bez zmian', async () => {
    const before = treeHash(home);
    const child = spawn(process.execPath, [CLI, 'setup', '--verbose'], { cwd: t.home, env: env(), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stdin.end('t\nt\nt\nt\n');
    const code = await new Promise<number | null>((resolve) => { child.on('close', resolve); });
    expect(stdout).toContain('rarog setup without a terminal');
    expect(stdout).not.toContain('[y/N]');
    expect(treeHash(home)).toEqual(before);
    expect(code).toBe(1);
  });
});

/**
 * `bin/rarog.mjs setup` w pseudoterminalu (`script` z macOS); `key` idzie po pierwszym pytaniu (`[y/N]` o transport
 * na maszynie z modułem iroh i `tailscale`, inaczej `[Y/n]` planu). `script` nie przyjmie gniazda jako stdin
 * (`tcgetattr`), a rura dziecka w Node to gniazdo — stąd `cat |` przed nim.
 */
async function ttySetup(key: string): Promise<{ readonly code: number | null; readonly stdout: string }> {
  const child = spawn('/bin/sh',
    ['-c', 'cat | /usr/bin/script -q /dev/null "$@"', 'sh', process.execPath, CLI, 'setup', '--verbose'],
    { cwd: t.home, env: env(), stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let sent = false;
  child.stderr.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
    if (!sent && /\[(?:y\/N|Y\/n)\]/u.test(stdout)) {
      sent = true;
      child.stdin.end(key);
    }
  });
  const timer = setTimeout(() => { child.kill('SIGKILL'); }, 20_000);
  const code = await new Promise<number | null>((resolve) => { child.on('close', resolve); });
  clearTimeout(timer);
  return { code, stdout };
}

describe.skipIf(!IS_MAC)(macOnly('rarog setup w terminalu (pseudoterminal)', 'launchd, the script command'), () => {
  it('Ctrl-D na pierwszym pytaniu: „nie” dla niego i dla reszty, kod 1, dom bez zmian', async () => {
    const before = treeHash(home);
    const run = await ttySetup('\u0004');
    expect(run.stdout).toContain('rarog setup: creates only what is missing');
    // After EOF the terminal shows no further question: the first one (transport or plan) is the only form.
    expect(run.stdout.match(/\[(?:y\/N|Y\/n)\]/gu)).toHaveLength(1);
    expect(run.stdout).toContain('Nothing changed.');
    expect(run.stdout).not.toContain('Summary:');
    expect(treeHash(home)).toEqual(before);
    expect(run.code).toBe(1);
  }, 30_000);

  it('Ctrl-C na pytaniu: kod 130, dom bez zmian', async () => {
    const before = treeHash(home);
    const run = await ttySetup('\u0003');
    expect(run.stdout).not.toContain('Summary:');
    expect(treeHash(home)).toEqual(before);
    expect(run.code).toBe(130);
  }, 30_000);
});

describe('rarog setup: pomoc', () => {
  it('--help i pomoc rarog wymieniają setup', async () => {
    let stdout = '';
    const io: CliIo = { stdout: (text) => { stdout += text; }, stderr: () => {}, env: env(), cwd: t.home };
    expect(await main(['setup', '--help'], io)).toBe(0);
    expect(stdout).toContain('rarog setup [--tailscale] [--tailscale-only] [--iroh-relay <https url>] [--data-dir <dir>]');
    stdout = '';
    expect(await main(['help'], io)).toBe(0);
    expect(stdout).toContain('rarog setup');
  });

  it('nieznany argument: użycie, kod 64', async () => {
    let stderr = '';
    const code = await main(['setup', '--force'], {
      stdout: () => {}, stderr: (text) => { stderr += text; }, env: env(), cwd: t.home,
    });
    expect(code).toBe(64);
    expect(stderr).toContain('unknown argument');
  });
});

// ---------------------------------------------------------------------------
// Linux (atrapy systemd --user)
// ---------------------------------------------------------------------------

describe('rarog setup na Linuksie (atrapy systemd --user)', () => {
  let sb: LinuxSandbox;
  let socket = '';

  beforeEach(() => {
    sb = linuxSandbox('rsl-');
    for (const name of ['claude', 'herdr']) fake(path.join(sb.bin, name), ['exit 0']);
    socket = path.join(sb.homeDir, 'hs.sock');
    writeConfig({ RAROG_ORIGINS: 'https://rarog.example.net', RAROG_PORT: String(port), RAROG_HERDR_SOCKET: socket },
      null, sb.homeDir);
    writeSecrets(sb.homeDir);
  });

  afterEach(() => { sb.cleanup(); });

  const linux = (answer: RunOptions['answer'] = YES): Promise<Result> =>
    runSetup({ answer, env: sb.env(), platform: 'linux' });

  /** `claude` tylko w `~/.local/bin` (natywny instalator Claude Code), poza `PATH` powłoki testu. */
  function claudeInLocalBin(): string {
    rmSync(path.join(sb.bin, 'claude'));
    const local = path.join(sb.homeDir, '.local', 'bin');
    mkdirSync(local, { recursive: true });
    fake(path.join(local, 'claude'), ['exit 0']);
    return local;
  }

  it('claude tylko w ~/.local/bin: krok 1 to mówi, PATH zapisanej jednostki herdr.service zaczyna się od niego', async () => {
    const local = claudeInLocalBin();
    const run = await linux();
    expect(run.stdout).toContain(`claude: ${path.join(local, 'claude')}\n    ${local} is outside this shell's PATH;`
      + ' step 9 checks the PATH of herdr panes');
    const expected = [...new Set([local, path.dirname(process.execPath), sb.bin, ...MANAGER_PATH.split(':')])];
    expect(readFileSync(herdrUnitFile(), 'utf8')).toContain(`\nEnvironment="PATH=${expected.join(':')}"\n`);
    expect(run.stdout).not.toContain('WARNING');
  });

  const herdrUnitFile = (): string => path.join(sb.homeDir, '.config', 'systemd', 'user', 'herdr.service');
  /** Jednostka z wydruku setupu tej piaskownicy (`claude` i herdr w atrapach, węzeł testu, `PATH` menedżera). */
  const currentHerdrUnit = (): string => renderHerdrUnit(path.join(sb.bin, 'herdr'),
    herdrUnitPath([sb.bin, path.dirname(process.execPath), sb.bin], MANAGER_PATH));
  /** Stan atrapy `systemctl` dla `herdr.service` (`active`, `enabled`, `LoadState`). */
  const herdrState = (name: string, value: string | null): void => { sb.set(`herdr.service.${name}`, value); };

  it('herdr.service jest, aktywna i włączona, PATH z wydruku: ok bez UWAGA; stan z systemctl --user show', async () => {
    write(herdrUnitFile(), currentHerdrUnit());
    herdrState('active', '1');
    herdrState('enabled', '1');
    const run = await linux(null);
    expect(summaryLine(run.stdout, 'herdr.service')).toMatch(/^ {2}ok {7}herdr.service: active and enabled$/);
    expect(run.stdout).toContain('LoadState=loaded, UnitFileState=enabled, ActiveState=active');
    expect(run.stdout).not.toContain('WARNING');
    expect(sb.calls('systemctl'))
      .toContain('--user show herdr.service -p LoadState -p UnitFileState -p ActiveState -p NeedDaemonReload');
  });

  const states: readonly {
    name: string; active: boolean; enabled: boolean; set?: Readonly<Record<string, string>>; alive?: boolean;
    summary: RegExp;
  }[] = [
    { name: 'działa, niewłączona', active: true, enabled: false,
      summary: /MISSING .*will not start after a reboot \(UnitFileState=disabled\): systemctl --user enable herdr.service$/ },
    { name: 'nieaktywna, niewłączona', active: false, enabled: false,
      summary: /MISSING .*inactive and not enabled: systemctl --user enable --now herdr.service$/ },
    { name: 'włączona, nieaktywna', active: false, enabled: true,
      summary: /PROBLEM .*ActiveState=inactive\): systemctl --user start herdr.service; see systemctl --user status/ },
    { name: 'nieaktywna, gniazdo herdr żywe', active: false, enabled: true, alive: true,
      summary: /info .*inactive \(ActiveState=inactive\), herdr runs outside it$/ },
    { name: 'nieaktywna, niewłączona, gniazdo herdr żywe', active: false, enabled: false, alive: true,
      summary: /info .*herdr runs outside it; to start after a reboot: systemctl --user enable herdr.service \(without --now/ },
    { name: 'plik bez daemon-reload', active: false, enabled: false, set: { LoadState: 'not-found' },
      summary: /MISSING .*the manager does not know it: systemctl --user daemon-reload && systemctl --user enable --now/ },
    { name: 'plik bez daemon-reload, gniazdo herdr żywe', active: false, enabled: false, alive: true,
      set: { LoadState: 'not-found' },
      summary: /info .*does not know it, herdr runs outside it: .*daemon-reload && systemctl --user enable herdr.service \(without --now/ },
    { name: 'plik zmieniony bez daemon-reload', active: true, enabled: true,
      set: { NeedDaemonReload: 'yes' },
      summary: /PROBLEM .*changed without daemon-reload \(NeedDaemonReload=yes\): systemctl --user daemon-reload/ },
    { name: 'zamaskowana', active: false, enabled: false, set: { LoadState: 'masked' },
      summary: /PROBLEM .*masked: systemctl --user unmask herdr.service$/ },
    { name: 'bad-setting', active: false, enabled: false, set: { LoadState: 'bad-setting' },
      summary: /PROBLEM .*LoadState=bad-setting; see systemctl --user status herdr.service for the cause$/ },
  ];
  for (const one of states) {
    it(`herdr.service jest, ${one.name}: sam plik to nie „ok”`, async () => {
      write(herdrUnitFile(), currentHerdrUnit());
      if (one.active) herdrState('active', '1');
      if (one.enabled) herdrState('enabled', '1');
      for (const [name, value] of Object.entries(one.set ?? {})) herdrState(name, value);
      if (one.alive === true) await listenHerdr(socket);
      const run = await linux(null);
      expect(summaryLine(run.stdout, 'herdr.service')).toMatch(one.summary);
      if (one.summary.source.startsWith('info')) expect(run.stdout).not.toContain('enable --now herdr.service');
    });
  }

  it('herdr.service jest, magistrala nieosiągalna: PROBLEM, stan nierozstrzygnięty', async () => {
    write(herdrUnitFile(), currentHerdrUnit());
    sb.set('bus-down', '1');
    const run = await linux(null);
    expect(summaryLine(run.stdout, 'herdr.service')).toMatch(/PROBLEM .*state undetermined .*Failed to connect/);
  });

  it('no bus on the step screen: Tools has one fix without systemctl\'s message, Service and Check wait for Tools', async () => {
    sb.set('bus-down', '1');
    const run = await runSetup({
      answer: YES, env: sb.env(), platform: 'linux', verbose: false,
      terminal: { tty: true, columns: 60, color: false },
    });
    const screen = run.stdout.replace(/\x1b\[[0-9;]*[A-Za-z]/gu, '').split('\n')
      .map((one) => one.split('\r').at(-1) ?? '').join('\n');
    expect(screen).toMatch(/^ ! Tools {10}1 missing: systemctl --user$/mu);
    expect(screen).toMatch(/^ – Service {8}waits for Tools$/mu);
    expect(screen).toMatch(/^ – Check {10}waits for Tools$/mu);
    // systemctl's own message is the run log's, never the screen's.
    expect(screen).not.toContain('Failed to connect');
    expect(screen).not.toMatch(/^ ✗ Service/mu);
    expect(run.code).toBe(1);
  });

  // The refusal's fix is an action, like the other refusals, and it fits one line at 60 columns.
  it('a first setup without systemctl --user: the refusal\'s Fix starts with what to do', async () => {
    rmSync(configFile(sb.homeDir));
    sb.set('bus-down', '1');
    const run = await runSetup({
      answer: YES, env: sb.env(), platform: 'linux', verbose: false,
      terminal: { tty: true, columns: 60, color: false },
    });
    const lines = run.stdout.split('\n');
    expect(run.code).toBe(1);
    expect(run.asked).toEqual([]);
    expect(lines.join('\n')).toContain('Rarog cannot run without systemctl --user; nothing changed.');
    expect(lines, run.stdout).toContain('   Fix: log in with a systemd user session; then rarog setup');
  });

  it('herdr.service bez PATH (stary wydruk), claude w ~/.local/bin: UWAGA, „info” i linia z bieżącym PATH', async () => {
    const local = claudeInLocalBin();
    write(herdrUnitFile(), `[Service]\nExecStart="${path.join(sb.bin, 'herdr')}" server\nRestart=on-failure\n`);
    herdrState('active', '1');
    herdrState('enabled', '1');
    const run = await linux(null);
    expect(run.stdout).toContain(`WARNING: the systemd --user manager PATH (the unit does not set PATH) lacks ${local}`
      + ' (claude)');
    const expected = [...new Set([local, path.dirname(process.execPath), sb.bin, ...MANAGER_PATH.split(':')])];
    expect(run.stdout).toContain(`\nEnvironment="PATH=${expected.join(':')}"\n`);
    const lacking = [local, path.dirname(process.execPath)].filter((dir) => !MANAGER_PATH.split(':').includes(dir));
    expect(summaryLine(run.stdout, 'herdr.service'))
      .toBe(`  info     herdr.service: active and enabled, but the pane PATH lacks ${lacking.join(', ')}`);
  });

  it('PATH jednostki bez claude: linia naprawy zachowuje własne katalogi jednostki', async () => {
    const local = claudeInLocalBin();
    write(herdrUnitFile(), '[Service]\nEnvironment="PATH=/opt/narzedzia/bin:/usr/bin"\n');
    herdrState('active', '1');
    herdrState('enabled', '1');
    const run = await linux(null);
    expect(run.stdout).toContain(`WARNING: the unit PATH lacks ${local} (claude)`);
    const expected = [...new Set([local, path.dirname(process.execPath), sb.bin, '/opt/narzedzia/bin', '/usr/bin',
      '/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/sbin', '/bin'])];
    expect(run.stdout).toContain(`\nEnvironment="PATH=${expected.join(':')}"\n`);
    expect(run.stdout).toContain('line for the [Service] section of the unit');
  });

  it('herdr.service z PATH=%h/.local/bin bez cudzysłowu i z katalogiem węzła: ok bez UWAGA', async () => {
    claudeInLocalBin();
    write(herdrUnitFile(), `[Service]\nEnvironment=PATH=%h/.local/bin:${path.dirname(process.execPath)}:/usr/bin\n`);
    herdrState('active', '1');
    herdrState('enabled', '1');
    const run = await linux(null);
    expect(run.stdout).not.toContain('WARNING');
    expect(summaryLine(run.stdout, 'herdr.service')).toMatch(/ok .*active and enabled$/);
  });

  it('claude tylko w ~/.local/bin, herdr działa bez jednostki: UWAGA o PATH paneli, krok zostaje „info”', async () => {
    const local = claudeInLocalBin();
    await listenHerdr(socket);
    const run = await linux(null);
    expect(run.stdout).toContain(`WARNING: herdr runs outside the unit, and ${local} (claude) is outside this shell's`
      + ' PATH');
    expect(summaryLine(run.stdout, 'herdr.service')).toMatch(/info .*herdr runs some other way/);
  });

  it('herdr runs without a unit: the step screen marks the unit not used (–), not ✓', async () => {
    await listenHerdr(socket);
    const run = await runSetup({ env: sb.env(), platform: 'linux', verbose: false, answer: null });
    expect(run.stdout).toMatch(/^\[[0-9]+\/10\] skip {4}herdr unit: not used \(herdr runs without it\)$/mu);
  });

  it('bez systemctl --user: braki w narzędziach, stan usługi nierozstrzygnięty, bez instalacji', async () => {
    sb.set('bus-down', '1');
    await listenHerdr(socket);
    const run = await linux();
    expect(run.stdout).toContain('systemctl --user unreachable');
    expect(run.stdout).toContain('Failed to connect to bus');
    expect(summaryLine(run.stdout, 'service')).toMatch(/PROBLEM/);
    expect(run.asked).not.toContain('service');
    expect(run.installs).toBe(0);
    expect(run.code).toBe(1);
  });

  it.skipIf(!HAS_CHECKOUT)(checkoutOnly('herdr bez gniazda: bez pytania o usługę; jednostka herdr.service z planu zapisana po „t”, niewłączona'), async () => {
    const run = await linux();
    expect(run.asked).not.toContain('service');
    // The unit is an item of the plan: one "t" to Continue? covers it, no question of its own.
    expect(run.asked.filter((one) => one === 'continue')).toHaveLength(1);
    expect(run.stdout).toContain('  • herdr.service          ~/.config/systemd/user\n');
    expect(run.installs).toBe(0);
    expect(run.stdout).toContain('herdr is not running');
    expect(readFileSync(herdrUnitFile(), 'utf8')).toBe(currentHerdrUnit());
    expect(readFileSync(herdrUnitFile(), 'utf8'))
      .toContain(`ExecStart=${escapeExecProgram(path.join(sb.bin, 'herdr'))} server`);
    // Setup never enables or starts the unit: systemctl only answers questions.
    expect(sb.calls('systemctl').every((line) => line.startsWith('--user show '))).toBe(true);
    // Kopia zainstalowana po „t”, wpisy hooków po „t”: krok hooka i hook kontekstu są `ok`.
    expect(summaryLine(run.stdout, 'hook copy:')).toMatch(/^ {2}ok {7}hook copy: matches the source$/);
    expect(summaryLine(run.stdout, 'Settings:')).toMatch(/ok {7}Settings: /);
    expect(run.code).toBe(1);
  });

  it('żywe gniazdo herdr, „t”: rarog service install (jednostka systemd --user)', async () => {
    await listenHerdr(socket);
    const run = await linux();
    expect(run.asked).toContain('continue');
    expect(run.stdout).toContain('installing the systemd --user unit rarog.service');
    expect(run.installs).toBe(1);
    expect(summaryLine(run.stdout, 'herdr.service')).toMatch(/info .*herdr runs some other way/);
  });

  it('plik jednostki jest: bez instalacji, stan z /health; martwy = rarog restart', async () => {
    write(path.join(sb.homeDir, '.config', 'systemd', 'user', 'rarog.service'), '[Service]\n');
    await listenHerdr(socket);
    const healthy = await linux();
    expect(healthy.installs).toBe(0);
    expect(summaryLine(healthy.stdout, 'service')).toContain('service: running');
    setHealthBody('not an object');
    const sick = await linux();
    expect(sick.installs).toBe(0);
    expect(summaryLine(sick.stdout, 'service')).toMatch(/PROBLEM .*: pnpm run restart$/);
  });

  /** The unit of this installation: a service of another one gets the command that points it here instead. */
  const ownUnit = (): void => {
    write(path.join(sb.homeDir, '.config', 'systemd', 'user', 'rarog.service'),
      `[Service]\nExecStart=${renderExecStart([process.execPath, path.join(REPO, 'bin', 'rarog.mjs'), 'serve'])}\n`);
  };

  // herdr: false with a silent herdr socket = herdr is down; the server reconnects by itself, a restart would not start
  // herdr. herdr: false with an answering socket = the server does not reach this herdr; the restart reloads it.
  it('loaded service with herdr: false, no herdr.service: start herdr in a terminal, not a restart', async () => {
    ownUnit();
    // The hook copy in place, so the plan offers the herdr unit alone and its "n" declines just that item.
    copyHooks([...HOOK_INSTALL_FILES, ...STATUSLINE_INSTALL_FILES], true, sb.homeDir);
    setHealthBody({ ok: true, herdr: false });
    // "n" to the plan: with "y" the unit exists by the Service step, which then waits for it.
    const run = await linux((question) => (question === 'continue' ? 'n' : 't'));
    expect(run.asked[0]).toBe('continue');
    expect(run.installs).toBe(0);
    const service = summaryLine(run.stdout, 'service');
    expect(service).toMatch(/PROBLEM .*\(herdr: false\): run herdr in a terminal, then node bin\/rarog\.mjs setup$/);
    expect(service).not.toContain('restart');
  });

  it('loaded service with herdr: false and a herdr.service unit: systemctl --user start herdr.service', async () => {
    ownUnit();
    write(path.join(sb.homeDir, '.config', 'systemd', 'user', 'herdr.service'), '[Service]\n');
    setHealthBody({ ok: true, herdr: false });
    const run = await linux();
    const service = summaryLine(run.stdout, 'service');
    expect(service).toMatch(/PROBLEM .*\(herdr: false\): systemctl --user start herdr\.service, then node bin\/rarog\.mjs setup$/);
    expect(service).not.toContain('restart');
  });

  it('herdr: false from a cached ping while the herdr socket answers: read again past the window, running', async () => {
    ownUnit();
    await listenHerdr(socket);
    // The first read carries the cached ping from before herdr started; the server's next ping sees herdr.
    let reads = 0;
    setHealthBody(() => ({ ok: true, herdr: (reads += 1) > 1 }));
    const run = await linux();
    expect(summaryLine(run.stdout, 'service')).toContain('service: running');
  });

  it('loaded service with herdr: false while the herdr socket answers: the restart, not a herdr start', async () => {
    ownUnit();
    await listenHerdr(socket);
    setHealthBody({ ok: true, herdr: false });
    const run = await linux();
    const service = summaryLine(run.stdout, 'service');
    expect(service).toMatch(/PROBLEM .*\(herdr: false\): pnpm run restart$/);
    expect(service).not.toContain('run herdr');
  });

  it('plik jednostki innej instalacji: kopia hooka i skryptu statusLine bez pytania i bez zapisu', async () => {
    write(path.join(sb.homeDir, '.config', 'systemd', 'user', 'rarog.service'),
      `[Service]\nExecStart=${renderExecStart(['/opt/n/bin/node', '/opt/inna/bin/rarog.mjs', 'serve'])}\n`);
    await listenHerdr(socket);
    const run = await linux();
    expect(run.asked).not.toContain('hook');
    expect(run.asked).not.toContain('statusline');
    expect(existsSync(hookInstallDir(sb.homeDir))).toBe(false);
    expect(summaryLine(run.stdout, 'hook copy')).toMatch(/PROBLEM .*: the service /);
  });

  it('jednostka załadowana bez pliku w katalogu użytkownika: bez instalacji', async () => {
    sb.set('LoadState', 'loaded');
    await listenHerdr(socket);
    const run = await linux();
    expect(run.asked).not.toContain('service');
    expect(run.installs).toBe(0);
  });
});
