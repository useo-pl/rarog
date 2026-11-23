/**
 * Parser ekranu: wycinek dialogu, tryb uprawnień ze stopki i CYFRY OPCJI.
 *
 * Testy jadą na fixture'ach z `server/test/fixtures/herdr/`, nigdy na żywym gnieździe.
 * `dialog-*.txt` są REKONSTRUKCJAMI (wywołanie dialogu wymagałoby mutacji cudzego panelu),
 * więc wolno na nich sprawdzać wycinanie, ANSI, przycinanie, hash i parsowanie opcji — ale
 * NIE wolno traktować ich jako dowodu, że parser poradzi sobie z prawdziwym ekranem. Brzmienie
 * nagłówków i numeracja pochodzą z CLI, które aktualizuje się bez uprzedzenia; przed weryfikacją
 * na żywo fixture'y trzeba podmienić na zrzuty z izolowanej sesji `rarog-spike`.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ASK_USER_QUESTION_TOOL, mcpServerOf, resolveOptions } from '../src/herdr/dialogs/screen/resolve.ts';
import { TOOL_QUESTION_MAX_CHARS, parseOptions } from '../src/herdr/dialogs/screen/parse.ts';
import { matchKnownDialog } from '../src/herdr/dialogs/screen/known.ts';
import { standingConsentDialog } from '../src/herdr/dialogs/policy/consent.ts';
import { OPTION_LABEL_MAX_CHARS, canonicalLabel } from '../src/herdr/dialogs/screen/options.ts';
import { MODE_FOOTER_LINES, parseMode } from '../src/herdr/dialogs/screen/mode-footer.ts';
import { SNIPPET_MAX_CHARS, SNIPPET_MAX_LINES, snippet } from '../src/herdr/dialogs/screen/snippet.ts';
import type { ScreenDialog } from '../src/herdr/dialogs/screen/parse.ts';
import { screenQuestionCard } from '../src/herdr/dialogs/cards/build.ts';
import { optionRole } from '../src/herdr/dialogs/cards/roles.ts';
import { hookQuestionFrom } from '../src/herdr/dialogs/cross-check.ts';
import { screenAnswerIndex } from '../src/herdr/dialogs/hook/target.ts';
import { affirmativeOption, alwaysOption } from '../src/herdr/dialogs/policy/options.ts';
import { askFormOnScreen } from '../src/herdr/dialogs/presence.ts';
import type { PendingTool } from '../src/herdr/jsonl-pending.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'herdr');
const read = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');

const permissionDialog = read('dialog-permission.txt');
const descriptionDialog = read('dialog-permission-opis.txt');
const questionDialog = read('dialog-askuserquestion.txt');
const trustDialog = read('dialog-trust.txt');
const modelSwitchDialog = read('dialog-model-switch.txt');
const effortDialog = read('dialog-effort-change.txt');
const resumeDialog = read('dialog-resume-summary-2.1.258.txt');
const subagentDialog = read('dialog-permission-subagent.txt');
const cdAdvisoryDialog = read('dialog-permission-cd-advisory-2.1.265.txt');
const footerAuto = read('footer-auto.txt');
const footerAutoTray = read('footer-auto-tacka.txt');

/** Etykiety opcji z fixture'ów — literały, żeby test nie zgadywał razem z parserem. */
const ALLOW_ONCE = 'Yes';
const ALLOW_ALWAYS = "Yes, and don't ask again for pnpm commands in /Users/u/Projects/demo";
const DENY_WITH_HINT = 'No, and tell Claude what to do differently (esc)';

/** Podmienia ostatnią NIEPUSTĄ linię ekranu — stopka trybu jest właśnie tam. */
function withFooter(screen: string, footer: string): string {
  const lines = screen.replace(/\s+$/, '').split('\n');
  lines[lines.length - 1] = footer;
  return `${lines.join('\n')}\n`;
}

/** Linie opcji wewnątrz ramki dialogu (z markerem zaznaczenia albo bez). */
const OPTION_LINE_IN_BOX = /^\s*│\s*(?:❯\s*)?\d\.\s/;

/**
 * Przestawia FIZYCZNĄ kolejność linii opcji, zostawiając ich cyfry nietknięte.
 *
 * `order` to lista indeksów źródłowych: `[2, 0, 1]` znaczy „na pierwszym miejscu pokaż opcję,
 * która ma cyfrę 3". Dokładnie tak wygląda ekran z przetasowaną numeracją.
 */
function reorderOptionLines(screen: string, order: readonly number[]): string {
  const lines = screen.split('\n');
  const slots: number[] = [];
  lines.forEach((line, i) => {
    if (OPTION_LINE_IN_BOX.test(line)) slots.push(i);
  });
  const original = slots.map((i) => lines[i] ?? '');
  order.forEach((from, to) => {
    lines[slots[to] ?? 0] = original[from] ?? '';
  });
  return lines.join('\n');
}

describe('snippet — realne ekrany dialogów', () => {
  it('zwraca czytelny wycinek dialogu zgody', () => {
    const result = snippet(permissionDialog);
    expect(result).not.toBeNull();
    expect(result?.text).toContain('Do you want to proceed?');
    expect(result?.text).toContain('1. Yes');
    expect(result?.text).toContain('esc to cancel');
  });

  it('zwraca czytelny wycinek dialogu AskUserQuestion', () => {
    const result = snippet(questionDialog);
    expect(result?.text).toContain('esc to cancel');
    expect(result?.text.length).toBeGreaterThan(50);
  });

  it('usuwa sekwencje ANSI (kolor, pozycjonowanie kursora, OSC)', () => {
    const painted = '\u001b[2J\u001b[H\u001b[31mUwaga\u001b[0m: zgoda?'
      + '\u001b]0;tytuł okna\u0007\n\u001b[1m1. Yes\u001b[0m';
    const result = snippet(painted);
    expect(result?.text).toBe('Uwaga: zgoda?\n1. Yes');
    expect(result?.text).not.toMatch(/\u001b/);
  });
});

describe('snippet — hash i deduplikacja', () => {
  it('ten sam ekran dwa razy → ten sam hash', () => {
    expect(snippet(permissionDialog)?.hash).toBe(snippet(permissionDialog)?.hash);
  });

  it('ten sam ekran z innym malowaniem ANSI → nadal ten sam hash', () => {
    const painted = permissionDialog.replace('Do you want', '\u001b[33mDo you want\u001b[0m');
    expect(snippet(painted)?.hash).toBe(snippet(permissionDialog)?.hash);
  });

  it('inny ekran → inny hash', () => {
    expect(snippet(questionDialog)?.hash).not.toBe(snippet(permissionDialog)?.hash);
  });
});

describe('snippet — brzegi', () => {
  it('pusty ekran → null', () => {
    expect(snippet('')).toBeNull();
    expect(snippet('   \n\n\t\n')).toBeNull();
  });

  it('sama ramka box-drawing bez treści → null', () => {
    expect(snippet('╭────────╮\n│        │\n╰────────╯')).toBeNull();
  });

  it('ekran ze samych sekwencji ANSI → null', () => {
    expect(snippet('\u001b[2J\u001b[H\u001b[0m')).toBeNull();
  });

  it('przycina do 40 linii, zostawiając KONIEC ekranu (tam stoi dialog)', () => {
    const lines = Array.from({ length: 120 }, (_, i) => `linia ${i}`);
    const result = snippet(lines.join('\n'));
    const out = result?.text.split('\n') ?? [];
    expect(out).toHaveLength(SNIPPET_MAX_LINES);
    expect(out.at(-1)).toBe('linia 119');
    expect(out[0]).toBe('linia 80');
  });

  it('przycina do 2000 znaków i nie zostawia urwanej pierwszej linii', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `${i} ${'x'.repeat(200)}`);
    const result = snippet(lines.join('\n'));
    expect(result).not.toBeNull();
    expect(result!.text.length).toBeLessThanOrEqual(SNIPPET_MAX_CHARS);
    // Pierwsza linia wycinka jest KOMPLETNA (zaczyna się od numeru, nie od środka `xxx`).
    expect(result!.text.split('\n')[0]).toMatch(/^\d+ x+$/);
  });
});

describe('parseMode — pięć stopek trybu (zmierzone na CLI 2.1.240, zrzut tylko `footer-auto.txt`)', () => {
  it('realna stopka z żywego serwera → auto', () => {
    expect(parseMode(footerAuto)).toBe('auto');
  });

  it('bypass permissions on → bypass', () => {
    const screen = withFooter(footerAuto, '  ⏵⏵ bypass permissions on (shift+tab to cycle)');
    expect(parseMode(screen)).toBe('bypass');
  });

  it('plan mode on → plan', () => {
    const screen = withFooter(footerAuto, '  ⏸ plan mode on (shift+tab to cycle)');
    expect(parseMode(screen)).toBe('plan');
  });

  it('manual mode on → manual (ten tryb MA własny marker — zmierzone na CLI 2.1.240)', () => {
    const screen = withFooter(footerAuto, '  ⏸ manual mode on · ← 1 agent');
    expect(parseMode(screen)).toBe('manual');
  });

  it('accept edits on → auto, nigdy manual', () => {
    /*
     * `accept edits` przyjmuje zmiany w plikach BEZ pytania. Kontrakt trybu nie ma dla niego
     * wariantu, więc pokazujemy `auto` (chip „uważaj"). Pokazanie `manual` byłoby obietnicą
     * kart zgody, których w tym trybie nie będzie.
     */
    const screen = withFooter(footerAuto, '  ⏵⏵ accept edits on (shift+tab to cycle) · ← 1 agent');
    expect(parseMode(screen)).toBe('auto');
  });

  it('stopka zasłonięta nakładką → unknown, NIE manual', () => {
    /*
     * To jest reguła bezpieczeństwa, nie kosmetyka: gdyby ekran bez markera czytał się jako
     * `manual`, panel w `bypass permissions` z otwartą nakładką `/status` traciłby chip
     * ORAZ blokadę `RAROG_YOLO_ROOTS`. Nadzorca na `unknown` zostawia ostatni znany tryb.
     */
    const screen = withFooter(footerAuto, '   Esc to cancel');
    expect(parseMode(screen)).toBe('unknown');
  });

  it('pusty / nieczytelny ekran → unknown', () => {
    expect(parseMode('')).toBe('unknown');
    expect(parseMode('\u001b[2J\u001b[H')).toBe('unknown');
    expect(parseMode('   \n \n')).toBe('unknown');
  });

  it('stopka najbliższa dołu wygrywa — starsza stopka wyżej NIE liczy się', () => {
    const stale = Array.from({ length: 20 }, () => '⏵⏵ bypass permissions on').join('\n');
    const screen = `${stale}\n${'x'.repeat(10)}\ny\n⏵⏵ auto mode on (shift+tab to cycle)`;
    expect(parseMode(screen)).toBe('auto');
  });

  it('tacka subagentów POD stopką → auto, nie unknown', () => {
    /*
     * Panel z subagentem (fixture `footer-auto-tacka.txt`, wersja CLI niezapisana): Claude Code rysuje
     * `⏺ main` i po wierszu na agenta pod stopką trybu.
     * Przy oknie 3 linii stopka wypada, `readMode` zostawia tryb nieświeży i po 15 s bramka
     * wysyłki odmawia — dokładnie wtedy, gdy człowiek chce dopisać coś pracującej sesji.
     */
    expect(parseMode(footerAutoTray)).toBe('auto');
  });

  it('okno kończy się na poziomej kresce — stara stopka ze scrollbacku NIE liczy się', () => {
    /*
     * Nad linią statusu stoi zawsze kreska. Co jest nad nią, to scrollback — tam mogła zostać
     * stopka sprzed `shift+tab`. Gdyby okno ją łapało, panel przełączony do `bypass`
     * z zasłoniętą bieżącą stopką czytałby się jako `auto`.
     */
    const rule = '─'.repeat(40);
    const screen = `⏵⏵ auto mode on (shift+tab to cycle)\n${rule}\n  Fable 5 ⚡high 8%\n  ⏺ main\n  ◯ Explore  szuka`;
    expect(parseMode(screen)).toBe('unknown');
  });

  it('okno ma sufit MODE_FOOTER_LINES — stopka głębiej bez kreski NIE liczy się', () => {
    const tray = Array.from({ length: MODE_FOOTER_LINES }, (_, i) => `  ◯ agent-${i}  pracuje`);
    const screen = `⏵⏵ auto mode on (shift+tab to cycle)\n${tray.join('\n')}`;
    expect(MODE_FOOTER_LINES).toBe(12);
    expect(parseMode(screen)).toBe('unknown');
  });
});

