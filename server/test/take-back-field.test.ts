/**
 * The prompt field around a queue take-back (`drivers/herdr/take-back-field.ts`) through the herdr driver: a draft or
 * a dialog before `up`, and the field record after it that clears, holds or lets go of the field, on the fake Claude
 * pane of `helpers/take-back-atrapy.ts`.
 */
import { describe, expect, it } from 'vitest';
import { appendFile } from 'node:fs/promises';
import { systemScheduler } from '../src/drivers/runtime.ts';
import { composerFieldView, squashWhitespace } from '../src/drivers/herdr/commands.ts';
import { TakeBackField, collapsedText, showsTaken } from '../src/drivers/herdr/take-back-field.ts';
import type { FieldRecord, TakenText } from '../src/drivers/herdr/take-back-field.ts';
import { createJsonlFollower } from '../src/herdr/jsonl-follow.ts';
import { TIMING, quiet, root, useDriverSandbox, userLine, waitFor } from './helpers/herdr-driver-atrapy.ts';
import {
  ACTIVE, BEFORE_UP, RULE, TWO, WAITING, keyAudit, keys, measured, queueLine, setup, takeBack,
} from './helpers/take-back-atrapy.ts';

useDriverSandbox();

/** A turn with B alone in the CLI queue. */
const ONE_QUEUED = userLine('start') + queueLine('enqueue', 'pomiar B: ok');

