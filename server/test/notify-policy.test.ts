/**
 * Polityka powiadomień (`notify/policy.ts`) — reguły, nie mechanika.
 *
 * Każda reguła w tym module została kupiona audytem po stronie hooków, więc test opisuje
 * SYTUACJĘ Z ŻYCIA, a nie tabelkę wejść i wyjść. Jeżeli któryś przypadek przestanie przechodzić,
 * ma być od razu widać, czyje popołudnie na tym ucierpi.
 */
import { describe, expect, it } from 'vitest';
import type { SessionState } from '@rarog/shared';
import type { SmEvent } from '../src/sessions/state-machine.ts';
import {
  FIRST_CHECK_MS, classify, decide, doneStaysOwed, kindOf, leavesResult, noResultTurn,
} from '../src/notify/policy.ts';
import type { ClassifyInput, DecideInput, NotifyClass, TurnInput } from '../src/notify/policy.ts';

/** Klasyfikacja bez zadań w tle — wariant domyślny w większości przypadków. */
const cls = (event: SmEvent, backgroundTasks = 0): NotifyClass | null =>
  classify({ event, backgroundTasks });

/** Werdykt dla sprawy świeżej, nieobejrzanej, przy nieobecnym użytkowniku. */
const base: DecideInput = {
  cls: 'blocking',
  state: 'waiting-permission',
  presentNow: false,
  seen: false,
  resultSeen: false,
  backgroundTasks: 0,
};

