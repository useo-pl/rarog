/**
 * Zrzut diagnostyczny odmowy (`server/src/herdr/dialogs/refusals.ts`).
 *
 * Testujemy DYSK, nie kształt obiektu: katalog i plik mają prawa, jakie deklaruje
 * `docs/security-model.md`, retencja i sufit realnie kasują, a wyłącznik nie tworzy nawet katalogu.
 * To jest nowa powierzchnia w `dataDir` z treścią ekranu panelu — jej granice muszą być
 * sprawdzone tak samo jak granice `pending/`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  REFUSAL_DUMP_DIALOG_SUFFIX, REFUSAL_DUMP_DIRNAME, REFUSAL_DUMP_MAX_FILES, REFUSAL_DUMP_TTL_MS,
  createRefusalDumper, sweepRefusalDumps,
} from '../src/herdr/dialogs/refusals.ts';
import type { RefusalDump } from '../src/herdr/dialogs/refusals.ts';

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'rarog-refusals-'));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

const AT = 1_700_000_000_000;

/** Katalog zrzutów. */
const dir = (): string => join(dataDir, REFUSAL_DUMP_DIRNAME);

/** Lista plików zrzutów (bez plików roboczych). */
const dumps = (): string[] => (existsSync(dir())
  ? readdirSync(dir()).filter((name) => name.endsWith('.txt')).sort()
  : []);

const DUMP: RefusalDump = {
  reason: 'no-jsonl',
  toolName: 'Bash',
  sessionId: 'sesja-1',
  screen: 'Bash(rm -rf /tmp/x)\n 1. Yes\n 2. No\n',
  hook: { toolName: 'Bash', at: AT - 1000, hookEventName: 'PermissionRequest' },
  jsonl: { id: 'toolu_01', toolName: 'Bash' },
};

const FIXTURES = join(import.meta.dirname, 'fixtures', 'herdr');
const SCREEN_MARK = '\n--- ekran ---\n';

/** The screen of a fixture: a refusal dump fixture without its header, any other fixture whole. */
function screenOf(name: string): string {
  const raw = readFileSync(join(FIXTURES, name), 'utf8');
  const at = raw.indexOf(SCREEN_MARK);
  return at < 0 ? raw : raw.slice(at + SCREEN_MARK.length);
}

/** A genuine layer-2 refusal: class `dialog`, the `/help` view on screen, no tool, no hook dump, no jsonl entry. */
const LAYER2_DUMP: RefusalDump = {
  reason: 'unreadable',
  sessionId: 'sesja-1',
  screen: screenOf('kontrolny/widok-help-2.1.322.txt'),
  hook: null,
  jsonl: null,
  cliDialog: 'dialog',
};

/** Podkłada gotowy plik zrzutu o zadanym wieku (żniwiarz liczy wiek z `mtime`). */
function putDump(name: string, ageMs: number): string {
  mkdirSync(dir(), { recursive: true, mode: 0o700 });
  const path = join(dir(), name);
  writeFileSync(path, 'stary zrzut\n', { mode: 0o600 });
  const seconds = (AT - ageMs) / 1000;
  utimesSync(path, seconds, seconds);
  return path;
}

