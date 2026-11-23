/**
 * Allow-lista argumentów `claude` — jedyna rzecz między polem formularza a POWŁOKĄ panelu.
 *
 * `agent.start` nie robi `execve`: herdr wpisuje linię poleceń do pty istniejącego panelu
 * („Existing pane at an interactive shell prompt"), więc każdy element `args` jest tekstem
 * w shellu. Ten plik pilnuje dwóch rzeczy naraz: że Rarog składa dokładnie takie argumenty,
 * jakie zaplanowano, i że NIC innego nie ma prawa się tam znaleźć — ani flaga spoza listy,
 * ani argument pozycyjny, ani wartość z metaznakami powłoki.
 */
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_CLAUDE_FLAGS, ARG_VALUE_PATTERN, FORBIDDEN_CLAUDE_FLAGS, HerdrArgvError,
  VALUELESS_CLAUDE_FLAGS, assertAllowedArgs, buildClaudeArgs,
} from '../src/herdr/argv.ts';
import type { HerdrLaunchRequest } from '../src/herdr/types.ts';
import { ULTRACODE_FLAG_VALUE } from '../src/herdr/ultracode.ts';

const SID = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-8888-4777-8666-555555555555';
const CWD = '/Users/u/Projects/atlas';

function req(extra: Partial<HerdrLaunchRequest> = {}): HerdrLaunchRequest {
  return { cwd: CWD, ...extra };
}

describe('listy flag', () => {
  it('allow-lista ma dokładnie pięć flag z wartością i jedną bez', () => {
    // Rozszerzenie którejkolwiek listy ma być osobną, świadomą decyzją — nie skutkiem
    // ubocznym „drobnej poprawki" w launcherze.
    expect([...ALLOWED_CLAUDE_FLAGS].sort()).toEqual([
      '--effort', '--model', '--permission-mode', '--resume', '--session-id',
    ]);
    expect([...VALUELESS_CLAUDE_FLAGS]).toEqual(['--fork-session']);
  });

  it('żadna flaga zablokowana na stałe nie jest dozwolona', () => {
    for (const flag of FORBIDDEN_CLAUDE_FLAGS) {
      expect(ALLOWED_CLAUDE_FLAGS.has(flag)).toBe(false);
      expect(VALUELESS_CLAUDE_FLAGS.has(flag)).toBe(false);
    }
  });
});

describe('buildClaudeArgs — ścieżka domyślna', () => {
  it('bez modelu i effortu daje DOKŁADNIE `--session-id <uuid>`', () => {
    // Brak pola `model` = „model domyślny konta" = zero flagi. To jest ścieżka DOMYŚLNA
    // formularza, a nie przypadek brzegowy.
    expect(buildClaudeArgs(req(), SID)).toEqual(['--session-id', SID]);
  });

  it('z modelem, effortem i trybem daje dokładną tablicę w ustalonej kolejności', () => {
    const args = buildClaudeArgs(
      req({ model: 'sonnet', effort: 'high', permissionMode: 'acceptEdits' }), SID,
    );
    expect(args).toEqual([
      '--session-id', SID,
      '--model', 'sonnet',
      '--effort', 'high',
      '--permission-mode', 'acceptEdits',
    ]);
  });

  it('`bypassPermissions` przechodzi — o `RAROG_YOLO_ROOTS` decyduje manager, nie argv', () => {
    const args = buildClaudeArgs(req({ permissionMode: 'bypassPermissions' }), SID);
    expect(args).toEqual(['--session-id', SID, '--permission-mode', 'bypassPermissions']);
  });

  it('nie ma parametru na prompt — i to jest sprawdzane przez typy', () => {
    // Prompt startowy jedzie `agent.prompt` po `interactive_ready`. Gdyby ktoś dopisał
    // trzeci parametr, ten `@ts-expect-error` przestałby być błędem i `tsc -b` by tu padł.
    // @ts-expect-error buildClaudeArgs nie przyjmuje promptu i nigdy nie przyjmie
    expect(() => buildClaudeArgs(req(), SID, 'napraw buga')).not.toThrow();
  });
});

