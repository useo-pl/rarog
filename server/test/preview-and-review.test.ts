/**
 * Podgląd opcji pytania i ekran przeglądu formularza jako POLA kontraktu.
 *
 * Preview: `AskUserQuestion` with a `preview` field draws a frame with code or a mockup next to the
 * option list in the terminal. The preview reaches the card ONLY from the payload (hook or jsonl),
 * never from the screen, which cuts it; in full from the driver, and to clients as a copy trimmed by
 * the manager (a ceiling per option and per frame, the `✂ …` marker).
 *
 * Review: the "Review your answers" screen of a multi-question form. The server computes the
 * "question → answers" pairs from raw screen lines (with indentation), because trimmed card text
 * lines lose wrapping, and sends them in the `Question.review` field.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Question } from '@rarog/shared';
import { decideCard } from '../src/herdr/dialogs/decide/decide.ts';
import { decideReqId } from '../src/herdr/dialogs/decide/sources.ts';
import type { DecideInput } from '../src/herdr/dialogs/decide/input.ts';
import { decisionCard } from '../src/herdr/dialogs/cards/build.ts';
import { hookPendingFrom } from '../src/herdr/dialogs/cross-check.ts';
import { parseAskUserQuestionInput } from '../src/drivers/tool-summary.ts';
import { ASK_USER_QUESTION_TOOL, resolveOptions } from '../src/herdr/dialogs/screen/resolve.ts';
import { reviewPairsFrom } from '../src/herdr/dialogs/screen/review.ts';
import type { PendingTool } from '../src/herdr/jsonl-pending.ts';
import type { PendingHookTool } from '../src/herdr/dialogs/hook/dump.ts';
import {
  PREVIEW_CLIP_MARKER, QUESTION_PREVIEW_MAX_CHARS, QUESTION_PREVIEWS_FRAME_MAX_CHARS,
  clipPreview, clipQuestionPreviews,
} from '../src/sessions/question-card.ts';

const DIR = join(import.meta.dirname, 'fixtures', 'herdr');
const fixture = (name: string): string => readFileSync(join(DIR, name), 'utf8');

/** Formularz z podglądem, CLI 2.1.293, panel 63 kolumny — etykieta 1 zawinięta na trzy linie. */
const PREVIEW_SCREEN = fixture('measured/pytanie-preview-2.1.293.txt');
const PREVIEW_QUESTION = 'Jaki uklad listy?';
const PODGLAD_1 = '+--------+---------+\n| lista  | podglad |\n+--------+---------+';
const PODGLAD_2 = '+--------+\n| lista  |\n+--------+';
const PREVIEW_INPUT = {
  questions: [{
    question: PREVIEW_QUESTION,
    header: 'Uklad listy',
    multiSelect: false,
    options: [
      { label: 'Dwie kolumny obok siebie z podgladem (Rekomendowane)', preview: PODGLAD_1 },
      { label: 'Jedna kolumna', preview: PODGLAD_2 },
      { label: 'Bez listy', preview: '(pusto)' },
    ],
  }],
};

function zrzut(over: Partial<PendingHookTool> = {}): PendingHookTool {
  return {
    toolName: ASK_USER_QUESTION_TOOL,
    hookEventName: 'PermissionRequest',
    answerKey: 'klucz-podglad',
    at: 21,
    toolInput: PREVIEW_INPUT,
    ...over,
  };
}

function input(over: Partial<DecideInput> = {}): DecideInput {
  const pending = over.pending ?? null;
  const hookPending = over.hookPending ?? null;
  return {
    pending,
    hookPending,
    text: null,
    reqId: decideReqId(hookPending ?? pending, 3),
    active: null,
    blockedSeq: 3,
    answeredSeq: -1,
    hookAnswersEnabled: true,
    deadAnswerKey: null,
    canRetry: false,
    answeredHookCall: null,
    decided: null,
    resolve: resolveOptions,
    excerpt: (text: string) => (text.trim() === '' ? null : text.trim()),
    hookRaw: null,
    ...over,
  };
}

function questionsOf(action: ReturnType<typeof decideCard>): Question[] {
  if (action.kind !== 'card' || action.card.event.type !== 'question-request') {
    throw new Error(`spodziewano karty pytania, jest ${action.kind}`);
  }
  return action.card.event.questions;
}