describe('classify — co zasługuje na powiadomienie', () => {
  it('praca stoi na człowieku: zgoda, pytanie, dialog w terminalu', () => {
    expect(cls({ type: 'permission-requested' })).toBe('blocking');
    expect(cls({ type: 'question-requested' })).toBe('blocking');
    expect(cls({ type: 'agent-blocked' })).toBe('blocking');
  });

  it('praca stanęła i bez człowieka nie ruszy: błąd, limit tur, limit planu', () => {
    expect(cls({ type: 'result', subtype: 'error' })).toBe('failure');
    expect(cls({ type: 'result', subtype: 'error_max_turns' })).toBe('failure');
    expect(cls({ type: 'limit-reached' })).toBe('failure');
  });

  it('prompt zablokowany przez hook to cisza — bez klasy i bez rodzaju, nie zostawia wyniku', () => {
    expect(cls({ type: 'prompt-blocked' })).toBeNull();
    expect(kindOf({ type: 'prompt-blocked' })).toBeNull();
    expect(leavesResult({ event: { type: 'prompt-blocked' }, backgroundTasks: 0 })).toBe(false);
  });

  it('skończone — obie drogi znaczą to samo (SDK i obserwacja herdr)', () => {
    expect(cls({ type: 'result', subtype: 'success' })).toBe('done');
    expect(cls({ type: 'agent-idle' })).toBe('done');
  });

  /*
   * An agent that started background work ends its turn ONLY to wait for its own subagents.
   * Measured on a workflow of 5 agents: the turn ended at 07:54, a "done" push would go out at
   * 07:55, and the workflow kept running for more than ten minutes.
   */
  it('koniec tury przy żywym tle to CISZA, nie „gotowe"', () => {
    expect(cls({ type: 'result', subtype: 'success' }, 1)).toBeNull();
    expect(cls({ type: 'agent-idle' }, 3)).toBeNull();
    // …ale awaryjne przechodzi mimo tła: tura padła i tło jej nie naprawi.
    expect(cls({ type: 'result', subtype: 'error' }, 2)).toBe('failure');
  });

  /*
   * Po pełnym restarcie serwera herdr `claude --resume` ładuje się i staje — pierwsze
   * `idle` odtworzonej karty nie jest końcem tury. Znacznik dotyczy WYŁĄCZNIE `agent-idle`:
   * dialog po odtworzeniu dalej blokuje pracę, a błąd dalej jest błędem.
   */
  it('`idle` karty odtworzonej po restarcie herdr to cisza — reszta klas bez zmian', () => {
    const restored = (event: SmEvent): NotifyClass | null =>
      classify({ event, backgroundTasks: 0, afterHerdrRestore: true });
    expect(restored({ type: 'agent-idle' })).toBeNull();
    expect(restored({ type: 'result', subtype: 'success' })).toBe('done');
    expect(restored({ type: 'agent-blocked' })).toBe('blocking');
    expect(restored({ type: 'result', subtype: 'error' })).toBe('failure');
    expect(classify({ event: { type: 'agent-idle' }, backgroundTasks: 0, afterHerdrRestore: false }))
      .toBe('done');
  });

  /*
   * A session that is only starting does not end a turn. The first `idle` of a pane in `starting`
   * and turn zero of a session without a prompt would give "✅ Done" with the chime before anyone
   * sent a prompt. The marker silences ONLY the "done" class: a dialog at start (folder trust,
   * the `--resume` question) still blocks work, and a plan limit is still a failure.
   */
  it('start sesji to cisza dla „gotowe” — dialog, błąd i limit bez zmian', () => {
    const started = (event: SmEvent): NotifyClass | null =>
      classify({ event, backgroundTasks: 0, afterStart: true });
    expect(started({ type: 'agent-idle' })).toBeNull();
    expect(started({ type: 'result', subtype: 'success' })).toBeNull();
    expect(started({ type: 'agent-blocked' })).toBe('blocking');
    expect(started({ type: 'permission-requested' })).toBe('blocking');
    expect(started({ type: 'result', subtype: 'error' })).toBe('failure');
    expect(started({ type: 'limit-reached' })).toBe('failure');
    // Zaległe „gotowe” sprzed startu nie wychodzi przy starcie: żadna tura się nie skończyła.
    expect(classify({ event: { type: 'agent-idle' }, backgroundTasks: 0, afterStart: true, doneOwed: true }))
      .toBeNull();
    expect(leavesResult({ event: { type: 'agent-idle' }, backgroundTasks: 0, afterStart: true })).toBe(false);
    expect(leavesResult({ event: { type: 'result', subtype: 'success' }, backgroundTasks: 0, afterStart: true }))
      .toBe(false);
  });

  /*
   * A session working in a temporary directory is a helper of another agent (tests, measurements). Its end of
   * turn is no news for the owner; a dialog or an error of such a session still stops work and still calls.
   */
  it('test session: "done" is silent and leaves no owed result; dialog and error unchanged', () => {
    const test = (event: SmEvent, extra: Partial<ClassifyInput> = {}): NotifyClass | null =>
      classify({ event, backgroundTasks: 0, testSession: true, ...extra });
    expect(test({ type: 'agent-idle' })).toBeNull();
    expect(test({ type: 'result', subtype: 'success' })).toBeNull();
    expect(test({ type: 'agent-idle' }, { doneOwed: true })).toBeNull();
    expect(test({ type: 'permission-requested' })).toBe('blocking');
    expect(test({ type: 'question-requested' })).toBe('blocking');
    expect(test({ type: 'agent-blocked' })).toBe('blocking');
    expect(test({ type: 'result', subtype: 'error' })).toBe('failure');
    expect(test({ type: 'limit-reached' })).toBe('failure');
    expect(leavesResult({ event: { type: 'agent-idle' }, backgroundTasks: 0, testSession: true })).toBe(false);
    expect(leavesResult({ event: { type: 'result', subtype: 'success' }, backgroundTasks: 0, testSession: true }))
      .toBe(false);
  });

  /*
   * A subagent stops because it waits for its own command, the CLI reports this to the main agent
   * (fixture `incydent-gotowe-po-postoju-2.1.301`), which writes "still waiting" and ends the turn.
   * Nothing has finished, and one night can bring 27 such turns. A turn in which the only `user`
   * messages since the previous turn end were standby notices is silent.
   */
  describe('tura wywołana samym postojem subagenta', () => {
    const turn = (standbyNotices: number, other: number): TurnInput => ({
      standbyNotices, artifactWatch: 0, other, toolCalls: 0, compactions: 0,
    });
    const ended = (turnInput: TurnInput | undefined, event: SmEvent = { type: 'agent-idle' }): NotifyClass | null =>
      classify({ event, backgroundTasks: 0, ...(turnInput === undefined ? {} : { turnInput }) });

    it('sama notka o postoju → cisza, obiema drogami końca tury', () => {
      expect(ended(turn(1, 0))).toBeNull();
      expect(ended(turn(1, 0), { type: 'result', subtype: 'success' })).toBeNull();
    });

    it('dwie i więcej notek o postoju w jednej turze → dalej cisza', () => {
      expect(ended(turn(2, 0))).toBeNull();
      expect(ended(turn(27, 0))).toBeNull();
    });

    it('notka o postoju i COKOLWIEK innego → zwykłe „gotowe"', () => {
      // Prompt człowieka, raport subagenta, notka o końcu komendy: manager liczy je razem.
      expect(ended(turn(1, 1))).toBe('done');
      expect(ended(turn(3, 2))).toBe('done');
    });

    it('tura bez notki o postoju zachowuje się jak dotąd: z wiadomością i bez żadnej', () => {
      // Notka o końcu komendy albo prompt człowieka.
      expect(ended(turn(0, 1))).toBe('done');
      // Żadnej wiadomości `user`: przyczyna, której Rarog nie zna — nie ma podstaw do ciszy.
      expect(ended(turn(0, 0))).toBe('done');
      // Wołający, który nie liczy (driver bez pliku rozmowy), też dostaje zwykłe zachowanie.
      expect(ended(undefined)).toBe('done');
    });

    it('dialog i błąd w takiej turze stoją na człowieku jak zawsze', () => {
      const standby = turn(1, 0);
      expect(ended(standby, { type: 'permission-requested' })).toBe('blocking');
      expect(ended(standby, { type: 'question-requested' })).toBe('blocking');
      expect(ended(standby, { type: 'agent-blocked' })).toBe('blocking');
      expect(ended(standby, { type: 'result', subtype: 'error' })).toBe('failure');
      expect(ended(standby, { type: 'result', subtype: 'error_max_turns' })).toBe('failure');
      expect(ended(standby, { type: 'limit-reached' })).toBe('failure');
    });

    it('praca w tle ucisza „gotowe" niezależnie od przyczyny tury', () => {
      expect(classify({ event: { type: 'agent-idle' }, backgroundTasks: 1, turnInput: turn(1, 1) })).toBeNull();
      expect(classify({ event: { type: 'agent-idle' }, backgroundTasks: 1, turnInput: turn(1, 0) })).toBeNull();
    });

    it('`noResultTurn` dla postoju wymaga obu połów: jest notka o postoju i nie ma nic innego', () => {
      expect(noResultTurn(turn(1, 0))).toBe(true);
      expect(noResultTurn(turn(0, 0))).toBe(false);
      expect(noResultTurn(turn(1, 1))).toBe(false);
      expect(noResultTurn(turn(0, 1))).toBe(false);
      expect(noResultTurn(undefined)).toBe(false);
      // Narzędzia agenta w turze po samym postoju niczego nie zmieniają.
      expect(noResultTurn({ ...turn(1, 0), toolCalls: 3 })).toBe(true);
    });

    /*
     * Owed "done". The result of an ordinary turn waits while a subagent works in the background,
     * and the first quiet moment may come after a turn with a standby alone; without the owed
     * result no banner would go out until morning.
     */
    describe('zaległe „gotowe"', () => {
      const owed = (turnInput: TurnInput, backgroundTasks = 0): NotifyClass | null =>
        classify({ event: { type: 'agent-idle' }, backgroundTasks, turnInput, doneOwed: true });

      it('tura po samym postoju z zaległym „gotowe" i cichym tłem → „gotowe"', () => {
        expect(owed(turn(1, 0))).toBe('done');
        expect(owed(turn(3, 0))).toBe('done');
      });

      it('praca w tle wstrzymuje także zaległe', () => {
        expect(owed(turn(1, 0), 1)).toBeNull();
      });

      it('zaległość nie zmienia niczego w zwykłej turze ani w dialogu i błędzie', () => {
        expect(owed(turn(0, 1))).toBe('done');
        expect(classify({
          event: { type: 'permission-requested' }, backgroundTasks: 0, turnInput: turn(1, 0), doneOwed: true,
        })).toBe('blocking');
        expect(classify({
          event: { type: 'result', subtype: 'error' }, backgroundTasks: 0, turnInput: turn(1, 0), doneOwed: true,
        })).toBe('failure');
      });

      it('`leavesResult`: wynik zostawia koniec każdej zwykłej tury, także przy pracującym tle', () => {
        const idle: SmEvent = { type: 'agent-idle' };
        expect(leavesResult({ event: idle, backgroundTasks: 0 })).toBe(true);
        expect(leavesResult({ event: idle, backgroundTasks: 2, turnInput: turn(0, 1) })).toBe(true);
        expect(leavesResult({ event: idle, backgroundTasks: 0, turnInput: turn(1, 1) })).toBe(true);
        expect(leavesResult({ event: { type: 'result', subtype: 'success' }, backgroundTasks: 1 })).toBe(true);
      });

      /*
       * A turn with a stage report ends by starting the next stage's subagent (result owed), the
       * subagent stops at its own command, the notice wakes the main agent, which writes "the stage
       * is still running"; the owed "done" must not go out about a stage that is still running.
       */
      describe('subagent w postoju czeka na własną komendę', () => {
        const held = (turnInput: TurnInput, extra: Partial<ClassifyInput> = {}): NotifyClass | null =>
          classify({
            event: { type: 'agent-idle' }, backgroundTasks: 0, turnInput, doneOwed: true, waitingOnOwnCommand: true,
            ...extra,
          });

        it('tura po samym postoju z zaległym „gotowe" → cisza, obiema drogami końca tury', () => {
          expect(held(turn(1, 0))).toBeNull();
          expect(held(turn(2, 0), { event: { type: 'result', subtype: 'success' } })).toBeNull();
        });

        it('bez komendy agenta zaległe wychodzi jak dotąd', () => {
          expect(held(turn(1, 0), { waitingOnOwnCommand: false })).toBe('done');
          expect(owed(turn(1, 0))).toBe('done');
        });

        it('prompt człowieka, raport subagenta albo koniec komendy w turze → „gotowe" jak dotąd', () => {
          expect(held(turn(0, 1))).toBe('done');
          expect(held(turn(1, 1))).toBe('done');
          expect(held(turn(0, 0))).toBe('done');
          expect(classify({ event: { type: 'agent-idle' }, backgroundTasks: 0, waitingOnOwnCommand: true })).toBe('done');
        });

        it('dialog i błąd w takiej turze stoją na człowieku jak zawsze', () => {
          expect(held(turn(1, 0), { event: { type: 'permission-requested' } })).toBe('blocking');
          expect(held(turn(1, 0), { event: { type: 'result', subtype: 'error' } })).toBe('failure');
        });

        it('zaległości nie zapala ani nie gasi: rachunek wyniku jest ten sam co bez komendy', () => {
          const idle: SmEvent = { type: 'agent-idle' };
          expect(leavesResult({ event: idle, backgroundTasks: 0, turnInput: turn(1, 0), waitingOnOwnCommand: true }))
            .toBe(false);
          expect(leavesResult({ event: idle, backgroundTasks: 0, turnInput: turn(0, 1), waitingOnOwnCommand: true }))
            .toBe(true);
        });
      });

      it('`leavesResult`: nie zostawia go tura po samym postoju, powrót herdr ani nie-koniec tury', () => {
        const idle: SmEvent = { type: 'agent-idle' };
        expect(leavesResult({ event: idle, backgroundTasks: 0, turnInput: turn(1, 0) })).toBe(false);
        expect(leavesResult({ event: idle, backgroundTasks: 0, afterHerdrRestore: true })).toBe(false);
        expect(leavesResult({ event: { type: 'agent-working' }, backgroundTasks: 0 })).toBe(false);
        expect(leavesResult({ event: { type: 'permission-requested' }, backgroundTasks: 0 })).toBe(false);
        // Tura, która padła, ma własny baner awaryjny; zaległego „gotowe" nie zostawia.
        expect(leavesResult({ event: { type: 'result', subtype: 'error' }, backgroundTasks: 0 })).toBe(false);
      });
    });
  });

  /*
   * Removing an artifact on claude.ai ends its observation in every session that published or read
   * it; the CLI injects an `artifact-watch-lifecycle` notice, the model replies on its own ("nothing
   * to do"), and without this rule a long finished session would get "done". The tool condition:
   * an agent that did something after the notice has a result to collect.
   */
  describe('tura po samym meldunku o artefakcie', () => {
    const turn = (patch: Partial<TurnInput>): TurnInput => ({
      standbyNotices: 0, artifactWatch: 0, other: 0, toolCalls: 0, compactions: 0, ...patch,
    });
    const ended = (turnInput: TurnInput | undefined, extra: Partial<ClassifyInput> = {}): NotifyClass | null =>
      classify({
        event: { type: 'agent-idle' }, backgroundTasks: 0, ...(turnInput === undefined ? {} : { turnInput }), ...extra,
      });

    it('sam meldunek, agent bez narzędzi → cisza i bez zaległości, obiema drogami końca tury', () => {
      const artifact = turn({ artifactWatch: 1 });
      expect(noResultTurn(artifact)).toBe(true);
      expect(ended(artifact)).toBeNull();
      expect(ended(artifact, { event: { type: 'result', subtype: 'success' } })).toBeNull();
      expect(leavesResult({ event: { type: 'agent-idle' }, backgroundTasks: 0, turnInput: artifact })).toBe(false);
      expect(ended(turn({ artifactWatch: 2 }))).toBeNull();
    });

    it('agent po meldunku użył narzędzia (odtworzył artefakt, poprawił plik) → „gotowe" i zaległość jak dotąd', () => {
      const worked = turn({ artifactWatch: 1, toolCalls: 1 });
      expect(noResultTurn(worked)).toBe(false);
      expect(ended(worked)).toBe('done');
      expect(leavesResult({ event: { type: 'agent-idle' }, backgroundTasks: 0, turnInput: worked })).toBe(true);
    });

    it('meldunek i prompt człowieka (albo raport subagenta, koniec komendy) → „gotowe", także bez narzędzi', () => {
      expect(noResultTurn(turn({ artifactWatch: 1, other: 1 }))).toBe(false);
      expect(ended(turn({ artifactWatch: 1, other: 1 }))).toBe('done');
    });

    it('meldunek i postój subagenta bez narzędzi → cisza; z narzędziem → „gotowe" (jak przed dopiskiem)', () => {
      expect(ended(turn({ artifactWatch: 1, standbyNotices: 1 }))).toBeNull();
      expect(ended(turn({ artifactWatch: 1, standbyNotices: 1, toolCalls: 2, compactions: 0 }))).toBe('done');
    });

    it('rachunek niepełny albo tura bez żadnego wejścia → zwykłe „gotowe"', () => {
      expect(ended(undefined)).toBe('done');
      expect(ended(turn({}))).toBe('done');
      expect(ended(turn({ toolCalls: 4 }))).toBe('done');
    });

    it('zaległość wcześniejszej zwykłej tury: wychodzi po takiej turze, chyba że subagent czeka na własną komendę', () => {
      const artifact = turn({ artifactWatch: 1 });
      expect(ended(artifact, { doneOwed: true })).toBe('done');
      expect(ended(artifact, { doneOwed: true, waitingOnOwnCommand: true })).toBeNull();
      expect(ended(artifact, { doneOwed: true, backgroundTasks: 1 })).toBeNull();
      // Ta sama odpowiedź co po turze z samym postojem: jedna reguła, `noResultTurn`.
      const standby = turn({ standbyNotices: 1 });
      for (const extra of [{}, { doneOwed: true }, { doneOwed: true, waitingOnOwnCommand: true }]) {
        expect(ended(artifact, extra)).toBe(ended(standby, extra));
      }
    });

    it('dialog i błąd w takiej turze stoją na człowieku jak zawsze', () => {
      const artifact = turn({ artifactWatch: 1 });
      expect(ended(artifact, { event: { type: 'permission-requested' } })).toBe('blocking');
      expect(ended(artifact, { event: { type: 'result', subtype: 'error' } })).toBe('failure');
    });
  });

  /*
   * A turn started by a context compaction alone (Claude Code compacts an idle conversation before the prompt
   * cache expires) has no result. The compaction boundary counts as a turn input of its own kind.
   */
  describe('turn after a context compaction alone', () => {
    const turn = (patch: Partial<TurnInput>): TurnInput => ({
      standbyNotices: 0, artifactWatch: 0, other: 0, toolCalls: 0, compactions: 0, ...patch,
    });
    const cases: readonly { readonly name: string; readonly turn: TurnInput; readonly noResult: boolean }[] = [
      { name: 'compaction alone', turn: turn({ compactions: 1 }), noResult: true },
      { name: 'compaction and a tool call', turn: turn({ compactions: 1, toolCalls: 1 }), noResult: false },
      { name: 'compaction and a prompt (also /compact)', turn: turn({ compactions: 1, other: 1 }), noResult: false },
      { name: 'compaction and a subagent standby', turn: turn({ compactions: 1, standbyNotices: 1 }), noResult: true },
    ];
    it.each(cases)('$name → no result: $noResult', ({ turn: input, noResult }) => {
      expect(noResultTurn(input)).toBe(noResult);
      expect(classify({ event: { type: 'agent-idle' }, backgroundTasks: 0, turnInput: input }))
        .toBe(noResult ? null : 'done');
      expect(leavesResult({ event: { type: 'agent-idle' }, backgroundTasks: 0, turnInput: input })).toBe(!noResult);
    });
  });

  /*
   * Sedno klasyfikacji po ZDARZENIU, a nie po parze stanów: `interrupt-requested` prowadzi do
   * tego samego `waiting-input` co `result: success`. Gdyby liczyła się para stanów, człowiek,
   * który nacisnął Esc i schował telefon, dostałby minutę później baner „Gotowe" o czymś,
   * co sam przerwał.
   */
  it('Esc od człowieka NIE jest powiadomieniem, choć prowadzi tam co „gotowe"', () => {
    expect(cls({ type: 'interrupt-requested' })).toBeNull();
    expect(cls({ type: 'result', subtype: 'success' })).toBe('done');
  });

  it('cykl życia Raroga i własne decyzje użytkownika są ciche', () => {
    const silent: SmEvent[] = [
      { type: 'driver-init' },
      { type: 'turn-start' },
      { type: 'agent-working' },
      { type: 'permission-resolved' },
      { type: 'question-resolved' },
      { type: 'backend-restart' },
      { type: 'resumed' },
      { type: 'closed' },
      { type: 'driver-exit', ok: true },
      { type: 'driver-exit', ok: false },
    ];
    for (const event of silent) expect(cls(event)).toBeNull();
  });
});

