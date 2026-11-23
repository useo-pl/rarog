/**
 * Zgoda Bash z opcją „Yes, allow reading from <katalog> from this project” (CLI 2.1.294–2.1.296).
 *
 * Dialog stawia komenda spod reguły `ask`, która sięga poza katalog projektu. Słownik
 * eskalacji musi znać tę etykietę: inaczej „Zatwierdź” ma dwóch kandydatów („Yes” i opcję z regułą odczytu),
 * więc `affirmativeOption` oddaje `null`, a tapnięcie kończy się odmową `no-digit` (18 z 36 odmów
 * w 30 dni; przegląd zrzutów `refusals/`). Fixture'y to wycinki tych zrzutów z podmienionymi ścieżkami.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { optionEscalates, readGrantTruncated } from '../src/herdr/dialogs/policy/escalation.ts';
import { parseOptions } from '../src/herdr/dialogs/screen/parse.ts';
import { resolveOptions } from '../src/herdr/dialogs/screen/resolve.ts';
import { affirmativeOption, alwaysOption } from '../src/herdr/dialogs/policy/options.ts';

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, 'fixtures', 'herdr', name), 'utf8');

describe('zgoda Bash: „Yes, allow reading from … from this project”', () => {
  const text = fixture('dialog-permission-odczyt-z-projektu.txt');
  const options = parseOptions(text)?.options ?? [];

  it('parser widzi trzy opcje dialogu narzędzia Bash', () => {
    expect(parseOptions(text)).toMatchObject({ kind: 'tool', toolName: 'Bash' });
    expect(options.map((option) => option.label)).toEqual([
      'Yes',
      'Yes, allow reading from /Users/u/.local/share/dane from this project',
      'No',
    ]);
    expect(resolveOptions(text, { toolName: 'Bash' }).status).toBe('ok');
  });

  it('opcja z regułą odczytu to eskalacja, więc „Zatwierdź” ma jednego kandydata', () => {
    expect(optionEscalates(options[1]?.label ?? '')).toBe(true);
    expect(affirmativeOption(options)).toMatchObject({ digit: '1', label: 'Yes' });
  });

  it('przycisk „zawsze” niesie tę etykietę dosłownie', () => {
    expect(alwaysOption(options)).toMatchObject({
      digit: '2', label: 'Yes, allow reading from /Users/u/.local/share/dane from this project',
    });
  });
});

/*
 * Panel 63 kolumny: etykieta opcji 2 zawija się na trzy linie, a trzecia („project”) nakłada się na
 * linię opcji 3 („3. Nooject”). Marker eskalacji musi więc stać w PIERWSZEJ linii etykiety.
 */
describe('ta sama zgoda w wąskim panelu: etykieta ucięta przez zawinięcie', () => {
  const options = parseOptions(fixture('dialog-permission-odczyt-z-projektu-waski.txt'))?.options ?? [];

  it('opcja 2 dalej jest eskalacją, „Zatwierdź” to cyfra 1', () => {
    expect(options[1]?.label).toMatch(/^Yes, allow reading from \/private\/tmp\/folders\//);
    expect(optionEscalates(options[1]?.label ?? '')).toBe(true);
    expect(affirmativeOption(options)).toMatchObject({ digit: '1', label: 'Yes' });
  });

  it('ucięta etykieta nie dostaje przycisku „zawsze”: zostaje w terminalu', () => {
    expect(options[1]?.label).toMatch(/from this$/);
    expect(readGrantTruncated(options[1]?.label ?? '')).toBe(true);
    expect(alwaysOption(options)).toBeNull();
  });
});

describe('pełna etykieta zgody na odczyt zostaje kandydatem przycisku „zawsze”', () => {
  it('zakres „from this project” i „during this session” to etykiety pełne', () => {
    expect(readGrantTruncated('Yes, allow reading from /Users/u/.local/share/dane from this project')).toBe(false);
    expect(readGrantTruncated('Yes, allow reading from /etc and /private/etc during this session')).toBe(false);
    expect(readGrantTruncated('Yes, and always allow access to /tmp from this project')).toBe(false);
    expect(readGrantTruncated('Yes')).toBe(false);
  });

  it('zgoda Read z CLI 2.1.278 („during this session”) dalej ma przycisk „zawsze”', () => {
    const read = parseOptions(fixture('dialog-permission-read-2.1.278.txt'))?.options ?? [];
    expect(alwaysOption(read)?.label).toBe('Yes, allow reading from /etc and /private/etc during this session');
  });
});

describe('słownik eskalacji: „allow reading from” nie łapie zwykłego „Yes”', () => {
  it('zwykłe potwierdzenia zostają bez eskalacji', () => {
    expect(optionEscalates('Yes')).toBe(false);
    expect(optionEscalates('Yes, proceed')).toBe(false);
    expect(optionEscalates('No')).toBe(false);
  });
});
