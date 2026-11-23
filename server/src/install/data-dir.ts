/**
 * Katalog danych instalacji: ten, którego użyje usługa serwera, a nie ten, który wynika z bieżącej powłoki. Reguła
 * katalogu (`shared/src/data-dir.mjs`) liczy go ze zmiennych środowiska, a usługa dostaje inne środowisko niż
 * powłoka: launchd żadnej zmiennej katalogu danych (macOS), jednostka `systemd --user` środowisko menedżera
 * użytkownika (Linux). Bez jednej reguły `rarog setup` pobrałby SDK tam, gdzie usługa go nie szuka.
 *
 * Kolejność: flaga `--data-dir` (instalacja z `rarog serve --data-dir`), katalog zainstalowanej usługi (z jej logu
 * `<katalog danych>/server.log`), reguła na środowisku usługi. Rozjazd flagi z usługą albo powłoki z wynikiem to
 * odmowa z obiema ścieżkami. Moduł importuje wyłącznie `node:*` i `@rarog/shared`.
 */
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR_ENV, XDG_DATA_HOME_ENV, dataDirConflictMessage, resolveDataDir } from '@rarog/shared/data-dir';

type Env = Readonly<Record<string, string | undefined>>;

export interface InstallDataDirInput {
  readonly home: string;
  /** Środowisko tej powłoki. */
  readonly shellEnv: Env;
  /** Środowisko, które dostaje usługa: na macOS bez zmiennych katalogu danych, na Linuksie środowisko menedżera. */
  readonly serviceEnv: Env;
  /** Wartość `--data-dir` (ścieżka bezwzględna); brak = bez flagi. */
  readonly flag?: string | undefined;
  /** Katalog danych zainstalowanej usługi (katalog jej logu); `null` = usługi nie ma albo jej plik nieczytelny. */
  readonly serviceDir?: string | null;
  /**
   * Komenda ponownej instalacji usługi dla komend bez `--data-dir` (`rarog restart`): rozjazd radzi ją albo
   * uruchomienie bez zmiennych powłoki zamiast `--data-dir`. Brak = rada z `--data-dir` (`rarog setup`).
   */
  readonly reinstall?: string;
}

/** Skąd katalog: `flag` — `--data-dir`; `service` — zainstalowana usługa; `rule` — reguła na środowisku usługi. */
export type InstallDataDirSource = 'flag' | 'service' | 'rule';

export type InstallDataDir =
  | { readonly ok: true; readonly dir: string; readonly source: InstallDataDirSource }
  | { readonly ok: false; readonly message: string };

/** Zmienne katalogu danych tego środowiska z wartością (jawny katalog i katalog bazowy XDG). */
export function dataDirVariables(env: Env): string[] {
  return [DATA_DIR_ENV, XDG_DATA_HOME_ENV].filter((variable) => (env[variable] ?? '') !== '');
}

/** Ten sam katalog: równe ścieżki albo równy `realpath` (katalog przez dowiązanie). */
function same(a: string, b: string): boolean {
  if (path.resolve(a) === path.resolve(b)) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/** Dopełniacz źródła do zdania „katalog …”. */
const SOURCE_TEXT: Readonly<Record<InstallDataDirSource, string>> = {
  flag: 'from --data-dir',
  service: 'of the installed service',
  rule: 'of the service',
};

/**
 * The data directory that the Rarog entries in the Claude Code settings name (the `denyRead` path, the write block
 * rules), for the commands that read or print them: the installed service's, else `--data-dir`, else the rule on
 * `env`. There is no comparison with the shell: the entries protect the directory the service's server uses, whatever
 * this shell computes, and `--data-dir` of a trial instance does not move them off the installed service.
 */
export function settingsDataDir(input: {
  readonly home: string; readonly env: Env; readonly flag?: string | undefined; readonly serviceDir?: string | null;
}): InstallDataDir {
  const serviceDir = input.serviceDir ?? null;
  if (serviceDir !== null) return { ok: true, dir: serviceDir, source: 'service' };
  const flag = input.flag ?? '';
  if (flag !== '') return { ok: true, dir: flag, source: 'flag' };
  const rule = resolveDataDir({ env: input.env, home: input.home });
  return rule.ok ? { ok: true, dir: rule.dir, source: 'rule' } : { ok: false, message: dataDirConflictMessage(rule) };
}

/** Katalog danych instalacji według reguły z nagłówka modułu. */
export function installDataDir(input: InstallDataDirInput): InstallDataDir {
  const flag = input.flag ?? '';
  const serviceDir = input.serviceDir ?? null;
  if (flag !== '') {
    if (serviceDir !== null && !same(serviceDir, flag)) {
      return {
        ok: false,
        message: `--data-dir ${flag} and the data directory of the installed service ${serviceDir} differ: the service`
          + ` would look for the SDK and devices in ${serviceDir}. Give --data-dir ${serviceDir} or reinstall the service`
          + ' with this directory.',
      };
    }
    return { ok: true, dir: flag, source: 'flag' };
  }
  let dir: string;
  let source: InstallDataDirSource;
  if (serviceDir !== null) {
    dir = serviceDir;
    source = 'service';
  } else {
    const rule = resolveDataDir({ env: input.serviceEnv, home: input.home });
    if (!rule.ok) return { ok: false, message: dataDirConflictMessage(rule) };
    dir = rule.dir;
    source = 'rule';
  }
  const shell = resolveDataDir({ env: input.shellEnv, home: input.home });
  if (!shell.ok) return { ok: false, message: dataDirConflictMessage(shell) };
  if (!same(shell.dir, dir)) {
    const variables = dataDirVariables(input.shellEnv);
    const why = variables.length > 0 ? ` (${variables.join(', ')} in this shell)` : '';
    if (input.reinstall !== undefined) {
      const fix = variables.length > 0 ? `Run without ${variables.join(', ')}` : `Reinstall the service:`
        + ` ${input.reinstall}`;
      return {
        ok: false,
        message: `The data directory from this shell ${shell.dir}${why} and the directory ${SOURCE_TEXT[source]} ${dir}`
          + ` differ: the check here and the service's server would look at different data (SDK, devices). ${fix}.`,
      };
    }
    return {
      ok: false,
      message: `The data directory from this shell ${shell.dir}${why} and the directory ${SOURCE_TEXT[source]} ${dir}`
        + ` differ: an SDK downloaded here would sit where the service does not look for it. Run without ${variables.length > 0
          ? variables.join(', ') : 'these variables'} or with --data-dir ${dir}`
        + ` (an install with rarog serve --data-dir: --data-dir <dir>).`,
    };
  }
  return { ok: true, dir, source };
}