describe('queue take-back: the field and dialogs', () => {
  it('a draft at the Mac in the field: `draft`, no key', async () => {
    const { fx, pane } = await setup({ transcript: BEFORE_UP, queue: TWO });
    pane.field = ['szkic przy Macu'];
    pane.draw();
    expect(await takeBack(fx)).toEqual({ refused: 'draft' });
    expect(keys(fx)).toEqual([]);
  });

  it.each([
    ['a permission dialog', 'zabranie-dialog-przed-2.1.328.txt'],
    ['a question form', 'zabranie-formularz-przed-2.1.328.txt'],
  ])('%s on screen before `up` (measured, the registry says nothing): `dialog`, no key', async (_name, screen) => {
    const { fx, pane } = await setup({ transcript: BEFORE_UP, queue: TWO });
    pane.dialog = measured(screen);
    pane.draw();
    expect(await takeBack(fx)).toEqual({ refused: 'dialog' });
    expect(keys(fx)).toEqual([]);
  });

  it('the registry says a dialog waits: `dialog`, no key', async () => {
    const { fx, registry } = await setup({ transcript: BEFORE_UP, queue: TWO });
    registry.now = WAITING;
    expect(await takeBack(fx)).toEqual({ refused: 'dialog' });
    expect(keys(fx)).toEqual([]);
  });

  it('a dialog in the middle of the cleanup: no key while it stands, the cleanup resumes after it', async () => {
    const { fx, pane, registry } = await setup({ transcript: BEFORE_UP, queue: TWO });
    pane.afterKey = (key) => { if (key === 'ctrl+u') registry.now = WAITING; };
    const result = await takeBack(fx);
    expect(result).toEqual({ cli: [{ text: 'pomiar B: ok' }, { text: 'pomiar C: ok' }], rarog: [], fieldCleanup: 'pending' });
    expect(keys(fx)).toEqual(['up', 'ctrl+u']);
    await quiet();
    expect(keys(fx)).toEqual(['up', 'ctrl+u']);
    pane.afterKey = () => {};
    registry.now = ACTIVE;
    await waitFor(() => pane.field.length === 0, 'field emptied after the dialog');
    expect(keys(fx)).toEqual(['up', 'ctrl+u', 'ctrl+u']);
  });

  it('the field replaced at the Mac between `up` and the first read: no `ctrl+u`, B comes back, the field stays held',
    async () => {
      const { fx, pane } = await setup({ transcript: ONE_QUEUED, queue: ['pomiar B: ok'] });
      pane.afterKey = (key) => { if (key === 'up') pane.field = ['NOWY SZKIC MACA']; };
      expect(await takeBack(fx)).toEqual({ cli: [{ text: 'pomiar B: ok' }], rarog: [], fieldCleanup: 'pending' });
      await quiet();
      expect(keys(fx)).toEqual(['up']);
      expect(pane.field).toEqual(['NOWY SZKIC MACA']);
      expect(await takeBack(fx)).toEqual({ refused: 'busy' });
    });

  it('the first read after `up` catches the field half drawn: the step reads it again and clears the taken texts',
    async () => {
      const { fx, pane } = await setup({ transcript: BEFORE_UP, queue: TWO });
      let halfDrawn = false;
      pane.afterKey = (key) => {
        if (key !== 'up') return;
        pane.field = ['pomiar B: ok'];
        halfDrawn = true;
      };
      const read = fx.client.readScreen.bind(fx.client);
      fx.client.readScreen = async (paneId, source, format) => {
        const screen = await read(paneId, source, format);
        // The CLI finishes drawing the field right after the first field read that saw half of it.
        if (halfDrawn && source === 'visible' && format === 'ansi') {
          halfDrawn = false;
          pane.field = [...TWO];
          pane.draw();
        }
        return screen;
      };
      expect(await takeBack(fx)).toEqual({
        cli: [{ text: 'pomiar B: ok' }, { text: 'pomiar C: ok' }], rarog: [], fieldCleanup: 'done',
      });
      expect(keys(fx)).toEqual(['up', 'ctrl+u', 'ctrl+u']);
      expect(pane.field).toEqual([]);
    });

  it('a held field that later shows exactly the taken texts: the hold turns into clearing them', async () => {
    const { fx, pane } = await setup({ transcript: BEFORE_UP, queue: TWO });
    pane.afterKey = (key) => { if (key === 'up') pane.field = ['pomiar B: ok']; };
    expect(await takeBack(fx)).toEqual({
      cli: [{ text: 'pomiar B: ok' }, { text: 'pomiar C: ok' }], rarog: [], fieldCleanup: 'pending',
    });
    expect(keys(fx)).toEqual(['up']);
    // The rest of the field shows up only after the step stopped waiting for it.
    pane.field = [...TWO];
    pane.draw();
    await waitFor(() => pane.field.length === 0, 'field cleared once it showed the taken texts');
    expect(keys(fx)).toEqual(['up', 'ctrl+u', 'ctrl+u']);
  });

  it('a held field cut at the top that shows only a part of the taken texts: no `ctrl+u`, the field stays held',
    async () => {
      const { fx, pane, logs } = await setup({ transcript: BEFORE_UP, queue: TWO });
      pane.afterKey = (key) => { if (key === 'up') pane.field = ['pomiar B: ok']; };
      expect(await takeBack(fx)).toMatchObject({ fieldCleanup: 'pending' });
      // Only the bottom of a taller field is on screen: a part of the taken texts is no proof of the whole field, and
      // the lines above may still hold the rest of them.
      const cut = ['⏺ Running the measurement…', '', `─── ↑ 2 more ${'─'.repeat(20)}`, '  pomiar C: ok', RULE]
        .join('\n');
      expect(composerFieldView(cut)?.cutAtTop).toBe(true);
      let reads = 0;
      const read = fx.client.readScreen.bind(fx.client);
      fx.client.readScreen = (paneId, source, format) => {
        reads += 1;
        return read(paneId, source, format);
      };
      pane.override = cut;
      pane.draw();
      // A second read means the step that read the cut field has decided.
      await waitFor(() => reads >= 2 || logs.some((line) => line.includes('stops without a key')),
        'the hold read the cut field');
      expect(await takeBack(fx)).toEqual({ refused: 'busy' });
      expect(keys(fx)).toEqual(['up']);
    });

  it('`ctrl+u` that changes nothing: three presses, then the field stays held and a message from the app waits',
    async () => {
      const { fx, pane } = await setup({ transcript: ONE_QUEUED, queue: ['pomiar B: ok'] });
      pane.afterKey = (key) => { if (key === 'ctrl+u') pane.field = ['pomiar B: ok']; };
      expect(await takeBack(fx)).toEqual({ cli: [{ text: 'pomiar B: ok' }], rarog: [], fieldCleanup: 'pending' });
      expect(keys(fx)).toEqual(['up', 'ctrl+u', 'ctrl+u', 'ctrl+u']);
      fx.driver.send('C', undefined, undefined, { echo: 'e9' });
      await quiet();
      await quiet();
      expect(await takeBack(fx)).toEqual({ refused: 'busy' });
      expect(fx.client.calls.filter((call) => call.method === 'paste' || call.method === 'prompt')).toEqual([]);
      expect(keys(fx)).toEqual(['up', 'ctrl+u', 'ctrl+u', 'ctrl+u']);
      // The person at the Mac clears the field: the hold ends and the message goes into the empty field.
      pane.afterKey = () => {};
      pane.field = [];
      pane.draw();
      await waitFor(() => pane.submitted.length === 1, 'message after the hold');
      expect(pane.submitted).toEqual(['C']);
    });

  it('`ctrl+u` that takes a line but fails in the client: the rest of the taken text stays held', async () => {
    const { fx, pane } = await setup({ transcript: BEFORE_UP, queue: TWO });
    const press = fx.client.sendTakeBackKey;
    fx.client.sendTakeBackKey = async (paneId, key) => {
      await press(paneId, key);
      if (key === 'ctrl+u') throw new Error('herdr timeout');
    };
    const result = await takeBack(fx);
    expect(result).toEqual({
      cli: [{ text: 'pomiar B: ok' }, { text: 'pomiar C: ok' }], rarog: [], fieldCleanup: 'pending',
    });
    expect(keys(fx)).toEqual(['up', 'ctrl+u']);
    expect(pane.field).toEqual(['pomiar B: ok']);
    fx.driver.send('D', undefined, undefined, { echo: 'e9' });
    await quiet();
    await quiet();
    expect(await takeBack(fx)).toEqual({ refused: 'busy' });
    expect(fx.client.calls.filter((call) => call.method === 'paste' || call.method === 'prompt')).toEqual([]);
    expect(keys(fx)).toEqual(['up', 'ctrl+u']);
  });

  it('the driver disposed during the screen read right before `up`: no key reaches the pane', async () => {
    let beforeUp = false;
    const { fx } = await setup({
      transcript: BEFORE_UP, queue: TWO,
      deps: {
        follow: (o) => {
          const follower = createJsonlFollower({ ...o, root, watch: false, timing: TIMING });
          const pops = follower.cliQueuePops?.bind(follower);
          // Before `up` the take-back asks for its popAll mark, and its next screen read is the last one before `up`.
          if (pops !== undefined) follower.cliQueuePops = () => { beforeUp = true; return pops(); };
          return follower;
        },
      },
    });
    const read = fx.client.readScreen.bind(fx.client);
    fx.client.readScreen = (paneId, source, format) => {
      if (beforeUp) {
        beforeUp = false;
        fx.driver.dispose();
      }
      return read(paneId, source, format);
    };
    await takeBack(fx);
    expect(keys(fx)).toEqual([]);
    expect(keyAudit(fx)).toEqual([]);
  });

  it('the field changed at the Mac during the cleanup: the record ends without a key', async () => {
    const { fx, pane, logs } = await setup({ transcript: BEFORE_UP, queue: TWO });
    pane.afterKey = (key) => { if (key === 'ctrl+u') pane.field = ['coś zupełnie innego']; };
    const result = await takeBack(fx);
    expect(result).toMatchObject({ fieldCleanup: 'done' });
    expect(keys(fx)).toEqual(['up', 'ctrl+u']);
    expect(logs.some((line) => line.includes('stops without a key: the field changed at the desk'))).toBe(true);
    await quiet();
    expect(keys(fx)).toEqual(['up', 'ctrl+u']);
  });
});