describe('zapis zrzutu', () => {
  it('pisze plik `<ts>-<reason>.txt` z ekranem, metadanymi hooka i statusem jsonl', () => {
    createRefusalDumper({ dataDir, version: '0.1.0', enabled: true, now: () => AT })(DUMP);

    expect(dumps()).toHaveLength(1);
    const name = dumps()[0] ?? '';
    // Nazwa jest ISO bez `:` i `.` — plik diagnostyczny ma się dać skopiować bez cudzysłowów.
    expect(name).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-no-jsonl\.txt$/);
    const body = readFileSync(join(dir(), name), 'utf8');
    expect(body).toContain('rarog: 0.1.0');
    expect(body).toContain('reason: no-jsonl');
    expect(body).toContain('toolName: Bash');
    expect(body).toContain('sessionId: sesja-1');
    expect(body).toContain('hook: PermissionRequest Bash at=');
    expect(body).toContain('jsonl: Bash id=toolu_01');
    expect(body).toContain('1. Yes');
  });

  it('niesie KSZTAŁT przypadku tymi samymi polami co dziennik i czas zdarzenia w nazwie', () => {
    createRefusalDumper({ dataDir, version: '0.1.0', enabled: true, now: () => AT + 400 })({
      ...DUMP,
      reason: 'mismatch',
      cliDialog: 'permission',
      at: AT,
      shape: {
        reqId: 'hook:1700000000000:f:0123456789ab', source: 'hook', promptId: 'p-1', agentId: 'a7e5ec6c821818fae',
        mismatchReason: 'operation', headerVisible: false, optionCount: 2, dialogTitle: null, paneRows: 28,
        // Identyfikator w obcym kształcie (zrzut hooka pisze proces spoza Raroga) nie trafia do pliku.
        toolUseId: 'toolu x; rm -rf',
      },
    });

    const name = dumps()[0] ?? '';
    // Nazwa z czasu ZDARZENIA (wpis `degrade` zapisuje się po odczycie wierszy panelu).
    expect(name.startsWith(new Date(AT).toISOString().replace(/[:.]/g, '-'))).toBe(true);
    const body = readFileSync(join(dir(), name), 'utf8');
    const header = body.slice(0, body.indexOf('--- ekran ---'));
    for (const line of [
      'cliDialog: permission', 'reqId: hook:1700000000000:f:0123456789ab', 'source: hook', 'promptId: p-1',
      'agentId: a7e5ec6c821818fae', 'mismatchReason: operation', 'headerVisible: false', 'optionCount: 2',
      'dialogTitle: brak', 'paneRows: 28',
    ]) expect(header).toContain(line);
    expect(header).not.toContain('toolUseId');
  });

  it('niesie werdykt rozdzielacza i `blockVisible` w nagłówku, jak wpis dziennika', () => {
    createRefusalDumper({ dataDir, version: '0.1.0', enabled: true, now: () => AT })({
      ...DUMP,
      reason: 'screen-changed',
      cliDialog: 'sandbox',
      shape: { optionCount: 3, blockVisible: false, route: 'terminal-only', routeReason: 'sandbox' },
    });
    const body = readFileSync(join(dir(), dumps()[0] ?? ''), 'utf8');
    const header = body.slice(0, body.indexOf('--- ekran ---'));
    for (const line of [
      'cliDialog: sandbox', 'optionCount: 3', 'blockVisible: false', 'route: terminal-only', 'routeReason: sandbox',
    ]) expect(header).toContain(line);
  });

  it('nie zostawia pliku roboczego — zapis jest atomowy (tmp + rename)', () => {
    createRefusalDumper({ dataDir, version: '0.1.0', enabled: true, now: () => AT })(DUMP);
    expect(readdirSync(dir()).filter((name) => name.includes('.tmp'))).toEqual([]);
  });

  it('plik ma prawa 0600, a katalog 0700 (treść ekranu = treść komend)', () => {
    createRefusalDumper({ dataDir, version: '0.1.0', enabled: true, now: () => AT })(DUMP);
    expect(statSync(join(dir(), dumps()[0] ?? '')).mode & 0o777).toBe(0o600);
    expect(statSync(dir()).mode & 0o777).toBe(0o700);
  });

  it('brak ekranu i brak obu źródeł treści to nadal zrzut — „brak" jest informacją', () => {
    createRefusalDumper({ dataDir, version: '0.1.0', enabled: true, now: () => AT })({
      reason: 'send-failed', screen: null, hook: null, jsonl: null,
    });
    const body = readFileSync(join(dir(), dumps()[0] ?? ''), 'utf8');
    expect(body).toContain('hook: brak');
    expect(body).toContain('jsonl: brak');
    expect(body).toContain('toolName: brak');
    expect(body).toContain('(ekranu nie udało się przeczytać)');
  });

  it('nie wywraca się, gdy katalogu nie da się utworzyć', () => {
    // `dataDir` jako PLIK: `mkdir` rzuca ENOTDIR. Odmowa i tak ma dojść do człowieka.
    const busy = join(dataDir, 'plik');
    writeFileSync(busy, 'x');
    const dump = createRefusalDumper({ dataDir: busy, version: '0.1.0', enabled: true });
    expect(() => { dump(DUMP); }).not.toThrow();
  });
});

