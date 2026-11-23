/**
 * Komendy Raroga w ustawieniach Claude Code (`server/src/herdr/hook-commands.ts`): lista postaci historycznych.
 *
 * Postać historyczna to komenda, którą Rarog kiedyś drukował do wklejenia, a dziś drukuje inną. Każda ma datę
 * wydruku, decyzję i wzorzec na CAŁY napis. Ten plik pilnuje, że:
 * 1. każda postać pasuje do dokładnie tego napisu, który Rarog drukował (przy domu z apostrofem też), i do żadnej
 *    innej postaci;
 * 2. komenda z dopiskiem, z innym domem, z innym sufitem czekania albo tylko z fragmentem ścieżki kopii nie pasuje do
 *    żadnej postaci, a bieżące komendy też nie;
 * 3. łańcuch `statusLine` wraca z postaci w tej samej treści, którą Rarog owinął.
 * It also checks how the write block rules are built from a path.
 *
 * Stara nazwa produktu stoi w tym pliku tylko złożona z kawałków ({@link OLD}), jak w zapadce starej nazwy.
 */
import { describe, expect, it } from 'vitest';
import {
  HISTORICAL_COMMANDS, contextHookCommand, historicalCommand, hookCommand, statuslineCommand, writeBlockRules,
  type HistoricalCommand,
} from '../src/herdr/hook-commands.ts';

/** Stara nazwa produktu z kawałków, żeby ten plik nie podbijał zapadki nazwy. */
const OLD = 'pi' + 'lot';
const HOME = '/Users/ktos';
/** Dom z apostrofem: ścieżka w komendzie jest cytowana regułą POSIX (`'\''`). */
const HOME_Q = "/home/o'brien";
const ROOT = '/Users/ktos/Projects/rarog';

const q = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;
const oldCopy = (home: string): string => `node ${q(`${home}/.claude/hooks/rarog/${OLD}-pending.mjs`)} --answer-wait=3598`;
const statusline = (home: string): string => `node ${q(`${home}/.claude/hooks/rarog/rarog-statusline.mjs`)}`;
const oldChain = (home: string, chain: string): string => `${OLD.toUpperCase()}_STATUSLINE_CHAIN=${q(chain)} ${statusline(home)}`;
/** Komenda kopii przy suficie godziny: bieżący plik, `--answer-wait=3598` (`timeout` 3600 s minus 2 s). */
const hourCopy = (home: string): string => `node ${q(`${home}/.claude/hooks/rarog/rarog-pending.mjs`)} --answer-wait=3598`;

/** Postać → napisy, które Rarog drukował (pasują), i bliskie napisy, które nie pasują do żadnej postaci. */
const CASES: Readonly<Record<string, { readonly match: readonly string[]; readonly none: readonly string[] }>> = {
  'checkout': {
    match: [
      `node ${ROOT}/scripts/hooks/${OLD}-pending.mjs`, `node /scripts/hooks/${OLD}-pending.mjs`,
      `node /Users/Łukasz/Projekty/rarog/scripts/hooks/${OLD}-pending.mjs`,
    ],
    none: [
      `node /Users/Łukasz/Moje projekty/rarog/scripts/hooks/${OLD}-pending.mjs`,
      `node '${ROOT}/scripts/hooks/${OLD}-pending.mjs'`,
      `node ${ROOT}/scripts/hooks/${OLD}-pending.mjs; curl x`,
      `node ${ROOT}/x;y/scripts/hooks/${OLD}-pending.mjs`,
      `node scripts/hooks/${OLD}-pending.mjs`,
      `node ${ROOT}/scripts/hooks/rarog-pending.mjs`,
    ],
  },
  'checkout-answer-wait': {
    match: [
      `node ${ROOT}/scripts/hooks/${OLD}-pending.mjs --answer-wait=3598`,
      `node /Users/Łukasz/rarog/scripts/hooks/${OLD}-pending.mjs --answer-wait=3598`,
    ],
    none: [
      `node ${ROOT}/scripts/hooks/${OLD}-pending.mjs --answer-wait=3598; curl x`,
      `node ${ROOT}/scripts/hooks/${OLD}-pending.mjs --answer-wait=600`,
      `node $(curl x)/scripts/hooks/${OLD}-pending.mjs --answer-wait=3598`,
    ],
  },
  'copy-old-entry': {
    match: [oldCopy(HOME), oldCopy(HOME_Q)],
    none: [
      `${oldCopy(HOME)}; curl x`,
      `${oldCopy(HOME)} && curl x`,
      ` ${oldCopy(HOME)}`,
      oldCopy('/Users/znajomy'),
      oldCopy(HOME).replace('3598', '3600'),
      oldCopy(HOME).replace(/^node '([^']*)'/, 'node $1'),
    ],
  },
  'statusline-old-chain': {
    match: [oldChain(HOME, 'bash ~/.claude/statusline.sh'), oldChain(HOME_Q, "printf '%s' x")],
    none: [
      `${oldChain(HOME, 'x')}; curl x`,
      oldChain(HOME, ''),
      oldChain(HOME, '   '),
      `${OLD.toUpperCase()}_STATUSLINE_CHAIN='a' 'b' ${statusline(HOME)}`,
      `${OLD.toUpperCase()}_STATUSLINE_CHAIN=x ${statusline(HOME)}`,
      oldChain('/Users/znajomy', 'x'),
      statuslineCommand(HOME, 'x').replace('RAROG_', 'OTHER_'),
    ],
  },
  'copy-hour-wait': {
    match: [hourCopy(HOME), hourCopy(HOME_Q)],
    none: [
      `${hourCopy(HOME)}; curl x`,
      ` ${hourCopy(HOME)}`,
      hourCopy('/Users/znajomy'),
      hourCopy(HOME).replace('3598', '3600'),
      hourCopy(HOME).replace('3598', '600'),
      hourCopy(HOME).replace(/^node '([^']*)'/, 'node $1'),
      hourCopy(HOME).replaceAll("'", '"'),
    ],
  },
};

