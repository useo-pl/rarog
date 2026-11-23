/**
 * Stan composera z ekranu Z ATRYBUTAMI (`composerStateFrom`).
 *
 * Zrzuty `composer-*-2.1.258.ansi.txt` są zapisem żywego panelu (herdr `agent.read`, źródło
 * `visible`, format `ansi`): CLI 2.1.258 wyświetla w pustym composerze podpowiedź następnego
 * promptu przyciemnioną (SGR 2), a `❯` koloruje 24-bitowo (`38;2;r;g;b`) — oba przypadki
 * to dokładnie te, na których parser bez atrybutów się przewracał.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  composerFieldView, composerQueueShown, composerRegionState, composerRegionText, composerStateFrom,
  heldLeftoverVerdicts, screenHoldsNeedle,
} from '../src/drivers/herdr/commands.ts';

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, 'fixtures', 'herdr', name), 'utf8');

const E = '\x1b';

describe('composerStateFrom — treść po atrybucie, nie po znakach', () => {
  it('przyciemniona podpowiedź CLI w pustym polu = `empty` (żywy zrzut)', () => {
    expect(composerStateFrom(fixture('composer-ghost-suggestion-2.1.258.ansi.txt'))).toBe('empty');
  });

  it('puste pole z kolorowym `❯` (`38;2;r;g;b`) = `empty`, kolor nie udaje treści', () => {
    expect(composerStateFrom(fixture('composer-empty-2.1.258.ansi.txt'))).toBe('empty');
  });

  it('tekst wpisany (bez przyciemnienia) po kolorowym `❯` = `filled`', () => {
    const screen = `${E}[0m${E}[38;2;200;192;147m❯ ${E}[0mDlaczego nie może tak zostać?${E}[0m\n`;
    expect(composerStateFrom(screen)).toBe('filled');
  });

  it('`22` gasi przyciemnienie: tekst po nim liczy się jako treść', () => {
    const screen = `❯ ${E}[2mpodpowiedź${E}[22m i mój tekst${E}[0m`;
    expect(composerStateFrom(screen)).toBe('filled');
  });

  it('`38;5;n` (kolor 256) nie zjada parametrów za sobą', () => {
    // Po `38;5;2` przychodzi `2` jako OSOBNY parametr — to już przyciemnienie.
    expect(composerStateFrom(`❯ ${E}[38;5;2;2mghost${E}[0m`)).toBe('empty');
    expect(composerStateFrom(`❯ ${E}[38;5;2mtekst${E}[0m`)).toBe('filled');
  });

  it('ekran bez sekwencji ESC zachowuje się jak dawniej', () => {
    expect(composerStateFrom('❯ zawieszony prompt\n  w composerze')).toBe('filled');
    expect(composerStateFrom('❯')).toBe('empty');
    // Wskaźnik opcji dialogu jest WCIĘTY — to nie composer.
    expect(composerStateFrom('  ❯ 1. Yes\n    2. No')).toBe('unknown');
    expect(composerStateFrom('zupełnie inny ekran')).toBe('unknown');
  });

  it('liczy się OSTATNIA linia z `❯` w kolumnie 0 — echo promptu wyżej nie jest composerem', () => {
    const screen = `❯ wysłana wiadomość\n\n⏺ odpowiedź\n\n❯ ${E}[2mpodpowiedź${E}[0m`;
    expect(composerStateFrom(screen)).toBe('empty');
  });
});

/*
 * `composerRegionState` — bramka restartu sesji. Zrzuty `composer-region-*-2.1.283`
 * to żywy panel CLI 2.1.283 (herdr `pane read --source visible --format ansi`).
 * Najważniejszy jest szkic od pustej linii: tam `composerStateFrom` widzi `❯` z pustym
 * ogonem i mówi `empty`, a `/exit` dopisany za takim szkicem poszedłby do modelu.
 */
