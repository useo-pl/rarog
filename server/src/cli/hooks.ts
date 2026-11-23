/**
 * `rarog hooks print|install|doctor` — instalacja hooka treści z terminala człowieka. Ten sam kod woła
 * podkładka `scripts/hooks-config.ts` (`pnpm run hooks:install|print|doctor`), więc obie drogi mówią to samo.
 *
 * `install` kopiuje kod hooka i skrypt `statusLine` ze `scripts/hooks/` do `~/.claude/hooks/rarog/` (ścieżka, której
 * Claude Code nie pozwala zapisać z sandboksa), usuwa z kopii pliki z poprzedniego manifestu spoza obecnego zestawu
 * i zapisuje nowy manifest; w paczce npm najpierw drukuje różnicę kopii wobec paczki i pyta w terminalu, a bez
 * terminala różną kopię zostawia (odmowa z różnicą). Gdy usługa startuje inną instalację, `install` odmawia bez
 * zapisu ({@link copyTargetRefusal}). Po zapisanej kopii `install` doprowadza wpisy hooka zgód w
 * `~/.claude/settings.json` do bieżącej postaci pisarzem ustawień (`claude-settings.ts`): one `[y/N/d]`
 * question in a terminal (`d` shows the diff), a write with a backup; without a terminal no diff, no write, code 1.
 * Hook kontekstu `SessionStart`, `statusLine`, ścieżki `denyRead` i blokadę zapisu dopisuje `rarog setup` (jedno
 * pytanie o wszystkie wpisy). `print` drukuje gotowy
 * blok JSON do wklejenia z kompletem pięciu wpisów (hooki zgód, `SessionStart`, `statusLine`, `denyRead`, the write
 * block rules in `permissions.deny`), wskazujący KOPIĘ;
 * `statusline` drukuje blok `statusLine` (opcjonalnie z łańcuchem `--chain`); `doctor` mówi, czy zainstalowany blok
 * jest dokładnie tym drukowanym i czy kopia zgadza się ze źródłem. `print`, `statusline` i `doctor` niczego nie
 * zapisują.
 *
 * Cała logika (kształt bloku, porównanie, kopia, wiek znacznika) mieszka w `server/src/herdr/hook-config.ts` — tej
 * samej, z której korzysta `/health`. Tutaj zostaje wyłącznie warstwa CLI: argumenty, środowisko i wypisywanie.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { dataDirConflictMessage, resolveDataDir } from '@rarog/shared/data-dir';
import { gitReadEnv, spawnGitArgs } from '../git-status.ts';
import { HOOK_STATUS_MISSING } from '../health.ts';
import type { HookStatus } from '../health.ts';
import {
  CONTEXT_HOOK_FILE, HOOK_ANSWER_TIMEOUT_S, HOOK_MANIFEST_FILENAME, HOOK_ROOTS_FILENAME, HOOK_SEEN_FILENAME,
  HOOK_SOURCE_DIR_REL, HOOK_TIMEOUT_S, combineStatus, contextHookCommand, denyReadBlock, expectedHookEntries,
  hookCommand, hookCopyReport, hookInstallDir, hookOriginText, installHookCopy, installedVersion, inspectContextHook,
  inspectSettingsFile, localSettingsPath, pasteHookBlock, readHookRoots, readHookSeenAt, readHookSeenByFile,
  renderHookCopyReview, renderStatuslineBlock, repoRoot, statuslineBlock, statuslineCommand, statuslineCopyReport,
  userSettingsPath, withCopyStatus, writeBlockRules,
} from '../herdr/hook-config.ts';
import type { ContextHookInspection } from '../herdr/hook-config.ts';
import type { HookCopyFile, HookCopyReport, HookCopyReview } from '../herdr/hook-config.ts';
import { HOOK_ANSWERS_DIRNAME } from '../herdr/dialogs/hook/contract.ts';
import { settingsDataDir } from '../install/data-dir.ts';
import { INSTALL_MODE } from '../install/mode.ts';
import type { InstallMode } from '../install/mode.ts';
import { REPAIR, rarogCli, repairCommands } from '../install/repair.ts';
import { serviceArgvBin, serviceArgvNode } from '../install/service-target.ts';
import { entriesDiff, entriesQuestion, writeClaudeSettings } from './claude-settings.ts';
import { homeOf, isYes, platformOf, terminalOf } from './io.ts';
import type { CliIo } from './io.ts';
import {
  installedServiceDataDir, onPath, serviceInstallationMismatch, servicePlistArgv, servicePlistPath, unitArgv,
} from './restart.ts';
import { confirm as confirmForm } from './screen/ask.ts';
import { layoutOf } from './screen/style.ts';
import { rarogConfigDir } from './serve.ts';
import { quote } from './service.ts';
import { unitFilePath } from './systemd-unit.ts';

/** Instalacja, z której komendy hooka biorą źródło kopii: tryb i korzeń (domyślnie ta, z `install/mode.ts`). */
export interface HookInstallTarget {
  readonly mode: InstallMode;
  readonly root: string;
}

const THIS_INSTALL: HookInstallTarget = { mode: INSTALL_MODE, root: repoRoot() };

/**
 * Plik usługi dla {@link copyTargetRefusal}: `missing` wyłącznie przy `ENOENT`. Wpis, którego nie da się sprawdzić
 * (`EACCES`, `ENOTDIR`) albo który prowadzi donikąd (wiszące dowiązanie), to powód odmowy, nie brak usługi.
 */
function serviceFileState(file: string): 'missing' | 'present' | { readonly issue: string } {
  try {
    lstatSync(file);
  } catch (failure) {
    const code = (failure as NodeJS.ErrnoException).code;
    return code === 'ENOENT' ? 'missing' : { issue: `cannot check ${file} (${code ?? 'error'})` };
  }
  return existsSync(file) ? 'present' : { issue: `${file} leads to a file that does not exist or cannot be read` };
}

