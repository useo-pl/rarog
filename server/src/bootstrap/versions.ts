/**
 * Server start: the new version signal of Claude Code and herdr, the consent canary push, and the one reader of the
 * CLI process registry. `main()` in `server/src/index.ts` builds them before the herdr supervisor and hands the APNs
 * sink over later.
 */
import { createCliVersionReader } from '../cli-version.ts';
import type { CliVersionReader } from '../cli-version.ts';
import type { RarogConfig } from '../config.ts';
import { createConsentCanaryFile } from '../herdr/dialogs/layer1/version-gate.ts';
import type { ApnsSink } from '../notify/apns-sink.ts';
import { createConsentCanaryPush } from '../notify/consent-canary-push.ts';
import type { Logger } from '../router.ts';
import { createVersionWatch, observeCliVersions } from '../version-watch.ts';
import type { VersionWatch } from '../version-watch.ts';

export interface VersionSignal {
  /** `null` in the demo, which tracks no versions. */
  readonly versionWatch: VersionWatch | null;
  /** `null` in the demo, which reads no process registry. */
  readonly cliVersionReader: CliVersionReader | null;
  /** Hands over the APNs sink once the channel exists; `undefined` = no push channel. */
  setVersionSink(sink: Pick<ApnsSink, 'send'> | undefined): void;
}

export function createVersionSignal(config: RarogConfig, log: Logger): VersionSignal {
  /*
   * Sygnał nowej wersji Claude Code i herdr (`version-watch.ts`): linia w `server.log` i push `version-changed`.
   * Powstaje przed nadzorcą herdr, który niesie wersję z `ping`; kanał APNs powstaje później, więc wysyłka sięga po
   * niego dopiero w chwili pushu (okno sklejania zmian trwa dłużej niż start). Demo wersji nie śledzi.
   */
  let versionSink: Pick<ApnsSink, 'send'> | undefined;
  const send: Parameters<typeof createVersionWatch>[0]['send'] =
    (content) => (versionSink === undefined ? Promise.resolve('no-receiver') : versionSink.send(content));
  const versionWatch = config.demo ? null : createVersionWatch({
    dataDir: config.dataDir, send, log: (line) => { log.info(line); },
  });
  // Consent canary result push (`notify/consent-canary-push.ts`): checked at the same full read of the installed
  // release as the version signal, through the same sink. Its own reader of the canary file (the gate in `index.ts`
  // keeps another), so neither memory depends on the other.
  const canary = createConsentCanaryFile(config.dataDir);
  const canaryPush = config.demo ? null : createConsentCanaryPush({
    dataDir: config.dataDir, readCanary: () => canary.read(), consentProof: config.consentProof, send,
    log: (line) => { log.info(line); },
  });
  // Wydanie Claude Code działających sesji vs zainstalowane, a z tego samego czytnika (jedna kolejka odczytów)
  // szybki tik dialogów managera i odczyt rejestru obserwacji kanału zgód w driverze. Każdy pełny odczyt dowiązania
  // idzie też do sygnału nowej wersji. Demo nie czyta rejestru procesów Maca — jego sesje są fikcyjne.
  const cliVersionReader = versionWatch === null
    ? null
    : observeCliVersions(createCliVersionReader({ logger: (line) => { log.info(line); } }), {
      observe: (product, version) => {
        versionWatch.observe(product, version);
        canaryPush?.check();
      },
    });
  return {
    versionWatch,
    cliVersionReader,
    setVersionSink: (sink) => { versionSink = sink; },
  };
}
