/**
 * Zdania obszaru `transcript`: wiadomości systemowe Raroga w transkrypcie, zastępnik obrazu, znacznik przycięcia.
 *
 * Kod ma postać `transcript.<nazwa>` w kebab-case. Format wpisu, rodzaje argumentów i reguła „opublikowany kod nie
 * zmienia znaczenia, argumentów ani szablonu”: `index.ts`. Zdanie własne dla apki powstaje wyłącznie przez `say`
 * z kodem z tego pliku.
 */
import type { SentenceArea } from './index.ts';

export const TRANSCRIPT_SENTENCES = {
  'transcript.repoint-clear': {
    en: '`/clear` started a new engine session. The earlier conversation stays in the terminal.',
  },
  'transcript.repoint-resume': { en: '`/resume` switched the pane to an earlier session. Its history is below.' },
  'transcript.trimmed-mark': { en: "[Rarog: message trimmed because it exceeded the transcript's memory limit]" },
  'transcript.truncation-footer': {
    en: { one: '\n… ({cut} character cut off)', other: '\n… ({cut} characters cut off)' },
    args: ['cut:plural'],
  },
  'transcript.image-placeholder': { en: '[image]' },
  'transcript.snapshot-image-alt': {
    en: 'Earlier image. The full preview is available only in the pane on the computer.',
  },
  'transcript.file-truncated': {
    en: 'The transcript file was truncated. History from before this point is only in the terminal.',
  },
  'transcript.gap': {
    en: 'Rarog skipped part of the transcript (too much growth at once). This part of the conversation is only in the terminal.',
  },
  'transcript.no-transcript': {
    en: "⚠ This session isn't producing a transcript. The pane probably started with an inherited `CLAUDE_CODE_CHILD_SESSION` variable or with `CLAUDE_CODE_SKIP_PROMPT_HISTORY` in its environment. Status and sending work, but the conversation content won't appear.",
  },
} as const satisfies SentenceArea;