describe('podgląd z payloadu autora', () => {
  it('`parseAskUserQuestionInput` niesie `preview` DOSŁOWNIE; pusty i nie-tekst odpadają', () => {
    const parsed = parseAskUserQuestionInput({
      questions: [{
        question: 'Q?', header: 'H', multiSelect: false,
        options: [
          { label: 'A', preview: PODGLAD_1 }, { label: 'B', preview: '' }, { label: 'C', preview: 7 },
        ],
      }],
    });
    expect(parsed?.[0]?.options).toEqual([{ label: 'A', preview: PODGLAD_1 }, { label: 'B' }, { label: 'C' }]);
  });

  it('karta kanału hooka niesie podgląd każdej opcji w całości (kopię tnie dopiero manager)', () => {
    const hook = zrzut();
    const questions = questionsOf(decideCard(input({
      hookPending: hookPendingFrom(hook), text: PREVIEW_SCREEN, hookRaw: hook,
    })));
    expect(questions[0]?.options.map((option) => option.preview)).toEqual([PODGLAD_1, PODGLAD_2, '(pusto)']);
  });

  it('karta CYFROWA (kanał wyłączony) bierze podgląd z payloadu po etykiecie z ekranu', () => {
    const hook = zrzut();
    const questions = questionsOf(decideCard(input({
      hookPending: hookPendingFrom(hook), text: PREVIEW_SCREEN, hookRaw: hook, hookAnswersEnabled: false,
    })));
    const byLabel = new Map(questions[0]?.options.map((option) => [option.label, option.preview]));
    expect(byLabel.get('Dwie kolumny obok siebie z podgladem (Rekomendowane)')).toBe(PODGLAD_1);
    expect(byLabel.get('Jedna kolumna')).toBe(PODGLAD_2);
    // Na CLI 2.1.293 „Chat about this" stoi w tym wariancie BEZ cyfry pod kreską — opcji z ekranu jest tyle,
    // ile w payloadzie, i każda ma swój podgląd.
    expect(byLabel.size).toBe(3);
    expect([...byLabel.values()].every((preview) => preview !== undefined)).toBe(true);
  });

  it('karta z samego wpisu jsonl (bez dopasowania ekranu) też niesie podgląd', () => {
    const pending: PendingTool = {
      id: 'toolu_p', toolName: ASK_USER_QUESTION_TOOL, input: PREVIEW_INPUT, at: '',
    };
    const card = decisionCard('toolu_p', pending, 'question', [], null);
    if (card.event.type !== 'question-request') throw new Error('spodziewano pytania');
    expect(card.event.questions[0]?.options[1]).toMatchObject({ label: 'Jedna kolumna', preview: PODGLAD_2 });
  });

  it('podglądu NIE czytamy z ekranu: formularz bez payloadu nie dostaje pola', () => {
    const questions = questionsOf(decideCard(input({ text: PREVIEW_SCREEN })));
    expect(questions[0]?.options.every((option) => option.preview === undefined)).toBe(true);
  });
});

describe('kopia przycięta dla klientów', () => {
  it('podgląd w suficie jedzie bez zmian', () => {
    expect(clipPreview(PODGLAD_1, QUESTION_PREVIEW_MAX_CHARS)).toBe(PODGLAD_1);
  });

  it('dłuższy jest cięty na granicy linii, a ostatnia linia to znacznik', () => {
    const line = 'x'.repeat(39);
    const long = Array.from({ length: 200 }, () => line).join('\n');
    const clipped = clipPreview(long, 200);
    expect(clipped.length).toBeLessThanOrEqual(200);
    const lines = clipped.split('\n');
    expect(lines.at(-1)).toBe(PREVIEW_CLIP_MARKER);
    expect(lines.slice(0, -1).every((row) => row === line)).toBe(true);
  });

  it('jedna długa linia: cięcie twarde, ale nigdy w środku pary surogatów', () => {
    const emoji = '🍦'.repeat(100);
    const clipped = clipPreview(emoji, 60);
    const head = clipped.split('\n')[0] ?? '';
    expect(head.length % 2).toBe(0);
    expect(head).toBe('🍦'.repeat(head.length / 2));
    expect(clipped.endsWith(`\n${PREVIEW_CLIP_MARKER}`)).toBe(true);
  });

  it('sufit ramki: późniejsze podglądy dostają resztę budżetu, a po jego końcu sam znacznik', () => {
    const big = 'y'.repeat(QUESTION_PREVIEW_MAX_CHARS * 2);
    const questions: Question[] = [0, 1].map((qi) => ({
      question: `P${String(qi)}?`, header: '', multiSelect: false,
      options: [0, 1, 2].map((oi) => ({ label: `o${String(oi)}`, preview: big })),
    }));
    const clipped = clipQuestionPreviews(questions);
    const lengths = clipped.flatMap((question) => question.options.map((option) => option.preview?.length ?? 0));
    expect(lengths.slice(0, 3).every((length) => length <= QUESTION_PREVIEW_MAX_CHARS)).toBe(true);
    expect(lengths.reduce((sum, length) => sum + length, 0)).toBeLessThanOrEqual(
      QUESTION_PREVIEWS_FRAME_MAX_CHARS + PREVIEW_CLIP_MARKER.length * lengths.length,
    );
    expect(clipped[1]?.options.at(-1)?.preview).toBe(PREVIEW_CLIP_MARKER);
    // Wejście zostaje nietknięte — oryginał jest adresem odpowiedzi w driverze.
    expect(questions[0]?.options[0]?.preview).toBe(big);
  });

  it('opcja bez podglądu zostaje bez pola', () => {
    const clipped = clipQuestionPreviews([{
      question: 'Q?', header: '', multiSelect: false, options: [{ label: 'A' }],
    }]);
    expect(clipped[0]?.options[0]).toEqual({ label: 'A' });
  });
});