describe('composerRegionState — cały obszar pola promptu', () => {
  it('żywe zrzuty 2.1.283: puste, jedna linia, szkic od pustej linii, szkic zawinięty', () => {
    expect(composerRegionState(fixture('composer-region-empty-2.1.283.ansi.txt'))).toBe('empty');
    expect(composerRegionState(fixture('composer-region-one-line-2.1.283.ansi.txt'))).toBe('filled');
    expect(composerRegionState(fixture('composer-region-leading-blank-2.1.283.ansi.txt')))
      .toBe('filled');
    expect(composerRegionState(fixture('composer-region-wrapped-2.1.283.ansi.txt'))).toBe('filled');
  });

  it('dowód potrzeby: stary parser widzi szkic od pustej linii jako puste pole', () => {
    expect(composerStateFrom(fixture('composer-region-leading-blank-2.1.283.ansi.txt'))).toBe('empty');
  });

  it('przyciemniona podpowiedź w ramce = `empty`', () => {
    const rule = '─'.repeat(40);
    expect(composerRegionState(`${rule}\n❯ ${E}[2mpodpowiedź${E}[0m\n${rule}`)).toBe('empty');
    expect(composerRegionState(`${rule}\n❯ \n  ${E}[2mdruga${E}[0m\n${rule}`)).toBe('empty');
  });

  it('brak ramki nad albo pod polem, dialog i obcy ekran = `unknown`', () => {
    const rule = '─'.repeat(40);
    expect(composerRegionState(`❯ \n${rule}`)).toBe('unknown');
    expect(composerRegionState(`${rule}\n❯ `)).toBe('unknown');
    expect(composerRegionState(`${rule}\n  ❯ 1. Yes\n    2. No\n${rule}`)).toBe('unknown');
    expect(composerRegionState('zupełnie inny ekran')).toBe('unknown');
  });

  it('kreska WPISANA w szkic (wcięta) nie jest ramką', () => {
    const rule = '─'.repeat(40);
    expect(composerRegionState(`${rule}\n❯ \n  ──────\n  niewysłany szkic\n${rule}`)).toBe('filled');
    expect(composerRegionState(`${rule}\n❯ \n  ──────\n${rule}`)).toBe('filled');
  });

  it('ramka z nazwą sesji po `/rename` dalej jest ramką', () => {
    const top = `${'─'.repeat(30)} review-1 ─`;
    expect(composerRegionState(`${top}\n❯ \n${'─'.repeat(40)}`)).toBe('empty');
    expect(composerRegionState(`${top}\n❯ \n  tekst\n${'─'.repeat(40)}`)).toBe('filled');
  });
});

/*
 * Odczyt pola po turze: prompt wysłany w trakcie tury i zablokowany przez hook
 * nie zostawia wpisu w pliku rozmowy, a CLI oddaje jego tekst do pola. O tym, CZYJ tekst stoi w polu, rozstrzyga
 * treść obszaru pola — nie cały ekran, bo historia rozmowy pokazuje wysłane prompty za tym samym `❯`.
 */
