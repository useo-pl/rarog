/**
 * Typowana fasada nad socketem: filtr wejściowy, kształt parametrów i mapowanie błędów.
 *
 * Kształty odpowiedzi biorą się z `fixtures/herdr/agent-list.json` (zrzut z żywego serwera),
 * a nie z wyobrażenia o API. Dwie asercje pilnują rzeczy, które kosztują ~380 ms albo cały
 * kanał wysyłki, jeśli ktoś je „poprawi": `agent.read` NIE wysyła `lines`, `agent.prompt`
 * NIE wysyła `wait`.
 */
import { describe, expect, it } from 'vitest';
import { foreign, isForeignText } from '@rarog/shared/sentences';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createHerdrClient, createHerdrLaunchClient, normalizeAgentInfo, normalizeCodexTitle,
  parseAgentList, parsePaneIds, parsePaneList, parseWorkspaceList,
} from '../src/herdr/client.ts';
import {
  HERDR_LAUNCH_READY_TIMEOUT_MS,
  HERDR_PROMPT_WAIT_MS, HERDR_START_REQUEST_TIMEOUT_MS, HERDR_START_WAIT_MS, RAROG_TERM_PANE_TOKEN,
} from '../src/config.ts';
import { HerdrRemoteError, REQUEST_TIMEOUT_MS } from '../src/herdr/socket.ts';
import { HERDR_NAME_PREFIX, claudePaneLabel, termPaneLabel } from '../src/herdr/provenance.ts';
import type { HerdrRequestOptions } from '../src/herdr/socket.ts';
import {
  HerdrBlockedError, HerdrError, HerdrGoneError, HerdrReadOnlyError, HerdrStalledError,
} from '../src/herdr/types.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'herdr');
const agentListFixture = JSON.parse(
  readFileSync(join(FIXTURES, 'agent-list.json'), 'utf8'),
) as { result: { type: string; agents: Record<string, unknown>[] } };

const rawAgents = agentListFixture.result.agents;

interface Call {
  method: string;
  params: Record<string, unknown>;
  /** Ustawienia POJEDYNCZEGO wywołania — dziś używa ich wyłącznie `agent.start`. */
  opts?: HerdrRequestOptions | undefined;
}

/** Atrapa transportu: zapamiętuje żądania i oddaje przygotowane wyniki. */
function fakeRequester(handler: (call: Call) => unknown): {
  calls: Call[];
  request: (
    m: string, p: Record<string, unknown>, o?: HerdrRequestOptions,
  ) => Promise<unknown>;
} {
  const calls: Call[] = [];
  return {
    calls,
    request(method, params, opts) {
      calls.push({ method, params, opts });
      try {
        return Promise.resolve(handler({ method, params }));
      } catch (err) {
        return Promise.reject(err);
      }
    },
  };
}

/**
 * Uuid sesji Codexa z pomiaru na herdr 0.9.0: prawdziwy UUID v7 z `agent_session.value`, czyli
 * wartość, która przechodzi `ENGINE_SESSION_ID_PATTERN` (nie trzeba jej syntetyzować).
 */
const CODEX_SESSION = '0198f0c4-1f2a-7c31-9a44-6f2b5d0e7a10';

/**
 * Wpis Codexa ZBUDOWANY z realnego wpisu Claude z fixture'a.
 *
 * README fixture'a zabrania dopisywać do `agent-list.json` rekordów, których na żywym serwerze
 * nie było — a Codexa tam nie było. Kształt bierze się z pomiaru na herdr 0.9.0:
 * `agent: 'codex'`, `agent_session.source: 'herdr:codex'` z uuid v7,
 * BRAK `interactive_ready` i `name`, `terminal_title_stripped` = `<prompt> | <katalog>`.
 */
function codexRaw(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...(rawAgents[0] as Record<string, unknown>),
    agent: 'codex',
    agent_session: {
      agent: 'codex', kind: 'id', source: 'herdr:codex', value: CODEX_SESSION,
    },
    terminal_title_stripped: 'Przeprojektuj aplikację | demo',
    ...patch,
  };
}

describe('normalizeAgentInfo — filtr wejściowy', () => {
  const sample = rawAgents[0] as Record<string, unknown>;

  it('normalizuje realny wpis z żywego serwera', () => {
    expect(normalizeAgentInfo(sample)).toEqual({
      paneId: 'w9:p72',
      tabId: 'w9:t1H',
      agentSessionId: 'e3759b2c-2275-565c-8f49-4e2707bb0231',
      cwd: '/Users/u/Projects/demo',
      status: 'idle',
      title: 'refaktor',
      stateChangeSeq: 23,
      // Silnik jest POLEM kontraktu, a Claude nigdy nie dostaje `termId` — karta
      // z transkryptem nie ma po co prowadzić do powłoki.
      engine: 'claude',
      termId: null,
      /*
       * Żywy `agent.list` NIE niesie ani `tokens`, ani `interactive_ready` (zmierzone
       * na 17 agentach). Domyślne wartości są dobrane po dwóch RÓŻNYCH stronach:
       * fail-closed dla WŁADZY (`launchedByRarog: false` → zostaje „Ukryj") i zachowawczo
       * dla ODCZYTU (`interactiveReady: true` → nie blokujemy wysyłki do paneli, do których
       * Rarog pisze).
       */
      launchedByRarog: false,
      interactiveReady: true,
    });
  });

  it('nazwa agenta `rarog-<6 hex>` włącza `launchedByRarog` bez żadnego tokenu', () => {
    expect(normalizeAgentInfo({ ...sample, name: 'rarog-abc123' })?.launchedByRarog).toBe(true);
    expect(normalizeAgentInfo({ ...sample, name: 'rarog-abc123', tokens: {} })?.launchedByRarog)
      .toBe(true);
  });

  it('nazwa spoza wzorca, brak nazwy i sam token `rarog` NIE dają własności', () => {
    for (const name of ['rarog-xyz', 'rarogx-abc123', 'rarog-abc1234', 'RAROG-abc123', null]) {
      expect(normalizeAgentInfo({ ...sample, name })?.launchedByRarog, String(name)).toBe(false);
    }
    // Tokenu własności nikt nie czyta — inaczej ręczny `claude` po `/exit`
    // dziedziczyłby chip.
    expect(normalizeAgentInfo({ ...sample, tokens: { [HERDR_NAME_PREFIX]: '1' } })?.launchedByRarog).toBe(false);
  });

  it('nazwa w złym typie nie wyrzuca agenta z listy — wpis zostaje, bez własności', () => {
    const info = normalizeAgentInfo({ ...sample, name: 42 });
    expect(info).not.toBeNull();
    expect(info?.launchedByRarog).toBe(false);
  });

  it('`interactive_ready: false` przechodzi wprost (panel jeszcze nie przyjmie promptu)', () => {
    expect(normalizeAgentInfo({ ...sample, interactive_ready: false })?.interactiveReady)
      .toBe(false);
  });

  it('bez flagi `RAROG_CODEX_STATUS` codex nie istnieje dla Raroga', () => {
    expect(normalizeAgentInfo(codexRaw())).toBeNull();
    expect(normalizeAgentInfo(codexRaw(), {})).toBeNull();
    expect(normalizeAgentInfo(codexRaw(), { codexStatus: false })).toBeNull();
  });

  it('odrzuca agenta spoza dwóch znanych silników — także z flagą', () => {
    // Flaga wpuszcza DOKŁADNIE codeksa. `future-agent` czy `aider` zostają poza Rarogiem:
    // nie znamy ani ich stopki, ani pliku treści, więc wiersz byłby obietnicą bez pokrycia.
    const obcy = { ...codexRaw(), agent: 'future-agent' };
    expect(normalizeAgentInfo(obcy, { codexStatus: true })).toBeNull();
    expect(normalizeAgentInfo({ ...sample, agent: null }, { codexStatus: true })).toBeNull();
  });

  it('odrzuca `agent_session.kind` inny niż `id`', () => {
    const session = { ...(sample['agent_session'] as object), kind: 'path' };
    expect(normalizeAgentInfo({ ...sample, agent_session: session })).toBeNull();
  });

  it('odrzuca sesję o wartości spoza ENGINE_SESSION_ID_PATTERN (granica traversalu)', () => {
    const session = { ...(sample['agent_session'] as object), value: '../../etc/passwd' };
    expect(normalizeAgentInfo({ ...sample, agent_session: session })).toBeNull();
  });

  it('odrzuca wpis bez `cwd` (nie ma jak sprawdzić zakresu ani znaleźć transkryptu)', () => {
    expect(normalizeAgentInfo({ ...sample, cwd: null })).toBeNull();
  });

  it('nieznany status → `unknown` (nigdy nie zgadujemy „skończył")', () => {
    expect(normalizeAgentInfo({ ...sample, agent_status: 'kompletnie-nowy' })?.status)
      .toBe('unknown');
  });

  it('brak `terminal_title_stripped` → pusty tytuł, brak `state_change_seq` → 0', () => {
    const info = normalizeAgentInfo({
      ...sample, terminal_title_stripped: null, state_change_seq: undefined,
    });
    expect(info).toMatchObject({ title: '', stateChangeSeq: 0 });
  });

  it('ignoruje nieznane pola odpowiedzi (herdr dokłada je addytywnie)', () => {
    expect(normalizeAgentInfo({ ...sample, cos_nowego: { a: 1 } })).not.toBeNull();
  });
});

