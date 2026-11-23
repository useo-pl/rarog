/**
 * Step 9 of `rarog setup` (Linux only): herdr as the `systemd --user` unit `herdr.service`. With herdr not running and
 * no such unit anywhere the manager looks, the unit is an item of the setup plan: setup writes it to
 * `~/.config/systemd/user` after the one "y" to `Continue?` and never enables or starts it; for an existing unit
 * it reads the state from `systemctl --user show` and checks that the PATH of herdr panes has the `claude` and node
 * directories.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { readRegularFileSync } from '../safe-read.ts';
import { Refusal, out } from './io.ts';
import { accepts } from './restart.ts';
import {
  SCREEN_TITLE, SERVICE_UNDETERMINED, entry, errnoCode, herdrSocket, line, onShellPath, unsafeDir, waitingStep,
  writeIfMissing,
} from './setup-context.ts';
import type { Ctx, Step } from './setup-context.ts';
import { tilde } from './setup-plan.ts';
import type { PlanEntry } from './setup-plan.ts';
import {
  escapeExecProgram, escapeUnitPath, locateUnit, samePath, showUnit, userUnitDir,
} from './systemd-unit.ts';

/** The herdr unit setup writes on Linux after its question. */
export const HERDR_UNIT_NAME = 'herdr.service';

/**
 * The command that starts herdr now and at each login. Setup never runs it: herdr started by hand on the same socket
 * would get a second server next to it.
 */
const ENABLE_NOW = `systemctl --user enable --now ${HERDR_UNIT_NAME}`;

/** Katalogi systemowe na końcu `PATH` jednostki herdr (domyślny `PATH` menedżera systemd, z `/sbin` i `/bin`). */
const SYSTEM_PATH_DIRS = ['/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin'] as const;

/** Katalogi, których panel herdr potrzebuje w `PATH`: `claude` z kroku 1 i węzeł tego procesu (hook treści). */
function panelDirs(ctx: Ctx): { readonly dir: string; readonly what: string }[] {
  return [
    ...(ctx.claude === null ? [] : [{ dir: path.dirname(ctx.claude), what: 'claude' }]),
    { dir: path.dirname(process.execPath), what: 'node for the permission hook' },
  ];
}

/** Katalog, który przejdzie do `Environment="PATH=…"`: bezwzględny, bez `:` i znaków, których jednostka nie niesie. */
function unitPathDirOk(dir: string): boolean {
  if (dir.includes(':')) return false;
  try {
    escapeUnitPath(dir, 'PATH');
    return true;
  } catch (failure) {
    if (failure instanceof Refusal) return false;
    throw failure;
  }
}

/**
 * `PATH` paneli herdr pod `systemd --user`: najpierw katalogi z `first` (z kroku 1: `claude`, węzeł, herdr), potem
 * `base` (`PATH` menedżera użytkownika) i katalogi systemowe, bez powtórzeń. Panel dziedziczy `PATH` serwera herdr,
 * a menedżer nie zna katalogów z `~/.profile` (`~/.local/bin` instalatora Claude Code). Katalog, którego jednostka
 * nie przeniesie (ścieżka względna, `:`, `"`, `\`, nowa linia, biały znak na końcu), wypada.
 */
export function herdrUnitPath(first: readonly string[], base: string): string[] {
  const dirs: string[] = [];
  for (const dir of [...first, ...base.split(':'), ...SYSTEM_PATH_DIRS]) {
    if (!dirs.includes(dir) && unitPathDirOk(dir)) dirs.push(dir);
  }
  return dirs;
}

