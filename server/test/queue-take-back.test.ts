/**
 * The queue take-back through the herdr driver (`drivers/herdr/queue-take-back.ts`): the facade with the shared fakes
 * (`helpers/herdr-driver-atrapy.ts`), a real follower over the conversation file and the fake Claude pane of
 * `helpers/take-back-atrapy.ts`. The field before `up` and the field record after it: `take-back-field.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { appendFile, chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { HerdrDriverDeps } from '../src/drivers/herdr-driver.ts';
import type { QueueTakeBackResult } from '../src/drivers/types.ts';
import { STALLED_PROMPT_MESSAGE } from '../src/drivers/herdr/commands.ts';
import { createPromptQueueStore } from '../src/drivers/herdr/prompt-queue-store.ts';
import type { PromptQueueStore } from '../src/drivers/herdr/prompt-queue-store.ts';
import { registryCatalog } from '../src/herdr/commands/catalog.ts';
import { classifySlashText, slashOf } from '../src/herdr/commands/shape.ts';
import { createJsonlFollower } from '../src/herdr/jsonl-follow.ts';
import type { JsonlFollower } from '../src/herdr/jsonl-follow.ts';
import { CLI_QUEUE_POPS_KEPT } from '../src/herdr/jsonl-queue.ts';
import {
  TIMING, base, quiet, root, systemTexts, useDriverSandbox, userLine, waitFor,
} from './helpers/herdr-driver-atrapy.ts';
import type { Fixture } from './helpers/herdr-driver-atrapy.ts';
import {
  ACTIVE, BEFORE_UP, TWO, WAITING, dimmedHint, keyAudit, keys, measured, measuredBefore, queueLine, setup, takeBack,
} from './helpers/take-back-atrapy.ts';
import type { Setup } from './helpers/take-back-atrapy.ts';

useDriverSandbox();

describe('queue take-back: CLI queue', () => {
  it('two prompts, empty field: `up`, both popAll entries, `ctrl+u` to an empty field; [B, C] and `done`', async () => {
    const { fx, pane } = await setup({ transcript: BEFORE_UP, queue: TWO });
    pane.override = dimmedHint(measured('zabranie-przed-up-2.1.328.txt'));
    pane.draw();
    const result = await takeBack(fx);
    expect(result).toEqual({ cli: [{ text: 'pomiar B: ok' }, { text: 'pomiar C: ok' }], rarog: [], fieldCleanup: 'done' });
    expect(keys(fx)).toEqual(['up', 'ctrl+u', 'ctrl+u']);
    expect(keyAudit(fx)).toEqual([['up'], ['ctrl+u'], ['ctrl+u']]);
    expect(pane.field).toEqual([]);
    expect(fx.client.calls.filter((call) => call.method === 'prompt_submit' || call.method === 'send_keys'))
      .toEqual([]);
  });

  it('the CLI queue empty in the file and on screen: no key, nothing taken', async () => {
    const { fx } = await setup({ transcript: userLine('start') });
    expect(await takeBack(fx)).toEqual({ cli: [], rarog: [], fieldCleanup: 'done' });
    expect(keys(fx)).toEqual([]);
  });

  it.each([
    ['the file has a prompt, the screen no queue', [queueLine('enqueue', 'A')], []],
    ['the screen shows the queue, the file none', [], ['A']],
  ])('signals that disagree (%s): `unknown`, no key', async (_name, lines, queue) => {
    const { fx } = await setup({ transcript: userLine('start') + lines.join(''), queue });
    expect(await takeBack(fx)).toEqual({ refused: 'unknown' });
    expect(keys(fx)).toEqual([]);
  });

  it('an image in the CLI queue: `queue`, no key', async () => {
    const text = '[Image #1] co jest na zdjęciu?';
    const { fx } = await setup({ transcript: userLine('start') + queueLine('enqueue', text), queue: [text] });
    expect(await takeBack(fx)).toEqual({ refused: 'queue' });
    expect(keys(fx)).toEqual([]);
  });

  it('popAll entries in two reads: the result waits for the whole queue', async () => {
    const { fx, pane } = await setup({ transcript: BEFORE_UP, queue: TWO });
    pane.upWrites = async (taken) => {
      await appendFile(fx.transcript, queueLine('popAll', taken[0]));
      setTimeout(() => { void appendFile(fx.transcript, queueLine('popAll', taken[1])); }, 40);
    };
    const result = await takeBack(fx);
    expect(result).toMatchObject({ cli: [{ text: 'pomiar B: ok' }, { text: 'pomiar C: ok' }], fieldCleanup: 'done' });
  });

  it('a follower that would read the file only at its next tick: the forced read finds the popAll entries', async () => {
    const { fx } = await setup({
      transcript: BEFORE_UP, queue: TWO,
      deps: { follow: (o) => createJsonlFollower({ ...o, root, watch: false, timing: { ...TIMING, statTickMs: 600_000 } }) },
    });
    const result = await takeBack(fx);
    expect(result).toEqual({ cli: [{ text: 'pomiar B: ok' }, { text: 'pomiar C: ok' }], rarog: [], fieldCleanup: 'done' });
  });

  it.each([
    ['its text without the wrapper: cleared', ['linia pierwsza', 'linia druga'], 'done', ['up', 'ctrl+u', 'ctrl+u']],
    ['the placeholder of its line count: cleared', ['[Pasted text #3 +1 lines]'], 'done', ['up', 'ctrl+u']],
    ['a placeholder of another line count: held without keys', ['[Pasted text #1 +5 lines]'], 'pending', ['up']],
  ])('a paste wrapper in the queue entry, the field after `up` shows %s; the text goes back without the wrapper',
    async (_name, field, cleanup, pressed) => {
      const raw = '<pasted_content id="094f">\nlinia pierwsza\nlinia druga\n</pasted_content id="094f">';
      const { fx, pane } = await setup({
        transcript: userLine('start') + queueLine('enqueue', raw), queue: ['[Pasted text #1 +1 lines]'],
      });
      pane.upWrites = () => appendFile(fx.transcript, queueLine('popAll', raw));
      pane.afterKey = (key) => { if (key === 'up') pane.field = [...field]; };
      const result = await takeBack(fx);
      expect(result).toEqual({ cli: [{ text: 'linia pierwsza\nlinia druga' }], rarog: [], fieldCleanup: cleanup });
      expect(keys(fx)).toEqual(pressed);
    });

  it.each([
    ['26 columns, wrapped after `+11`', 'zabranie-wklejka'],
    ['121 columns', 'zabranie-wklejka-szeroki'],
  ])('a 12-line paste in the CLI queue, its placeholder in the field after `up` (measured, %s): one `ctrl+u`, '
    + 'the text goes back without the wrapper', async (_name, name) => {
    const file = `${name}-2.1.328.jsonl`;
    const beforeUp = measuredBefore(file, 'up');
    const popAll = measuredBefore(file, 'ctrl-u-do-pustego-pola').slice(beforeUp.length);
    const raw = (JSON.parse(popAll[0] ?? '{}') as { content?: string }).content ?? '';
    const { fx, pane } = await setup({ transcript: beforeUp.join(''), queue: ['[Pasted text #1 +11 lines]'] });
    pane.override = dimmedHint(measured(`${name}-przed-up-2.1.328.txt`));
    pane.draw();
    pane.upWrites = () => appendFile(fx.transcript, popAll.join(''));
    pane.afterKey = (key) => {
      if (key === 'up') pane.override = measured(`${name}-po-up-2.1.328.txt`);
      if (key === 'ctrl+u') pane.override = measured(`${name}-po-ctrl-u-1-2.1.328.txt`);
    };
    const result = await takeBack(fx);
    // The text between the wrapper's two tag lines, as the person pasted it.
    const text = raw.split('\n').slice(1, -1).join('\n');
    expect(text.split('\n')).toHaveLength(12);
    expect(result).toEqual({ cli: [{ text }], rarog: [], fieldCleanup: 'done' });
    expect(keys(fx)).toEqual(['up', 'ctrl+u']);
  });

  it('two equal messages from the app in the CLI queue: two entries, each with its own echo token', async () => {
    const { fx, pane } = await setup({ transcript: userLine('start') });
    fx.driver.send('ok', undefined, undefined, { echo: 'e1' });
    await waitFor(() => pane.submitted.length === 1, 'first Enter');
    fx.driver.send('ok', undefined, undefined, { echo: 'e2' });
    await waitFor(() => pane.submitted.length === 2, 'second Enter');
    await quiet();
    const result = await takeBack(fx);
    expect(result).toEqual({
      cli: [{ text: 'ok', echo: 'e1' }, { text: 'ok', echo: 'e2' }], rarog: [], fieldCleanup: 'done',
    });
  });
});

describe('queue take-back: `up` without popAll (the CLI was faster)', () => {
  /** The measured race at a turn end: the CLI delivered B (`dequeue`, its prompt entry), `up` opened history. */
  const RACE = measuredBefore('zabranie-wyscig-koniec-2.1.328.jsonl', 'up-po-odpowiedzi');
  /** The prompt and its `enqueue`: B waits in the CLI queue. */
  const RACE_QUEUED = RACE.slice(0, 2).join('');
  /** The CLI delivers B by itself: the answer, `dequeue`, the turn end and B's prompt entry. */
  const RACE_DELIVERED = RACE.slice(2).join('');

  it('a history entry after `up`: `down` brings the empty field back, nothing from the CLI', async () => {
    const { fx, pane } = await setup({ transcript: RACE_QUEUED, queue: ['pomiar B: ok'] });
    pane.upWrites = () => Promise.resolve();
    pane.afterKey = (key) => {
      if (key !== 'up') return;
      // The CLI took B itself in the same instant: the queue is empty and `up` shows B as history (measured screen).
      pane.field = [];
      pane.history = 'pomiar B: ok';
      pane.override = measured('zabranie-wyscig-koniec-po-up-2.1.328.txt');
      void appendFile(fx.transcript, RACE_DELIVERED);
    };
    const result = await takeBack(fx);
    expect(result).toEqual({ cli: [], rarog: [], fieldCleanup: 'done', cliLeft: true });
    expect(keys(fx)).toEqual(['up', 'down']);
    expect(pane.history).toBeNull();
  });

  it('a dialog before `down`: no key while it stands, `down` after it', async () => {
    const { fx, pane, registry } = await setup({ transcript: RACE_QUEUED, queue: ['pomiar B: ok'] });
    pane.upWrites = () => Promise.resolve();
    pane.afterKey = (key) => {
      if (key !== 'up') return;
      pane.field = [];
      pane.history = 'pomiar B: ok';
      registry.now = WAITING;
    };
    expect(await takeBack(fx)).toEqual({ cli: [], rarog: [], fieldCleanup: 'pending', cliLeft: true });
    await quiet();
    expect(keys(fx)).toEqual(['up']);
    registry.now = ACTIVE;
    await waitFor(() => pane.history === null, 'down after the dialog');
    expect(keys(fx)).toEqual(['up', 'down']);
  });

  it('a history entry that `down` does not leave: two presses, then the entry stays held', async () => {
    const { fx, pane } = await setup({ transcript: RACE_QUEUED, queue: ['pomiar B: ok'] });
    pane.upWrites = () => Promise.resolve();
    pane.afterKey = (key) => {
      if (key === 'up') pane.field = [];
      if (key === 'up' || key === 'down') pane.history = 'pomiar B: ok';
    };
    expect(await takeBack(fx)).toEqual({ cli: [], rarog: [], fieldCleanup: 'pending', cliLeft: true });
    await quiet();
    expect(keys(fx)).toEqual(['up', 'down', 'down']);
    expect(await takeBack(fx)).toEqual({ refused: 'busy' });
  });

  it('no history entry and an empty field after `up`: no other key', async () => {
    const { fx, pane } = await setup({ transcript: BEFORE_UP, queue: TWO });
    pane.upWrites = () => Promise.resolve();
    pane.afterKey = (key) => { if (key === 'up') pane.field = []; };
    expect(await takeBack(fx)).toEqual({ cli: [], rarog: [], fieldCleanup: 'done', cliLeft: true });
    expect(keys(fx)).toEqual(['up']);
  });

  it.each([
    ['the screen cannot be read after it', 0],
    ['an empty field read after it, then the screen cannot be read', 1],
  ])('`up` sent, no popAll and %s: no other key, the field stays held', async (_name, goodReads) => {
    const { fx, pane } = await setup({ transcript: BEFORE_UP, queue: TWO });
    pane.upWrites = () => Promise.resolve();
    let afterUp = false;
    let reads = 0;
    pane.afterKey = (key) => {
      if (key !== 'up') return;
      pane.field = [];
      afterUp = true;
    };
    const read = fx.client.readScreen.bind(fx.client);
    fx.client.readScreen = (paneId, source, format) => {
      if (afterUp && (reads += 1) > goodReads) return Promise.reject(new Error('herdr timeout'));
      return read(paneId, source, format);
    };
    expect(await takeBack(fx)).toEqual({ cli: [], rarog: [], fieldCleanup: 'pending', cliLeft: true });
    await quiet();
    expect(keys(fx)).toEqual(['up']);
    expect(await takeBack(fx)).toEqual({ refused: 'busy' });
  });

  it('text in the field without popAll: no other key, a message from the app waits until the field is empty',
    async () => {
      const { fx, pane } = await setup({ transcript: BEFORE_UP, queue: TWO });
      pane.upWrites = () => Promise.resolve();
      expect(await takeBack(fx)).toEqual({ cli: [], rarog: [], fieldCleanup: 'pending', cliLeft: true });
      expect(await takeBack(fx)).toEqual({ refused: 'busy' });
      // A slash command typed after the taken text would send it too: refused, nothing goes to the pane.
      const catalog = registryCatalog();
      fx.driver.send('/compact', undefined, undefined, {
        command: { catalog, slash: slashOf(classifySlashText('/compact', catalog)) },
      });
      await waitFor(() => systemTexts(fx.events).includes(STALLED_PROMPT_MESSAGE.text), 'slash refusal');
      fx.driver.send('nowa wiadomość', undefined, undefined, { echo: 'e9' });
      await quiet();
      await quiet();
      expect(fx.client.calls.filter((call) => call.method === 'paste' || call.method === 'prompt')).toEqual([]);
      expect(keys(fx)).toEqual(['up']);
      // The person at the Mac clears the field: the hold ends and the message goes into the empty field.
      pane.field = [];
      pane.draw();
      await waitFor(() => pane.submitted.length === 1, 'message after the hold');
      expect(pane.submitted).toEqual(['nowa wiadomość']);
    });
});

