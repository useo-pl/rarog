/**
 * Dialog zaufania folderu bez cyfr: parser, dowód przed klawiszem i strażnik ścieżki `down`/`enter`.
 *
 * Fixture'y z pomiaru na CLI 2.1.319: `kontrolny/zaufanie-2.1.319.txt` (`❯` na „No, exit”) i
 * `kontrolny/zaufanie-po-down-2.1.319.txt` (ten sam dialog po `down`, `❯` na „Yes, I trust this folder”). Sekwencję
 * w driverze sprawdza `herdr-driver.test.ts` (sekwencja zatwierdzenia zaufania), gniazdo metody klienta
 * `herdr-client.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveOptions } from '../src/herdr/dialogs/screen/resolve.ts';
import { parseOptions } from '../src/herdr/dialogs/screen/parse.ts';
import { parseTrustArrowDialog, trustFolderIs } from '../src/herdr/dialogs/screen/trust-arrow.ts';
import { ALLOWED_KEYS } from '../src/herdr/dialogs/send/keys.ts';
import {
  TRUST_DOWN_KEY, TRUST_ENTER_KEY, TRUST_STEP_KEYS, assertTrustStepKeys, nextTrustStep,
} from '../src/herdr/dialogs/send/trust-step.ts';
import type { TrustStepExpectation } from '../src/herdr/dialogs/send/trust-step.ts';
import { scan, tsFiles } from './source-scan.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'herdr');
const BEFORE = readFileSync(join(FIXTURES, 'kontrolny', 'zaufanie-2.1.319.txt'), 'utf8');
const AFTER_DOWN = readFileSync(join(FIXTURES, 'kontrolny', 'zaufanie-po-down-2.1.319.txt'), 'utf8');
const FOLDER = '/Users/u/projekt';
const OTHER = (text: string): string => text.replace(FOLDER, '/Users/u/inny');

describe('parser dialogu zaufania bez cyfr', () => {
  it('fixture przed `down`: folder, `❯` na „No”, etykieta zgody', () => {
    expect(parseTrustArrowDialog(BEFORE)).toMatchObject({
      folder: FOLDER, cursor: 'no', yesLabel: 'Yes, I trust this folder',
    });
  });

  it('fixture po `down`: ten sam folder i ten sam odcisk, `❯` na „Yes”', () => {
    const before = parseTrustArrowDialog(BEFORE);
    const after = parseTrustArrowDialog(AFTER_DOWN);
    expect(after).toMatchObject({ folder: FOLDER, cursor: 'yes' });
    expect(after?.bodyPrint).toBe(before?.bodyPrint);
    expect(after?.bodyPrint).toMatch(/^[0-9a-f]{16}$/);
  });

  it('podmiana folderu zmienia odcisk', () => {
    expect(parseTrustArrowDialog(OTHER(BEFORE))?.bodyPrint).not.toBe(parseTrustArrowDialog(BEFORE)?.bodyPrint);
  });

  it('parser cyfr tego ekranu nie czyta, a rozpoznanie daje `trust` bez fikcyjnych cyfr', () => {
    expect(parseOptions(BEFORE)).toBeNull();
    const resolved = resolveOptions(BEFORE, null);
    expect(resolved).toMatchObject({
      status: 'no-jsonl', knownDialog: 'trust', options: [], questionForm: null,
      dialogIdentity: { kind: 'confirm', identity: { kind: 'known', id: 'trust' } },
    });
  });

  it('starsze brzmienie zgody „Yes, proceed” też jest rozpoznane', () => {
    const older = BEFORE.replace('Yes, I trust this folder', 'Yes, proceed');
    expect(parseTrustArrowDialog(older)).toMatchObject({ yesLabel: 'Yes, proceed', cursor: 'no' });
  });

  it.each([
    ['trzy opcje', BEFORE.replace('   Yes, I trust this folder\n', '   Yes, I trust this folder\n   Maybe\n')],
    ['bez stopki (ucięty dół)', BEFORE.replace('\n Enter to confirm · Esc to cancel', '')],
    ['bez kreski i tytułu (ucięta góra)', BEFORE.slice(BEFORE.indexOf(' /Users/u/projekt'))],
    ['dwa znaczniki `❯`', BEFORE.replace('   Yes, I trust', ' ❯ Yes, I trust')],
    ['bez znacznika `❯`', BEFORE.replace(' ❯ No, exit', '   No, exit')],
    ['odwrotna kolejność opcji', BEFORE.replace(' ❯ No, exit\n   Yes, I trust this folder', ' ❯ Yes, I trust this folder\n   No, exit')],
    ['etykieta z cyfrą', BEFORE.replace(' ❯ No, exit', ' ❯ 1. No, exit')],
    ['inna etykieta zgody', BEFORE.replace('Yes, I trust this folder', 'Yes, and allow everything')],
    ['bez zdania zaufania w treści', BEFORE.replace('Is this a project you created or one you trust?', 'Hello')],
    ['folder bez ścieżki', BEFORE.replace(FOLDER, 'projekt')],
  ])('%s → `null` (karta bez przycisku)', (_, screen) => {
    expect(parseTrustArrowDialog(screen)).toBeNull();
  });

  /*
   * Dodatkowa pozycja listy poza parą opcji, także oddzielona pustą linią: znacznik `❯` w treści bloku, linia
   * z wcięciem kolumny kursora albo z etykietą opcji, opcja bez wcięcia kolumny kursora.
   */
  const GUIDE = ' Security guide';
  const YES_LINE = '   Yes, I trust this folder\n';
  it.each([
    ['`❯` nad parą za pustą linią (przed `down`)', BEFORE.replace(GUIDE, ` ❯ Other choice\n\n${GUIDE}`)],
    ['`❯` nad parą za pustą linią (po `down`)', AFTER_DOWN.replace(GUIDE, ` ❯ Other choice\n\n${GUIDE}`)],
    ['`❯` w zdaniu treści', BEFORE.replace(" Claude Code'll", " ❯ Claude Code'll")],
    ['trzecia opcja nad parą za pustą linią, „No” bez wcięcia (po `down`)',
      AFTER_DOWN.replace('No, exit', 'Maybe later\n\nNo, exit')],
    ['trzecia opcja nad parą za pustą linią (przed `down`)',
      BEFORE.replace(' ❯ No, exit', '   Maybe later\n\n ❯ No, exit')],
    ['trzecia opcja pod parą za pustą linią', BEFORE.replace(YES_LINE, `${YES_LINE}\n   Maybe later\n`)],
    ['linia z wcięciem kolumny kursora w treści', BEFORE.replace(GUIDE, '   Maybe later')],
    ['etykieta opcji w treści', BEFORE.replace(GUIDE, ' Yes, I trust this folder')],
    ['opcja z cyfrą w treści', BEFORE.replace(GUIDE, ' 1. Maybe later')],
    ['opcja bez wcięcia kolumny kursora', AFTER_DOWN.replace('   No, exit', 'No, exit')],
  ])('dodatkowa pozycja poza parą: %s → `null`', (_, screen) => {
    expect(parseTrustArrowDialog(screen)).toBeNull();
  });

  it('folder ze spacją w jednej linii: znaki nazwy zostają, ucięty jest tylko margines CLI', () => {
    const spaced = BEFORE.replace(FOLDER, '/Users/u/My project');
    expect(parseTrustArrowDialog(spaced)?.folder).toBe('/Users/u/My project');
    expect(parseTrustArrowDialog(BEFORE.replace(` ${FOLDER}`, `  ${FOLDER}`))).toBeNull();
  });

  /*
   * Zawinięcie chowa spację na granicy linii (zdanie treści tego bloku: „…open source project, or” / „work from…”),
   * więc „/Users/u/My” + „project” to równie dobrze „/Users/u/Myproject”, jak „/Users/u/My project”. Folder w więcej
   * niż jednej linii daje `null`: kartę bez przycisku, odpowiedź w terminalu.
   */
  it.each([
    ['zawinięcie na spacji w nazwie', ' /Users/u/My \n project\n'],
    ['zawinięcie bez widocznej spacji', ' /Users/u/My\n project\n'],
    ['zawinięcie w środku słowa', ' /Users/u/pro\n jekt\n'],
  ])('folder zawinięty przez wąski panel (%s) → `null`', (_, folderLines) => {
    expect(parseTrustArrowDialog(BEFORE.replace(` ${FOLDER}\n`, folderLines))).toBeNull();
    expect(parseTrustArrowDialog(AFTER_DOWN.replace(` ${FOLDER}\n`, folderLines))).toBeNull();
  });
});