describe('composerRegionText i werdykt odczytu pola po turze', () => {
  const rule = '─'.repeat(40);
  const squash = (value: string | null): string | null => (value === null ? null : value.replace(/\s+/g, ''));

  it('żywe zrzuty 2.1.283: treść całego pola, bez `❯` i bez linii ramki', () => {
    expect(composerRegionText(fixture('composer-region-empty-2.1.283.ansi.txt'))?.trim()).toBe('');
    expect(composerRegionText(fixture('composer-region-one-line-2.1.283.ansi.txt'))?.trim()).toBe('szkic jednej linii');
    expect(composerRegionText(fixture('composer-region-leading-blank-2.1.283.ansi.txt'))?.trim())
      .toBe('druga linia szkicu');
    expect(squash(composerRegionText(fixture('composer-region-wrapped-2.1.283.ansi.txt'))))
      .toBe('bardzodlugiszkic'.repeat(12));
  });

  it('`null` dokładnie tam, gdzie stan `unknown`: dialog, brak ramki, obcy ekran', () => {
    for (const screen of [`❯ \n${rule}`, `${rule}\n❯ tekst`, `${rule}\n  ❯ 1. Yes\n${rule}`, 'inny ekran']) {
      expect(composerRegionText(screen)).toBeNull();
      expect(composerRegionState(screen)).toBe('unknown');
    }
  });

  it('przyciemniona podpowiedź CLI nie jest treścią pola', () => {
    expect(composerRegionText(`${rule}\n❯ ${E}[2mpodpowiedź${E}[0m\n${rule}`)?.trim()).toBe('');
  });

  const one = (region: string | null, text: string): string | undefined => heldLeftoverVerdicts(region, [text])[0];

  it('pole RÓWNE tekstowi wstrzymanego promptu → `not-taken`, także zawinięte na szerokość panelu', () => {
    expect(one(composerRegionText(fixture('composer-region-one-line-2.1.283.ansi.txt')), 'szkic jednej linii'))
      .toBe('not-taken');
    const wrapped = fixture('composer-region-wrapped-2.1.283.ansi.txt');
    expect(one(composerRegionText(wrapped), 'bardzo dlugi szkic '.repeat(12).trim())).toBe('not-taken');
  });

  it('pole z innym tekstem albo `[Pasted text #N +K lines]` długiego promptu → `unconfirmed`', () => {
    const line = fixture('composer-region-one-line-2.1.283.ansi.txt');
    expect(one(composerRegionText(line), 'zupełnie inny prompt')).toBe('unconfirmed');
    const pasted = line.replace('szkic jednej linii', '[Pasted text #1 +40 lines]');
    expect(one(composerRegionText(pasted), `linia 1\n${'dalej\n'.repeat(39)}`)).toBe('unconfirmed');
  });

  // Samo zawieranie uznałoby cudzy szkic za naszą pozostałość, a `not-taken` go czyści.
  it('krótki prompt WEWNĄTRZ cudzego szkicu albo szkic dopisany do naszego tekstu → `unconfirmed`', () => {
    const line = fixture('composer-region-one-line-2.1.283.ansi.txt');
    const foreign = composerRegionText(line.replace('szkic jednej linii', 'Popraw dokumentację'));
    expect(screenHoldsNeedle(foreign ?? '', 'ok')).toBe(true);
    expect(one(foreign, 'ok')).toBe('unconfirmed');
    const extended = composerRegionText(line.replace('szkic jednej linii', 'zablokowany w turze i dopisek z Maca'));
    expect(one(extended, 'zablokowany w turze')).toBe('unconfirmed');
  });

  it('prompt w HISTORII nad pustym polem → `empty`, choć reguła na całym ekranie by go znalazła', () => {
    const screen = `❯ zablokowany w turze\n\n⏺ Odpowiedź na poprzedni prompt.\n\n${rule}\n❯ \n${rule}`;
    expect(screenHoldsNeedle(screen, 'zablokowany w turze')).toBe(true);
    expect(one(composerRegionText(screen), 'zablokowany w turze')).toBe('empty');
    expect(one(composerRegionText(fixture('composer-region-empty-2.1.283.ansi.txt')), 'x')).toBe('empty');
  });

  it('pole nieczytelne → `unknown` dla każdej wiadomości', () => {
    expect(heldLeftoverVerdicts(null, ['a', 'b'])).toEqual(['unknown', 'unknown']);
  });

  it('dwa prompty sklejone w polu (drugi dopisany do pierwszego) → oba `not-taken`, reszta `unconfirmed`', () => {
    const region = composerRegionText(`${rule}\n❯ pierwszy promptdrugi prompt\n${rule}`);
    expect(heldLeftoverVerdicts(region, ['pierwszy prompt', 'drugi prompt'])).toEqual(['not-taken', 'not-taken']);
    expect(heldLeftoverVerdicts(region, ['wzięty wcześniej', 'pierwszy prompt', 'drugi prompt']))
      .toEqual(['unconfirmed', 'not-taken', 'not-taken']);
    // Sklejka nie po kolei wysyłki nie pasuje.
    expect(heldLeftoverVerdicts(region, ['drugi prompt', 'pierwszy prompt'])).toEqual(['unconfirmed', 'unconfirmed']);
  });

  it('dwa identyczne prompty, w polu jeden → `not-taken` dostaje późniejszy', () => {
    const region = composerRegionText(`${rule}\n❯ tak\n${rule}`);
    expect(heldLeftoverVerdicts(region, ['tak', 'tak'])).toEqual(['unconfirmed', 'not-taken']);
  });
});

/*
 * The field reader for shapes the frame-to-frame reader cannot see, measured on CLI 2.1.328
 * (`queue/measured/zabranie-*`): a field taller than the pane (top rule `─── ↑ N more ───`, no `❯` on screen) and
 * a history entry (top rule `─── History N/M ───`, or ` History N/M · ↑ N mo` cut to 26 columns).
 */