/**
 * Katalog kopii (`<HOME>/.claude/hooks/rarog`) prowadzi poza `HOME` przez dowiązanie: wtedy plik usługi w `HOME` nie
 * mówi nic o serwerze, obok którego kopia wyląduje (np. `.claude` dowiązane do `.claude` innego domu). Sprawdza
 * prawdziwą ścieżkę katalogu kopii albo najbliższego istniejącego przodka do `.claude` włącznie; dowiązania plików
 * w `.claude` (np. `settings.json`) nie mają tu znaczenia. `null` = katalog kopii leży pod `realpath(HOME)`.
 */
function copyDirEscape(home: string): string | null {
  let realHome: string;
  try {
    realHome = realpathSync(home);
  } catch (failure) {
    return `cannot check the home directory ${home} (${(failure as NodeJS.ErrnoException).code ?? 'error'})`;
  }
  const claude = join(home, '.claude');
  for (let probe = hookInstallDir(home); ; probe = dirname(probe)) {
    let real: string | null = null;
    try {
      real = realpathSync(probe);
    } catch (failure) {
      const code = (failure as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') return `cannot check ${probe} (${code ?? 'error'})`;
      try {
        lstatSync(probe);
        return `${probe} is a dangling symlink`;
      } catch {
        // Wpisu nie ma: decyduje przodek.
      }
    }
    if (real !== null) {
      return real === realHome || real.startsWith(`${realHome}${sep}`)
        ? null : `the copy directory leads outside HOME through a symlink: ${probe} → ${real}`;
    }
    if (probe === claude) return null;
  }
}

/**
 * Cel usługi wobec instalacji `target`, zanim jej kopia hooka trafi obok serwera: kopia z klonu obok usługi, która
 * startuje paczkę (albo odwrotnie), po cichu przepięłaby kod hooka tamtego serwera. Cel czyta się z pliku usługi
 * w `HOME` (plist `ai.rarog.server` na macOS, plik jednostki `rarog.service` na Linuksie) regułą `rarog restart`
 * i `rarog doctor` ({@link serviceInstallationMismatch}). Liczy się wejście `bin/rarog.mjs`, nie węzeł: hook biegnie
 * na `node` z `PATH` sesji Claude Code. Załadowanej etykiety launchd bez plistu ten odczyt nie widzi: domena launchd
 * jest wspólna dla każdego `HOME` konta, więc etykieta nie mówi nic o tym `HOME`.
 *
 * Najpierw katalog kopii musi leżeć pod tym `HOME` ({@link copyDirEscape}), bo inaczej plik usługi w nim nie mówi
 * nic o serwerze obok kopii. `null` = pliku usługi nie ma (`ENOENT`, {@link serviceFileState}) albo usługa startuje
 * tę instalację; napis = powód odmowy z komendą (wspólny dla `rarog hooks install` i kroków hooka i `statusLine`
 * w `rarog setup`).
 */
export function copyTargetRefusal(io: CliIo, target: HookInstallTarget): string | null {
  return copyTargetRefusalOf(io, target)?.text ?? null;
}

/**
 * A refusal of {@link copyTargetRefusal} for a step screen: the whole sentence (`text`, the run log and `rarog hooks
 * install`), one short sentence for the step line (`result`) and the command that fixes it (`fix`).
 */
export interface CopyRefusal {
  readonly text: string;
  readonly result: string;
  readonly fix: string;
}

/** {@link copyTargetRefusal} with the step screen's sentence and fix ({@link CopyRefusal}). */
export function copyTargetRefusalOf(io: CliIo, target: HookInstallTarget): CopyRefusal | null {
  const home = homeOf(io.env);
  const escape = copyDirEscape(home);
  if (escape !== null) {
    return {
      text: `${escape}, so the hook copy is not written: the service file in ${home} does not say which server runs`
        + ' it. Run the install from the HOME this directory belongs to, or remove the symlink.',
      result: 'the hook copy directory leads outside this HOME',
      fix: 'remove the symlink, or run Rarog from the HOME the directory belongs to',
    };
  }
  const platform = platformOf(io);
  const file = platform === 'darwin' ? servicePlistPath(home) : platform === 'linux' ? unitFilePath(home) : null;
  if (file === null) return null;
  const state = serviceFileState(file);
  if (state === 'missing') return null;
  const found = state !== 'present' ? state : platform === 'darwin' ? servicePlistArgv(io) : unitArgv(io);
  if ('issue' in found) {
    const doctor = rarogCli('doctor', target.mode);
    return {
      text: `cannot tell which installation the service starts (${found.issue.replace(/\.$/u, '')}), so the hook copy`
        + ` from this installation is not written. \`${doctor}\` shows the service state.`,
      result: 'cannot tell which installation the service starts', fix: doctor,
    };
  }
  const mismatch = serviceInstallationMismatch(found.argv, target.mode, {
    node: process.execPath, bin: join(target.root, 'bin', 'rarog.mjs'),
  });
  if (mismatch?.kind !== 'bin') return null;
  const own = `${quote(serviceArgvNode(found.argv) ?? 'node')} ${quote(serviceArgvBin(found.argv) ?? '')} hooks install`;
  // Z klonu bez propozycji przepięcia usługi: to przestawiłoby produkcję z paczki na klon.
  const hooksInstall = repairCommands(target.mode, target.root).hooksInstall;
  const switchOver = target.mode === 'package'
    ? `; or first point the service at this installation (\`${mismatch.reinstall}\`), then \`${hooksInstall}\``
    : '';
  return {
    text: `the service ${mismatch.what}: a hook copy from this installation would change the hook code next to that`
      + ` server, so nothing is written. The service's installation installs the copy: \`${own}\`${switchOver}.`,
    result: 'the service starts another installation',
    // The package points the service here first; a clone never does (it would move production to the clone).
    fix: target.mode === 'package' ? `${mismatch.reinstall}, then ${hooksInstall}` : own,
  };
}

/** Zdanie naprawy stanu `stale` dla komendy instalacji kopii `install`. */
function hookRepairCopy(install: string): string {
  return `Fix: \`${install}\` in your own terminal (outside the Claude Code sandbox).`;
}

/** Naprawa stanu `stale` (kopia hooka różna od repo albo jej brak); to samo zdanie mówi `rarog doctor`. */
export const HOOK_REPAIR_COPY = hookRepairCopy(REPAIR.hooksInstall);
/** Naprawa stanów `missing` i `mismatch` (wpis w ustawieniach); to samo zdanie mówi `rarog doctor`. */
export const HOOK_REPAIR_ENTRY = `Fix: \`${REPAIR.hooksInstall}\` in a terminal (hook code copy, then the entries in`
  + ' ~/.claude/settings.json after one question, d shows the diff); a conflict it shows needs a hand edit (block:'
  + ` \`${REPAIR.hooksPrint}\`).`;
/**
 * Linie o znacznikach per plik wejściowy: który plik kopii Claude Code wołał i kiedy. Wspólne z `rarog doctor`.
 */
export function seenByFileLines(dataDir: string, now: number): string[] {
  const byFile = Object.entries(readHookSeenByFile(dataDir));
  if (byFile.length === 0) return ['per-file markers: none (the copy predates per-file markers, or the hook has not fired)'];
  return byFile.map(([file, at]) => `per-file marker ${file}: last fired ${String(ageS(at, now))} s ago`);
}

/** Powód `mismatch`, gdy wpis wskazuje checkout repo zamiast kopii hooka. */
export const HOOK_CHECKOUT_REASON = 'the entry points at the repo checkout, not the hook copy: an agent in the sandbox'
  + ' can change the checkout code, and Claude Code runs it outside the sandbox.';

/** Wiek w sekundach albo `null`. */
function ageS(at: number | null, now: number): number | null {
  return at === null ? null : Math.max(0, Math.floor((now - at) / 1000));
}

/** Blok hooka do wklejenia z uwagami; wspólny z `rarog setup` (krok hooka). */
export function printHookBlock(io: CliIo, local: boolean, home: string): void {
  const target = local
    ? localSettingsPath('<project directory>')
    : userSettingsPath('~');
  io.stdout(`First \`${REPAIR.hooksInstall}\` (hook code copy in `
    + `${hookInstallDir(home)}; the block below points at THAT copy, not the repo checkout).\n\n`);
  io.stdout(`Paste this block into ${target} (merge it with the existing \`hooks\`, \`sandbox\` and \`permissions\`;`
    + ' remove nothing from there; with a statusLine of your own use `rarog hooks statusline --chain'
    + ' \'<your command>\'` instead of this one):\n\n');
  // The directory of the installed service, as setup's write: a block for the shell's directory would leave a
  // service with its own data directory without the rules while the notes below say it has them.
  const resolved = settingsDataDir({
    home, env: io.env, serviceDir: installedServiceDataDir(io, platformOf(io), home),
  });
  const writeBlock = resolved.ok ? writeBlockRules(resolved.dir, home)
    : { ok: false, reason: resolved.message } as const;
  const block = {
    ...(pasteHookBlock(hookCommand(home), contextHookCommand(home)) as object),
    ...(statuslineBlock(statuslineCommand(home)) as object),
    ...(denyReadBlock(resolved.ok ? resolved.dir : '<data directory>') as object),
    ...(writeBlock.ok ? { permissions: { deny: [...writeBlock.rules] } } : {}),
  };
  io.stdout(`${JSON.stringify(block, null, 2)}\n\n`);
  io.stdout([
    'Notes:',
    writeBlock.ok
      ? '- `permissions.deny` keeps a Claude Code session that loads these settings from writing the Rarog data'
        + '\n  directory and `~/.config/rarog` (Bash in the sandbox, and the Write and Edit tools).'
      : `- No write block rules in this block: ${writeBlock.reason.replace(/\.$/u, '')}.`,
    `- \`SessionStart\` runs the context hook \`${CONTEXT_HOOK_FILE}\` from the same copy. In a herdr pane under the`,
    '  Rarog roots it tells the model how the app highlights a question to you (the bold **To you:** marker), and',
    '  prints nothing anywhere else. It has its own state in `hooks:doctor` and stays out of the `/health` `hook`',
    '  field; remove its entry to turn it off.',
    '- The command points at the copy in `~/.claude/hooks/rarog/`: Claude Code runs the hook outside',
    '  the sandbox, and an agent in the sandbox can change the repo checkout. After every change in',
    '  `scripts/hooks/`, `/health` and `hooks:doctor` say `stale` until you run',
    `  \`${REPAIR.hooksInstall}\` in your own terminal (review the changes first).`,
    `- \`node\` comes from the PATH of the Claude Code session (in this repo: node from nvm, the same one`,
    '  the server start adds). A path with the nvm version number is left out on purpose: it is gone',
    '  after the next `nvm install`.',
    `- \`timeout: ${String(HOOK_ANSWER_TIMEOUT_S)}\` (24 h) on \`PermissionRequest\` is DELIBERATE: the hook WAITS`,
    '  for the decision from the phone (the `AskUserQuestion` answer, and a permission with the consent channel),',
    '  and the dialog stays up until someone decides, overnight too. Without a wait it finishes in milliseconds,',
    `  hence \`timeout: ${String(HOOK_TIMEOUT_S)}\` on \`PreToolUse\`, where the hook only dumps the question text.`,
    '- `--answer-wait` in the command MUST match `timeout` (the cap minus 2 s): a hook that waits',
    '  longer than the registration allows is killed silently.',
    '- `PermissionRequest` without a matcher (it covers `ExitPlanMode` too); `PreToolUse` ONLY',
    '  with the `AskUserQuestion` matcher, not on every tool.',
    '- The hook writes only for directories under the Rarog roots (`<dataDir>/roots.json`, written at',
    '  server start from `RAROG_HERDR_ROOTS`). Outside them it exits without a trace.',
    '- Tall dialog guard (`RAROG_TALL_DIALOG_GUARD`): in a herdr session the hook',
    '  DENIES a `Bash` permission whose dialog does not fit on the phone, and asks the model',
    '  for shorter calls. It never allows anything.',
    local
      ? '- `--local` variant: `settings.local.json` is in the `.gitignore` of most repos and loads\n  hooks the same way'
        + ` as the user-wide file. \`/health\` checks ONLY the user-wide file, though:\n  with a local install the`
        + ` \`hook\` field says \`${HOOK_STATUS_MISSING}\`.`
      : `- Project variant: \`${REPAIR.hooksPrintLocal}\`.`,
    '- `rarog setup` and `rarog hooks install` write the entries to `~/.claude/settings.json` themselves, after',
    `  one question (\`d\` shows the diff); the Rarog server never writes settings. Check: \`${REPAIR.hooksDoctor}\`.`,
    '',
  ].join('\n'));
}

/**
 * Komenda instalacji integracji Claude w herdr. Uruchamia ją wyłącznie krok 1 `rarog setup`, po pytaniu,
 * bo herdr pisze wtedy ustawienia Claude Code; doctor tylko ją drukuje.
 */
export const HERDR_INTEGRATION_INSTALL = 'herdr integration install claude';

/** Sufit czasu `herdr integration status` (komenda czyta pliki, nie gniazdo). */
const HERDR_INTEGRATION_TIMEOUT_MS = 5000;

/**
 * Integracja Claude w herdr według `herdr integration status` (linia `claude: …`, herdr 0.9.5): `current` (tekst
 * zaczyna się od „current”), `missing` („not installed”), `other` (inny tekst, np. starsza wersja) albo `unknown`
 * (komenda padła albo bez linii `claude:`). `text` to tekst po dwukropku albo powód.
 */
export interface HerdrIntegration {
  readonly state: 'current' | 'missing' | 'other' | 'unknown';
  readonly text: string;
}

/** `herdr integration status` przez `herdr` (pełna ścieżka); tylko odczyt, niczego nie instaluje. */
export function herdrClaudeIntegration(herdr: string, env: NodeJS.ProcessEnv): HerdrIntegration {
  const result = spawnSync(herdr, ['integration', 'status'], {
    env, encoding: 'utf8', timeout: HERDR_INTEGRATION_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error !== undefined || result.status !== 0) {
    return { state: 'unknown', text: result.error?.message ?? `code ${String(result.status)}` };
  }
  const found = result.stdout.split('\n').map((one) => one.trim()).find((one) => one.startsWith('claude:'));
  if (found === undefined) return { state: 'unknown', text: 'no `claude:` line' };
  const text = found.slice('claude:'.length).trim();
  if (text.startsWith('current')) return { state: 'current', text };
  return { state: text.startsWith('not installed') ? 'missing' : 'other', text };
}

/** `herdr` z `PATH`, potem `~/.local/bin/herdr` (ta sama kolejność co krok narzędzi `rarog setup`); `null` = brak. */
export function findHerdr(env: NodeJS.ProcessEnv, home: string): string | null {
  for (const dir of [...(env['PATH'] ?? '').split(':'), join(home, '.local', 'bin')]) {
    if (dir.startsWith('/') && onPath('herdr', { PATH: dir })) return join(dir, 'herdr');
  }
  return null;
}

/** Linia o integracji (wspólna dla `hooks doctor` i `rarog setup`), bez wcięcia. */
export function herdrIntegrationLine(integration: HerdrIntegration): string {
  switch (integration.state) {
    case 'current':
      return `herdr integration for Claude Code: ${integration.text}`;
    case 'missing':
      return `MISSING herdr integration for Claude Code (${integration.text}): Rarog finds no session without it. Run`
        + ` \`${HERDR_INTEGRATION_INSTALL}\` in your terminal (\`rarog setup\` runs it after a question); herdr then`
        + ' adds its own SessionStart hook to ~/.claude/settings.json.';
    case 'other':
      return `WARNING: herdr integration for Claude Code is not current (${integration.text}); the install command is`
        + ` \`${HERDR_INTEGRATION_INSTALL}\`.`;
    case 'unknown':
      return `herdr integration for Claude Code: not checked (herdr integration status: ${integration.text})`;
  }
}

/** Powód `mismatch` wpisu hooka kontekstu wskazującego checkout repo. */
const CONTEXT_CHECKOUT_REASON = 'the entry points at the repo checkout, not the copy in `~/.claude/hooks/rarog/`.';

/** Linia o wpisie hooka kontekstu w jednym pliku ustawień (doctor), bez wcięcia. */
function contextHookLine(one: ContextHookInspection): string {
  const detail = one.entries.length === 0
    ? (one.readable ? 'no entry' : 'missing or cannot be parsed')
    : one.entries.map((entry) => `${entry.event}${entry.matcher === null ? '' : `/${entry.matcher}`}`
      + ` timeout=${entry.timeout === null ? 'none' : String(entry.timeout)}`).join(', ');
  return `context hook in ${one.path}: ${one.status} — ${detail}${one.checkout ? ` (${CONTEXT_CHECKOUT_REASON})` : ''}`;
}

/**
 * `rarog hooks statusline [--chain <komenda>]`: blok `statusLine` wskazujący kopię skryptu Raroga.
 * Wspólny z `rarog setup` (krok `statusLine`), żeby obie drogi drukowały to samo.
 */
export function printStatuslineBlock(io: CliIo, home: string, chain?: string): void {
  io.stdout('First `rarog hooks install` (script copy in '
    + `${hookInstallDir(home)}; the block below points at THAT copy, not the repo checkout).\n\n`);
  io.stdout(`Paste this block into ${userSettingsPath('~')} (it sets the \`statusLine\` key; leave the rest of the file):\n\n`);
  io.stdout(`${renderStatuslineBlock(statuslineCommand(home, chain))}\n\n`);
  io.stdout([
    'Notes:',
    '- The script dumps the status line payload to `~/.claude/statusline/<session>.json`; the server takes',
    '  the session context window size and the plan usage limits from it. The script prints the model and the',
    '  context window percentage itself.',
    '- Already have your own `statusLine`? Print the block with a chain: `rarog hooks statusline --chain \'<your command>\'`.',
    '  After the dump the script runs your command with the same payload on stdin and shows its output (2 s limit).',
    '  Your own script that dumps the payload to `~/.claude/statusline/<session>.json` (tmp + rename) works too.',
    '- The command points at the copy in `~/.claude/hooks/rarog/`: Claude Code runs it outside the sandbox.',
    '- `rarog setup` writes `statusLine` to `~/.claude/settings.json` itself, after one question, `d` shows the',
    '  diff (a custom command without fresh snapshots gets the chain); the Rarog server never writes settings. Check:',
    '  `rarog doctor`, line `statusLine`.',
    '',
  ].join('\n'));
}

/** Zrzuty leżące w `<dataDir>/pending/` — diagnostyka, nie dowód (kasuje je decyzja z Raroga). */
function pendingDumps(dir: string, now: number): string[] {
  let names: string[];
  try {
    names = readdirSync(join(dir, 'pending')).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  return names.map((name) => {
    const path = join(dir, 'pending', name);
    let tool = '?';
    let event = '?';
    let at: number | null = null;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      if (typeof parsed['toolName'] === 'string') tool = parsed['toolName'];
      if (typeof parsed['hookEventName'] === 'string') event = parsed['hookEventName'];
      if (typeof parsed['at'] === 'number') at = parsed['at'];
    } catch {
      // Zepsuty zrzut też jest informacją — pokazujemy go z wiekiem pliku.
    }
    if (at === null) {
      try {
        at = statSync(path).mtimeMs;
      } catch {
        at = null;
      }
    }
    const age = ageS(at, now);
    return `  ${name.replace(/\.json$/, '')} · ${event} · ${tool} · ${age === null ? '?' : `${String(age)} s ago`}`;
  });
}

/** Ile plików odpowiedzi leży w `<dataDir>/answers/` (razem, po wszystkich sesjach). */
function answerFiles(dir: string): number {
  let sessions: string[];
  try {
    sessions = readdirSync(join(dir, HOOK_ANSWERS_DIRNAME));
  } catch {
    return 0;
  }
  return sessions.reduce((sum, session) => {
    try {
      return sum + readdirSync(join(dir, HOOK_ANSWERS_DIRNAME, session)).length;
    } catch {
      return sum;
    }
  }, 0);
}

const STATE_TEXT: Readonly<Record<HookCopyFile['state'], string>> = {
  match: 'matches the repo', differs: 'differs from the repo', missing: 'missing',
  unreadable: 'unreadable (not a regular file)',
};

/** Opis pliku z poprzedniej instalacji spoza obecnego zestawu kopii (`HookCopyReport.leftovers`). */
export const HOOK_LEFTOVER_TEXT = 'file from a previous install, outside the current set; `hooks install` removes it';

/**
 * Przedrostek pierwszej linii `hooks doctor`. Skrypty biorą stan jako pierwsze słowo po nim, więc linię składa
 * wyłącznie {@link hookStatusLine}.
 */
export const HOOK_STATUS_LINE_PREFIX = 'hook: ';

/** Przedrostek linii stanu hooka kontekstu w `hooks doctor` (stan jako pierwsze słowo po nim). */
export const CONTEXT_STATUS_LINE_PREFIX = 'context: ';

/** Pierwsza linia `hooks doctor`: przedrostek, stan i po trzech spacjach dopisek o `/health`. */
export function hookStatusLine(status: HookStatus): string {
  return `${HOOK_STATUS_LINE_PREFIX}${status}   (same value as /health)`;
}

/** Pytanie `hooks install` przed zapisem kopii w trybie paczki; skrypty odbioru paczki szukają go w wyjściu. */
export function hookInstallQuestion(dir: string): string {
  return `Write these files to ${dir}? [y/N] `;
}

/** Przedrostek linii z ostrzeżeniami instalacji kopii w wyjściu `hooks install`; skrypty filtrują po nim. */
export const HOOK_INSTALL_WARNING_PREFIX = 'WARNING: ';

/** Linie o kopii dla doctora: katalog, prawdziwa ścieżka, manifest i stan każdego pliku. */
function copyLines(report: HookCopyReport): string[] {
  const lines = [`copy:    ${report.dir}`];
  if (report.dirKind === 'symlink') {
    lines.push('  the copy directory is a SYMLINK: it does not count as a copy (it could lead to a checkout).');
  } else if (report.dirKind === 'other') {
    lines.push('  something other than a directory stands where the copy directory belongs.');
  } else if (report.dirKind === 'dir') {
    try {
      const real = realpathSync(report.dir);
      if (real !== report.dir) lines.push(`  real path: ${real}`);
    } catch {
      // Brak realpath przy istniejącym katalogu = wyścig z usunięciem; stan plików i tak to pokaże.
    }
    lines.push(report.manifest === null
      ? `  ${HOOK_MANIFEST_FILENAME}: missing or unreadable`
      : `  ${HOOK_MANIFEST_FILENAME}: ${hookOriginText(report.manifest)}, `
        + `${new Date(report.manifest.at).toISOString()}`);
  }
  for (const one of report.files) lines.push(`  ${one.name}: ${STATE_TEXT[one.state]}`);
  for (const name of report.leftovers) lines.push(`  ${name}: ${HOOK_LEFTOVER_TEXT}`);
  return lines;
}

/**
 * Pliki kopii zmienione PO instalacji: plik różny od źródła, którego skrót różni się od skrótu z manifestu (ktoś spoza
 * `hooks install` zmienił kod pod `~/.claude/hooks/`). Wspólne z `rarog setup`, który przy takiej kopii nie pyta
 * o aktualizację.
 */
export function changedAfterInstall(files: readonly HookCopyFile[]): string[] {
  return files.filter((one) => one.state !== 'match' && one.copySha !== null && one.manifestSha !== null
    && one.copySha !== one.manifestSha).map((one) => one.name);
}

/** Ostrzeżenie o kopii zmienionej po instalacji ({@link changedAfterInstall}); to samo mówią doctor i `rarog setup`. */
export function changedAfterInstallWarning(names: readonly string[]): string {
  return `WARNING: copy changed AFTER the install (${names.join(', ')}): hash differs from the manifest. Someone`
    + ' outside `hooks:install` changed the hook code under `~/.claude/hooks/`.';
}

/**
 * Linie o źródle, które poszło dalej od instalacji kopii (kopia równa manifestowi, inna niż źródło, albo plik dodany
 * w źródle po instalacji: nie ma go ani w kopii, ani w manifeście): w klonie z kopią
 * z klonu przegląd zmian od commita instalacji (`git log`); inaczej zdanie, z czego jest kopia i co jest źródłem
 * (w paczce różnicę pokazuje sam instalator przed pytaniem). Pusta lista, gdy tego nie widać. Wspólne z `rarog setup`,
 * który drukuje je przed pytaniem o aktualizację.
 */
export function sourceMovedLines(report: HookCopyReport, target: HookInstallTarget): string[] {
  const manifest = report.manifest;
  const moved = manifest !== null && report.files.some((one) => one.state !== 'match'
    && ((one.copySha !== null && one.copySha === one.manifestSha) || (one.state === 'missing' && one.manifestSha === null)));
  if (!moved) return [];
  if (target.mode === 'clone' && manifest.commit !== null) {
    return [
      'The repo changed the hook since the install. Review the changes:',
      `  git log ${manifest.commit}..HEAD -- ${HOOK_SOURCE_DIR_REL}`,
    ];
  }
  const source = target.mode === 'package'
    ? `package version ${installedVersion(target.root) ?? '(version unreadable)'}`
    : 'repo clone (copy without a commit: review scripts/hooks/ before installing)';
  return [`The source changed the hook since the install (copy: ${hookOriginText(manifest)}; source: ${source}).`];
}

/**
 * Co zrobić przy kopii różnej od źródła. Kopia różna od manifestu = ktoś zmienił ją PO instalacji (ostrzeżenie);
 * kopia równa manifestowi = źródło poszło dalej ({@link sourceMovedLines}). W klonie z kopią z klonu najpierw
 * przegląd zmian od commita instalacji (`git log`), potem `install`. W paczce gita nie ma: zdanie mówi, z czego jest
 * kopia i co jest źródłem, a różnicę pokazuje sam `install` przed pytaniem.
 */
function staleAdvice(report: HookCopyReport, target: HookInstallTarget): string[] {
  const lines: string[] = [''];
  const afterInstall = changedAfterInstall(report.files);
  if (afterInstall.length > 0) lines.push(changedAfterInstallWarning(afterInstall));
  const install = repairCommands(target.mode, target.root).hooksInstall;
  const moved = sourceMovedLines(report, target);
  lines.push(...moved);
  if (moved.length > 0 && target.mode === 'package') {
    lines.push(`\`${install}\` shows the diff before writing and asks.`);
  }
  lines.push(hookRepairCopy(install));
  return lines;
}

function doctor(io: CliIo, target: HookInstallTarget): number {
  const now = Date.now();
  const home = homeOf(io.env);
  const resolved = resolveDataDir({ env: io.env, home });
  if (!resolved.ok) {
    // Konflikt katalogów: hook w tym stanie milknie, a serwer nie wstaje — nie ma czego mierzyć.
    io.stdout(`dataDir: CONFLICT — the hook writes nothing and the server does not start.\n`
      + `${dataDirConflictMessage(resolved)}\n`);
    return 1;
  }
  const dir = resolved.dir;
  const command = hookCommand(home);
  const expected = expectedHookEntries(command);
  const user = inspectSettingsFile(userSettingsPath(home), expected);
  const local = inspectSettingsFile(localSettingsPath(io.cwd), expected);
  const registered = combineStatus([user]);
  const report = hookCopyReport(home, target.root);
  // Ta sama reguła co `/health` (`hookHealth`): poprawny wpis przy kopii różnej od repo to `stale`.
  const status = withCopyStatus(registered, report);

  const lines: string[] = [];
  lines.push(hookStatusLine(status));
  lines.push(`command: ${command}`);
  lines.push(`source:  ${join(target.root, HOOK_SOURCE_DIR_REL)}`);
  lines.push(...copyLines(report));
  // Skrypt `statusLine` leży w tej samej kopii, ale do pola `hook` nie wchodzi (liczy się, gdy pasek go wskazuje).
  for (const one of statuslineCopyReport(home, target.root).files) {
    lines.push(`  ${one.name}: ${STATE_TEXT[one.state]} (statusLine script, outside the hook state)`);
  }
  for (const one of [user, local]) {
    const detail = one.entries.length === 0
      ? (one.readable ? 'no Rarog entries' : 'missing or cannot be parsed')
      : one.entries.map((entry) => `${entry.event}${entry.matcher === null ? '' : `/${entry.matcher}`}`
        + ` timeout=${entry.timeout === null ? 'none' : String(entry.timeout)}`).join(', ');
    lines.push(`${one.path}: ${one.status} — ${detail}`);
    if (one.checkout) {
      lines.push(`  ${HOOK_CHECKOUT_REASON} Swap \`command\` for the one printed by \`${REPAIR.hooksPrint}\`.`);
    }
  }
  if (user.status !== 'ok' && local.status === 'ok') {
    lines.push('WARNING: the block is only in the project file; /health asks about the user-wide file and says'
      + ` \`${HOOK_STATUS_MISSING}\`.`);
  }
  // Hook kontekstu: własny stan, poza polem `hook` i poza kodem wyjścia.
  const contextCommand = contextHookCommand(home);
  const contextUser = inspectContextHook(userSettingsPath(home), contextCommand);
  const contextLocal = inspectContextHook(localSettingsPath(io.cwd), contextCommand);
  // Wpisy Raroga w obu plikach: ten sam handler w dwóch plikach ustawień Claude Code odpala
  // raz, a różny (np. stara komenda w pliku projektu) dwa razy. `/health` czyta tylko plik użytkownika i tego nie widzi.
  if (user.entries.length + contextUser.entries.length > 0 && local.entries.length + contextLocal.entries.length > 0) {
    lines.push(`WARNING: Rarog hook entries are in both ${user.path} and ${local.path}: in this project identical`
      + ' handlers fire once and different ones (for example an old command) fire twice. Keep them only in the'
      + ' user-wide file.');
  }
  lines.push(`${CONTEXT_STATUS_LINE_PREFIX}${contextUser.status}`
    + '   (SessionStart context hook, outside the hook state and /health)');
  lines.push(contextHookLine(contextUser), contextHookLine(contextLocal));
  if (contextUser.status !== 'ok') {
    lines.push(`  The \`SessionStart\` entry is in the block from \`${REPAIR.hooksPrint}\`; without it the model does`
      + ' not know the **To you:** marker the app highlights.');
  }
  const herdr = findHerdr(io.env, home);
  lines.push(herdr === null
    ? 'herdr integration for Claude Code: not checked (no herdr on PATH or in ~/.local/bin)'
    : herdrIntegrationLine(herdrClaudeIntegration(herdr, io.env)));

  const seenAt = readHookSeenAt(dir);
  const seen = ageS(seenAt, now);
  lines.push(`dataDir: ${dir}`);
  lines.push(seen === null
    ? `${HOOK_SEEN_FILENAME}: the hook has never fired (or the marker was deleted)`
    : `${HOOK_SEEN_FILENAME}: last fired ${String(seen)} s ago`);
  lines.push(...seenByFileLines(dir, now));

  const roots = readHookRoots(dir);
  lines.push(roots === null
    ? `${HOOK_ROOTS_FILENAME}: MISSING — the hook writes nothing (fail-closed). Start the server.`
    : `${HOOK_ROOTS_FILENAME}: ${roots.join(', ')}`);

  const dumps = pendingDumps(dir, now);
  lines.push(dumps.length === 0 ? 'pending/: empty' : `pending/: ${String(dumps.length)}`);
  lines.push(...dumps);

  // Kanał odpowiedzi: plik żyje ułamek sekundy, więc NIEPUSTE `answers/` znaczy
  // „hook nie odebrał" — najczęściej dlatego, że nie jest zainstalowany albo padł.
  const answers = answerFiles(dir);
  lines.push(answers === 0
    ? 'answers/: empty (as expected: the hook deletes the file after reading it)'
    : `answers/: ${String(answers)} — unconsumed answers; check the hook install`);

  if (status === 'stale') {
    lines.push(...staleAdvice(report, target));
  } else if (status !== 'ok') {
    lines.push('');
    lines.push(HOOK_REPAIR_ENTRY);
  }
  io.stdout(`${lines.join('\n')}\n`);
  return status === 'ok' ? 0 : 1;
}

/**
 * `install`: w klonie kopia ze stanu z commita; w paczce różnica wobec kopii na stdout, potem pytanie `[y/N]`
 * (tylko w terminalu, `CliIo.ask`); bez terminala różna kopia to odmowa z wydrukowaną różnicą. Odmowa i „nie” na
 * stderr z kodem 1.
 */
async function install(io: CliIo, target: HookInstallTarget): Promise<number> {
  const home = homeOf(io.env);
  const git = spawnGitArgs(gitReadEnv({ PATH: io.env['PATH'] ?? '', HOME: home }));
  const ask = io.ask;
  const review = ask === undefined ? undefined : async (diff: HookCopyReview): Promise<boolean> => {
    io.stdout(renderHookCopyReview(diff));
    return isYes(await ask(hookInstallQuestion(diff.dir)));
  };
  const result = await installHookCopy({
    home, root: target.root, mode: target.mode, git, ...(review === undefined ? {} : { review }),
    serviceRefusal: () => copyTargetRefusal(io, target),
  });
  if (!result.ok) {
    if (result.review !== undefined) io.stdout(renderHookCopyReview(result.review));
    io.stderr(`hooks:install: ${result.declined === true ? '' : 'refused — '}${result.reason}\n`);
    return 1;
  }
  const lines = [`Hook copy in ${result.dir} (${hookOriginText(result)}):`];
  for (const one of result.files) lines.push(`  ${one.name}  sha256 ${one.sha256}`);
  for (const name of result.removed) lines.push(`  ${name}  removed (file from a previous install)`);
  for (const warning of result.warnings) lines.push(`${HOOK_INSTALL_WARNING_PREFIX}${warning}`);
  lines.push(`Check: \`${REPAIR.hooksDoctor}\`. Status line block: \`rarog hooks statusline\`.`);
  io.stdout(`${lines.join('\n')}\n`);
  return installEntries(io, target, home);
}

/**
 * Początek linii stderr `install` bez terminala, gdy kopia już zapisana, a wpisów w ustawieniach brak (kod 1).
 * Wołający, który bierze z `install` samą kopię, rozpoznaje ten przypadek po tej stałej, nie po kopii tekstu.
 */
export const HOOK_ENTRIES_NO_TERMINAL = 'hooks:install: without a terminal the hook entries are not written';

/**
 * Wpisy hooka zgód w `~/.claude/settings.json` po zapisanej kopii: bieżące = kod 0 bez pytania; w terminalu
 * one question `[y/N/d]` (the same form as `rarog setup`): the diff is not printed up front, `d` shows it on the
 * screen and asks again; without a terminal no diff and no write. „Nie”, brak terminala, konflikt i odmowa: kod 1,
 * powód na stderr z blokiem do wklejenia jako drogą ręczną.
 */
async function installEntries(io: CliIo, target: HookInstallTarget, home: string): Promise<number> {
  const repair = repairCommands(target.mode, target.root);
  const resolved = resolveDataDir({ env: io.env, home });
  const ask = io.ask;
  const print = (line: string): void => { io.stdout(`${line}\n`); };
  const result = await writeClaudeSettings({
    home, root: target.root, operation: 'permission',
    dataDir: resolved.ok ? { ok: true, dir: resolved.dir } : { ok: false, message: dataDirConflictMessage(resolved) },
    lock: { dir: rarogConfigDir(io.env), what: 'rarog hooks install' },
    confirm: ask === undefined ? null : (question) => confirmForm(ask, entriesQuestion(question), 'y/N/d', {
      width: layoutOf(terminalOf(io).columns).width,
      showDiff: () => { for (const one of entriesDiff(question)) print(one); },
    }),
    print,
    // The diff quotes the user's file: only on the answer `d`, never up front.
    printDiff: () => {},
    again: repair.hooksInstall,
  });
  const settings = userSettingsPath(home);
  const manual = `block to paste by hand: \`${repair.hooksPrint}\``;
  switch (result.kind) {
    case 'unchanged':
      io.stdout(`Hook entries in ${settings}: match.\n`);
      return 0;
    case 'written':
      return 0;
    case 'declined':
      io.stderr(`hooks:install: hook entries not written to ${settings}; ${manual}.\n`);
      return 1;
    case 'no-terminal':
      io.stderr(`${HOOK_ENTRIES_NO_TERMINAL} to ${settings}; run`
        + ` \`${repair.hooksInstall}\` in a terminal, or ${manual}.\n`);
      return 1;
    case 'copy-not-ready':
      io.stderr(`hooks:install: hook entries not written: ${result.reason}.\n`);
      return 1;
    case 'conflict':
      io.stderr([
        `hooks:install: conflict in ${settings}, nothing written:`,
        ...result.reasons.map((reason) => `  ${reason}`),
        `Fix it by hand (${manual}), then run \`${repair.hooksInstall}\` again.`,
        '',
      ].join('\n'));
      return 1;
    case 'refused':
      io.stderr(`hooks:install: refused — ${result.reason.replace(/\.$/u, '')}.\n`);
      return 1;
  }
}

/** Argumenty bez pary `--chain <komenda>` i sama komenda łańcucha; `null` = `--chain` bez wartości. */
function splitChain(args: readonly string[]): { rest: string[]; chain: string | undefined } | null {
  const rest: string[] = [];
  let chain: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? '';
    if (arg !== '--chain') {
      rest.push(arg);
      continue;
    }
    const value = args[i + 1];
    if (value === undefined || value.trim() === '') return null;
    chain = value;
    i += 1;
  }
  return { rest, chain };
}

/**
 * Wejście komend hooka: `args` to argumenty PO nazwie (`print`, `install`, `doctor`, `--local`). Bez komendy —
 * `print`, jak `scripts/hooks-config.ts`. Nieznana komenda: `usage` na stderr i `usageCode` (podkładka
 * `pnpm run hooks:*` ma 2, `rarog hooks` ma 64 jak reszta CLI). `target` to instalacja ze źródłem
 * kopii (testy podają paczkę na atrapie katalogu).
 */
export async function hooksCommand(
  args: readonly string[], io: CliIo, usage: string, usageCode: number, target: HookInstallTarget = THIS_INSTALL,
): Promise<number> {
  const split = splitChain(args);
  const local = args.includes('--local');
  const command = split?.rest.find((arg) => !arg.startsWith('-')) ?? 'print';
  if (split === null || (split.chain !== undefined && command !== 'statusline')) {
    io.stderr(`${usage}\n`);
    return usageCode;
  }
  switch (command) {
    case 'install':
      return install(io, target);
    case 'print':
      printHookBlock(io, local, homeOf(io.env));
      return 0;
    case 'statusline':
      printStatuslineBlock(io, homeOf(io.env), split.chain);
      return 0;
    case 'doctor':
      return doctor(io, target);
    default:
      io.stderr(`${usage}\n`);
      return usageCode;
  }
}
