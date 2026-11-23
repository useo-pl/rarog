/*
 * Skrypt restartu serwera: `restart.sh`, wykonawca `rarog restart`.
 *
 * Trzy klasy asercji:
 * 1. składnia i lint — `bash -n`, ShellCheck (gdy jest w PATH);
 * 2. `restart.sh` startuje serwer przez usługę launchd albo `rarog serve`, nigdy tsx wprost;
 * 3. zachowanie `restart.sh` z parametrami od `rarog restart` i PODSTAWIONYMI programami (`launchctl`, `curl`,
 *    `pgrep`, `pkill`, `lsof`) w katalogu tymczasowym — bez dotykania prawdziwego launchd ani portu 8930.
 * Parametry i odmowy samego `restart.sh` sprawdza `rarog-restart.test.ts`.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RESTART_HOOK_REPAIR } from '../src/install/repair.ts';
import { IS_MAC, macOnly } from './platform.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => readFileSync(path.join(repoRoot, rel), 'utf8');

const SCRIPTS = ['scripts/restart.sh'] as const;
const LABEL = 'ai.rarog.server';
const PORT = '8930';

function inPath(bin: string): boolean {
  return spawnSync('which', [bin], { encoding: 'utf8' }).status === 0;
}
const hasShellcheck = inPath('shellcheck');

describe('skrypty cyklu życia: składnia i lint', () => {
  it.each(SCRIPTS)('`bash -n %s` przechodzi', (rel) => {
    const res = spawnSync('bash', ['-n', rel], { cwd: repoRoot, encoding: 'utf8' });
    expect(res.stderr).toBe('');
    expect(res.status).toBe(0);
  });

  it.skipIf(!hasShellcheck)('ShellCheck nie zgłasza nic w żadnym skrypcie (requires shellcheck)', () => {
    const res = spawnSync('shellcheck', [...SCRIPTS], { cwd: repoRoot, encoding: 'utf8' });
    expect(res.stdout + res.stderr).toBe('');
    expect(res.status).toBe(0);
  });
});

describe('środowisko serwera składa `rarog serve`', () => {
  it('`restart.sh` kickstartuje usługę albo uruchamia `rarog serve` (nohup) — nigdy tsx wprost', () => {
    const restart = read('scripts/restart.sh');
    expect(restart).toContain('nohup node bin/rarog.mjs serve');
    expect(restart).toContain(`launchctl print "$LAUNCHD_TARGET"`);
    expect(restart).toContain(`launchctl kickstart "$LAUNCHD_TARGET"`);
    expect(restart).toContain(`SERVICE_LABEL="${LABEL}"`);
    expect(restart).not.toMatch(/^\s*(nohup\s+)?\.\/node_modules\/\.bin\/tsx/m);
  });
});

/**
 * Atrapy binarek dla `restart.sh`: log wywołań `launchctl` do pliku, `curl` oddający zadany
 * JSON, `pgrep`/`pkill` „nic nie działa". Reszta (`seq`, `sleep`, `id`, `tail`) jest prawdziwa.
 */
interface Sandbox {
  home: string;
  bin: string;
  launchctlLog: string;
  run(env: Record<string, string>): { status: number | null; stdout: string; stderr: string };
}