describe('parseOptions — cztery ekrany z fixture', () => {
  it('dialog zgody → kind `tool`, nazwa narzędzia i trzy opcje', () => {
    const dialog = parseOptions(permissionDialog);
    expect(dialog).not.toBeNull();
    expect(dialog?.kind).toBe('tool');
    expect(dialog?.toolName).toBe('Bash');
    expect(dialog?.options).toEqual([
      { digit: '1', label: ALLOW_ONCE },
      { digit: '2', label: ALLOW_ALWAYS },
      { digit: '3', label: DENY_WITH_HINT },
    ]);
  });

  it('nowy render z opisem (bez linii `⏺ Bash(…)`) → nazwa z nagłówka „Bash command"', () => {
    /*
     * Zrzut `dialog-permission-opis.txt` (wersja CLI niezapisana): gdy model daje opis wywołania,
     * CLI rysuje `⏺ Opis` + `└ $ komenda` — linii `⏺ Bash(…)` nie ma na ekranie w ogóle (jej brak
     * przy nagłówku „Bash command” pokazuje też `dialog-bash-opis-telefon-2.1.302.txt`, CLI 2.1.302).
     * Nazwę niosą nagłówek ramki i linia „Ask rule Bash(…)"; bez tego fallbacku cross-check kończył się
     * fail-closed i karta spadała do „odpowiedz w terminalu" mimo poprawnego dialogu.
     */
    const dialog = parseOptions(descriptionDialog);
    expect(dialog).not.toBeNull();
    expect(dialog?.kind).toBe('tool');
    expect(dialog?.toolName).toBe('Bash');
    expect(dialog?.options).toEqual([
      { digit: '1', label: 'Yes' },
      { digit: '2', label: 'No' },
    ]);
  });

  it('stare `⏺ Read(…)` w scrollbacku NIE przykrywa nazwy z dialogu niżej (nazwa z tytułu bloku)', () => {
    const mixed = `⏺ Read(docs/architektura.md)\n  ⎿ 40 lines\n\n${descriptionDialog}`;
    expect(parseOptions(mixed)?.toolName).toBe('Bash');
  });

  it('formularz AskUserQuestion → kind `question`, bez nazwy narzędzia na ekranie', () => {
    /*
     * Brak nazwy jest FAKTEM tego ekranu, nie brakiem parsera: dialog `AskUserQuestion`
     * nie zawiera linii `⏺ AskUserQuestion(…)`. Cała asymetria cross-checku w `resolveOptions`
     * (kształt zamiast nazwy) wisi na tej asercji.
     */
    const dialog = parseOptions(questionDialog);
    expect(dialog?.kind).toBe('question');
    expect(dialog?.toolName).toBeNull();
    expect(dialog?.options).toEqual([
      {
        digit: '1',
        label: 'Zapis atomowy (tmp + rename)',
        description: 'Bezpieczniejszy, o jeden syscall więcej',
      },
      {
        digit: '2',
        label: 'Zapis w miejscu',
        description: 'Szybszy, ryzyko uciętego pliku przy awarii',
      },
    ]);
  });

  it('opis pod opcją NIE staje się osobną opcją (linia bez cyfry to nie opcja)', () => {
    const dialog = parseOptions(questionDialog);
    expect(dialog?.options).toHaveLength(2);
    expect(dialog?.options.map((o) => o.label)).not.toContain(
      'Bezpieczniejszy, o jeden syscall więcej',
    );
  });

  it('dialog zaufania katalogu → kind `other` mimo poprawnie sparsowanych opcji', () => {
    const dialog = parseOptions(trustDialog);
    expect(dialog?.kind).toBe('other');
    expect(dialog?.options).toEqual([
      { digit: '1', label: 'Yes, I trust this folder' },
      { digit: '2', label: 'No, exit' },
    ]);
  });

  it('dialog zmiany modelu → kind `confirm` (klasa potwierdzeń ustawień CLI)', () => {
    /*
     * Fixture jest ZRZUTEM Z ŻYWEGO PANELU (`rarog-spike`, claude 2.1.241),
     * a nie rekonstrukcją — stąd etykiety niosą nazwę modelu docelowego („…to Opus 5"),
     * a nie ogólne „Yes, switch". Nagłówek na ekranie brzmi „Switch model?" i NIE mówi ani
     * słowa o zapisie do ustawień konta; o skutku globalnym uprzedza wyłącznie
     * `MODEL_CHANGE_WARNING` w arkuszu Raroga — dlatego to ostrzeżenie musi zostać.
     *
     * Kind to `confirm`, nie `other`: klasa `confirm` (silnik dialogów) rozpoznaje ten
     * kształt: region za kreską `▔▔▔…`, pytanie w treści, opcje na samym dole, zero `⏺`.
     */
    const dialog = parseOptions(modelSwitchDialog);
    expect(dialog?.kind).toBe('confirm');
    expect(dialog?.question?.question).toContain('Switch model?');
    expect(dialog?.options).toEqual([
      { digit: '1', label: 'Yes, switch to Opus 5' },
      { digit: '2', label: 'No, go back' },
    ]);
  });
});

describe('parseOptions — cyfra pochodzi z TEKSTU, nigdy z pozycji', () => {
  it('przetasowana numeracja 3/1/2 daje cyfry z linii, nie z licznika pętli', () => {
    /*
     * TEST OBOWIĄZKOWY. Ekran pokazuje opcje w kolejności 3, 1, 2. Parser liczący
     * pozycję przypisałby „No, and tell Claude…" cyfrę 1 — czyli Rarog pokazałby „Odrzuć",
     * a wysłał „Zezwól". To jest dokładnie ta pomyłka, przed którą broni cały ten moduł.
     */
    const shuffled = reorderOptionLines(permissionDialog, [2, 0, 1]);
    const dialog = parseOptions(shuffled);
    expect(dialog?.options.map((o) => o.digit)).toEqual(['3', '1', '2']);
    expect(dialog?.options.map((o) => o.label)).toEqual([DENY_WITH_HINT, ALLOW_ONCE, ALLOW_ALWAYS]);

    const byLabel = new Map(dialog?.options.map((o) => [o.label, o.digit]));
    expect(byLabel.get(DENY_WITH_HINT)).toBe('3');
    expect(byLabel.get(ALLOW_ONCE)).toBe('1');
  });
});

describe('parseOptions — żywy render multi-select (wersja CLI niezapisana)', () => {
  /*
   * Trzy zrzuty z izolowanej zakładki herdr (README fixture'ów). Różnią się od rekonstrukcji
   * jednym szczegółem, który rozkłada naiwny parser: opis stoi w TEJ SAMEJ kolumnie co cyfra.
   */
  const start = read('dialog-askuserquestion-multi-live-start.txt');
  const submit = read('dialog-askuserquestion-multi-live-submit.txt');

  it('opis w kolumnie cyfry JEST opisem — `Kolorowa` dociera do opcji', () => {
    const dialog = parseOptions(start);
    expect(dialog?.multiSelect).toBe(true);
    expect(dialog?.options.map((o) => [o.label, o.checked, o.description])).toEqual([
      ['Posypka', false, 'Kolorowa'],
      ['Polewa', false, 'Czekoladowa'],
      ['Bita śmietana', false, 'Domowa'],
      ['Type something', false, undefined],
      ['Chat about this', undefined, undefined],
    ]);
  });

  it('`❯` na wierszu „Submit" nie jest opcją, a zaznaczenie z `space` widać w `checked`', () => {
    const dialog = parseOptions(submit);
    expect(dialog?.options.map((o) => o.label)).not.toContain('Submit');
    expect(dialog?.options[0]?.checked).toBe(true);
    expect(dialog?.selected).toBeNull();
  });
});

describe('parseOptions — wskaźniki przewinięcia listy', () => {
  /*
   * Założenie Raroga z obserwacji bez wersji CLI i bez zrzutu (ekrany niżej są syntetyczne):
   * `AskUserQuestion` z trzylinijkowymi opisami, który nie mieści się w panelu, dostaje od
   * Claude Code własny wskaźnik przewinięcia `↓` W KOLUMNIE MARKERA WYBORU. Bez rozpoznania
   * linia „↓ 2. …" nie byłaby opcją, więc nawet kompletna lista z takim wskaźnikiem szłaby
   * w kartę zastępczą.
   */
  it('`↓`/`↑` przed cyfrą to kosmetyka, nie część etykiety — opcja zostaje rozpoznana', () => {
    const screen = [
      'Do you want to proceed?',
      '❯ 1. Yes',
      '↓ 2. No, and tell Claude what to do differently',
      '',
      'Enter to select · ↑/↓ to navigate · Esc to cancel',
    ].join('\n');
    const dialog = parseOptions(screen);
    expect(dialog?.options).toEqual([
      { digit: '1', label: 'Yes' },
      { digit: '2', label: 'No, and tell Claude what to do differently' },
    ]);
  });

  it('wskaźnik przewinięcia NIE czyni listy kompletną — luka 3–4 nadal daje null', () => {
    const screen = [
      'Which option?',
      '❯ 1. Alpha',
      '↓ 2. Beta',
      '─────────',
      '  5. Chat about this',
      '',
      'Enter to select · ↑/↓ to navigate · Esc to cancel',
    ].join('\n');
    expect(parseOptions(screen)).toBeNull();
  });
});

describe('parseOptions — brzegi i fail-closed', () => {
  it('powtórzona cyfra (ekran przemalowany w trakcie odczytu) → null', () => {
    const repainted = permissionDialog.replace('3. No, and tell', '1. No, and tell');
    expect(parseOptions(repainted)).toBeNull();
  });

  it('powtórzona etykieta → null (wybór „po tekście" przestaje być jednoznaczny)', () => {
    const ambiguous = permissionDialog.replace(`2. ${ALLOW_ALWAYS}`, `2. ${ALLOW_ONCE}`);
    expect(parseOptions(ambiguous)).toBeNull();
  });

  it('opcja numerowana od zera → null (CLI numeruje od 1, więc czytamy nie to, co myślimy)', () => {
    const zeroBased = permissionDialog.replace('1. Yes', '0. Yes');
    expect(parseOptions(zeroBased)).toBeNull();
  });

  it('dialog bez cyfr → null', () => {
    const noDigits = trustDialog
      .replace('1. Yes, I trust this folder', 'Yes, I trust this folder')
      .replace('2. No, exit', 'No, exit');
    expect(parseOptions(noDigits)).toBeNull();
  });

  it('śmieć, pusty ekran i sama ramka → null', () => {
    expect(parseOptions('')).toBeNull();
    expect(parseOptions('\u001b[2J\u001b[H')).toBeNull();
    expect(parseOptions('╭──────╮\n│      │\n╰──────╯')).toBeNull();
    expect(parseOptions('ls -la\ntotal 24\ndrwxr-xr-x  3 u  staff   96 Aug 23 09:00 .')).toBeNull();
  });

  it('zdejmuje ANSI przed parsowaniem', () => {
    const painted = permissionDialog.replace('1. Yes', '\u001b[1m1. Yes\u001b[0m');
    expect(parseOptions(painted)?.options[0]).toEqual({ digit: '1', label: ALLOW_ONCE });
  });

  it('dolna krawędź ramki NIE jest poziomą kreską (inaczej region byłby pusty)', () => {
    // Regresja: `╰────╯` stoi POD opcjami. Gdyby liczyła się jako kreska, `parseOptions`
    // zaczynałby czytać za nią i nie widział ani jednej opcji.
    expect(permissionDialog).toContain('╰');
    expect(parseOptions(permissionDialog)?.options).toHaveLength(3);
  });

  it('etykieta jest przycięta do sufitu i ma zwinięte białe znaki', () => {
    const long = 'x'.repeat(OPTION_LABEL_MAX_CHARS + 50);
    const dialog = parseOptions(`──────────\n1.    a\t\tb\n2. ${long}\n  esc to cancel`);
    expect(dialog?.options[0]?.label).toBe('a b');
    expect(dialog?.options[1]?.label).toHaveLength(OPTION_LABEL_MAX_CHARS);
  });

  it('canonicalLabel jest tą samą funkcją, której użyje wołający przy `allow`', () => {
    expect(canonicalLabel('  Yes,   and   don\'t ask  ')).toBe("Yes, and don't ask");
  });

  /*
   * Klucz kanoniczny bywa liczony dwa razy: raz z pełnej etykiety, raz z etykiety już kanonicznej (opcja z ekranu
   * na karcie, lista `terminalOnlyLabels`). Cięcie na sufit, które zostawiało spację na końcu, dawało przy drugim
   * liczeniu klucz o znak krótszy, więc bramka cyfry rozjeżdżała się z kartą.
   */
  it.each([
    ['spacja na 200. pozycji', `${'x'.repeat(OPTION_LABEL_MAX_CHARS - 1)} for this session`],
    ['ciąg spacji przez sufit', `${'x'.repeat(OPTION_LABEL_MAX_CHARS - 2)}   \t  dalej`],
    ['krótka etykieta', '  Yes,   and   don\'t ask  '],
    ['dokładnie sufit', 'y'.repeat(OPTION_LABEL_MAX_CHARS)],
  ])('canonicalLabel jest idempotentne i nie kończy się spacją (%s)', (_case, label) => {
    const once = canonicalLabel(label);
    expect(canonicalLabel(once)).toBe(once);
    expect(once).toBe(once.trimEnd());
    expect(once.length).toBeLessThanOrEqual(OPTION_LABEL_MAX_CHARS);
  });
});