describe('progi czasowe', () => {
  /*
   * Thresholds only wait out a state that reverts by itself; they do not make up for uncertain
   * presence, because in Rarog presence is a fact.
   */
  it('sprawa, na której praca STOI, wychodzi praktycznie od razu', () => {
    expect(FIRST_CHECK_MS.blocking).toBeLessThanOrEqual(3_000);
    expect(FIRST_CHECK_MS.failure).toBeLessThanOrEqual(3_000);
  });

  /*
   * Ale NIE zero: Rarog potrafi auto-potwierdzić komendę, więc dialog bywa migawką. Przy zerze
   * push byłby alarmem o czymś, co samo rozstrzygnęło się sekundę później.
   */
  it('żadna klasa nie dzwoni w tej samej milisekundzie', () => {
    for (const value of Object.values(FIRST_CHECK_MS)) expect(value).toBeGreaterThan(0);
  });

  /*
   * „Gotowe" zostaje jedynym progiem z prawdziwym zadaniem: to jedyny stan, który sam się cofa
   * (prompt z kolejki, wybudzenie `/loop`). Zadania w tle mają własny guard, ale zaplanowanych
   * wybudzeń Rarog NIE WIDZI — i te sekundy są właśnie na nie.
   */
  it('„skończone" ma zapas na turę, która zaraz ruszy dalej — ale krótki', () => {
    expect(FIRST_CHECK_MS.done).toBeGreaterThan(FIRST_CHECK_MS.blocking);
    expect(FIRST_CHECK_MS.done).toBeLessThanOrEqual(15_000);
  });
});

