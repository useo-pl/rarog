/**
 * Testy `drivers/tool-summary.ts` — opis wywołania narzędzia dla człowieka.
 *
 * Trzy z nich są jednocześnie wejściem warstwy treści dla
 * transkryptu z magazynu CLI i dla karty czekającego narzędzia czytanej z jsonl.
 */
import { describe, expect, it } from 'vitest';
import {
  ASK_USER_QUESTION_TOOL, describeToolInput, firstSentence, parseAskUserQuestionInput,
  summarizeToolInput,
} from '../src/drivers/tool-summary.ts';
import {
  MAX_DISPLAY_TEXT, editDiffText, permissionSemantics, toolDiffText, toolInputText,
} from '../src/drivers/tool-text.ts';
import { degradedCard, planDisplayText, screenPermissionCard } from '../src/herdr/dialogs/cards/build.ts';
import { classifyRisk } from '../src/risk.ts';

describe('opis inputu narzędzia', () => {
  it('komenda Basha idzie w całości (to wejście klasyfikatora ryzyka)', () => {
    const command = 'rm -rf ./dist && git push --force origin main';
    expect(describeToolInput('Bash', { command })).toEqual({ text: command });
  });

  it('bez komendy pokazujemy czytelny JSON', () => {
    const detail = describeToolInput('Edit', { file_path: 'src/a.ts', old_string: 'x' });
    expect(detail.text).toContain('"file_path"');
    expect(detail.text).toContain('src/a.ts');
  });

  it('skrót wybiera pierwsze sensowne pole', () => {
    expect(summarizeToolInput('Read', { file_path: 'src/a.ts' })).toBe('src/a.ts');
    expect(summarizeToolInput('Nieznane', { foo: 1 })).toBe('Nieznane');
    expect(summarizeToolInput('Nieznane', null)).toBe('Nieznane');
  });

  it('kolejność kluczy jest kontraktem: komenda wygrywa ze ścieżką pliku', () => {
    expect(summarizeToolInput('Bash', { file_path: 'a.ts', command: 'npm test' }))
      .toBe('npm test');
  });

  it('komenda poniżej limitu prezentacji idzie w całości (5 kB > stary limit 2 kB)', () => {
    const long = 'x'.repeat(5_000);
    expect(describeToolInput('Bash', { command: long })).toEqual({ text: long });
  });

  it('powyżej 20 kB przycinamy, ale mówimy o tym wprost', () => {
    const long = 'x'.repeat(MAX_DISPLAY_TEXT + 137);
    const shown = describeToolInput('Bash', { command: long });
    expect(shown.text.startsWith('x'.repeat(MAX_DISPLAY_TEXT))).toBe(true);
    expect(shown.text).toContain('… (137 characters cut off)');
    // Ucięcie wewnętrzne — ile znaków wypadło i ile zajmuje stopka na końcu tekstu.
    expect(shown.truncation).toEqual({ cut: 137, footer: [...'\n… (137 characters cut off)'].length });
  });

  /*
   * Reguła, dla której ten plik istnieje osobno: PREZENTACJA przycina, KLASYFIKATOR nie.
   * Gdyby `classifyRisk` dostawał tekst z `describeToolInput`, czerwona fraza za progiem
   * 20 kB byłaby dla niego niewidzialna — a karta pokazywałaby ją użytkownikowi jako `normal`.
   */
  it('przycięcie prezentacji nie chowa czerwonej frazy przed klasyfikatorem', () => {
    const command = `echo ${'a'.repeat(MAX_DISPLAY_TEXT)} && rm -rf ./dist`;
    expect(classifyRisk(describeToolInput('Bash', { command }).text)).toBe('normal');
    expect(classifyRisk(toolInputText('Bash', { command }))).toBe('red');
  });
});

/*
 * Kolor składni na karcie zgody. Pole dostaje WYŁĄCZNIE karta, której `displayText` jest
 * dosłownie komendą powłoki — tekst budują tu prawdziwi producenci kart (`describeToolInput`,
 * `planDisplayText`, `screenPermissionCard`, `degradedCard`), nie ręcznie wpisane łańcuchy.
 */
