/**
 * Karta bez przycisków nad ekranem BEZ opcji z cyframi: na karcie blok dialogu zamiast ogona ekranu.
 *
 * Widoki slash-komend (`/help`, `/status`), zaufanie bez cyfr, ekran `/login` i dialog zgody CLI nie mają opcji
 * z cyframi, więc karta nie ma przycisków, a powód zostaje `unreadable`. Wycinek na kartę to linie spod najniższej
 * kreski bloku (`blockExcerpt` w `server/src/herdr/dialogs/screen/excerpt.ts`), a tytuł bloku wchodzi do `reqId`
 * (`screenFallbackReqId`). Ekran ponad sufit wycinka, bez kreski, bez sygnału dialogu, z widocznym polem promptu
 * i karta odmowy ze zrzutu hooka zostają przy ogonie ekranu (`snippet`). Opis: `docs/dialogs.md`, „Dialog block”.
 *
 * Kreskę bloku i tytuł test bierze z WŁASNEJ tabeli i własnego wzorca, nie z funkcji modułu: test, który sprawdza
 * moduł jego własnym kodem, nie sprawdza niczego.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decideCard } from '../src/herdr/dialogs/decide/decide.ts';
import { evaluationReqId } from '../src/herdr/dialogs/decide/sources.ts';
import type { DecideAction, DecideInput } from '../src/herdr/dialogs/decide/input.ts';
import { screenDialogCard } from '../src/herdr/dialogs/cards/build.ts';
import { screenFallbackReqId } from '../src/herdr/dialogs/cards/ids.ts';
import { hookPendingFrom } from '../src/herdr/dialogs/cross-check.ts';
import type { PendingHookTool } from '../src/herdr/dialogs/hook/dump.ts';
import { blockExcerpt } from '../src/herdr/dialogs/screen/excerpt.ts';
import { resolveOptions } from '../src/herdr/dialogs/screen/resolve.ts';
import { SCREEN_SIGNATURES } from '../src/herdr/dialogs/screen/signatures.ts';
import { snippet } from '../src/herdr/dialogs/screen/snippet.ts';

const DIR = join(import.meta.dirname, 'fixtures', 'herdr');
const MARK = '\n--- ekran ---\n';

/** Plik fixture'u; zrzut odmowy (`refusals/`) ma nad ekranem nagłówek `klucz: wartość`. */
function read(name: string): { head: Readonly<Record<string, string>>; screen: string } {
  const raw = readFileSync(join(DIR, name), 'utf8');
  const at = raw.indexOf(MARK);
  if (at < 0) return { head: {}, screen: raw };
  const head = Object.fromEntries(raw.slice(0, at).split('\n').map((line) => {
    const colon = line.indexOf(': ');
    return [line.slice(0, colon), line.slice(colon + 2)];
  }));
  return { head, screen: raw.slice(at + MARK.length) };
}

const screenOf = (name: string): string => read(name).screen;

/** Linie ekranu bez końcowych białych znaków i bez pustego ogona — własna kopia, nie `trimmedLines` modułu. */
function linesOf(screen: string): string[] {
  const lines = screen.split('\n').map((line) => line.replace(/\s+$/u, ''));
  while (lines.length > 0 && lines.at(-1) === '') lines.pop();
  return lines;
}

/** Kreska nad tytułem bloku: `─`/`▔` od 8 znaków, także `▔` ze statusem sesji przed końcem. */
const RULE_LIKE = /^(?:─{8,}|▔{8,}(?: .+ ▔+)?)$/u;

/** Wejście decyzji jak w driverze po ponowionym odczycie: bez źródeł, wycinek ogona ekranu jak `#snippet`. */
function input(text: string, over: Partial<DecideInput> = {}): DecideInput {
  return {
    pending: null,
    hookPending: null,
    text,
    reqId: evaluationReqId(null, null, null, 1),
    active: null,
    blockedSeq: 1,
    answeredSeq: -1,
    hookAnswersEnabled: true,
    deadAnswerKey: null,
    canRetry: false,
    answeredHookCall: null,
    decided: null,
    resolve: resolveOptions,
    excerpt: (value: string) => snippet(value)?.text ?? null,
    hookRaw: null,
    ...over,
  };
}