describe('decide — czy wysłać po upływie okna', () => {
  it('nieobecny, sprawa aktualna → wysyłamy', () => {
    expect(decide(base)).toBe('send');
  });

  /*
   * Presence comes from Rarog, not from tty atime, so work in the app on the phone counts as presence
   * and no push goes to someone who is looking at the same session.
   */
  it('patrzysz w Raroga → sprawa GAŚNIE, nie czeka', () => {
    // Obecność kasuje, a nie odkłada. Powrót do Raroga kasuje wszystko,
    // bo lista pokazuje stan każdej sesji naraz — nie ma czego dosyłać.
    expect(decide({ ...base, presentNow: true })).toBe('drop');
  });

  it('obejrzane w Rarogu gasi sprawę — nawet gdy stan dalej trwa', () => {
    expect(decide({ ...base, seen: true })).toBe('drop');
  });

  /*
   * The sticky herdr marker `seen` must not be ORed with `watching`. It lights up when the pane goes
   * from `done` to `idle` (someone looked at it in the terminal) and does NOT go off on `working` or
   * `blocked`, so a dialog that stopped in the next turn would be cleared silently while the user
   * is ABSENT.
   */
  it('wynik odebrany w terminalu NIE kasuje dialogu, który stanął później', () => {
    expect(decide({ ...base, cls: 'blocking', resultSeen: true })).toBe('send');
    expect(decide({
      ...base, cls: 'failure', state: 'error', resultSeen: true,
    })).toBe('send');
    // …ale dla „gotowe" znaczy dokładnie to, co mówi: wynik już odebrano.
    expect(decide({
      ...base, cls: 'done', state: 'waiting-input', resultSeen: true,
    })).toBe('drop');
  });

  describe('stan, który minął, nie zasługuje na powiadomienie', () => {
    const holds: Record<NotifyClass, SessionState[]> = {
      blocking: ['waiting-permission', 'waiting-question'],
      failure: ['error', 'limit-reached', 'interrupted'],
      done: ['waiting-input', 'done'],
    };

    for (const [name, states] of Object.entries(holds)) {
      it(`${name}: trwa tylko w swoich stanach`, () => {
        for (const state of states) {
          expect(decide({ ...base, cls: name as NotifyClass, state })).toBe('send');
        }
        // `running` unieważnia KAŻDĄ klasę: zgoda rozstrzygnięta, błąd ponowiony, tura ruszyła.
        expect(decide({ ...base, cls: name as NotifyClass, state: 'running' })).toBe('drop');
      });
    }

    it('zgoda rozstrzygnięta w terminalu, zanim minęło okno', () => {
      expect(decide({ ...base, cls: 'blocking', state: 'running' })).toBe('drop');
    });

    it('ponowiłeś po błędzie → awaryjne milknie', () => {
      expect(decide({ ...base, cls: 'failure', state: 'running' })).toBe('drop');
    });

    /*
     * Sesja zamknięta PRZEPUSZCZA „gotowe": wynik ostatniej tury dalej czeka na odebranie,
     * a `done` znaczy tu „silnik odszedł", nie „obejrzane".
     */
    it('sesja zamknięta nie kasuje „gotowe"', () => {
      expect(decide({ ...base, cls: 'done', state: 'done' })).toBe('send');
    });
  });

  /*
   * Subagent w postoju nie wstrzymuje „gotowe", więc push uzbraja się przy liście, na której
   * coś stoi. Gdy ten subagent ruszy sam w oknie 15 s (skończyła się jego komenda), stan głównej
   * sesji się nie zmienia — dalej `waiting-input` — i jedynym śladem jest liczba pracujących zadań
   * z chwili sprawdzenia. Bez niej baner „Skończył" wychodziłby przy pracującym tle.
   */
  it('„gotowe": tło ruszyło po uzbrojeniu → cisza, choć stan sesji się nie zmienił', () => {
    const done: DecideInput = { ...base, cls: 'done', state: 'waiting-input' };
    expect(decide(done)).toBe('send');
    expect(decide({ ...done, backgroundTasks: 1 })).toBe('drop');
    expect(decide({ ...done, state: 'done', backgroundTasks: 2 })).toBe('drop');
  });

  it('praca w tle gasi TYLKO „gotowe" — dialog i błąd stoją niezależnie od niej', () => {
    expect(decide({ ...base, cls: 'blocking', backgroundTasks: 3 })).toBe('send');
    expect(decide({ ...base, cls: 'failure', state: 'error', backgroundTasks: 3 })).toBe('send');
  });

  it('każdy powód ciszy działa osobno i wszystkie się składają', () => {
    expect(decide({ ...base, presentNow: true, state: 'running' })).toBe('drop');
    expect(decide({ ...base, presentNow: true, seen: true })).toBe('drop');
  });
});