describe('pary ekranu przeglądu liczone z surowych linii', () => {
  it('formularz trzech pytań (pomiar 2.1.257)', () => {
    expect(reviewPairsFrom(fixture('dialog-askuserquestion-multiq-review.txt'))).toEqual([
      { question: 'Na którą wartość ujednolicić odstęp pod nagłówkiem sekcji?',
        answers: ['52 px — wartość `wide` (rekomendacja)'] },
      { question: 'Które dodatki włączyć?', answers: ['Posypka'] },
      { question: 'Jaki kolor przycisku?', answers: ['Niebieski (Rekomendacja)'] },
    ]);
  });

  it('formularz jednego pytania wielokrotnego wyboru', () => {
    expect(reviewPairsFrom(fixture('dialog-askuserquestion-multi-live-review.txt'))).toEqual([
      { question: 'Które dodatki?', answers: ['Posypka'] },
    ]);
  });

  it('zawinięte pytanie i zawinięta odpowiedź wracają w całości; kilka strzałek = kilka wartości', () => {
    const screen = [
      '←  ☒ Odstęp  ☒ Dodatki  ✔ Submit  →',
      '',
      'Review your answers',
      '',
      ' ● Na którą wartość ujednolicić odstęp pod',
      '   nagłówkiem sekcji?',
      '   → 52 px — wartość `wide`',
      '     (rekomendacja)',
      ' ● Które dodatki włączyć?',
      '   → Posypka',
      '   → Polewa',
      '',
      'Ready to submit your answers?',
      '',
      '❯ 1. Submit answers',
      '  2. Cancel',
    ].join('\n');
    expect(reviewPairsFrom(screen)).toEqual([
      { question: 'Na którą wartość ujednolicić odstęp pod nagłówkiem sekcji?',
        answers: ['52 px — wartość `wide` (rekomendacja)'] },
      { question: 'Które dodatki włączyć?', answers: ['Posypka', 'Polewa'] },
    ]);
  });

  it('nagłówek zacytowany w scrollbacku nie przykrywa listy prawdziwego dialogu pod nim', () => {
    const screen = [
      'Agent: pokażę „Review your answers" na końcu.',
      'Review your answers',
      ' ● Stare pytanie?',
      '   → Stara odpowiedź',
      '',
      '─────────────',
      'Review your answers',
      '',
      ' ● Nowe pytanie?',
      '   → Nowa odpowiedź',
      '',
      'Ready to submit your answers?',
    ].join('\n');
    expect(reviewPairsFrom(screen)).toEqual([{ question: 'Nowe pytanie?', answers: ['Nowa odpowiedź'] }]);
  });

  it('ekran, którego nie rozumiemy, daje `null`: bez nagłówka, odpowiedź bez pytania, pytanie bez odpowiedzi', () => {
    expect(reviewPairsFrom(' ● P?\n   → O')).toBeNull();
    expect(reviewPairsFrom('Review your answers\n   → O bez pytania')).toBeNull();
    expect(reviewPairsFrom('Review your answers\n ● P bez odpowiedzi?\n\nReady to submit your answers?'))
      .toBeNull();
    expect(reviewPairsFrom('Review your answers\n\nReady to submit your answers?')).toBeNull();
  });

  it('karta ekranu przeglądu niesie pary w `review`, a treść pytania zostaje dosłowna', () => {
    const questions = questionsOf(decideCard(input({
      text: fixture('dialog-askuserquestion-multiq-review.txt'),
    })));
    expect(questions).toHaveLength(1);
    expect(questions[0]?.review?.map((pair) => pair.question)).toEqual([
      'Na którą wartość ujednolicić odstęp pod nagłówkiem sekcji?', 'Które dodatki włączyć?',
      'Jaki kolor przycisku?',
    ]);
    expect(questions[0]?.question.startsWith('Review your answers')).toBe(true);
    expect(questions[0]?.options.map((option) => option.label)).toEqual(['Submit answers', 'Cancel']);
  });

  it('zwykłe pytanie i zwykłe potwierdzenie nie dostają pola `review`', () => {
    const questions = questionsOf(decideCard(input({ text: PREVIEW_SCREEN })));
    expect(questions[0]?.review).toBeUndefined();
  });
});