function screenDialogOf(action: DecideAction): Extract<DecideAction, { kind: 'screen-dialog' }> {
  if (action.kind !== 'screen-dialog') throw new Error(`oczekiwana karta ekranowa, jest ${action.kind}`);
  return action;
}

/** Karta, którą driver stawia z akcji `screen-dialog` (`#showScreenDialog`). */
function cardOf(action: Extract<DecideAction, { kind: 'screen-dialog' }>) {
  return screenDialogCard(action.reqId, action.resolved, action.reason, action.screen, null, action.origin);
}

/** `reqId` karty bez opcji i bez tytułu — ten sam sufiks co w nagłówkach zrzutów `refusals/` sprzed zmiany. */
const UNTITLED = 'screen:1:f:30db357025d1';

/**
 * Sześć ekranów bez opcji z cyframi, z blokiem dialogu: plik → tytuł bloku (pierwsza niepusta linia pod kreską).
 * Tytuł to dane testu, nie mapa w kodzie. Dialog zaufania bez cyfr nie jest tu ekranem `unreadable`: pełny render
 * to znany dialog `trust` ścieżki strzałki (`TRUST_ARROW` niżej).
 */
const BLOCKS = [
  ['refusals/widok-help-2.1.310.txt', 'Help  General   Commands   Custom commands'],
  ['refusals/widok-status-2.1.310.txt', 'Settings  Status   Config   Usage   Stats'],
  ['refusals/widok-status-stechly-zrzut-2.1.310.txt', 'Settings  Status   Config   Usage   Stats'],
  ['dialog-automode-teach-2.1.258.txt', 'Teach auto mode about your environment?'],
  ['ekran-login-2.1.293.txt', 'Login'],
  // Suwak pickera `/effort` w panelu 26 kolumn (CLI 2.1.312): goła kreska `▔`, bez opcji z cyframi.
  ['measured/picker-effort-2.1.312-26kol.txt', 'Effort'],
] as const;

/** Dialogi zaufania bez cyfr w korpusie: znany dialog `trust` bez opcji z cyframi, bez powodu odmowy. */
const TRUST_ARROW = ['refusals/zaufanie-bez-cyfr-2.1.311.txt', 'dialog-trust-2.1.293.txt'] as const;

describe('dialog zaufania bez cyfr: znany dialog `trust`, nie ekran `unreadable`', () => {
  for (const file of TRUST_ARROW) {
    it(`${file}: karta znanego dialogu bez opcji z cyframi, bez powodu odmowy`, () => {
      const action = screenDialogOf(decideCard(input(screenOf(file))));
      expect(action).toMatchObject({ reason: null, audit: null, origin: { source: 'screen' } });
      expect(action.resolved).toMatchObject({ knownDialog: 'trust', options: [] });
    });
  }
});

describe('wycinek bloku na sześciu ekranach bez opcji', () => {
  for (const [file, title] of BLOCKS) {
    it(`${file}: na karcie blok spod kreski, tytuł „${title}”, powód \`unreadable\``, () => {
      const screen = screenOf(file);
      const lines = linesOf(screen);
      const at = lines.findLastIndex((line) => line.trim() === title);
      expect(at, 'tytuł z tabeli stoi na ekranie').toBeGreaterThan(0);
      expect(RULE_LIKE.test((lines[at - 1] ?? '').trim()), 'nad tytułem kreska bloku').toBe(true);

      const action = screenDialogOf(decideCard(input(screen)));
      expect(action).toMatchObject({ reason: 'unreadable', audit: 'unreadable', origin: { source: 'screen' } });
      expect(action.resolved).toMatchObject({ knownDialog: null, options: [] });
      // Ciągły fragment od pierwszej linii pod kreską do końca ekranu, bez kreski i bez niczego nad nią.
      expect(action.screen).toBe(lines.slice(at).join('\n'));
      expect(action.screen?.split('\n')[0]).toBe(lines[at]);
      expect(action.screen).toContain(title);
      expect(action.screen).not.toContain(lines[at - 1]);

      const card = cardOf(action);
      expect(card.active.options).toEqual([]);
      expect(card.event).toEqual({ type: 'screen-dialog', reason: 'unreadable', screen: action.screen });
    });
  }

  it('zaufanie bez cyfr (CLI 2.1.311): zrzut z dnia odmowy to ścieżka ekranowa, `reqId` bez tytułu', () => {
    const { head } = read('refusals/zaufanie-bez-cyfr-2.1.311.txt');
    expect(head).toMatchObject({ reason: 'unreadable', toolName: 'brak', hook: 'brak', jsonl: 'brak',
      source: 'screen', optionCount: '0', dialogTitle: 'brak', reqId: UNTITLED });
    // Zrzut powstał bez klasy z rejestru sesji CLI (pole `cliDialog` nie stoi w nagłówku).
    expect(head).not.toHaveProperty('cliDialog');
  });
});

