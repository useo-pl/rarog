/**
 * Zgody z pomiaru na CLI 2.1.293 (`measured/*-2.1.293.txt`).
 *
 * - Zgoda Bash ma DWIE opcje eskalujące (reguła katalogu i przełącznik trybu) — przycisk
 *   „zawsze" dostaje reguła, przełącznik trybu odpada.
 * - Dialog sieci sandboksa nie ma hooka ani własnego wpisu w jsonl; czekający wtedy `Bash` to
 *   komenda, która poprosiła o sieć. Karta zgody z ekranu, wyłącznie jednorazowa.
 * - „Exit plan mode?" (ExitPlanMode bez pliku planu) to dialog planu, a opcja przejścia do
 *   trybu `default` (ask each time) nie jest eskalacją.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SANDBOX_NETWORK_TOOL } from '../src/herdr/dialogs/screen/kinds.ts';
import { parseOptions, screenOnlyDialog } from '../src/herdr/dialogs/screen/parse.ts';
import { resolveOptions } from '../src/herdr/dialogs/screen/resolve.ts';
import { optionEscalates } from '../src/herdr/dialogs/policy/escalation.ts';
import { parseModeFooter } from '../src/herdr/dialogs/screen/mode-footer.ts';
import { screenPermissionCard } from '../src/herdr/dialogs/cards/build.ts';
import { affirmativeOption, alwaysOption } from '../src/herdr/dialogs/policy/options.ts';
import { decideCard } from '../src/herdr/dialogs/decide/decide.ts';
import { decideReqId } from '../src/herdr/dialogs/decide/sources.ts';
import type { DecideInput } from '../src/herdr/dialogs/decide/input.ts';
import type { PendingTool } from '../src/herdr/jsonl-pending.ts';

const measured = (name: string): string =>
  readFileSync(join(import.meta.dirname, 'fixtures', 'herdr', 'measured', name), 'utf8');
const fixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, 'fixtures', 'herdr', name), 'utf8');

const optionsOf = (name: string) => parseOptions(measured(name))?.options ?? [];

describe('przycisk „zawsze" przy dwóch opcjach eskalujących', () => {
  it('Bash 2.1.293: reguła katalogu wygrywa z przełącznikiem trybu', () => {
    expect(alwaysOption(optionsOf('zgoda-bash-2.1.293.txt'))?.label)
      .toBe('Yes, and always allow access to /Users/u/Library/Caches from this project');
    expect(affirmativeOption(optionsOf('zgoda-bash-2.1.293.txt'))?.label).toBe('Yes');
  });

  it('Bash 2.1.285 (panel 128 kolumn): to samo', () => {
    expect(alwaysOption(optionsOf('zgoda-bash-2.1.285.txt'))?.label)
      .toBe('Yes, and always allow access to /tmp from this project');
  });

  it('pojedynczy przełącznik trybu zostaje kandydatem jak dotąd', () => {
    expect(alwaysOption(optionsOf('exitplanmode-2.1.293.txt'))?.label).toBe('Yes, and use auto mode');
    expect(alwaysOption(optionsOf('zgoda-edit-2.1.293.txt'))?.label).toMatch(/^Yes, and switch to accept edits/);
  });

  it('dwie REGUŁY naraz to remis — fail-closed', () => {
    expect(alwaysOption([
      { digit: '1', label: 'Yes' },
      { digit: '2', label: "Yes, and don't ask again for git commands" },
      { digit: '3', label: 'Yes, and always allow access to /tmp from this project' },
      { digit: '4', label: 'No' },
    ])).toBeNull();
  });
});

describe('„Exit plan mode?" to dialog planu', () => {
  const text = measured('exitplanmode-bez-planu-2.1.293.txt');

  it('parser oddaje `tool` z nazwą `ExitPlanMode`, nie `confirm`', () => {
    expect(parseOptions(text)).toMatchObject({ kind: 'tool', toolName: 'ExitPlanMode' });
    expect(resolveOptions(text, { toolName: 'ExitPlanMode' }).status).toBe('ok');
  });

  it('„switch to default (ask each time)" to zwykłe „Zatwierdź", bez przycisku „zawsze"', () => {
    const options = parseOptions(text)?.options ?? [];
    expect(affirmativeOption(options)?.digit).toBe('1');
    expect(alwaysOption(options)).toBeNull();
  });

  it('wyjątek jest wąski: inny marker w tej samej etykiecie dalej eskaluje', () => {
    expect(optionEscalates('Yes, and switch to default (ask each time) for this session')).toBe(false);
    expect(optionEscalates('Yes, and switch to default (ask each time) and always allow git')).toBe(true);
    expect(optionEscalates('Yes, allow all edits during this session')).toBe(true);
  });
});

describe('dialog sieci sandboksa — karta zgody, wyłącznie jednorazowa', () => {
  const text = measured('zgoda-siec-2.1.293.txt');

  it('parser rozpoznaje dialog po tytule nad ramką `╌╌╌` i niesie host w treści', () => {
    const dialog = parseOptions(text);
    expect(dialog).toMatchObject({ kind: 'tool', toolName: SANDBOX_NETWORK_TOOL });
    expect(dialog?.question?.question).toBe(
      'Network request outside of sandbox\nHost: example.org\nDo you want to allow this connection?',
    );
    expect(screenOnlyDialog(text)).toBe(true);
    expect(screenOnlyDialog(measured('zgoda-bash-2.1.293.txt'))).toBe(false);
  });

  it('karta z ekranu: „Zatwierdź" = „Yes", bez przycisku „zawsze"', () => {
    const resolution = resolveOptions(text, null);
    expect(resolution.status).toBe('no-jsonl');
    if (resolution.status !== 'no-jsonl' || resolution.questionForm === null) throw new Error('brak formularza');
    const card = screenPermissionCard(resolution.questionForm, 7);
    expect(card.event).toMatchObject({ type: 'permission-request', toolName: SANDBOX_NETWORK_TOOL });
    expect(card.event).not.toHaveProperty('alwaysLabel');
    expect(affirmativeOption(card.active.options)?.label).toBe('Yes');
  });

  it('czekający wpis `Bash` z jsonl nie odbiera karty (dawniej `mismatch`)', () => {
    const bash: PendingTool = {
      id: 'toolu_curl', toolName: 'Bash', input: { command: 'curl -sI https://example.org' }, at: '',
    };
    const input: DecideInput = {
      pending: bash,
      hookPending: null,
      text,
      reqId: decideReqId(bash, 7),
      active: null,
      blockedSeq: 7,
      answeredSeq: -1,
      hookAnswersEnabled: true,
      deadAnswerKey: null,
      canRetry: false,
      answeredHookCall: null,
      decided: null,
      resolve: resolveOptions,
      excerpt: (screen: string) => screen.trim(),
      hookRaw: null,
    };
    const action = decideCard(input);
    expect(action.kind).toBe('card');
    if (action.kind !== 'card') return;
    expect(action.card.event).toMatchObject({ type: 'permission-request', toolName: SANDBOX_NETWORK_TOOL });
    expect(action.card.event).not.toHaveProperty('alwaysLabel');
  });
});

/*
 * Żywy dialog zaufania CLI 2.1.293 ma opcje BEZ numerów („❯ No, exit / Yes, I trust this folder").
 * Parser cyfr nie widzi opcji, a cyfry nie zgaduje się po kolejności. Pełny render rozpoznaje osobny parser
 * ścieżki strzałki: znany dialog `trust` bez opcji z cyframi.
 */
describe('dialog zaufania bez numerów — bez opcji z cyframi, rozpoznanie ścieżki strzałki', () => {
  const text = fixture('dialog-trust-2.1.293.txt');

  it('parser cyfr nie widzi opcji ani formularza; rozpoznanie `trust` bez fikcyjnych cyfr', () => {
    expect(parseOptions(text)).toBeNull();
    expect(resolveOptions(text, null)).toMatchObject({
      status: 'no-jsonl', knownDialog: 'trust', questionForm: null, options: [],
    });
  });
});

/*
 * Ekran `/login` („Login successful. Press Enter to continue…") zasłania stopkę trybu, więc
 * bramka wysyłki promptu mówi `mode-unknown` (zrzut z pomiaru, e-mail zanonimizowany).
 * To poprawne „nie wiem" — przyczynę nazywa komunikat, gdy rejestr CLI powie `waiting`.
 */
describe('ekran /login nie ma stopki trybu ani opcji', () => {
  const text = fixture('ekran-login-2.1.293.txt');

  it('tryb `unknown`, dialogu z cyframi brak', () => {
    expect(parseModeFooter(text)).toBe('unknown');
    expect(parseOptions(text)).toBeNull();
  });
});