/*
 * Zaległe „gotowe": skasowany baner zostaje zaległy tylko wtedy, gdy człowiek wyniku nie
 * widział. Praca w tle to sprawa, która minęła sama; obecność i odbiór to człowiek.
 */
describe('doneStaysOwed — czy skasowane „gotowe" zostaje zaległe', () => {
  const done: DecideInput = { ...base, cls: 'done', state: 'waiting-input' };

  it('w tle znów coś pracuje → zostaje', () => {
    expect(decide({ ...done, backgroundTasks: 1 })).toBe('drop');
    expect(doneStaysOwed({ ...done, backgroundTasks: 1 })).toBe(true);
    // Obecność w Rarogu przy pracującym tle nie odbiera wyniku: lista pokazuje pracę, nie koniec.
    expect(doneStaysOwed({ ...done, backgroundTasks: 1, presentNow: true })).toBe(true);
  });

  it('człowiek widział wynik → znika', () => {
    expect(doneStaysOwed({ ...done, seen: true })).toBe(false);
    expect(doneStaysOwed({ ...done, resultSeen: true })).toBe(false);
    expect(doneStaysOwed({ ...done, backgroundTasks: 1, seen: true })).toBe(false);
    expect(doneStaysOwed({ ...done, backgroundTasks: 1, resultSeen: true })).toBe(false);
  });

  it('patrzy w Raroga przy cichej sesji → znika (lista pokazuje stan końcowy)', () => {
    expect(decide({ ...done, presentNow: true })).toBe('drop');
    expect(doneStaysOwed({ ...done, presentNow: true })).toBe(false);
  });

  it('inne klasy nie mają zaległości', () => {
    expect(doneStaysOwed({ ...base, backgroundTasks: 1 })).toBe(false);
    expect(doneStaysOwed({ ...base, cls: 'failure', state: 'running' })).toBe(false);
  });
});

