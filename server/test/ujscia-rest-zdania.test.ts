/**
 * Ujścia REST przyjmują zdanie, nie napis (sekcja 4 „say(), ForeignText”).
 *
 * `errorBodyOf` jest JEDYNYM budowniczym ciała błędu z wyjątku i bierze `message` wyłącznie z pola `sentence`
 * (zdanie własne albo tekst obcy), nigdy z `err.message`. Klasy błędów, które trafiają do odpowiedzi REST, niosą
 * `sentence` i mają `Error.message` równe jego tekstowi, więc logi i drut się nie zmieniają. Funkcje, których wynik
 * router odsyła w 400/404/5xx (`validateProjectCwd`, `checkCwd`, `checkAnswerNotes`, mint Soniox), zwracają zdanie.
 */
import { describe, expect, it } from 'vitest';
import { CLIENT_ID_CONFLICT_ERROR, ULTRACODE_REFUSED_ERROR } from '@rarog/shared/rest';
import { type AnyText, foreign, isServerSentence, say, textOf } from '@rarog/shared/sentences';
import { validateProjectCwd } from '../src/config.ts';
import { UploadError } from '../src/herdr/uploads.ts';
import { NotesFailure } from '../src/notes/store.ts';
import { diffErrorStatus, errorBodyOf, managerErrorStatus } from '../src/router.ts';
import {
  BadRequestError, BadStateError, GoneError, NotFoundError, TooManyRequestsError, UltracodeRefusedError,
} from '../src/sessions/manager.ts';
import { checkAnswerNotes } from '../src/sessions/question-card.ts';
import { CLIENT_ID_CONFLICT_MESSAGE, ClientIdConflictError } from '../src/sessions/send-registry.ts';
import { createVoiceMinter } from '../src/voice/soniox.ts';

/** Wyjątek z kodem i zdaniem — kształt, który `managerErrorStatus` i `errorBodyOf` czytają. */
const withSentence = (code: string, sentence: AnyText): Error =>
  Object.assign(new Error(sentence.text), { code, sentence });