describe('wyłącznik RAROG_REFUSAL_DUMPS', () => {
  it('wyłączony zapisywacz nie tworzy nawet katalogu', () => {
    createRefusalDumper({ dataDir, version: '0.1.0', enabled: false, now: () => AT })(DUMP);
    expect(existsSync(dir())).toBe(false);
  });
});

describe('żniwiarz', () => {
  it('kasuje zrzuty starsze niż 48 h, młodsze zostawia', () => {
    putDump('stary.txt', REFUSAL_DUMP_TTL_MS + 60_000);
    putDump('swiezy.txt', 60_000);

    expect(sweepRefusalDumps(dataDir, () => AT)).toBe(1);
    expect(dumps()).toEqual(['swiezy.txt']);
  });

  it('trzyma sufit 200 plików, kasując NAJSTARSZE', () => {
    for (let i = 0; i < REFUSAL_DUMP_MAX_FILES + 5; i += 1) {
      putDump(`zrzut-${String(i).padStart(3, '0')}.txt`, (REFUSAL_DUMP_MAX_FILES + 5 - i) * 1000);
    }

    expect(sweepRefusalDumps(dataDir, () => AT)).toBe(5);
    const left = dumps();
    expect(left).toHaveLength(REFUSAL_DUMP_MAX_FILES);
    // Ginie pięć najstarszych (największy wiek = najniższy numer).
    expect(left).not.toContain('zrzut-000.txt');
    expect(left).toContain('zrzut-005.txt');
  });

  it('sufit działa też PRZY ZAPISIE — pętla odmów nie czeka na restart', () => {
    for (let i = 0; i < REFUSAL_DUMP_MAX_FILES; i += 1) {
      putDump(`zrzut-${String(i).padStart(3, '0')}.txt`, (REFUSAL_DUMP_MAX_FILES - i) * 1000);
    }
    createRefusalDumper({ dataDir, version: '0.1.0', enabled: true, now: () => AT })(DUMP);

    expect(dumps()).toHaveLength(REFUSAL_DUMP_MAX_FILES);
    expect(dumps()).not.toContain('zrzut-000.txt');
  });

  it('nie tyka plików spoza `.txt` i milczy bez katalogu', () => {
    expect(sweepRefusalDumps(dataDir, () => AT)).toBe(0);
    mkdirSync(dir(), { recursive: true, mode: 0o700 });
    const obcy = join(dir(), 'notatka.md');
    writeFileSync(obcy, 'nie mój plik');
    utimesSync(obcy, 0, 0);

    expect(sweepRefusalDumps(dataDir, () => AT)).toBe(0);
    expect(existsSync(obcy)).toBe(true);
  });
});

/*
 * A dump of a CLI dialog of registry class `dialog` (layer 2: picker, slash command view, model confirmation) lives
 * 14 days and at most 500 files, because it carries no tool input and grows the layer-2 corpus. Every other dump
 * (no class, `permission`, `sandbox`, …) keeps 48 h and 200 files: a consent dialog screen holds commands with their
 * values. Each cap holds on its own, so a burst of one kind never evicts the other.
 */
