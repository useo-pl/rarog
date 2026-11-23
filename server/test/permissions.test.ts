/**
 * Pending interactions: first-wins (200), konflikt (409), wygaszenie i nieznane id (410).
 */
import { describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import fc from 'fast-check';
import type { PermissionRequest, QuestionRequest } from '@rarog/shared';
import { EXPIRED_REASON, PendingInteractions } from '../src/permissions.ts';
import type { DecisionOutcome } from '../src/drivers/types.ts';
import { APPLIED, STALE, refused } from '../src/drivers/types.ts';

/** Driver, który zawsze melduje „klawisz poszedł" — domyślny w testach sprzed kontraktu. */
function applied(): Mock<(...args: unknown[]) => Promise<DecisionOutcome>> {
  return vi.fn((...args: unknown[]) => {
    void args;
    return Promise.resolve(APPLIED);
  });
}

const SESSION = 'sesja-1';

function permission(permId: string, sessionId = SESSION): PermissionRequest {
  return {
    permId,
    sessionId,
    toolName: 'Bash',
    displayText: 'npm test',
    risk: 'normal',
    cwd: '/Users/demo/Projects/willow',
    createdAt: '2026-08-21T10:00:00.000Z',
  };
}

function question(qId: string, sessionId = SESSION): QuestionRequest {
  return {
    qId,
    sessionId,
    questions: [
      {
        question: 'Który wariant?',
        header: 'Wariant',
        multiSelect: false,
        options: [{ label: 'A' }, { label: 'B' }],
      },
    ],
    createdAt: '2026-08-21T10:00:00.000Z',
  };
}

describe('PendingInteractions — zgody', () => {
  it('pierwsza decyzja wygrywa, kolejna to konflikt', async () => {
    const pending = new PendingInteractions();
    const respond = applied();
    pending.addPermission(permission('p1'), respond);

    await expect(pending.resolvePermission(SESSION, 'p1', 'allow'))
      .resolves.toEqual({ outcome: 'ok' });
    expect(respond).toHaveBeenCalledExactlyOnceWith('allow', undefined);

    await expect(pending.resolvePermission(SESSION, 'p1', 'deny'))
      .resolves.toEqual({ outcome: 'conflict' });
    await expect(pending.resolvePermission(SESSION, 'p1', 'allow'))
      .resolves.toEqual({ outcome: 'conflict' });
    // Driver dostaje decyzję dokładnie raz — powtórka nie może cofnąć ani zdublować akcji.
    expect(respond).toHaveBeenCalledTimes(1);
  });

  it('przekazuje wiadomość odmowy do drivera', async () => {
    const pending = new PendingInteractions();
    const respond = applied();
    pending.addPermission(permission('p1'), respond);

    await expect(pending.resolvePermission(SESSION, 'p1', 'deny', 'nie tędy'))
      .resolves.toEqual({ outcome: 'ok' });
    expect(respond).toHaveBeenCalledWith('deny', 'nie tędy');
  });

  it('nieznany permId to 410, nie 409', async () => {
    const pending = new PendingInteractions();
    await expect(pending.resolvePermission(SESSION, 'nie-ma-takiego', 'allow'))
      .resolves.toEqual({ outcome: 'gone' });
  });

  it('permId z innej sesji jest niewidoczny', async () => {
    const pending = new PendingInteractions();
    const respond = applied();
    pending.addPermission(permission('p1', 'inna-sesja'), respond);

    await expect(pending.resolvePermission(SESSION, 'p1', 'allow'))
      .resolves.toEqual({ outcome: 'gone' });
    expect(respond).not.toHaveBeenCalled();
    // Właściciel nadal może zdecydować.
    await expect(pending.resolvePermission('inna-sesja', 'p1', 'allow'))
      .resolves.toEqual({ outcome: 'ok' });
  });

  it('listuje pending tylko swojej sesji', () => {
    const pending = new PendingInteractions();
    pending.addPermission(permission('p1'), applied());
    pending.addPermission(permission('p2', 'inna-sesja'), applied());

    expect(pending.permissionsFor(SESSION).map((r) => r.permId)).toEqual(['p1']);
    expect(pending.hasPending(SESSION)).toBe(true);
  });
});

describe('PendingInteractions — pytania', () => {
  it('first-wins działa tak samo jak przy zgodach', async () => {
    const pending = new PendingInteractions();
    const respond = applied();
    pending.addQuestion(question('q1'), respond);

    await expect(pending.resolveQuestion(SESSION, 'q1', [['A']]))
      .resolves.toEqual({ outcome: 'ok' });
    expect(respond).toHaveBeenCalledExactlyOnceWith([['A']]);
    await expect(pending.resolveQuestion(SESSION, 'q1', [['B']]))
      .resolves.toEqual({ outcome: 'conflict' });
    await expect(pending.resolveQuestion(SESSION, 'nieznane', [['B']]))
      .resolves.toEqual({ outcome: 'gone' });
  });
});

describe('PendingInteractions — wygaszanie (interrupt / close / restart)', () => {
  it('wygasza pending sesji i zwraca ich identyfikatory', () => {
    const pending = new PendingInteractions();
    const onPermission = applied();
    const onQuestion = applied();
    pending.addPermission(permission('p1'), onPermission);
    pending.addQuestion(question('q1'), onQuestion);
    pending.addPermission(permission('p2', 'inna-sesja'), applied());

    const expired = pending.expireSession(SESSION);

    expect(expired).toEqual({ permIds: ['p1'], qIds: ['q1'] });
    // Driver MUSI dostać odpowiedź, inaczej `canUseTool` wisi bez końca.
    expect(onPermission).toHaveBeenCalledWith('deny', EXPIRED_REASON);
    expect(onQuestion).toHaveBeenCalledWith([[]]);
    // Cudza sesja nietknięta.
    expect(pending.permissionsFor('inna-sesja')).toHaveLength(1);
  });

  it('same karty zgód sesji (karta kanału zgód zastępuje kartę z ekranu): bez drivera, pytania zostają, potem 410',
    async () => {
      const pending = new PendingInteractions();
      const onPermission = applied();
      const onQuestion = applied();
      pending.addPermission(permission('p1'), onPermission);
      pending.addQuestion(question('q1'), onQuestion);
      pending.addPermission(permission('p2', 'inna-sesja'), applied());

      expect(pending.expirePermissions(SESSION)).toEqual(['p1']);

      expect(onPermission).not.toHaveBeenCalled();
      expect(pending.questionsFor(SESSION)).toHaveLength(1);
      expect(pending.permissionsFor('inna-sesja')).toHaveLength(1);
      await expect(pending.resolvePermission(SESSION, 'p1', 'allow')).resolves.toEqual({ outcome: 'gone' });
      expect(onPermission).not.toHaveBeenCalled();
    });

  it('po wygaszeniu decyzja jest 410 (a nie 409)', async () => {
    const pending = new PendingInteractions();
    pending.addPermission(permission('p1'), applied());
    pending.expireSession(SESSION);

    await expect(pending.resolvePermission(SESSION, 'p1', 'allow'))
      .resolves.toEqual({ outcome: 'gone' });
    expect(pending.hasPending(SESSION)).toBe(false);
  });

  it('nie zawiadamia drivera, gdy ten już nie żyje', async () => {
    const pending = new PendingInteractions();
    const respond = applied();
    pending.addPermission(permission('p1'), respond);

    pending.expireSession(SESSION, false);

    expect(respond).not.toHaveBeenCalled();
    await expect(pending.resolvePermission(SESSION, 'p1', 'allow'))
      .resolves.toEqual({ outcome: 'gone' });
  });

  it('forgetSession czyści pending bez zawiadamiania drivera', () => {
    const pending = new PendingInteractions();
    const respond = applied();
    pending.addPermission(permission('p1'), respond);

    pending.forgetSession(SESSION);

    expect(respond).not.toHaveBeenCalled();
    expect(pending.permissionsFor(SESSION)).toHaveLength(0);
  });
});

describe('PendingInteractions — pamięć rozstrzygnięć', () => {
  it('po przepełnieniu pamięci stary konflikt degraduje się do 410', async () => {
    // Świadome ograniczenie: pamiętamy ostatnie N rozstrzygnięć, żeby mapa nie rosła bez końca.
    // Najstarszy identyfikator przestaje być rozpoznawany jako „już zdecydowany" i wraca 410.
    const pending = new PendingInteractions({ settledMemory: 2 });
    for (const id of ['p1', 'p2', 'p3']) {
      pending.addPermission(permission(id), applied());
      await expect(pending.resolvePermission(SESSION, id, 'allow'))
        .resolves.toEqual({ outcome: 'ok' });
    }

    await expect(pending.resolvePermission(SESSION, 'p1', 'allow'))
      .resolves.toEqual({ outcome: 'gone' });
    await expect(pending.resolvePermission(SESSION, 'p3', 'allow'))
      .resolves.toEqual({ outcome: 'conflict' });
  });
});

describe('PendingInteractions — kontrakt DecisionOutcome', () => {
  it('`refused` NIE zdejmuje pendingu — karta zostaje, drugie urządzenie ją widzi', async () => {
    const pending = new PendingInteractions();
    const respond = vi.fn(() => Promise.resolve(refused('no-digit')));
    pending.addPermission(permission('p1'), respond);

    await expect(pending.resolvePermission(SESSION, 'p1', 'allow'))
      .resolves.toEqual({ outcome: 'refused', reason: 'no-digit' });
    // Cały sens zmiany: dialog stoi dalej w terminalu, więc karta ma stać dalej w Rarogu.
    expect(pending.permissionsFor(SESSION).map((r) => r.permId)).toEqual(['p1']);
    expect(pending.hasPending(SESSION)).toBe(true);

    // …i druga próba nie jest konfliktem, bo pierwsza niczego nie „zużyła".
    respond.mockImplementation(() => Promise.resolve(APPLIED));
    await expect(pending.resolvePermission(SESSION, 'p1', 'allow'))
      .resolves.toEqual({ outcome: 'ok' });
    expect(pending.hasPending(SESSION)).toBe(false);
  });

  it('`stale` gasi pending i daje 410, nie 422', async () => {
    const pending = new PendingInteractions();
    pending.addPermission(permission('p1'), () => Promise.resolve(STALE));

    await expect(pending.resolvePermission(SESSION, 'p1', 'allow'))
      .resolves.toEqual({ outcome: 'gone' });
    expect(pending.hasPending(SESSION)).toBe(false);
    // Wpis „expired", nie „decided" — powtórka ma dostać 410, a nie 409.
    await expect(pending.resolvePermission(SESSION, 'p1', 'allow'))
      .resolves.toEqual({ outcome: 'gone' });
  });

  it('druga próba W TRAKCIE pierwszej to 422 `in-flight`, nie 409', async () => {
    const pending = new PendingInteractions();
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const respond = vi.fn(async (): Promise<DecisionOutcome> => {
      await gate;
      return APPLIED;
    });
    pending.addPermission(permission('p1'), respond);

    const first = pending.resolvePermission(SESSION, 'p1', 'allow');
    // Driver jeszcze czyta ekran — drugie urządzenie nie ma prawa wysłać drugiej cyfry…
    await expect(pending.resolvePermission(SESSION, 'p1', 'allow'))
      .resolves.toEqual({ outcome: 'refused', reason: 'in-flight' });
    // …a karta ZOSTAJE: w tej chwili nikt jeszcze nie wie, czy jakakolwiek decyzja zapadła.
    expect(pending.hasPending(SESSION)).toBe(true);
    release();
    await expect(first).resolves.toEqual({ outcome: 'ok' });
    expect(respond).toHaveBeenCalledTimes(1);
  });

  it('gdy pierwsza próba skończy się `refused`, druga nie dostała nieprawdy o konflikcie',
    async () => {
      /*
       * Najgorszy przebieg: `send-failed` nie gasi karty i nie stawia nowej, więc po 409
       * drugie urządzenie ZDJĘŁOBY kartę i pokazało „decyzja zapadła na innym urządzeniu" —
       * choć nie zapadła żadna, a dialog dalej stoi w terminalu.
       */
      const pending = new PendingInteractions();
      let release = (): void => {};
      const gate = new Promise<void>((resolve) => { release = resolve; });
      pending.addPermission(permission('p1'), async () => {
        await gate;
        return refused('send-failed');
      });

      const first = pending.resolvePermission(SESSION, 'p1', 'deny');
      await expect(pending.resolvePermission(SESSION, 'p1', 'deny'))
        .resolves.toEqual({ outcome: 'refused', reason: 'in-flight' });
      release();
      await expect(first).resolves.toEqual({ outcome: 'refused', reason: 'send-failed' });
      // Oba urządzenia zostają z tą samą, wciąż czekającą kartą.
      expect(pending.permissionsFor(SESSION).map((r) => r.permId)).toEqual(['p1']);
    });

  it('wygaszenie W TRAKCIE decyzji wygrywa — driver nie dostaje drugiego klawisza', async () => {
    const pending = new PendingInteractions();
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const respond = vi.fn(async (): Promise<DecisionOutcome> => {
      await gate;
      return APPLIED;
    });
    pending.addPermission(permission('p1'), respond);

    const first = pending.resolvePermission(SESSION, 'p1', 'allow');
    // Interrupt z drugiego urządzenia w oknie, w którym driver czyta ekran i trzyma cyfrę.
    expect(pending.expireSession(SESSION)).toEqual({ permIds: ['p1'], qIds: [] });
    /*
     * `deny` (escape) NIE leci: driver ma cyfrę w kolejce, więc escape wylądowałby ZA nią —
     * a `interrupt()` dokłada z managera własny. Dwa Esc pod rząd to w Claude Code rewind.
     */
    expect(respond).toHaveBeenCalledExactlyOnceWith('allow', undefined);

    release();
    // Karty już nie ma, więc wynik drivera nie może wrócić jako 200 (drugie
    // `permission-resolved decision:'allow'` po ogłoszonym przed chwilą `expired`).
    await expect(first).resolves.toEqual({ outcome: 'gone' });
    expect(pending.hasPending(SESSION)).toBe(false);
    // Znacznik ma zostać `expired`: powtórka to 410 „wygasło", nie 409 „ktoś już zdecydował".
    await expect(pending.resolvePermission(SESSION, 'p1', 'allow'))
      .resolves.toEqual({ outcome: 'gone' });
  });

  it('wygaszenie W TRAKCIE odmowy też jest 410 — karty nie ma, więc nie ma czego zostawiać',
    async () => {
      const pending = new PendingInteractions();
      let release = (): void => {};
      const gate = new Promise<void>((resolve) => { release = resolve; });
      pending.addPermission(permission('p1'), async () => {
        await gate;
        return refused('screen-changed');
      });

      const first = pending.resolvePermission(SESSION, 'p1', 'allow');
      pending.expireSession(SESSION);
      release();

      await expect(first).resolves.toEqual({ outcome: 'gone' });
      expect(pending.hasPending(SESSION)).toBe(false);
    });

  it('to samo dla pytań: wygaszenie w locie nie wysyła pustej odpowiedzi', async () => {
    const pending = new PendingInteractions();
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const respond = vi.fn(async (): Promise<DecisionOutcome> => {
      await gate;
      return APPLIED;
    });
    pending.addQuestion(question('q1'), respond);

    const first = pending.resolveQuestion(SESSION, 'q1', [['A']]);
    expect(pending.expireSession(SESSION)).toEqual({ permIds: [], qIds: ['q1'] });
    // Pusta tablica odpowiedzi zostawiłaby w transkrypcie wpis „wielokrotny wybór".
    expect(respond).toHaveBeenCalledExactlyOnceWith([['A']]);

    release();
    await expect(first).resolves.toEqual({ outcome: 'gone' });
  });

  it('to samo dla pytań: `refused` zostawia pytanie na ekranie', async () => {
    const pending = new PendingInteractions();
    pending.addQuestion(question('q1'), () => Promise.resolve(refused('multi-select')));

    await expect(pending.resolveQuestion(SESSION, 'q1', [['A']]))
      .resolves.toEqual({ outcome: 'refused', reason: 'multi-select' });
    expect(pending.questionsFor(SESSION).map((r) => r.qId)).toEqual(['q1']);
  });
});

describe('PendingInteractions — własności (fast-check)', () => {
  it('żadna sekwencja decyzji nie „zjada" pendingu bez applied/stale', async () => {
    // `'expire'` = interrupt / close / `permission-cleared`. W modelu jest krokiem
    // NIEODWRACALNYM: po nim wpis jest martwy niezależnie od tego, co odda driver.
    const outcome = fc.constantFrom<DecisionOutcome | 'expire'>(
      APPLIED, refused('no-digit'), refused('screen-changed'), STALE, 'expire',
    );
    await fc.assert(
      fc.asyncProperty(fc.array(outcome, { minLength: 1, maxLength: 12 }), async (steps) => {
        const pending = new PendingInteractions();
        let next: DecisionOutcome = APPLIED;
        pending.addPermission(permission('p1'), () => Promise.resolve(next));
        // Model: wpis żyje dopóki żadna decyzja nie wróciła jako `applied` ani `stale`.
        let alive = true;
        for (const step of steps) {
          if (step === 'expire') {
            pending.expireSession(SESSION);
            alive = false;
            expect(pending.hasPending(SESSION)).toBe(false);
            continue;
          }
          next = step;
          const result = await pending.resolvePermission(SESSION, 'p1', 'allow');
          if (!alive) {
            // Po zdjęciu wpisu decyzje są już tylko 409/410 — nigdy 422 i nigdy 200.
            expect(['conflict', 'gone']).toContain(result.outcome);
            continue;
          }
          if (step.kind === 'refused') {
            expect(result).toEqual({ outcome: 'refused', reason: step.reason });
          } else {
            expect(result.outcome).toBe(step.kind === 'applied' ? 'ok' : 'gone');
            alive = false;
          }
          expect(pending.hasPending(SESSION)).toBe(alive);
        }
      }),
      { numRuns: 200 },
    );
  });
});
