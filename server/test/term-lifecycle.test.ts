/**
 * Terminal PTY — decyzje cyklu życia i granica sekretów.
 *
 * Wszystko tutaj jest CZYSTE: żadnego herdr, żadnego procesu, żadnego gniazda. To jest cała
 * treść podziału na `lifecycle.ts` i resztę modułu — bezpiecznik respawnu i żniwiarz to
 * logika, której nie da się sprawdzić na żywo (trzeba by czekać tydzień albo wywrócić
 * kontroler panelu trzy razy pod rząd).
 */
import { describe, expect, it } from 'vitest';
import { TERM_ID_LENGTH, TERM_ID_RE, TERM_SLOTS_MAX } from '@rarog/shared';
import { loadConfig } from '../src/config.ts';
import { claudePaneLabel, projectKey, termPaneLabel } from '../src/herdr/provenance.ts';
import {
  TERM_RESPAWN_LIMIT, TERM_SOCKET_BUFFER_LIMIT_BYTES,
  isBreakerTripped, matchTermId, matchTermLabel, recordCrash, shouldPausePty, shouldReap,
  shouldTerminateSocket, termIdFor,
} from '../src/term/lifecycle.ts';

const BASE_ENV: NodeJS.ProcessEnv = {
  RAROG_ORIGINS: 'https://rarog.example',
  RAROG_TERM: '1',
};

describe('tożsamość terminala', () => {
  it('id to 16 hex z sha256 realpath — stabilne dla tej samej ścieżki', () => {
    const id = termIdFor('/Users/x/Projects/rarog');
    expect(id).toHaveLength(TERM_ID_LENGTH);
    expect(TERM_ID_RE.test(id)).toBe(true);
    expect(termIdFor('/Users/x/Projects/rarog')).toBe(id);
  });

  it('ścieżki różniące się jednym znakiem NIE kolidują (powód odrzucenia sluga)', () => {
    // `cli-store.ts` jest stratny z własnej deklaracji: `~/Projects/stare`
    // i `~/Projects-stare` dają ten sam slug. Tu kolizja znaczyłaby powłokę w cudzym katalogu.
    expect(termIdFor('/Users/x/Projects/stare')).not.toBe(termIdFor('/Users/x/Projects-stare'));
  });

  /*
   * REGRESSION: the slot separator must not be a character allowed in a POSIX path. With `#` the
   * hash material would be AMBIGUOUS and both calls below would give `18eca2443f94c1b6`: the folder
   * `foo#2` under Rarog's roots would hit the existing registry entry `('/…/foo', 2)` with
   * `POST /api/term` and get a shell in SOMEONE ELSE's folder, and the ownership gate
   * (`token rarog-term === id`) would let attach, kill and history reads through to that pane. NUL
   * cannot occur in a POSIX path, so the split is unambiguous.
   */
  it('slot NIE koliduje ze ścieżką, w której `#N` jest częścią nazwy katalogu', () => {
    expect(termIdFor('/Users/x/Projects/foo', 2)).not.toBe(termIdFor('/Users/x/Projects/foo#2'));
    expect(termIdFor('/Users/x/Projects/foo', 3))
      .not.toBe(termIdFor('/Users/x/Projects/foo#3', 1));
  });

  /*
   * Zgodność wsteczna slotu 1 jest WARUNKIEM, nie ozdobą: te wartości siedzą w tokenach
   * `rarog-term` żywych paneli herdr, w kluczach `term-herdr.json` i w trasach `#/terminal/<id>`
   * zapisanych w PWA. Literał niżej jest hashem sprzed zmiany rozdzielacza.
   */
  it('slot 1 liczy się bez sufiksu — zmiana rozdzielacza go nie ruszyła', () => {
    expect(termIdFor('/Users/x/Projects/foo#2', 1)).toBe('18eca2443f94c1b6');
    expect(termIdFor('/Users/x/Projects/rarog', 1)).toBe(termIdFor('/Users/x/Projects/rarog'));
  });

  /*
   * ROLE POPUPOWE (`lazygit`, `popup`) mają WŁASNE
   * przestrzenie tożsamości. Trzy warunki naraz: nie wolno im wejść w żaden slot (to byłaby
   * powłoka cudzego taba pod adresem popupu), nie wolno im ruszyć identyfikatorów slotów (te
   * siedzą w tokenach żywych paneli herdr, w kluczach `term-herdr.json` i w trasach
   * `#/terminal/<id>` zapisanych w PWA) i nie wolno im zderzyć się ze sobą — lazygit i terminal
   * tego samego projektu to DWA panele, które wolno mieć naraz.
   */
  it.each(['lazygit', 'popup'] as const)(
    'id roli %s nie koliduje z żadnym slotem tego samego katalogu',
    (role) => {
      const cwd = '/Users/x/Projects/rarog';
      const id = termIdFor(cwd, 0, role);
      expect(TERM_ID_RE.test(id)).toBe(true);
      for (let slot = 1; slot <= TERM_SLOTS_MAX; slot += 1) {
        expect(id).not.toBe(termIdFor(cwd, slot));
      }
      // Slot jest przy tych rolach IGNOROWANY — jeden taki panel na katalog, zawsze ten sam.
      expect(termIdFor(cwd, 3, role)).toBe(id);
      expect(id).not.toBe(termIdFor('/Users/x/Projects/inny', 0, role));
    },
  );

  it('lazygit i popup tego samego katalogu to DWA różne panele', () => {
    const cwd = '/Users/x/Projects/rarog';
    expect(termIdFor(cwd, 0, 'lazygit')).not.toBe(termIdFor(cwd, 0, 'popup'));
  });

  it('sloty i domyślna rola liczą się DOKŁADNIE tak jak przed rolami popupowymi', () => {
    // Bramka regresji: gdyby rola weszła do materiału hasha także dla `shell`, adopcja po
    // restarcie nie poznałaby ani jednego istniejącego terminala.
    expect(termIdFor('/Users/x/Projects/foo#2', 1, 'shell')).toBe('18eca2443f94c1b6');
    expect(termIdFor('/Users/x/Projects/rarog', 2, 'shell'))
      .toBe(termIdFor('/Users/x/Projects/rarog', 2));
  });
});