describe('tytuł bloku w `reqId` karty bez opcji', () => {
  const HELP = screenOf('refusals/widok-help-2.1.310.txt');
  const STATUS = screenOf('refusals/widok-status-2.1.310.txt');
  const untitled = (seq: number): string => screenFallbackReqId(evaluationReqId(null, null, null, seq), {
    knownDialog: null, reason: 'unreadable', question: null, options: [],
  });

  it('karta bez opcji i bez tytułu ma dzisiejszy sufiks (punkt odniesienia)', () => {
    expect(untitled(1)).toBe(UNTITLED);
  });

  it('`/help`, potem `/status` w tej samej blokadzie: dwie karty o różnych `reqId`, druga zamiast `keep`', () => {
    const help = screenDialogOf(decideCard(input(HELP)));
    expect(help.reqId).toBe(screenFallbackReqId(evaluationReqId(null, null, null, 1), {
      knownDialog: null, reason: 'unreadable', question: null, options: [],
      title: 'Help  General   Commands   Custom commands',
    }));
    expect(help.reqId).not.toBe(UNTITLED);

    const status = screenDialogOf(decideCard(input(STATUS, { active: cardOf(help).active })));
    expect(status.reqId).not.toBe(help.reqId);
    expect(status.screen?.split('\n')[0]?.trim()).toBe('Settings  Status   Config   Usage   Stats');
  });

  it('ten sam widok przy ponownej ocenie: `keep` z przestawieniem `seq`, bez nowej karty', () => {
    const help = screenDialogOf(decideCard(input(HELP)));
    expect(decideCard(input(HELP, { active: cardOf(help).active }))).toEqual({ kind: 'keep', touchSeq: true });
  });

  it('ten sam widok w nowej blokadzie (po mignięciu statusu): nowy `reqId`, jak przed zmianą', () => {
    const first = screenDialogOf(decideCard(input(HELP)));
    const next = screenDialogOf(decideCard(input(HELP, {
      reqId: evaluationReqId(null, null, null, 2), blockedSeq: 2, active: cardOf(first).active,
    })));
    expect(next.reqId.startsWith('screen:2:f:')).toBe(true);
    expect(next.reqId).not.toBe(first.reqId);
    expect(next.screen).toBe(first.screen);
  });
});

/*
 * Ekrany bez opcji, które zostają przy ogonie ekranu: blok ponad sufit wycinka (40 linii, 2000 znaków), ekran bez
 * kreski bloku, kreska bez sygnału dialogu (`────` bez `▔` i bez stopki klawiszowej pod nią) i widoczne pole promptu.
 */