describe('buildClaudeArgs — wznowienie i rozwidlenie', () => {
  it('zwykłe wznowienie NIE podaje `--session-id` (CLI tego zabrania)', () => {
    /*
     * Zmierzone w `rarog-spike` — `claude` odpowiada wprost:
     *
     *     Error: --session-id can only be used with --continue or --resume
     *            if --fork-session is also specified.
     *
     * …i kończy się natychmiast. Panel wracał do powłoki, a sesja w Rarogu lądowała w `done`
     * z „panel zniknął z herdr" — czyli WZNAWIANIE Z TELEFONU nie działało wcale. Wznowiona
     * sesja zachowuje swój uuid, więc nie ma czego nadawać.
     */
    expect(buildClaudeArgs(req({ resumeFrom: OTHER }), SID)).toEqual(['--resume', OTHER]);
  });

  it('`fork` dokłada `--fork-session`, a nowy uuid różni się od wznawianego', () => {
    const args = buildClaudeArgs(req({ resumeFrom: OTHER, fork: true }), SID);
    expect(args).toEqual(['--session-id', SID, '--resume', OTHER, '--fork-session']);
    expect(SID).not.toBe(OTHER);
  });

  it('`fork` bez `resumeFrom` rzuca', () => {
    expect(() => buildClaudeArgs(req({ fork: true }), SID)).toThrow(HerdrArgvError);
  });

  it('`resumeFrom` równy `--session-id` rzuca (dwóch pisarzy na jednym jsonl)', () => {
    expect(() => buildClaudeArgs(req({ resumeFrom: SID }), SID)).toThrow(HerdrArgvError);
  });

  it('`resumeFrom` ze ścieżką w środku rzuca, zanim trafi do `join()`', () => {
    expect(() => buildClaudeArgs(req({ resumeFrom: '../../etc/passwd' }), SID))
      .toThrow(HerdrArgvError);
  });
});

describe('buildClaudeArgs — ultracode', () => {
  it('ultracode z `xhigh` daje `--effort ultracode` w miejscu poziomu', () => {
    const args = buildClaudeArgs(
      req({ model: 'opus[1m]', effort: 'xhigh', ultracode: true, permissionMode: 'auto' }), SID,
    );
    expect(args).toEqual([
      '--session-id', SID,
      '--model', 'opus[1m]',
      '--effort', ULTRACODE_FLAG_VALUE,
      '--permission-mode', 'auto',
    ]);
  });

  it('ultracode bez effortu też daje `--effort ultracode` (CLI ustawia wtedy `xhigh`)', () => {
    expect(buildClaudeArgs(req({ ultracode: true }), SID))
      .toEqual(['--session-id', SID, '--effort', ULTRACODE_FLAG_VALUE]);
  });

  it('ultracode z poziomem innym niż `xhigh` rzuca (druga linia obrony po kontrakcie)', () => {
    expect(() => buildClaudeArgs(req({ ultracode: true, effort: 'high' }), SID)).toThrow(HerdrArgvError);
    expect(() => buildClaudeArgs(req({ ultracode: true, effort: 'max' }), SID)).toThrow(HerdrArgvError);
  });

  it('`ultracode: false` i brak pola nie zmieniają argv', () => {
    expect(buildClaudeArgs(req({ effort: 'high', ultracode: false }), SID))
      .toEqual(['--session-id', SID, '--effort', 'high']);
  });

  it('ultracode przy wznowieniu stoi po `--resume`, jedna flaga `--effort`', () => {
    expect(buildClaudeArgs(req({ resumeFrom: OTHER, ultracode: true }), SID))
      .toEqual(['--resume', OTHER, '--effort', ULTRACODE_FLAG_VALUE]);
  });

  it('allow-lista bez zmian: `--settings` dalej zabronione', () => {
    expect(FORBIDDEN_CLAUDE_FLAGS).toContain('--settings');
    expect(() => assertAllowedArgs(['--session-id', SID, '--settings', 'ultracode.json'])).toThrow(HerdrArgvError);
  });
});

describe('buildClaudeArgs — odrzucenia semantyczne', () => {
  it('model spoza wzorca rzuca', () => {
    expect(() => buildClaudeArgs(req({ model: 'Sonnet 4' }), SID)).toThrow(HerdrArgvError);
  });

  it('wariant okna `[1m]` przechodzi, inny sufiks w nawiasie — nie', () => {
    expect(buildClaudeArgs(req({ model: 'opus[1m]' }), SID)).toContain('opus[1m]');
    expect(buildClaudeArgs(req({ model: 'claude-fable-5[1m]' }), SID)).toContain('claude-fable-5[1m]');
    expect(() => buildClaudeArgs(req({ model: 'opus[2m]' }), SID)).toThrow(HerdrArgvError);
    expect(() => buildClaudeArgs(req({ model: 'opus[1m' }), SID)).toThrow(HerdrArgvError);
    expect(() => buildClaudeArgs(req({ model: '[1m]' }), SID)).toThrow(HerdrArgvError);
  });

  it('effort spoza listy poziomów rzuca', () => {
    const bad = { cwd: CWD, effort: 'ultracode' } as unknown as HerdrLaunchRequest;
    expect(() => buildClaudeArgs(bad, SID)).toThrow(HerdrArgvError);
  });

  it('tryb uprawnień spoza listy rzuca', () => {
    expect(() => buildClaudeArgs(req({ permissionMode: 'default' }), SID))
      .toThrow(HerdrArgvError);
  });

  it('`--session-id` bez kształtu identyfikatora rzuca', () => {
    expect(() => buildClaudeArgs(req(), 'nie ma takiego uuida')).toThrow(HerdrArgvError);
  });

  it('wartość udająca flagę nie przechodzi przez model', () => {
    expect(() => buildClaudeArgs(req({ model: '--settings' }), SID)).toThrow(HerdrArgvError);
  });
});