describe('layer-2 dialog dumps (class `dialog`)', () => {
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  const DIALOG_TTL_MS = 14 * DAY;
  const DIALOG_MAX_FILES = 500;

  /** Writes one dump through the dumper and returns its file name. */
  function writeDump(dump: RefusalDump): string {
    const before = new Set(dumps());
    createRefusalDumper({ dataDir, version: '0.1.0', enabled: true, now: () => AT })(dump);
    const added = dumps().filter((name) => !before.has(name));
    expect(added).toHaveLength(1);
    return added[0] ?? '';
  }

  /** Sets the age of a dump file (the sweeper counts age from `mtime`). */
  function age(name: string, ageMs: number): void {
    const seconds = (AT - ageMs) / 1000;
    utimesSync(join(dir(), name), seconds, seconds);
  }

  it('names a class `dialog` dump with the dialog marker, every other dump keeps `<ts>-<reason>.txt`', () => {
    const dialog = writeDump(LAYER2_DUMP);
    const permission = writeDump({ ...DUMP, reason: 'mismatch', cliDialog: 'permission' });
    const none = writeDump({ ...DUMP, reason: 'no-jsonl' });

    expect(REFUSAL_DUMP_DIALOG_SUFFIX).toBe('.dialog.txt');
    expect(dialog).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-unreadable\.dialog\.txt$/);
    expect(permission).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-mismatch\.txt$/);
    expect(none).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-no-jsonl\.txt$/);
    expect(readFileSync(join(dir(), dialog), 'utf8')).toContain('cliDialog: dialog');
  });

  it('keeps a class `dialog` dump older than 48 h and younger than 14 days, removes one older than 14 days', () => {
    const kept = writeDump(LAYER2_DUMP);
    age(kept, REFUSAL_DUMP_TTL_MS + 60_000);
    const nearLimit = `near${REFUSAL_DUMP_DIALOG_SUFFIX}`;
    putDump(nearLimit, DIALOG_TTL_MS - 60_000);
    const expired = `expired${REFUSAL_DUMP_DIALOG_SUFFIX}`;
    putDump(expired, DIALOG_TTL_MS + 60_000);

    expect(sweepRefusalDumps(dataDir, () => AT)).toBe(1);
    expect(dumps()).toEqual([kept, nearLimit].sort());
  });

  it('removes a dump without a class or of another class once older than 48 h', () => {
    const none = writeDump({ ...DUMP, reason: 'no-jsonl' });
    const permission = writeDump({ ...DUMP, reason: 'mismatch', cliDialog: 'permission' });
    const sandbox = writeDump({ ...DUMP, reason: 'screen-changed', cliDialog: 'sandbox' });
    for (const name of [none, permission, sandbox]) age(name, REFUSAL_DUMP_TTL_MS + 60_000);

    expect(sweepRefusalDumps(dataDir, () => AT)).toBe(3);
    expect(dumps()).toEqual([]);
  });

  it('caps class `dialog` dumps at 500, oldest first, without evicting other dumps', () => {
    // The other dumps are the OLDEST files in the directory: a shared cap would evict them first.
    for (let i = 0; i < 10; i += 1) putDump(`other-${String(i).padStart(3, '0')}.txt`, HOUR + i * 1000);
    for (let i = 0; i < DIALOG_MAX_FILES + 5; i += 1) {
      putDump(`dialog-${String(i).padStart(3, '0')}${REFUSAL_DUMP_DIALOG_SUFFIX}`, (DIALOG_MAX_FILES + 5 - i) * 1000);
    }

    expect(sweepRefusalDumps(dataDir, () => AT)).toBe(5);
    const left = dumps();
    expect(left.filter((name) => name.endsWith(REFUSAL_DUMP_DIALOG_SUFFIX))).toHaveLength(DIALOG_MAX_FILES);
    expect(left).not.toContain(`dialog-000${REFUSAL_DUMP_DIALOG_SUFFIX}`);
    expect(left).toContain(`dialog-005${REFUSAL_DUMP_DIALOG_SUFFIX}`);
    expect(left.filter((name) => name.startsWith('other-'))).toHaveLength(10);
  });

  it('caps the other dumps at 200, oldest first, without touching class `dialog` dumps', () => {
    for (let i = 0; i < 10; i += 1) putDump(`dialog-${String(i)}${REFUSAL_DUMP_DIALOG_SUFFIX}`, HOUR + i * 1000);
    for (let i = 0; i < REFUSAL_DUMP_MAX_FILES + 5; i += 1) {
      putDump(`other-${String(i).padStart(3, '0')}.txt`, (REFUSAL_DUMP_MAX_FILES + 5 - i) * 1000);
    }

    expect(REFUSAL_DUMP_MAX_FILES).toBe(200);
    expect(sweepRefusalDumps(dataDir, () => AT)).toBe(5);
    const left = dumps();
    expect(left.filter((name) => name.startsWith('other-'))).toHaveLength(REFUSAL_DUMP_MAX_FILES);
    expect(left).not.toContain('other-000.txt');
    expect(left).toContain('other-005.txt');
    expect(left.filter((name) => name.endsWith(REFUSAL_DUMP_DIALOG_SUFFIX))).toHaveLength(10);
  });

  it('holds the dialog cap on write too, and a dialog write does not evict other dumps', () => {
    for (let i = 0; i < 3; i += 1) putDump(`other-${String(i)}.txt`, DAY + i * 1000);
    for (let i = 0; i < DIALOG_MAX_FILES; i += 1) {
      putDump(`dialog-${String(i).padStart(3, '0')}${REFUSAL_DUMP_DIALOG_SUFFIX}`, (DIALOG_MAX_FILES - i) * 1000);
    }
    writeDump(LAYER2_DUMP);

    const left = dumps();
    expect(left.filter((name) => name.endsWith(REFUSAL_DUMP_DIALOG_SUFFIX))).toHaveLength(DIALOG_MAX_FILES);
    expect(left).not.toContain(`dialog-000${REFUSAL_DUMP_DIALOG_SUFFIX}`);
    expect(left.filter((name) => name.startsWith('other-'))).toHaveLength(3);
  });

  it('writes a class `dialog` dump as 0600 in a 0700 directory', () => {
    const name = writeDump(LAYER2_DUMP);
    expect(statSync(join(dir(), name)).mode & 0o777).toBe(0o600);
    expect(statSync(dir()).mode & 0o777).toBe(0o700);
    expect(readdirSync(dir()).filter((entry) => entry.includes('.tmp'))).toEqual([]);
  });

  it('writes nothing for a class `dialog` dump with RAROG_REFUSAL_DUMPS=0', () => {
    createRefusalDumper({ dataDir, version: '0.1.0', enabled: false, now: () => AT })(LAYER2_DUMP);
    expect(existsSync(dir())).toBe(false);
  });

  it('sweeps a `.txt` dump without the marker after 48 h even when its header says class `dialog`', () => {
    // The name decides, not the header: a class `dialog` dump named `<ts>-<reason>.txt` gets 48 h, so none is orphaned.
    const old = '2026-11-01T10-00-00-000Z-unreadable.txt';
    putDump(old, REFUSAL_DUMP_TTL_MS + 60_000);
    writeFileSync(join(dir(), old), 'rarog: 0.1.0\nreason: unreadable\ncliDialog: dialog\n--- ekran ---\n/model\n');
    age(old, REFUSAL_DUMP_TTL_MS + 60_000);
    const young = '2026-11-02T10-00-00-000Z-unreadable.txt';
    putDump(young, HOUR);

    expect(sweepRefusalDumps(dataDir, () => AT)).toBe(1);
    expect(dumps()).toEqual([young]);
  });
});