function makeSandbox(): Sandbox {
  const home = mkdtempSync(path.join(tmpdir(), 'rarog-restart-'));
  const bin = path.join(home, 'bin');
  mkdirSync(bin);
  const launchctlLog = path.join(home, 'launchctl.log');
  const fake = (name: string, body: string): void => {
    const file = path.join(bin, name);
    writeFileSync(file, `#!/bin/bash\n${body}\n`);
    chmodSync(file, 0o755);
  };
  fake('launchctl', [
    `printf '%s\\n' "$*" >> "${launchctlLog}"`,
    'case "$1" in',
    '  print) [ "${FAKE_LAUNCHD_LOADED:-0}" = 1 ] && exit 0 || exit 1 ;;',
    '  kickstart) exit 0 ;;',
    '  *) exit 1 ;;',
    'esac',
  ].join('\n'));
  fake('curl', 'printf \'%s\' "$FAKE_HEALTH"');
  // `pgrep` oddaje `FAKE_PATTERN_PIDS` (tylko żywe, jak `lsof` niżej) — „procesy o argv serwera".
  fake('pgrep', [
    'found=1',
    'for p in ${FAKE_PATTERN_PIDS:-}; do',
    '  stat="$(ps -p "$p" -o stat= 2>/dev/null || true)"',
    '  case "$stat" in \'\'|Z*) ;; *) echo "$p"; found=0 ;; esac',
    'done',
    'exit $found',
  ].join('\n'));
  fake('pkill', 'exit 1');
  /*
   * `lsof` jest ATRAPĄ, bo zatrzymanie idzie po PORCIE, nie po argv. `FAKE_LISTENERS` = PID-y
   * „nasłuchujące na 8930", ale zgłaszamy tylko te, które JESZCZE ŻYJĄ — inaczej `running()` nigdy
   * by nie zgasło i skrypt zawsze dobijałby SIGKILL-em. Stan `Z` (zombie) liczy się jako martwy: proces ubity, ale jeszcze
   * niepogrzebany przez rodzica, nie trzyma gniazda i prawdziwy `lsof` też by go nie pokazał
   * — a w teście rodzicem jest node zablokowany na `spawnSync`, więc żniwa idą dopiero potem.
   * `kill` zostaje PRAWDZIWY: testy podstawiają pod niego własny `sleep`, więc sprawdzamy
   * skutek, a nie to, że skrypt wywołał funkcję.
   */
  fake('lsof', [
    // Katalog roboczy kandydata z wzorca (`-a -p <pid> -d cwd`) czyta prawdziwy `lsof`: test sprawdza skutek filtra.
    'case " $* " in *" -d cwd "*) exec /usr/sbin/lsof "$@" ;; esac',
    'for p in ${FAKE_LISTENERS:-}; do',
    '  stat="$(ps -p "$p" -o stat= 2>/dev/null || true)"',
    '  case "$stat" in \'\'|Z*) ;; *) echo "$p" ;; esac',
    'done',
    'exit 0',
  ].join('\n'));
  return {
    home, bin, launchctlLog,
    run: (env) => spawnSync('bash', ['scripts/restart.sh'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: home,
        RAROG_RESTART_LABEL: LABEL,
        RAROG_RESTART_PORT: PORT,
        RAROG_LOG: path.join(home, 'server.log'),
        RAROG_RESTART_HOOK_REPAIR: RESTART_HOOK_REPAIR,
        ...env,
      },
    }),
  };
}

