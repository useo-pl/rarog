/**
 * Etykiety opcji zawinięte przez wąski panel.
 *
 * Measured on Claude Code 2.1.293 (63-column panel, `measured/*-2.1.293.txt`): a label longer than the
 * column wraps onto the next lines. A parser that takes only the line with the digit fails the preview form
 * match against the hook snapshot (refusal `no-digit`) and gives the Bash consent card the button
 * "Yes, and always allow access to" without the directory.
 *
 * Dwie reguły, obie fail-closed:
 * - ZGODA, potwierdzenie i lewa kolumna formularza z PODGLĄDEM — pod opcją nie ma opisów, więc
 *   linie kontynuacji należą do etykiety (bez podpowiedzi klawiszowych);
 * - PYTANIE bez podglądu — opis stoi w tej samej kolumnie co kontynuacja, więc rozstrzygają
 *   etykiety z payloadu, i to wyłącznie przy PEŁNEJ równości (żadnego dopasowania prefiksem).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ASK_USER_QUESTION_TOOL, resolveOptions } from '../src/herdr/dialogs/screen/resolve.ts';
import { parseOptions } from '../src/herdr/dialogs/screen/parse.ts';
import type { LabelGuide } from '../src/herdr/dialogs/screen/options.ts';
import { applyMultiSelectOverride, hookQuestionFrom } from '../src/herdr/dialogs/cross-check.ts';
import type { ActiveReq } from '../src/herdr/dialogs/cards/build.ts';
import { confirmFormSubmit } from '../src/herdr/dialogs/send/form-submit.ts';
import type { PendingTool } from '../src/herdr/jsonl-pending.ts';

const measured = (name: string): string =>
  readFileSync(join(import.meta.dirname, 'fixtures', 'herdr', 'measured', name), 'utf8');

const labelsOf = (text: string, labels?: readonly LabelGuide[]): (string | undefined)[] =>
  (parseOptions(text, { labels })?.options ?? []).map((option) => option.label);

const PREVIEW = measured('pytanie-preview-2.1.293.txt');
const PREVIEW_QUESTION = 'Jaki uklad listy?';
const PREVIEW_LABELS = [
  'Dwie kolumny obok siebie z podgladem (Rekomendowane)', 'Jedna kolumna', 'Bez listy',
];
const previewPending: PendingTool = {
  id: 'hook:preview',
  toolName: ASK_USER_QUESTION_TOOL,
  at: '',
  input: {
    questions: [{
      question: PREVIEW_QUESTION,
      header: 'Uklad listy',
      multiSelect: false,
      options: PREVIEW_LABELS.map((label) => ({ label, preview: '+--------+' })),
    }],
  },
};

describe('zgoda i potwierdzenie: zawinięta etykieta wraca w całości', () => {
  it('Bash: opcja „zawsze" niesie katalog, którego dotyczy', () => {
    expect(labelsOf(measured('zgoda-bash-2.1.293.txt'))).toEqual([
      'Yes',
      'Yes, and always allow access to /Users/u/Library/Caches from this project',
      'Yes, and switch to auto mode · auto mode handles these prompts for you',
      'No',
    ]);
  });

  it('Edit: kontynuacja z „(shift+tab)" W ŚRODKU linii jest etykietą, nie podpowiedzią', () => {
    expect(labelsOf(measured('zgoda-edit-2.1.293.txt'))).toEqual([
      'Yes',
      'Yes, and switch to accept edits (auto-approve file edits and common file commands) for this'
        + ' session (shift+tab)',
      'No',
    ]);
  });

  it('„Exit plan mode?": opcja 1 kończy się „for this session"', () => {
    expect(labelsOf(measured('exitplanmode-bez-planu-2.1.293.txt'))).toEqual([
      'Yes, and switch to default (ask each time) for this session', 'No',
    ]);
  });

  it('plan z treścią: podpowiedź „shift+tab to approve…" nie wchodzi do etykiety', () => {
    expect(labelsOf(measured('exitplanmode-2.1.293.txt'))).toEqual([
      'Yes, and use auto mode', 'Yes, manually approve edits', 'Tell Claude what to change',
    ]);
  });

  it('cyfry zostają z ekranu, a opis znika — był kawałkiem etykiety', () => {
    const dialog = parseOptions(measured('zgoda-bash-2.1.293.txt'));
    expect(dialog?.options.map((option) => option.digit)).toEqual(['1', '2', '3', '4']);
    expect(dialog?.options.every((option) => option.description === undefined)).toBe(true);
  });
});

describe('pytanie z podglądem: lewa kolumna to sama etykieta', () => {
  it('trzy linie lewej kolumny obok ramki podglądu sklejone w etykietę — bez payloadu', () => {
    expect(labelsOf(PREVIEW)).toEqual(PREVIEW_LABELS);
  });

  it('etykieta payloadu krótsza od tego, co widać, nie przechodzi dopasowania hooka', () => {
    // „(Rekomendowane)" stoi na ekranie, a w payloadzie go nie ma — to INNA opcja niż widoczna.
    const shorter: PendingTool = {
      ...previewPending,
      input: {
        questions: [{
          question: PREVIEW_QUESTION, header: 'Uklad listy', multiSelect: false,
          options: [
            { label: 'Dwie kolumny obok siebie z podgladem' }, { label: 'Jedna kolumna' },
            { label: 'Bez listy' },
          ],
        }],
      },
    };
    expect(hookQuestionFrom(shorter, PREVIEW)).toBeNull();
  });
});

describe('pytanie bez podglądu: etykieta odtwarzana WYŁĄCZNIE etykietami payloadu', () => {
  it('opisy opcji zostają opisami, gdy etykieta jest już pełna', () => {
    const dialog = parseOptions(measured('pytanie-jednokrotne-2.1.293.txt'), {
      labels: ['Wanilia', 'Czekolada', 'Truskawka'],
    });
    expect(dialog?.options.slice(0, 3).map((option) => [option.label, option.description])).toEqual([
      ['Wanilia', 'Wanilia'], ['Czekolada', 'Czekolada'], ['Truskawka', 'Truskawka'],
    ]);
  });

  /*
   * Wspólny początek etykiet: linia pod opcją bywa jej dalszym ciągiem
   * ALBO opisem. Wygrywa NAJDŁUŻSZE sklejenie równe etykiecie payloadu, a payload bez takiej
   * etykiety zostawia linię opisem.
   */
  const COMMON_PREFIX = [
    '───────────────────────────────────────────────────────────────',
    ' ☐ Srodowisko',
    '',
    'Gdzie wdrozyc?',
    '',
    '❯ 1. Staging',
    '     (tylko odczyt)',
    '  2. Produkcja',
    '  3. Type something.',
    '───────────────────────────────────────────────────────────────',
    '  4. Chat about this',
    '',
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
  ].join('\n');

  it('without a payload — the first line is the label, the next one the description', () => {
    expect(parseOptions(COMMON_PREFIX)?.options[0])
      .toMatchObject({ label: 'Staging', description: '(tylko odczyt)' });
  });

  it('wspólny początek: najdłuższe sklejenie równe etykiecie payloadu', () => {
    expect(labelsOf(COMMON_PREFIX, ['Staging (tylko odczyt)', 'Staging', 'Produkcja']).slice(0, 2))
      .toEqual(['Staging (tylko odczyt)', 'Produkcja']);
    const plain = parseOptions(COMMON_PREFIX, { labels: ['Staging', 'Produkcja'] });
    expect(plain?.options[0]).toMatchObject({ label: 'Staging', description: '(tylko odczyt)' });
  });

  /*
   * Pod sklejoną etykietą pojawia się NOWA linia („i zapis"). Bez
   * sprawdzenia opisu stara etykieta przechodziła, a nowa linia udawała opis — świeży odczyt
   * przed cyfrą przyjmował zmienioną opcję. Sklejenie wchodzi tylko, gdy reszta to opis z payloadu.
   */
  const WITH_EXTRA = COMMON_PREFIX.replace('     (tylko odczyt)', '     (tylko odczyt)\n     i zapis');

  it('sklejenie z niewyjaśnioną resztą nie przechodzi — reszta musi być opisem z payloadu', () => {
    expect(labelsOf(WITH_EXTRA, [{ label: 'Staging (tylko odczyt)' }, 'Produkcja'])[0])
      .not.toBe('Staging (tylko odczyt)');
    expect(labelsOf(WITH_EXTRA, [
      { label: 'Staging (tylko odczyt)', description: 'Opis innej treści' }, 'Produkcja',
    ])[0]).not.toBe('Staging (tylko odczyt)');
    // Reszta, która JEST opisem tej opcji — sklejenie przechodzi, a opis zostaje opisem.
    const dialog = parseOptions(WITH_EXTRA, {
      labels: [{ label: 'Staging (tylko odczyt)', description: 'i zapis' }, 'Produkcja'],
    });
    expect(dialog?.options[0]).toMatchObject({ label: 'Staging (tylko odczyt)', description: 'i zapis' });
  });

  it('ponowny odczyt karty: nowa linia pod sklejoną etykietą = ekran zmieniony', () => {
    const answered: ActiveReq = {
      reqId: 'q:staging',
      toolName: ASK_USER_QUESTION_TOOL,
      options: [
        { digit: '1', label: 'Staging (tylko odczyt)' }, { digit: '2', label: 'Produkcja' },
      ],
      question: 'Gdzie wdrozyc?',
      multiSelect: false,
    };
    const fresh = applyMultiSelectOverride(WITH_EXTRA, parseOptions(WITH_EXTRA, {
      labels: answered.options.map((option) => ({ label: option.label })),
    }), answered);
    expect(fresh?.options.some((option) => option.label === 'Staging (tylko odczyt)')).toBe(false);
  });

  it('bez pełnej równości zostaje pierwsza linia — prefiks niczego nie rozstrzyga', () => {
    expect(labelsOf(COMMON_PREFIX, ['Staging (tylko odczyt) i zapis', 'Produkcja']).slice(0, 2))
      .toEqual(['Staging', 'Produkcja']);
  });

  it('`hookQuestionFrom` dopasowuje formularz z podglądem i zawiniętą etykietą (odmowa 19:01)', () => {
    const hooked = hookQuestionFrom(previewPending, PREVIEW);
    expect(hooked).not.toBeNull();
    expect(hooked?.options.map((option) => [option.digit, option.label])).toEqual([
      ['1', PREVIEW_LABELS[0]], ['2', PREVIEW_LABELS[1]], ['3', PREVIEW_LABELS[2]],
    ]);
    expect(hooked?.card.options.map((option) => option.label)).toEqual(PREVIEW_LABELS);
  });

  it('ścieżka jsonl: `resolveOptions` z etykietami oddaje pełną etykietę pod cyfrą 1', () => {
    const resolution = resolveOptions(PREVIEW, {
      toolName: ASK_USER_QUESTION_TOOL, labels: PREVIEW_LABELS,
    });
    expect(resolution.status).toBe('ok');
    if (resolution.status !== 'ok') return;
    expect(resolution.options[0]).toMatchObject({ digit: '1', label: PREVIEW_LABELS[0] });
  });

  it('weryfikacja przed `enter`: podświetlona zawinięta opcja ma pełną etykietę', () => {
    const option = { digit: '1', label: PREVIEW_LABELS[0] ?? '' };
    expect(confirmFormSubmit(PREVIEW, { option, question: PREVIEW_QUESTION, labels: PREVIEW_LABELS }))
      .toEqual({ ok: true });
    // Sama pierwsza linia (np. z karty starszego serwera) nie jest tą opcją — fail-closed.
    expect(confirmFormSubmit(PREVIEW, {
      option: { digit: '1', label: 'Dwie kolumny obok siebie' }, question: PREVIEW_QUESTION,
    })).toEqual({ ok: false, reason: 'wrong-option' });
  });

  it('ponowny odczyt przed cyfrą bierze etykiety z karty', () => {
    const answered: ActiveReq = {
      reqId: 'q:preview',
      toolName: ASK_USER_QUESTION_TOOL,
      options: PREVIEW_LABELS.map((label, index) => ({ digit: String(index + 1), label })),
      question: PREVIEW_QUESTION,
      multiSelect: false,
    };
    const dialog = applyMultiSelectOverride(PREVIEW, parseOptions(PREVIEW), answered);
    expect(dialog?.options.map((option) => option.label)).toEqual(PREVIEW_LABELS);
  });
});