/** Prawdziwe rendery bez cyfr z korpusu: każdy dalej rozpoznany, z folderem i kursorem z ekranu. */
describe('korpus: dialog zaufania bez cyfr na CLI 2.1.293, 2.1.311, 2.1.314, 2.1.316 i 2.1.319', () => {
  const screenOf = (name: string): string => {
    const text = readFileSync(join(FIXTURES, name), 'utf8');
    const mark = '\n--- ekran ---\n';
    return text.includes(mark) ? text.slice(text.indexOf(mark) + mark.length) : text;
  };

  it.each([
    ['dialog-trust-2.1.293.txt', FOLDER, 'no'],
    ['refusals/zaufanie-bez-cyfr-2.1.311.txt', '~/Projects/strona', 'no'],
    ['kontrolny/zaufanie-2.1.314.txt', FOLDER, 'no'],
    ['kontrolny/zaufanie-2.1.316.txt', FOLDER, 'no'],
    ['kontrolny/zaufanie-2.1.319.txt', FOLDER, 'no'],
    ['kontrolny/zaufanie-po-down-2.1.319.txt', FOLDER, 'yes'],
  ])('%s: folder %s, `❯` na „%s”', (name, folder, cursor) => {
    expect(parseTrustArrowDialog(screenOf(name)))
      .toMatchObject({ folder, cursor, yesLabel: 'Yes, I trust this folder' });
  });

  it('dialog zaufania z cyframi (`dialog-trust.txt`) nie jest dialogiem bez cyfr', () => {
    expect(parseTrustArrowDialog(screenOf('dialog-trust.txt'))).toBeNull();
  });
});

