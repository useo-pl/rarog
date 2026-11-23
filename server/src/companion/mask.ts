/**
 * Mask of common secret shapes in text that leaves for an outside AI: the ask route's answer and its prompt proposal.
 * The app masks the session projection it sends to OpenAI with the same rules.
 *
 * This is a sieve for common shapes (`sk-…` keys, GitHub and Slack tokens, AWS access key IDs, `Bearer …`, the
 * `Rarog-Device` credential), not a guarantee: a secret in any other shape passes unchanged. The rules, their order
 * and a synthetic example of each live in the shared table `shared/fixtures/companion/secret-shapes.json`; the TS test
 * (`server/test/companion-mask.test.ts`) and the Swift test of the projection check their mask against every row, so
 * both masks behave the same. Patterns use only syntax that JavaScript and `NSRegularExpression` both accept.
 */
import { DEVICE_AUTH_SCHEME } from '../auth/device.ts';

/** What a masked secret becomes. */
export const SECRET_MASK = '[secret]';

/** One rule of the mask: a pattern and its replacement (`$1` keeps a scheme word such as `Bearer`). */
export interface SecretShape {
  readonly name: string;
  readonly pattern: RegExp;
  readonly replacement: string;
}

/** Rules in the order they apply: credentials after a scheme word first, so `Bearer sk-…` keeps the word. */
export const SECRET_SHAPES: readonly SecretShape[] = [
  {
    name: 'rarog-device',
    pattern: new RegExp(`(${DEVICE_AUTH_SCHEME})\\s+[^\\s"',;]+`, 'gi'),
    replacement: `$1 ${SECRET_MASK}`,
  },
  { name: 'bearer', pattern: /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{16,}/gi, replacement: `$1 ${SECRET_MASK}` },
  { name: 'sk-key', pattern: /\bsk-[A-Za-z0-9_-]{20,}/g, replacement: SECRET_MASK },
  {
    name: 'github-token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g,
    replacement: SECRET_MASK,
  },
  { name: 'aws-access-key-id', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replacement: SECRET_MASK },
  { name: 'slack-token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, replacement: SECRET_MASK },
];

/** Text with every match of {@link SECRET_SHAPES} replaced; applying it twice changes nothing. */
export function maskSecrets(text: string): string {
  let out = text;
  for (const shape of SECRET_SHAPES) out = out.replace(shape.pattern, shape.replacement);
  return out;
}