describe('normalizeAgentInfo — wpis Codexa', () => {
  it('z flagą wchodzi jako `engine: codex`, zawsze niegotowy na wysyłkę', () => {
    expect(normalizeAgentInfo(codexRaw(), { codexStatus: true })).toEqual({
      paneId: 'w9:p72',
      tabId: 'w9:t1H',
      agentSessionId: CODEX_SESSION,
      engine: 'codex',
      // Panel bez tokenu `rarog-term` = Codex w zwykłym tabie herdr, bez wejścia do terminala.
      termId: null,
      cwd: '/Users/u/Projects/demo',
      status: 'idle',
      launchedByRarog: false,
      /*
       * `interactive_ready` w odpowiedzi dla Codexa NIE MA (to pole ma tylko Claude), a mimo
       * to wynik jest `false`, nie domyślne `true`: do wpisu Codexa Rarog nie wysyła niczego
       * żadnym kanałem, więc „gotowy na prompt" byłoby obietnicą, której nikt nie spełni.
       */
      interactiveReady: false,
      title: 'Przeprojektuj aplikację',
      stateChangeSeq: 23,
    });
  });

  it('zdejmuje spinner braille i sufiks katalogu — klatki nie zmieniają tytułu', () => {
    const klatki = ['⠴ ', '⠦ ', '⠇ '].map((spinner) => normalizeAgentInfo(
      codexRaw({ terminal_title_stripped: `${spinner}Przeprojektuj aplikację | demo` }),
      { codexStatus: true },
    )?.title);
    // Gdyby spinner szedł do kontraktu, każda migawka dawałaby `titleChanged` w nadzorcy.
    expect(new Set(klatki)).toEqual(new Set(['Przeprojektuj aplikację']));
  });

  it('tytuł równy nazwie katalogu (panel przed pierwszym promptem) → pusty string', () => {
    expect(normalizeAgentInfo(
      codexRaw({ terminal_title_stripped: 'demo' }), { codexStatus: true },
    )?.title).toBe('');
    // Etykietę z pustego tytułu robi manager (nazwa katalogu) — tą samą regułą co dla Claude.
    expect(normalizeAgentInfo(
      codexRaw({ terminal_title_stripped: '⠴ demo' }), { codexStatus: true },
    )?.title).toBe('');
  });

  it('sam `normalizeCodexTitle` jest odporny na brak katalogu i na goły prompt', () => {
    expect(normalizeCodexTitle('⠴ Napisz testy | birch', '/Users/u/Projects/birch'))
      .toBe('Napisz testy');
    // Sufiks zdejmujemy TYLKO wtedy, gdy to naprawdę nazwa tego katalogu.
    expect(normalizeCodexTitle('Napisz testy | cedar', '/Users/u/Projects/birch'))
      .toBe('Napisz testy | cedar');
    expect(normalizeCodexTitle('', '/Users/u/Projects/birch')).toBe('');
  });

  it('`termId` bierze się z tokenu `rarog-term`, ale tylko w kształcie `TERM_ID_RE`', () => {
    const dobry = codexRaw({ tokens: { 'rarog-term': '0123456789abcdef' } });
    expect(normalizeAgentInfo(dobry, { codexStatus: true })?.termId).toBe('0123456789abcdef');
    /*
     * Tokeny panelu może wpisać KTOKOLWIEK (`pane.report_metadata`), a z tej wartości powstaje
     * adres trasy `#/terminal/<id>` w PWA — dlatego bramka jest tu, a nie w widoku.
     */
    for (const zly of ['../../etc/passwd', 'ZZZZ456789abcdef', '0123456789abcde', '']) {
      expect(normalizeAgentInfo(
        codexRaw({ tokens: { 'rarog-term': zly } }), { codexStatus: true },
      )?.termId, zly).toBeNull();
    }
  });

  it('agent i token terminala pod przedrostkiem Raroga; obcy przedrostek tokenu nie daje `termId`', () => {
    const claude = { ...(rawAgents[0] as Record<string, unknown>) };
    expect(normalizeAgentInfo({ ...claude, name: `${HERDR_NAME_PREFIX}-abc123` })?.launchedByRarog).toBe(true);
    const tokens = { [`${HERDR_NAME_PREFIX}-term`]: '0123456789abcdef' };
    expect(normalizeAgentInfo(codexRaw({ tokens }), { codexStatus: true })?.termId).toBe('0123456789abcdef');
    expect(normalizeAgentInfo(codexRaw({ tokens: { 'inny-term': '0123456789abcdef' } }), { codexStatus: true })
      ?.termId).toBeNull();
  });

  it('Codex z nazwą `rarog-<6 hex>` NIE jest panelem Raroga (własność tylko dla Claude)', () => {
    expect(normalizeAgentInfo(codexRaw({ name: 'rarog-abc123' }), { codexStatus: true })
      ?.launchedByRarog).toBe(false);
  });

  it('Claude z tokenem `rarog-term` dostaje `termId` jak Codex', () => {
    const claude = { ...(rawAgents[0] as Record<string, unknown>) };
    const info = normalizeAgentInfo(
      { ...claude, tokens: { 'rarog-term': '0123456789abcdef' } }, { codexStatus: true },
    );
    expect(info).toMatchObject({ engine: 'claude', termId: '0123456789abcdef' });
    // Ta sama bramka kształtu co dla Codexa i ta sama odpowiedź bez tokenu.
    expect(normalizeAgentInfo({ ...claude, tokens: { 'rarog-term': '../../etc/passwd' } })?.termId)
      .toBeNull();
    expect(normalizeAgentInfo(claude)?.termId).toBeNull();
  });

  it('filtr sesji obowiązuje Codexa tak samo jak Claude', () => {
    const path = codexRaw({
      agent_session: {
        agent: 'codex', kind: 'path', source: 'herdr:codex', value: CODEX_SESSION,
      },
    });
    expect(normalizeAgentInfo(path, { codexStatus: true })).toBeNull();
    expect(normalizeAgentInfo(codexRaw({ cwd: null }), { codexStatus: true })).toBeNull();
  });
});

