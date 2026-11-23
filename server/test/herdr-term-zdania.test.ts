/**
 * Błędy i status herdr oraz terminal niosą ZDANIE, nie goły napis.
 *
 * Każda klasa błędu warstwy herdr (baza `HerdrError` i jej podklasy), `UploadError` i `TermBackendRetryError`
 * przyjmuje w konstruktorze zdanie własne (`say`) albo tekst obcy (`foreign`: treść herdr, `err.message`
 * z Node), trzyma go w `sentence`, a `Error.message` to jego tekst, więc logi i drut się nie zmieniają.
 * Ramka `err` terminala powstaje wyłącznie z `errFrame(zdanie)`. Linie z `@ts-expect-error` to sprawdzian
 * typu: gdyby konstruktor znów przyjął napis, `tsc` zgłosi nieużyte `@ts-expect-error`.
 */
import { describe, expect, it } from 'vitest';
import {
  type AnyText, foreign, isForeignText, isServerSentence, say, textOf,
} from '@rarog/shared/sentences';
import { HerdrArgvError } from '../src/herdr/argv.ts';
import { HerdrCommandRefusedError, HerdrPromptRejectedError } from '../src/herdr/commands/guard.ts';
import { HerdrKeyNotAllowedError } from '../src/herdr/dialogs/send/keys.ts';
import {
  HerdrMethodNotAllowedError, HerdrRemoteError, HerdrUnavailableError,
} from '../src/herdr/socket.ts';
import type { HerdrStreamEvent } from '../src/herdr/socket.ts';
import {
  HerdrBlockedError, HerdrError, HerdrGoneError, HerdrLaunchTimeoutError, HerdrNotOwnedError,
  HerdrOutOfScopeError, HerdrReadOnlyError, HerdrStalledError, HerdrUntrustedCwdError, sentenceOfError,
} from '../src/herdr/types.ts';
import type { HerdrLifecycleEvent } from '../src/herdr/types.ts';
import { UploadError } from '../src/herdr/uploads.ts';
import { errorBodyOf } from '../src/router.ts';
import { TermBackendRetryError, errFrame } from '../src/term/backend.ts';
import type { TermErrFrame } from '../src/term/backend.ts';

/** Każda klasa z jednym argumentem-zdaniem; `HerdrStalledError`, `HerdrRemoteError` i odmowa komendy osobno. */
const SINGLE: readonly (new (sentence: AnyText) => Error & { readonly sentence: AnyText })[] = [
  HerdrError, HerdrBlockedError, HerdrGoneError, HerdrReadOnlyError, HerdrOutOfScopeError, HerdrNotOwnedError,
  HerdrUntrustedCwdError, HerdrLaunchTimeoutError, HerdrMethodNotAllowedError, HerdrUnavailableError,
  HerdrArgvError, HerdrKeyNotAllowedError, HerdrPromptRejectedError, UploadError,
];