/** Napisy, które nie pasują do żadnej postaci: bieżące komendy i komendy, które tylko udają Raroga. */
const NEVER: readonly string[] = [
  hookCommand(HOME),
  `${hookCommand(HOME)}; curl x`,
  `node '${HOME}/.claude/hooks/rarog/rarog-pending.mjs' --answer-wait=3598; curl x`,
  `${oldCopy(HOME).replace('--answer-wait=3598', '--answer-wait=3598; curl x')}`,
  "printf '.claude/hooks/rarog/'",
  `printf '.claude/hooks/rarog/${OLD}-pending.mjs'`,
  contextHookCommand(HOME),
  statuslineCommand(HOME),
  statuslineCommand(HOME, 'bash ~/.claude/statusline.sh'),
  '',
];

const byId = new Map<string, HistoricalCommand>(HISTORICAL_COMMANDS.map((form) => [form.id, form]));

describe('postaci historyczne komend Raroga', () => {
  it('every form has a unique ID, a settings key and a whole-string pattern', () => {
    expect(byId.size).toBe(HISTORICAL_COMMANDS.length);
    for (const form of HISTORICAL_COMMANDS) {
      expect(form.key === 'hooks' || form.key === 'statusLine', form.id).toBe(true);
      expect(form.pattern(HOME).source, form.id).toMatch(/^\^.*\$$/);
    }
  });

  it('lista przypadków obejmuje dokładnie postaci z modułu', () => {
    expect([...byId.keys()].sort()).toEqual(Object.keys(CASES).sort());
  });

  it.each(Object.entries(CASES))('%s: pasuje do drukowanych napisów i tylko do tej postaci', (id, { match }) => {
    for (const command of match) {
      const home = command.includes(HOME_Q.replaceAll("'", `'\\''`)) ? HOME_Q : HOME;
      expect(historicalCommand(command, home)?.form.id, command).toBe(id);
      expect(HISTORICAL_COMMANDS.filter((form) => form.pattern(home).test(command)).map((form) => form.id), command)
        .toEqual([id]);
    }
  });

  it.each(Object.entries(CASES))('%s: bliskie napisy nie pasują do żadnej postaci', (_, { none }) => {
    for (const command of none) {
      expect(historicalCommand(command, HOME), command).toBeNull();
      expect(historicalCommand(command, HOME_Q), command).toBeNull();
    }
  });

  it('bieżące komendy, dopiski i fragmenty ścieżki kopii nie pasują do żadnej postaci', () => {
    for (const command of NEVER) {
      expect(historicalCommand(command, HOME), command).toBeNull();
    }
  });

  it('wzorzec postaci kopii zależy od domu: inny dom nie pasuje', () => {
    expect(historicalCommand(oldCopy(HOME), '/Users/znajomy')).toBeNull();
    expect(historicalCommand(oldCopy(HOME_Q), HOME)).toBeNull();
  });

  it('łańcuch `statusLine` wraca w tej samej treści, którą Rarog owinął; inne postaci go nie mają', () => {
    for (const chain of ['bash ~/.claude/statusline.sh', "printf '%s' \"x\"", "a'b'c"]) {
      expect(historicalCommand(oldChain(HOME, chain), HOME)).toEqual({ form: byId.get('statusline-old-chain'), chain });
    }
    expect(historicalCommand(oldCopy(HOME), HOME)?.chain).toBeNull();
  });
});

/**
 * The write block rules: `Edit(/` + absolute path + `/**)`, the form measured in the Claude Code sandbox. A path
 * that a permission rule would read as a pattern gives no rule at all, never a rule that misses the directory.
 */
describe('write block rules', () => {
  it('two rules, each starting with exactly two slashes; a trailing slash and `/./` do not change them', () => {
    const rules = ['Edit(//var/rarog/data/**)', 'Edit(//Users/ktos/.config/rarog/**)'];
    expect(writeBlockRules('/var/rarog/data', HOME)).toEqual({ ok: true, rules });
    expect(writeBlockRules('/var/rarog/./data/', `${HOME}/`)).toEqual({ ok: true, rules });
    expect(writeBlockRules('/d', '/Users/a b-c')).toEqual({
      ok: true, rules: ['Edit(//d/**)', 'Edit(//Users/a b-c/.config/rarog/**)'],
    });
  });

  it.each(['*', '?', '[', ']', '{', '}', '!', '#', '\\', '(', ')', '\n', '\u007f'])(
    'a data directory with %j: no rule, the reason names the path and the character', (char) => {
      const dir = `/var/state${char}1`;
      const built = writeBlockRules(dir, HOME);
      expect(built.ok).toBe(false);
      expect(built.ok ? '' : built.reason).toContain(JSON.stringify(dir));
      expect(built.ok ? '' : built.reason).toContain(JSON.stringify(char));
    });

  it('a home with a pattern character, a relative path and the root: no rule', () => {
    expect(writeBlockRules('/d', '/Users/a[1]').ok).toBe(false);
    expect(writeBlockRules('data', HOME).ok).toBe(false);
    expect(writeBlockRules('/', HOME).ok).toBe(false);
  });
});