describe('errorBodyOf — jedyne źródło tekstu ciała błędu', () => {
  it('polityka `generic` daje zdanie ogólne statusu nawet przy zdaniu w wyjątku', () => {
    const err = withSentence('bad-request', say('commands.prefix-blocked', { prefix: '!' }));
    expect(errorBodyOf(400, err)).toEqual({ error: 'bad-request', message: 'Request rejected.', messageRef: { code: 'rest.bad-request' } });
    expect(errorBodyOf(404, err)).toEqual({ error: 'not-found', message: "That session doesn't exist.", messageRef: { code: 'rest.session-not-found' } });
    expect(errorBodyOf(409, err)).toEqual({
      error: 'bad-state', message: "The session is in a state that doesn't allow this action.",
      messageRef: { code: 'rest.bad-state' },
    });
    expect(errorBodyOf(410, err)).toEqual({ error: 'gone', message: 'This session is already closed.', messageRef: { code: 'rest.session-closed' } });
    expect(errorBodyOf(429, err)).toEqual({ error: 'too-many-requests', message: 'Too many requests. Try again in a moment.', messageRef: { code: 'rest.too-many-requests' } });
    expect(errorBodyOf(500, err)).toEqual({ error: 'internal', message: 'Server error.', messageRef: { code: 'rest.internal' } });
  });

  it('polityka `message`: zdanie wyjątku przy 400/409/429, ogólne przy 404 i 500', () => {
    const err = withSentence('bad-request', say('rest.cwd-outside-roots'));
    expect(errorBodyOf(400, err, 'message')).toEqual({
      error: 'bad-request', message: 'This directory is outside the allowed projects.',
      messageRef: { code: 'rest.cwd-outside-roots' },
    });
    expect(errorBodyOf(429, err, 'message').message).toBe('This directory is outside the allowed projects.');
    expect(errorBodyOf(404, err, 'message')).toEqual({ error: 'not-found', message: "That session doesn't exist.", messageRef: { code: 'rest.session-not-found' } });
    expect(errorBodyOf(500, err, 'message')).toEqual({ error: 'internal', message: 'Server error.', messageRef: { code: 'rest.internal' } });
  });

  it('`err.message` bez `sentence` NIE wychodzi do klienta w żadnej polityce', () => {
    const leak = Object.assign(new Error('ENOENT: /Users/u/tajny/katalog'), { code: 'bad-request' });
    for (const policy of ['generic', 'message', 'model', 'diff'] as const) {
      for (const status of [400, 404, 409, 410, 429, 500]) {
        expect(errorBodyOf(status, leak, policy).message, `${policy} ${String(status)}`).not.toContain('ENOENT');
      }
    }
  });

  it('pole `sentence` musi być tekstem z marką: zwykły obiekt `{text}` i napis nie przechodzą', () => {
    for (const sentence of ['goły napis', { text: 'podrobione zdanie' }]) {
      const err = Object.assign(new Error('x'), { code: 'bad-request', sentence });
      expect(errorBodyOf(400, err, 'message')).toEqual({ error: 'bad-request', message: 'Request rejected.', messageRef: { code: 'rest.bad-request' } });
    }
  });

  it('zdanie puste jest jak brak zdania (dawny warunek `message === ""`)', () => {
    expect(errorBodyOf(400, withSentence('bad-request', foreign('')), 'message').message).toBe('Request rejected.');
  });

  it('tekst obcy (`foreign`) w wyjątku jedzie dosłownie', () => {
    const err = Object.assign(new Error('x'), { code: 'bad-state', sentence: foreign('herdr: pane busy') });
    expect(errorBodyOf(409, err, 'message')).toEqual({ error: 'bad-state', message: 'herdr: pane busy' });
  });

  it('własne kody `client-id-conflict` (409) i `ultracode-refused` (400) zostają', () => {
    expect(errorBodyOf(409, new ClientIdConflictError(), 'message')).toEqual({
      error: CLIENT_ID_CONFLICT_ERROR, message: CLIENT_ID_CONFLICT_MESSAGE,
      messageRef: { code: 'session.client-id-conflict' },
    });
    const refused = new UltracodeRefusedError(
      say('model.ultracode-cli-too-old', { version: '2.1.200', minVersion: '2.1.300' }),
    );
    expect(errorBodyOf(400, refused, 'message')).toEqual({
      error: ULTRACODE_REFUSED_ERROR,
      message: "Claude Code 2.1.200 can't switch ultracode. Version 2.1.300 or later is required.",
      messageRef: { code: 'model.ultracode-cli-too-old', args: ['2.1.200', '2.1.300'] },
    });
  });

  it('polityka `model`: `busy` i `gone` ze zdaniem albo zdaniem zapasowym arkusza modelu', () => {
    const busy = new BadStateError(say('model.busy'));
    expect(errorBodyOf(409, busy, 'model')).toEqual({
      error: 'busy', message: 'The agent is working or waiting for a decision. Change the model when it finishes its turn.',
      messageRef: { code: 'model.busy' },
    });
    expect(errorBodyOf(409, new Error('x'), 'model')).toEqual({
      error: 'busy', message: 'The session is busy right now.', messageRef: { code: 'rest.session-busy' },
    });
    expect(errorBodyOf(410, new Error('x'), 'model')).toEqual({ error: 'gone', message: 'This session is already closed.', messageRef: { code: 'rest.session-closed' } });
    expect(errorBodyOf(400, new Error('x'), 'model')).toEqual({ error: 'bad-request', message: 'Request rejected.', messageRef: { code: 'rest.bad-request' } });
    expect(errorBodyOf(429, new TooManyRequestsError(say('session.send-throttled')), 'model')).toEqual({
      error: 'too-many-requests', message: 'Too fast. Give the pane a moment and send again.',
      messageRef: { code: 'session.send-throttled' },
    });
  });

  it('polityka `diff`: kod z tabeli z jej statusem, 404 jako `session-not-found`, reszta jak `message`', () => {
    const badPath = Object.assign(new Error('bad-path'), { code: 'bad-path' });
    expect(diffErrorStatus(badPath)).toBe(400);
    expect(errorBodyOf(400, badPath, 'diff')).toEqual({
      error: 'bad-path', message: 'Invalid file path.', messageRef: { code: 'rest.diff-bad-path' },
    });
    const gitFailed = Object.assign(new Error('git-failed'), { code: 'git-failed' });
    expect(diffErrorStatus(gitFailed)).toBe(503);
    const missing = new NotFoundError(say('rest.session-not-found'));
    expect(diffErrorStatus(missing)).toBe(404);
    expect(errorBodyOf(404, missing, 'diff')).toEqual({ error: 'session-not-found', message: "That session doesn't exist.", messageRef: { code: 'rest.session-not-found' } });
    const codex = new BadRequestError(say('session.codex-git'));
    expect(errorBodyOf(400, codex, 'diff')).toEqual({
      error: 'bad-request', message: 'Rarog only observes the Codex pane. Manage git in this project from the terminal or from herdr.',
      messageRef: { code: 'session.codex-git' },
    });
  });
});