describe('klasy błędów herdr niosą zdanie', () => {
  it('każda klasa trzyma podane zdanie, a `message` to jego tekst (tekst własny i obcy)', () => {
    for (const Klasa of SINGLE) {
      const own = say('herdr.response-timeout', { method: Klasa.name });
      const err = new Klasa(own);
      expect(err.sentence, Klasa.name).toBe(own);
      expect(err.message, Klasa.name).toBe(`Timed out waiting for a herdr response (${Klasa.name}).`);
      const obcy = new Klasa(foreign('pane not found'));
      expect(isForeignText(obcy.sentence), Klasa.name).toBe(true);
      expect(obcy.message, Klasa.name).toBe('pane not found');
    }
  });

  it('klasy z dodatkowym argumentem też niosą zdanie', () => {
    const stalled = new HerdrStalledError(foreign('timed out waiting for agent status'), 'message');
    expect(isForeignText(stalled.sentence)).toBe(true);
    expect(stalled.stallSource).toBe('message');
    const remote = new HerdrRemoteError('agent_blocked', foreign('agent is blocked'));
    expect(remote.remoteCode).toBe('agent_blocked');
    expect(remote.message).toBe('agent is blocked');
    const refused = new HerdrCommandRefusedError(say('commands.refused-known.run-in-terminal', { token: '/quit' }), '/quit');
    expect(isServerSentence(refused.sentence)).toBe(true);
    expect(isServerSentence(refused.sentence) ? refused.sentence.ref : null)
      .toEqual({ code: 'commands.refused-known.run-in-terminal', args: ['/quit'] });
    expect(refused.command).toBe('/quit');
    const retry = new TermBackendRetryError(say('term.recovering'));
    expect(retry.message).toBe('The terminal is recovering. Try again in a moment.');
    expect(retry.sentence.ref).toEqual({ code: 'term.recovering' });
  });

  it('goły napis w konstruktorze nie kompiluje się', () => {
    // Sam sprawdzian typu: funkcji nikt nie woła (w czasie wykonania napis bez `.text` i tak by odpadł).
    const tylkoTyp = (): unknown[] => [
      // @ts-expect-error — treść herdr wchodzi wyłącznie przez `foreign`
      new HerdrRemoteError('agent_blocked', 'literał'),
      // @ts-expect-error — tekst wyłącznie przez `say` albo `foreign`
      new HerdrGoneError('literał'),
      // @ts-expect-error — jw.
      new UploadError('literał'),
      // @ts-expect-error — ramka `err` terminala bierze tekst własny, napis odpada
      new TermBackendRetryError('literał'),
    ];
    expect(tylkoTyp).toBeTypeOf('function');
  });

  it('`sentenceOfError`: zdanie klasy herdr bez zmian, reszta jako tekst obcy', () => {
    const own = say('herdr.client-closed');
    expect(sentenceOfError(new HerdrUnavailableError(own))).toBe(own);
    const node = sentenceOfError(new Error('connect ENOENT /tmp/herdr.sock'));
    expect(isForeignText(node)).toBe(true);
    expect(textOf(node)).toBe('connect ENOENT /tmp/herdr.sock');
    expect(textOf(sentenceOfError('coś'))).toBe('coś');
  });

  it('ciało 400 z odmowy wysyłki niesie tekst zdania i jego `messageRef`', () => {
    const err = new HerdrPromptRejectedError(say('commands.empty'));
    expect(errorBodyOf(400, err, 'message')).toEqual({
      error: 'bad-request', message: "The message is empty. There's nothing to send.", messageRef: { code: 'commands.empty' },
    });
  });
});

describe('zdarzenia statusu herdr niosą zdanie', () => {
  it('powód `unavailable` i `disconnected` to zdanie, nie napis', () => {
    const unavailable: HerdrLifecycleEvent = { type: 'unavailable', reason: say('herdr.stream-closed') };
    const disconnected: HerdrStreamEvent = { type: 'disconnected', reason: foreign('ECONNRESET') };
    expect(unavailable.type).toBe('unavailable');
    expect(disconnected.type).toBe('disconnected');
    // @ts-expect-error — goły napis jako powód niedostępności
    const zly: HerdrLifecycleEvent = { type: 'unavailable', reason: 'socket padł' };
    // @ts-expect-error — jw. w strumieniu gniazda
    const zly2: HerdrStreamEvent = { type: 'disconnected', reason: 'EOF' };
    expect([zly.type, zly2.type]).toEqual(['unavailable', 'disconnected']);
  });
});

describe('ramka `err` terminala', () => {
  it('`errFrame` składa ramkę ze zdania; na drut idą wyłącznie `t`, `msg` i `msgRef`', () => {
    const frame = errFrame(say('term.attach-failed'));
    expect(JSON.parse(JSON.stringify(frame))).toEqual({
      t: 'err', msg: "The terminal isn't starting. Open it again from the project list.", msgRef: { code: 'term.attach-failed' },
    });
  });

  it('ramki `err` nie da się złożyć z gołego napisu', () => {
    // @ts-expect-error — ramkę składa wyłącznie `errFrame`
    const reczna: TermErrFrame = { t: 'err', msg: 'Terminal został przejęty.' };
    // @ts-expect-error — `errFrame` nie bierze napisu
    const zNapisu = errFrame('Terminal został przejęty.');
    expect([reczna.t, zNapisu.t]).toEqual(['err', 'err']);
  });
});