describe('parseOptions — klasa `confirm` (silnik dialogów)', () => {
  it('dialog `Change effort level?` → confirm z dosłowną treścią i opcjami', () => {
    /*
     * Fixture jest rekonstrukcją ze screenshota ŻYWEJ AWARII (wersja CLI niezapisana): dialog
     * po `/effort high`, którego Rarog nie obsłużył (stare okno pollingu 2 s), przez co pigułka
     * effortu kłamała, a herdr trzymał stary poziom. To jest dialog, dla którego powstała klasa.
     */
    const dialog = parseOptions(effortDialog);
    expect(dialog?.kind).toBe('confirm');
    expect(dialog?.question?.header).toBe('');
    expect(dialog?.question?.question).toContain('Change effort level?');
    expect(dialog?.question?.question).not.toContain('Sautéed');
    expect(dialog?.options).toEqual([
      { digit: '1', label: 'Yes, switch to high' },
      { digit: '2', label: 'No, go back' },
    ]);
  });

  it('bez kreski odgradzającej NIE ma confirm — treść mogłaby nieść scrollback', () => {
    const unbounded = effortDialog.replace(/^▔+$/m, '');
    expect(parseOptions(unbounded)?.kind).toBe('other');
  });

  it('tekst POD ostatnią opcją dyskwalifikuje confirm (lista cyfr może być ze scrollbacku)', () => {
    const trailing = `${effortDialog.trimEnd()}\n   a prawdziwy dialog stoi niżej`;
    expect(parseOptions(trailing)?.kind).toBe('other');
  });

  it('marker eskalacji w TREŚCI wyklucza confirm — trust zostaje przy swojej sygnaturze', () => {
    // Zaufanie katalogu parsuje się poprawnie, ale NIGDY nie jest `confirm` (podwójna
    // bramka: stopka pod opcjami ORAZ marker `trust` w treści) — obsługuje je zamknięta lista.
    expect(parseOptions(trustDialog)?.kind).toBe('other');
  });

  it('marker eskalacji w ETYKIECIE OPCJI nie ubija karty — opcja dostaje flagę', () => {
    /*
     * Polityka uniwersalnej karty: marker w KTÓREJKOLWIEK linii regionu nie odbiera karty
     * całemu dialogowi, bo opcja „don't ask again"/„always allow" bywa w
     * dialogach obok w pełni bezpiecznych opcji jednorazowych. Teraz treść i etykiety są
     * rozdzielone: eskalująca TREŚĆ dalej wyklucza (test wyżej), eskalująca OPCJA jedzie
     * na kartę z `terminalOnly` (bramka wysyłki w driverze odmawia jej cyfry).
     */
    const escalating = effortDialog.replace(
      'Yes, switch to high', "Yes, and don't ask again",
    );
    expect(parseOptions(escalating)?.kind).toBe('confirm');
    const resolution = resolveOptions(escalating, null);
    expect(resolution.status).toBe('no-jsonl');
    if (resolution.status !== 'no-jsonl') throw new Error('nieosiągalne');
    expect(resolution.questionForm?.options).toEqual([
      { digit: '1', label: "Yes, and don't ask again", terminalOnly: true },
      { digit: '2', label: 'No, go back' },
    ]);
  });

  it('treść bez pytajnika albo dłuższa niż sufit → other (fail-closed)', () => {
    const noQuestion = effortDialog.replace('Change effort level?', 'Change effort level');
    expect(parseOptions(noQuestion)?.kind).toBe('other');

    const padding = 'za długi opis dialogu bez granic. '.repeat(30);
    const tooLong = effortDialog.replace(
      'Your next response will be slower and use more tokens',
      padding,
    );
    expect(parseOptions(tooLong)?.kind).toBe('other');
  });

  it('dialog wznowienia starej sesji (`--resume`, 2.1.258) → confirm mimo braku pytajnika', () => {
    /*
     * Zmierzone na CLI 2.1.258 (tab pomiarowy, `claude --resume` sesji sprzed 5 dni i 779k
     * tokenów): nagłówek jest ZDANIEM, pod opcjami stoi stopka „Enter to confirm · Esc to
     * cancel", a cyfra wybiera od razu (bez Entera). Opcja „Don't ask me again" utrwala ustawienie, więc zostaje
     * `terminalOnly` — tak samo jak każde „don't ask again".
     */
    const dialog = parseOptions(resumeDialog);
    expect(dialog?.kind).toBe('confirm');
    expect(dialog?.submit).toBe('digit');
    expect(dialog?.question?.question).toContain('This session is 5d 8h old and 778.9k tokens.');
    expect(dialog?.question?.question).not.toContain('recap');
    const resolution = resolveOptions(resumeDialog, null);
    if (resolution.status !== 'no-jsonl') throw new Error('nieosiągalne');
    expect(resolution.questionForm?.options).toEqual([
      { digit: '1', label: 'Resume from summary (recommended)' },
      { digit: '2', label: 'Resume full session as-is' },
      { digit: '3', label: "Don't ask me again", terminalOnly: true },
    ]);
  });

  it('zdanie bez pytajnika SPOZA zamkniętej listy dalej daje other (stopka nie otwiera drzwi)', () => {
    const foreign = resumeDialog.replace(
      'This session is 5d 8h old and 778.9k tokens.', 'Some other statement about the session.',
    );
    expect(parseOptions(foreign)?.kind).toBe('other');
    // Pod opcjami wolno stać wyłącznie stopce klawiszowej — zwykły tekst dalej dyskwalifikuje.
    const trailing = resumeDialog.replace('Enter to confirm · Esc to cancel', 'a prawdziwy dialog niżej');
    expect(parseOptions(trailing)?.kind).toBe('other');
  });

  it('linia `⏺ Narzędzie(…)` w regionie wyklucza confirm', () => {
    const withTool = effortDialog.replace(
      '   Change effort level?', '⏺ Bash(rm -rf /tmp/x)\n   Change effort level?',
    );
    expect(parseOptions(withTool)?.kind).toBe('other');
  });
});

describe('standingConsentDialog — dialogi zgody CLI niewidoczne dla herdr', () => {
  it('„Teach auto mode about your environment?" (2.1.258, żywy zrzut) → `auto-mode-teach`', () => {
    const screen = read('dialog-automode-teach-2.1.258.txt');
    expect(standingConsentDialog(screen)).toBe('auto-mode-teach');
    // Nie jest to dialog z opcjami ani composer: parser opcji milczy, composer jest `unknown`.
    expect(parseOptions(screen)).toBeNull();
  });

  it('zwykłe dialogi i puste ekrany → null (lista jest zamknięta)', () => {
    expect(standingConsentDialog(effortDialog)).toBeNull();
    expect(standingConsentDialog(trustDialog)).toBeNull();
    expect(standingConsentDialog('❯')).toBeNull();
    // Samo słowo „auto mode" w scrollbacku (stopka trybu) nie jest dialogiem.
    expect(standingConsentDialog('⏵⏵ auto mode on (shift+tab to cycle)')).toBeNull();
  });
});

describe('matchKnownDialog — zamknięta lista sygnatur', () => {
  const known = (screen: string): string | null => {
    const dialog = parseOptions(screen);
    return dialog === null ? null : matchKnownDialog(screen, dialog);
  };

  it('rozpoznaje zaufanie katalogu i zmianę modelu', () => {
    expect(known(trustDialog)).toBe('trust');
    expect(known(modelSwitchDialog)).toBe('model');
  });

  it('dialog effortu NIE jest `model` — zawężona sygnatura', () => {
    /*
     * Stara gałąź `|to ` łapała „Yes, switch to high" i dialog po `/effort` dostawał etykietę
     * „zmiana modelu". Dziś nagłówkiem sygnatury jest wyłącznie „Switch model", a dialogi
     * bez niego obsługuje klasa `confirm`.
     */
    expect(known(effortDialog)).toBeNull();
  });

  it('nie rozpoznaje niczego spoza listy, choć opcje parsują się poprawnie', () => {
    const mcp = [
      '⏺ Łączę się z serwerem MCP.',
      '──────────────────────────────────────────────',
      '╭────────────────────────────────────────────╮',
      '│ Do you want to allow this connection?      │',
      '│                                            │',
      '│ ❯ 1. Yes, allow                            │',
      '│   2. No                                    │',
      '╰────────────────────────────────────────────╯',
      '  enter to confirm · esc to cancel',
    ].join('\n');
    expect(parseOptions(mcp)?.options).toHaveLength(2);
    expect(known(mcp)).toBeNull();
  });

  it('nagłówek pasuje, ale brakuje oczekiwanej opcji → brak dopasowania', () => {
    const truncated = trustDialog.replace('2. No, exit', '2. Maybe later');
    expect(known(truncated)).toBeNull();
  });

  it('jedna etykieta nie zaspokaja dwóch wzorców naraz', () => {
    // „Yes" pasuje do `/^Yes/i`, ale nie ma czym pokryć `/^No/i` — dialog z samym „Yes"
    // nie ma prawa udawać pary Yes/No.
    const onlyYes = trustDialog.replace('2. No, exit', '2. Yes, and remember');
    expect(known(onlyYes)).toBeNull();
  });
});

describe('resolveOptions — cross-check jsonl ↔ ekran', () => {
  it('zgoda na narzędzie: nazwa z ekranu zgodna z jsonl → ok z mapą cyfr', () => {
    const result = resolveOptions(permissionDialog, { toolName: 'Bash' });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.kind).toBe('tool');
    expect(result.toolName).toBe('Bash');
    expect(result.digitByLabel.get(ALLOW_ONCE)).toBe('1');
    expect(result.digitByLabel.get(DENY_WITH_HINT)).toBe('3');
  });

  it('nowy render z opisem: nazwa z nagłówka zgodna z jsonl → ok z mapą cyfr', () => {
    const result = resolveOptions(descriptionDialog, { toolName: 'Bash' });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.kind).toBe('tool');
    expect(result.digitByLabel.get('Yes')).toBe('1');
    expect(result.digitByLabel.get('No')).toBe('2');
  });

  it('nowy render z opisem, a jsonl czeka na Edit → mismatch po nazwie', () => {
    const result = resolveOptions(descriptionDialog, { toolName: 'Edit' });
    expect(result).toMatchObject({
      status: 'mismatch', retryable: false, reason: 'tool-name', screenToolName: 'Bash',
    });
  });

  it('rozjazd nazwy narzędzia → mismatch bez ponawiania (to nie jest problem czasu)', () => {
    const result = resolveOptions(permissionDialog, { toolName: 'Edit' });
    expect(result).toMatchObject({
      status: 'mismatch', retryable: false, reason: 'tool-name', screenToolName: 'Bash',
    });
  });

  it('jsonl mówi o pytaniu, ekran o zgodzie na narzędzie → mismatch po rodzaju', () => {
    const result = resolveOptions(permissionDialog, { toolName: 'AskUserQuestion' });
    expect(result).toMatchObject({ status: 'mismatch', reason: 'kind', screenKind: 'tool' });
  });

  it('pytanie: kształt formularza wystarcza za nazwę, której ekran nie niesie', () => {
    const result = resolveOptions(questionDialog, { toolName: 'AskUserQuestion' });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.kind).toBe('question');
    expect(result.digitByLabel.get('Zapis w miejscu')).toBe('2');
  });

  it('pytanie z ekranu, a jsonl czeka na Bash → mismatch', () => {
    const result = resolveOptions(questionDialog, { toolName: 'Bash' });
    expect(result).toMatchObject({ status: 'mismatch', reason: 'kind', screenKind: 'question' });
  });

  it('linia `⏺` nad formularzem i w nim nie jest ani nazwą, ani sprzecznością', () => {
    /*
     * `⏺ Edit(…)` z POPRZEDNIEGO wywołania w scrollbacku nie może unieważniać formularza,
     * a linia narzędzia w regionie dialogu też nie jest sprzecznością: nazwa pochodzi
     * wyłącznie z bloku dialogu, a kształt `⏺ Bash(…)` potrafi wpisać autor
     * pytania. Zgodę na narzędzie zamiast formularza łapie rozjazd rodzaju (stopka CLI).
     */
    const inScrollback = `⏺ Bash(rm -rf /tmp/x)\n${questionDialog}`;
    const inRegion = questionDialog.replace('╭', '⏺ Bash(rm -rf /tmp/x)\n╭');
    for (const text of [inScrollback, inRegion]) {
      expect(parseOptions(text)).toMatchObject({ kind: 'question', toolName: null, identity: { kind: 'form' } });
      expect(resolveOptions(text, { toolName: 'AskUserQuestion' }).status).toBe('ok');
    }
  });

  it('ekran nieczytelny → unreadable z prawem do JEDNEGO ponowienia', () => {
    const result = resolveOptions('\u001b[2J\u001b[H', { toolName: 'Bash' });
    expect(result).toMatchObject({ status: 'unreadable', retryable: true });
  });

  it('przetasowana numeracja: mapa oddaje cyfrę z tekstu, nie z pozycji', () => {
    const shuffled = reorderOptionLines(permissionDialog, [2, 0, 1]);
    const result = resolveOptions(shuffled, { toolName: 'Bash' });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.options[0]?.label).toBe(DENY_WITH_HINT);
    expect(result.digitByLabel.get(DENY_WITH_HINT)).toBe('3');
    expect(result.digitByLabel.get(ALLOW_ONCE)).toBe('1');
  });

  it('etykieta spoza ekranu nie ma cyfry — wołający nie ma czego wysłać', () => {
    const result = resolveOptions(permissionDialog, { toolName: 'Bash' });
    if (result.status !== 'ok') return expect.unreachable('powinno być ok');
    expect(result.digitByLabel.get('Zezwól')).toBeUndefined();
    expect(result.digitByLabel.has(ALLOW_ONCE.toUpperCase())).toBe(false);
  });
});