describe('permissionSemantics — komenda powłoki na karcie zgody', () => {
  const command = 'rm -rf ./dist && git push --force origin main';

  it('karta z jsonl z komendą Basha → `shell`', () => {
    const input = { command, description: 'Sprzątanie i push' };
    expect(permissionSemantics(input, describeToolInput('Bash', input).text)).toEqual({ inputKind: 'shell' });
  });

  it('komenda przycięta stopką `N characters cut off` → brak pola', () => {
    const long = `echo ${'a'.repeat(MAX_DISPLAY_TEXT)}`;
    const shown = describeToolInput('Bash', { command: long });
    expect(shown.text).toContain('characters cut off)');
    expect(permissionSemantics({ command: long }, shown.text)).toEqual({});
  });

  it('karta z ekranu (`{ screen }`) → brak pola, nawet gdy tekst wygląda jak komenda', () => {
    const card = screenPermissionCard({
      header: 'Bash command', question: 'npm test\nDo you want to proceed?', toolName: 'Bash',
      options: [{ digit: '1', label: 'Yes' }, { digit: '2', label: 'No' }],
      dialogIdentity: { kind: 'tool', identity: { kind: 'title', tool: 'Bash' } },
    }, 1);
    expect(card.event.type).toBe('permission-request');
    if (card.event.type !== 'permission-request') return;
    expect(card.event.displayText).toBe('npm test');
    expect(permissionSemantics(card.event.input, card.event.displayText)).toEqual({});
  });

  it('karta zdegradowana (`input: null`) → brak pola', () => {
    const card = degradedCard('toolu_1', null, 'mismatch');
    if (card.event.type !== 'permission-request') throw new Error('karta zgody');
    expect(card.event.input).toBeNull();
    expect(permissionSemantics(card.event.input, card.event.displayText)).toEqual({});
  });

  it('plan (`ExitPlanMode`) → brak pola', () => {
    const input = { plan: '# Plan\n\n1. Krok.' };
    const shown = planDisplayText('ExitPlanMode', input);
    expect(shown).not.toBeNull();
    expect(permissionSemantics(input, shown?.text ?? '')).toEqual({});
  });

  it('JSON innego narzędzia (`Edit`) → brak pola, nie `json`', () => {
    const input = { file_path: 'src/a.ts', old_string: 'x', new_string: 'y' };
    expect(permissionSemantics(input, describeToolInput('Edit', input).text)).toEqual({});
  });

  it('`command` nie-łańcuch albo inny niż tekst karty → brak pola', () => {
    expect(permissionSemantics({ command: ['npm', 'test'] }, 'npm test')).toEqual({});
    expect(permissionSemantics({ command: 'npm test' }, 'npm test ')).toEqual({});
    expect(permissionSemantics('npm test', 'npm test')).toEqual({});
  });
});

describe('parseAskUserQuestionInput', () => {
  it('nazwa narzędzia jest stałą, nie literałem rozsianym po kodzie', () => {
    expect(ASK_USER_QUESTION_TOOL).toBe('AskUserQuestion');
  });

  it('czyta pytania z inputu narzędzia AskUserQuestion', () => {
    const questions = parseAskUserQuestionInput({
      questions: [{
        question: 'Który wariant?',
        header: 'Wariant',
        multiSelect: true,
        options: [
          { label: 'A', description: 'pierwszy' },
          { label: 'B' },
          { label: '' },
        ],
      }],
    });

    expect(questions).toEqual([{
      question: 'Który wariant?',
      header: 'Wariant',
      multiSelect: true,
      options: [{ label: 'A', description: 'pierwszy' }, { label: 'B' }],
    }]);
  });

  it('nieznany kształt inputu → null (manager pokaże zwykłą kartę zgody)', () => {
    expect(parseAskUserQuestionInput({ questions: 'nie tablica' })).toBeNull();
    expect(parseAskUserQuestionInput({})).toBeNull();
    expect(parseAskUserQuestionInput(null)).toBeNull();
    expect(parseAskUserQuestionInput({ questions: [{ header: 'bez pytania' }] })).toBeNull();
  });
});

describe('firstSentence', () => {
  it('bierze pierwsze zdanie i normalizuje białe znaki', () => {
    expect(firstSentence('Zrobione.\n\nDalej nieważne.')).toBe('Zrobione.');
    expect(firstSentence('Bez kropki na końcu')).toBe('Bez kropki na końcu');
    expect(firstSentence('   ')).toBe('');
  });

  it('przycina bardzo długie zdanie', () => {
    expect(firstSentence(`${'a'.repeat(400)}.`).length).toBeLessThanOrEqual(200);
  });
});

// ---------------------------------------------------------------------------
// Mini-diff kart Edit/Write (detailKind: 'diff')
// ---------------------------------------------------------------------------

describe('toolDiffText', () => {
  it('Edit: wspólny początek i koniec odpada, zostają -/+ z dwiema liniami kontekstu', () => {
    const oldStr = 'a\nb\nc\nSTARE\ne\nf\ng';
    const newStr = 'a\nb\nc\nNOWE 1\nNOWE 2\ne\nf\ng';
    expect(toolDiffText('Edit', { file_path: '/x', old_string: oldStr, new_string: newStr }))
      .toBe('  b\n  c\n- STARE\n+ NOWE 1\n+ NOWE 2\n  e\n  f');
  });

  it('Write: cały zapis to plusy', () => {
    expect(toolDiffText('Write', { file_path: '/x', content: 'jeden\ndwa' }))
      .toBe('+ jeden\n+ dwa');
  });

  it('inne narzędzie albo niekompletny input → null (zostaje surowy JSON)', () => {
    expect(toolDiffText('Bash', { command: 'ls' })).toBeNull();
    expect(toolDiffText('Edit', { file_path: '/x', old_string: 'a' })).toBeNull();
    expect(toolDiffText('Write', { file_path: '/x' })).toBeNull();
    expect(toolDiffText('Edit', 'nie obiekt')).toBeNull();
  });

  it('czysta wstawka (stary tekst jest prefiksem nowego) nie gubi ani linii', () => {
    expect(editDiffText('a\nb', 'a\nNOWA\nb')).toBe('  a\n+ NOWA\n  b');
  });
});
