/**
 * Choice of the demo content set by language or by name (`RAROG_DEMO_CONTENT`). The server `index.ts` calls
 * it once while assembling, only in the demo (dynamic import), with `config.demoLang` and `config.demoSet`; the
 * production process does not load this module.
 */
import { demoContentEn } from './en.ts';
import { DEMO_SET_ROOT, loadDemoSet } from './named-set.ts';
import { demoContentPl } from './pl.ts';
import type { DemoContent, DemoLang, DemoSet } from './types.ts';

const SETS: Readonly<Record<DemoLang, DemoContent>> = { en: demoContentEn, pl: demoContentPl };

/**
 * The demo content set: the named set from `root` when there is one (`loadConfig` lets a name through only with
 * `en` and only when its module exists), otherwise the set of the language.
 */
export async function demoContent(
  lang: DemoLang, set: DemoSet | null = null, root: string = DEMO_SET_ROOT,
): Promise<DemoContent> {
  return set === null ? SETS[lang] : loadDemoSet(set, root);
}