describe('composerFieldView: long field and history entry', () => {
  interface JsonlEntry {
    readonly type?: string;
    readonly operation?: string;
    readonly content?: unknown;
    readonly message?: { readonly content?: unknown };
  }
  const measured = (name: string): string => fixture(join('queue', 'measured', name));
  const squash = (value: string): string => value.replace(/\s+/g, '');
  const jsonl = (name: string): JsonlEntry[] => measured(name).split('\n')
    .filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as JsonlEntry);
  const firstPrompt = (name: string): string => {
    const content = jsonl(name).find((entry) => entry.type === 'user')?.message?.content;
    return typeof content === 'string' ? content : '';
  };

  it('`↑ N more` top rule: the visible bottom of the field, marked cut at the top', () => {
    const view = composerFieldView(measured('zabranie-dlugie-po-up-2.1.328.txt'));
    expect(view).toMatchObject({ cutAtTop: true, history: false });
    const lines = view?.text.split('\n') ?? [];
    expect(lines).toHaveLength(14);
    expect(lines[0]?.trim()).toBe('linia, zeby pole po');
    expect(lines.at(-1)?.trim()).toBe('jednym slowem: ok.');
    // The visible part is the tail of the prompts the CLI handed back to the field.
    const taken = jsonl('zabranie-dlugie-2.1.328.jsonl')
      .filter((entry) => entry.operation === 'popAll').map((entry) => String(entry.content)).join('\n');
    expect(squash(taken).endsWith(squash(view?.text ?? '-'))).toBe(true);
    expect(squash(view?.text ?? '').length).toBeLessThan(squash(taken).length);
  });

  it('`History` header in a full top rule: the whole entry, marked history', () => {
    const view = composerFieldView(measured('zabranie-historia-szeroki-po-up-2.1.328.txt'));
    expect(view).toMatchObject({ cutAtTop: false, history: true });
    expect(squash(view?.text ?? '')).toBe(squash(firstPrompt('zabranie-historia-szeroki-2.1.328.jsonl')));
    for (const name of ['zabranie-wyscig-koniec-po-up-2.1.328.txt', 'zabranie-wyscig-wynik-po-up-2.1.328.txt']) {
      const entry = composerFieldView(measured(name));
      expect(entry, name).toMatchObject({ cutAtTop: false, history: true });
      expect(entry?.text.trim(), name).toBe('pomiar B: ok');
    }
  });

  it('`History` header cut to the pane width with `↑ N`: the visible bottom, marked history and cut', () => {
    const view = composerFieldView(measured('zabranie-historia-po-up-2.1.328.txt'));
    expect(view).toMatchObject({ cutAtTop: true, history: true });
    expect(view?.text.split('\n')[0]?.trim()).toBe('— zwykłe, na');
    const prompt = squash(firstPrompt('zabranie-historia-2.1.328.jsonl'));
    expect(prompt.endsWith(squash(view?.text ?? '-'))).toBe(true);
    expect(squash(view?.text ?? '').length).toBeLessThan(prompt.length);
  });

  it('the frame-to-frame reader still answers `null` on these shapes', () => {
    for (const name of [
      'zabranie-dlugie-po-up-2.1.328.txt', 'zabranie-historia-po-up-2.1.328.txt',
      'zabranie-historia-szeroki-po-up-2.1.328.txt', 'zabranie-wyscig-koniec-po-up-2.1.328.txt',
      'zabranie-wyscig-wynik-po-up-2.1.328.txt',
    ]) {
      expect(composerRegionText(measured(name)), name).toBeNull();
      expect(composerRegionState(measured(name)), name).toBe('unknown');
    }
  });

  it('a normal field reads as before, without marks, on every measured screen', () => {
    const screens = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (entry.isDirectory()) return screens(join(dir, entry.name));
      return entry.name.endsWith('.txt') ? [join(dir, entry.name)] : [];
    });
    let normal = 0;
    for (const path of screens(join(import.meta.dirname, 'fixtures', 'herdr'))) {
      const screen = readFileSync(path, 'utf8');
      const region = composerRegionText(screen);
      if (region === null) continue;
      normal += 1;
      expect(composerFieldView(screen), path).toEqual({ text: region, cutAtTop: false, history: false });
    }
    expect(normal).toBeGreaterThan(5);
    expect(composerFieldView(measured('zabranie-historia-po-down-2.1.328.txt')))
      .toEqual({ text: '', cutAtTop: false, history: false });
  });

  it('a dialog or a form on screen, including a dialog line `↑ N more lines`, is no field', () => {
    for (const name of [
      'zabranie-dialog-przed-2.1.328.txt', 'zabranie-dialog-po-up-2.1.328.txt',
      'zabranie-formularz-przed-2.1.328.txt', 'zabranie-formularz-po-up-2.1.328.txt',
      'zabranie-formularz-po-down-2.1.328.txt',
    ]) expect(composerFieldView(measured(name)), name).toBeNull();
    expect(composerFieldView(fixture(join('measured', 'zgoda-bash-wysoka-2.1.328.txt')))).toBeNull();
  });

  it('a cut or history shape that is not the last field on screen, or is malformed, is no field', () => {
    const rule = '─'.repeat(26);
    const longField = `─── ↑ 3 more ─────────────\n  dalszy tekst\n${rule}`;
    expect(composerFieldView(longField)).toEqual({ text: '  dalszy tekst', cutAtTop: true, history: false });
    expect(composerFieldView(`${longField}\n❯ stray prompt line`)).toBeNull();
    expect(composerFieldView(`${longField}\n${longField}`)).toEqual(composerFieldView(longField));
    expect(composerFieldView(`${longField}\n  ? for shortcuts`)).toEqual(composerFieldView(longField));
    expect(composerFieldView(`─── History 2/5 ──────────\n  no prompt sign\n${rule}`)).toBeNull();
    expect(composerFieldView(`─── ↑ 3 more ─────────────\n❯ text\n${rule}`)).toBeNull();
    expect(composerFieldView('─── ↑ 3 more ─────────────\n  no bottom rule')).toBeNull();
  });

  it('the last field on screen wins: a normal field above a later cut field does not answer for it', () => {
    const rule = '─'.repeat(26);
    const oldField = `${rule}\n❯ old draft\n${rule}`;
    expect(composerFieldView(`${oldField}\n─── ↑ 3 more ─────────────\n  current tail\n${rule}`))
      .toEqual({ text: '  current tail', cutAtTop: true, history: false });
    expect(composerFieldView(`${oldField}\n─── ↑ 3 more ─────────────\n  current tail`)).toBeNull();
    expect(composerFieldView(`${oldField}\n─── History 2/5 ──────────\n❯ entry\n${rule}`))
      .toEqual({ text: ' entry', cutAtTop: false, history: true });
  });
});