describe('queue take-back: a paste the field shows as its placeholder', () => {
  const TWELVE = Array.from({ length: 12 }, (_, index) => `linia ${String(index + 1)}`).join('\n');
  const paste = (text: string): TakenText => ({ text, pasteLines: text.split('\n').length });
  const plain = (text: string): TakenText => ({ text, pasteLines: null });

  it.each([
    ['the placeholder of a 12-line paste, any number after `#`', [paste(TWELVE)], '[Pasted text #4 +11 lines]',
      false, false, true],
    ['the same placeholder wrapped over two lines', [paste(TWELVE)], '[Pasted text #1 +11\n  lines]', false, false, true],
    ['a placeholder of another line count', [paste(TWELVE)], '[Pasted text #1 +12 lines]', false, false, false],
    ['the paste in full', [paste(TWELVE)], TWELVE, false, false, true],
    ['the placeholder for a text that was no paste', [plain(TWELVE)], '[Pasted text #1 +11 lines]', false, false, false],
    ['a placeholder cut inside while clearing', [paste(TWELVE)], '[Pasted text #1 +11', false, true, false],
    ['a paste then B, the placeholder left after B went', [paste(TWELVE), plain('pomiar B: ok')],
      '[Pasted text #1 +11 lines]', false, true, true],
    ['the same field where the whole field must match', [paste(TWELVE), plain('pomiar B: ok')],
      '[Pasted text #1 +11 lines]', false, false, false],
    ['B then a paste, a part of B left', [plain('pomiar B: ok'), paste(TWELVE)], 'pomiar B', false, true, true],
    ['two pastes, both as placeholders', [paste(TWELVE), paste('a\nb')],
      '[Pasted text #1 +11 lines]\n[Pasted text #2 +1 lines]', false, false, true],
    ['two pastes, one as a placeholder and one in full', [paste(TWELVE), paste('a\nb')],
      '[Pasted text #1 +11 lines] a b', false, false, false],
    ['the end of a placeholder under a cut top', [paste(TWELVE), plain('pomiar B: ok')], 'lines]\npomiar B: ok',
      true, true, false],
  ])('%s', (_name, entries, field, cutAtTop, prefix, expected) => {
    const taken = {
      expected: squashWhitespace(entries.map(({ text }) => text).join('\n')), collapsed: collapsedText(entries),
    };
    expect(showsTaken(taken, squashWhitespace(field), cutAtTop, prefix)).toBe(expected);
  });

  const RAW = '<pasted_content id="094f">\nlinia pierwsza\nlinia druga\n</pasted_content id="094f">';
  const PLACEHOLDER = '[Pasted text #1 +1 lines]';

  it('`ctrl+u` that changes nothing on the placeholder: three presses, then the field stays held', async () => {
    const { fx, pane } = await setup({ transcript: userLine('start') + queueLine('enqueue', RAW), queue: [PLACEHOLDER] });
    pane.upWrites = () => appendFile(fx.transcript, queueLine('popAll', RAW));
    pane.afterKey = (key) => { if (key === 'ctrl+u') pane.field = [PLACEHOLDER]; };
    expect(await takeBack(fx)).toEqual({
      cli: [{ text: 'linia pierwsza\nlinia druga' }], rarog: [], fieldCleanup: 'pending',
    });
    expect(keys(fx)).toEqual(['up', 'ctrl+u', 'ctrl+u', 'ctrl+u']);
    await quiet();
    await quiet();
    expect(await takeBack(fx)).toEqual({ refused: 'busy' });
    expect(keys(fx)).toEqual(['up', 'ctrl+u', 'ctrl+u', 'ctrl+u']);
  });

  it('a field cut at the top that shows only the end of the placeholder while clearing: no more keys, held',
    async () => {
      const { fx, pane } = await setup({
        transcript: userLine('start') + queueLine('enqueue', RAW) + queueLine('enqueue', 'pomiar B: ok'),
        queue: [PLACEHOLDER, 'pomiar B: ok'],
      });
      pane.upWrites = () => appendFile(fx.transcript, queueLine('popAll', RAW) + queueLine('popAll', 'pomiar B: ok'));
      // The top line on screen is the second line of a wrapped placeholder: no proof, and no proof of a change either.
      const cut = ['⏺ Running the measurement…', '', `─── ↑ 1 more ${'─'.repeat(20)}`, '  lines]', RULE].join('\n');
      expect(composerFieldView(cut)?.cutAtTop).toBe(true);
      pane.afterKey = (key) => { if (key === 'ctrl+u') pane.override = cut; };
      expect(await takeBack(fx)).toEqual({
        cli: [{ text: 'linia pierwsza\nlinia druga' }, { text: 'pomiar B: ok' }], rarog: [], fieldCleanup: 'pending',
      });
      expect(keys(fx)).toEqual(['up', 'ctrl+u']);
      await quiet();
      await quiet();
      expect(await takeBack(fx)).toEqual({ refused: 'busy' });
      expect(keys(fx)).toEqual(['up', 'ctrl+u']);
    });
});

