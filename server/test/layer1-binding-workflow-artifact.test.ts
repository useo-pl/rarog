/**
 * Binding of `Workflow` and `Artifact` consent keys in the consent channel.
 *
 * Sentences this file guards:
 *
 * - `Workflow` and `Artifact` compare by input hash, like `Bash`: measured on live sessions (CLI 2.1.322), the hook
 *   input hash equals the `tool_use` input hash and the result carries `permissionDecision` from `hook`;
 * - an approved key of either tool binds to its call, so the record does not end as `unknown`
 *   (`incomparable-input`) with the "check the terminal" sentence on the phone;
 * - a call with a different input does not bind the key;
 * - a tool outside the list stays `incomparable-input`.
 */
import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../src/herdr/dialogs/hook/canon.ts';
import { bindTurn, comparabilityOf } from '../src/herdr/dialogs/layer1/bind.ts';
import type { ConsentTurnFacts } from '../src/herdr/dialogs/layer1/bind.ts';

const START = Date.parse('2026-11-11T19:55:02.000Z');

/** Input shapes as the CLI writes them (keys measured on CLI 2.1.322; values synthetic). */
const INPUTS = {
  Workflow: { script: "export const meta = { name: 'read-two', description: 'Two read-only agents' }\n" },
  Artifact: { action: 'read', scope: 'mine', url: 'https://claude.ai/artifact/0000' },
} as const;

function turnWith(name: string, input: unknown): ConsentTurnFacts {
  return {
    promptId: 'prompt-1', ended: true, partial: false,
    toolUses: [{ id: 'toolu-1', name, inputSha256: canonicalSha256(input), line: 10 }],
    results: [{ toolUseId: 'toolu-1', line: 11, at: START + 2000, decision: 'accept', source: 'hook', interrupted: false }],
  };
}

describe('consent binding: Workflow and Artifact', () => {
  it.each(Object.keys(INPUTS))('`%s` compares by input hash', (name) => {
    expect(comparabilityOf(name)).toBe('input');
  });

  it.each(Object.entries(INPUTS))('`%s` with the same input hash binds to its call', (name, input) => {
    const key = { key: 'k', toolName: name, inputSha256: canonicalSha256(input), hookStartedAt: START };
    expect(bindTurn([key], turnWith(name, input)))
      .toEqual([{ key: 'k', correlation: 'bound', toolUseId: 'toolu-1', cause: null }]);
  });

  it.each(Object.entries(INPUTS))('`%s` with a different input hash does not bind', (name, input) => {
    const key = { key: 'k', toolName: name, inputSha256: canonicalSha256({ other: true }), hookStartedAt: START };
    const [verdict] = bindTurn([key], turnWith(name, input));
    expect(verdict?.correlation).not.toBe('bound');
    expect(verdict?.toolUseId).toBeNull();
  });

  it('a tool outside the list stays `incomparable-input`', () => {
    const key = { key: 'k', toolName: 'Task', inputSha256: canonicalSha256({}), hookStartedAt: START };
    expect(comparabilityOf('Task')).toBe('none');
    expect(bindTurn([key], turnWith('Task', {})))
      .toEqual([{ key: 'k', correlation: 'incomparable-input', toolUseId: null, cause: 'incomparable-input' }]);
  });
});