/*
 * The CLI queue around the prompt field, measured on CLI 2.1.328 (`queue/measured/zabranie-*-przed-up`): the dimmed
 * hint `Press up to edit queued…` in an empty field and the `ctrl+enter to send now` line under the queued prompts.
 * The captures carry no attributes, so the hint is dimmed here the way the live `visible` + `ansi` read shows it.
 */
describe('composerQueueShown: the CLI queue around the prompt field', () => {
  const measured = (name: string): string => fixture(join('queue', 'measured', name));
  const HINT = /Press up to edit queued(?: messages|…)/;
  const dimmed = (screen: string): string => screen.replace(HINT, (hint) => `${E}[2m${hint}${E}[22m`);
  const rule = '─'.repeat(26);

  it.each([
    'zabranie-przed-up-2.1.328.txt', 'zabranie-szeroki-przed-up-2.1.328.txt', 'zabranie-meldunek-przed-up-2.1.328.txt',
  ])('%s: the queue shows and the field reads empty', (name) => {
    const screen = dimmed(measured(name));
    expect(composerQueueShown(screen)).toBe(true);
    expect(composerRegionText(screen)?.trim()).toBe('');
  });

  it('the line under the queued prompts alone shows the queue; the dimmed hint alone shows it too', () => {
    const marker = measured('zabranie-przed-up-2.1.328.txt').replace(HINT, '');
    expect(composerQueueShown(marker)).toBe(true);
    expect(composerQueueShown(`${rule}\n❯ ${E}[2mPress up to edit queued…${E}[22m\n${rule}`)).toBe(true);
  });

  it('no queue: a plain field, the field after `up`, a hint read without attributes, a marker far above', () => {
    expect(composerQueueShown(`${rule}\n❯ \n${rule}`)).toBe(false);
    expect(composerQueueShown(measured('zabranie-po-up-2.1.328.txt'))).toBe(false);
    expect(composerQueueShown(`${rule}\n❯ Press up to edit queued…\n${rule}`)).toBe(false);
    const far = `  ctrl+enter to send now\n${'\nagent text'.repeat(14)}\n${rule}\n❯ \n${rule}`;
    expect(composerQueueShown(far)).toBe(false);
  });
});