describe('queue take-back: a failed `up` or a step that throws after it', () => {
  /** The client call of `up` fails after the key took effect in the pane. */
  function failUpAfterDelivery(fx: Fixture): void {
    const press = fx.client.sendTakeBackKey;
    fx.client.sendTakeBackKey = async (paneId, key) => {
      await press(paneId, key);
      if (key === 'up') throw new Error('herdr timeout');
    };
  }

  it('`up` reached the pane and the file proves both prompts: [B, C] come back and the field is cleared', async () => {
    const { fx, pane } = await setup({ transcript: BEFORE_UP, queue: TWO });
    failUpAfterDelivery(fx);
    expect(await takeBack(fx)).toEqual({
      cli: [{ text: 'pomiar B: ok' }, { text: 'pomiar C: ok' }], rarog: [], fieldCleanup: 'done',
    });
    expect(keys(fx)).toEqual(['up', 'ctrl+u', 'ctrl+u']);
    expect(pane.field).toEqual([]);
  });

  it.each([
    ['the prompts stand in the field', (_ctx: Setup): void => {}],
    ['a history entry stands', ({ pane }: Setup): void => {
      pane.afterKey = (key) => {
        if (key !== 'up') return;
        pane.field = [];
        pane.history = 'pomiar B: ok';
      };
    }],
    ['the screen cannot be read', ({ fx, pane }: Setup): void => {
      pane.afterKey = (key) => {
        if (key === 'up') fx.client.readScreen = () => Promise.reject(new Error('herdr timeout'));
      };
    }],
  ])('`up` reached the pane without popAll and %s: no other key, the field stays held', async (_name, arrange) => {
    const ctx = await setup({ transcript: BEFORE_UP, queue: TWO });
    ctx.pane.upWrites = () => Promise.resolve();
    arrange(ctx);
    failUpAfterDelivery(ctx.fx);
    expect(await takeBack(ctx.fx)).toEqual({ cli: [], rarog: [], fieldCleanup: 'pending', cliLeft: true });
    await quiet();
    expect(keys(ctx.fx)).toEqual(['up']);
    expect(await takeBack(ctx.fx)).toEqual({ refused: 'busy' });
  });

  it('`up` that did not reach the pane: the field stays empty, nothing taken, no hold', async () => {
    const { fx, pane } = await setup({ transcript: BEFORE_UP, queue: TWO });
    fx.client.sendTakeBackKey = (paneId, key) => {
      fx.client.calls.push({ method: 'take_back_key', paneId, keys: [key] });
      return Promise.reject(new Error('herdr refused'));
    };
    expect(await takeBack(fx)).toEqual({ cli: [], rarog: [], fieldCleanup: 'done', cliLeft: true });
    expect(keys(fx)).toEqual(['up']);
    expect(pane.queue).toEqual(TWO);
  });

  it('the driver disposed while `up` goes out, after the follower noted both popAll entries: [B, C] come back, '
    + 'no other key', async () => {
    let follower: JsonlFollower | undefined;
    const { fx, pane } = await setup({
      transcript: BEFORE_UP, queue: TWO,
      deps: {
        follow: (o) => {
          follower = createJsonlFollower({ ...o, root, watch: false, timing: TIMING });
          return follower;
        },
      },
    });
    let noted: readonly string[] = [];
    pane.upWrites = async (taken) => {
      await appendFile(fx.transcript, taken.map((text) => queueLine('popAll', text)).join(''));
      await follower?.readNow?.();
      noted = follower?.cliQueuePops?.().recent ?? [];
      // The send of `up` has not resolved yet.
      fx.driver.dispose();
    };
    const result = await takeBack(fx);
    expect(noted).toEqual(TWO);
    expect(result).toEqual({ cli: [{ text: 'pomiar B: ok' }, { text: 'pomiar C: ok' }], rarog: [], fieldCleanup: 'done' });
    expect(keys(fx)).toEqual(['up']);
  });

  it('the driver disposed during the forced file read after `up`: no screen read after it, [B, C] come back',
    async () => {
      let follower: JsonlFollower | undefined;
      let afterUp = false;
      let disposedAt = -1;
      const { fx, pane } = await setup({
        transcript: BEFORE_UP, queue: TWO,
        deps: {
          follow: (o) => {
            follower = createJsonlFollower({ ...o, root, watch: false, timing: TIMING });
            const readNow = follower.readNow?.bind(follower);
            follower.readNow = async () => {
              await readNow?.();
              if (afterUp && disposedAt < 0) {
                disposedAt = fx.client.calls.length;
                fx.driver.dispose();
              }
            };
            return follower;
          },
        },
      });
      pane.afterKey = (key) => { if (key === 'up') afterUp = true; };
      const result = await takeBack(fx);
      expect(disposedAt).toBeGreaterThan(0);
      expect(fx.client.calls.slice(disposedAt).filter((call) => call.method === 'read')).toEqual([]);
      expect(result).toEqual({ cli: [{ text: 'pomiar B: ok' }, { text: 'pomiar C: ok' }], rarog: [], fieldCleanup: 'done' });
    });

  it('the driver disposed during the field read after B, with the popAll entry of C noted by then: [B, C] come back',
    async () => {
      let follower: JsonlFollower | undefined;
      const { fx, pane } = await setup({
        transcript: BEFORE_UP, queue: TWO,
        deps: {
          follow: (o) => {
            follower = createJsonlFollower({ ...o, root, watch: false, timing: TIMING });
            return follower;
          },
        },
      });
      let afterUp = false;
      pane.upWrites = (taken) => appendFile(fx.transcript, queueLine('popAll', taken[0]));
      pane.afterKey = (key) => { if (key === 'up') afterUp = true; };
      const read = fx.client.readScreen.bind(fx.client);
      fx.client.readScreen = async (paneId, source, format) => {
        if (afterUp && source === 'visible' && format === 'ansi') {
          afterUp = false;
          // The first field read after `up`: the popAll entry of C lands in the file, the follower notes it, and the
          // driver goes.
          await appendFile(fx.transcript, queueLine('popAll', 'pomiar C: ok'));
          await follower?.readNow?.();
          fx.driver.dispose();
        }
        return read(paneId, source, format);
      };
      expect(await takeBack(fx)).toEqual({
        cli: [{ text: 'pomiar B: ok' }, { text: 'pomiar C: ok' }], rarog: [], fieldCleanup: 'done',
      });
      expect(keys(fx)).toEqual(['up']);
    });

  it('the forced read of the file throws between two popAll entries: B comes back and the field stays held',
    async () => {
      let afterUp = false;
      let reads = 0;
      const { fx, pane } = await setup({
        transcript: BEFORE_UP, queue: TWO,
        deps: {
          follow: (o) => {
            const follower = createJsonlFollower({ ...o, root, watch: false, timing: TIMING });
            const readNow = follower.readNow?.bind(follower);
            // The first forced read after `up` finds the popAll entry of B, the next one throws.
            if (readNow !== undefined) {
              follower.readNow = () => (afterUp && (reads += 1) > 1
                ? Promise.reject(new Error('read failed')) : readNow());
            }
            return follower;
          },
        },
      });
      pane.upWrites = (taken) => appendFile(fx.transcript, queueLine('popAll', taken[0]));
      pane.afterKey = (key) => { if (key === 'up') afterUp = true; };
      expect(await takeBack(fx)).toEqual({
        cli: [{ text: 'pomiar B: ok' }], rarog: [], fieldCleanup: 'pending', cliLeft: true,
      });
      await quiet();
      expect(keys(fx)).toEqual(['up']);
      expect(pane.field).toEqual(TWO);
      expect(await takeBack(fx)).toEqual({ refused: 'busy' });
    });
});

