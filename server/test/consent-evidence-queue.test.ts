/**
 * Consent turn boundaries (`herdr/consent-evidence.ts`) on the queue measurements of two CLI versions
 * (`fixtures/herdr/queue/measured/<scenario>-<version>.jsonl`). The CLI gives the entries around a queued prompt
 * different `promptId`s per version: Esc while the model writes text puts the interrupted turn's `promptId` on the
 * interruption on CLI 2.1.328 and the queued prompt's on CLI 2.1.299; after `/compact` the queued prompt has its own
 * `promptId` on CLI 2.1.328 and shares the compaction entries' on CLI 2.1.299. Every arrangement must give both turns
 * a seen start and an end, and the queued prompt's turn must start no later than its own prompt.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createConsentEvidenceScanner, locateConsentCheckpoint } from '../src/herdr/consent-evidence.ts';

const DIR = join(import.meta.dirname, 'fixtures', 'herdr', 'queue', 'measured');
const SESSION = '00000000-0000-4000-8000-0000000000aa';

interface HumanPrompt { readonly promptId: string; readonly line: number }

/** Human prompts of the file (`origin.kind: human`) with their 1-based line numbers, in file order. */
function humanPrompts(text: string): HumanPrompt[] {
  return text.split('\n').flatMap((raw, index) => {
    if (raw.trim() === '') return [];
    const entry = JSON.parse(raw) as { promptId?: string; origin?: { kind?: string } };
    return entry.origin?.kind === 'human' && entry.promptId !== undefined
      ? [{ promptId: entry.promptId, line: index + 1 }] : [];
  });
}

/** 1-based line number of the byte offset `at` (the start of a line). */
function lineAt(text: string, at: number): number {
  return Buffer.from(text, 'utf8').subarray(0, at).toString('utf8').split('\n').length;
}

/** Where the review finds the start of the queued prompt's turn: the line of its checkpoint, per file. */
const QUEUED_TURN_START: Readonly<Record<string, number>> = {
  // The first entry with the queued prompt's `promptId` is the interruption, which opens no turn: the file start.
  'esc-w-tekscie-2.1.299.jsonl': 1,
  'esc-w-tekscie-2.1.328.jsonl': 7,
  // The tool result of the interrupted call carries the queued prompt's `promptId` on both versions.
  'esc-nad-kolejka-2.1.299.jsonl': 1,
  'esc-nad-kolejka-2.1.328.jsonl': 1,
  // CLI 2.1.299: the compaction summary shares the queued prompt's `promptId` and opens its turn.
  'compact-2.1.299.jsonl': 10,
  'compact-2.1.328.jsonl': 13,
};

describe('consent turns around a queued prompt, both CLI versions', () => {
  it.each(Object.entries(QUEUED_TURN_START))('%s: both turns start where the file shows them and end', async (
    name, start,
  ) => {
    const file = join(DIR, name);
    const text = readFileSync(file, 'utf8');
    const prompts = humanPrompts(text);
    expect(prompts, name).toHaveLength(2);
    const [first, queued] = prompts as [HumanPrompt, HumanPrompt];
    expect(queued.promptId, name).not.toBe(first.promptId);

    const scanner = createConsentEvidenceScanner();
    for (const [prompt, expectedLine] of [[first, first.line], [queued, start]] as const) {
      const checkpoint = await locateConsentCheckpoint(file, SESSION, prompt.promptId, Number.MAX_SAFE_INTEGER);
      expect(checkpoint, name).not.toBeNull();
      if (checkpoint === null) return;
      expect(lineAt(text, checkpoint.lineStart), `${name}: ${prompt.promptId}`).toBe(expectedLine);
      expect(expectedLine).toBeLessThanOrEqual(prompt.line);
      const pass = await scanner.pass({ sessionId: SESSION, promptId: prompt.promptId, file, checkpoint });
      expect(pass.status === 'ok' ? { ended: pass.facts.ended, partial: pass.facts.partial } : pass, name)
        .toEqual({ ended: true, partial: false });
    }
  });
});