describe('parseAgentList', () => {
  it('przepuszcza wszystkie 17 realnych paneli z fixture', () => {
    const list = parseAgentList(agentListFixture.result);
    expect(list).toHaveLength(17);
    expect(list.map((a) => a.paneId)).toContain('wQ:p2');
  });

  it('wycina wpisy spoza zakresu integracji, zostawiając resztę', () => {
    const mixed = {
      type: 'agent_list',
      agents: [rawAgents[0], { ...rawAgents[1], agent: 'codex' }, rawAgents[2]],
    };
    expect(parseAgentList(mixed).map((a) => a.paneId)).toEqual(['w9:p72', 'w9:p5Q']);
  });

  it('lista mieszana z flagą: Claude i Codex obok siebie, `kind: path` dalej odpada', () => {
    const mixed = {
      type: 'agent_list',
      agents: [
        rawAgents[0],
        { ...codexRaw(), pane_id: 'w9:pCX', tab_id: 'w9:tCX' },
        {
          ...rawAgents[2],
          agent_session: { ...(rawAgents[2]?.['agent_session'] as object), kind: 'path' },
        },
      ],
    };
    expect(parseAgentList(mixed, { codexStatus: true }).map((a) => [a.paneId, a.engine]))
      .toEqual([['w9:p72', 'claude'], ['w9:pCX', 'codex']]);
    // Ta sama lista bez flagi: sam Claude.
    expect(parseAgentList(mixed).map((a) => a.paneId)).toEqual(['w9:p72']);
  });

  it('odpowiedź bez listy agentów → błąd, nie cicha pusta lista', () => {
    expect(() => parseAgentList({ type: 'agent_list' })).toThrow(HerdrError);
  });
});

describe('createHerdrClient — kształt żądań', () => {
  it('`agent.read` wysyła TYLKO `target` i `source` (bez `lines`)', async () => {
    const fake = fakeRequester(() => ({ type: 'pane_read', read: { text: 'ekran' } }));
    const client = createHerdrClient(fake);
    await expect(client.readScreen('w9:p72', 'visible')).resolves.toEqual({ text: 'ekran' });
    expect(fake.calls[0]).toEqual({
      method: 'agent.read',
      params: { target: 'w9:p72', source: 'visible' },
    });
    expect(Object.keys(fake.calls[0]!.params)).toEqual(['target', 'source']);
  });

  it('`agent.prompt` DOMYŚLNIE nie wysyła `wait` (slash-komendy dawałyby fałszywy stall)', async () => {
    const fake = fakeRequester(() => ({ type: 'agent_prompted', agent: {} }));
    await createHerdrClient(fake).prompt('w9:p72', '/status');
    expect(fake.calls[0]!.params).toEqual({ target: 'w9:p72', text: '/status' });
    expect('wait' in fake.calls[0]!.params).toBe(false);
  });

  it('`agent.prompt` z `wait` czeka na `working` w oknie krótszym niż timeout gniazda', async () => {
    const fake = fakeRequester(() => ({ type: 'agent_prompted', agent: {} }));
    await createHerdrClient(fake).prompt('w9:p72', 'napisz test', true);
    expect(fake.calls[0]!.params).toEqual({
      target: 'w9:p72',
      text: 'napisz test',
      wait: { timeout_ms: HERDR_PROMPT_WAIT_MS, until: ['working'] },
    });
    // Inaczej timeout socketu (5 s) ubiegnie odpowiedź herdr i stall wróci jako błąd transportu.
    expect(HERDR_PROMPT_WAIT_MS).toBeLessThan(REQUEST_TIMEOUT_MS);
  });

  it('`agent.send_keys` przechodzi przez allow-listę PRZED transportem', async () => {
    const fake = fakeRequester(() => ({ type: 'ok' }));
    const client = createHerdrClient(fake);

    await client.sendKeys('w9:p72', ['ctrl+c']);
    expect(fake.calls[0]!.params).toEqual({ target: 'w9:p72', keys: ['ctrl+c'] });

    await expect(client.sendKeys('w9:p72', ['escape', 'enter'])).rejects.toThrow();
    // Zły klawisz NIE dotknął transportu — nadal jedno wywołanie.
    expect(fake.calls).toHaveLength(1);
  });

  it('`sendTrustStep`: jedno `agent.send_keys` z dokładnie `[down]` albo `[enter]`', async () => {
    const fake = fakeRequester(() => ({ type: 'ok' }));
    const client = createHerdrClient(fake);

    await client.sendTrustStep('w9:p72', 'down');
    await client.sendTrustStep('w9:p72', 'enter');
    expect(fake.calls.map((call) => [call.method, call.params])).toEqual([
      ['agent.send_keys', { target: 'w9:p72', keys: ['down'] }],
      ['agent.send_keys', { target: 'w9:p72', keys: ['enter'] }],
    ]);
  });

  it('`sendTrustStep` odrzuca klawisz spoza ścieżki zaufania, zanim dotknie gniazda', async () => {
    const fake = fakeRequester(() => ({ type: 'ok' }));
    const client = createHerdrClient(fake);
    for (const key of ['escape', 'up', '2', 'ctrl+c']) {
      await expect(client.sendTrustStep('w9:p72', key as 'down')).rejects.toThrow();
    }
    expect(fake.calls).toHaveLength(0);
  });

  it('`sendKeys` dalej nie przepuszcza `down` ani `enter` (ALLOWED_KEYS bez zmian)', async () => {
    const fake = fakeRequester(() => ({ type: 'ok' }));
    const client = createHerdrClient(fake);
    await expect(client.sendKeys('w9:p72', ['down'])).rejects.toThrow();
    await expect(client.sendKeys('w9:p72', ['enter'])).rejects.toThrow();
    expect(fake.calls).toHaveLength(0);
  });

  it('`agent.get` normalizuje wpis, a panel bez znanego agenta znaczy „zniknął"', async () => {
    const good = fakeRequester(() => ({ type: 'agent_info', agent: rawAgents[0] }));
    await expect(createHerdrClient(good).getAgent('w9:p72')).resolves.toMatchObject({
      paneId: 'w9:p72', status: 'idle', engine: 'claude',
    });

    const gone = fakeRequester(() => ({
      type: 'agent_info', agent: { ...rawAgents[0], agent: 'future-agent' },
    }));
    await expect(createHerdrClient(gone).getAgent('w9:p72')).rejects.toBeInstanceOf(
      HerdrGoneError,
    );
  });

  it('`agent.get` filtruje TĄ SAMĄ bramką co `agent.list` — to jest ścieżka pushu', async () => {
    /*
     * Push `pane.agent_status_changed` nie niesie ani sesji, ani `state_change_seq`, więc
     * nadzorca i tak pyta `agent.get`. Gdyby flaga jechała tylko do `agent.list`, panel Codexa
     * wchodziłby resyncem, a przy każdej zmianie stanu wracał jako `HerdrGoneError` — karta
     * migałaby raz po raz. Dlatego flaga jest polem FASADY.
     */
    const raw = { ...codexRaw(), tokens: { 'rarog-term': 'abcdef0123456789' } };
    const wlaczone = fakeRequester(() => ({ type: 'agent_info', agent: raw }));
    await expect(createHerdrClient(wlaczone, { codexStatus: true }).getAgent('w9:p72'))
      .resolves.toMatchObject({
        engine: 'codex',
        termId: 'abcdef0123456789',
        interactiveReady: false,
        title: 'Przeprojektuj aplikację',
      });

    const wylaczone = fakeRequester(() => ({ type: 'agent_info', agent: raw }));
    await expect(createHerdrClient(wylaczone).getAgent('w9:p72'))
      .rejects.toBeInstanceOf(HerdrGoneError);
  });

  it('`ping` zwraca wersję i protokół', async () => {
    const fake = fakeRequester(() => ({ type: 'pong', version: '0.8.2', protocol: 20 }));
    await expect(createHerdrClient(fake).ping()).resolves.toEqual({
      version: '0.8.2', protocol: 20,
    });
  });
});

