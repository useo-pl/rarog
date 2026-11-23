/** A named demo content set for the loader tests: the English set with its own tailnet name. */
import { demoContentEn } from '../../../src/demo/content/en.ts';
import type { DemoContent } from '../../../src/demo/content/types.ts';

const sample: DemoContent = { ...demoContentEn, tailnet: 'sample.example' };

export default sample;
