/**
 * Channel sentences: every sentence of this table except `state.limit-reached` is created at its source by `say()`,
 * and the text that goes to the app is the English registry template. The test checks the text and that the source
 * is a sentence with a code, not a bare literal.
 * Przypadki ścieżek HTTP (404, 500, 422, 401, 409 notatek, modele) stoją w `router.test.ts`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL_CHOICE, MODEL_CHANGE_WARNING, REFUSE_MESSAGES, REFUSE_REASONS, ULTRACODE_CHANGE_NOTE,
} from '@rarog/shared';
import { SENTENCES, isServerSentence } from '@rarog/shared/sentences';
import type { AnyText, SentenceCode } from '@rarog/shared/sentences';
import { errorBodyOf } from '../src/router.ts';
import {
  HERDR_PANE_CAP_MESSAGE, isFallbackLabel, nextFallbackLabel,
} from '../src/sessions/manager.ts';
import { HERDR_UNKNOWN_DETAIL } from '../src/sessions/state-sentences.ts';
import { launchDetail } from '../src/herdr/supervisor.ts';
import { DEGRADED_DISPLAY_TEXT, DEGRADED_UNREADABLE_TEXT } from '../src/herdr/dialogs/copy.ts';
import { degradedCard, screenQuestionCard } from '../src/herdr/dialogs/cards/build.ts';
import { REPOINT_MESSAGE, RESUME_REPOINT_MESSAGE } from '../src/herdr/jsonl-follow.ts';
import { MESSAGE_TRIMMED_MARK, clampMessageBlocks } from '../src/sessions/session.ts';
import { IMAGE_PLACEHOLDER } from '../src/transcript-import.ts';
import { clipForDisplay, truncationFooter } from '../src/drivers/tool-text.ts';
import { budgetSnapshotImages, SNAPSHOT_IMAGE_BUDGET_BYTES } from '../src/sse.ts';
import { NotesFailure, writeNotes } from '../src/notes/store.ts';

const en = (code: SentenceCode): string => {
  const def = SENTENCES[code].en;
  if (typeof def !== 'string') throw new Error(`${code}: szablon z liczbą mnogą`);
  return def;
};

/** Zdanie z kodem: marka `say()` i oczekiwany kod. */
function expectSentence(value: AnyText | undefined, code: SentenceCode): void {
  expect(isServerSentence(value), `${code}: źródło ma być zdaniem z say()`).toBe(true);
  if (value !== undefined && isServerSentence(value)) expect(value.ref.code).toBe(code);
}