/*
 * Granica sekretów przy powłoce: powłokę zakłada HERDR, nie Rarog, więc do samej
 * powłoki proces serwera nie wnosi już nic. `termEnvBase` żyje dalej, bo z niego bierze env
 * PROCES KONTROLERA (`herdr terminal session control`) — i to jest jedyne miejsce, przez które
 * cokolwiek z env serwera wychodzi w stronę terminala.
 */
describe('termEnvBase — sekrety Raroga nie wychodzą w stronę terminala', () => {
  it('przepuszcza DOKŁADNIE zamkniętą listę', () => {
    const config = loadConfig({
      ...BASE_ENV,
      HOME: '/Users/x',
      USER: 'x',
      LOGNAME: 'x',
      SHELL: '/bin/zsh',
      LANG: 'pl_PL.UTF-8',
      TMPDIR: '/tmp/x/',
      PATH: '/usr/bin',
      // Gniazdo ssh-agenta nie przechodzi: powłokę zakłada herdr ze swoim env.
      SSH_AUTH_SOCK: '/tmp/agent.sock',
    });
    expect(Object.keys(config.termEnvBase).sort()).toEqual([
      'HOME', 'LANG', 'LOGNAME', 'PATH', 'SHELL', 'TMPDIR', 'USER',
    ]);
  });

  it('klucz Soniox NIE przechodzi — nawet gdy jest w env serwera', () => {
    const config = loadConfig({
      ...BASE_ENV,
      HOME: '/Users/x',
      PATH: '/usr/bin',
      SONIOX_API_KEY: 'sekret-soniox',
      ANTHROPIC_API_KEY: 'sk-test',
      RAROG_YOLO_ROOTS: '/Users/x/Projects',
    });
    const env = config.termEnvBase;
    expect(Object.keys(env)).toEqual(['HOME', 'PATH']);
    // Tokenu Raroga już nie ma (logowanie tokenem usunięte), więc sekret Raroga reprezentuje tu klucz Soniox.
    expect(Object.values(env)).not.toContain('sekret-soniox');
    expect(Object.values(env)).not.toContain('sk-test');
  });

  it('pusta wartość znaczy BRAK zmiennej (`env -i` przekazuje puste jawnie)', () => {
    const config = loadConfig({ ...BASE_ENV, HOME: '/Users/x', TMPDIR: '' });
    expect(Object.keys(config.termEnvBase)).not.toContain('TMPDIR');
  });
});

describe('bezpiecznik respawnu', () => {
  it('trzy pady w oknie 30 s kładą terminal w stan failed', () => {
    let history: number[] = [];
    for (let i = 0; i < TERM_RESPAWN_LIMIT - 1; i += 1) {
      history = recordCrash(history, 1_000 + i * 1_000);
      expect(isBreakerTripped(history)).toBe(false);
    }
    history = recordCrash(history, 3_000);
    expect(isBreakerTripped(history)).toBe(true);
  });

  it('pady starsze niż okno wypadają — powolne pady nie wyzwalają bezpiecznika', () => {
    let history = recordCrash([], 0);
    history = recordCrash(history, 40_000);
    history = recordCrash(history, 80_000);
    expect(history).toEqual([80_000]);
    expect(isBreakerTripped(history)).toBe(false);
  });

  it('nie mutuje wejścia — historia należy do rejestru, decyzja do tego modułu', () => {
    const history: readonly number[] = [1_000];
    expect(recordCrash(history, 2_000)).not.toBe(history);
    expect(history).toEqual([1_000]);
  });
});