const TAILS = [
  ['refusals/widok-skills-2.1.310.txt', 'ponad sufit'],
  ['dialog-askuserquestion-linia-nazwy-luka-2.1.281.txt', 'ponad sufit'],
  ['dialog-bash-przewiniety-widok-2.1.295.txt', 'bez kreski'],
  ['refusals/powloka-zawiniete-polecenie.txt', 'bez kreski'],
  ['refusals/powloka-komunikat-przed-promptem.txt', 'bez kreski'],
  ['footer-auto-tacka.txt', 'bez sygnału'],
  ['footer-auto.txt', 'pole promptu'],
  ['composer-empty-2.1.258.ansi.txt', 'pole promptu'],
  ['composer-ghost-suggestion-2.1.258.ansi.txt', 'pole promptu'],
  ['composer-region-empty-2.1.283.ansi.txt', 'pole promptu'],
  ['composer-region-leading-blank-2.1.283.ansi.txt', 'pole promptu'],
  ['composer-region-one-line-2.1.283.ansi.txt', 'pole promptu'],
  ['composer-region-wrapped-2.1.283.ansi.txt', 'pole promptu'],
] as const;

describe('ekrany bez bloku na karcie: ogon ekranu, `reqId` i powód jak przed zmianą', () => {
  for (const [file, why] of TAILS) {
    it(`${file} (${why})`, () => {
      const screen = screenOf(file);
      expect(blockExcerpt(screen)).toBeNull();
      const action = screenDialogOf(decideCard(input(screen)));
      expect(action).toMatchObject({ reqId: UNTITLED, reason: 'unreadable', audit: 'unreadable' });
      expect(action.screen).toBe(snippet(screen)?.text ?? null);
    });
  }

  it('lista obejmuje każdy ekran bez opcji z cyframi spoza tabeli bloków (katalog, `measured/`, `refusals/`)', () => {
    const all = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (
      entry.isDirectory()
        ? (['measured', 'refusals'].includes(entry.name) ? all(join(dir, entry.name)) : [])
        : entry.name.endsWith('.txt') ? [relative(DIR, join(dir, entry.name))] : []
    ));
    const noOptions = all(DIR).filter((file) => {
      const action = decideCard(input(screenOf(file)));
      return action.kind === 'screen-dialog' && action.reason === 'unreadable';
    });
    expect(noOptions.sort()).toEqual([...BLOCKS, ...TAILS].map(([file]) => file).sort());
  });
});

describe('karta odmowy ze zrzutu hooka zostaje przy ogonie ekranu', () => {
  const { head, screen } = read('refusals/widok-status-stechly-zrzut-2.1.310.txt');
  const at = Date.parse(/\bat=(\S+)$/u.exec(head['hook'] ?? '')?.[1] ?? '');
  const hookRaw: PendingHookTool = {
    toolName: 'AskUserQuestion',
    hookEventName: 'PermissionRequest',
    at,
    promptId: head['promptId'] ?? '',
    answerKey: 'klucz-syntetyczny',
    // Pytanie syntetyczne (zrzut nie niesie `tool_input`): formularza i tak nie ma na ekranie.
    toolInput: {
      questions: [{
        question: 'Który wariant wybrać?', header: 'Wariant', multiSelect: false,
        options: [{ label: 'Pierwszy', description: '' }, { label: 'Drugi', description: '' }],
      }],
    },
  };
  const hookPending = hookPendingFrom(hookRaw);

  it('`/status` przy stęchłym zrzucie `AskUserQuestion`: powód ze ścieżki hooka, ogon ekranu, `reqId` ze zrzutu', () => {
    expect(Number.isFinite(at)).toBe(true);
    if (hookPending === null) return expect.unreachable('zrzut hooka bez kształtu PendingTool');
    const action = screenDialogOf(decideCard(input(screen, {
      reqId: evaluationReqId(null, hookPending, hookRaw, 1), hookPending, hookRaw,
    })));
    expect(action).toMatchObject({ reqId: head['reqId'], reason: 'unreadable', audit: 'unreadable' });
    expect(action.origin).toEqual({ source: 'hook', promptId: head['promptId'] });
    expect(action.screen).toBe(snippet(screen)?.text ?? null);
    // Ten sam ekran bez zrzutu dostaje blok — różnicę robi wyłącznie powód ze ścieżki hooka.
    expect(blockExcerpt(screen)).not.toBeNull();
    expect(cardOf(action).active.options).toEqual([]);
  });
});

