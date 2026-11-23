/**
 * Lines of a synthetic Claude Code conversation file for the tests that read turns from it (the voice agent's turns,
 * the Inbox cards): a human prompt, an agent answer, a tool call with its result, a task notification, the end of an
 * artifact watch, a prompt blocked by a hook, a local command with its output, an image pasted in the terminal.
 * Every line ends with `\n`; the texts are synthetic.
 */

const at = (minute: number): string => `2026-11-20T10:${String(minute).padStart(2, '0')}:00.000Z`;

/** Time of minute `minute` of the synthetic day, as the lines write it. */
export const lineTime = at;

const line = (entry: Record<string, unknown>): string => `${JSON.stringify(entry)}\n`;

export function userLine(text: string, minute = 0, extra: Record<string, unknown> = {}): string {
  return line({ type: 'user', timestamp: at(minute), message: { role: 'user', content: text }, ...extra });
}

export function agentLine(text: string, minute = 0): string {
  return line({
    type: 'assistant', timestamp: at(minute), message: { role: 'assistant', content: [{ type: 'text', text }] },
  });
}

/** A main-agent tool call and its result, as two entries; `id` must differ between calls of one file. */
export function toolLines(minute = 0, id = `toolu_${String(minute)}`): string {
  return line({
    type: 'assistant', timestamp: at(minute),
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: '/repo/a.ts' } }] },
  }) + line({
    type: 'user', timestamp: at(minute),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
  });
}

/** The harness notice that an artifact watch ended: a turn input that leaves no result when the agent only answers. */
export function artifactWatchLine(minute = 0): string {
  const text = [
    '<task-notification>', '<task-type>artifact-watch-lifecycle</task-type>',
    '<summary>Stopped watching Artifact: "Report" (artifact not found)</summary>', '</task-notification>',
  ].join('\n');
  return userLine(text, minute, { origin: { kind: 'task-notification', producer: 'session-task' } });
}

/** A background task notification: a `user` entry with a `<task-notification>` text and the task origin. */
export function noticeLine(summary: string, minute = 0): string {
  const text = [
    '<task-notification>', '<task-id>bash_1</task-id>', '<status>completed</status>',
    `<summary>${summary}</summary>`, '</task-notification>',
  ].join('\n');
  return userLine(text, minute, { origin: { kind: 'task-notification', producer: 'session-task' } });
}

/** A prompt blocked by a `UserPromptSubmit` hook. */
export function blockedLine(prompt: string, minute = 0, reason = 'policy says no'): string {
  return line({
    type: 'system', subtype: 'informational', level: 'warning', isMeta: false, preventContinuation: true,
    content: `UserPromptSubmit operation blocked by hook:\n[/h.sh]: ${reason}\n\nOriginal prompt: ${prompt}`,
    promptSubmitEnding: { ending: { kind: 'blocked_by_hook', reason }, promptKept: false },
    timestamp: at(minute),
  });
}

/** A local command and its output, as two `user` entries. */
export function localCommandLines(name: string, output: string, minute = 0): string {
  return userLine(`<command-name>/${name}</command-name>\n<command-message>${name}</command-message>\n<command-args></command-args>`, minute)
    + userLine(`<local-command-stdout>${output}</local-command-stdout>`, minute);
}

/** An image pasted in the terminal, without text: the import keeps only the server's `[image]` placeholder. */
export function pastedImageLine(minute = 0): string {
  return line({
    type: 'user', timestamp: at(minute),
    message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }] },
  });
}

/**
 * A photo sent from Rarog without text: the prompt entry with its image block and the `isMeta` companion entry with
 * the upload's path, which the import pins to the prompt as an attachment.
 */
export function photoLines(minute = 0): string {
  const path = '/p/.rarog-uploads/1790000000-0123456789abcdef.png';
  return line({
    type: 'user', timestamp: at(minute),
    message: { role: 'user', content: [{ type: 'text', text: '[Image #1]' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aaaa' } }] },
  }) + line({
    type: 'user', timestamp: at(minute), isMeta: true,
    message: { role: 'user', content: [{ type: 'text', text: `[Image: source: ${path}]` }] },
  });
}

/** Prompt and answer of turn `n`. */
export function turnLines(n: number, minute = n): string {
  return userLine(`prompt ${String(n)}`, minute) + agentLine(`answer ${String(n)}`, minute);
}