/*
 * The registry class alone does not earn the 14 days: it can say `dialog` while the last screen read still shows a
 * consent dialog and the card is still a tool's. The dump must show no trace of a consent; anything else keeps 48 h.
 */
describe('the layer-2 retention needs a dump without any consent trace', () => {
  /** Writes one dump at its own time (distinct names) and returns the file name. */
  function nameOf(dump: RefusalDump, at: number = AT): string {
    const before = new Set(dumps());
    createRefusalDumper({ dataDir, version: '0.1.0', enabled: true, now: () => AT })({ ...dump, at });
    const added = dumps().filter((name) => !before.has(name));
    expect(added).toHaveLength(1);
    return added[0] ?? '';
  }

  const isDialog = (name: string): boolean => name.endsWith(REFUSAL_DUMP_DIALOG_SUFFIX);

  it('a genuine layer-2 screen with no tool, or with a screen card tool name, is `.dialog.txt`', () => {
    const picker = screenOf('kontrolny/picker-model-klucz-api-2.1.322.txt');
    expect(isDialog(nameOf(LAYER2_DUMP, AT))).toBe(true);
    expect(isDialog(nameOf({ ...LAYER2_DUMP, screen: picker }, AT + 1))).toBe(true);
    expect(isDialog(nameOf({ ...LAYER2_DUMP, toolName: 'dialog:layer2' }, AT + 2))).toBe(true);
    expect(isDialog(nameOf({ ...LAYER2_DUMP, toolName: 'dialog:confirm' }, AT + 3))).toBe(true);
    expect(isDialog(nameOf({ ...LAYER2_DUMP, shape: { source: 'screen', optionCount: 0 } }, AT + 4))).toBe(true);
  });

  it('class `dialog` with a tool name of a tool card is plain `.txt`', () => {
    expect(isDialog(nameOf({ ...LAYER2_DUMP, toolName: 'Bash' }))).toBe(false);
  });

  it('class `dialog` with a hook dump, a jsonl entry or tool identifiers in the shape is plain `.txt`', () => {
    const hook = { toolName: 'Bash', at: AT - 1000, hookEventName: 'PermissionRequest' };
    expect(isDialog(nameOf({ ...LAYER2_DUMP, hook }, AT))).toBe(false);
    expect(isDialog(nameOf({ ...LAYER2_DUMP, jsonl: { id: 'toolu_01', toolName: 'Bash' } }, AT + 1))).toBe(false);
    expect(isDialog(nameOf({ ...LAYER2_DUMP, shape: { source: 'jsonl' } }, AT + 2))).toBe(false);
    expect(isDialog(nameOf({ ...LAYER2_DUMP, shape: { toolUseId: 'toolu_01' } }, AT + 3))).toBe(false);
    expect(isDialog(nameOf({ ...LAYER2_DUMP, shape: { promptId: 'p-1' } }, AT + 4))).toBe(false);
  });

  it('class `dialog` without a screen is plain `.txt`', () => {
    expect(isDialog(nameOf({ ...LAYER2_DUMP, screen: null }))).toBe(false);
  });

  it.each([
    ['a `Bash` consent', 'dialog-permission.txt'],
    ['a `Bash` consent cut at the top', 'dialog-bash-uciety-naglowek-2.1.294.txt'],
    ['an `Edit` consent', 'measured/zgoda-edit-2.1.322.txt'],
    ['a `WebFetch` consent', 'measured/zgoda-webfetch-2.1.322.txt'],
    ['the sandbox network request', 'kontrolny/zgoda-siec-2.1.322.txt'],
    ['a workflow approval', 'kontrolny/zatwierdzenie-workflow-auto-bez-kontroli-2.1.322.txt'],
    ['a question form', 'dialog-askuserquestion.txt'],
    ['the answer review of a question form', 'dialog-askuserquestion-multiq-review.txt'],
  ])('class `dialog` with %s on screen is plain `.txt`', (_label, file) => {
    expect(isDialog(nameOf({ ...LAYER2_DUMP, screen: screenOf(file) }))).toBe(false);
  });

  it('control set: every consent and question screen is plain `.txt`, every class `dialog` screen `.dialog.txt`', () => {
    interface Shape { id: string; file: string; waitingFor: { value: string | null } | null }
    const manifest = JSON.parse(readFileSync(join(FIXTURES, 'kontrolny', 'manifest.json'), 'utf8')) as {
      shapes: Shape[];
    };
    const classOf: Readonly<Record<string, 'consent' | 'dialog'>> = {
      'permission prompt': 'consent', 'sandbox request': 'consent', 'input needed': 'consent', 'dialog open': 'dialog',
    };
    const seen = { consent: 0, dialog: 0 };
    for (const [index, shape] of manifest.shapes.entries()) {
      const kind = classOf[shape.waitingFor?.value ?? ''];
      if (kind === undefined) continue;
      seen[kind] += 1;
      const name = nameOf({ ...LAYER2_DUMP, screen: screenOf(shape.file) }, AT + index);
      expect(isDialog(name), `${shape.id} (${kind})`).toBe(kind === 'dialog');
    }
    expect(seen.consent).toBeGreaterThan(20);
    expect(seen.dialog).toBeGreaterThan(20);
  });
});
