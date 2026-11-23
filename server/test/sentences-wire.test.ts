/**
 * Zdania z kodem na drucie: obok gotowego angielskiego tekstu jedzie `ref` zdania z `say()` (`messageRef`,
 * `labelRef`, `descriptionRef`, `warningRef`, `stateDetailRef`, `detailRef`, `ref` bloku, `displayTextRef`,
 * `questionRef`, `msgRef`), `foreign()` i tekst obcy wychodzą samym tekstem, a uszkodzony `ref` i złe `truncation`
 * odrzucają ramkę. Ścieżki managera (cztery ujścia stanu, etykieta, karty) stoją w `manager.test.ts`, pełne ramki
 * w producentach złotych plików.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL_CHOICE, blockSchema, decisionRefusedBodySchema, herdrStatusSchema, permissionRequestSchema,
  sessionSummarySchema, stateEventSchema, termServerFrameSchema,
} from '@rarog/shared';
import { errorBodySchema } from '@rarog/shared/rest';
import { say } from '@rarog/shared/sentences';
import { errorBodyOf } from '../src/router.ts';
import { HERDR_UNKNOWN_DETAIL, limitReachedDetail } from '../src/sessions/state-sentences.ts';
import {
  MESSAGE_TRIMMED_MARK, clampMessageBlocks, fallbackLabelRef, wireBlocks, wireStateDetail,
} from '../src/sessions/session.ts';
import { budgetSnapshotImages, SNAPSHOT_IMAGE_BUDGET_BYTES } from '../src/sse.ts';
import { errFrame } from '../src/term/backend.ts';
import { degradedCard, screenQuestionCard } from '../src/herdr/dialogs/cards/build.ts';
import { clipForDisplay } from '../src/drivers/tool-text.ts';
import { foreign } from '@rarog/shared/sentences';

describe('drut REST: `messageRef` ze zdania z `say()`', () => {
  it('404 sesji → `messageRef` `rest.session-not-found`', () => {
    expect(errorBodyOf(404, new Error('x'))).toEqual({
      error: 'not-found', message: "That session doesn't exist.", messageRef: { code: 'rest.session-not-found' },
    });
  });

  it('błąd ze zdaniem `foreign()` → samo `message`, bez `messageRef`', () => {
    const body = errorBodyOf(400, { sentence: foreign('Brak katalogu.') }, 'message');
    expect(body).toEqual({ error: 'bad-request', message: 'Brak katalogu.' });
  });

  it('polityka `model`: 409 ze zdania managera z `say()` → ciało z `messageRef` (mutacja 5)', () => {
    const body = errorBodyOf(409, { sentence: say('rest.bad-state') }, 'model');
    expect(body).toEqual({ error: 'busy', message: say('rest.bad-state').text, messageRef: { code: 'rest.bad-state' } });
  });

  it('pierwsza pozycja listy modeli niesie `labelRef` i `descriptionRef`', () => {
    expect(DEFAULT_MODEL_CHOICE.labelRef).toEqual({ code: 'model.default-label' });
    expect(DEFAULT_MODEL_CHOICE.descriptionRef).toEqual({ code: 'model.default-description' });
  });
});

describe('drut stanu: jeden helper dla podsumowania i zdarzenia `state`', () => {
  it('stan herdr nieznany → tekst i `stateDetailRef` `state.herdr-unknown`', () => {
    expect(wireStateDetail(HERDR_UNKNOWN_DETAIL)).toEqual({
      stateDetail: HERDR_UNKNOWN_DETAIL.text, stateDetailRef: { code: 'state.herdr-unknown' },
    });
  });

  it('limit → token `resetAt=<ISO>` i `ref` z chwilą; brak zdania → żadnego pola; tekst obcy → sam tekst', () => {
    const limit = limitReachedDetail('2026-11-12T10:00:00.000Z');
    expect(wireStateDetail(limit)).toEqual({
      stateDetail: 'resetAt=2026-11-12T10:00:00.000Z',
      stateDetailRef: { code: 'state.limit-reached', args: ['2026-11-12T10:00:00.000Z'] },
    });
    expect(limitReachedDetail('jutro')).toBeUndefined();
    expect(wireStateDetail(undefined)).toEqual({});
    expect(wireStateDetail(foreign('przerwana'))).toEqual({ stateDetail: 'przerwana' });
  });

  it('etykieta `session 2` → `labelRef` z numerem; etykieta z promptu i dawne `sesja 2` → bez', () => {
    expect(fallbackLabelRef('session 2')).toEqual({ code: 'session.fallback-label', args: ['2'] });
    expect(fallbackLabelRef('napraw logowanie')).toBeUndefined();
    expect(fallbackLabelRef('sesja 2')).toBeUndefined();
    expect(fallbackLabelRef('session 02')).toBeUndefined();
    expect(fallbackLabelRef(undefined)).toBeUndefined();
  });
});

describe('drut transkryptu: `ref` bloku, `truncation`, `placeholder`', () => {
  it('blok z `say()` niesie `ref`, tekst obcy nie', () => {
    const wire = wireBlocks([
      { type: 'text', text: say('transcript.repoint-clear') },
      { type: 'text', text: foreign('agent') },
    ]);
    expect(wire[0]).toEqual({ type: 'text', text: say('transcript.repoint-clear').text, ref: { code: 'transcript.repoint-clear' } });
    expect(wire[1]).toEqual({ type: 'text', text: 'agent' });
  });

  it('blok przycięty traci `ref`, osobny blok znacznika go niesie', () => {
    // Blok z `ref` dłuższy niż budżet (kształt z drutu): zostaje jego początek bez `ref`.
    const whole = { type: 'text' as const, text: 'x'.repeat(5000), ref: { code: 'transcript.repoint-clear' } };
    const [cut, mark] = clampMessageBlocks([whole], 1000);
    expect(cut?.type === 'text' && cut.text.length > 0 && whole.text.startsWith(cut.text)).toBe(true);
    expect(cut).not.toHaveProperty('ref');
    expect(mark).toEqual({ type: 'text', text: MESSAGE_TRIMMED_MARK.text, ref: { code: 'transcript.trimmed-mark' } });
  });

  it('`tool-call` ucięty → `truncation` obok `detail`; ucięcie bez `detail` nie wychodzi', () => {
    const clipped = clipForDisplay('x'.repeat(40), 10);
    const [withDetail, withoutDetail] = wireBlocks([
      { type: 'tool-call', toolName: 'Bash', summary: 's', detail: clipped.text, truncation: clipped.truncation },
      { type: 'tool-call', toolName: 'Bash', summary: 's', truncation: { cut: 1, footer: 1 } },
    ]);
    expect(withDetail).toMatchObject({ detail: clipped.text, truncation: { cut: 30, footer: clipped.truncation?.footer } });
    expect(blockSchema.parse(withDetail)).toEqual(withDetail);
    expect(withoutDetail).not.toHaveProperty('truncation');
  });

  it('ucięcie tekstu spoza BMP: liczba w stopce liczy jednostki UTF-16, `cut` skalary, `footer` = skalary stopki', () => {
    const text = '😀'.repeat(10);
    const clipped = clipForDisplay(text, 4);
    // Stopka mówi o 16 jednostkach UTF-16 (20 − 4), a wypadło 8 skalarów (10 − 2).
    expect(clipped.text).toBe(`😀😀\n… (16 characters cut off)`);
    expect(clipped.truncation).toEqual({ cut: 8, footer: [...'\n… (16 characters cut off)'].length });
  });

  it('stary obraz migawki → `placeholder: true` obok angielskiego `alt`', () => {
    const big = `data:image/png;base64,${'A'.repeat(SNAPSHOT_IMAGE_BUDGET_BYTES + 4)}`;
    const [message] = budgetSnapshotImages([{
      seq: 1, role: 'user', at: '2026-11-06T10:00:00Z', blocks: [{ type: 'image', dataUrl: big }],
    }]);
    expect(message?.blocks[0]).toMatchObject({ type: 'image', placeholder: true });
    expect(blockSchema.safeParse({ ...message?.blocks[0], placeholder: false }).success).toBe(false);
  });
});

describe('drut kart i terminala', () => {
  it('karta zdegradowana → `displayTextRef`; pytanie zapasowe → `questionRef`; pytanie z ekranu → bez', () => {
    const degraded = degradedCard('p1', null, 'unreadable').event;
    expect(degraded).toMatchObject({ displayTextRef: { code: 'dialogs.degraded-unreadable' } });
    const form = (question: string): Parameters<typeof screenQuestionCard>[0] => ({
      kind: 'confirm', header: 'h', question, options: [], dialogIdentity: { kind: 'none' },
    } as unknown as Parameters<typeof screenQuestionCard>[0]);
    const fallback = screenQuestionCard(form(''), 1).event;
    expect(fallback.type === 'question-request' ? fallback.questions[0]?.questionRef : null)
      .toEqual({ code: 'dialogs.fallback-question.confirm' });
    const own = screenQuestionCard(form('Kontynuować?'), 1).event;
    expect(own.type === 'question-request' ? own.questions[0] : null).not.toHaveProperty('questionRef');
  });

  it('terminal przejęty → `{t: err, msg, msgRef: {code: term.taken-over}}`; tekst obcy → bez `msgRef`', () => {
    const frame = errFrame(say('term.taken-over'));
    expect({ ...frame }).toEqual({ t: 'err', msg: say('term.taken-over').text, msgRef: { code: 'term.taken-over' } });
    expect(termServerFrameSchema.parse(frame)).toEqual({ ...frame });
    expect({ ...errFrame(foreign('x')) }).toEqual({ t: 'err', msg: 'x' });
  });
});

describe('uszkodzony `ref` i złe `truncation` odrzucają obiekt', () => {
  const summary = {
    id: 's', cwd: '/x', title: 'x', state: 'waiting-input', stateSince: 'a', createdAt: 'a', lastActivityAt: 'a',
    stateDetail: 'd',
  };
  const badRefs: readonly unknown[] = [
    null, { code: '' }, { code: 'a.b', args: ['1', '2', '3', '4', '5', '6', '7', '8', '9'] }, { code: 'a.b', args: [1] },
  ];

  it.each(badRefs.map((ref) => [JSON.stringify(ref), ref]))('ref %s', (_name, ref) => {
    expect(sessionSummarySchema.safeParse({ ...summary, stateDetailRef: ref }).success).toBe(false);
    expect(stateEventSchema.safeParse({ type: 'state', sessionId: 's', state: 'error', since: 'a', detailRef: ref }).success)
      .toBe(false);
    expect(herdrStatusSchema.safeParse({
      available: true, agentCount: 0, readOnly: false, canLaunch: false, detail: 'd', detailRef: ref,
    }).success).toBe(false);
    expect(errorBodySchema.safeParse({ error: 'x', message: 'm', messageRef: ref }).success).toBe(false);
    expect(decisionRefusedBodySchema.safeParse({
      error: 'refused', reason: 'multi-select', message: 'm', messageRef: ref,
    }).success).toBe(false);
    expect(blockSchema.safeParse({ type: 'text', text: 't', ref }).success).toBe(false);
  });

  it('dobry `ref` (8 argumentów) przechodzi', () => {
    const ref = { code: 'a.b', args: ['1', '2', '3', '4', '5', '6', '7', '8'] };
    expect(sessionSummarySchema.parse({ ...summary, stateDetailRef: ref })).toMatchObject({ stateDetailRef: ref });
  });

  it('`truncation`: `footer` dłuższy niż tekst, `cut` ujemne, ułamek, ucięcie bez `detail` → odrzucone', () => {
    const permission = {
      permId: 'p', sessionId: 's', toolName: 'Bash', displayText: 'ab😀', risk: 'red', cwd: '/x', createdAt: 'a',
    };
    expect(permissionRequestSchema.safeParse({ ...permission, truncation: { cut: 0, footer: 3 } }).success).toBe(true);
    expect(permissionRequestSchema.safeParse({ ...permission, truncation: { cut: 0, footer: 4 } }).success).toBe(false);
    expect(permissionRequestSchema.safeParse({ ...permission, truncation: { cut: -1, footer: 0 } }).success).toBe(false);
    expect(permissionRequestSchema.safeParse({ ...permission, truncation: { cut: 1.5, footer: 0 } }).success).toBe(false);
    const call = { type: 'tool-call', toolName: 'Bash', summary: 's' };
    expect(blockSchema.safeParse({ ...call, truncation: { cut: 1, footer: 0 } }).success).toBe(false);
    expect(blockSchema.safeParse({ ...call, detail: 'abc', truncation: { cut: 1, footer: 3 } }).success).toBe(true);
    expect(blockSchema.safeParse({ ...call, detail: 'abc', truncation: { cut: 1, footer: 4 } }).success).toBe(false);
  });
});