/*
 * A folder whose settings pre-approve tool permissions adds a warning paragraph to the block (Claude Code 2.1.332):
 * the line "⚠ This folder pre-approves …:", the permission list, whose first line has a three-space margin (the
 * shape of an option line), and "These will apply without asking. …". Only inside that paragraph may a line carry
 * the three-space margin.
 */
describe('trust dialog with the pre-approved permissions warning (CLI 2.1.332)', () => {
  const WARNED = readFileSync(join(FIXTURES, 'dialog-trust-preapproved-2.1.332.txt'), 'utf8');
  const WARNED_AFTER_DOWN = WARNED.replace(' ❯ No, exit\n   Yes, I trust', '   No, exit\n ❯ Yes, I trust');
  const LIST = '   Bash(pnpm run build *)';
  const CLOSER = ' These will apply without asking.';

  it('is recognized as the trust dialog, with the folder and the cursor from the screen', () => {
    expect(parseTrustArrowDialog(WARNED))
      .toMatchObject({ folder: FOLDER, cursor: 'no', yesLabel: 'Yes, I trust this folder' });
    expect(resolveOptions(WARNED, null)).toMatchObject({
      status: 'no-jsonl', knownDialog: 'trust', options: [],
      dialogIdentity: { kind: 'confirm', identity: { kind: 'known', id: 'trust' } },
    });
  });

  it('has the same fingerprint before and after `down`, and another one for another permission list', () => {
    const before = parseTrustArrowDialog(WARNED);
    expect(parseTrustArrowDialog(WARNED_AFTER_DOWN)).toMatchObject({ cursor: 'yes', bodyPrint: before?.bodyPrint });
    const otherList = parseTrustArrowDialog(WARNED.replace('Bash(pnpm install *)', 'Bash(pnpm publish *)'));
    expect(otherList?.bodyPrint).toMatch(/^[0-9a-f]{16}$/);
    expect(otherList?.bodyPrint).not.toBe(before?.bodyPrint);
    expect(before?.bodyPrint).not.toBe(parseTrustArrowDialog(BEFORE)?.bodyPrint);
  });

  it('is recognized with the opening line wrapped by a narrower pane', () => {
    const wrapped = (text: string): string => text.replace(
      '.claude/settings.json and .claude/settings.local.json:\n   Bash',
      '.claude/settings.json and\n .claude/settings.local.json:\n   Bash',
    );
    expect(wrapped(WARNED)).not.toBe(WARNED);
    const before = parseTrustArrowDialog(wrapped(WARNED));
    expect(before).toMatchObject({ folder: FOLDER, cursor: 'no' });
    expect(parseTrustArrowDialog(wrapped(WARNED_AFTER_DOWN))).toMatchObject({ cursor: 'yes', bodyPrint: before?.bodyPrint });
  });

  it('gets `down`, then `enter`, with the proof of the card', () => {
    const expected: TrustStepExpectation = {
      bodyPrint: parseTrustArrowDialog(WARNED)?.bodyPrint ?? '', folder: FOLDER, cwd: FOLDER, home: '/Users/u', allowDown: true,
    };
    expect(nextTrustStep(WARNED, expected)).toMatchObject({ ok: true, key: 'down' });
    expect(nextTrustStep(WARNED_AFTER_DOWN, { ...expected, allowDown: false })).toMatchObject({ ok: true, key: 'enter' });
  });

  it.each([
    ['a three-space line under the warning paragraph', WARNED.replace(' Security guide', '   Maybe later')],
    ['a three-space line above the warning paragraph', WARNED.replace(" Claude Code'll", "   Claude Code'll")],
    ['a three-space line past the closing sentence', WARNED.replace(CLOSER, `${CLOSER}\n   Maybe later`)],
    ['an option label as a permission list line', WARNED.replace(LIST, `   Yes, I trust this folder\n${LIST}`)],
    ['a numbered option as a permission list line', WARNED.replace(LIST, `   1. Yes\n${LIST}`)],
    ['`❯` in the permission list', WARNED.replace(LIST, ' ❯ Bash(pnpm run build *)')],
    ['a blank line inside the warning paragraph', WARNED.replace(LIST, `\n${LIST}`)],
    ['no closing sentence', WARNED.replace(/ These will apply without asking\..*\n/, '')],
    ['the permission list without the opening line', WARNED.replace(/ ⚠ This folder pre-approves.*\n/, '')],
  ])('%s → `null` (a card without a button)', (_, screen) => {
    expect(screen).not.toBe(WARNED);
    expect(parseTrustArrowDialog(screen)).toBeNull();
    expect(parseTrustArrowDialog(screen.replace(' ❯ No, exit\n   Yes, I trust', '   No, exit\n ❯ Yes, I trust'))).toBeNull();
  });
});