describe.skipIf(!IS_MAC)(macOnly('`restart.sh` z podstawionym launchctl', 'launchd'), () => {
  let sb: Sandbox;
  beforeEach(() => { sb = makeSandbox(); });
  afterEach(() => { rmSync(sb.home, { recursive: true, force: true }); });

  const HEALTHY = '{"ok":true,"version":"t","uptime":1,"herdr":true,"term":true}';

  it('usługa załadowana → `kickstart` bez `-k`, bez nohup; kończy się OK', () => {
    const res = sb.run({ FAKE_LAUNCHD_LOADED: '1', FAKE_HEALTH: HEALTHY });
    expect(res.stderr).toBe('');
    expect(res.status).toBe(0);
    const uid = execFileSync('id', ['-u'], { encoding: 'utf8' }).trim();
    const calls = readFileSync(sb.launchctlLog, 'utf8').trim().split('\n');
    // The second `print` reads the PID of the running instance for the stop step.
    expect(calls).toEqual([
      `print gui/${uid}/${LABEL}`,
      `print gui/${uid}/${LABEL}`,
      `kickstart gui/${uid}/${LABEL}`,
    ]);
    expect(res.stdout).toContain('start: launchd');
    expect(res.stdout).not.toContain('nohup');
    expect(res.stdout).toContain('OK: ');
  });

  it('`hook: stale` w health → linia naprawy ze zdaniem z `RAROG_RESTART_HOOK_REPAIR`, restart zielony', () => {
    const stale = '{"ok":true,"version":"t","uptime":1,"herdr":true,"term":true,"hook":"stale"}';
    const res = sb.run({ FAKE_LAUNCHD_LOADED: '1', FAKE_HEALTH: stale });
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain('herdr: true · term: true · hook: stale\n'
      + `hook: the copy in ~/.claude/hooks/rarog/ differs from the repo — ${RESTART_HOOK_REPAIR}\n`);
    const custom = sb.run({
      FAKE_LAUNCHD_LOADED: '1', FAKE_HEALTH: stale, RAROG_RESTART_HOOK_REPAIR: 'zdanie od frontu 100% `x` $HOME',
    });
    expect(custom.stdout).toContain('differs from the repo — zdanie od frontu 100% `x` $HOME\n');
    const healthy = sb.run({ FAKE_LAUNCHD_LOADED: '1', FAKE_HEALTH: HEALTHY });
    expect(healthy.stdout).not.toContain('differs from the repo');
  });

  // Starszy serwer mówi `brak`, nowszy `missing`: skrypt drukuje słowo, jakie przyszło, a naprawę daje tylko `stale`.
  it('`hook: brak` i `hook: missing` w health → słowo w linii stanu, bez linii naprawy, restart zielony', () => {
    for (const word of ['brak', 'missing']) {
      const health = `{"ok":true,"version":"t","uptime":1,"herdr":true,"term":true,"hook":"${word}"}`;
      const res = sb.run({ FAKE_LAUNCHD_LOADED: '1', FAKE_HEALTH: health });
      expect(res.status, `${word}: ${res.stderr}`).toBe(0);
      expect(res.stdout).toContain(`herdr: true · term: true · hook: ${word}\n`);
      expect(res.stdout).not.toContain('differs from the repo');
    }
  });

  it('`herdr:false` w health → wyjście ≠ 0 z komunikatem, co sprawdzić', () => {
    const res = sb.run({
      FAKE_LAUNCHD_LOADED: '1',
      FAKE_HEALTH: '{"ok":true,"version":"t","uptime":1,"herdr":false,"term":true}',
    });
    expect(res.status).toBe(2);
    // Serwer żyje (status 200 z atrapy), więc oba pola są wypisane…
    expect(res.stdout).toContain('herdr: false · term: true');
    // …ale restart jest CZERWONY i mówi, gdzie szukać.
    expect(res.stderr).toContain('herdr');
    expect(res.stderr).toContain('herdr agent list');
  });

  /*
   * Stopping by PORT. argv patterns are coupled to a tsx implementation detail — measured on a live
   * system: `pgrep -f "tsx server/src/index.ts"` matched NOTHING, and the second pattern caught only the
   * child process. A tsx bump would break a stop by argv alone silently: `running()` would say "no
   * server", and the new instance would fail with EADDRINUSE into the log.
   */
  it('ubija proces trzymający port, choć jego argv nie pasuje do żadnego wzorca', async () => {
    // Prawdziwy proces o argv, którego wzorce NIE łapią — dokładnie sytuacja po bumpie tsx.
    const victim = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    victim.unref();
    const pid = victim.pid!;
    const exited = new Promise<NodeJS.Signals | null>((resolve) => {
      victim.on('exit', (_code, signal) => { resolve(signal); });
    });
    try {
      const res = sb.run({
        FAKE_LAUNCHD_LOADED: '1', FAKE_HEALTH: HEALTHY, FAKE_LISTENERS: String(pid),
      });
      expect(res.status, res.stderr).toBe(0);
      // Skutek, nie wywołanie: proces trzymający port dostał SIGTERM i zszedł.
      expect(await exited).toBe('SIGTERM');
      // Bez dobijania SIGKILL-em — ścieżka jest czysta, więc stderr milczy.
      expect(res.stderr).toBe('');
    } finally {
      try { process.kill(pid, 'SIGKILL'); } catch { /* już nie żyje — o to chodziło */ }
    }
  });

  /*
   * The argv pattern also matches the demo server from agent worktrees (`pnpm run demo:server` under the
   * XCUITest run of `ios-check.sh`), and a production restart must not kill it in the middle of another
   * agent's gate. A pattern candidate goes down only without `RAROG_DEMO=1` and without a foreign
   * `RAROG_PORT` (`ps -E`).
   */
  it('wzorzec argv nie zabija serwera demo ani serwera na innym porcie', async () => {
    // `node`, nie `sleep`: `ps -E` nie pokazuje środowiska binarek systemowych z `/bin` (zmierzone),
    // a serwer i demo to właśnie procesy node.
    const start = (env: Record<string, string>, cwd = repoRoot) => {
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)'], {
        detached: true, stdio: 'ignore', cwd, env: { PATH: '/usr/bin:/bin', ...env },
      });
      child.unref();
      const exited = new Promise<NodeJS.Signals | null>((resolve) => {
        child.on('exit', (_code, signal) => { resolve(signal); });
      });
      return { pid: child.pid!, exited };
    };
    const prod = start({});
    const demo = start({ RAROG_DEMO: '1', RAROG_PORT: '18952' });
    const other = start({ RAROG_PORT: '18961' });
    // `Number('+18952')` to 18952 — serwer słucha na obcym porcie, choć zapis nie jest samymi cyframi.
    const signed = start({ RAROG_PORT: '+18952' });
    // Serwer innego projektu o tym samym argv (`node server/src/index.js`), bez żadnej zmiennej Raroga: obcy
    // katalog roboczy.
    const foreign = start({ PORT: '3000' }, sb.home);
    try {
      const res = sb.run({
        FAKE_LAUNCHD_LOADED: '1', FAKE_HEALTH: HEALTHY,
        FAKE_PATTERN_PIDS: `${prod.pid} ${demo.pid} ${other.pid} ${signed.pid} ${foreign.pid}`,
      });
      expect(res.status, res.stderr).toBe(0);
      expect(await prod.exited).toBe('SIGTERM');
      // Demo, serwery na obcym porcie i serwer z obcego katalogu żyją dalej (sygnał 0 = samo sprawdzenie istnienia).
      expect(() => process.kill(demo.pid, 0)).not.toThrow();
      expect(() => process.kill(other.pid, 0)).not.toThrow();
      expect(() => process.kill(signed.pid, 0)).not.toThrow();
      expect(() => process.kill(foreign.pid, 0)).not.toThrow();
      expect(res.stderr).toBe('');
    } finally {
      for (const pid of [prod.pid, demo.pid, other.pid, signed.pid, foreign.pid]) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* już nie żyje */ }
      }
    }
  });

  /*
   * Okres zmiany nazwy: `rarog serve` przyjmuje zmienne pod obiema nazwami, więc demo albo serwer na obcym
   * porcie bywa uruchomiony z którąkolwiek. Nazwy z modułu starych nazw, żeby przepisanie literałów nie
   * zgubiło przypadku starej nazwy.
   */
  it('demo i obcy port żyją dalej; ten sam port to nasz serwer', async () => {
    const start = (env: Record<string, string>) => {
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)'], {
        detached: true, stdio: 'ignore', cwd: repoRoot, env: { PATH: '/usr/bin:/bin', ...env },
      });
      child.unref();
      const exited = new Promise<NodeJS.Signals | null>((resolve) => {
        child.on('exit', (_code, signal) => { resolve(signal); });
      });
      return { pid: child.pid!, exited };
    };
    const survivors = [start({ RAROG_DEMO: '1' }), start({ RAROG_PORT: '18961' })];
    const prod = start({ RAROG_PORT: PORT });
    const all = [prod, ...survivors];
    try {
      const res = sb.run({
        FAKE_LAUNCHD_LOADED: '1', FAKE_HEALTH: HEALTHY, FAKE_PATTERN_PIDS: all.map((c) => c.pid).join(' '),
      });
      expect(res.status, res.stderr).toBe(0);
      expect(await prod.exited).toBe('SIGTERM');
      for (const c of survivors) expect(() => process.kill(c.pid, 0)).not.toThrow();
      expect(res.stderr).toBe('');
    } finally {
      for (const c of all) {
        try { process.kill(c.pid, 'SIGKILL'); } catch { /* już nie żyje */ }
      }
    }
  });

  it('log z `RAROG_LOG`; bez niego brak parametru, nic nie zatrzymane', () => {
    const ok = sb.run({ FAKE_LAUNCHD_LOADED: '1', FAKE_HEALTH: HEALTHY, RAROG_LOG: path.join(sb.home, 'nowy', 'server.log') });
    expect(ok.status, ok.stderr).toBe(0);
    expect(existsSync(path.join(sb.home, 'nowy'))).toBe(true);
    const missing = sb.run({ FAKE_LAUNCHD_LOADED: '1', FAKE_HEALTH: HEALTHY, RAROG_LOG: '' });
    expect(missing.status).toBe(64);
    expect(missing.stderr).toContain('missing parameter RAROG_LOG');
  });

  /*
   * The loop reads `uptime` from `/health`, not only the 200 status and two booleans. When the stop
   * misses and the new instance fails with EADDRINUSE (to the log, not the screen), the OLD process
   * answers, and the user would get a green restart while still working on the code from before the
   * change (tsx does not reload code live).
   */
  it('health od procesu STARSZEGO niż ten restart jest błędem, nie sukcesem', () => {
    const res = sb.run({
      FAKE_LAUNCHD_LOADED: '1',
      FAKE_HEALTH: '{"ok":true,"version":"t","uptime":9999,"herdr":true,"term":true}',
    });
    expect(res.status).toBe(3);
    expect(res.stderr).toContain('older than this restart');
    expect(res.stderr).toContain('EADDRINUSE');
  });
});
