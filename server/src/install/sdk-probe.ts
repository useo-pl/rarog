/**
 * Sonda katalogu SDK w osobnym krótkim procesie (`probeSdkDir` w `sdk.ts`): argumenty `<katalog wersji> <wersja>`,
 * import po jawnej ścieżce (`importSdkFrom`) i `listSessions` na pustym katalogu (`probeListSessions`). Wynik: jedna
 * linia `SDK_PROBE_PREFIX<JSON>` na stdout i `process.exit` po jej zapisie, bo moduł SDK może zostawić otwarty
 * uchwyt. Pliku nikt nie importuje: to wejście procesu.
 */
import { SDK_PROBE_PREFIX, importSdkFrom, probeListSessions } from './sdk.ts';
import type { SdkProbeResult } from './sdk.ts';

const [versionDir = '', version = ''] = process.argv.slice(2);
let result: SdkProbeResult;
try {
  result = await probeListSessions(await importSdkFrom(versionDir, version));
} catch (failure) {
  result = { ok: false, reason: `import SDK: ${failure instanceof Error ? failure.message : String(failure)}` };
}
process.stdout.write(`${SDK_PROBE_PREFIX}${JSON.stringify(result)}\n`, () => {
  process.exit(result.ok ? 0 : 1);
});