describe('zdania u źródeł: REST', () => {
  it('404 bez zdania wyjątku → „That session doesn\'t exist.” z `messageRef` i nic poza tym', () => {
    expect(errorBodyOf(404, new Error('x'))).toEqual({ error: 'not-found', message: "That session doesn't exist.", messageRef: { code: 'rest.session-not-found' } });
  });

  it('500 z wyjątku Node → „Server error.”, nigdy `err.message`', () => {
    const body = errorBodyOf(500, new Error('ENOENT: open /var/rarog/sekret.json'), 'message');
    expect(body).toEqual({ error: 'internal', message: 'Server error.', messageRef: { code: 'rest.internal' } });
  });

  it('zdania ogólne pozostałych statusów są angielskie', () => {
    expect(errorBodyOf(400, null).message).toBe(en('rest.bad-request'));
    expect(errorBodyOf(409, null).message).toBe(en('rest.bad-state'));
    expect(errorBodyOf(410, null).message).toBe(en('rest.session-closed'));
    expect(errorBodyOf(429, null).message).toBe(en('rest.too-many-requests'));
    // Zapas 410 arkusza modelu to to samo zdanie co 410 ogólne.
    expect(errorBodyOf(410, null, 'model')).toEqual({ error: 'gone', message: en('rest.session-closed'), messageRef: { code: 'rest.session-closed' } });
    expect(errorBodyOf(404, null, 'diff').message).toBe(en('rest.session-not-found'));
  });

  it('odmowa 422: REFUSE_MESSAGES to angielskie zdania `dialogs.refuse.<powód>`', () => {
    expect(REFUSE_MESSAGES['multi-select']).toBe('Make multiple selections in the terminal. Rarog sends only one digit.');
    for (const reason of REFUSE_REASONS) expect(REFUSE_MESSAGES[reason]).toBe(en(`dialogs.refuse.${reason}`));
  });

  it('409 notatek: NotesFailure niesie zdanie `rest.notes-conflict`', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rarog-notatki-e1-'));
    cleanup.push(dir);
    writeNotes(dir, dir, 'a', 0);
    let failure: unknown;
    try {
      writeNotes(dir, dir, 'b', 0);
    } catch (err) {
      failure = err;
    }
    expect(failure).toBeInstanceOf(NotesFailure);
    expectSentence((failure as NotesFailure).sentence, 'rest.notes-conflict');
    expect((failure as NotesFailure).sentence.text).toBe('The notes changed on another device.');
  });
});

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('zdania u źródeł: modele', () => {
  it('pierwszy wybór listy modeli ma angielską etykietę i opis', () => {
    expect(DEFAULT_MODEL_CHOICE.label).toBe('Account Default Model');
    expect(DEFAULT_MODEL_CHOICE.description).toBe(en('model.default-description'));
  });

  it('ostrzeżenie zmiany modelu i notka ultracode to zdania rejestru', () => {
    expectSentence(MODEL_CHANGE_WARNING, 'model.change-warning');
    expectSentence(ULTRACODE_CHANGE_NOTE, 'model.ultracode-note');
    expect(MODEL_CHANGE_WARNING.text).toBe(en('model.change-warning'));
    expect(ULTRACODE_CHANGE_NOTE.text).toBe(en('model.ultracode-note'));
  });
});

describe('zdania u źródeł: sesja i herdr', () => {
  it('etykieta zapasowa: `session N`, numeracja ciągła po starej formie `sesja N`', () => {
    expect(nextFallbackLabel([])).toBe('session 1');
    expect(nextFallbackLabel(['session 1'])).toBe('session 2');
    expect(nextFallbackLabel(['sesja 3'])).toBe('session 4');
    expect(nextFallbackLabel(['sesja 3', 'session 5', 'mój prompt'])).toBe('session 6');
  });

  it('etykieta zapasowa: numer z promptu, którego następnik nie jest bezpieczną liczbą całkowitą, nie liczy się', () => {
    // Prompt „session 9007199254740991” zostaje etykietą; następna sesja bez promptu nie może przez niego paść.
    expect(nextFallbackLabel(['session 9007199254740991'])).toBe('session 1');
    expect(nextFallbackLabel(['session 2', 'sesja 99999999999999999999'])).toBe('session 3');
    expect(nextFallbackLabel(['session 9007199254740990'])).toBe('session 9007199254740991');
  });

  it('pierwszy prompt nadpisuje obie formy etykiety zapasowej', () => {
    expect(isFallbackLabel('sesja 2')).toBe(true);
    expect(isFallbackLabel('session 2')).toBe(true);
    expect(isFallbackLabel('session two')).toBe(false);
    expect(isFallbackLabel('moja session 2')).toBe(false);
  });

  it('stan herdr nieznany i limit paneli to zdania rejestru', () => {
    expectSentence(HERDR_UNKNOWN_DETAIL, 'state.herdr-unknown');
    expect(HERDR_UNKNOWN_DETAIL.text).toBe('pane state not known yet');
    expectSentence(HERDR_PANE_CAP_MESSAGE, 'herdr.pane-cap');
    expect(HERDR_PANE_CAP_MESSAGE.text).toBe('Rarog pane limit reached. Close a session and try again.');
    const detail = launchDetail({ otherwiseCanLaunch: true, paneCapReached: true });
    expectSentence(detail, 'herdr.pane-cap');
  });
});