describe('resolveOptions — dialog bez odpowiednika w jsonl', () => {
  const OUTSIDE_JSONL: readonly [string, string, string | null][] = [
    ['zaufanie katalogu', trustDialog, 'trust'],
    ['zmiana modelu', modelSwitchDialog, 'model'],
    ['dialog zgody bez pendingu w jsonl', permissionDialog, null],
  ];

  for (const [name, screen, expectedKnown] of OUTSIDE_JSONL) {
    it(`${name} → no-jsonl, nigdy ok`, () => {
      /*
       * TEST OBOWIĄZKOWY. Status NIGDY nie jest `ok`: bez wpisu w jsonl nie ma czego
       * cross-checkować, więc karta nie jest kartą ZGODY — nawet gdy sygnatura pasuje.
       * `knownDialog` mówi tylko tyle, że wolno dla niej wystawić przycisk.
       */
      const result = resolveOptions(screen, null);
      expect(result.status).toBe('no-jsonl');
      if (result.status !== 'no-jsonl') return;
      expect(result.retryable).toBe(false);
      expect(result.knownDialog).toBe(expectedKnown);
    });
  }

  /*
   * REGRESJA: sygnatura zaufania nie może trzymać się WYŁĄCZNIE zdania „Do you trust the files
   * in this folder?”, którego CLI 2.1.293 nie wypisuje wcale (brzmienie w `dialog-trust-2.1.293.txt`)
   * — dialog stałby, a karta nie dostałaby przycisku, bo `matchKnownDialog` oddałoby `null`. Oba brzmienia są tu przypięte JAWNIE: skasowanie
   * któregokolwiek z wzorca to nawrót błędu (nowe brzmienie) albo utrata starego brzmienia, które
   * Rarog zakłada dla starszych wydań (zrzutu ani wersji CLI nie ma).
   */
  const TRUST_WORDINGS: readonly [string, string][] = [
    ['żywe (CLI 2.1.293)', 'Quick safety check: Is this a project you created or one you trust?'],
    ['starsze (bez zrzutu)', 'Do you trust the files in this folder?'],
  ];

  for (const [name, question] of TRUST_WORDINGS) {
    it(`sygnatura zaufania trafia w brzmienie: ${name}`, () => {
      // Zdanie liczy się wyłącznie w BLOKU dialogu: pod kreską, nad opcjami. Prawdziwe dialogi
      // zaufania mają kreskę (`dialog-trust.txt:5`, `dialog-trust-2.1.293.txt:1`).
      const options = '\n\n ❯ 1. Yes, I trust this folder\n   2. No, exit\n';
      const result = resolveOptions(`${'─'.repeat(40)}\n ${question}${options}`, null);
      expect(result.status).toBe('no-jsonl');
      if (result.status !== 'no-jsonl') return;
      expect(result.knownDialog).toBe('trust');
      // Bez kreski nad zdaniem bloku nie ma, a zdanie bez bloku nie rozpoznaje dialogu.
      const bare = resolveOptions(`${question}${options}`, null);
      expect(bare).toMatchObject({ status: 'no-jsonl', knownDialog: null, options: [] });
    });
  }

  it('rozpoznana sygnatura oddaje opcje z cyframi — to z nich powstaje przycisk', () => {
    const result = resolveOptions(trustDialog, null);
    expect(result.status).toBe('no-jsonl');
    if (result.status !== 'no-jsonl') return;
    expect(result.options.map((o) => [o.digit, o.label])).toEqual([
      ['1', 'Yes, I trust this folder'],
      ['2', 'No, exit'],
    ]);
  });

  it('dialog SPOZA listy nie oddaje ani jednej opcji, choć ekran parsuje się poprawnie', () => {
    /*
     * TEST OBOWIĄZKOWY. To jest cała granica: opcje wychodzą z tego modułu
     * WYŁĄCZNIE razem z rozpoznaniem. Gdyby wychodziły zawsze, wołający miałby z czego
     * zrobić przyciski do dowolnego cudzego dialogu.
     */
    expect(parseOptions(permissionDialog)?.options).toHaveLength(3);
    const result = resolveOptions(permissionDialog, null);
    expect(result.status).toBe('no-jsonl');
    if (result.status !== 'no-jsonl') return;
    expect(result.knownDialog).toBeNull();
    expect(result.options).toEqual([]);
  });

  it('zgoda na narzędzie bez pendingu niesie `questionForm.kind: tool` z flagami eskalacji', () => {
    /*
     * Uniwersalna karta. Zmierzone tego samego dnia na CLI 2.1.246: wpis
     * `tool_use` stojącego dialogu zgody NIE ISTNIEJE w jsonl aż do decyzji — czyli
     * `expected === null` przy dialogu `tool` to stan TRWAŁY, a nie wyścig, dokładnie jak
     * przy formularzu pytania. Karta powstaje z ekranu: treść i etykiety dosłownie, opcja
     * eskalująca z flagą `terminalOnly` (bez przycisku; bramka wysyłki w driverze).
     */
    const result = resolveOptions(permissionDialog, null);
    expect(result.status).toBe('no-jsonl');
    if (result.status !== 'no-jsonl') return;
    expect(result.questionForm?.kind).toBe('tool');
    expect(result.questionForm?.question).toContain('Do you want to proceed?');
    expect(result.questionForm?.options).toEqual([
      { digit: '1', label: 'Yes' },
      {
        digit: '2',
        label: "Yes, and don't ask again for pnpm commands in /Users/u/Projects/demo",
        terminalOnly: true,
      },
      { digit: '3', label: 'No, and tell Claude what to do differently (esc)' },
    ]);
  });

  it('apostrof typograficzny w „don’t ask again" nadal zapala `terminalOnly` (CLI 2.1.246)', () => {
    /*
     * Zrzut realnego panelu (`dialog-permission-subagent.txt`; apostrof zmierzony na CLI 2.1.246):
     * dialog zgody wywołany przez subagenta pisze opcję jako
     * „Yes, and don’t ask again for: cd *" — z U+2019, nie z `'`. Wzorzec eskalacji z samym prostym
     * apostrofem nie trafiłby w nią wcale, więc opcja TRWALE rozszerzająca uprawnienia jechałaby
     * na telefon bez `terminalOnly`, czyli z żywym przyciskiem.
     */
    const result = resolveOptions(subagentDialog, null);
    expect(result.status).toBe('no-jsonl');
    if (result.status !== 'no-jsonl') return;
    expect(result.questionForm?.kind).toBe('tool');
    expect(result.questionForm?.options).toEqual([
      { digit: '1', label: 'Yes' },
      { digit: '2', label: 'Yes, and don\u2019t ask again for: cd *', terminalOnly: true },
      { digit: '3', label: 'No' },
    ]);
  });

  it('ostrzeżenie CLI o `cd` przed gitem („…if you trust it") nie odbiera karcie przycisków', () => {
    /*
     * CLI 2.1.265 pod komendą z `cd` dopisuje „…can execute untrusted hooks… Approve only if you
     * trust it." Słowo „trust" zapaliłoby marker eskalacji TREŚCI i zwykła zgoda „Yes"/„No"
     * jechałaby na telefon jako karta bez przycisków. Ostrzeżenie zdejmuje ZAMKNIĘTA sygnatura `cdAdvisory`; reszta treści
     * (komenda, opis, linia `Ask rule …`) zostaje na karcie dosłownie.
     */
    const dialog = parseOptions(cdAdvisoryDialog);
    expect(dialog?.kind).toBe('tool');
    expect(dialog?.toolName).toBe('Bash');
    expect(dialog?.question).not.toBeNull();
    expect(dialog?.question?.question).toContain('cd /tmp && rm -rf gtest');
    expect(dialog?.question?.question).toContain('Approve only');
    expect(dialog?.options).toEqual([
      { digit: '1', label: 'Yes' },
      { digit: '2', label: 'No' },
    ]);

    const result = resolveOptions(cdAdvisoryDialog, null);
    expect(result.status).toBe('no-jsonl');
    if (result.status !== 'no-jsonl') return;
    expect(result.questionForm?.options).toEqual([
      { digit: '1', label: 'Yes' },
      { digit: '2', label: 'No' },
    ]);
  });

  it('samo zdanie o zaufaniu poza sygnaturą `cdAdvisory` dalej odbiera kartę (fail-closed)', () => {
    const screen = cdAdvisoryDialog.replace(
      /This command changes directory[\s\S]*?if you trust it\./,
      'Approve only if you trust this directory.',
    );
    expect(screen).toContain('trust this directory');
    const dialog = parseOptions(screen);
    expect(dialog?.kind).toBe('tool');
    expect(dialog?.question).toBeNull();
  });

  it('zgoda na `Edit`: ekran rysuje `⏺ Update(…)`, nazwę daje nagłówek „Edit file" — CLI 2.1.258', () => {
    /*
     * ZMIERZONE na CLI 2.1.258 (`measured/zgoda-edit-2.1.258.txt`): linia wywołania
     * niesie nazwę WYŚWIETLANĄ `Update`, hook i jsonl mówią `Edit`. Bez nagłówka w mapie
     * każda zgoda na edycję pliku kończyłaby się `mismatch/tool-name`. Opcja 2 („…for this session") jest
     * eskalacją i zostaje w terminalu; z telefonu idą tylko „Yes" i „No".
     */
    const live = read('measured/zgoda-edit-2.1.258.txt');
    const dialog = parseOptions(live);
    expect(dialog?.kind).toBe('tool');
    expect(dialog?.toolName).toBe('Edit');
    expect(dialog?.options.map((o) => o.digit)).toEqual(['1', '2', '3']);
    const result = resolveOptions(live, { toolName: 'Edit' });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.digitByLabel.get('Yes')).toBe('1');
    expect(result.digitByLabel.get('No')).toBe('3');
    const screenOnly = resolveOptions(live, null);
    if (screenOnly.status !== 'no-jsonl') throw new Error('nieosiągalne');
    expect(screenOnly.questionForm?.options.map((o) => o.terminalOnly === true))
      .toEqual([false, true, false]);
  });

  it('zgoda na `Edit` bez tytułu z mapy daje rozjazd — `Update` nie jest aliasem', () => {
    // Fail-closed zostaje: nazwa idzie WYŁĄCZNIE z tytułu bloku z mapy, nie z linii `⏺`. Ekran
    // z samym `⏺ Update(…)` i stopką zgody to rozjazd, a nazwy z ekranu nie ma wcale.
    const live = read('measured/zgoda-edit-2.1.258.txt').replace(' Edit file\n', ' Edited file\n');
    expect(resolveOptions(live, { toolName: 'Edit' })).toMatchObject({
      status: 'mismatch', reason: 'tool-name', screenToolName: null,
    });
  });

  it('zgoda na `Write`: nagłówek „Create file", linia `⏺ Write(…)` — CLI 2.1.258', () => {
    const live = read('measured/zgoda-write-2.1.258.txt');
    expect(parseOptions(live)?.toolName).toBe('Write');
    const result = resolveOptions(live, { toolName: 'Write' });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.digitByLabel.get('Yes')).toBe('1');
    expect(result.digitByLabel.get('No')).toBe('3');
  });

  it('zgoda na `Read`: nagłówek „Read file", linia `Read(…)` bez bulletu — CLI 2.1.278', () => {
    // ZMIERZONE na CLI 2.1.278: bez sygnatury nazwa z ekranu jest pusta i KAŻDA zgoda na odczyt
    // kończy się `mismatch/tool-name` (tak samo na 2.1.273).
    const live = read('dialog-permission-read-2.1.278.txt');
    expect(parseOptions(live)?.toolName).toBe('Read');
    const result = resolveOptions(live, { toolName: 'Read' });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.digitByLabel.get('Yes')).toBe('1');
    expect(result.digitByLabel.get('No')).toBe('3');
    // „Zatwierdź" celuje w jednorazowe „Yes"; zgoda na sesję ma WŁASNY przycisk.
    expect(affirmativeOption(result.options)?.digit).toBe('1');
    expect(alwaysOption(result.options)?.digit).toBe('2');
    // Inne narzędzie w jsonl to dalej rozjazd — nagłówek nie jest przepustką.
    expect(resolveOptions(live, { toolName: 'Bash' })).toMatchObject({
      status: 'mismatch', reason: 'tool-name', screenToolName: 'Read',
    });
  });

  it('zgoda SUBAGENTA na `Read`: sufiks „· from the Explore agent" nie gubi nazwy', () => {
    const live = read('dialog-permission-read-2.1.278.txt')
      .replace(' Read file\n', ' Read file · from the Explore agent\n');
    expect(parseOptions(live)?.toolName).toBe('Read');
  });

  it('nagłówek `Bash command (unsandboxed)` daje nazwę narzędzia — zrzut żywego panelu', () => {
    /*
     * ZMIERZONE na CLI 2.1.246 (`dialog-permission-unsandboxed.txt` jest zrzutem):
     * ponowienie komendy poza sandboksem rysuje nagłówek z sufiksem, a linii `⏺ Bash(…)`
     * nie ma na ekranie w ogóle — bez zdjęcia sufiksu zgoda z POPRAWNYM wpisem w jsonl
     * kończyłaby się rozjazdem nazwy i kartą zdegradowaną (`canAllow: false`).
     */
    const live = read('dialog-permission-unsandboxed.txt');
    const dialog = parseOptions(live);
    expect(dialog?.kind).toBe('tool');
    expect(dialog?.toolName).toBe('Bash');
    const result = resolveOptions(live, { toolName: 'Bash' });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.digitByLabel.get('Yes')).toBe('1');
    // Bez jsonl ta sama zgoda idzie kartą ekranową z flagą na opcji „always allow".
    const screenOnly = resolveOptions(live, null);
    if (screenOnly.status !== 'no-jsonl') throw new Error('nieosiągalne');
    expect(screenOnly.questionForm?.kind).toBe('tool');
    expect(screenOnly.questionForm?.options.map((o) => o.terminalOnly === true))
      .toEqual([false, true, false]);
  });

  it('zgoda MCP: ekran niesie SERWER, nazwa kanoniczna z jsonl — zrzuty żywe (CLI 2.1.258)', () => {
    /*
     * ZMIERZONE na CLI 2.1.258, na dwóch serwerach: dialog MCP ma nagłówek ramki
     * „Tool use", a nazwę stawia w linii `catalog — Get Project Tree Layout Tool: (MCP)` — czyli
     * serwer plus LUDZKI tytuł, nigdy identyfikator. Linii `⏺ mcp__…(` nie ma na ekranie w ogóle,
     * więc porównanie nazw dałoby przy KAŻDEJ zgodzie MCP `mismatch/tool-name` (czerwona karta
     * bez przycisków). Cross-check porównuje serwer; na kartę i do dziennika idzie
     * nazwa kanoniczna z jsonl.
     */
    const catalog = read('dialog-permission-mcp.txt');
    const dialog = parseOptions(catalog);
    expect(dialog?.kind).toBe('tool');
    // Identyfikatora na ekranie nie ma — i nie udajemy, że jest.
    expect(dialog?.toolName).toBeNull();
    expect(dialog?.mcpServer).toBe('catalog');
    const result = resolveOptions(catalog, {
      toolName: 'mcp__catalog__catalog_get_project_tree_layout',
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.toolName).toBe('mcp__catalog__catalog_get_project_tree_layout');
    expect(result.options.map((o) => [o.digit, o.label])).toEqual([['1', 'Yes'], ['2', 'No']]);

    // Drugi serwer, inny kształt tytułu („List extensions" zamiast „Get Project Tree Layout"):
    // sygnatura ma być niezależna od serwera, nie dopasowana do jednego pomiaru.
    const supabase = read('dialog-permission-mcp-supabase.txt');
    expect(parseOptions(supabase)?.mcpServer).toBe('supabase');
    expect(resolveOptions(supabase, { toolName: 'mcp__supabase__list_extensions' }).status)
      .toBe('ok');
  });

  it('zgoda MCP: inny serwer, inne narzędzie i brak nagłówka MCP zostają fail-closed', () => {
    const catalog = read('dialog-permission-mcp.txt');
    // Serwer z jsonl nie zgadza się z ekranem — rozjazd, nie „przecież obie są MCP".
    const foreign = resolveOptions(catalog, { toolName: 'mcp__supabase__list_extensions' });
    expect(foreign).toMatchObject({ status: 'mismatch', reason: 'tool-name' });
    // Nazwa spoza MCP na ekranie MCP: `toolName` z ekranu jest `null`, więc rozjazd.
    expect(resolveOptions(catalog, { toolName: 'Bash' }))
      .toMatchObject({ status: 'mismatch', reason: 'tool-name' });
    // I odwrotnie: zgoda na `Bash` nie ma prawa przejść jako narzędzie MCP.
    expect(resolveOptions(permissionDialog, { toolName: 'mcp__catalog__catalog_get_task' }))
      .toMatchObject({ status: 'mismatch', reason: 'tool-name' });
    expect(parseOptions(permissionDialog)?.mcpServer).toBeNull();
  });

  it('`mcpServerOf` czyta serwer tylko z pełnego `mcp__<serwer>__<narzędzie>`', () => {
    expect(mcpServerOf('mcp__catalog__catalog_get_project_tree_layout')).toBe('catalog');
    expect(mcpServerOf('mcp__claude-in-chrome__navigate')).toBe('claude-in-chrome');
    expect(mcpServerOf('Bash')).toBeNull();
    expect(mcpServerOf('mcp__catalog')).toBeNull();
    expect(mcpServerOf('mcp__catalog__')).toBeNull();
  });

  it('reguła `Ask` w trybie auto: „Yes, and allow … commands" niesie terminalOnly — rekonstrukcja', () => {
    /*
     * Rekonstrukcja `dialog-permission-ask-rule-auto.txt` (wersja CLI niezapisana): opcja 2
     * dopisuje trwałe reguły uprawnień bez słów „don't ask again"/„always". Bez członu
     * `yes, and allow` w `OPTION_ESCALATION_PATTERN` jechałaby na kartę jako zwykła zgoda.
     */
    const live = read('dialog-permission-ask-rule-auto.txt');
    const dialog = parseOptions(live);
    expect(dialog?.kind).toBe('tool');
    expect(dialog?.toolName).toBe('Bash');
    expect(dialog?.options.map((o) => o.digit)).toEqual(['1', '2', '3']);
    expect(dialog?.options[1]?.label).toMatch(/^Yes, and allow \/private\/tmp\/claude access/);
    const screenOnly = resolveOptions(live, null);
    if (screenOnly.status !== 'no-jsonl') throw new Error('nieosiągalne');
    expect(screenOnly.questionForm?.options.map((o) => o.terminalOnly === true))
      .toEqual([false, true, false]);
  });

  it('formularz z preview (side-by-side) nie skleja etykiet z ramką podglądu — zrzut żywy', () => {
    /*
     * CLI 2.1.246: `AskUserQuestion` z polem `preview` rysuje ramkę OBOK opcji, więc etykieta
     * czytana do końca linii niosłaby kawałek podglądu — a podgląd zmienia się z ruchem
     * podświetlenia, więc każdy odczyt dałby INNĄ etykietę, a odpowiedź nie znalazłaby opcji.
     */
    const live = read('dialog-askuserquestion-preview.txt');
    const dialog = parseOptions(live);
    expect(dialog?.kind).toBe('question');
    expect(dialog?.options).toEqual([
      { digit: '1', label: 'Płaski zasobowy' },
      { digit: '2', label: 'Zagnieżdżony po projekcie' },
      { digit: '3', label: 'Wersjonowany RPC' },
    ]);
    expect(dialog?.question?.question).toContain('Który schemat ścieżek URL');
    // Ruch podświetlenia podmienia treść podglądu — etykiety mają zostać IDENTYCZNE,
    // bo na ich stałości stoi `answerQuestion` i `#digitStillHolds`.
    const shifted = live
      .replace('/api/sessions/42/messages', '/api/projects/rarog/sessions')
      .replace('❯ 1.', '  1.').replace('  2. Zagnieżdżony', '❯ 2. Zagnieżdżony');
    expect(parseOptions(shifted)?.options).toEqual(dialog?.options);
  });

  it('formularz z preview: submit `digit-enter`, podświetlenie z `❯`, bez trybu notatki', () => {
    /*
     * Pomiar na żywych panelach, CLI 2.1.246: w wariancie z preview cyfra TYLKO
     * przesuwa podświetlenie — zatwierdza dopiero `enter`, dosłany po weryfikacji
     * (`form-submit.ts`). Formularz bez preview zatwierdza samą cyfrą i ma zostać
     * przy `'digit'` — dosłanie tam entera byłoby drugim klawiszem w cudzy ekran.
     */
    const live = parseOptions(read('dialog-askuserquestion-preview.txt'));
    expect(live?.submit).toBe('digit-enter');
    expect(live?.selected).toEqual({ digit: '1', label: 'Płaski zasobowy' });
    expect(live?.notesEditing).toBe(false);
  });

  it('ŻYWY render 2.1.246 bez preview: submit `digit` — zrzut z pomiaru', () => {
    /*
     * Odporność na fałszywy `digit-enter` sprawdzona na zrzucie żywego panelu, nie tylko na
     * rekonstrukcji (pomiar na CLI 2.1.246): stopka bez
     * `n to add notes`, opcje z opisami, `4. Type something.` i `5. Chat about this` za kreską.
     */
    const dialog = parseOptions(read('dialog-askuserquestion-2126.txt'));
    expect(dialog?.kind).toBe('question');
    expect(dialog?.submit).toBe('digit');
    expect(dialog?.notesEditing).toBe(false);
    expect(dialog?.selected).toEqual({ digit: '1', label: 'Nie, przerwij' });
    expect(dialog?.question?.question).toBe('Czy kontynuować pomiar A?');
  });

  it('markery `ctrl+g` i `n to add notes` POZA stopką nie zmieniają niczego', () => {
    // Frazy wypisane w TREŚCI formularza (pytanie cytujące instrukcję, opis opcji) nie mają
    // prawa ani zdegradować karty do fallbacku, ani przełączyć trybu zatwierdzania —
    // markery czytamy WYŁĄCZNIE ze stopki regionu.
    const poisoned = read('dialog-askuserquestion-2126.txt')
      .replace('Czy kontynuować pomiar A?', 'Czy kontynuować pomiar A (ctrl+g w instrukcji)?')
      .replace('Przerwij pomiar A.', 'Przerwij pomiar A — n to add notes w opisie.');
    const dialog = parseOptions(poisoned);
    expect(dialog?.kind).toBe('question');
    expect(dialog?.submit).toBe('digit');
    expect(dialog?.notesEditing).toBe(false);
    expect(dialog?.question).not.toBeNull();
  });

  it('formularz bez preview: submit `digit`; ramka okalająca nie udaje podglądu', () => {
    // Stary render okala CAŁY formularz ramką `│ … │` — krawędzie zdejmuje `unbox`,
    // więc nie mają prawa włączyć wariantu `digit-enter` ani zgubić podświetlenia.
    const dialog = parseOptions(questionDialog);
    expect(dialog?.kind).toBe('question');
    expect(dialog?.submit).toBe('digit');
    expect(dialog?.selected).toEqual({ digit: '1', label: 'Zapis atomowy (tmp + rename)' });
  });

  it('dwa markery `❯` w regionie = `selected: null` — nie wiadomo, co zatwierdziłby enter', () => {
    const doubled = read('dialog-askuserquestion-preview.txt')
      .replace('  2. Zagnieżdżony', '❯ 2. Zagnieżdżony');
    const dialog = parseOptions(doubled);
    expect(dialog?.kind).toBe('question');
    expect(dialog?.selected).toBeNull();
  });

  it('`❯` composera (bez cyfry z kropką) nie liczy się jako podświetlenie', () => {
    // Echo promptu i composer też zaczynają się od `❯` — dowodem jest wyłącznie
    // `❯ <cyfra>.` w regionie dialogu.
    const noSelection = read('dialog-askuserquestion-preview.txt').replace('❯ 1.', '  1.');
    const dialog = parseOptions(noSelection);
    expect(dialog?.kind).toBe('question');
    expect(dialog?.selected).toBeNull();
  });

  it('tryb edycji notatki: karta bez przycisków, flaga zapalona — zrzut żywy', () => {
    /*
     * Pomiar na CLI 2.1.246: po `n` cyfra wpisuje się do pola notatki jako TEKST
     * („Notes: 5"), a jedyną sygnaturą trybu jest `ctrl+g` w stopce (poza nim nie występuje wcale).
     * `question: null` = fallback „odpowiedz w terminalu"; osobna bramka w driverze
     * (`#digitStillHolds`) odmawia też cyfry z karty, która zdążyła powstać wcześniej.
     */
    const dialog = parseOptions(read('dialog-askuserquestion-notes.txt'));
    expect(dialog?.kind).toBe('question');
    expect(dialog?.notesEditing).toBe(true);
    expect(dialog?.question).toBeNull();
    expect(dialog?.selected).toEqual({ digit: '2', label: 'Wariant Y' });
  });

  it('zgoda na narzędzie i dialog potwierdzenia zostają przy `digit`', () => {
    expect(parseOptions(permissionDialog)?.submit).toBe('digit');
    expect(parseOptions(effortDialog)?.submit).toBe('digit');
  });

  it('`resolveOptions` niesie tryb zatwierdzania na obu ścieżkach', () => {
    const live = read('dialog-askuserquestion-preview.txt');
    const noJsonl = resolveOptions(live, null);
    expect(noJsonl.status).toBe('no-jsonl');
    if (noJsonl.status !== 'no-jsonl') return;
    expect(noJsonl.questionForm?.submit).toBe('digit-enter');
    const ok = resolveOptions(live, { toolName: ASK_USER_QUESTION_TOOL });
    expect(ok.status).toBe('ok');
    if (ok.status !== 'ok') return;
    expect(ok.submit).toBe('digit-enter');
    // Treść pytania Z EKRANU jedzie też ścieżką jsonl/hooka — bez niej
    // weryfikacja przed enterem nie umie dowieść „to samo pytanie".
    expect(ok.question).toBe('Który schemat ścieżek URL wolisz dla API Raroga?');
  });

  it('treść karty `tool` dłuższa niż sufit = karta bez przycisków, nie przycięta', () => {
    // Przycięta treść z przyciskami pozwoliłaby zatwierdzić koniec komendy, którego karta nie pokazuje
    // (np. `rm -rf ~/Pictures` po 22 liniach `printf`). Bez formularza karta spada do wycinka
    // i „zatwierdź w terminalu".
    const longLine = 'x'.repeat(TOOL_QUESTION_MAX_CHARS + 500);
    const inflated = permissionDialog.replace(
      'Do you want to proceed?', `${longLine}\n│ Do you want to proceed?`,
    );
    const result = resolveOptions(inflated, null);
    expect(result.status).toBe('no-jsonl');
    if (result.status !== 'no-jsonl') return;
    expect(result.questionForm).toBeNull();
    expect(result.options).toEqual([]);
  });

  it('nieczytelny ekran bez pendingu → no-jsonl bez sygnatury, nie wyjątek', () => {
    expect(resolveOptions('   \n\n', null)).toEqual({
      status: 'no-jsonl', retryable: false, knownDialog: null, dialogIdentity: null, questionForm: null, options: [],
    });
  });

  it('formularz pytania bez pendingu niesie `questionForm` zbudowany Z EKRANU', () => {
    /*
     * Claude Code przed 2.1.267 zapisywał `tool_use` pytania do jsonl dopiero PO rozstrzygnięciu
     * dialogu. Od CLI 2.1.267 wpis stoi tam nad STOJĄCYM dialogiem, więc `no-jsonl` znaczy „follower jeszcze
     * nie dogonił" albo „sesja nie ma transkryptu" — i w obu sytuacjach ekran jest jedynym
     * źródłem karty. To nie jest generyczne klikanie
     * w cudze dialogi: sygnatura stopki jest zamknięta, a cyfry idą po etykietach.
     */
    const result = resolveOptions(questionDialog, null);
    expect(result.status).toBe('no-jsonl');
    if (result.status !== 'no-jsonl') return;
    expect(result.knownDialog).toBeNull();
    expect(result.options).toEqual([]);
    expect(result.questionForm?.question).toContain('Który wariant zapisu wybrać?');
    expect(result.questionForm?.options.map((o) => [o.digit, o.label])).toEqual([
      ['1', 'Zapis atomowy (tmp + rename)'],
      ['2', 'Zapis w miejscu'],
    ]);
  });

  it('formularz multi-select (`space to …`) NIE dostaje `questionForm` — jedna cyfra to za mało', () => {
    const multi = questionDialog.replace(
      '↑/↓ to navigate · enter to select',
      '↑/↓ to navigate · space to toggle · enter to select',
    );
    const result = resolveOptions(multi, null);
    expect(result.status).toBe('no-jsonl');
    if (result.status !== 'no-jsonl') return;
    expect(result.questionForm).toBeNull();
  });

  it('dialog `confirm` bez pendingu niesie formularz z DOSŁOWNĄ treścią (silnik dialogów)', () => {
    const result = resolveOptions(effortDialog, null);
    expect(result.status).toBe('no-jsonl');
    if (result.status !== 'no-jsonl') return;
    expect(result.knownDialog).toBeNull();
    // `options` poza formularzem zostają puste — przycisk „Zatwierdź" (affirmative) nie ma
    // z czego powstać; jedyną drogą decyzji jest karta z jawnymi opcjami.
    expect(result.options).toEqual([]);
    expect(result.questionForm?.kind).toBe('confirm');
    expect(result.questionForm?.question).toContain('Change effort level?');
    expect(result.questionForm?.options.map((o) => [o.digit, o.label])).toEqual([
      ['1', 'Yes, switch to high'],
      ['2', 'No, go back'],
    ]);
  });

  it('dialog z sygnatury zamkniętej listy (model) zostaje przy SWOJEJ karcie — bez formularza', () => {
    const result = resolveOptions(modelSwitchDialog, null);
    expect(result.status).toBe('no-jsonl');
    if (result.status !== 'no-jsonl') return;
    expect(result.knownDialog).toBe('model');
    expect(result.questionForm).toBeNull();
    expect(result.options.length).toBeGreaterThan(0);
  });

  it('jsonl czeka na Bash, ekran ma confirm → mismatch po rodzaju (fail-closed)', () => {
    const result = resolveOptions(effortDialog, { toolName: 'Bash' });
    expect(result).toMatchObject({ status: 'mismatch', reason: 'kind', screenKind: 'confirm' });
  });
});