describe('`trustFolderIs`: folder z dialogu wobec `cwd` sesji', () => {
  it.each([
    ['/Users/u/projekt', '/Users/u/projekt', true],
    ['~/projekt', '/Users/u/projekt', true],
    ['~', '/Users/u', true],
    ['/Users/u/projekt', '/Users/u/projekt-2', false],
    ['~/projekt', '/Users/x/projekt', false],
    ['projekt', 'projekt', false],
  ])('%s wobec %s → %s', (folder, cwd, expected) => {
    expect(trustFolderIs(folder, cwd, '/Users/u')).toBe(expected);
  });
});

describe('`nextTrustStep`: dowód ze świeżego ekranu przed klawiszem', () => {
  const print = parseTrustArrowDialog(BEFORE)?.bodyPrint ?? '';
  const expected: TrustStepExpectation = { bodyPrint: print, folder: FOLDER, cwd: FOLDER, home: '/Users/u', allowDown: true };

  it('`❯` na „No” → `down`', () => {
    expect(nextTrustStep(BEFORE, expected)).toMatchObject({ ok: true, key: 'down' });
  });

  it('`❯` na „Yes” → `enter` (także przy ponownym tapnięciu po samym `down`)', () => {
    expect(nextTrustStep(AFTER_DOWN, expected)).toMatchObject({ ok: true, key: 'enter' });
  });

  it('po wysłanym `down` `❯` dalej na „No” → odmowa, drugiego `down` nie ma', () => {
    expect(nextTrustStep(BEFORE, { ...expected, allowDown: false })).toEqual({ ok: false, reason: 'cursor' });
  });

  it('podmiana folderu przy identycznych etykietach → odmowa przed `down` i po nim', () => {
    expect(nextTrustStep(OTHER(BEFORE), expected).ok).toBe(false);
    expect(nextTrustStep(OTHER(AFTER_DOWN), { ...expected, allowDown: false }).ok).toBe(false);
  });

  it('folder inny niż `cwd` sesji → `folder`', () => {
    expect(nextTrustStep(BEFORE, { ...expected, cwd: '/Users/u/inny' })).toEqual({ ok: false, reason: 'folder' });
  });

  it('dialog zniknął albo ekran nieczytelny → `not-trust`', () => {
    expect(nextTrustStep('❯ \n', expected)).toEqual({ ok: false, reason: 'not-trust' });
    expect(nextTrustStep(null, expected)).toEqual({ ok: false, reason: 'not-trust' });
  });

  it('dodatkowy `❯` albo trzecia opcja za pustą linią → bez `down` i bez `enter`', () => {
    const extraCursor = (text: string): string => text.replace(' Security guide', ' ❯ Other choice\n\n Security guide');
    const thirdOption = AFTER_DOWN.replace('No, exit', 'Maybe later\n\nNo, exit');
    for (const screen of [extraCursor(BEFORE), extraCursor(AFTER_DOWN), thirdOption]) {
      expect(nextTrustStep(screen, expected)).toEqual({ ok: false, reason: 'not-trust' });
      expect(nextTrustStep(screen, { ...expected, allowDown: false })).toEqual({ ok: false, reason: 'not-trust' });
    }
  });

  /*
   * Zawinięty folder rozpoznania nie dostaje (bezpieczna odmowa zamiast zgadywania spacji): ani `cwd` bez spacji,
   * ani `cwd` ze spacją nie dostaje klawisza. Odcisk i folder karty są z tego samego ekranu, jak przy wystawieniu
   * karty w driverze; bez rozpoznania karta nie ma czego nieść, a odmowa jest ta sama.
   */
  it('folder zawinięty na spacji: `cwd` bez spacji i `cwd` ze spacją → bez klawisza', () => {
    for (const screen of [BEFORE, AFTER_DOWN]) {
      const wrapped = screen.replace(` ${FOLDER}\n`, ' /Users/u/My \n project\n');
      const card = parseTrustArrowDialog(wrapped);
      for (const cwd of ['/Users/u/Myproject', '/Users/u/My project']) {
        const proof = { ...expected, bodyPrint: card?.bodyPrint ?? print, folder: card?.folder ?? cwd, cwd };
        expect(nextTrustStep(wrapped, proof)).toEqual({ ok: false, reason: 'not-trust' });
        expect(nextTrustStep(wrapped, { ...proof, allowDown: false })).toEqual({ ok: false, reason: 'not-trust' });
      }
    }
  });

  it('folder ze spacją w jednej linii: zgodny `cwd` → klawisz, `cwd` bez tej spacji → `folder`', () => {
    const spaced = (text: string): string => text.replace(FOLDER, '/Users/u/My project');
    const spacedPrint = parseTrustArrowDialog(spaced(BEFORE))?.bodyPrint ?? '';
    const same = { ...expected, bodyPrint: spacedPrint, folder: '/Users/u/My project', cwd: '/Users/u/My project' };
    expect(nextTrustStep(spaced(BEFORE), same)).toMatchObject({ ok: true, key: 'down' });
    expect(nextTrustStep(spaced(AFTER_DOWN), { ...same, allowDown: false })).toMatchObject({ ok: true, key: 'enter' });
    expect(nextTrustStep(spaced(AFTER_DOWN), { ...same, cwd: '/Users/u/Myproject', allowDown: false }))
      .toEqual({ ok: false, reason: 'folder' });
  });
});