describe('take-back field record: a hold while the field did not show the taken texts yet', () => {
  const screenOf = (lines: readonly string[]): string => [
    '⏺ Running the measurement…', '', RULE, `❯ ${lines[0] ?? ''}`, ...lines.slice(1).map((line) => `  ${line}`), RULE,
  ].join('\n');
  const cutOf = (lines: readonly string[]): string => [
    '⏺ Running the measurement…', '', `─── ↑ 2 more ${'─'.repeat(20)}`, ...lines.map((line) => `  ${line}`), RULE,
  ].join('\n');

  /** B and C the file proves taken, held on the field the step last read: B alone. */
  const hold = (): FieldRecord => ({
    kind: 'hold', expected: 'pomiarB:ok', collapsed: null, prefix: false, history: false,
    own: { kind: 'clear', expected: 'pomiarB:okpomiarC:ok', collapsed: null, ceiling: 10, presses: 0, stalled: 0,
      last: null },
  });

  it.each([
    ['cut at the top, the bottom of the taken texts', 'wait', cutOf(['pomiar C: ok'])],
    ['cut at the top, text that is not taken', 'wait', cutOf(['szkic przy Macu'])],
    ['whole, the start of the taken texts', 'wait', screenOf(['pomiar B: ok', 'pomiar'])],
    ['whole, the field the hold began on', 'wait', screenOf(['pomiar B: ok'])],
    ['whole, text that is not taken', 'dead', screenOf(['szkic przy Macu'])],
    ['empty', 'done', screenOf([])],
  ])('a field read %s: `%s`, no key', async (_name, outcome, screen) => {
    expect(composerFieldView(screen)).not.toBeNull();
    const pressed: string[] = [];
    const field = new TakeBackField({
      deps: { promptRetryMs: 600_000, promptFieldPollMs: 1 }, scheduler: systemScheduler, key: 'w9:p72',
      gates: { promptObstacle: () => Promise.resolve(null), knownObstacle: () => null },
    }, {
      disposed: () => false,
      enqueue: (step) => step(),
      read: () => Promise.resolve({ text: screen, view: composerFieldView(screen) }),
      press: (key) => {
        pressed.push(key);
        return Promise.resolve(true);
      },
      log: () => {},
    });
    try {
      expect(await field.start(hold())).toBe(outcome);
      expect(pressed).toEqual([]);
    } finally {
      field.release();
    }
  });

  /** B and a two-line paste the file proves taken, held on B alone. */
  const pasteHold = (): FieldRecord => {
    const taken: TakenText[] = [{ text: 'pomiar B: ok', pasteLines: null }, { text: 'a\nb', pasteLines: 2 }];
    return {
      kind: 'hold', expected: 'pomiarB:ok', collapsed: null, prefix: false, history: false,
      own: { kind: 'clear', expected: 'pomiarB:okab', collapsed: collapsedText(taken), ceiling: 10, presses: 0,
        stalled: 0, last: null },
    };
  };

  it.each([
    ['ends inside the placeholder of the taken paste', 'wait', screenOf(['pomiar B: ok[Pasted text #1 +1'])],
    ['ends inside a bracket after text that is not taken', 'dead', screenOf(['szkic [Pasted text #1 +1'])],
  ])('a whole field half drawn that %s: `%s`, no key', async (_name, outcome, screen) => {
    expect(composerFieldView(screen)).not.toBeNull();
    const pressed: string[] = [];
    const field = new TakeBackField({
      deps: { promptRetryMs: 600_000, promptFieldPollMs: 1 }, scheduler: systemScheduler, key: 'w9:p72',
      gates: { promptObstacle: () => Promise.resolve(null), knownObstacle: () => null },
    }, {
      disposed: () => false,
      enqueue: (step) => step(),
      read: () => Promise.resolve({ text: screen, view: composerFieldView(screen) }),
      press: (key) => {
        pressed.push(key);
        return Promise.resolve(true);
      },
      log: () => {},
    });
    try {
      expect(await field.start(pasteHold())).toBe(outcome);
      expect(pressed).toEqual([]);
    } finally {
      field.release();
    }
  });
});