describe('parseOptions — kontrakt typu', () => {
  it('nie zwraca z ekranu NIC poza kind, nazwami narzędzia i opcjami', () => {
    // Pola o dialogu: tryb zatwierdzania, podświetlona OPCJA, tryb notatki, `multiSelect`, `mcpServer`
    // (sam serwer z nagłówka MCP) — wszystkie zbudowane z tych samych danych co opcje, żadne nie niesie
    // treści ekranu spoza etykiet i opisów opcji. `operation` — linie ramki operacji z SAMEGO dialogu
    // (ta sama klasa treści co `question` karty uniwersalnej); służy porównaniom tożsamości i karcie tej
    // sesji, nie dziennikowi ani logom. `bodyPrint` — SKRÓT treści dialogu do kontroli przed cyfrą, także
    // skrót bloku pytania, potwierdzenia i znanego dialogu (skrót, nie treść). `terminalDialog` —
    // identyfikator z zamkniętej listy `TERMINAL_DIALOGS`, i `title` — pierwsza linia treści dialogu za
    // kreską (ta sama klasa co `question`; tylko do odcisku karty i rozpoznania pauzy). Blok dialogu:
    // `identity` (rodzaj tożsamości i nazwa z bloku), `knownDialog` (identyfikator z zamkniętej listy)
    // i `mcpTool` (tytuł narzędzia MCP z nagłówka, ta sama klasa co `mcpServer`); nazwa narzędzia to jedno
    // pole `toolName`. `planFile` — nazwa pliku planu ze stopki dialogu `ExitPlanMode` (tylko nazwa, do
    // cross-checku zrzutu hooka).
    const dialog = parseOptions(permissionDialog);
    expect(dialog).not.toBeNull();
    expect(Object.keys(dialog as ScreenDialog).sort()).toEqual([
      'bodyPrint', 'identity', 'kind', 'knownDialog', 'mcpServer', 'mcpTool', 'multiSelect', 'notesEditing',
      'operation', 'options', 'planFile', 'question', 'selected', 'submit', 'terminalDialog', 'title', 'toolName',
    ]);
    // Dialog zgody nie ma opisów ani checkboxów pod opcjami, więc pola addytywne są NIEOBECNE
    // — `undefined` w kluczu znaczyłoby „opis pusty", a to nie to samo co „opisu nie było".
    expect(Object.keys(dialog?.options[0] ?? {}).sort()).toEqual(['digit', 'label']);
  });
});

