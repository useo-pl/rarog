/**
 * Sprawdzarka angielskiej treści demo (używa jej też test procesu trybu recenzji).
 *
 * Bierze dowolną wartość JSON (zestaw treści po złożeniu przez {@link demoContentTexts}, odpowiedź REST, ramkę SSE)
 * i zbiera z niej każdy napis poza kluczami struktury ({@link DEMO_STRUCTURE_KEYS}: identyfikatory takie same
 * w każdym języku, np. `demo-rarog`, i dane obrazków). Napis widoczny nie może mieć polskiej litery ani słowa `rarog`
 * w żadnej wielkości liter: demo dla recenzenta mówi po angielsku i nie nosi nazwy produktu w treści fikcyjnej.
 * Nazwy klientów i projektów właściciela sprawdza osobno skan prywatnych literałów (`describePrivate`) na tych samych
 * napisach ({@link textLeaves}).
 */
import { demoGitStatus } from '../../src/drivers/mock-driver.ts';
import { createDemoNotes } from '../../src/demo/notes.ts';
import {
  demoDiff, demoProjectCwd, demoProjects, demoResumable, demoSeedUploads, demoSeeds,
} from '../../src/demo/seeds.ts';
import type { DemoContent } from '../../src/demo/content/types.ts';

/**
 * Klucze, których napisów sprawdzarka nie czyta: identyfikatory sesji, rozmów, zgód i wiadomości (struktura, ta sama
 * w każdym języku), nazwy plików zdjęć w kształcie `herdr/uploads.ts` i dane obrazków.
 */
export const DEMO_STRUCTURE_KEYS: ReadonlySet<string> = new Set([
  'id', 'sessionId', 'engineSessionId', 'permId', 'reqId', 'clientMessageId', 'serverStartId', 'file', 'dataUrl',
]);

/** Polska litera (małe i wielkie). */
const POLISH_LETTER = /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/u;
/** Nazwa produktu, także z polską literą. */
const PRODUCT_NAME = /rar[oó]g/iu;

export interface TextLeaf {
  /** Ścieżka w wartości (`$.seeds[2].title`). */
  readonly path: string;
  readonly text: string;
}

/** Wszystkie napisy wartości (także klucze obiektów) poza kluczami z `skip`, z ich ścieżkami. */
export function textLeaves(value: unknown, skip: ReadonlySet<string> = DEMO_STRUCTURE_KEYS, at = '$'): TextLeaf[] {
  if (typeof value === 'string') return [{ path: at, text: value }];
  if (Array.isArray(value)) return value.flatMap((item, index) => textLeaves(item, skip, `${at}[${String(index)}]`));
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, inner]) => (
    skip.has(key) ? [] : [{ path: `${at}.${key} (klucz)`, text: key }, ...textLeaves(inner, skip, `${at}.${key}`)]
  ));
}

/**
 * Napisy, które nie są angielską treścią demo: `ścieżka: powód (napis)`. Pusta lista = wartość przechodzi.
 *
 * @param value wartość JSON do sprawdzenia
 * @param skip klucze struktury pomijane razem z poddrzewem
 */
export function nonEnglishTexts(value: unknown, skip: ReadonlySet<string> = DEMO_STRUCTURE_KEYS): string[] {
  const problems: string[] = [];
  for (const leaf of textLeaves(value, skip)) {
    const letter = POLISH_LETTER.exec(leaf.text)?.[0];
    if (letter !== undefined) problems.push(`${leaf.path}: polska litera „${letter}” (${leaf.text.slice(0, 80)})`);
    if (PRODUCT_NAME.test(leaf.text)) problems.push(`${leaf.path}: nazwa produktu (${leaf.text.slice(0, 80)})`);
  }
  return problems;
}

/** Stałe „teraz” złożenia zestawu: wynik nie zależy od zegara. */
const NOW = Date.parse('2026-11-07T09:00:00.000Z');

/**
 * Wszystko, co klient demo widzi z tego zestawu, złożone tymi samymi funkcjami co serwer: projekty, seedy, „Wznów
 * istniejącą” każdego projektu, diff, temat ostatniego commitu, notatka z zasiewu, katalogi zdjęć, odpowiedzi
 * atrapy (z echem obrazków w trzech formach liczby) i stałe trybu recenzji.
 */
export function demoContentTexts(content: DemoContent): Record<string, unknown> {
  const projects = demoProjects(content);
  const { driver } = content;
  return {
    projects,
    seeds: demoSeeds(content, NOW),
    resumable: projects.map((project) => demoResumable(content, project.path, NOW)),
    diff: demoDiff(content),
    lastCommit: demoGitStatus(demoProjectCwd(content, 'main'), 3, content).lastCommit,
    note: createDemoNotes(content, () => NOW).read(demoProjectCwd(content, 'import')),
    uploads: demoSeedUploads(content).map((upload) => ({ cwd: upload.cwd, file: upload.file })),
    driver: {
      replies: driver.replies,
      streamFragments: driver.streamFragments,
      questions: driver.questions,
      triggers: driver.triggers,
      imagesEcho: [1, 2, 5].map((count) => driver.imagesEcho(count)),
      imageAlt: [1, 2, 3].map((index) => driver.imageAlt(index)),
      deniedReply: driver.deniedReply,
      deniedSummary: driver.deniedSummary,
      turnSummary: driver.turnSummary,
    },
    review: content.review,
  };
}