describe('backpressure — polityka SSE, nie pauza zbiorowa', () => {
  it('zrywamy gniazdo dopiero POWYŻEJ progu', () => {
    expect(shouldTerminateSocket(TERM_SOCKET_BUFFER_LIMIT_BYTES)).toBe(false);
    expect(shouldTerminateSocket(TERM_SOCKET_BUFFER_LIMIT_BYTES + 1)).toBe(true);
  });

  it('wolne gniazdo nie zatrzymuje szybkiego', () => {
    expect(shouldPausePty([TERM_SOCKET_BUFFER_LIMIT_BYTES * 2, 0])).toBe(false);
  });

  it('pauzujemy, gdy WSZYSTKIE gniazda są nad progiem albo nie ma żadnego', () => {
    expect(shouldPausePty([TERM_SOCKET_BUFFER_LIMIT_BYTES * 2])).toBe(true);
    expect(shouldPausePty([])).toBe(true);
  });
});

describe('żniwiarz bezczynności', () => {
  const DAY = 24 * 3600 * 1000;
  const now = 1_800_000_000_000;
  const idleSince = (days: number): number => Math.floor((now - days * DAY) / 1000);

  it('zabija wyłącznie powłoki Raroga, bez klienta, po czasie', () => {
    const idle = { owned: true, activityEpochSec: idleSince(8), attached: false };
    expect(shouldReap(idle, now, 7)).toBe(true);
  });

  /*
   * `owned` zamiast nazwy sesji: powłoka w herdr nie ma żadnej nazwy `rarog-…` —
   * własność potwierdza token panelu (`rarog-term`). Cudzy panel człowieka ma tu `false`.
   */
  it('nie tyka cudzych powłok (cudzy panel w herdr)', () => {
    const foreign = { owned: false, activityEpochSec: idleSince(400), attached: false };
    expect(shouldReap(foreign, now, 7)).toBe(false);
  });

  it('nie tyka powłok z podłączonym klientem ani świeżych', () => {
    expect(shouldReap(
      { owned: true, activityEpochSec: idleSince(400), attached: true }, now, 7,
    )).toBe(false);
    expect(shouldReap(
      { owned: true, activityEpochSec: idleSince(6), attached: false }, now, 7,
    )).toBe(false);
  });
});

/*
 * Etykieta PANELU terminala → tożsamość dla KONKRETNEGO katalogu. Hash jest
 * jednokierunkowy, więc jedyną drogą jest próba każdego slotu i każdej roli popupowej; ta sama
 * próba jest DOWODEM, że etykieta należy do tej ścieżki (resolver workspace'u i adopcja).
 */
describe('matchTermLabel — etykieta `rarog-term <id>` dla katalogu', () => {
  const REAL = '/Users/x/Projects/rarog';

  it('rozpoznaje każdy slot 1…TERM_SLOTS_MAX jako rolę `shell`', () => {
    for (let slot = 1; slot <= TERM_SLOTS_MAX; slot += 1) {
      const id = termIdFor(REAL, slot);
      expect(matchTermLabel(termPaneLabel(id), REAL)).toEqual({ id, slot, role: 'shell' });
    }
  });

  it('rozpoznaje role popupowe ze slotem 0', () => {
    for (const role of ['lazygit', 'popup'] as const) {
      const id = termIdFor(REAL, 0, role);
      expect(matchTermLabel(termPaneLabel(id), REAL)).toEqual({ id, slot: 0, role });
    }
  });

  it('etykieta INNEJ ścieżki to `null` — przy żadnym slocie ani roli', () => {
    const inny = '/Users/x/Projects/inny';
    expect(matchTermLabel(termPaneLabel(termIdFor(inny)), REAL)).toBeNull();
    expect(matchTermLabel(termPaneLabel(termIdFor(inny, 3)), REAL)).toBeNull();
    expect(matchTermLabel(termPaneLabel(termIdFor(inny, 0, 'lazygit')), REAL)).toBeNull();
    // Slot ponad sufit to też „nie ten terminal" — Rarog nie zakłada piątego taba.
    expect(matchTermLabel(termPaneLabel(termIdFor(REAL, TERM_SLOTS_MAX + 1)), REAL)).toBeNull();
  });

  it('etykieta spoza wzorca, panelu Claude albo jej brak to `null`', () => {
    const id = termIdFor(REAL);
    expect(matchTermLabel(null, REAL)).toBeNull();
    expect(matchTermLabel(undefined, REAL)).toBeNull();
    expect(matchTermLabel(`rarog-term ${id} `, REAL)).toBeNull();
    expect(matchTermLabel(`Rarog-term ${id}`, REAL)).toBeNull();
    expect(matchTermLabel(id, REAL)).toBeNull();
    // Klucz projektu panelu Claude ma TEN SAM materiał co slot 1 — rozróżnia je prefiks.
    expect(matchTermLabel(claudePaneLabel(projectKey(REAL), '0123abcd'), REAL)).toBeNull();
  });

  it('matchTermId odpowiada na to samo pytanie bez etykiety (adopcja z tokenu)', () => {
    expect(matchTermId(termIdFor(REAL, 2), REAL)).toEqual({ id: termIdFor(REAL, 2), slot: 2, role: 'shell' });
    expect(matchTermId('0'.repeat(16), REAL)).toBeNull();
  });
});