/** The `herdr.service` unit setup writes (and shows on `d`); `pathDirs` from {@link herdrUnitPath}. */
export function renderHerdrUnit(herdr: string, pathDirs: readonly string[]): string {
  const pathValue = pathDirs.map((dir) => escapeUnitPath(dir, 'herdr unit PATH')).join(':');
  return [
    '[Unit]',
    'Description=herdr (terminal session server for Rarog)',
    '',
    '[Service]',
    `ExecStart=${escapeExecProgram(herdr)} server`,
    '# PATH of herdr panes: the claude, node and herdr directories from rarog setup (systemd --user does not read'
      + ' ~/.profile).',
    `Environment="PATH=${pathValue}"`,
    '# always, because herdr server stop (server restart after a herdr update) exits with code 0.',
    'Restart=always',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

/**
 * `PATH` jednostki herdr tej instalacji: `claude` i herdr z kroku 1, węzeł tego procesu, potem `base` (domyślnie
 * `PATH` menedżera; przy naprawie istniejącej jednostki jej własny `PATH`, żeby jej katalogi zostały).
 */
function herdrUnitPathOf(ctx: Ctx, herdr: string | null, base = ctx.serviceEnv['PATH'] ?? ''): string[] {
  const files = [ctx.claude, process.execPath, herdr].filter((file) => file !== null);
  return herdrUnitPath(files.map((file) => path.dirname(file)), base);
}

/**
 * Linie logiczne tekstu jednostki, jak w parserze systemd (strona `man systemd.syntax`, kontynuacja linii):
 * linia kończąca się nieparzystą liczbą `\` łączy się z następną, a ten `\` staje się spacją. Linie komentarza
 * (`#` albo `;` po białych znakach) wypadają, także wewnątrz kontynuacji: linia łączy się wtedy z tą po komentarzu.
 */
function unitLogicalLines(text: string): string[] {
  const lines: string[] = [];
  let pending: string | null = null;
  for (const raw of text.split('\n')) {
    const physical = raw.replace(/\r$/, '');
    if (/^\s*[#;]/.test(physical)) continue;
    const joined: string = `${pending ?? ''}${physical}`;
    if ((/\\*$/.exec(joined)?.[0].length ?? 0) % 2 === 1) {
      pending = `${joined.slice(0, -1)} `;
      continue;
    }
    pending = null;
    lines.push(joined);
  }
  if (pending !== null) lines.push(pending);
  return lines;
}

/**
 * `PATH` z tekstu jednostki herdr: ostatnia linia `Environment=` sekcji `[Service]`, która go ustawia (w systemd
 * późniejsza wygrywa, a puste `Environment=` zeruje wcześniejsze), w formie `Environment="PATH=…"`
 * z {@link renderHerdrUnit} albo `Environment=PATH=…` bez cudzysłowu i spacji; `%%` to `%`, `%h` to dom. Linie
 * czyta logicznie ({@link unitLogicalLines}): kontynuacja z `\` na końcu to jedna linia, więc kilka przypisań
 * rozpisanych na kilka linii daje `unknown` jak w jednej. `missing` = żadna linia nie ustawia `PATH`; `unknown` =
 * linia w innej formie (kilka przypisań, inny specyfikator, `\`, apostrofy). `Environment=` poza `[Service]`
 * systemd pomija, więc parser też.
 */
export function herdrUnitFilePath(text: string, home: string): readonly string[] | 'missing' | 'unknown' {
  let found: readonly string[] | 'missing' | 'unknown' = 'missing';
  let section = '';
  for (const current of unitLogicalLines(text)) {
    const header = /^\s*\[([^\]]*)\]\s*$/.exec(current)?.[1];
    if (header !== undefined) {
      section = header;
      continue;
    }
    const assignment = section === 'Service' ? /^\s*Environment\s*=\s*(.*?)\s*$/.exec(current)?.[1] : undefined;
    if (assignment === '') found = 'missing';
    if (assignment === undefined || !/(^|[\s"'])PATH=/.test(assignment)) continue;
    const value = /^"PATH=([^"\\]*)"$/.exec(assignment)?.[1] ?? /^PATH=([^\s"'\\]*)$/.exec(assignment)?.[1];
    if (value === undefined || /%[^%h]/.test(value.replaceAll('%%', ''))) {
      found = 'unknown';
      continue;
    }
    found = value.replace(/%([%h])/g, (_match, spec: string) => (spec === 'h' ? home : '%')).split(':');
  }
  return found;
}

/** Odczyt pliku jednostki herdr do {@link herdrUnitFilePath}; plik nie do przeczytania = `unknown`. */
function herdrUnitFilePathOf(file: string, home: string): readonly string[] | 'missing' | 'unknown' {
  try {
    const read = readRegularFileSync(file, { maxBytes: 64 * 1024, followSymlink: true });
    return read === null || read.truncated ? 'unknown' : herdrUnitFilePath(read.bytes.toString('utf8'), home);
  } catch {
    return 'unknown';
  }
}

/**
 * `PATH` paneli z istniejącej jednostki wobec katalogów `claude` i węzła: linia `Environment=` z pliku albo, bez
 * niej, `PATH` menedżera użytkownika. Brakujący katalog = WARNING i linia z bieżącymi katalogami; `ok` kroku
 * schodzi wtedy do `info`. Plik bez sprawdzalnej linii (`unknown`) = jedna linia bez zmiany stanu.
 */
function herdrUnitPathCheck(ctx: Ctx, file: string, step: Step): Step {
  const fromFile = herdrUnitFilePathOf(file, ctx.home);
  if (fromFile === 'unknown') {
    line(ctx, `unit PATH: an Environment= line in a form setup does not read — check yourself that it has the`
      + ` directories ${panelDirs(ctx).map(({ dir }) => dir).join(', ')}`);
    return step;
  }
  const dirs = fromFile === 'missing' ? (ctx.serviceEnv['PATH'] ?? '').split(':') : fromFile;
  const source = fromFile === 'missing' ? 'the systemd --user manager PATH (the unit does not set PATH)' : 'the unit PATH';
  const lacking = panelDirs(ctx).filter(({ dir }) => !dirs.includes(dir));
  if (lacking.length === 0) return step;
  for (const { dir, what } of lacking) {
    line(ctx, `WARNING: ${source} lacks ${dir} (${what}) — a herdr pane may not see it`);
  }
  const base = fromFile === 'missing' ? undefined : fromFile.join(':');
  const pathValue = herdrUnitPathOf(ctx, ctx.herdr, base).map((dir) => escapeUnitPath(dir, 'herdr unit PATH'))
    .join(':');
  // The sentences around a block to paste stay with it on the screen (`ctx.io`), not only in the run log.
  out(ctx.io, '  line for the [Service] section of the unit (then systemctl --user daemon-reload; only a new herdr'
    + ' server gets the new PATH):');
  out(ctx.io, `Environment="PATH=${pathValue}"\n`);
  const missingDirs = lacking.map(({ dir }) => dir).join(', ');
  return step.state === 'ok'
    ? { ...step, state: 'info', summary: `${step.summary}, but the pane PATH lacks ${missingDirs}` }
    : step;
}

/**
 * Istniejąca jednostka herdr: sam plik to nie „ok”. Stan z `systemctl --user show` (wartości, nie kody wyjścia):
 * `LoadState`, `NeedDaemonReload`, `UnitFileState`, `ActiveState`; „działa” = `active`, „wstanie po reboocie” =
 * `enabled`. Jednostka nieaktywna albo nieznana menedżerowi przy żywym gnieździe herdr = herdr działa poza nią
 * (`info`, `enable` bez `--now`). Na końcu `PATH` paneli. `file` = the unit file in `~/.config/systemd/user` or in
 * another `UnitPath` directory; `null` = the manager knows the unit without a file, so there is no PATH to read.
 */
async function existingHerdrUnit(ctx: Ctx, file: string | null): Promise<Step> {
  const title = 'herdr.service';
  line(ctx, file === null ? `${HERDR_UNIT_NAME}: known to the manager, no unit file` : `${file}: present`);
  const props = ['LoadState', 'UnitFileState', 'ActiveState', 'NeedDaemonReload'];
  const shown = showUnit(ctx.io, props, [], HERDR_UNIT_NAME);
  if ('failure' in shown) {
    line(ctx, `unit state undetermined (${shown.failure})`);
    return { title, state: 'problem', summary: `herdr.service: state undetermined (${shown.failure})` };
  }
  const load = shown.values.get('LoadState') ?? '';
  const enabled = shown.values.get('UnitFileState') ?? '';
  const active = shown.values.get('ActiveState') ?? '';
  line(ctx, `LoadState=${load || '?'}, UnitFileState=${enabled || '?'}, ActiveState=${active || '?'}`);
  const status = `systemctl --user status ${HERDR_UNIT_NAME}`;
  const enableNow = `systemctl --user enable --now ${HERDR_UNIT_NAME}`;
  // Przy żywym herdr poza jednostką `--now` startowałby drugi serwer obok działającego.
  const enableOnly = `systemctl --user enable ${HERDR_UNIT_NAME} (without --now, because herdr is already running)`;
  const alive = (): Promise<boolean> => accepts({ path: herdrSocket(ctx) });
  if (load === 'not-found') {
    return await alive()
      ? {
        title, state: 'info',
        summary: `herdr.service: the file is present, the manager does not know it, herdr runs outside it: systemctl`
          + ` --user daemon-reload && ${enableOnly}`,
      }
      : {
        title, state: 'missing',
        summary: `herdr.service: the file is present, the manager does not know it: systemctl --user daemon-reload`
          + ` && ${enableNow}`,
      };
  }
  if (load === 'masked') {
    return {
      title, state: 'problem', summary: `herdr.service: masked: systemctl --user unmask ${HERDR_UNIT_NAME}`,
    };
  }
  if (load !== 'loaded') {
    return { title, state: 'problem', summary: `herdr.service: LoadState=${load || '?'}; see ${status} for the cause` };
  }
  // Plik nowszy niż wczytana definicja: stan i `PATH` z pliku nie mówią, z czym systemd wystartuje.
  if (shown.values.get('NeedDaemonReload') === 'yes') {
    return {
      title, state: 'problem',
      summary: 'herdr.service: file changed without daemon-reload (NeedDaemonReload=yes): systemctl --user'
        + ' daemon-reload; only a new herdr server gets new settings such as PATH',
    };
  }
  let step: Step;
  if (active === 'active') {
    step = enabled === 'enabled'
      ? { title, state: 'ok', summary: 'herdr.service: active and enabled' }
      : {
        title, state: 'missing',
        summary: `herdr.service: running, but will not start after a reboot (UnitFileState=${enabled || '?'}):`
          + ` systemctl --user enable ${HERDR_UNIT_NAME}`,
      };
  } else if (await alive()) {
    step = {
      title, state: 'info',
      summary: `herdr.service: inactive (ActiveState=${active || '?'}), herdr runs outside it`
        + (enabled === 'enabled' ? '' : `; to start after a reboot: ${enableOnly}`),
    };
  } else if (enabled !== 'enabled') {
    step = { title, state: 'missing', summary: `herdr.service: inactive and not enabled: ${enableNow}` };
  } else {
    step = {
      title, state: 'problem',
      summary: `herdr.service: enabled, but not running (ActiveState=${active || '?'}): systemctl --user start`
        + ` ${HERDR_UNIT_NAME}; see ${status} for the cause`,
    };
  }
  return file === null ? step : herdrUnitPathCheck(ctx, file, step);
}

const TITLE = 'herdr.service';

/**
 * The herdr unit's place cannot be read (the manager or a directory entry did not answer): no question and no write.
 * With `systemctl --user` silent the step waits for the Tools step, which names it.
 */
function undetermined(ctx: Ctx, failure: string): Step {
  line(ctx, `${HERDR_UNIT_NAME}: state undetermined (${failure}) — writing nothing`);
  const summary = `herdr.service: state undetermined (${failure})`;
  if (ctx.serviceWaits !== null) return waitingStep(TITLE, 'problem', summary, ctx.serviceWaits);
  return {
    title: TITLE, state: 'problem', summary, result: SERVICE_UNDETERMINED,
    fix: `check systemctl --user status ${HERDR_UNIT_NAME} in a regular terminal, then rarog setup`,
  };
}

/** The unit directory refused or the write failed (`reason` without the path): nothing under the unit's name. */
function notWritten(ctx: Ctx, dir: string, reason: string): Step {
  line(ctx, `${path.join(dir, HERDR_UNIT_NAME)} not written: ${reason}`);
  return {
    title: TITLE, state: 'problem', summary: `herdr.service not written (${dir}: ${reason})`,
    result: `not written: ${reason}`, fix: `check ${tilde(dir, ctx.home)}, then rarog setup`,
  };
}

/**
 * The unit directory ready for the write: created when missing (parents too, default mode), then a real directory of
 * this user, not a symlink planted during the question. `null` = ready, otherwise why not.
 */
function unitDirIssue(dir: string): string | null {
  if (entry(dir) === 'missing') {
    try {
      mkdirSync(dir, { recursive: true });
    } catch (failure) {
      return errnoCode(failure);
    }
  }
  const issue = unsafeDir(dir, null);
  return issue === null ? null : issue.replace(`${dir}: `, '');
}

/**
 * After "y": the directory, the unit's place read again right before the write (a unit that appeared during the
 * question wins: its state as for any existing unit), then the file only when missing (`writeIfMissing`: a temporary
 * file and `link`, mode 0644). The unit is not enabled: herdr started by hand meanwhile would get a second server.
 */
async function writeUnit(ctx: Ctx, dir: string, unit: string): Promise<Step> {
  const file = path.join(dir, HERDR_UNIT_NAME);
  const issue = unitDirIssue(dir);
  if (issue !== null) return notWritten(ctx, dir, issue);
  const again = locateUnit(ctx.io, HERDR_UNIT_NAME);
  if (again.kind === 'unknown') return undetermined(ctx, again.failure);
  if (again.kind === 'present') {
    line(ctx, `${again.file ?? HERDR_UNIT_NAME} appeared during the question — writing nothing`);
    return existingHerdrUnit(ctx, again.file);
  }
  let written: boolean;
  try {
    written = writeIfMissing(file, unit, 0o644);
  } catch (failure) {
    return notWritten(ctx, dir, errnoCode(failure));
  }
  if (!written) {
    line(ctx, `${file} appeared during the question — writing nothing`);
    return existingHerdrUnit(ctx, file);
  }
  line(ctx, `${file}: written, not enabled`);
  for (const one of unit.trimEnd().split('\n')) line(ctx, `  ${one}`);
  return {
    title: TITLE, state: 'missing', summary: `herdr.service: ${file} written, not enabled: ${ENABLE_NOW}`,
    result: 'written, not enabled', fix: ENABLE_NOW, changed: true,
  };
}

/** The unit's line of the plan screen: what and where. */
export function herdrUnitPlanEntry(home: string): PlanEntry {
  return { item: 'herdr', what: HERDR_UNIT_NAME, where: tilde(userUnitDir(home), home) };
}

/**
 * The unit as a plan item, read without a write, when the step would write it (`null` otherwise): Linux, herdr found by
 * the Tools step, no unit the manager knows or finds in its `UnitPath`, `~/.config/systemd/user` in that `UnitPath`,
 * and herdr not answering on `socket` (the herdr socket of `config.json`, or herdr's default, read before the Config
 * step).
 */
export async function herdrUnitOffer(ctx: Ctx, socket: string): Promise<PlanEntry | null> {
  if (ctx.platform !== 'linux' || ctx.herdr === null) return null;
  const dir = userUnitDir(ctx.home);
  if (entry(path.join(dir, HERDR_UNIT_NAME)) === 'present') return null;
  const where = locateUnit(ctx.io, HERDR_UNIT_NAME);
  if (where.kind !== 'absent' || !where.unitPath.some((one) => samePath(one, dir))) return null;
  return await accepts({ path: socket }) ? null : herdrUnitPlanEntry(ctx.home);
}

/**
 * The herdr unit step of `rarog setup` on Linux (`null` elsewhere). An existing unit gets its state check (no write).
 * Without one, with herdr not running: the plan item accepted with "Continue?" leads to {@link writeUnit} (no
 * question of its own). Without a terminal, with the item declined or not in the plan, nothing is written.
 */
export async function stepHerdrUnit(ctx: Ctx): Promise<Step | null> {
  if (ctx.platform !== 'linux') return null;
  const dir = userUnitDir(ctx.home);
  const file = path.join(dir, HERDR_UNIT_NAME);
  if (entry(file) === 'present') return existingHerdrUnit(ctx, file);
  // A unit in another directory of the manager's search path, or one the manager knows, is the unit herdr runs from.
  const where = locateUnit(ctx.io, HERDR_UNIT_NAME);
  if (where.kind === 'present') return existingHerdrUnit(ctx, where.file);
  const alive = await accepts({ path: herdrSocket(ctx) });
  if (ctx.herdr === null) {
    line(ctx, 'no herdr — install herdr first');
    // The Tools step carries the fix.
    return waitingStep(TITLE, alive ? 'info' : 'missing', 'herdr.service: herdr first', SCREEN_TITLE.tools);
  }
  if (alive) {
    // Herdr spoza jednostki ma `PATH` procesu, który go uruchomił: tu widać tylko `PATH` tej powłoki.
    for (const { dir: panelDir, what } of panelDirs(ctx)) {
      if (!onShellPath(panelDir, ctx)) {
        line(ctx, `WARNING: herdr runs outside the unit, and ${panelDir} (${what}) is outside this shell's PATH — a`
          + ' herdr pane may not see it');
      }
    }
    // No question and no write next to a running herdr; not in use: `–`, not `✓`.
    return {
      title: TITLE, state: 'info', summary: 'herdr.service: no unit, herdr runs some other way',
      result: 'not used (herdr runs without it)', skipped: true,
    };
  }
  if (where.kind === 'unknown') return undetermined(ctx, where.failure);
  if (!where.unitPath.some((one) => samePath(one, dir))) {
    // A unit there would be invisible to the manager (another XDG_CONFIG_HOME of the manager).
    line(ctx, `the systemd --user manager does not look for units in ${dir} (not in UnitPath) — writing nothing`);
    return {
      title: TITLE, state: 'problem', summary: `herdr.service: the systemd --user manager does not read ${dir}`,
      result: `the manager does not read ${tilde(dir, ctx.home)}`, fix: 'run rarog setup in a regular login session',
    };
  }
  line(ctx, `${file}: missing, herdr not running`);
  if (ctx.ask === null) {
    return {
      title: TITLE, state: 'missing', summary: 'herdr.service: no unit; rarog setup in a terminal writes it',
      result: 'no unit; rarog setup in a terminal writes it',
    };
  }
  // The write only after "y" to the plan that listed it.
  if (ctx.declined.has('herdr')) {
    line(ctx, `${file}: not written (answer: no)`);
    // The user's choice, not a fault: no `Fix:` that sends them back to setup.
    return {
      title: TITLE, state: 'info', summary: 'herdr.service: not written (answer: no)', result: 'not written',
      skipped: true,
    };
  }
  if (!ctx.accepted.has('herdr')) {
    // The plan read another state (herdr running, or a unit, then); the next setup offers it.
    line(ctx, `${file}: not written, the plan of this run did not list it`);
    return {
      title: TITLE, state: 'missing', summary: 'herdr.service: not written, not in the plan; rarog setup offers it',
      result: 'not written: not in the plan', fix: 'rarog setup',
    };
  }
  const unit = renderHerdrUnit(ctx.herdr, herdrUnitPathOf(ctx, ctx.herdr));
  return writeUnit(ctx, dir, unit);
}