describe('queue take-back: Rarog queue', () => {
  /**
   * A message pasted mid-turn whose Enter a dialog held: the head waits for its Enter, its text in the field, after
   * `draft` when the field held one (the queue pastes after a draft at the Mac); `cli` waits in the CLI queue.
   */
  async function pastedHead(
    deps: Partial<HerdrDriverDeps> = {}, draft?: string, cli: readonly string[] = [],
  ): Promise<Setup> {
    const ctx = await setup({
      transcript: userLine('start') + cli.map((text) => queueLine('enqueue', text)).join(''), queue: cli,
      deps: { promptRetryMs: 600_000, ...deps },
    });
    if (draft !== undefined) {
      ctx.pane.field = [draft];
      ctx.pane.draw();
    }
    const paste = ctx.fx.client.pasteText;
    ctx.fx.client.pasteText = async (paneId, text) => {
      await paste(paneId, text);
      ctx.registry.now = WAITING;
    };
    ctx.fx.driver.send('pierwszy', undefined, undefined, { echo: 'e1' });
    await waitFor(() => ctx.logs.some((line) => line.includes('after paste')), 'held after paste');
    ctx.registry.now = ACTIVE;
    return ctx;
  }

  it('the pasted head in the field: taken with its echo token and cleared', async () => {
    const { fx, pane } = await pastedHead();
    expect(pane.field).toEqual(['pierwszy']);
    const result = await takeBack(fx);
    expect(result).toEqual({ cli: [], rarog: [{ text: 'pierwszy', echo: 'e1' }], fieldCleanup: 'done' });
    expect(keys(fx)).toEqual(['ctrl+u']);
    expect(pane.submitted).toEqual([]);
  });

  it('a draft at the Mac under the pasted head: `draft` before the queue is touched, no key', async () => {
    const { fx, pane } = await pastedHead({}, 'szkic Maca ');
    expect(pane.field).toEqual(['szkic Maca pierwszy']);
    expect(await takeBack(fx)).toEqual({ refused: 'draft' });
    expect(keys(fx)).toEqual([]);
    expect(pane.field).toEqual(['szkic Maca pierwszy']);
    // The message is still queued: with the field emptied at the Mac, the next take-back returns it.
    pane.field = [];
    pane.draw();
    expect(await takeBack(fx)).toEqual({ cli: [], rarog: [{ text: 'pierwszy', echo: 'e1' }], fieldCleanup: 'done' });
    expect(keys(fx)).toEqual([]);
  });

  it('more CLI prompts than the file can prove taken after one `up`: `queue`, no key, both queues stay; '
    + 'one prompt fewer and both come back', async () => {
    const cli = Array.from({ length: CLI_QUEUE_POPS_KEPT + 1 }, (_, index) => `kolejka ${String(index + 1)}`);
    const { fx, pane } = await pastedHead({}, undefined, cli);
    expect(await takeBack(fx)).toEqual({ refused: 'queue' });
    expect(keys(fx)).toEqual([]);
    expect(pane.field).toEqual(['pierwszy']);
    expect(pane.queue).toEqual(cli);
    // The CLI drops one prompt: at the limit the take-back returns the rest and the message Rarog still held.
    const dropped = pane.queue.pop() ?? '';
    await appendFile(fx.transcript, queueLine('remove', dropped));
    pane.draw();
    expect(await takeBack(fx)).toEqual({
      cli: cli.slice(0, -1).map((text) => ({ text })), rarog: [{ text: 'pierwszy', echo: 'e1' }], fieldCleanup: 'done',
    });
    expect(pane.field).toEqual([]);
  });

  it('the CLI queue grows past what the file can prove while the head leaves the field: no `up`, the head comes back',
    async () => {
      const cli = Array.from({ length: CLI_QUEUE_POPS_KEPT }, (_, index) => `kolejka ${String(index + 1)}`);
      const { fx, pane } = await pastedHead({}, undefined, cli);
      let grown = false;
      pane.afterKey = (key) => {
        if (key !== 'ctrl+u' || grown) return;
        grown = true;
        pane.queue.push('kolejka 65');
        void appendFile(fx.transcript, queueLine('enqueue', 'kolejka 65'));
      };
      const result = await takeBack(fx);
      expect(grown).toBe(true);
      expect(result).toMatchObject({ cli: [], rarog: [{ text: 'pierwszy', echo: 'e1' }] });
      expect(keys(fx)).not.toContain('up');
      expect(pane.queue).toHaveLength(CLI_QUEUE_POPS_KEPT + 1);
    });

  it('the Enter of a queued message not settled yet: the take-back waits for it', async () => {
    const { fx, pane } = await setup({ transcript: userLine('start'), deps: { promptSubmitSettleMs: 60_000 } });
    fx.driver.send('wysłana', undefined, undefined, { echo: 'e1' });
    await waitFor(() => pane.submitted.length === 1, 'Enter');
    let result: QueueTakeBackResult | undefined;
    void takeBack(fx).then((value) => { result = value; });
    await quiet();
    await quiet();
    expect(result).toBeUndefined();
    expect(fx.client.calls.filter((call) => call.method === 'read').length).toBeGreaterThan(0);
    // The prompt entry of the message settles the Enter: the CLI took it into its queue, and the take-back goes on.
    await appendFile(fx.transcript, userLine('wysłana'));
    await waitFor(() => result !== undefined, 'take-back after the Enter settled');
    expect(result).toMatchObject({ rarog: [] });
  });

  it('the write of Rarog queue fails: `disk`, no key, the message stays queued', async () => {
    const dataDir = join(base, 'data');
    await mkdir(dataDir, { recursive: true });
    const store: PromptQueueStore = createPromptQueueStore({ dataDir });
    try {
      const { fx } = await pastedHead({ promptStore: store });
      await chmod(dataDir, 0o500);
      expect(await takeBack(fx)).toEqual({ refused: 'disk' });
      expect(keys(fx)).toEqual([]);
      await chmod(dataDir, 0o700);
      expect(await takeBack(fx)).toEqual({ cli: [], rarog: [{ text: 'pierwszy', echo: 'e1' }], fieldCleanup: 'done' });
    } finally {
      await chmod(dataDir, 0o700);
      await store.close();
    }
  });
});