describe('widoczne pole promptu: wycinka bloku nie ma', () => {
  const FIELD = linesOf(screenOf('footer-auto.txt')).slice(0, 2).join('\n');
  const TRAY = screenOf('footer-auto-tacka.txt');

  it('pełny ekran: pole promptu z nazwą sesji, pod nim tacka agentów — wycinek `null`, ogon ekranu', () => {
    const screen = `${FIELD}\n${TRAY}`;
    expect(blockExcerpt(screen)).toBeNull();
    const action = screenDialogOf(decideCard(input(screen)));
    expect(action).toMatchObject({ reqId: UNTITLED, reason: 'unreadable' });
    expect(action.screen).toBe(snippet(screen)?.text ?? null);
  });

  it('syntetyczny: pod polem promptu linia zaczynająca się od klawisza — ten sam ekran z polem zostaje przy ogonie', () => {
    // Linia „esc to …” pod kreską daje sygnał dialogu, więc sam wycinek bloku by się udał; pole promptu go wyłącza.
    const screen = `${FIELD}\n${TRAY.replace('  ⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent', '  esc to interrupt')}`;
    expect(blockExcerpt(screen)).not.toBeNull();
    const action = screenDialogOf(decideCard(input(screen)));
    expect(action).toMatchObject({ reqId: UNTITLED, reason: 'unreadable' });
    expect(action.screen).toBe(snippet(screen)?.text ?? null);
  });
});

describe('`blockRuleWithStatus`: kreska `▔` ze statusem sesji', () => {
  const pattern = SCREEN_SIGNATURES.blockRuleWithStatus.pattern;
  /** Linia z `▔` i statusem `/effort` w pliku — wybrana własnym warunkiem, nie wzorcem z rejestru. */
  const statusRule = (file: string): string => {
    const line = linesOf(screenOf(file)).find((l) => l.startsWith('▔') && l.includes('/effort'));
    if (line === undefined) throw new Error(`${file}: brak kreski ze statusem`);
    return line;
  };

  it.each([
    'refusals/widok-help-2.1.310.txt',
    'refusals/widok-status-stechly-zrzut-2.1.310.txt',
    'measured/exitplanmode-2.1.278.txt',
  ])('trafia w kreskę ze statusem: %s', (file) => {
    expect(pattern.test(statusRule(file).trim())).toBe(true);
  });

  it('nie trafia w kreskę z nazwą sesji, gołą `▔`, kreskę pola promptu z nazwą ani tekst z `▔` w środku', () => {
    const named = linesOf(screenOf('dialog-askuserquestion-linia-nazwy-2.1.281.txt'))
      .find((l) => l.endsWith(' pomiar-nazwy ─'));
    const bare = linesOf(screenOf('refusals/widok-status-2.1.310.txt')).find((l) => /^▔{8,}$/u.test(l));
    const composer = linesOf(screenOf('footer-auto.txt'))[0];
    for (const line of [named, bare, composer]) {
      expect(line).toBeDefined();
      expect(pattern.test((line ?? '').trim()), line).toBe(false);
    }
    expect(pattern.test(`tekst ${'▔'.repeat(12)} tekst`)).toBe(false);
    expect(pattern.test(`${'▔'.repeat(12)} tekst`)).toBe(false);
  });

  it('`blockRule` bez zmian dla pozostałych odbiorców, a nowy literał czyta tylko `blockTopOf`', () => {
    expect(SCREEN_SIGNATURES.blockRule.pattern.source).toBe('^(?:─{8,}|▔{8,})$');
    expect(SCREEN_SIGNATURES.blockRule.pattern.flags).toBe('');
    const SRC = join(import.meta.dirname, '..', 'src');
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (
      entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith('.ts') ? [join(dir, entry.name)] : []
    ));
    const readers = files(SRC)
      .filter((file) => readFileSync(file, 'utf8').includes('blockRuleWithStatus'))
      .map((file) => relative(SRC, file))
      .sort();
    // Wycinek i odcisk bloku czytają kreskę ze statusem przez `blockTopOf` (`screen/region.ts`), nie wprost.
    expect(readers).toEqual(['herdr/dialogs/screen/region.ts', 'herdr/dialogs/screen/signatures.ts']);
  });
});
