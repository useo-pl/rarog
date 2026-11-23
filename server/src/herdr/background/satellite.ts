/**
 * Katalog sesji obok transkryptu („satelita") — adres i relokacja.
 *
 * Jedno miejsce dla czytnika przebiegów (`workflow-run.ts`) i pulsu tury (`herdr/session-pulse.ts`), także
 * dla kształtu `wf_<id>`. Opis całości: `docs/background-tasks.md`.
 *
 *   <root>/<slug>/<uuid>.jsonl   główny transkrypt (czyta go `herdr/jsonl-follow.ts`)
 *   <root>/<slug>/<uuid>/        satelita — powstaje DOPIERO, gdy jest co w nim zapisać
 *
 * Pełny, zmierzony układ wnętrza katalogu stoi w nagłówku `herdr/session-pulse.ts`.
 *
 * Adres bierzemy z `locateTranscript` (glob po uuid), a nie ze sklejenia sluga z uuid: sesja
 * wznowiona międzykatalogowo pisze do pliku w slugu ORYGINALNYM i katalog satelity leży obok
 * NIEGO. Nic tu nie rzuca — brak pliku albo katalogu to normalny stan pracy.
 */
import { stat } from 'node:fs/promises';
import { TRANSCRIPT_EXT, locateTranscript } from '../transcript-path.ts';

/**
 * Katalog satelity sesji `agentSessionId`; `null` = transkryptu albo katalogu (jeszcze) nie ma.
 *
 * Jeden odczyt bez pamięci: glob po uuid i `stat`. Kto chce pamiętać adres między odczytami,
 * bierze {@link createSatelliteDir} albo trzyma wynik sam (puls tury, który ma własny cykl życia).
 */
export async function locateSatelliteDir(
  root: string, cwd: string, agentSessionId: string,
): Promise<string | null> {
  const path = await locateTranscript(root, cwd, agentSessionId);
  if (path === null) return null;
  const dir = path.slice(0, path.length - TRANSCRIPT_EXT.length);
  try {
    if (!(await stat(dir)).isDirectory()) return null;
  } catch {
    return null;
  }
  return dir;
}

/** Adres katalogu satelity JEDNEJ sesji panelu, zapamiętany między odczytami. */
export interface SatelliteDir {
  /** Katalog bieżącej sesji silnika; `null` = jeszcze go nie ma (następny odczyt spróbuje znów). */
  resolve(): Promise<string | null>;
  /** `/clear`, `/resume`: inna sesja silnika, czyli INNY katalog. */
  repoint(agentSessionId: string): void;
  /**
   * Ta sama sesja, ale jej pliki PRZENIOSŁY SIĘ (`EnterWorktree`): kasujemy sam adres,
   * najbliższy `resolve()` zrobi glob po uuid od nowa.
   */
  relocated(): void;
}

export interface SatelliteDirOptions {
  /** Korzeń magazynu CLI (`~/.claude/projects`; testy dają katalog tymczasowy). */
  root: string;
  cwd: string;
  agentSessionId: string;
}

/**
 * Tworzy zapamiętany adres katalogu satelity.
 *
 * Szukanie adresu trwa (glob po uuid i `stat`), a `repoint()` albo `relocated()` potrafi wejść
 * w jego środek. Wynik takiego szukania opisuje poprzednią sesję silnika albo adres sprzed
 * przeniesienia, więc numer pokolenia go unieważnia: `resolve()` oddaje wtedy `null` („nie wiem”)
 * i niczego nie zapamiętuje, a następny odczyt szuka od nowa. Bez tego spóźniony wynik
 * zapisałby stary katalog i czytnik patrzyłby w niego aż do kolejnego `/clear`.
 */
export function createSatelliteDir(opts: SatelliteDirOptions): SatelliteDir {
  let uuid = opts.agentSessionId;
  let dir: string | null = null;
  /** Rośnie przy każdej zmianie tego, czego szukamy; szukanie sprzed zmiany jest nieważne. */
  let generation = 0;
  return {
    async resolve(): Promise<string | null> {
      if (dir !== null) return dir;
      const started = generation;
      const found = await locateSatelliteDir(opts.root, opts.cwd, uuid);
      if (started !== generation || found === null) return null;
      dir = found;
      return found;
    },
    repoint(agentSessionId: string): void {
      generation += 1;
      uuid = agentSessionId;
      dir = null;
    },
    relocated(): void {
      generation += 1;
      dir = null;
    },
  };
}
