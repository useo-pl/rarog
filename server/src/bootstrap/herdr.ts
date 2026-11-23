/**
 * Server start: the shape of the herdr runtime and its demo variant. The real runtime (`loadHerdr`) stays in
 * `server/src/index.ts`, next to the consent channel wiring it carries into the driver.
 */
import { redact } from '../auth/index.ts';
import type { DemoContent } from '../demo/content/types.ts';
import type { ScenarioPanels } from '../demo/scenarios.ts';
import type { HerdrSupervisor } from '../herdr/types.ts';
import type { UploadImage } from '../herdr/uploads.ts';
import type { Logger } from '../router.ts';
import type { HerdrManagerDeps } from '../sessions/manager.ts';

/** Nadzorca + zależności managera — jedno i drugie powstaje razem albo wcale. */
export interface HerdrRuntime {
  supervisor: HerdrSupervisor;
  deps: HerdrManagerDeps;
  /** Odczyt zdjęcia do miniatury; w demo z RAM pokazu (seedy i wysłane zdjęcia). */
  readUpload?: (cwd: string, name: string) => Promise<UploadImage | null>;
  scenarioPanels?: ScenarioPanels;
  /** Sonda `/health`: żywy ping gniazda herdr; demo odpowiada `false` bez pytania. */
  probe(): Promise<boolean>;
  dispose(): void;
}

/** Demo: mock nadzorcy zamiast gniazda. Zero herdr, zero `~/.claude`, zero procesów. */
export async function loadDemoHerdr(log: Logger, content: DemoContent): Promise<HerdrRuntime | null> {
  try {
    const mock = await import('../demo/mock-herdr.ts');
    const herdr = mock.createMockHerdr(content);
    return {
      supervisor: herdr.supervisor,
      deps: herdr.deps,
      scenarioPanels: herdr.scenarioPanels,
      readUpload: (cwd, name) => herdr.readUpload(cwd, name),
      // Demo nie ma gniazda, więc `/health` mówi o herdr `false` — zgodnie z prawdą.
      probe: () => Promise.resolve(false),
      dispose: () => { herdr.dispose(); },
    };
  } catch (err: unknown) {
    log.error(`Demo without a supervisor (${redact(err)}); the session list stays empty.`);
    return null;
  }
}