/*
 * Kontrola przy wysyłce. Własna komenda subagenta trafia na listę
 * dopiero po odczycie jego pliku (co 5 s), więc w chwili końca tury mogło jej tam jeszcze nie być.
 * Gaśnie WYŁĄCZNIE zaległe „gotowe" wypuszczone bez zwykłego końca tury (turą z samym postojem albo
 * ciszą w tle — `owedRelease`); zwykłe „gotowe" bez zmian.
 */
describe('decide — zaległe „gotowe" po turze z samym postojem a subagent z własną komendą', () => {
  const owedDone: DecideInput = { ...base, cls: 'done', state: 'waiting-input', owedRelease: true };

  it('komenda pojawiła się po końcu tury → cisza, a zaległość zostaje', () => {
    expect(decide({ ...owedDone, waitingOnOwnCommand: true })).toBe('drop');
    expect(doneStaysOwed({ ...owedDone, waitingOnOwnCommand: true })).toBe(true);
    expect(decide({ ...owedDone, state: 'done', waitingOnOwnCommand: true })).toBe('drop');
  });

  it('bez komendy zaległe wychodzi', () => {
    expect(decide(owedDone)).toBe('send');
    expect(decide({ ...owedDone, waitingOnOwnCommand: false })).toBe('send');
  });

  it('zwykłe „gotowe" przy agencie z komendą wychodzi jak dotąd', () => {
    expect(decide({ ...base, cls: 'done', state: 'waiting-input', waitingOnOwnCommand: true })).toBe('send');
  });

  it('człowiek, który wynik widział, gasi zaległość mimo komendy agenta', () => {
    expect(doneStaysOwed({ ...owedDone, waitingOnOwnCommand: true, seen: true })).toBe(false);
    expect(doneStaysOwed({ ...owedDone, waitingOnOwnCommand: true, resultSeen: true })).toBe(false);
  });

  it('dialog i błąd nie znają tej reguły', () => {
    expect(decide({ ...base, owedRelease: true, waitingOnOwnCommand: true })).toBe('send');
    expect(decide({
      ...base, cls: 'failure', state: 'error', owedRelease: true, waitingOnOwnCommand: true,
    })).toBe('send');
  });
});

describe('kindOf — rodzaj zdarzenia do tytułu banera', () => {
  it('rozróżnia zgodę od pytania i dialogu w terminalu — jedna klasa, trzy decyzje', () => {
    expect(kindOf({ type: 'permission-requested' })).toBe('permission');
    expect(kindOf({ type: 'question-requested' })).toBe('question');
    expect(kindOf({ type: 'agent-blocked' })).toBe('blocked');
  });

  it('wynik, błąd i limit dostają własne rodzaje', () => {
    expect(kindOf({ type: 'result', subtype: 'success' })).toBe('done');
    expect(kindOf({ type: 'result', subtype: 'error' })).toBe('error');
    expect(kindOf({ type: 'agent-idle' })).toBe('done');
    expect(kindOf({ type: 'limit-reached' })).toBe('limit');
  });

  it('zdarzenia bez banera nie mają rodzaju — ta sama cisza co w classify()', () => {
    for (const type of ['turn-start', 'agent-working', 'closed', 'permission-resolved'] as const) {
      expect(kindOf({ type } as never)).toBeNull();
      expect(classify({ event: { type } as never, backgroundTasks: 0 })).toBeNull();
    }
  });
});