describe('assertAllowedArgs — bramka po zbudowaniu tablicy', () => {
  it('przepuszcza tablicę z buildClaudeArgs', () => {
    const args = buildClaudeArgs(req({ model: 'opus', effort: 'max' }), SID);
    expect(() => assertAllowedArgs(args)).not.toThrow();
  });

  it('odrzuca pustą tablicę (bez `--session-id` nie znamy ścieżki jsonl)', () => {
    expect(() => assertAllowedArgs([])).toThrow(HerdrArgvError);
  });

  it('odrzuca flagę spoza allow-listy', () => {
    for (const flag of FORBIDDEN_CLAUDE_FLAGS) {
      expect(() => assertAllowedArgs(['--session-id', SID, flag])).toThrow(HerdrArgvError);
    }
  });

  it('odrzuca `--dangerously-skip-permissions` wstrzyknięte ręcznie', () => {
    expect(() => assertAllowedArgs(['--dangerously-skip-permissions']))
      .toThrow(HerdrArgvError);
  });

  it('odrzuca ARGUMENT POZYCYJNY — także wtedy, gdy reszta tablicy jest poprawna', () => {
    // To jest kanał, którym prompt użytkownika mógłby wjechać do linii poleceń powłoki.
    expect(() => assertAllowedArgs(['napraw buga', '--session-id', SID]))
      .toThrow(HerdrArgvError);
    expect(() => assertAllowedArgs(['--session-id', SID, 'napraw buga']))
      .toThrow(HerdrArgvError);
  });

  it('odrzuca flagę bez wartości i wartość udającą flagę', () => {
    expect(() => assertAllowedArgs(['--session-id'])).toThrow(HerdrArgvError);
    expect(() => assertAllowedArgs(['--model', '--settings'])).toThrow(HerdrArgvError);
  });

  it('odrzuca powtórzoną flagę', () => {
    expect(() => assertAllowedArgs(['--model', 'opus', '--model', 'sonnet']))
      .toThrow(HerdrArgvError);
  });

  it('nie cytuje w komunikacie elementu, który nie wygląda jak flaga', () => {
    // Element spoza schematu bywa promptem albo sekretem, a komunikaty błędów bywają logowane.
    try {
      assertAllowedArgs(['sk-tajny-klucz-uzytkownika']);
      expect.unreachable('powinno rzucić');
    } catch (err) {
      expect((err as Error).message).not.toContain('sk-tajny-klucz-uzytkownika');
      expect((err as HerdrArgvError).code).toBe('bad-request');
    }
  });
});

describe('ARG_VALUE_PATTERN — metaznaki powłoki', () => {
  // KAŻDA z tych wartości trafiłaby DO POWŁOKI panelu, gdyby przeszła: `agent.start` wpisuje
  // linię poleceń do pty, a `assertSendable` czyści znaki sterujące TERMINALA, nie shella.
  const SHELL: readonly string[] = [
    '\'"$(id)', 'a b', 'x;y', '$(whoami)', 'a\nb', '`id`', 'a|b', 'a&&b', 'a>b',
    '../../etc/passwd', 'a\\b', '', 'a'.repeat(65),
  ];

  for (const value of SHELL) {
    it(`odrzuca wartość ${JSON.stringify(value)}`, () => {
      expect(ARG_VALUE_PATTERN.test(value)).toBe(false);
      expect(() => assertAllowedArgs(['--model', value])).toThrow(HerdrArgvError);
    });
  }

  it('przepuszcza uuid, alias modelu i poziom effortu', () => {
    for (const value of [SID, 'sonnet', 'claude-fable-5', 'opus[1m]', 'high', 'acceptEdits']) {
      expect(ARG_VALUE_PATTERN.test(value)).toBe(true);
    }
  });
});