describe('createHerdrClient — mapowanie kodów błędów', () => {
  const CASES: readonly [string, new (...args: never[]) => Error][] = [
    ['agent_blocked', HerdrBlockedError],
    ['agent_prompt_stalled', HerdrStalledError],
    ['agent_not_running', HerdrGoneError],
    ['pane_not_found', HerdrGoneError],
    ['agent_not_ready', HerdrGoneError],
    // `--resume <nieistniejący uuid>` kończy `claude` w ~1–2 s i panel wraca do powłoki.
    // Bez tej gałęzi launcher czekałby 20 s na gotowość agenta, którego już nie ma.
    ['agent_not_found', HerdrGoneError],
    ['feature_disabled', HerdrReadOnlyError],
    ['internal_error', HerdrError],
    ['invalid_request', HerdrError],
  ];

  for (const [code, expected] of CASES) {
    it(`${code} → ${expected.name}`, async () => {
      const fake = fakeRequester(() => {
        throw new HerdrRemoteError(code, foreign(`herdr mówi ${code}`));
      });
      await expect(createHerdrClient(fake).prompt('w9:p72', 'x')).rejects.toBeInstanceOf(expected);
    });
  }

  it('treść ramki `error` herdr przechodzi przez mapowanie jako tekst obcy, z tym samym brzmieniem', async () => {
    const gone = fakeRequester(() => {
      throw new HerdrRemoteError('pane_not_found', foreign('pane w9:p72 not found'));
    });
    const err: unknown = await createHerdrClient(gone).prompt('w9:p72', 'x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HerdrGoneError);
    expect(isForeignText((err as HerdrGoneError).sentence)).toBe(true);
    expect((err as HerdrGoneError).message).toBe('pane w9:p72 not found');

    const other = fakeRequester(() => {
      throw new HerdrRemoteError('invalid_request', foreign('bad params'));
    });
    const wrapped: unknown = await createHerdrClient(other).prompt('w9:p72', 'x').catch((e: unknown) => e);
    expect(wrapped).toBeInstanceOf(HerdrRemoteError);
    expect(isForeignText((wrapped as HerdrRemoteError).sentence)).toBe(true);
    expect((wrapped as HerdrRemoteError).message).toBe('herdr: bad params');
  });

  it('timeout `wait` po TREŚCI → HerdrStalledError — herdr 0.8.2 nie daje tu kodu stalla', async () => {
    // Zmierzone na żywo (herdr 0.8.2): timeout czekania na status ma inny kod niż `agent_prompt_stalled` — bez
    // mapowania po treści stall-guard nie widziałby stalla i użytkownik dostałby surowy błąd zamiast ponowienia.
    const fake = fakeRequester(() => {
      throw new HerdrRemoteError('internal_error', foreign('timed out waiting for agent status'));
    });
    await expect(createHerdrClient(fake).prompt('w9:p72', 'x', true))
      .rejects.toBeInstanceOf(HerdrStalledError);
  });

  it('stall z TREŚCI jest oznaczony `stallSource` — połykać wolno tylko ten z kodu', async () => {
    /*
     * Rozróżnienie jest treścią, nie metadaną: gałąź tekstowa łapie DOWOLNY nieznany kod,
     * a driver połyka stalla przy Esc jako sukces. Bez znacznika nieznana awaria z takim
     * brzmieniem zamieniała się w fałszywe „Tura przerwana" i trwały wpis w transkrypcie.
     */
    const byText = fakeRequester(() => {
      throw new HerdrRemoteError('internal_error', foreign('timed out waiting for agent status'));
    });
    await expect(createHerdrClient(byText).prompt('w9:p72', 'x', true))
      .rejects.toMatchObject({ code: 'herdr-stalled', stallSource: 'message' });

    const byCode = fakeRequester(() => {
      throw new HerdrRemoteError('agent_prompt_stalled', foreign('timed out waiting for agent status'));
    });
    await expect(createHerdrClient(byCode).prompt('w9:p72', 'x', true))
      .rejects.toMatchObject({ code: 'herdr-stalled', stallSource: 'remote-code' });
  });

  it('błąd transportu (nie `error` z herdr) przechodzi bez zmiany klasy', async () => {
    const boom = new Error('gniazdo padło');
    const fake = fakeRequester(() => {
      throw boom;
    });
    await expect(createHerdrClient(fake).listAgents()).rejects.toBe(boom);
  });
});

describe('createHerdrLaunchClient — `agent.start` i jego dwa zegary', () => {
  const params = {
    name: 'rarog-abc', kind: 'claude', paneId: 'w9:p9', args: ['--session-id', 'x'],
  };

  it('podaje `timeout_ms` herdr i PODNOSI sufit gniazda dla tego wywołania', async () => {
    /*
     * Rozjazd, który to naprawia, był najgroźniejszy z całej warstwy transportowej:
     * `timeout_ms` nie szło NIGDY (nikt nie podawał `timeoutMs`), więc jedynym zegarem był
     * globalny sufit gniazda 5 s. Start dłuższy niż 5 s wracał jako timeout TRANSPORTU —
     * czyli „nie wiem, co się stało" — a launcher zamykał na tej podstawie tab z agentem,
     * który właśnie wstał. Nierówność `wait < sufit gniazda` jest tu kontraktem, dokładnie
     * jak przy `HERDR_PROMPT_WAIT_MS`.
     */
    const fake = fakeRequester(() => ({ agent_started: { argv: ['claude'] } }));
    await createHerdrLaunchClient(fake).startAgent(params);

    const call = fake.calls[0]!;
    expect(call.method).toBe('agent.start');
    expect(call.params['timeout_ms']).toBe(HERDR_START_WAIT_MS);
    expect(call.opts?.timeoutMs).toBe(HERDR_START_REQUEST_TIMEOUT_MS);
    expect(HERDR_START_WAIT_MS).toBeLessThan(HERDR_START_REQUEST_TIMEOUT_MS);
    // Okno startu = okno czekania na gotowość (herdr 0.9.0 porzuca rekord startu po
    // `timeout_ms`, a launcher czeka `HERDR_LAUNCH_READY_TIMEOUT_MS`).
    expect(HERDR_START_WAIT_MS).toBe(HERDR_LAUNCH_READY_TIMEOUT_MS);
    expect(HERDR_START_WAIT_MS).toBeLessThanOrEqual(300_000);
    // …i sufit tego wywołania jest większy niż globalny, bo o to w naprawie chodzi.
    expect(HERDR_START_REQUEST_TIMEOUT_MS).toBeGreaterThan(REQUEST_TIMEOUT_MS);
  });

  it('jawne `timeoutMs` wołającego wygrywa z domyślnikiem', async () => {
    const fake = fakeRequester(() => ({ argv: [] }));
    await createHerdrLaunchClient(fake).startAgent({ ...params, timeoutMs: 1_000 });
    expect(fake.calls[0]?.params['timeout_ms']).toBe(1_000);
  });
});

describe('`pane.list` — etykieta panelu', () => {
  const row = {
    pane_id: 'w9:p9', tab_id: 'w9:t9', workspace_id: 'w9', cwd: '/Users/u/Projects/atlas',
  };

  it('`label` przechodzi do `HerdrPaneInfo`; brak pola i `null` → `null`', () => {
    const label = claudePaneLabel('0123456789abcdef', '89abcdef');
    expect(parsePaneList({ panes: [{ ...row, label }] })[0]?.label).toBe(label);
    expect(parsePaneList({ panes: [row] })[0]?.label).toBeNull();
    expect(parsePaneList({ panes: [{ ...row, label: null }] })[0]?.label).toBeNull();
  });

  it('etykieta w złym typie nie wyrzuca panelu z listy — zostaje bez etykiety', () => {
    const panes = parsePaneList({ panes: [{ ...row, label: 42 }] });
    expect(panes).toHaveLength(1);
    expect(panes[0]?.label).toBeNull();
  });
});

describe('`pane.list` — panel nieodtworzony (`restore_error`, herdr 0.9.4)', () => {
  const row = {
    pane_id: 'w9:p9', tab_id: 'w9:t9', workspace_id: 'w9', cwd: '/Users/u/Projects/usuniety-worktree',
    label: termPaneLabel('0123456789abcdef'), tokens: { [RAROG_TERM_PANE_TOKEN]: '0123456789abcdef' },
  };
  const restoreError = 'Saved directory is unavailable. Restore the directory and restart this session.';

  it('panel z `restore_error` znika z listy przydatnych, ale zostaje w inwentarzu obecności', () => {
    const result = { panes: [{ ...row, restore_error: restoreError }] };
    expect(parsePaneList(result)).toEqual([]);
    expect(parsePaneIds(result)).toEqual(new Set(['w9:p9']));
  });

  it('`null`, pusty napis, brak pola i obcy typ = panel żywy', () => {
    for (const restore of [null, '', undefined, 42]) {
      expect(parsePaneList({ panes: [{ ...row, restore_error: restore }] })).toHaveLength(1);
    }
  });
});

describe('createHerdrLaunchClient — `pane.rename` i `tab.rename`', () => {
  it('`renamePane` wysyła `pane.rename {pane_id, label}`; `null` zdejmuje etykietę', async () => {
    const fake = fakeRequester(() => ({ type: 'pane_info', pane: {} }));
    const client = createHerdrLaunchClient(fake);
    await client.renamePane('w9:p9', termPaneLabel('0123456789abcdef'));
    await client.renamePane('w9:p9', null);
    expect(fake.calls.map((call) => [call.method, call.params])).toEqual([
      ['pane.rename', { pane_id: 'w9:p9', label: termPaneLabel('0123456789abcdef') }],
      ['pane.rename', { pane_id: 'w9:p9', label: null }],
    ]);
  });

  it('`renameTab` wysyła `tab.rename {tab_id, label}`', async () => {
    const fake = fakeRequester(() => ({ type: 'tab_info', tab: {} }));
    await createHerdrLaunchClient(fake).renameTab('w9:t9', 'atlas');
    expect(fake.calls.map((call) => [call.method, call.params])).toEqual([
      ['tab.rename', { tab_id: 'w9:t9', label: 'atlas' }],
    ]);
  });

  it('pusty adres, pusta etykieta i znaki sterujące odpadają ZANIM cokolwiek pójdzie do gniazda',
    async () => {
      /*
       * herdr NIE normalizuje etykiet (zmierzone: ESC, `\n`, pusty napis i same
       * spacje przyjęte i zapisane do snapshotu) — więc ostatnia bramka stoi tutaj, na
       * granicy gniazda. Zdjęcie etykiety panelu to jawne `null`, nie pusty napis.
       */
      const fake = fakeRequester(() => ({}));
      const client = createHerdrLaunchClient(fake);
      await expect(client.renamePane('', 'x')).rejects.toBeInstanceOf(HerdrError);
      await expect(client.renameTab('', 'x')).rejects.toBeInstanceOf(HerdrError);
      for (const label of ['', '   ', 'a\u001bb', 'a\nb', 'a\u0007', 'a\u009bb']) {
        await expect(client.renamePane('w9:p9', label), JSON.stringify(label))
          .rejects.toBeInstanceOf(HerdrError);
        await expect(client.renameTab('w9:t9', label), JSON.stringify(label))
          .rejects.toBeInstanceOf(HerdrError);
      }
      expect(fake.calls).toEqual([]);
    });

  it('`getTab` czyta `tab.get` (`TabInfo` z herdr 0.9.3) — etykieta, liczba paneli, workspace', async () => {
    const fake = fakeRequester(() => ({
      type: 'tab_info',
      tab: {
        tab_id: 'w9:t9', workspace_id: 'w9', number: 2, label: 'atlas', focused: false,
        pane_count: 1, agent_status: 'idle',
      },
    }));
    await expect(createHerdrLaunchClient(fake).getTab('w9:t9')).resolves.toEqual({
      tabId: 'w9:t9', label: 'atlas', paneCount: 1, workspaceId: 'w9',
    });
    expect(fake.calls.map((call) => [call.method, call.params])).toEqual([
      ['tab.get', { tab_id: 'w9:t9' }],
    ]);
  });

  it('`getTab`: pusty adres nie dotyka gniazda, odpowiedź bez etykiety albo liczby paneli rzuca',
    async () => {
      // Tab z odczytem, któremu nie da się ufać, nie dostaje nowej nazwy — rzut, nie „pusto".
      const empty = fakeRequester(() => ({}));
      await expect(createHerdrLaunchClient(empty).getTab('')).rejects.toBeInstanceOf(HerdrError);
      expect(empty.calls).toEqual([]);
      for (const tab of [
        { tab_id: 'w9:t9', workspace_id: 'w9', pane_count: 1 },
        { tab_id: 'w9:t9', workspace_id: 'w9', label: 'atlas' },
        { tab_id: 'w9:t9', workspace_id: 'w9', label: 'atlas', pane_count: -1 },
      ]) {
        const fake = fakeRequester(() => ({ type: 'tab_info', tab }));
        await expect(createHerdrLaunchClient(fake).getTab('w9:t9'), JSON.stringify(tab))
          .rejects.toBeInstanceOf(HerdrError);
      }
    });

  it('`reportPaneMetadata` bez tokenów nie wysyła pola `tokens` ani `ttl_ms`', async () => {
    // Stempel panelu Claude niesie sam tytuł — własność mówi nazwa agenta, pochodzenie
    // etykieta panelu; tokenu `rarog` (z TTL) nie ma.
    const fake = fakeRequester(() => ({}));
    await createHerdrLaunchClient(fake).reportPaneMetadata({
      paneId: 'w9:p9', source: 'rarog', title: 'atlas',
    });
    expect(fake.calls[0]?.params).toEqual({ pane_id: 'w9:p9', source: 'rarog', title: 'atlas' });
  });
});

describe('createHerdrLaunchClient — `pane.layout` (rozmiar panelu terminala przed zwolnieniem)', () => {
  /** Kształt z żywego herdr 0.9.5 (`herdr pane layout --pane w56:p1`, panel pomiarowy). */
  const layoutResult = (panes: unknown[]): unknown => ({
    type: 'pane_layout',
    layout: {
      area: { height: 52, width: 128, x: 0, y: 0 },
      focused_pane_id: 'w56:p1',
      panes,
      splits: [],
      tab_id: 'w56:t1',
      workspace_id: 'w56',
      zoomed: false,
    },
  });

  it('wysyła `pane.layout {pane_id}` i oddaje WYŁĄCZNIE id i wymiary paneli', async () => {
    const fake = fakeRequester(() => layoutResult([
      { focused: true, pane_id: 'w56:p1', rect: { height: 52, width: 128, x: 0, y: 0 } },
    ]));
    await expect(createHerdrLaunchClient(fake).readPaneLayout?.('w56:p1')).resolves.toEqual({
      panes: [{ paneId: 'w56:p1', width: 128, height: 52 }],
    });
    expect(fake.calls.map((call) => [call.method, call.params])).toEqual([
      ['pane.layout', { pane_id: 'w56:p1' }],
    ]);
  });

  it('pusty adres nie dotyka gniazda; brak układu albo JEDEN wpis w obcym kształcie rzuca', async () => {
    const empty = fakeRequester(() => ({}));
    await expect(createHerdrLaunchClient(empty).readPaneLayout?.('')).rejects.toBeInstanceOf(HerdrError);
    expect(empty.calls).toEqual([]);
    const good = { pane_id: 'w56:p1', rect: { height: 26, width: 64 } };
    for (const result of [
      { type: 'pane_layout' },
      { type: 'pane_layout', layout: {} },
      // Zgubiony wpis zrobiłby z taba z podziałem tab jednopanelowy — cała odpowiedź odpada.
      layoutResult([good, { pane_id: 'w56:p2', rect: { width: 64 } }]),
      layoutResult([good, { pane_id: 'w56:p2', rect: { height: 26, width: -1 } }]),
      layoutResult([good, { rect: { height: 26, width: 64 } }]),
    ]) {
      const fake = fakeRequester(() => result);
      await expect(createHerdrLaunchClient(fake).readPaneLayout?.('w56:p1'), JSON.stringify(result))
        .rejects.toBeInstanceOf(HerdrError);
    }
  });
});

describe('createHerdrLaunchClient — `workspace.list` (resolver workspace\'u projektu)', () => {
  it('etykieta i ścieżki checkoutu; `worktree` tylko tam, gdzie herdr go zna', async () => {
    // Kształt z żywego herdr 0.9.3 (`workspace list`): `worktree` ma 1 z 10.
    const fake = fakeRequester(() => ({
      type: 'workspace_list',
      workspaces: [
        { workspace_id: 'w9', number: 1, label: 'atlas', focused: false, pane_count: 11,
          tab_count: 11, active_tab_id: 'w9:t43', agent_status: 'idle' },
        { workspace_id: 'wQ', number: 5, label: 'rarog', focused: true, pane_count: 8,
          tab_count: 8, active_tab_id: 'wQ:tBW', agent_status: 'working', tokens: { vpn: 'x' },
          worktree: {
            checkout_path: '/Users/u/Projects/ACME/rarog', is_linked_worktree: false,
            repo_key: '/Users/u/Projects/ACME/rarog/.git', repo_name: 'rarog',
            repo_root: '/Users/u/Projects/ACME/rarog',
          } },
        { workspace_id: 'w2Z', number: 10, label: 'ERWU', worktree: null },
      ],
    }));
    await expect(createHerdrLaunchClient(fake).listWorkspaces()).resolves.toEqual([
      { workspaceId: 'w9', label: 'atlas' },
      { workspaceId: 'wQ', label: 'rarog', checkoutPath: '/Users/u/Projects/ACME/rarog',
        repoRoot: '/Users/u/Projects/ACME/rarog' },
      { workspaceId: 'w2Z', label: 'ERWU' },
    ]);
    expect(fake.calls.map((call) => [call.method, call.params])).toEqual([['workspace.list', {}]]);
  });

  it('wpis bez id albo etykiety odpada, zły typ ścieżki = „nie znamy", odpowiedź bez listy rzuca',
    async () => {
      // Odpadnięty workspace nie jest kandydatem — skutkiem jest co najwyżej NOWY workspace,
      // nigdy tab w cudzym.
      expect(parseWorkspaceList({ workspaces: [
        { label: 'bez-id' }, { workspace_id: 'w1' }, 'śmieć',
        { workspace_id: 'w2', label: 'api', worktree: { checkout_path: 7, repo_root: '' } },
      ] })).toEqual([{ workspaceId: 'w2', label: 'api' }]);
      expect(() => parseWorkspaceList({ type: 'workspace_list' })).toThrow(HerdrError);
    });
});

describe('createHerdrLaunchClient — `pane.read` (historia terminala do zaznaczenia)', () => {
  /** Odpowiedź `pane.read` w kształcie protokołu 20: `{ read: PaneReadResult }`. */
  const answer = (text: string, truncated: boolean): Record<string, unknown> => ({
    type: 'pane_read',
    read: {
      pane_id: 'w9:p9', workspace_id: 'w9', tab_id: 'w9:t1',
      source: 'recent_unwrapped', format: 'text', revision: 7, text, truncated,
    },
  });

  it('wysyła DOKŁADNIE `recent_unwrapped`, `strip_ansi` i `format: text`', async () => {
    /*
     * Nazwa źródła jest wersją PROTOKOŁU (podkreślnik), a nie tą z CLI (`recent-unwrapped`
     * z dywizem) — pomyłka kosztuje `invalid_request` na gnieździe i pustą nakładkę
     * w telefonie. `strip_ansi` i `format` jadą jawnie, bo historia ląduje w `<pre>`:
     * sekwencje ESC byłyby tam śmieciem do zaznaczenia.
     */
    const fake = fakeRequester(() => answer('linia\n', false));
    await createHerdrLaunchClient(fake).readPaneHistory('w9:p9', 1_000);

    const call = fake.calls[0]!;
    expect(call.method).toBe('pane.read');
    expect(call.params).toEqual({
      pane_id: 'w9:p9',
      source: 'recent_unwrapped',
      lines: 1_000,
      strip_ansi: true,
      format: 'text',
    });
  });

  it('oddaje `text` i `truncated`, ignorując resztę pól odpowiedzi', async () => {
    const fake = fakeRequester(() => answer('a\nb\n', true));
    expect(await createHerdrLaunchClient(fake).readPaneHistory('w9:p9', 10))
      .toEqual({ text: 'a\nb\n', truncated: true });
  });

  it('odpowiedź BEZ `truncated` to błąd kształtu, nie ciche `false`', async () => {
    // Ciche `false` skłamałoby stopce nakładki („widzisz całość"), a to jedyne zdanie,
    // po którym człowiek wie, czy czegoś nie brakuje.
    const fake = fakeRequester(() => ({ read: { text: 'a' } }));
    await expect(createHerdrLaunchClient(fake).readPaneHistory('w9:p9', 10))
      .rejects.toBeInstanceOf(HerdrError);
  });

  it('pusty `pane_id` nie dotyka gniazda', async () => {
    const fake = fakeRequester(() => answer('', false));
    await expect(createHerdrLaunchClient(fake).readPaneHistory('', 10))
      .rejects.toBeInstanceOf(HerdrError);
    expect(fake.calls).toEqual([]);
  });
});

describe('createHerdrLaunchClient — `pane.process_info` (nazwa procesu na etykiecie taba)', () => {
  /**
   * Odpowiedź w kształcie protokołu 20, zrzucona z żywego herdr: panel z codeksem
   * ma DWA procesy pierwszego planu, a ten o `pid == foreground_process_group_id` jest tym
   * MNIEJ informatywnym (`node`).
   */
  const answer = (processes: readonly Record<string, unknown>[]): Record<string, unknown> => ({
    type: 'pane_process_info',
    process_info: {
      pane_id: 'w9:p9', shell_pid: 43_308, tty: '/dev/ttys012',
      foreground_process_group_id: 51_069,
      foreground_processes: processes,
    },
  });

  it('wysyła sam `pane_id` i oddaje procesy w KOLEJNOŚCI od herdr', async () => {
    const fake = fakeRequester(() => answer([
      { pid: 51_073, name: 'codex', argv0: 'codex', cmdline: '/…/bin/codex', cwd: '/p' },
      { pid: 51_069, name: 'node', argv0: 'node', cmdline: 'node /…/codex', cwd: '/p' },
    ]));

    const info = await createHerdrLaunchClient(fake).readPaneProcess('w9:p9');

    expect(fake.calls[0]?.method).toBe('pane.process_info');
    expect(fake.calls[0]?.params).toEqual({ pane_id: 'w9:p9' });
    expect(info.processes.map((proc) => proc.name)).toEqual(['codex', 'node']);
  });

  /*
   * ZAWĘŻENIE do trzech pól jest granicą, nie estetyką: `argv`, `cmdline` i `cwd` bywają całą
   * linią polecenia (`psql "postgres://user:haslo@host"`), a Rarogowi potrzebne jest JEDNO
   * słowo na pigułkę. Fasada ma nie wpuścić reszty do serwera w ogóle.
   */
  it('nie przepuszcza `argv`, `cmdline` ani `cwd`', async () => {
    const fake = fakeRequester(() => answer([{
      pid: 1, name: 'psql', argv0: 'psql',
      argv: ['psql', 'postgres://user:HASLO@host'],
      cmdline: 'psql postgres://user:HASLO@host',
      cwd: '/Users/x/tajne',
    }]));

    const info = await createHerdrLaunchClient(fake).readPaneProcess('w9:p9');

    expect(info.processes).toEqual([{ pid: 1, name: 'psql', argv0: 'psql' }]);
    expect(JSON.stringify(info)).not.toContain('HASLO');
  });

  it('`argv0: null` schodzi do pustego stringu (pole jest nullowalne w schemacie)', async () => {
    const fake = fakeRequester(() => answer([{ pid: 7, name: 'nvim', argv0: null }]));
    expect((await createHerdrLaunchClient(fake).readPaneProcess('w9:p9')).processes)
      .toEqual([{ pid: 7, name: 'nvim', argv0: '' }]);
  });

  it('brak `foreground_processes` to PUSTA lista, nie błąd', async () => {
    // Powłoka bez procesu na pierwszym planie jest normalna — wołający zamienia to na `zsh`.
    const fake = fakeRequester(() => ({ type: 'pane_process_info', process_info: {} }));
    expect((await createHerdrLaunchClient(fake).readPaneProcess('w9:p9')).processes).toEqual([]);
  });

  it('odpowiedź w nieznanym kształcie to `HerdrError`', async () => {
    const fake = fakeRequester(() => ({ type: 'pane_process_info' }));
    await expect(createHerdrLaunchClient(fake).readPaneProcess('w9:p9'))
      .rejects.toBeInstanceOf(HerdrError);
  });

  it('pusty `pane_id` nie dotyka gniazda', async () => {
    const fake = fakeRequester(() => answer([]));
    await expect(createHerdrLaunchClient(fake).readPaneProcess(''))
      .rejects.toBeInstanceOf(HerdrError);
    expect(fake.calls).toEqual([]);
  });
});

describe('createHerdrClient — wiersze panelu do wpisu `degrade` (`pane.list`)', () => {
  /*
   * Kształt z żywego `herdr pane list` (herdr 0.9.5): każdy wpis niesie `scroll`
   * z `viewport_rows`. Panel 62×29 z incydentu ma 28 wierszy widoku; prostokąt `pane.layout` tego
   * samego panelu mówił 128×52, bo opisuje układ taba — dlatego geometria NIE idzie z `pane.layout`.
   */
  const pane = (id: string, scroll: unknown): Record<string, unknown> => ({
    pane_id: id, tab_id: 'wQ:t1', workspace_id: 'wQ', terminal_id: 'term-1', focused: false,
    agent_status: 'blocked', revision: 3, cwd: '/Users/x/tajne', terminal_title: 'tytuł z treścią', scroll,
  });
  const answer = (panes: readonly Record<string, unknown>[]): Record<string, unknown> => ({ type: 'pane_list', panes });

  it('pyta `pane.list` ze ZWYKŁYM sufitem gniazda i oddaje `viewport_rows` WŁASNEGO panelu', async () => {
    const fake = fakeRequester(() => answer([
      pane('wQ:pJ8', { offset_from_bottom: 0, max_offset_from_bottom: 0, viewport_rows: 52 }),
      pane('wQ:pJ9', { offset_from_bottom: 0, max_offset_from_bottom: 12, viewport_rows: 28 }),
    ]));

    const client = createHerdrClient(fake);
    expect(await client.readPaneRows?.('wQ:pJ9')).toBe(28);
    // Bez własnego `timeoutMs`: krótszy sufit gniazda oznaczałby herdr jako niedostępny (status gniazda,
    // `canLaunch`) z powodu samej diagnostyki — budżet czekania trzyma driver.
    expect(fake.calls).toEqual([{ method: 'pane.list', params: {}, opts: undefined }]);
  });

  it('brak panelu, `scroll: null` albo obcy kształt to `HerdrError` — nigdy liczba zgadnięta', async () => {
    const client = (result: unknown) => createHerdrClient(fakeRequester(() => result));
    await expect(client(answer([pane('wQ:pJ8', { viewport_rows: 52 })])).readPaneRows?.('wQ:pJ9'))
      .rejects.toBeInstanceOf(HerdrError);
    await expect(client(answer([pane('wQ:pJ9', null)])).readPaneRows?.('wQ:pJ9'))
      .rejects.toBeInstanceOf(HerdrError);
    await expect(client({ type: 'pane_list' }).readPaneRows?.('wQ:pJ9'))
      .rejects.toBeInstanceOf(HerdrError);
  });

  it('pusty `pane_id` nie dotyka gniazda', async () => {
    const fake = fakeRequester(() => answer([]));
    await expect(createHerdrClient(fake).readPaneRows?.('')).rejects.toBeInstanceOf(HerdrError);
    expect(fake.calls).toEqual([]);
  });
});

describe('createHerdrLaunchClient — sonda gotowości (`probeAgent`)', () => {
  /** Odpowiedź `agent.get` w kształcie, w jakim herdr oddaje ją NA STARCIE panelu. */
  function starting(extra: Record<string, unknown>): Record<string, unknown> {
    return { agent: { pane_id: 'w9:p9', agent: 'claude', agent_status: 'idle', ...extra } };
  }

  it('brak `agent_session` przez pierwsze ~2 s NIE jest zniknięciem agenta', async () => {
    /*
     * To jest cały powód, dla którego sonda nie może stać na `getAgent()`: tamta funkcja
     * rzuca `HerdrGoneError`, gdy `agent_session` nie jest jeszcze identyfikatorem, a herdr
     * wypełnia to pole DOPIERO ~2,0 s po `agent.start` (zmierzone na żywym herdr). Sonda na
     * `getAgent()` zgłaszałaby więc „agent zniknął zaraz po starcie" przy KAŻDYM starcie.
     */
    const fake = fakeRequester(() => starting({ agent_session: null }));
    const probe = await createHerdrLaunchClient(fake).probeAgent('w9:p9');
    expect(probe).toEqual({
      agentSessionId: '', status: 'idle', interactiveReady: null, launchPending: false,
    });
  });

  it('brak `interactive_ready` to `null` („nie wiem"), nigdy `true`', async () => {
    /*
     * Odwrotnie niż w `normalizeAgentInfo`: tam mowa o panelu, który już działa, tu — o takim,
     * który dopiero wstaje. `agent.prompt` przed gotowością zwraca `agent_not_ready` i GUBI
     * tekst, więc optymistyczne `true` kosztowałoby pierwszą wiadomość użytkownika. Od herdr
     * 0.9.0 brak pola ma jednak dwa znaczenia (rekord startu trwa / wygasł), więc sonda oddaje
     * `null` i `launchPending`, a rozstrzyga launcher (`waitReady`).
     */
    const fake = fakeRequester(() => starting({}));
    const probe = await createHerdrLaunchClient(fake).probeAgent('w9:p9');
    expect(probe.interactiveReady).toBeNull();
    expect(probe.launchPending).toBe(false);
  });

  it('`launch_pending: true` (herdr 0.9.0) przechodzi do sondy', async () => {
    const fake = fakeRequester(() => starting({ launch_pending: true, agent_status: 'unknown' }));
    const probe = await createHerdrLaunchClient(fake).probeAgent('w9:p9');
    expect(probe.launchPending).toBe(true);
    expect(probe.interactiveReady).toBeNull();
  });

  it('`interactive_ready: false` wprost zostaje `false`', async () => {
    const fake = fakeRequester(() => starting({ interactive_ready: false }));
    expect((await createHerdrLaunchClient(fake).probeAgent('w9:p9')).interactiveReady)
      .toBe(false);
  });

  it('gotowy agent oddaje uuid sesji i `interactive_ready`', async () => {
    const uuid = '11111111-2222-4333-8444-555555555555';
    const fake = fakeRequester(() => starting({
      agent_session: { kind: 'id', value: uuid }, interactive_ready: true, agent_status: 'idle',
    }));
    const probe = await createHerdrLaunchClient(fake).probeAgent('w9:p9');
    expect(probe).toEqual({
      agentSessionId: uuid, status: 'idle', interactiveReady: true, launchPending: false,
    });
    expect(fake.calls).toEqual([{ method: 'agent.get', params: { target: 'w9:p9' } }]);
  });

  it('odpowiedź bez wpisu agenta to `HerdrGoneError`', async () => {
    const fake = fakeRequester(() => ({ agent: null }));
    await expect(createHerdrLaunchClient(fake).probeAgent('w9:p9'))
      .rejects.toBeInstanceOf(HerdrGoneError);
  });

  it('nieznany kod zdalny zachowuje `remoteCode` po opakowaniu', async () => {
    // Detekcja `agent_name_taken` w launcherze opiera się na tym polu. Gdyby zostawał sam
    // tekst, zależałaby od brzmienia komunikatu herdr — czyli od rzeczy, która zmienia się
    // bez uprzedzenia razem z wersją serwera.
    const fake = fakeRequester(() => {
      throw new HerdrRemoteError('agent_name_taken', foreign('nazwa zajęta'));
    });
    await expect(createHerdrLaunchClient(fake).probeAgent('w9:p9'))
      .rejects.toMatchObject({ remoteCode: 'agent_name_taken' });
  });
});

// ---------------------------------------------------------------------------
// Fasada LUSTRA