// ---------------------------------------------------------------------------
// ZRZUT Z ŻYWEGO PANELU — regresja, której rekonstrukcje nie łapią
// ---------------------------------------------------------------------------

describe('parseOptions na EKRANIE Z ŻYWEGO PANELU', () => {
  const liveQuestion = read('dialog-askuserquestion-live.txt');

  it('widzi WSZYSTKIE opcje, mimo poziomej kreski w środku listy', () => {
    /*
     * Zmierzone w `rarog-spike` (zrzut `dialog-askuserquestion-live.txt`, wersja CLI niezapisana; ten sam
     * separator w `measured/pytanie-jednokrotne-2.1.293.txt`, CLI 2.1.293): Claude Code rysuje separator
     * między „3. Type something." a „4. Chat about this". Regionem „za ostatnią kreską" parser
     * widział wtedy JEDNĄ opcję z czterech — a `answerQuestion('Wariant B')` kończyło się
     * fail-closed („nie wiem, która opcja odpowiada tej decyzji") i zgoda z telefonu po prostu
     * NIE DZIAŁAŁA.
     *
     * Rekonstrukcje fixture'ów tego nie łapały, bo nikt nie zgadłby separatora w środku listy.
     */
    const dialog = parseOptions(liveQuestion);
    expect(dialog?.kind).toBe('question');
    expect(dialog?.options).toEqual([
      { digit: '1', label: 'Wariant A', description: 'Wybierz wariant A' },
      { digit: '2', label: 'Wariant B', description: 'Wybierz wariant B' },
      { digit: '3', label: 'Type something.' },
      { digit: '4', label: 'Chat about this' },
    ]);
  });

  it('cross-check z jsonl przepuszcza ten ekran i oddaje cyfrę po ETYKIECIE', () => {
    const resolution = resolveOptions(liveQuestion, { toolName: ASK_USER_QUESTION_TOOL });
    expect(resolution.status).toBe('ok');
    if (resolution.status !== 'ok') return;
    // Cyfra bierze się z TEKSTU opcji, nie z jej pozycji — to jest cała reguła.
    expect(resolution.digitByLabel.get(canonicalLabel('Wariant B'))).toBe('2');
  });

  it('niepełna lista opcji (bez jedynki) to `null`, a nie zgadywanie', () => {
    // Ekran przewinięty tak, że opcji 1 nie widać: cyfra z telefonu trafiłaby w opcję,
    // której użytkownik nigdy nie zobaczył. Fail-closed jest tu jedyną poprawną odpowiedzią.
    const cut = liveQuestion.replace('1. Wariant A', 'Wariant A');
    expect(parseOptions(cut)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ZRZUT Z ŻYWEJ AWARII (wersja CLI niezapisana) — scrollback z listą numerowaną nad formularzem
// ---------------------------------------------------------------------------

describe('parseOptions na EKRANIE Z ŻYWEJ AWARII (scrollback + kreska w liście)', () => {
  const scrollbackQuestion = read('dialog-askuserquestion-scrollback.txt');

  it('widzi pełny formularz 1…5, choć scrollback nad nim niesie WŁASNĄ listę 1./2./3.', () => {
    /*
     * Ekran z żywego panelu, na którym naiwny region zawodzi: wąski (za kreską w środku listy)
     * widzi samą opcję 5, a szeroki ogon łapie listę numerowaną z wiadomości agenta w scrollbacku
     * i przez duplikaty cyfr uznaje CAŁY ekran za sprzeczny. Kandydat poszerzany kreska po kresce kończy się na górnej kresce formularza
     * — dokładnie tam, gdzie kończy się dialog.
     */
    const dialog = parseOptions(scrollbackQuestion);
    expect(dialog?.kind).toBe('question');
    expect(dialog?.options.map((o) => o.digit)).toEqual(['1', '2', '3', '4', '5']);
    expect(dialog?.options[0]?.label).toBe('A. Plik lokalny, SQLite (Rekomendacja)');
    expect(dialog?.options[4]?.label).toBe('Chat about this');
    // Lista ze scrollbacku NIE przecieka do opcji.
    expect(dialog?.options.map((o) => o.label)).not.toContain(
      'Uruchom ponownie aplikację notatek (ustawienia są w pliku app.json).',
    );
    // Formularz pytania nie ma nazwy w bloku.
    expect(dialog).toMatchObject({ toolName: null, identity: { kind: 'form' } });
  });

  it('cross-check z jsonl przepuszcza ten ekran (karta pytania z pięcioma cyframi)', () => {
    const resolution = resolveOptions(scrollbackQuestion, { toolName: ASK_USER_QUESTION_TOOL });
    expect(resolution.status).toBe('ok');
    if (resolution.status !== 'ok') return;
    expect(resolution.kind).toBe('question');
    expect(resolution.digitByLabel.get(canonicalLabel('Chat about this'))).toBe('5');
  });

  it('stare `⏺ Edit(…)` w scrollbacku nie unieważnia formularza pytania', () => {
    const withStaleTool = `⏺ Edit(docs/decyzje.md)\n${scrollbackQuestion}`;
    const resolution = resolveOptions(withStaleTool, { toolName: ASK_USER_QUESTION_TOOL });
    expect(resolution.status).toBe('ok');
  });

  it('bez pendingu ten ekran daje `questionForm` z nagłówkiem i treścią pytania', () => {
    const result = resolveOptions(scrollbackQuestion, null);
    expect(result.status).toBe('no-jsonl');
    if (result.status !== 'no-jsonl') return;
    expect(result.options).toEqual([]);
    // Zakładka `☐ Architektura` staje się nagłówkiem, a linia pytania — treścią (1:1 z tym,
    // co wpisał autor pytania w input narzędzia).
    expect(result.questionForm?.header).toBe('Architektura');
    // Oczekiwana treść czytana z nagrania (linia pod zakładką), nie literałem: układ ekranu jest 1:1 z żywej awarii.
    const question = scrollbackQuestion.split('\n').find((line) => line.startsWith('Który sposób zapisu notatek'));
    expect(question).toBeDefined();
    expect(result.questionForm?.question).toBe(question);
    expect(result.questionForm?.options.map((o) => o.digit)).toEqual(['1', '2', '3', '4', '5']);
  });
});

// ---------------------------------------------------------------------------
// REKONSTRUKCJA ZRZUTU Z ŻYWEGO EKRANU (iPad, CLI 2.1.246) — formularz WIELOKROTNEGO wyboru
// ---------------------------------------------------------------------------

describe('parseOptions na formularzu multiSelect (pasek zakładek, checkboxy, opisy)', () => {
  const multiQuestion = read('dialog-askuserquestion-multi.txt');
  /*
   * Wariant JEDNOKROTNY tego samego renderu: bez checkboxów ORAZ bez „✔ Submit" w pasku,
   * czyli formularz JEDNOPYTANIOWY — taki pasek ma goły `☐ Nazwa`. Wariant „jednokrotny
   * z Submitem" (zakładka formularza wielopytaniowego) jest zmierzony osobno, na własnych
   * fixture'ach `dialog-askuserquestion-multiq-*` (CLI 2.1.257).
   */
  const single = multiQuestion
    .replace(/\[[ ✔]\] /g, '')
    .replace('← ☒ Dodatki ✔ Submit →', '← ☐ Dodatki →');

  it('checkbox jest STANEM opcji, nie częścią etykiety — cyfra idzie po tekście bez niego', () => {
    /*
     * Zrzut z CLI 2.1.246: linia opcji brzmi `1. [✔] Posypka` (niezaznaczona `1. [ ] Posypka`
     * w `measured/multiselect-2.1.258.txt`, CLI 2.1.258). Checkbox w etykiecie dałby na karcie
     * „[✔] Posypka" (śmieć), a klucz mapy `etykieta → cyfra` zmieniałby się przy KAŻDYM
     * zaznaczeniu w terminalu — wybór po tekście przestałby trafiać w cokolwiek.
     */
    const dialog = parseOptions(multiQuestion);
    expect(dialog?.kind).toBe('question');
    expect(dialog?.options).toEqual([
      { digit: '1', label: 'Posypka', checked: true, description: 'Kolorowa' },
      { digit: '2', label: 'Polewa', checked: true, description: 'Czekoladowa' },
      { digit: '3', label: 'Bita śmietana', checked: false, description: 'Domowa' },
      { digit: '4', label: 'Type something', checked: false },
      { digit: '5', label: 'Chat about this' },
    ]);
  });

  it('„Submit" pod ostatnią pozycją to chrome formularza, nie opis i nie opcja', () => {
    const dialog = parseOptions(multiQuestion);
    expect(dialog?.options.map((o) => o.label)).not.toContain('Submit');
    expect(dialog?.options.find((o) => o.digit === '4')?.description).toBeUndefined();
  });

  it('checkboxy w liniach opcji = multiSelect, a multiSelect = karta BEZ przycisków', () => {
    /*
     * Stopki `space to …`, po której starsze CLI dawało poznać multi-select, ten ekran
     * NIE MA — została po niej wyłącznie sygnatura z checkboxów. Bez niej parser widział
     * formularz jednokrotny i karta mówiła „Tapnięcie wysyła odpowiedź", choć jedna cyfra
     * nie odpowiada na nic: zaznaczenie i „Submit" to dwa osobne kroki.
     */
    const dialog = parseOptions(multiQuestion);
    expect(multiQuestion.toLowerCase()).not.toContain('space to');
    expect(dialog?.multiSelect).toBe(true);
    expect(dialog?.question).toBeNull();
  });

  it('bez pendingu formularz multiSelect NIE dostaje `questionForm` ani opcji', () => {
    const result = resolveOptions(multiQuestion, null);
    expect(result.status).toBe('no-jsonl');
    if (result.status !== 'no-jsonl') return;
    expect(result.questionForm).toBeNull();
    expect(result.options).toEqual([]);
    expect(result.knownDialog).toBeNull();
  });

  it('z pendingiem AskUserQuestion formularz multiSelect kończy się fail-closed', () => {
    // Ścieżka jsonl/hooka: zrzut narzędzia mówi `AskUserQuestion`, a ekran jest formularzem
    // wielokrotnym — cyfra nie ma prawa wyjść, więc rozjazd jest OD RAZU, bez ponawiania.
    const result = resolveOptions(multiQuestion, { toolName: ASK_USER_QUESTION_TOOL });
    expect(result).toMatchObject({
      status: 'mismatch', retryable: false, reason: 'multi-select', screenKind: 'question',
    });
  });

  it('pasek zakładek `← ☐ Dodatki →` daje nagłówek i ZNIKA z treści pytania', () => {
    /*
     * Ten sam ekran bez checkboxów, czyli formularz JEDNOKROTNY z nowym paskiem zakładek
     * (pasek nad pytaniem jednokrotnym: fixture `measured/wielopytaniowy-jednokrotne-2.1.293.txt`).
     * Wzorzec nagłówka, który wymaga glifu na POCZĄTKU linii, wpuszcza całą linię paska — ze strzałkami —
     * do treści pytania i karta na telefonie zaczyna się od chrome'u TUI.
     */
    const dialog = parseOptions(single);
    expect(dialog?.multiSelect).toBe(false);
    expect(dialog?.question?.header).toBe('Dodatki');
    expect(dialog?.question?.question).toBe('Które dodatki do lodów?');
    expect(dialog?.question?.question).not.toContain('←');
    expect(dialog?.question?.question).not.toContain('☐');
  });

  it('formularz jednokrotny z tego samego ekranu ma opisy i JEDZIE na kartę', () => {
    const result = resolveOptions(single, null);
    expect(result.status).toBe('no-jsonl');
    if (result.status !== 'no-jsonl') return;
    expect(result.questionForm?.header).toBe('Dodatki');
    expect(result.questionForm?.options.map((o) => [o.label, o.description])).toEqual([
      ['Posypka', 'Kolorowa'],
      ['Polewa', 'Czekoladowa'],
      ['Bita śmietana', 'Domowa'],
      ['Type something', undefined],
      ['Chat about this', undefined],
    ]);
  });

  it('stary nagłówek `☐ Motyw` (bez strzałek) dalej działa', () => {
    const old = multiQuestion
      .replace(/\[[ ✔]\] /g, '')
      .replace('← ☒ Dodatki ✔ Submit →', '☐ Motyw');
    expect(parseOptions(old)?.question?.header).toBe('Motyw');
  });

  it('checkbox GOŁYM glifem (`1. ☑ Posypka`) też znaczy multiSelect', () => {
    /*
     * Sygnatura nie może stać na jednej klasie glifów — checkboxie W NAWIASACH. Ten sam render
     * rysuje `☐☑☒` w pasku zakładek, więc checkbox w tej postaci jest w pełni realny, a rozjazd
     * byłby fail-OPEN: formularz wielokrotny wracałby do karty z przyciskami i „Tapnięcie
     * wysyła odpowiedź". Etykieta ma przy tym zostać BEZ glifu — inaczej klucz mapy
     * `etykieta → cyfra` zmieniałby się przy każdym zaznaczeniu w terminalu.
     */
    const glyphs = multiQuestion.replace(/\[✔\] /g, '☑ ').replace(/\[ \] /g, '☐ ');
    const dialog = parseOptions(glyphs);
    expect(dialog?.multiSelect).toBe(true);
    expect(dialog?.question).toBeNull();
    expect(dialog?.options.slice(0, 3)).toEqual([
      { digit: '1', label: 'Posypka', checked: true, description: 'Kolorowa' },
      { digit: '2', label: 'Polewa', checked: true, description: 'Czekoladowa' },
      { digit: '3', label: 'Bita śmietana', checked: false, description: 'Domowa' },
    ]);
  });

  it('samo „✔ Submit" w pasku zakładek NIE wystarczy za sygnaturę multiSelect', () => {
    /*
     * Pomiar na żywo (CLI 2.1.257, `dialog-askuserquestion-multiq-tab1-jednokrotne.txt`): pasek
     * z „✔ Submit" rysuje KAŻDY formularz z więcej niż jednym pytaniem, także wtedy, gdy każde
     * pytanie jest jednokrotne. Sama ta sygnatura zabrałaby więc kartę wszystkim zakładkom.
     *
     * Liczy się tylko razem z drugim dowodem — checkboxem w linii opcji albo pozycją
     * „Submit"/„Next" pod ostatnią opcją. Tu nie ma ani jednego z nich.
     */
    const barOnly = multiQuestion
      .replace(/\[[ ✔]\] /g, '')
      .replace(/^ +Submit$/m, '');
    expect(barOnly).toContain('✔ Submit');
    const dialog = parseOptions(barOnly);
    expect(dialog?.options.every((o) => o.checked === undefined)).toBe(true);
    expect(dialog?.multiSelect).toBe(false);
    expect(dialog?.question?.question).toBe('Które dodatki do lodów?');
  });

  it('pasek z „✔ Submit" RAZEM z pozycją „Submit" pod listą dalej znaczy multiSelect', () => {
    // Drugi dowód sygnatury nr 2: ten sam ekran bez checkboxów, ale z zachowaną pozycją
    // „Submit" pod ostatnią opcją (glif checkboxa mógł się zmienić — fail-closed zostaje).
    const noBoxes = multiQuestion.replace(/\[[ ✔]\] /g, '');
    expect(noBoxes).toContain('✔ Submit');
    const dialog = parseOptions(noBoxes);
    expect(dialog?.options.every((o) => o.checked === undefined)).toBe(true);
    expect(dialog?.multiSelect).toBe(true);
    expect(dialog?.question).toBeNull();
  });

  it('pasek z DWIEMA zakładkami nie wkłada cudzego pytania do nagłówka', () => {
    /*
     * `← ☒ Dodatki ☐ Kolor →`: wzorzec czytający ogon linii do końca dałby
     * `header: "Dodatki ☐ Kolor"` — nazwa CUDZEGO pytania razem z glifem TUI. Aktywnej
     * zakładki nikt nie zmierzył, więc fail-closed jest tu PUSTY nagłówek: linia dalej
     * znika z treści (to JEST pasek), a właściwe zdanie niesie sama treść pytania.
     */
    const twoTabs = single.replace('← ☐ Dodatki →', '← ☒ Dodatki ☐ Kolor →');
    const dialog = parseOptions(twoTabs);
    expect(dialog?.question?.header).toBe('');
    expect(dialog?.question?.question).toBe('Które dodatki do lodów?');
    expect(dialog?.question?.question).not.toContain('Kolor');
  });

  it('linia NIEWCIĘTA pod ostatnią opcją nie staje się jej opisem', () => {
    /*
     * Opis poznaje się po WCIĘCIU głębszym niż cyfra opcji — inaczej granicą byłaby wyłącznie
     * lista brzmień stopki (`FORM_CHROME_PATTERN`), a każda nowa stopka CLI jechałaby na kartę
     * jako zdanie, którego autor pytania nie napisał. Tu: stopka bez znanej frazy, bez pustej
     * linii nad sobą, na wcięciu paska (kolumna 1).
     */
    const oddFooter = single
      .replace('   5. Chat about this\n', '   5. Chat about this\n Wybierz i naciśnij co trzeba\n');
    expect(oddFooter).toContain('Wybierz i naciśnij co trzeba');
    const dialog = parseOptions(oddFooter);
    expect(dialog?.kind).toBe('question');
    expect(dialog?.options.find((o) => o.digit === '5')?.description).toBeUndefined();
  });
});

describe('opisy opcji — wariant z kolumną `preview` ich NIE MA', () => {
  const previewQuestion = read('dialog-askuserquestion-preview.txt');
  const notesQuestion = read('dialog-askuserquestion-notes.txt');

  it('treść ramki podglądu nie staje się opisem opcji', () => {
    /*
     * `unbox` zdejmuje pionowe krawędzie ramki podglądu tak samo jak krawędzie dialogu, więc
     * linia „│ /api/sessions/42 │" wygląda po nim jak zwyczajny opis pod opcją. Treść podglądu
     * zmienia się z ruchem podświetlenia — wzięta za opis byłaby inna przy każdym odczycie.
     */
    for (const option of parseOptions(previewQuestion)?.options ?? []) {
      expect(option.description).toBeUndefined();
    }
    for (const option of parseOptions(notesQuestion)?.options ?? []) {
      expect(option.description).toBeUndefined();
    }
    expect(parseOptions(previewQuestion)?.submit).toBe('digit-enter');
  });
});

describe('dialog `ExitPlanMode` — zamknięta sygnatura ekranu (pomiar D na CLI 2.1.251)', () => {
  const planDialog = read('dialog-exitplanmode.txt');

  it('rozpoznaje dialog planu jako zgodę i bierze nazwę Z SYGNATURY, nie ze scrollbacku', () => {
    /*
     * Dialog wyjścia z trybu planu pyta „Would you like to proceed?", a nie „Do you want to
     * proceed?" (`measured/exitplanmode-2.1.258.txt` i `-2.1.293.txt`, CLI 2.1.258 i 2.1.293), więc
     * stopkowe markery zgody go nie łapały — był `other`, czyli karta bez treści i bez przycisków.
     * Nazwy narzędzia nie da się z niego odczytać (nie rysuje linii `⏺ ExitPlanMode(…)`),
     * a `toolNameFrom` całego ekranu oddałby `Read` ze scrollbacku —
     * czyli nazwę CUDZEGO, zakończonego wywołania na karcie i w dzienniku.
     */
    const dialog = parseOptions(planDialog);
    expect(dialog?.kind).toBe('tool');
    expect(dialog?.toolName).toBe('ExitPlanMode');
    expect(planDialog).toContain('⏺ Read(');
    expect(dialog?.options.map((o) => [o.digit, o.label])).toEqual([
      ['1', 'Yes, and use auto mode'],
      ['2', 'Yes, manually approve edits'],
      ['3', 'Tell Claude what to change'],
    ]);
  });

  it('podpowiedź `shift+tab` pod ostatnią opcją nie jest jej opisem', () => {
    // Skrót klawiszowy stoi dokładnie w kolumnie opisu; bez wpisu w chromie formularza
    // jechałby na kartę jako zdanie, którego nikt nie napisał.
    const last = parseOptions(planDialog)?.options.at(-1);
    expect(last?.description).toBeUndefined();
  });

  it('opcja „use auto mode" jest ESKALUJĄCA — bez przycisku „Zatwierdź"', () => {
    // Przestawia całą sesję w tryb wykonujący zmiany bez pytania. Na karcie zgody dostaje
    // własny, jawnie nazwany przycisk — nigdy zwykłe „Zatwierdź".
    const form = resolveOptions(planDialog, null);
    expect(form.status).toBe('no-jsonl');
    const options = form.status === 'no-jsonl' ? form.questionForm?.options ?? [] : [];
    expect(options.find((o) => o.label.includes('auto mode'))?.terminalOnly).toBe(true);
    expect(options.find((o) => o.label.includes('manually'))?.terminalOnly).toBeUndefined();
  });

  it('cross-check ze zrzutem hooka przechodzi po nazwie z sygnatury', () => {
    const resolved = resolveOptions(planDialog, { toolName: 'ExitPlanMode' });
    expect(resolved.status).toBe('ok');
  });

  it('sygnatura W SCROLLBACKU nie przemianowuje prawdziwej zgody na narzędzie', () => {
    /*
     * Fail-closed w drugą stronę: zdanie sygnatury wypisane przez agenta nad dialogiem `Bash`
     * nie ma prawa podmienić nazwy narzędzia — region prawdziwej zgody niesie własną
     * (`⏺ Bash(…)` albo nagłówek ramki), więc warunek „region bez nazwy" go chroni.
     */
    const spoofed = `Claude has written up a plan and is ready to execute.\n${permissionDialog}`;
    expect(parseOptions(spoofed)?.toolName).toBe('Bash');
  });
});

describe('multiSelect — override z hooka i ekran przeglądu', () => {
  const multiStart = read('dialog-askuserquestion-multi-live-start.txt');
  const reviewScreen = read('dialog-askuserquestion-multi-live-review.txt');
  const single = read('dialog-askuserquestion-live.txt');

  it('ekran PRZEGLĄDU odpowiedzi to zwykłe potwierdzenie z cyframi, nie multi-select', () => {
    /*
     * Ostatni krok formularza wielokrotnego („Review your answers" + „1. Submit answers" /
     * „2. Cancel") nie ma checkboxów, ale pasek zakładek dalej niesie „✔ Submit" — czyli
     * sygnaturę nr 2. Bez warunku negatywnego jedyny krok, który da się zrobić jedną cyfrą,
     * zostawał kartą „odpowiedz w terminalu".
     */
    const dialog = parseOptions(reviewScreen);
    expect(dialog?.multiSelect).toBe(false);
    expect(dialog?.options.map((o) => o.label)).toEqual(['Submit answers', 'Cancel']);
    expect(dialog?.question?.question).toContain('Ready to submit your answers?');
  });

  it('sam nagłówek przeglądu w scrollbacku NIE rozbraja sygnatury multi-select', () => {
    // Warunek jest podwójny (nagłówek ORAZ opcja „Submit answers"): agent cytujący „Review
    // your answers" nad prawdziwym formularzem nie ma prawa zdjąć z niego fail-closed.
    const spoofed = multiStart.replace('Które dodatki?', 'Review your answers\n\nKtóre dodatki?');
    expect(parseOptions(spoofed)?.multiSelect).toBe(true);
  });

  it('override z hooka nadpisuje heurystykę ekranu w OBIE strony', () => {
    // `false` przywraca treść pytania formularzowi z checkboxami…
    const forcedSingle = parseOptions(multiStart, { multiSelect: false });
    expect(forcedSingle?.multiSelect).toBe(false);
    expect(forcedSingle?.question?.question).toBe('Które dodatki?');
    // …a `true` odbiera ją formularzowi, który ekran widzi jako jednokrotny.
    const forcedMulti = parseOptions(single, { multiSelect: true });
    expect(forcedMulti?.multiSelect).toBe(true);
    expect(forcedMulti?.question).toBeNull();
  });

  it('`resolveOptions` z override `false` daje status `ok` zamiast rozjazdu multi-select', () => {
    expect(resolveOptions(multiStart, { toolName: ASK_USER_QUESTION_TOOL }).status)
      .toBe('mismatch');
    const resolved = resolveOptions(
      multiStart, { toolName: ASK_USER_QUESTION_TOOL, multiSelect: false },
    );
    expect(resolved.status).toBe('ok');
    expect(resolved.status === 'ok' ? resolved.question : null).toBe('Które dodatki?');
  });
});

describe('formularz WIELOPYTANIOWY — pomiar na żywo (CLI 2.1.257)', () => {
  const tab1 = read('dialog-askuserquestion-multiq-tab1-jednokrotne.txt');
  const tab2 = read('dialog-askuserquestion-multiq-tab2-multiselect-next.txt');
  const tab3 = read('dialog-askuserquestion-multiq-tab3-ostatnie.txt');
  const framed = read('dialog-askuserquestion-multiq-pytanie-w-ramce.txt');
  const review = read('dialog-askuserquestion-multiq-review.txt');
  const oneQuestion = read('dialog-askuserquestion-multiq-jednopytaniowy-submit.txt');

  /**
   * `tool_input` odpowiadający `tab1`/`tab2`/`tab3` — treść pytań i etykiety przepisane
   * DOSŁOWNIE z fixture'ów (CLI rysuje backticki etykiety bez zmian, więc etykieta
   * z hooka = etykieta z ekranu).
   */
  const hookInput = {
    questions: [
      {
        question: 'Na którą wartość ujednolicić odstęp pod nagłówkiem sekcji?',
        header: 'Odstęp',
        multiSelect: false,
        options: [
          { label: '52 px — wartość `wide` (rekomendacja)', description: 'Największa z używanych' },
          { label: '40 px — wartość `default`', description: 'Środkowa' },
          { label: 'Nowa wartość pośrednia', description: 'Do ustalenia' },
        ],
      },
      {
        question: 'Które dodatki włączyć?',
        header: 'Dodatki',
        multiSelect: true,
        options: [
          { label: 'Posypka', description: 'Kolorowa' },
          { label: 'Polewa', description: 'Czekoladowa' },
          { label: 'Bita śmietana', description: 'Domowa' },
        ],
      },
      {
        question: 'Jaki kolor przycisku?',
        header: 'Kolor',
        multiSelect: false,
        options: [
          { label: 'Niebieski (Rekomendacja)', description: 'Jak dziś' },
          { label: 'Zielony', description: 'Nowy' },
        ],
      },
    ],
  };
  const hookPending: PendingTool = {
    id: 'hook:multiq', toolName: ASK_USER_QUESTION_TOOL, input: hookInput, at: '',
  };

  it('zakładka JEDNOKROTNA formularza wielopytaniowego dostaje kartę pytania', () => {
    /*
     * Pasek `← ☐ Odstęp ☐ Dodatki ☐ Kolor ✔ Submit →` rysuje KAŻDY formularz z więcej niż
     * jednym pytaniem. Gdyby sam ten pasek znaczył `multiSelect`, odpowiedź z telefonu na
     * pytanie 1 gwarantowałaby fallback „odpowiedz w terminalu" na pytaniu 2.
     */
    for (const screen of [tab1, tab3]) {
      const dialog = parseOptions(screen);
      expect(dialog?.kind).toBe('question');
      expect(dialog?.multiSelect).toBe(false);
      expect(dialog?.question).not.toBeNull();
    }
    expect(parseOptions(tab1)?.question?.question)
      .toBe('Na którą wartość ujednolicić odstęp pod nagłówkiem sekcji?');
    expect(parseOptions(tab3)?.question?.question).toBe('Jaki kolor przycisku?');
  });

  it('zakładka `multiSelect` z pozycją „Next" zostaje BEZ karty pytania', () => {
    /*
     * Drugi dowód sygnatury nr 2: checkboxy `[ ]` w liniach opcji ORAZ pozycja pod ostatnią
     * opcją, która w formularzu wielopytaniowym brzmi „Next", nie „Submit". Zaznaczenie
     * i zatwierdzenie to dwa różne klawisze — jedna cyfra nie odpowiada tu na nic.
     */
    const dialog = parseOptions(tab2);
    expect(dialog?.multiSelect).toBe(true);
    expect(dialog?.question).toBeNull();
    // Checkbox ma każda pozycja formularza; „Chat about this" (spod kreski) go nie ma.
    expect(dialog?.options.map((o) => o.checked))
      .toEqual([false, false, false, false, undefined]);
  });

  it('„Next" pod ostatnią opcją to chrome formularza, nie opis opcji', () => {
    // Bez `^next$` w `FORM_CHROME_PATTERN` słowo jechało na kartę jako opis „Type something".
    expect(tab2).toContain('Next');
    expect(parseOptions(tab2)?.options.find((o) => o.digit === '4')?.description)
      .toBeUndefined();
    expect(parseOptions(tab2)?.options.map((o) => o.label)).not.toContain('Next');
  });

  it('pytanie rysowane w ramce cytatu `│` jedzie na kartę ZŁĄCZONE', () => {
    // CLI łamie długie pytanie na kilka linii z prefiksem `│`; `unbox` zdejmuje krawędź,
    // a `questionFrom` skleja linie — na karcie ma być całe zdanie, bez glifów ramki.
    const question = parseOptions(framed)?.question?.question ?? '';
    expect(question).not.toContain('│');
    expect(question).toContain('czy wprowadzamy tryb roboczy (decyzja X)?');
    expect(question).toContain('Flaga na obiekcie, ustawia ją administrator');
    expect(question).toContain('w dzienniku i jawnym komunikatem.');
    expect(parseOptions(framed)?.multiSelect).toBe(false);
  });

  it('ekran przeglądu po ostatniej zakładce to zwykła para z cyframi', () => {
    // „Review your answers" + `1. Submit answers` / `2. Cancel` — pasek dalej niesie
    // „✔ Submit", a mimo to jest to dokładnie ten krok, który Rarog umie zrobić jedną cyfrą.
    const dialog = parseOptions(review);
    expect(dialog?.multiSelect).toBe(false);
    expect(dialog?.options.map((o) => o.label)).toEqual(['Submit answers', 'Cancel']);
    expect(dialog?.question?.question).toContain('Ready to submit your answers?');
  });

  it('formularz JEDNOPYTANIOWY z checkboxami i „Submit" dalej nie ma karty', () => {
    // Pasek z JEDNĄ zakładką (`← ☐ Dodatki ✔ Submit →`), ale checkboxy i pozycja „Submit"
    // stoją — sygnatura paska niczego tu nie otwiera.
    const dialog = parseOptions(oneQuestion);
    expect(dialog?.multiSelect).toBe(true);
    expect(dialog?.question).toBeNull();
  });

  it('`resolveOptions` z pendingiem `AskUserQuestion` daje `ok` dla zakładki jednokrotnej', () => {
    // Ścieżka jsonl/hooka: nie kończy się `mismatch` z powodem `multi-select`,
    // czyli czerwoną kartą bez przycisków na KAŻDEJ zakładce formularza wielopytaniowego.
    const resolved = resolveOptions(tab1, { toolName: ASK_USER_QUESTION_TOOL });
    expect(resolved.status).toBe('ok');
    if (resolved.status !== 'ok') return;
    expect(resolved.kind).toBe('question');
    expect(resolved.question).toBe('Na którą wartość ujednolicić odstęp pod nagłówkiem sekcji?');
    expect(resolved.digitByLabel.get('40 px — wartość `default`')).toBe('2');
    // Zakładka wielokrotna zostaje fail-closed — reguła paska nie dotyczy checkboxów.
    expect(resolveOptions(tab2, { toolName: ASK_USER_QUESTION_TOOL })).toMatchObject({
      status: 'mismatch', reason: 'multi-select',
    });
  });

  it('`hookQuestionFrom` paruje zrzut hooka z zakładką stojącą na ekranie', () => {
    /*
     * Zrzut niesie KOMPLET trzech pytań, ekran pokazuje jedno — dopasowanie idzie po treści
     * pytania i komplecie etykiet, więc karta dostaje opisy i `multiSelect` od autora
     * pytania, a cyfry zostają z ekranu.
     */
    const hooked = hookQuestionFrom(hookPending, tab1);
    expect(hooked?.multiSelect).toBe(false);
    expect(hooked?.card.header).toBe('Odstęp');
    expect(hooked?.card.question)
      .toBe('Na którą wartość ujednolicić odstęp pod nagłówkiem sekcji?');
    expect(hooked?.options.map((o) => [o.digit, o.label, o.description])).toEqual([
      ['1', '52 px — wartość `wide` (rekomendacja)', 'Największa z używanych'],
      ['2', '40 px — wartość `default`', 'Środkowa'],
      ['3', 'Nowa wartość pośrednia', 'Do ustalenia'],
      ['4', 'Type something.', undefined],
      ['5', 'Chat about this', undefined],
    ]);
  });

  /*
   * Rolę opcji wyznacza serwer. Karta CYFROWA niesie etykiety Z EKRANU, więc chrome CLI
   * dostaje `custom`/`exit`; karta kanału hooka niesie payload autora — same odpowiedzi.
   */
  it('`hookQuestionFrom`: karta z ekranu ma role chrome CLI, komplet z payloadu same `answer`', () => {
    const hooked = hookQuestionFrom(hookPending, tab1);
    expect(hooked?.card.options.map((o) => [o.label, o.role])).toEqual([
      ['52 px — wartość `wide` (rekomendacja)', 'answer'],
      ['40 px — wartość `default`', 'answer'],
      ['Nowa wartość pośrednia', 'answer'],
      ['Type something.', 'custom'],
      ['Chat about this', 'exit'],
    ]);
    const roles = new Set(hooked?.all.flatMap((q) => q.options.map((o) => o.role)));
    expect([...roles]).toEqual(['answer']);
  });

  it('`optionRole` rozpoznaje chrome CLI po etykiecie (z kropką i bez, wielkość liter, spacje)', () => {
    expect(['Type something.', 'type something', '  Type something  '].map(optionRole))
      .toEqual(['custom', 'custom', 'custom']);
    expect(['Chat about this', 'chat about this.'].map(optionRole)).toEqual(['exit', 'exit']);
    expect(['Type something else', 'Chat', 'Tak'].map(optionRole))
      .toEqual(['answer', 'answer', 'answer']);
  });

  it('`screenQuestionCard` nadaje rolę KAŻDEJ opcji z ekranu', () => {
    const card = screenQuestionCard({
      kind: 'question', header: 'Smak', question: 'Jaki smak?',
      options: [
        { digit: '1', label: 'Wanilia' }, { digit: '2', label: 'Type something.' },
        { digit: '3', label: 'Chat about this' },
      ],
      dialogIdentity: { kind: 'question', identity: { kind: 'form' } },
    }, 1);
    const event = card.event;
    expect(event.type).toBe('question-request');
    if (event.type !== 'question-request') return;
    expect(event.questions[0]?.options.map((o) => o.role)).toEqual(['answer', 'custom', 'exit']);
  });

  it('`hookQuestionFrom` bierze `multiSelect` z payloadu dla zakładki z checkboxami', () => {
    // Ta sama para, druga zakładka: hook mówi `multiSelect: true` i to jest rozstrzygnięcie
    // autorytatywne — ekran potwierdza je checkboxami.
    const hooked = hookQuestionFrom(hookPending, tab2);
    expect(hooked?.multiSelect).toBe(true);
    expect(hooked?.card.question).toBe('Które dodatki włączyć?');
    expect(hooked?.options.map((o) => o.label))
      .toEqual(['Posypka', 'Polewa', 'Bita śmietana', 'Type something', 'Chat about this']);
  });

  it('zrzut hooka o INNYM formularzu nie paruje się z ekranem', () => {
    // Fail-closed cross-checku: pytania ze zrzutu nie ma na ekranie przeglądu, więc karta
    // z hooka nie powstaje i zostaje ścieżka czysto ekranowa.
    expect(hookQuestionFrom(hookPending, review)).toBeNull();
  });

  it('`screenAnswerIndex` wskazuje zakładkę Z EKRANU, a przy braku dopasowania `-1`', () => {
    /*
     * Fallback cyfrą bierze po tym indeksie JEDNĄ grupę odpowiedzi z karty: karta niesie pytania w kolejności payloadu, a na ekranie stoi dowolna
     * zakładka. Zwinięcie białych znaków jest tu obowiązkowe — panel zawija długie pytania.
     */
    const target = {
      key: 'k',
      questions: ['Które dodatki włączyć?', 'Na którą wartość\nujednolicić odstęp?'],
      blocked: [],
      notable: [null, null],
    };
    expect(screenAnswerIndex(target, 'Które dodatki włączyć?')).toBe(0);
    expect(screenAnswerIndex(target, 'Na którą wartość ujednolicić odstęp?')).toBe(1);
    // Fail-closed: pytania z ekranu nie ma na karcie (albo ekranu nie ma wcale).
    expect(screenAnswerIndex(target, 'Zupełnie inne pytanie?')).toBe(-1);
    expect(screenAnswerIndex(target, undefined)).toBe(-1);
    expect(screenAnswerIndex(target, '   ')).toBe(-1);
  });
});

/*
 * CLI 2.1.281 w sesji po `/rename` rysuje POD stopką formularza linię z nazwą sesji
 * (`──── pomiar-nazwy ─`). herdr bierze ją za ostatnią kreskę poziomą (reguła
 * `live_blocked_form`, region `after_last_horizontal_rule`) i nie melduje `blocked` — stąd
 * rezerwa: Rarog rozpoznaje taki formularz sam. Parser Raroga tej linii za kreskę NIE bierze (w linii jest tekst), więc czyta
 * formularz tak samo jak bez niej. Zrzut z żywego panelu.
 */
describe('formularz z linią nazwy sesji pod stopką (CLI 2.1.281)', () => {
  const screen = read('dialog-askuserquestion-linia-nazwy-2.1.281.txt');

  it('fixture naprawdę kończy się linią nazwy, a nie stopką', () => {
    const lines = screen.trimEnd().split('\n');
    expect(lines.at(-1)).toMatch(/^─+ pomiar-nazwy ─$/);
    expect(lines.at(-2)).toContain('Esc to cancel');
  });

  it('parseOptions widzi formularz pytania z kompletem opcji i podświetleniem', () => {
    const dialog = parseOptions(screen);
    expect(dialog?.kind).toBe('question');
    expect(dialog?.question?.question).toBe('Jaki smak lodow?');
    expect(dialog?.options.map((o) => o.label)).toEqual([
      'Wanilia', 'Czekolada', 'Truskawka', 'Type something.', 'Chat about this',
    ]);
    expect(dialog?.selected?.digit).toBe('1');
  });

  it('zrzut hooka dopasowuje się do tego ekranu (kanał odpowiedzi plikiem działa)', () => {
    const pending: PendingTool = {
      id: 'hook:nazwa',
      toolName: ASK_USER_QUESTION_TOOL,
      input: {
        questions: [
          {
            question: 'Jaki smak lodow?', header: 'Smak', multiSelect: false,
            options: [{ label: 'Wanilia' }, { label: 'Czekolada' }, { label: 'Truskawka' }],
          },
          {
            question: 'Jaki kubek?', header: 'Kubek', multiSelect: false,
            options: [{ label: 'Maly' }, { label: 'Duzy' }],
          },
        ],
      },
      at: '',
    };
    expect(hookQuestionFrom(pending, screen)?.screenQuestion).toBe('Jaki smak lodow?');
  });

  /*
   * ZNANE OGRANICZENIE (roadmap): wysoki panel i krótka sesja — CLI 2.1.281 stawia linię nazwy
   * na DOLE ekranu, a między nią a stopką zostaje 55 pustych linii. Parser przeszukuje ostatnie
   * `DIALOG_TAIL_LINES` (60, liczone z pustymi), więc formularz wypada poza okno i rezerwa nie
   * wchodzi. Test przypina ten stan: poprawka parsera ma go zmienić ŚWIADOMIE.
   */
  it('askFormOnScreen: formularz, ekran przeglądu odpowiedzi i brak odczytu', () => {
    expect(askFormOnScreen(screen)).toBe('form');
    // Przegląd („Submit answers") to ostatni krok TEGO SAMEGO formularza na torze cyfry — parser
    // czyta go jako `confirm`, a rezerwa bez tej reguły gasłaby tuż przed wysłaniem odpowiedzi.
    const review = read('dialog-askuserquestion-multiq-review.txt');
    expect(parseOptions(review)?.kind).toBe('confirm');
    expect(askFormOnScreen(review)).toBe('form');
    expect(askFormOnScreen(read('dialog-permission-unsandboxed.txt'))).toBe('none');
    expect(askFormOnScreen(null)).toBe('unknown');
  });

  it('luka pustych wierszy nad linią nazwy wypycha formularz poza okno parsera', () => {
    const gap = read('dialog-askuserquestion-linia-nazwy-luka-2.1.281.txt');
    expect(gap.split('\n').filter((line) => line.trim() === '').length).toBeGreaterThan(50);
    expect(parseOptions(gap)).toBeNull();
    expect(askFormOnScreen(gap)).toBe('none');
  });
});