describe('asercja klawiszy ścieżki zaufania', () => {
  it('przepuszcza dokładnie jeden klawisz: `down` albo `enter`', () => {
    expect(TRUST_STEP_KEYS).toEqual(['down', 'enter']);
    expect(() => { assertTrustStepKeys([TRUST_DOWN_KEY]); }).not.toThrow();
    expect(() => { assertTrustStepKeys([TRUST_ENTER_KEY]); }).not.toThrow();
  });

  it.each([[[]], [['down', 'enter']], [['escape']], [['up']], [['2']], [['enter', 'enter']]])(
    '%j → wyjątek', (keys) => {
      expect(() => { assertTrustStepKeys(keys); }).toThrow();
    },
  );

  it('`ALLOWED_KEYS` bez `down`, `enter` i `up`', () => {
    for (const key of ['down', 'enter', 'up']) expect(ALLOWED_KEYS.has(key)).toBe(false);
  });
});

/*
 * Strażnik: `down` i `enter` tej ścieżki nie występują w żadnej innej ścieżce wysyłki. Literał `'down'` stoi w kodzie
 * serwera tylko w `trust-step.ts` (poza kierunkiem przewijania terminala, który nie jest klawiszem), `'enter'` tylko
 * tam, w `form-submit.ts` (osobna ścieżka formularza) i w `prompt-submit.ts` (wysyłka w trakcie tury; jej
 * strażnik: `send-during-turn.test.ts`). Metodę klienta woła wyłącznie ścieżka zatwierdzenia
 * w driverze, a stałe klawiszy biorą tylko driver i klient.
 *
 * Layer 2 verdict (`layer2/verdict.ts`) names `down` and `enter` too: the `DialogKey` type and the map from a footer
 * segment to a card choice. It sends nothing; the send path for those keys stays in `send/`. The key row of a layer 2
 * card (`send/key-row.ts`) is that path: its own closed list, its own assertion of one key per call and its own
 * client method (`sendDialogKey`, guarded in `key-row.test.ts`); `ALLOWED_KEYS` still has neither key. The queue
 * take-back (`send/take-back-keys.ts`) names `down` as one of its own three keys, with its own assertion and client
 * method (`sendTakeBackKey`, guarded in `take-back-keys.test.ts`).
 */