describe('queue take-back: the first-key mark of the caller', () => {
  const BOTH = { cli: [{ text: 'pomiar B: ok' }, { text: 'pomiar C: ok' }], rarog: [], fieldCleanup: 'done' };

  /** The take-back with a mark that notes how many take-back keys the client had got when the mark ran. */
  function takeBackMarked(fx: Fixture, marks: number[]): Promise<QueueTakeBackResult | undefined> {
    return fx.driver.takeBackQueue?.(() => { marks.push(keys(fx).length); }) ?? Promise.resolve(undefined);
  }

  it('runs once, right before `up` reaches the client; the `ctrl+u` after it do not run it', async () => {
    const { fx } = await setup({ transcript: BEFORE_UP, queue: TWO });
    const marks: number[] = [];
    expect(await takeBackMarked(fx, marks)).toEqual(BOTH);
    expect(keys(fx)).toEqual(['up', 'ctrl+u', 'ctrl+u']);
    expect(marks).toEqual([0]);
  });

  it('the driver disposed while `up` goes out: the mark ran for `up` and never runs again', async () => {
    const { fx, pane } = await setup({ transcript: BEFORE_UP, queue: TWO });
    pane.upWrites = async (taken) => {
      await appendFile(fx.transcript, taken.map((text) => queueLine('popAll', text)).join(''));
      fx.driver.dispose();
    };
    const marks: number[] = [];
    await takeBackMarked(fx, marks);
    await quiet();
    expect(keys(fx)).toEqual(['up']);
    expect(marks).toEqual([0]);
  });

  it('the driver disposed during the file read right before `up`: no key and no mark', async () => {
    let reads = 0;
    const { fx } = await setup({
      transcript: BEFORE_UP, queue: TWO,
      deps: {
        follow: (o) => {
          const follower = createJsonlFollower({ ...o, root, watch: false, timing: TIMING });
          const readNow = follower.readNow?.bind(follower);
          // The first forced read counts the queue at the gates, the second comes right before `up`.
          follower.readNow = async () => {
            await readNow?.();
            if ((reads += 1) === 2) fx.driver.dispose();
          };
          return follower;
        },
      },
    });
    const marks: number[] = [];
    expect(await takeBackMarked(fx, marks)).toEqual({ cli: [], rarog: [], fieldCleanup: 'done', cliLeft: true });
    await quiet();
    expect(keys(fx)).toEqual([]);
    expect(marks).toEqual([]);
  });

  it('a mark that throws does not stop the keys', async () => {
    const { fx, pane } = await setup({ transcript: BEFORE_UP, queue: TWO });
    const result = await fx.driver.takeBackQueue?.(() => { throw new Error('the mark failed'); });
    expect(result).toEqual(BOTH);
    expect(keys(fx)).toEqual(['up', 'ctrl+u', 'ctrl+u']);
    expect(pane.field).toEqual([]);
  });
});