describe('zdania u źródeł: karty dialogów', () => {
  it('karta zdegradowana i nieczytelna mają angielski `displayText`', () => {
    expectSentence(DEGRADED_DISPLAY_TEXT, 'dialogs.degraded-display');
    expectSentence(DEGRADED_UNREADABLE_TEXT, 'dialogs.degraded-unreadable');
    const shown = (reason: 'mismatch' | 'unreadable'): string | undefined => {
      const event = degradedCard('toolu_1', null, reason).event;
      return event.type === 'permission-request' ? event.displayText : undefined;
    };
    expect(shown('mismatch')).toBe(en('dialogs.degraded-display'));
    expect(shown('unreadable')).toBe(en('dialogs.degraded-unreadable'));
  });

  it('pytanie zapasowe karty z ekranu bez treści pytania', () => {
    const question = (kind: 'question' | 'confirm' | 'tool'): string | undefined => {
      const event = screenQuestionCard({
        kind, header: '', question: '',
        options: [{ digit: '1', label: 'Yes' }, { digit: '2', label: 'No' }],
        dialogIdentity: { kind: 'question', identity: { kind: 'form' } },
      }, 1).event;
      return event.type === 'question-request' ? event.questions[0]?.question : undefined;
    };
    expect(question('confirm')).toBe(en('dialogs.fallback-question.confirm'));
    expect(question('tool')).toBe(en('dialogs.fallback-question.tool'));
    expect(question('question')).toBe(en('dialogs.fallback-question.question'));
  });
});

describe('zdania u źródeł: transkrypt', () => {
  it('wiadomości systemowe `/clear` i `/resume`', () => {
    expectSentence(REPOINT_MESSAGE, 'transcript.repoint-clear');
    expectSentence(RESUME_REPOINT_MESSAGE, 'transcript.repoint-resume');
  });

  it('wiadomość ponad budżet dostaje osobny blok znacznika `[Rarog: message trimmed because …]`', () => {
    expectSentence(MESSAGE_TRIMMED_MARK, 'transcript.trimmed-mark');
    const blocks = clampMessageBlocks([{ type: 'text', text: 'x'.repeat(5000) }], 1000);
    const last = blocks.at(-1);
    expect(last).toEqual({ type: 'text', text: en('transcript.trimmed-mark'), ref: { code: 'transcript.trimmed-mark' } });
    expect(en('transcript.trimmed-mark')).toMatch(/^\[Rarog: message trimmed because /u);
  });

  it('stopka ucięcia: liczba pojedyncza i mnoga po angielsku', () => {
    expectSentence(truncationFooter(1), 'transcript.truncation-footer');
    expect(truncationFooter(1).text).toBe('\n… (1 character cut off)');
    expect(truncationFooter(5).text).toBe('\n… (5 characters cut off)');
    const clipped = clipForDisplay('abcdefgh', 3);
    expect(clipped.text).toBe('abc\n… (5 characters cut off)');
    expect(clipped.truncation).toEqual({ cut: 5, footer: [...'\n… (5 characters cut off)'].length });
  });

  it('obraz w imporcie → `[image]`; stary obraz w migawce → angielski `alt`', () => {
    expectSentence(IMAGE_PLACEHOLDER, 'transcript.image-placeholder');
    expect(IMAGE_PLACEHOLDER.text).toBe('[image]');
    const big = `data:image/png;base64,${'A'.repeat(SNAPSHOT_IMAGE_BUDGET_BYTES + 4)}`;
    const [message] = budgetSnapshotImages([{
      seq: 1, role: 'user', at: '2026-11-06T10:00:00Z', blocks: [{ type: 'image', dataUrl: big }],
    }]);
    const block = message?.blocks[0];
    expect(block?.type === 'image' ? block.alt : undefined).toBe(en('transcript.snapshot-image-alt'));
  });
});