describe('strażnik ścieżki `down`/`enter` dialogu zaufania', () => {
  const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const files = tsFiles(join(REPO, 'server/src')).map((file) => ({
    file: relative(REPO, file), source: readFileSync(file, 'utf8'),
  }));
  const literalIn = (text: string): string[] => files
    .filter(({ source }) => scan(source).literals.some((literal) => literal.text === text))
    .map(({ file }) => file);
  const codeLines = (source: string): string[] => source.split('\n')
    .filter((line) => !/^\s*(?:\*|\/\/|\/\*)/.test(line));
  const usedIn = (pattern: RegExp): string[] => files
    .filter(({ source }) => codeLines(source).some((line) => pattern.test(line)))
    .map(({ file }) => file);

  it('literał `down` tylko w `trust-step.ts` (i w kierunku przewijania terminala)', () => {
    expect(literalIn('down').sort()).toEqual([
      'server/src/herdr/dialogs/layer2/verdict.ts',
      'server/src/herdr/dialogs/send/key-row.ts',
      'server/src/herdr/dialogs/send/take-back-keys.ts',
      'server/src/herdr/dialogs/send/trust-step.ts',
      'server/src/term/herdr-backend.ts',
    ]);
    const scroll = files.find(({ file }) => file === 'server/src/term/herdr-backend.ts')?.source ?? '';
    expect(codeLines(scroll).filter((line) => line.includes("'down'"))).toEqual([
      "          direction: lines < 0 ? 'up' : 'down',",
    ]);
  });

  it('literał `enter` tylko w `trust-step.ts`, `form-submit.ts` i `prompt-submit.ts`', () => {
    expect(literalIn('enter').sort()).toEqual([
      'server/src/herdr/dialogs/layer2/verdict.ts',
      'server/src/herdr/dialogs/send/form-submit.ts',
      'server/src/herdr/dialogs/send/key-row.ts',
      'server/src/herdr/dialogs/send/prompt-submit.ts',
      'server/src/herdr/dialogs/send/trust-step.ts',
    ]);
  });

  it('`sendTrustStep` woła tylko driver (ścieżka zatwierdzenia), a definiuje klient', () => {
    // The answer recheck wraps the client a driver gets: one line passes the driver's call on as it came
    // (`herdr-answer-recheck.test.ts`), so it is not a second sender.
    const recheck = 'server/src/herdr/answer-recheck.ts';
    expect(usedIn(/\.sendTrustStep\(/).sort()).toEqual(['server/src/drivers/herdr-driver.ts', recheck]);
    const driver = files.find(({ file }) => file === 'server/src/drivers/herdr-driver.ts')?.source ?? '';
    expect(codeLines(driver).filter((line) => line.includes('.sendTrustStep('))).toHaveLength(2);
    const wrapper = files.find(({ file }) => file === recheck)?.source ?? '';
    expect(codeLines(wrapper).filter((line) => line.includes('.sendTrustStep('))).toHaveLength(1);
    // A definition, not a call through a receiver: the calls are counted above.
    expect(usedIn(/(?<!\.)sendTrustStep\(paneId/).sort())
      .toEqual(['server/src/herdr/client.ts', 'server/src/herdr/types.ts']);
  });

  it('stałe klawiszy i asercję biorą tylko driver i klient', () => {
    expect(usedIn(/\bTRUST_(?:DOWN|ENTER)_KEY\b|\bassertTrustStepKeys\b|\bTRUST_STEP_KEYS\b/).sort()).toEqual([
      'server/src/drivers/herdr-driver.ts',
      'server/src/herdr/client.ts',
      'server/src/herdr/dialogs/send/trust-step.ts',
    ]);
  });
});
