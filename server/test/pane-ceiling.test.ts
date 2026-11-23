/**
 * THE PANE CEILING TELLS THE TRUTH BEFORE ANYTHING IS TAPPED.
 *
 * With six live Rarog panes ("+" and "New session" dimmed) the client must not fall back to a sentence
 * such as "launching is disabled": it is false when `RAROG_HERDR_LAUNCH=1` and leads nowhere, because it
 * does not say that closing a session is enough. `POST /api/sessions` refuses with 409 and the right
 * sentence, but only after a tap, which a dimmed button no longer accepts.
 *
 * The client uses fallback copy when `HerdrStatus.detail` is empty, so the reason has to arrive in
 * `detail` from the server. This file guards the rule: the ceiling is shown only when it is the ONLY
 * reason, because only then does the advice "close a session" unblock anything.
 */
import { describe, expect, it } from 'vitest';
import { foreign } from '@rarog/shared/sentences';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchDetail } from '../src/herdr/supervisor.ts';
import { HERDR_PANE_CAP_MESSAGE } from '../src/herdr/types.ts';
import { HERDR_PANE_CAP_MESSAGE as FROM_MANAGER } from '../src/sessions/manager.ts';

const SUPERVISOR_SRC = readFileSync(
  join(import.meta.dirname, '..', 'src', 'herdr', 'supervisor.ts'),
  'utf8',
);

describe('powód zgaszonego `canLaunch` jako zdanie', () => {
  it('pełny sufit i nic poza tym → zdanie, które mówi wyjście', () => {
    expect(launchDetail({ paneCapReached: true, otherwiseCanLaunch: true })?.text)
      .toBe(HERDR_PANE_CAP_MESSAGE.text);
    expect(HERDR_PANE_CAP_MESSAGE.text).toContain('Close a session');
  });

  it('sufit NIEOSIĄGNIĘTY → brak zdania, bo nie ma o czym mówić', () => {
    expect(launchDetail({ paneCapReached: false, otherwiseCanLaunch: true })).toBeUndefined();
  });

  it('killswitch albo tylko-odczyt → milczenie, nie „zamknij którąś sesję"', () => {
    /*
     * To jest sedno reguły 2: przy `RAROG_HERDR_LAUNCH=0` zamknięcie panelu NICZEGO nie
     * odblokuje, więc rada byłaby fałszywą obietnicą. Puste `detail` oddaje głos ogólnemu
     * zdaniu PWA — i tym razem jest ono prawdziwe.
     */
    expect(launchDetail({ paneCapReached: true, otherwiseCanLaunch: false })).toBeUndefined();
    expect(launchDetail({ paneCapReached: false, otherwiseCanLaunch: false })).toBeUndefined();
  });

  it('transport ma pierwszeństwo — przy martwym herdr sufit nic nie znaczy', () => {
    const detail = launchDetail({
      transportDetail: foreign('herdr nie odpowiada'),
      paneCapReached: true,
      otherwiseCanLaunch: true,
    });
    expect(detail?.text).toBe('herdr nie odpowiada');
  });
});

describe('jedno zdanie, dwa wyjścia', () => {
  it('manager re-eksportuje DOKŁADNIE tę samą stałą co warstwa herdr', () => {
    // Dwie kopie tego samego copy rozjeżdżają się przy pierwszej poprawce — a tu rozjazd
    // znaczyłby, że odmowa POST-a mówi co innego niż wygaszony przycisk.
    expect(FROM_MANAGER).toBe(HERDR_PANE_CAP_MESSAGE);
  });

  it('`status()` liczy sufit i powód z tych samych dwóch faktów', () => {
    // Bez rozbicia na `paneCapReached` i `otherwiseCanLaunch` nie da się odpowiedzieć na
    // pytanie „czy sufit jest JEDYNYM powodem" — a od tego zależy, czy wolno pokazać radę.
    expect(SUPERVISOR_SRC).toContain('const paneCapReached = rarogPanes() >= maxPanes;');
    expect(SUPERVISOR_SRC).toContain('canLaunch: otherwiseCanLaunch && !paneCapReached,');
    expect(SUPERVISOR_SRC).toContain('const detail = launchDetail({');
  });
});