describe('take-back field record: a background step that throws', () => {
  it('the record goes on as a hold without keys, so it still ends once the field is empty', async () => {
    const screenOf = (field: string): string => ['⏺ Running the measurement…', '', RULE, `❯ ${field}`, RULE].join('\n');
    let screen = screenOf('pomiar B: ok');
    let throwing = false;
    let throws = 0;
    const pressed: string[] = [];
    let chain: Promise<unknown> = Promise.resolve();
    const field = new TakeBackField({
      deps: { promptRetryMs: 5, promptFieldPollMs: 1 }, scheduler: systemScheduler, key: 'w9:p72',
      gates: {
        promptObstacle: () => {
          if (!throwing) return Promise.resolve('registry');
          throws += 1;
          return Promise.reject(new Error('gate read failed'));
        },
        knownObstacle: () => null,
      },
    }, {
      disposed: () => false,
      // The driver's chain: a step that throws comes back as `undefined` and the chain goes on.
      enqueue: (step) => {
        const run = chain.then(step);
        chain = run.catch(() => undefined);
        return run.catch(() => undefined);
      },
      read: () => Promise.resolve({ text: screen, view: composerFieldView(screen) }),
      press: (key) => {
        pressed.push(key);
        return Promise.resolve(true);
      },
      log: () => {},
    });
    try {
      const record: FieldRecord = {
        kind: 'clear', expected: 'pomiarB:ok', collapsed: null, ceiling: 10, presses: 0, stalled: 0, last: null,
      };
      // A dialog stands at the first step: the record goes on in the background.
      expect(field.settleRecord(await field.start(record))).toBe('pending');
      throwing = true;
      await waitFor(() => throws > 0, 'a background step that throws');
      await quiet();
      expect(field.holdsField()).toBe(true);
      // The person at the Mac empties the field: only a record that still reads the field lets it go.
      screen = screenOf('');
      await waitFor(() => !field.holdsField(), 'the hold read the empty field');
      expect(pressed).toEqual([]);
    } finally {
      field.release();
    }
  });
});
