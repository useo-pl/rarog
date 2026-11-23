/**
 * Server start: the SSE hub with its start-time options (gzip, app build floor, project notes in the start frame).
 */
import { PROTOCOL_VERSION } from '@rarog/shared';
import type { RarogConfig } from '../config.ts';
import type { DemoNotes } from '../demo/notes.ts';
import { projectsWithNotes } from '../notes/store.ts';
import type { Logger } from '../router.ts';
import type { ManagerApi } from '../sessions/manager-api.ts';
import { SseHub } from '../sse.ts';

export interface HubDeps {
  readonly config: RarogConfig;
  readonly manager: ManagerApi;
  readonly serverStartId: string;
  readonly log: Logger;
  /** Demo notes in process memory, or `undefined` outside the demo (notes on disk). */
  readonly demoNotes: DemoNotes | undefined;
  /** Number of open streams after every change (the PR status reads only while a client is connected). */
  readonly onClientCount?: (count: number) => void;
}

/** The hub, not started yet: `main()` calls `start()`. */
export function createSseHub(deps: HubDeps): SseHub {
  const { config, manager, serverStartId, log, demoNotes, onClientCount } = deps;
  return new SseHub({
    manager, serverStartId, protocolVersion: PROTOCOL_VERSION,
    // Linia `sse: powtórka … → snapshot` — koszt bajtów zamiany powtórki na snapshot.
    logger: (line) => { log.info(line); },
    // Stream compression with gzip, only for a client with `Accept-Encoding: gzip`; on unless `RAROG_SSE_GZIP=0`.
    gzip: config.sseGzip,
    ...(onClientCount === undefined ? {} : { onClientCount }),
    // Próg builda apki natywnej; brak w configu = brak pola w `hello`.
    ...(config.minClientBuild === undefined ? {} : { minClientBuild: config.minClientBuild }),
    /*
     * Notatki w ramce startowej — pod killswitchem `RAROG_NOTES`, jak cała reszta
     * ficzeru: przy `0` funkcji NIE MA, więc ramka nie niesie pola, a sidebar nie rysuje ikon.
     * Pole zamiast osobnej trasy, bo lista projektów już tędy jedzie.
     */
    ...(config.notesEnabled
      ? {
        notesFor: (cwds: readonly string[]) => demoNotes?.withNotes(cwds)
          ?? projectsWithNotes(config.dataDir, cwds),
      }
      : {}),
  });
}
