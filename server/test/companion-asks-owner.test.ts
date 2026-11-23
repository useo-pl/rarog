/**
 * The question marker of the voice agent's session catalog (`server/src/companion/asks-owner.ts`) on the table shared
 * with the app (`shared/fixtures/companion/asks-owner.json`). The app's markdown parser reads the same table
 * (`MarkdownQuestionTests` in RarogUI), so the server flags a session exactly when the app marks the question in its
 * transcript. The texts in the table are synthetic.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { TranscriptMessage } from '@rarog/shared';
import { ASKS_OWNER_MARKERS, messageAsksOwner, textAsksOwner } from '../src/companion/asks-owner.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

interface Table {
  markers: string[];
  cases: { name: string; text: string; asksOwner: boolean }[];
}

const TABLE = JSON.parse(readFileSync(join(REPO, 'shared/fixtures/companion/asks-owner.json'), 'utf8')) as Table;

describe('companion: the question marker by the shared table', () => {
  it('the markers of the code are the markers of the table', () => {
    expect(ASKS_OWNER_MARKERS).toEqual(TABLE.markers);
  });

  it('the table has both answers and both markers', () => {
    expect(TABLE.cases.some((row) => row.asksOwner)).toBe(true);
    expect(TABLE.cases.some((row) => !row.asksOwner)).toBe(true);
    for (const marker of TABLE.markers) {
      expect(TABLE.cases.some((row) => row.asksOwner && row.text.includes(marker)), marker).toBe(true);
    }
  });

  it.each(TABLE.cases.map((row) => [row.name, row.text, row.asksOwner] as const))('%s', (_name, text, asksOwner) => {
    expect(textAsksOwner(text)).toBe(asksOwner);
  });
});

describe('companion: which message asks the owner', () => {
  const message = (role: TranscriptMessage['role'], ...texts: string[]): TranscriptMessage => ({
    seq: 1, role, blocks: texts.map((text) => ({ type: 'text' as const, text })), at: '2026-11-20T10:00:00.000Z',
  });

  it('an agent message with the marker in any of its text blocks', () => {
    expect(messageAsksOwner(message('assistant', 'Done.', '**Do Ciebie:** A or B?'))).toBe(true);
    expect(messageAsksOwner(message('assistant', 'Done.'))).toBe(false);
  });

  it('a human or system message with the marker, a tool call alone and no message do not', () => {
    expect(messageAsksOwner(message('user', '**Do Ciebie:** A or B?'))).toBe(false);
    expect(messageAsksOwner(message('system', '**To you:** A or B?'))).toBe(false);
    expect(messageAsksOwner({
      ...message('assistant'), blocks: [{ type: 'tool-call', toolName: 'Bash', summary: '**Do Ciebie:** x' }],
    })).toBe(false);
    expect(messageAsksOwner(undefined)).toBe(false);
  });
});
