/**
 * Sending while a turn runs through the herdr driver (`drivers/herdr/prompt-queue.ts`): paste, check,
 * separate Enter. The tests drive the facade `drivers/herdr-driver.ts` with the shared fakes from
 * `helpers/herdr-driver-atrapy.ts`: the fake client counts every call, the follower reads a real jsonl file.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { foreign } from '@rarog/shared/sentences';
import type { DriverEvent } from '../src/drivers/types.ts';
import type { HerdrDriverDeps } from '../src/drivers/herdr-driver.ts';
import { assertSendable } from '../src/herdr/commands/guard.ts';
import { HerdrReadOnlyError } from '../src/herdr/types.ts';
import type { HerdrAgentInfo, HerdrScreen } from '../src/herdr/types.ts';
import { createJsonlFollower } from '../src/herdr/jsonl-follow.ts';
import {
  DIALOG_PERMISSION, EMPTY_FIELD, FIXTURES, PANE, SESSION, TIMING, blockedLine, commandOpts, composerPane,
  drivenClock, inTurn, makeDriver, pasteFlow, quiet, root, systemCodes, useDriverSandbox, userLine, waitFor,
} from './helpers/herdr-driver-atrapy.ts';
import type { ComposerPane, Fixture } from './helpers/herdr-driver-atrapy.ts';

useDriverSandbox();

describe('wysyłka w trakcie tury: wklejenie i osobny Enter', () => {
  const PREVIEW_FORM = readFileSync(join(FIXTURES, 'measured', 'pytanie-preview-2.1.293.txt'), 'utf8');
  const WAITING = { kind: 'waiting', dialog: 'permission' } as const;
  const ACTIVE = { kind: 'active' } as const;
  type Signal = Awaited<ReturnType<NonNullable<HerdrDriverDeps['consentRegistryRead']>>>;

  const echoRefused = (fx: Fixture): string[] => fx.events
    .filter((e): e is Extract<DriverEvent, { type: 'echo-refused' }> => e.type === 'echo-refused')
    .map((e) => e.token);
  const enters = (fx: Fixture): number => fx.client.calls.filter((c) => c.method === 'prompt_submit').length;

  it('bez dialogu: wklejenie i Enter od razu, bez czekania ponad pojawienie się tekstu w polu', async () => {
    const clock = drivenClock();
    const logs: string[] = [];
    const fx = await makeDriver({
      agent: { status: 'working' }, deps: { scheduler: clock.scheduler, logger: (line) => logs.push(line) },
    });
    composerPane(fx);
    fx.driver.send('dopisek w trakcie tury', undefined, undefined, { echo: 'e1' });
    // Zegar drivera stoi: tekst stoi w polu od razu, więc Enter idzie bez żadnego timera.
    await clock.advance(0);
    expect(pasteFlow(fx)).toEqual(['paste:dopisek w trakcie tury', 'enter']);
    expect(fx.client.calls.filter((c) => c.method === 'send_keys')).toEqual([]);
    expect(echoRefused(fx)).toEqual([]);
    expect(logs).toEqual([]);
    expect(fx.audit.map((entry) => [entry.method, entry.keys ?? entry.text])).toEqual([
      ['prompt', 'dopisek w trakcie tury'], ['send_keys', ['enter']],
    ]);
  });

  it('`waiting` w rejestrze przed wysyłką: nic nie idzie, wiadomość czeka i idzie po dialogu', async () => {
    const logs: string[] = [];
    const fx = await makeDriver({
      transcript: userLine('start'), agent: { status: 'working' },
      deps: { promptRetryMs: 5, blockedPollMs: 5, screenCacheMs: 0, logger: (line) => logs.push(line) },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    const pane = composerPane(fx);
    pane.dialog = DIALOG_PERMISSION;
    pane.draw();
    fx.driver.noteCliWaiting?.(WAITING);
    await quiet();
    fx.driver.send('po dialogu', undefined, undefined, { echo: 'e1' });
    await quiet();
    await quiet();
    expect(pasteFlow(fx)).toEqual([]);
    expect(echoRefused(fx)).toEqual([]);
    expect(systemCodes(fx.events).filter((code) => code.startsWith('commands.send-'))).toEqual([]);
    expect(logs.filter((line) => line.includes('waits'))).toHaveLength(1);

    pane.dialog = null;
    pane.draw();
    fx.driver.noteCliWaiting?.(ACTIVE);
    await waitFor(() => enters(fx) === 1, 'enter po dialogu');
    expect(pasteFlow(fx)).toEqual(['paste:po dialogu', 'enter']);
    expect(echoRefused(fx)).toEqual([]);
  });

  it('dialog między wklejeniem a Enterem: bez Entera, wiadomość zostaje na początku kolejki, nic nie ginie',
    async () => {
      const clock = drivenClock();
      const logs: string[] = [];
      let registry: Signal = ACTIVE;
      const fx = await makeDriver({
        agent: { status: 'working' },
        deps: {
          scheduler: clock.scheduler, logger: (line) => logs.push(line),
          consentRegistryRead: () => Promise.resolve(registry),
        },
      });
      const pane = composerPane(fx);
      const paste = fx.client.pasteText;
      let first = true;
      fx.client.pasteText = async (paneId, text) => {
        await paste(paneId, text);
        // CLI dostał żądanie dialogu tuż po wklejeniu: rejestr mówi `waiting`, dialog rysuje się później
        // (zmierzone na 2.1.322, pomiar 0a).
        if (first) registry = WAITING;
        first = false;
      };
      fx.driver.send('pierwszy', undefined, undefined, { echo: 'e1' });
      await clock.advance(0);
      expect(pasteFlow(fx)).toEqual(['paste:pierwszy']);
      expect(logs).toEqual([
        `send: registry after paste in pane ${PANE}, no Enter; message stays at the head of the queue`,
      ]);

      // Dialog stoi i zakrywa pole; druga wiadomość staje za pierwszą.
      pane.dialog = DIALOG_PERMISSION;
      pane.draw();
      fx.driver.send('drugi', undefined, undefined, { echo: 'e2' });
      await clock.advance(1_000);
      expect(pasteFlow(fx)).toEqual(['paste:pierwszy']);

      // Dialog zamknięty, tekst przetrwał w polu (pomiar 0a: 7 z 7): Enter bez ponownego wklejania.
      pane.dialog = null;
      pane.draw();
      registry = ACTIVE;
      await clock.advance(300);
      expect(pasteFlow(fx)).toEqual(['paste:pierwszy', 'enter']);
      // Druga czeka na rozstrzygnięcie Entera pierwszej (hook mógłby oddać jej tekst do pola), najwyżej limit.
      await clock.advance(1_500);
      expect(pasteFlow(fx)).toEqual(['paste:pierwszy', 'enter', 'paste:drugi', 'enter']);
      expect(echoRefused(fx)).toEqual([]);
      expect(systemCodes(fx.events)).toEqual([]);
      expect(logs.some((line) => /^send: Enter \d+ ms after paste in pane .+, checked again: clear$/.test(line)))
        .toBe(true);
    });

  it('`waiting` w rejestrze między odczytem pola a wklejeniem: zero wklejenia, wiadomość idzie po dialogu', async () => {
    const clock = drivenClock();
    const logs: string[] = [];
    let registry: Signal = ACTIVE;
    const fx = await makeDriver({
      agent: { status: 'working' },
      deps: {
        scheduler: clock.scheduler, logger: (line) => logs.push(line),
        consentRegistryRead: () => Promise.resolve(registry),
      },
    });
    composerPane(fx);
    const getAgent = fx.client.getAgent.bind(fx.client);
    let first = true;
    fx.client.getAgent = async () => {
      // CLI zażądał dialogu w trakcie `agent.get`: dialogu jeszcze nie widać, rejestr już mówi `waiting`.
      if (first) registry = WAITING;
      first = false;
      return getAgent();
    };
    fx.driver.send('tuż przed wklejeniem', undefined, undefined, { echo: 'e1' });
    await clock.advance(0);
    expect(pasteFlow(fx)).toEqual([]);
    expect(logs).toEqual([`send: message for pane ${PANE} waits (registry)`]);

    registry = ACTIVE;
    await clock.advance(300);
    expect(pasteFlow(fx)).toEqual(['paste:tuż przed wklejeniem', 'enter']);
    expect(echoRefused(fx)).toEqual([]);
  });

  it('formularz na wierzchu: zero wklejenia, wiadomość idzie, gdy pole wróci', async () => {
    const logs: string[] = [];
    const fx = await makeDriver({
      agent: { status: 'working' }, deps: { promptRetryMs: 5, logger: (line) => logs.push(line) },
    });
    const pane = composerPane(fx);
    pane.dialog = PREVIEW_FORM;
    pane.draw();
    fx.driver.send('to nie jest odpowiedź');
    await quiet();
    await quiet();
    expect(pasteFlow(fx)).toEqual([]);
    expect(logs).toEqual([`send: message for pane ${PANE} waits (screen)`]);

    pane.dialog = null;
    pane.draw();
    await waitFor(() => enters(fx) === 1, 'enter po formularzu');
    expect(pasteFlow(fx)).toEqual(['paste:to nie jest odpowiedź', 'enter']);
  });

  it('Enter później niż 300 ms po wklejeniu: drugie sprawdzenie i linia logu z czasem', async () => {
    const clock = drivenClock();
    const logs: string[] = [];
    let registryReads = 0;
    const fx = await makeDriver({
      agent: { status: 'working' },
      deps: {
        scheduler: clock.scheduler, logger: (line) => logs.push(line),
        consentRegistryRead: () => { registryReads += 1; return Promise.resolve(ACTIVE); },
      },
    });
    const pane = composerPane(fx);
    // Tekst staje w polu dopiero po 400 ms (przestój herdr albo wolny render).
    fx.client.pasteText = (paneId, text) => {
      fx.client.calls.push({ method: 'paste', paneId, text });
      clock.scheduler.setTimeout(() => { pane.field += text; pane.draw(); }, 400);
      return Promise.resolve();
    };
    fx.driver.send('powoli');
    await clock.advance(1_000);
    expect(pasteFlow(fx)).toEqual(['paste:powoli', 'enter']);
    // Rejestr przed odczytem pola, tuż przed wklejeniem, przed Enterem i drugi raz przy późnym Enterze.
    expect(registryReads).toBe(4);
    expect(logs).toEqual([`send: Enter 400 ms after paste in pane ${PANE}, checked again: clear`]);
  });

  it('prośba hooka zgody czeka: zero wklejenia, a slash-komenda za wiadomością nie idzie', async () => {
    const logs: string[] = [];
    let hookWaits = true;
    const fx = await makeDriver({
      agent: { status: 'working' },
      deps: { promptRetryMs: 5, consentCardLive: () => hookWaits, logger: (line) => logs.push(line) },
    });
    composerPane(fx);
    fx.driver.send('dopisek');
    await quiet();
    fx.driver.send('/compact', undefined, undefined, commandOpts('/compact'));
    await waitFor(() => systemCodes(fx.events).includes('commands.send-held.cli-dialog'), 'odmowa komendy');
    expect(pasteFlow(fx)).toEqual([]);
    expect(logs).toEqual([`send: message for pane ${PANE} waits (hook)`]);

    hookWaits = false;
    await waitFor(() => enters(fx) === 1, 'enter po prośbie hooka');
    expect(pasteFlow(fx)).toEqual(['paste:dopisek', 'enter']);
  });

  it('wklejenie trzy razy przepada w dialogu, który już stał: wiadomość nie poszła i transkrypt to mówi', async () => {
    /*
     * Dowód, że tekst przepadł: pierwszy odczyt po wklejeniu, skończony przed progiem 300 ms, pokazuje dialog w miejscu
     * pola. CLI rysuje dialog żądany po wejściu najwcześniej 441 ms po nim (pomiar 0a na CLI 2.1.322), więc ten dialog
     * stał już przy wklejeniu, a tekst wklejony w stojący dialog przepada (tamże: 6 z 6). Po dialogu pole jest jak przed
     * wklejeniem: od nowa.
     */
    const clock = drivenClock();
    const logs: string[] = [];
    const fx = await makeDriver({
      agent: { status: 'working' },
      deps: { scheduler: clock.scheduler, logger: (line) => logs.push(line) },
    });
    const pane = composerPane(fx);
    fx.client.pasteText = (paneId, text) => {
      fx.client.calls.push({ method: 'paste', paneId, text });
      // Dialog stanął między ostatnim sprawdzeniem a wklejeniem: tekst trafia w dialog i przepada.
      pane.dialog = DIALOG_PERMISSION;
      pane.draw();
      clock.scheduler.setTimeout(() => { pane.dialog = null; pane.draw(); }, 100);
      return Promise.resolve();
    };
    fx.driver.send('zgubiony', undefined, undefined, { echo: 'e1' });
    await clock.advance(5_000);
    expect(pasteFlow(fx)).toEqual(['paste:zgubiony', 'paste:zgubiony', 'paste:zgubiony']);
    expect(echoRefused(fx)).toEqual(['e1']);
    expect(systemCodes(fx.events)).toEqual(['commands.send-stalled']);
    expect(logs.at(-1)).toBe(`send: message for pane ${PANE} not placed after 3 pastes, not sent`);
  });

  it('odczyt pola po turze nie bierze wiadomości z kolejki wklejeń za niewzięty prompt', async () => {
    const clock = drivenClock();
    let registry: Signal = ACTIVE;
    const fx = await makeDriver({
      agent: { status: 'working' },
      deps: { scheduler: clock.scheduler, consentRegistryRead: () => Promise.resolve(registry) },
    });
    composerPane(fx);
    const paste = fx.client.pasteText;
    fx.client.pasteText = async (paneId, text) => {
      await paste(paneId, text);
      registry = WAITING;
    };
    fx.driver.send('czeka na Enter', undefined, undefined, { echo: 'e1' });
    await clock.advance(0);
    expect(pasteFlow(fx)).toEqual(['paste:czeka na Enter']);
    const check = fx.driver.checkHeldLeftover?.([{ token: 'e1', text: 'czeka na Enter' }], () => true) ?? null;
    await clock.advance(0);
    await expect(check).resolves.toEqual(new Map([['e1', 'unknown']]));
  });

  it('wklejenie odrzucone przez herdr: bez Entera, echo oddane, notka jak przy `agent.prompt`', async () => {
    const fx = await makeDriver({ agent: { status: 'working' }, deps: { promptRetryMs: 5 } });
    composerPane(fx);
    fx.client.pasteText = (paneId, text) => {
      fx.client.calls.push({ method: 'paste', paneId, text });
      return Promise.reject(new HerdrReadOnlyError(foreign('feature_disabled')));
    };
    fx.driver.send('odrzucony', undefined, undefined, { echo: 'e1' });
    await waitFor(() => systemCodes(fx.events).includes('commands.send-read-only'), 'notka');
    await quiet();
    expect(pasteFlow(fx)).toEqual(['paste:odrzucony']);
    expect(echoRefused(fx)).toEqual(['e1']);
  });

  it('panel innego agenta: `agent.prompt` bez `wait`, bez wklejenia', async () => {
    const fx = await makeDriver({ agent: { status: 'working', engine: 'codex' } });
    fx.client.screenText = EMPTY_FIELD;
    fx.driver.send('dopisek dla Codexa');
    await waitFor(() => fx.client.calls.some((c) => c.method === 'prompt'), 'prompt');
    await quiet();
    expect(pasteFlow(fx)).toEqual(['prompt:dopisek dla Codexa']);
    expect('wait' in (fx.client.calls.find((c) => c.method === 'prompt') ?? {})).toBe(false);
  });

  /*
   * Bramka trybu przy ponowieniu, czyszczenie pola dopiero po sprawdzeniu dialogu, bez drugiej wysyłki tej samej
   * wiadomości i bez sklejenia z wiadomością odrzuconą przez hook.
   */

  /** Podkody powodu w zdaniach `commands.send-refused`. */
  const refusedReasons = (fx: Fixture): string[] => fx.events
    .filter((e): e is Extract<DriverEvent, { type: 'message' }> => e.type === 'message' && e.role === 'system')
    .flatMap((e) => e.blocks.flatMap((b) => (
      b.type === 'text' && 'ref' in b.text && b.text.ref.code === 'commands.send-refused' ? b.text.ref.args ?? [] : []
    )));
  const escapes = (fx: Fixture): (readonly string[] | undefined)[] =>
    fx.client.calls.filter((c) => c.method === 'send_keys').map((c) => c.keys);
  const promptBlocks = (fx: Fixture): number => fx.events.filter((e) => e.type === 'prompt-blocked').length;
  /** Wpis `user` z czasem TERAZ: follower bierze token tylko od wpisu nie starszego niż rejestracja echa. */
  const freshUserLine = (text: string): string => `${JSON.stringify({
    type: 'user', message: { role: 'user', content: text }, isSidechain: false,
    timestamp: new Date().toISOString(), sessionId: SESSION,
  })}\n`;

  it('tryb `auto` → `bypass` poza `RAROG_YOLO_ROOTS` w czasie czekania: zero wklejenia, echo oddane, powód w transkrypcie',
    async () => {
      const logs: string[] = [];
      let hookWaits = true;
      const fx = await makeDriver({
        agent: { status: 'working', mode: 'auto' },
        deps: {
          guard: assertSendable, promptRetryMs: 5, consentCardLive: () => hookWaits,
          logger: (line) => logs.push(line),
        },
      });
      composerPane(fx);
      fx.driver.send('po dialogu', undefined, undefined, { echo: 'e1' });
      await quiet();
      expect(pasteFlow(fx)).toEqual([]);

      // Stopka pokazała `bypass`, a katalog panelu nie leży w `RAROG_YOLO_ROOTS` (`yoloRoots: []`); dialog się kończy.
      fx.emit({ type: 'mode', mode: 'bypass' });
      hookWaits = false;
      await waitFor(() => echoRefused(fx).includes('e1'), 'odmowa bramki');
      await quiet();
      expect(pasteFlow(fx)).toEqual([]);
      expect(escapes(fx)).toEqual([]);
      expect(refusedReasons(fx)).toEqual(['commands.bypass-outside-yolo']);
      expect(logs.at(-1)).toBe(`send: send guard refused the message for pane ${PANE} before paste`);
    });

  it('tryb `bypass` poza `RAROG_YOLO_ROOTS` między wklejeniem a Enterem: bez Entera, echo oddane, powód w transkrypcie',
    async () => {
      const clock = drivenClock();
      let registry: Signal = ACTIVE;
      const fx = await makeDriver({
        agent: { status: 'working', mode: 'auto' },
        deps: { guard: assertSendable, scheduler: clock.scheduler, consentRegistryRead: () => Promise.resolve(registry) },
      });
      const pane = composerPane(fx);
      const paste = fx.client.pasteText;
      fx.client.pasteText = async (paneId, text) => {
        await paste(paneId, text);
        // CLI zażądał dialogu tuż po wklejeniu: Enter czeka na jego koniec, tekst stoi w polu.
        registry = WAITING;
      };
      fx.driver.send('przed Enterem', undefined, undefined, { echo: 'e1' });
      await clock.advance(0);
      expect(pasteFlow(fx)).toEqual(['paste:przed Enterem']);

      fx.emit({ type: 'mode', mode: 'bypass' });
      registry = ACTIVE;
      await clock.advance(1_000);
      expect(pasteFlow(fx)).toEqual(['paste:przed Enterem']);
      expect(echoRefused(fx)).toEqual(['e1']);
      expect(refusedReasons(fx)).toEqual(['commands.bypass-outside-yolo']);
      expect(pane.field).toBe('przed Enterem');
    });

  it('formularz na wierzchu przy `#needsEscape` po blokadzie hooka: zero klawiszy czyszczenia, para Esc po formularzu',
    async () => {
      const fx = await makeDriver({
        transcript: userLine('start'), agent: { status: 'idle' }, deps: { promptRetryMs: 5, stallSettleMs: 5 },
      });
      await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
      const pane = composerPane(fx);
      // Hook `UserPromptSubmit` blokuje prompt wysłany poza turą: wpis blokady w pliku, tekst wraca do pola.
      fx.client.prompt = async (paneId, text, wait) => {
        fx.client.calls.push({ method: 'prompt', paneId, text, ...(wait === undefined ? {} : { wait }) });
        const before = promptBlocks(fx);
        await appendFile(fx.transcript, blockedLine(text));
        await waitFor(() => promptBlocks(fx) > before, 'blokada w driverze');
        pane.field = text;
        pane.draw();
      };
      fx.driver.send('zablokowany');
      await waitFor(() => promptBlocks(fx) === 1, 'blokada');
      await quiet();

      // Tura trwa, a na wierzchu stoi formularz z `❯ 1.` w kolumnie 0 — opcja formularza, nie pole promptu.
      inTurn(fx);
      pane.dialog = PREVIEW_FORM;
      pane.draw();
      fx.driver.send('drugi', undefined, undefined, { echo: 'e2' });
      await quiet();
      await quiet();
      expect(escapes(fx)).toEqual([]);
      expect(pasteFlow(fx)).toEqual(['prompt:zablokowany']);

      // Formularz zamknięty, pole trzyma zablokowany prompt: para Esc dopiero teraz, potem sama druga wiadomość.
      pane.dialog = null;
      pane.draw();
      await waitFor(() => enters(fx) === 1, 'enter po formularzu');
      expect(escapes(fx)).toEqual([['escape', 'escape']]);
      expect(pane.submitted).toEqual(['drugi']);
    });

  it('Enter przy Macu przed pierwszym odczytem, echo potwierdzone wpisem z pliku: jedno wklejenie, wpis kolejki zamknięty',
    async () => {
      const logs: string[] = [];
      const fx = await makeDriver({
        transcript: userLine('start'), agent: { status: 'working' },
        deps: { promptRetryMs: 5, promptFieldWaitMs: 400, logger: (line) => logs.push(line) },
      });
      await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
      const pane = composerPane(fx);
      const paste = fx.client.pasteText;
      let first = true;
      fx.client.pasteText = async (paneId, text) => {
        if (!first) {
          await paste(paneId, text);
          return;
        }
        first = false;
        fx.client.calls.push({ method: 'paste', paneId, text });
        // Człowiek przy Macu nacisnął Enter, zanim driver przeczytał pole: pole puste, prompt w pliku rozmowy.
        await appendFile(fx.transcript, freshUserLine(text));
      };
      fx.driver.send('wyślij raz', undefined, undefined, { echo: 'e1' });
      fx.driver.send('następna', undefined, undefined, { echo: 'e2' });
      await waitFor(() => enters(fx) >= 1, 'enter');
      await quiet();
      expect(pasteFlow(fx)).toEqual(['paste:wyślij raz', 'paste:następna', 'enter']);
      expect(pane.submitted).toEqual(['następna']);
      expect(fx.events.some((e) => e.type === 'message' && e.echoToken === 'e1')).toBe(true);
      expect(echoRefused(fx)).toEqual([]);
      expect(systemCodes(fx.events)).toEqual([]);
      expect(logs).toContain(`send: message for pane ${PANE} arrived in the transcript, no Enter from Rarog`);
    });

  it('tekst nie pokazał się w widocznym polu i nic go nie potwierdziło: jedno wklejenie, bez drugiego i bez Entera',
    async () => {
      /*
       * Pole puste przed wklejeniem i po nim, bez dialogu: tekst mógł pójść Enterem przy Macu przed pierwszym odczytem,
       * więc drugie wklejenie groziłoby drugą wysyłką. Echo zostaje w oknie (wpis z pliku podstawi wiadomość, inaczej
       * spłucze ją manager po turze), bez zdania odmowy.
       */
      const clock = drivenClock();
      const logs: string[] = [];
      const fx = await makeDriver({
        agent: { status: 'working' },
        deps: { scheduler: clock.scheduler, promptFieldWaitMs: 100, logger: (line) => logs.push(line) },
      });
      composerPane(fx);
      fx.client.pasteText = (paneId, text) => {
        fx.client.calls.push({ method: 'paste', paneId, text });
        return Promise.resolve();
      };
      fx.driver.send('niewidoczny', undefined, undefined, { echo: 'e1' });
      await clock.advance(5_000);
      expect(pasteFlow(fx)).toEqual(['paste:niewidoczny']);
      expect(echoRefused(fx)).toEqual([]);
      expect(systemCodes(fx.events)).toEqual([]);
      expect(logs.at(-1)).toBe(
        `send: pasted text never showed in the prompt field of pane ${PANE}; it may have gone with an Enter at the desk,`
          + ' not pasted again',
      );
    });

  it('hook blokuje pierwszą wiadomość z kolejki, a jej tekst wraca do pola: druga idzie bez tego tekstu', async () => {
    /*
     * W trakcie tury blokada nie zostawia wpisu w pliku (`docs/dialogs.md`, „Prompt blocked by a hook”): driver widzi
     * tylko pole, które po Enterze dalej trzyma dokładnie wysłany tekst.
     */
    const fx = await makeDriver({ agent: { status: 'working' }, deps: { promptRetryMs: 5 } });
    const pane = composerPane(fx);
    pane.dialog = DIALOG_PERMISSION;
    pane.draw();
    fx.driver.send('pierwszy', undefined, undefined, { echo: 'e1' });
    fx.driver.send('drugi', undefined, undefined, { echo: 'e2' });
    await quiet();
    expect(pasteFlow(fx)).toEqual([]);

    const submit = fx.client.sendPromptSubmit;
    let blocked = false;
    fx.client.sendPromptSubmit = async (paneId) => {
      const text = pane.field;
      await submit(paneId);
      if (blocked) return;
      blocked = true;
      pane.field = text;
      pane.draw();
    };
    pane.dialog = null;
    pane.draw();
    await waitFor(() => enters(fx) === 2, 'dwa Entery');
    await quiet();
    expect(pane.submitted).toEqual(['pierwszy', 'drugi']);
    expect(escapes(fx)).toEqual([['escape', 'escape']]);
    expect(pasteFlow(fx)).toEqual(['paste:pierwszy', 'enter', 'paste:drugi', 'enter']);
  });

  /*
   * Świeże pole przed parą Esc, zero sklejki po tekście, który hook oddaje do pola później niż pierwszy odczyt, i notka
   * o wysyłce bez potwierdzenia.
   */

  /** Hook `UserPromptSubmit` blokuje pierwszą wiadomość z kolejki: po Enterze CLI oddaje jej tekst do pola. */
  const blockFirstSubmit = (fx: Fixture, pane: ComposerPane, restore: (text: string) => void): void => {
    const submit = fx.client.sendPromptSubmit;
    let blocked = false;
    fx.client.sendPromptSubmit = async (paneId) => {
      const text = pane.field;
      await submit(paneId);
      if (blocked) return;
      blocked = true;
      restore(text);
    };
  };

  it('pole opustoszeje podczas `consentRegistryRead` między sprawdzeniem własności pozostałości a parą Esc: zero '
    + 'klawiszy czyszczenia, wiadomość wklejona i wysłana', async () => {
    const clock = drivenClock();
    let onRegistry = (): void => {};
    const fx = await makeDriver({
      agent: { status: 'working' },
      deps: {
        scheduler: clock.scheduler,
        consentRegistryRead: () => { onRegistry(); return Promise.resolve(ACTIVE); },
      },
    });
    const pane = composerPane(fx);
    blockFirstSubmit(fx, pane, (text) => { pane.field = text; pane.draw(); });
    fx.driver.send('pierwszy', undefined, undefined, { echo: 'e1' });
    await clock.advance(0);
    expect(pane.field).toBe('pierwszy');

    // Driver widzi w polu oddany tekst (własność pozostałości), a w czasie następnego odczytu rejestru człowiek przy
    // Macu czyści pole: para Esc na pustym polu otworzyłaby rewind.
    let watching = true;
    let owned = false;
    const read = fx.client.readScreen.bind(fx.client);
    fx.client.readScreen = (paneId, source, format) => {
      if (watching && pane.field === 'pierwszy') owned = true;
      return read(paneId, source, format);
    };
    onRegistry = () => {
      if (!owned) return;
      owned = false;
      watching = false;
      pane.field = '';
      pane.draw();
    };
    fx.driver.send('drugi', undefined, undefined, { echo: 'e2' });
    await clock.advance(1_000);
    expect(escapes(fx)).toEqual([]);
    expect(pasteFlow(fx)).toEqual(['paste:pierwszy', 'enter', 'paste:drugi', 'enter']);
    expect(pane.submitted).toEqual(['pierwszy', 'drugi']);
    expect(echoRefused(fx)).toEqual([]);
  });

  it('hook przywraca poprzedni prompt po zakończeniu `sendPromptSubmit`, podczas przygotowania następnej wiadomości: '
    + 'Enter nie wysyła sklejki, pole czyszczone przed wklejeniem', async () => {
    const clock = drivenClock();
    const logs: string[] = [];
    const fx = await makeDriver({
      agent: { status: 'working' }, deps: { scheduler: clock.scheduler, logger: (line) => logs.push(line) },
    });
    const pane = composerPane(fx);
    // `agent.get` trwa 10 ms, a hook oddaje tekst do pola 5 ms po Enterze: w trakcie przygotowania następnej wiadomości.
    const getAgent = fx.client.getAgent;
    fx.client.getAgent = () => new Promise<HerdrAgentInfo>((resolve, reject) => {
      clock.scheduler.setTimeout(() => { getAgent().then(resolve, reject); }, 10);
    });
    blockFirstSubmit(fx, pane, (text) => {
      clock.scheduler.setTimeout(() => { pane.field = `${text}${pane.field}`; pane.draw(); }, 5);
    });
    fx.driver.send('pierwszy', undefined, undefined, { echo: 'e1' });
    await clock.advance(10);
    expect(pasteFlow(fx)).toEqual(['paste:pierwszy', 'enter']);

    fx.driver.send('drugi', undefined, undefined, { echo: 'e2' });
    await clock.advance(2_000);
    expect(pane.submitted).toEqual(['pierwszy', 'drugi']);
    expect(escapes(fx)).toEqual([['escape', 'escape']]);
    expect(pasteFlow(fx)).toEqual(['paste:pierwszy', 'enter', 'paste:drugi', 'enter']);
    expect(echoRefused(fx)).toEqual([]);
    expect(logs).toContain(`send: message for pane ${PANE} waits (submit)`);
  });

  it('hook oddaje tekst poprzedniej wiadomości dopiero po limicie czekania, przy wklejeniu następnej: bez Entera '
    + 'sklejki, bez czyszczenia i bez drugiego wklejenia, odmowa `changed`', async () => {
    const clock = drivenClock();
    const logs: string[] = [];
    const fx = await makeDriver({
      agent: { status: 'working' }, deps: { scheduler: clock.scheduler, logger: (line) => logs.push(line) },
    });
    const pane = composerPane(fx);
    const paste = fx.client.pasteText;
    let pastes = 0;
    fx.client.pasteText = async (paneId, text) => {
      await paste(paneId, text);
      pastes += 1;
      if (pastes !== 2) return;
      // Wolny hook: tekst pierwszej wiadomości wraca do pola razem z wklejeniem drugiej, już po limicie czekania.
      pane.field = `pierwszy${pane.field}`;
      pane.draw();
    };
    fx.driver.send('pierwszy', undefined, undefined, { echo: 'e1' });
    await clock.advance(0);
    fx.driver.send('drugi', undefined, undefined, { echo: 'e2' });
    // Pole puste po Enterze (hook jeszcze nie oddał tekstu): druga wiadomość czeka, najwyżej do limitu.
    await clock.advance(1_000);
    expect(pasteFlow(fx)).toEqual(['paste:pierwszy', 'enter']);

    await clock.advance(2_000);
    // Pole zaczyna się tekstem Raroga, ale może to być szkic przy Macu: zero klawiszy, sklejka zostaje w polu.
    expect(pane.submitted).toEqual(['pierwszy']);
    expect(pasteFlow(fx)).toEqual(['paste:pierwszy', 'enter', 'paste:drugi']);
    expect(escapes(fx)).toEqual([]);
    expect(pane.field).toBe('pierwszydrugi');
    expect(echoRefused(fx)).toEqual(['e2']);
    expect(systemCodes(fx.events)).toEqual(['commands.send-stalled']);
    expect(logs).toContain(`send: prompt field in pane ${PANE} changed after paste, no Enter`);
  });

  it('wpis promptu z pliku rozstrzyga poprzedni Enter: następna wiadomość nie czeka do limitu', async () => {
    const fx = await makeDriver({
      transcript: userLine('start'), agent: { status: 'working' },
      deps: { promptRetryMs: 5, promptSubmitSettleMs: 60_000 },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    const pane = composerPane(fx);
    const submit = fx.client.sendPromptSubmit;
    fx.client.sendPromptSubmit = async (paneId) => {
      const text = pane.field;
      await submit(paneId);
      // CLI przyjął wiadomość: wpis `user` stoi w pliku rozmowy, pole puste.
      if (text === 'pierwszy') await appendFile(fx.transcript, freshUserLine(text));
    };
    fx.driver.send('pierwszy', undefined, undefined, { echo: 'e1' });
    fx.driver.send('drugi', undefined, undefined, { echo: 'e2' });
    await waitFor(() => enters(fx) === 2, 'dwa Entery');
    expect(pane.submitted).toEqual(['pierwszy', 'drugi']);
    expect(escapes(fx)).toEqual([]);
  });

  it('wklejenie przepada w dialogu, pierwszy odczyt trwa ponad 300 ms, a po turze nie przychodzi potwierdzenie z '
    + 'pliku: bez drugiego wklejenia, odczyt pola po turze daje `unseen`', async () => {
    const clock = drivenClock();
    const fx = await makeDriver({
      agent: { status: 'working' }, deps: { scheduler: clock.scheduler, promptFieldWaitMs: 1_000 },
    });
    const pane = composerPane(fx);
    let slowRead = false;
    const read = fx.client.readScreen.bind(fx.client);
    fx.client.readScreen = (paneId, source, format) => {
      if (!slowRead) return read(paneId, source, format);
      slowRead = false;
      // Przestój herdr: pierwszy odczyt po wklejeniu kończy się po 400 ms, więc nie dowodzi, że tekst przepadł.
      return new Promise<HerdrScreen>((resolve, reject) => {
        clock.scheduler.setTimeout(() => { read(paneId, source, format).then(resolve, reject); }, 400);
      });
    };
    fx.client.pasteText = (paneId, text) => {
      fx.client.calls.push({ method: 'paste', paneId, text });
      // Dialog stanął tuż przed wklejeniem: tekst trafia w dialog i przepada (pomiar 0a, 6 z 6).
      pane.dialog = DIALOG_PERMISSION;
      pane.draw();
      slowRead = true;
      clock.scheduler.setTimeout(() => { pane.dialog = null; pane.draw(); }, 600);
      return Promise.resolve();
    };
    fx.driver.send('zgubiony w dialogu', undefined, undefined, { echo: 'e1' });
    await clock.advance(5_000);
    expect(pasteFlow(fx)).toEqual(['paste:zgubiony w dialogu']);
    expect(echoRefused(fx)).toEqual([]);
    expect(systemCodes(fx.events)).toEqual([]);

    // Tura się kończy, a wpisu z pliku nie ma: manager pyta o pole (10 s po turze), a pole jest puste.
    const check = fx.driver.checkHeldLeftover?.([{ token: 'e1', text: 'zgubiony w dialogu' }], () => true) ?? null;
    await clock.advance(0);
    await expect(check).resolves.toEqual(new Map([['e1', 'unseen']]));
  });

  it('pole wyczyszczone przy biurku po wklejeniu, przed Enterem Raroga (`taken`), a po turze nie przychodzi '
    + 'potwierdzenie z pliku: bez Entera, odczyt pola po turze daje `unseen`', async () => {
    const clock = drivenClock();
    const logs: string[] = [];
    let registry: Signal = ACTIVE;
    const fx = await makeDriver({
      agent: { status: 'working' },
      deps: {
        scheduler: clock.scheduler, logger: (line) => logs.push(line),
        consentRegistryRead: () => Promise.resolve(registry),
      },
    });
    const pane = composerPane(fx);
    const paste = fx.client.pasteText;
    fx.client.pasteText = async (paneId, text) => {
      await paste(paneId, text);
      // Żądanie dialogu tuż po wklejeniu: tekst stoi w polu, Enter czeka.
      registry = WAITING;
    };
    fx.driver.send('wyczyszczony', undefined, undefined, { echo: 'e1' });
    await clock.advance(0);
    expect(pasteFlow(fx)).toEqual(['paste:wyczyszczony']);

    // Przy Macu pole opustoszało (Enter albo czyszczenie): wiadomość mogła pójść albo nie.
    pane.field = '';
    pane.draw();
    registry = ACTIVE;
    await clock.advance(1_000);
    expect(pasteFlow(fx)).toEqual(['paste:wyczyszczony']);
    expect(logs).toContain(`send: prompt field in pane ${PANE} taken after paste, no Enter`);
    expect(echoRefused(fx)).toEqual([]);
    expect(systemCodes(fx.events)).toEqual([]);

    // Tura się kończy, a wpisu z pliku nie ma: pole puste niczego nie potwierdza (`docs/dialogs.md`, reguła 3).
    const check = fx.driver.checkHeldLeftover?.([{ token: 'e1', text: 'wyczyszczony' }], () => true) ?? null;
    await clock.advance(0);
    await expect(check).resolves.toEqual(new Map([['e1', 'unseen']]));
  });

  /*
   * Pole niejednoznaczne kończy wiadomość bez Entera: Rarog nie kasuje tekstu, którego cały nie jest jego, i nie wkleja
   * tej samej wiadomości drugi raz bez dowodu, że bieżące wklejenie przepadło (`docs/dialogs.md`, „Sending while a turn
   * runs”).
   */

  it('szkic przy Macu zaczyna się poprzednią wiadomością z kolejki i staje w polu razem z wklejeniem następnej: zero '
    + '`escape`, szkic zostaje w polu, bez Entera, odmowa `changed`', async () => {
    const clock = drivenClock();
    const fx = await makeDriver({ agent: { status: 'working' }, deps: { scheduler: clock.scheduler } });
    const pane = composerPane(fx);
    fx.driver.send('tak', undefined, undefined, { echo: 'e1' });
    await clock.advance(0);
    expect(pane.submitted).toEqual(['tak']);

    // Człowiek przy Macu zaczyna szkic od „tak”, a w tej samej chwili idzie wklejenie następnej wiadomości.
    const paste = fx.client.pasteText;
    fx.client.pasteText = async (paneId, text) => {
      pane.field = 'tak ale chcę zachować ten szkic ';
      await paste(paneId, text);
    };
    fx.driver.send('drugi', undefined, undefined, { echo: 'e2' });
    await clock.advance(5_000);
    expect(escapes(fx)).toEqual([]);
    expect(pane.field).toBe('tak ale chcę zachować ten szkic drugi');
    expect(pasteFlow(fx)).toEqual(['paste:tak', 'enter', 'paste:drugi']);
    expect(echoRefused(fx)).toEqual(['e2']);
    expect(systemCodes(fx.events)).toEqual(['commands.send-stalled']);
  });

  it('szkic przy Macu kończy się poprzednią wiadomością z kolejki i zastępuje wklejony tekst, kiedy stoi dialog: zero '
    + '`escape`, szkic zostaje w polu, bez Entera, odmowa `changed`', async () => {
    const clock = drivenClock();
    let registry: Signal = ACTIVE;
    const fx = await makeDriver({
      agent: { status: 'working' },
      deps: { scheduler: clock.scheduler, consentRegistryRead: () => Promise.resolve(registry) },
    });
    const pane = composerPane(fx);
    fx.driver.send('tak', undefined, undefined, { echo: 'e1' });
    await clock.advance(0);
    const paste = fx.client.pasteText;
    fx.client.pasteText = async (paneId, text) => {
      await paste(paneId, text);
      // CLI zażądał dialogu tuż po wklejeniu: Enter czeka, tekst stoi w polu.
      registry = WAITING;
    };
    fx.driver.send('drugi', undefined, undefined, { echo: 'e2' });
    await clock.advance(2_000);
    expect(pasteFlow(fx)).toEqual(['paste:tak', 'enter', 'paste:drugi']);

    // Dialog się kończy, a człowiek przy Macu ma już w polu własny szkic zamiast wklejonego tekstu.
    pane.field = 'zostaw ten szkic, tak';
    pane.draw();
    registry = ACTIVE;
    await clock.advance(2_000);
    expect(escapes(fx)).toEqual([]);
    expect(pane.field).toBe('zostaw ten szkic, tak');
    expect(pasteFlow(fx)).toEqual(['paste:tak', 'enter', 'paste:drugi']);
    expect(echoRefused(fx)).toEqual(['e2']);
    expect(systemCodes(fx.events)).toEqual(['commands.send-stalled']);
  });

  it('Enter przy Macu przed pierwszym odczytem, potem hook oddaje do pola poprzednią wiadomość, a wpis z pliku przychodzi '
    + 'z opóźnieniem: wiadomość idzie raz, bez `escape` i bez drugiego wklejenia, echo zostaje', async () => {
    const fx = await makeDriver({
      transcript: userLine('start'), agent: { status: 'working' },
      deps: { promptRetryMs: 5, promptSubmitSettleMs: 30 },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    const pane = composerPane(fx);
    fx.driver.send('pierwszy', undefined, undefined, { echo: 'e1' });
    await waitFor(() => enters(fx) === 1, 'Enter pierwszej');

    const paste = fx.client.pasteText;
    let desk = true;
    fx.client.pasteText = async (paneId, text) => {
      await paste(paneId, text);
      if (!desk) return;
      desk = false;
      // Enter przy Macu, zanim driver przeczytał pole, a potem wolny hook oddaje do pola zablokowaną „pierwszy”.
      pane.submitted.push(pane.field);
      pane.field = 'pierwszy';
      pane.draw();
    };
    fx.driver.send('drugi', undefined, undefined, { echo: 'e2' });
    await waitFor(() => !desk, 'wklejenie drugiej');
    await quiet();
    await quiet();
    // Wpis promptu „drugi” z pliku rozmowy przychodzi dopiero po werdykcie drivera.
    await appendFile(fx.transcript, freshUserLine('drugi'));
    await waitFor(() => fx.events.some((e) => e.type === 'message' && e.echoToken === 'e2'), 'echo z pliku');
    await quiet();
    expect(pane.submitted).toEqual(['pierwszy', 'drugi']);
    expect(pasteFlow(fx)).toEqual(['paste:pierwszy', 'enter', 'paste:drugi']);
    expect(escapes(fx)).toEqual([]);
    expect(pane.field).toBe('pierwszy');
    expect(echoRefused(fx)).toEqual([]);
    expect(systemCodes(fx.events)).toEqual([]);
  });

  it('wklejenie przepadło w stojącym dialogu, a po dialogu pole trzyma szkic przy Macu: bez Entera, szkic zostaje, '
    + 'odmowa `changed`', async () => {
    const clock = drivenClock();
    const fx = await makeDriver({ agent: { status: 'working' }, deps: { scheduler: clock.scheduler } });
    const pane = composerPane(fx);
    fx.client.pasteText = (paneId, text) => {
      fx.client.calls.push({ method: 'paste', paneId, text });
      // Dialog stał już przy wklejeniu: tekst przepada (pomiar 0a, 6 z 6), a po dialogu człowiek pisze własny szkic.
      pane.dialog = DIALOG_PERMISSION;
      pane.draw();
      clock.scheduler.setTimeout(() => { pane.dialog = null; pane.field = 'mój szkic'; pane.draw(); }, 100);
      return Promise.resolve();
    };
    fx.driver.send('zgubiony', undefined, undefined, { echo: 'e1' });
    await clock.advance(5_000);
    expect(pasteFlow(fx)).toEqual(['paste:zgubiony']);
    expect(pane.submitted).toEqual([]);
    expect(pane.field).toBe('mój szkic');
    expect(echoRefused(fx)).toEqual(['e1']);
    expect(systemCodes(fx.events)).toEqual(['commands.send-stalled']);
  });

  /** Panel, w którym pierwsze wklejenie nie pokazuje się w polu (werdykt `unseen`), a następne idą zwykłą drogą. */
  const firstPasteUnseen = (fx: Fixture): void => {
    composerPane(fx);
    const paste = fx.client.pasteText;
    let first = true;
    fx.client.pasteText = async (paneId, text) => {
      if (!first) {
        await paste(paneId, text);
        return;
      }
      first = false;
      fx.client.calls.push({ method: 'paste', paneId, text });
    };
  };

  it('wpis echa wiadomości bez potwierdzenia wypada z okna (`echo-dropped`): token `unseen` znika, odczyt pola po turze '
    + 'daje zwykłe `empty`', async () => {
    const clock = drivenClock();
    const fx = await makeDriver({
      agent: { status: 'working' },
      deps: {
        scheduler: clock.scheduler, promptFieldWaitMs: 100,
        // Okno echa na jeden wpis z tokenem: echo następnej wiadomości wypycha echo poprzedniej.
        follow: (o) => createJsonlFollower({ ...o, root, watch: false, timing: { ...TIMING, echoWindow: 1 } }),
      },
    });
    firstPasteUnseen(fx);
    fx.driver.send('niewidoczny', undefined, undefined, { echo: 'e1' });
    await clock.advance(5_000);
    expect(pasteFlow(fx)).toEqual(['paste:niewidoczny']);

    fx.driver.send('następna', undefined, undefined, { echo: 'e2' });
    await clock.advance(0);
    await waitFor(() => fx.events.some((e) => e.type === 'echo-dropped' && e.token === 'e1'), 'echo-dropped');
    expect(pasteFlow(fx)).toEqual(['paste:niewidoczny', 'paste:następna', 'enter']);
    const check = fx.driver.checkHeldLeftover?.([{ token: 'e1', text: 'niewidoczny' }], () => true) ?? null;
    await clock.advance(0);
    await expect(check).resolves.toEqual(new Map([['e1', 'empty']]));
  });

  it('przy `RAROG_PROMPT_BLOCK=0` driver nie trzyma tokenów `unseen`: pola po turze nikt nie czyta, więc nie rosną',
    async () => {
    const clock = drivenClock();
    const fx = await makeDriver({
      agent: { status: 'working' }, deps: { scheduler: clock.scheduler, promptFieldWaitMs: 100, promptBlock: false },
    });
    firstPasteUnseen(fx);
    fx.driver.send('niewidoczny', undefined, undefined, { echo: 'e1' });
    await clock.advance(5_000);
    expect(pasteFlow(fx)).toEqual(['paste:niewidoczny']);
    expect(fx.driver.checkHeldLeftover?.([{ token: 'e1', text: 'niewidoczny' }], () => true) ?? null).toBeNull();

    // Flaga jest stała dla procesu; przełączenie jej tutaj to jedyny sposób, żeby zobaczyć, czy driver zapisał token.
    fx.deps.promptBlock = true;
    const check = fx.driver.checkHeldLeftover?.([{ token: 'e1', text: 'niewidoczny' }], () => true) ?? null;
    await clock.advance(0);
    await expect(check).resolves.toEqual(new Map([['e1', 'empty']]));
  });
});

/*
 * herdr reports a turn started at the desk 1.6–2.0 s after the CLI registry says `busy` (measurement 0a after the
 * deployment, CLI 2.1.322). A message in that window goes the same paste queue as mid-turn, chosen by a fresh registry
 * read, not by the herdr status.
 */
describe('panel `idle` w herdr, rejestr CLI w turze: kolejka wklejeń (0a po pomiarze)', () => {
  type Signal = Awaited<ReturnType<NonNullable<HerdrDriverDeps['consentRegistryRead']>>>;
  const BUSY = { kind: 'active', busy: true } as const;
  const IDLE = { kind: 'active' } as const;
  const WAITING = { kind: 'waiting', dialog: 'permission' } as const;
  const echoRefused = (fx: Fixture): string[] => fx.events
    .filter((e): e is Extract<DriverEvent, { type: 'echo-refused' }> => e.type === 'echo-refused')
    .map((e) => e.token);
  const promptCalls = (fx: Fixture): { text: string | undefined; wait: boolean | undefined }[] => fx.client.calls
    .filter((c) => c.method === 'prompt')
    .map((c) => ({ text: c.text, wait: c.wait }));

  it('rejestr `busy`: wklejenie bez Entera, sprawdzenie i osobny Enter; `agent.prompt` niewołane', async () => {
    const clock = drivenClock();
    let registryReads = 0;
    const fx = await makeDriver({
      deps: {
        scheduler: clock.scheduler,
        consentRegistryRead: () => { registryReads += 1; return Promise.resolve(BUSY); },
      },
    });
    const pane = composerPane(fx);
    fx.driver.send('dopisek z telefonu', undefined, undefined, { echo: 'e1' });
    await clock.advance(0);
    expect(pasteFlow(fx)).toEqual(['paste:dopisek z telefonu', 'enter']);
    expect(promptCalls(fx)).toEqual([]);
    expect(fx.audit.map((entry) => [entry.method, entry.keys ?? entry.text])).toEqual([
      ['prompt', 'dopisek z telefonu'], ['send_keys', ['enter']],
    ]);
    // The path choice, then the queue's own checks: before the field read, right before the paste, before the Enter.
    expect(registryReads).toBe(4);
    expect(pane.submitted).toEqual(['dopisek z telefonu']);
    expect(echoRefused(fx)).toEqual([]);
  });

  it('rejestr `waiting`: wiadomość czeka w kolejce bez odmowy „dialog stoi” i idzie po dialogu', async () => {
    const clock = drivenClock();
    const logs: string[] = [];
    let registry: Signal = WAITING;
    const fx = await makeDriver({
      deps: {
        scheduler: clock.scheduler, logger: (line) => logs.push(line),
        consentRegistryRead: () => Promise.resolve(registry),
      },
    });
    const pane = composerPane(fx);
    pane.dialog = DIALOG_PERMISSION;
    pane.draw();
    fx.driver.send('po dialogu', undefined, undefined, { echo: 'e1' });
    await clock.advance(1_000);
    expect(pasteFlow(fx)).toEqual([]);
    expect(echoRefused(fx)).toEqual([]);
    expect(systemCodes(fx.events).filter((code) => code.startsWith('commands.send-'))).toEqual([]);
    expect(logs).toEqual([`send: message for pane ${PANE} waits (registry)`]);

    pane.dialog = null;
    pane.draw();
    registry = BUSY;
    await clock.advance(300);
    expect(pasteFlow(fx)).toEqual(['paste:po dialogu', 'enter']);
    expect(echoRefused(fx)).toEqual([]);
  });

  it.each([
    ['`idle`', (): Promise<Signal> => Promise.resolve(IDLE)],
    ['`unknown`', (): Promise<Signal> => Promise.resolve({ kind: 'unknown' })],
    ['błąd odczytu', (): Promise<Signal> => Promise.reject(new Error('EIO'))],
  ])('rejestr %s: `agent.prompt` ze stall-guardem jak dziś, bez wklejenia', async (_label, read) => {
    const clock = drivenClock();
    const fx = await makeDriver({ deps: { scheduler: clock.scheduler, consentRegistryRead: read } });
    fx.client.screenText = EMPTY_FIELD;
    fx.client.screenAnsi = EMPTY_FIELD;
    fx.driver.send('poza turą', undefined, undefined, { echo: 'e1' });
    await clock.advance(0);
    expect(pasteFlow(fx)).toEqual(['prompt:poza turą']);
    expect(promptCalls(fx)).toEqual([{ text: 'poza turą', wait: true }]);
  });

  it.each([
    ['`idle`', (): Promise<Signal> => Promise.resolve(IDLE)],
    ['`unknown`', (): Promise<Signal> => Promise.resolve({ kind: 'unknown' })],
    ['błąd odczytu', (): Promise<Signal> => Promise.reject(new Error('EIO'))],
  ])('herdr mówi `working` w trakcie odczytu rejestru, a odczyt daje %s: kolejka wklejeń, nie `agent.prompt`',
    async (_label, outcome) => {
      const clock = drivenClock();
      let release: () => void = () => undefined;
      let reads = 0;
      const fx = await makeDriver({
        deps: {
          scheduler: clock.scheduler,
          consentRegistryRead: () => {
            reads += 1;
            if (reads > 1) return Promise.resolve(BUSY);
            return new Promise<void>((resolve) => { release = resolve; }).then(outcome);
          },
        },
      });
      const pane = composerPane(fx);
      fx.driver.send('w wyścigu', undefined, undefined, { echo: 'e1' });
      await clock.advance(0);
      inTurn(fx);
      release();
      await clock.advance(0);
      expect(promptCalls(fx)).toEqual([]);
      expect(pasteFlow(fx)).toEqual(['paste:w wyścigu', 'enter']);
      expect(pane.submitted).toEqual(['w wyścigu']);
    });

  it('slash-komenda przy rejestrze `busy`: `agent.prompt` bez `wait`, jak dziś, bez odczytu rejestru', async () => {
    const clock = drivenClock();
    let registryReads = 0;
    const fx = await makeDriver({
      deps: {
        scheduler: clock.scheduler,
        consentRegistryRead: () => { registryReads += 1; return Promise.resolve(BUSY); },
      },
    });
    fx.client.screenText = EMPTY_FIELD;
    fx.client.screenAnsi = EMPTY_FIELD;
    fx.driver.send('/compact', undefined, undefined, commandOpts('/compact'));
    await clock.advance(0);
    expect(pasteFlow(fx)).toEqual(['prompt:/compact']);
    expect(promptCalls(fx)).toEqual([{ text: '/compact', wait: undefined }]);
    expect('wait' in (fx.client.calls.find((c) => c.method === 'prompt') ?? {})).toBe(false);
    expect(registryReads).toBe(0);
  });
});

describe('wklejenie na cudzy tekst w polu: echo gasi też wpis z polem po wklejeniu', () => {
  const enters = (fx: Fixture): number => fx.client.calls.filter((c) => c.method === 'prompt_submit').length;
  const echoRefused = (fx: Fixture): string[] => fx.events
    .filter((e): e is Extract<DriverEvent, { type: 'echo-refused' }> => e.type === 'echo-refused')
    .map((e) => e.token);
  const escapes = (fx: Fixture): number => fx.client.calls.filter((c) => c.method === 'send_keys').length;
  /** Wpis `user` z czasem TERAZ: follower bierze token tylko od wpisu nie starszego niż rejestracja echa. */
  const freshUserLine = (text: string): string => `${JSON.stringify({
    type: 'user', message: { role: 'user', content: text }, isSidechain: false,
    timestamp: new Date().toISOString(), sessionId: SESSION,
  })}\n`;
  /** Wpisy `user` z pliku rozmowy po historii: tekst i token echa, który follower do nich przypiął. */
  const fileUsers = (fx: Fixture): { text: string; echo: string | undefined }[] => fx.events
    .filter((e): e is Extract<DriverEvent, { type: 'message' }> => e.type === 'message' && e.role === 'user')
    .map((e) => ({
      text: e.blocks.map((b) => (b.type === 'text' && 'text' in b.text ? b.text.text : '')).join(''),
      echo: e.echoToken,
    }));
  /** Panel w turze z polem `draft`, wiadomość `text` z echem `e1` i Enter Raroga. */
  const sentOnto = async (draft: string, text: string): Promise<Fixture> => {
    const fx = await makeDriver({
      transcript: userLine('start'), agent: { status: 'working' }, deps: { promptRetryMs: 5 },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    const pane = composerPane(fx);
    pane.field = draft;
    pane.draw();
    fx.driver.send(text, undefined, undefined, { echo: 'e1' });
    await waitFor(() => enters(fx) === 1, 'Enter');
    expect(pane.submitted).toEqual([`${draft}${text}`]);
    return fx;
  };
  const entryArrives = async (fx: Fixture, text: string): Promise<string | undefined> => {
    await appendFile(fx.transcript, freshUserLine(text));
    await waitFor(() => fileUsers(fx).some((u) => u.text === text), `wpis ${text}`);
    return fileUsers(fx).find((u) => u.text === text)?.echo;
  };

  it('pole „t”, wiadomość „czy te”, wpis „tczy te”: echo zamknięte', async () => {
    const fx = await sentOnto('t', 'czy te');
    expect(await entryArrives(fx, 'tczy te')).toBe('e1');
    expect(echoRefused(fx)).toEqual([]);
  });

  it('pole puste, wiadomość „abc”, wpis „abc”: echo zamknięte jak dotąd', async () => {
    const fx = await sentOnto('', 'abc');
    expect(await entryArrives(fx, 'abc')).toBe('e1');
  });

  it('pole „t”, wiadomość „czy te”, wpis „czy te” (pole wyczyszczone przy Macu): echo zamknięte własnym tekstem',
    async () => {
      const fx = await sentOnto('t', 'czy te');
      expect(await entryArrives(fx, 'czy te')).toBe('e1');
    });

  it.each(['xczy te', 'tczy te dalej', 't'])('pole „t”, wiadomość „czy te”, wpis „%s”: echo NIE zamknięte',
    async (entry) => {
      const fx = await sentOnto('t', 'czy te');
      expect(await entryArrives(fx, entry)).toBeUndefined();
      // Echo dalej czeka na swój wpis.
      expect(await entryArrives(fx, 'tczy te')).toBe('e1');
    });

  it('blokada hooka zwraca do pola „tabc”: szkic „t” nie jest tekstem Raroga, następna wiadomość nie wysyła Esc',
    async () => {
      const fx = await sentOnto('t', 'abc');
      const pane = composerPane(fx);
      await appendFile(fx.transcript, blockedLine('tabc'));
      pane.field = 'tabc';
      pane.draw();
      await quiet();
      fx.driver.send('def', undefined, undefined, { echo: 'e2' });
      await waitFor(() => enters(fx) === 2, 'drugi Enter');
      expect(escapes(fx)).toBe(0);
      // `composerPane` is a new pane: its list holds only the Enter after it, the draft went with the second message.
      expect(pane.submitted).toEqual(['tabcdef']);
    });

  it('wiadomość ze ścieżką załącznika wklejona na „t”: wpis z polem po wklejeniu zamyka echo', async () => {
    const text = 'sprawdz /repo/.rarog-uploads/report.txt';
    const fx = await sentOnto('t', text);
    expect(await entryArrives(fx, `t${text}`)).toBe('e1');
  });

  it('dwie wiadomości, druga wklejona na cudzy tekst: każde echo zamyka tylko swój wpis', async () => {
    const fx = await makeDriver({
      transcript: userLine('start'), agent: { status: 'working' },
      deps: { promptRetryMs: 5, promptSubmitSettleMs: 30 },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    const pane = composerPane(fx);
    const submit = fx.client.sendPromptSubmit;
    fx.client.sendPromptSubmit = async (paneId) => {
      await submit(paneId);
      // Po Enterze pierwszej człowiek przy Macu wpisuje „t”, zanim pójdzie druga.
      if (pane.submitted.length === 1) {
        pane.field = 't';
        pane.draw();
      }
    };
    fx.driver.send('abc', undefined, undefined, { echo: 'e1' });
    fx.driver.send('czy te', undefined, undefined, { echo: 'e2' });
    await waitFor(() => enters(fx) === 2, 'dwa Entery');
    expect(pane.submitted).toEqual(['abc', 'tczy te']);
    expect(escapes(fx)).toBe(0);
    expect(await entryArrives(fx, 'tczy te')).toBe('e2');
    expect(await entryArrives(fx, 'abc')).toBe('e1');
  });
});