describe('klasy błędów REST niosą `sentence`, a `message` to jego tekst', () => {
  it('klasy managera: konstruktor przyjmuje zdanie, `message` bez zmian', () => {
    const sentence = say('restart.busy');
    for (const [err, status] of [
      [new NotFoundError(sentence), 404], [new BadStateError(sentence), 409],
      [new BadRequestError(sentence), 400], [new UltracodeRefusedError(sentence), 400],
      [new TooManyRequestsError(sentence), 429], [new GoneError(sentence), 410],
    ] as const) {
      expect(err.sentence, err.name).toBe(sentence);
      expect(err.message, err.name).toBe(textOf(sentence));
      // Router tests throw copies of these classes, so only here a changed `code` would reach the wire status.
      expect(managerErrorStatus(err), err.name).toBe(status);
    }
  });

  it('goły napis w konstruktorze się nie kompiluje i rzuca w czasie wykonania', () => {
    // @ts-expect-error — klasy managera przyjmują wyłącznie zdanie własne (`say()`)
    expect(() => new BadRequestError('literał')).toThrow(TypeError);
    // @ts-expect-error — `NotesFailure` też
    expect(() => new NotesFailure('conflict', 'literał')).toThrow(TypeError);
  });

  it('`ClientIdConflictError` i `NotesFailure` niosą zdanie odpowiedzi', () => {
    const conflict = new ClientIdConflictError();
    expect(isServerSentence(conflict.sentence)).toBe(true);
    expect(conflict.message).toBe(CLIENT_ID_CONFLICT_MESSAGE);
    const notes = new NotesFailure('conflict', say('rest.notes-conflict'));
    expect(notes.message).toBe('The notes changed on another device.');
    expect(isServerSentence(notes.sentence)).toBe(true);
  });

  it('`UploadError` ze zdaniem trafia do ciała 400 tym samym tekstem (klasy herdr: `herdr-term-zdania.test.ts`)', () => {
    expect(errorBodyOf(400, new UploadError(say('uploads.bad-content', { name: 'zrzut.png' })), 'message').message)
      .toBe('The attachment “zrzut.png” has invalid content. Nothing was sent.');
  });
});

describe('funkcje, których wynik router odsyła, zwracają zdanie', () => {
  it('`validateProjectCwd` odmawia zdaniem', () => {
    const check = validateProjectCwd('', ['/tmp']);
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(isServerSentence(check.sentence)).toBe(true);
      expect(textOf(check.sentence)).toBe('Enter the path to a project directory.');
    }
  });

  it('`checkAnswerNotes` odmawia zdaniem', () => {
    const checked = checkAnswerNotes(undefined, [['a']], ['x', 'y']);
    expect('error' in checked && isServerSentence(checked.error)).toBe(true);
  });

  it('mint Soniox bez klucza odmawia zdaniem', async () => {
    const minter = createVoiceMinter({ apiKey: undefined, minIntervalMs: 0, hourlyCap: 1 });
    const result = await minter.mint();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(isServerSentence(result.sentence)).toBe(true);
  });
});
