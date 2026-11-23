/**
 * Registry of Claude Code literals for the voice agent's `claude -p` call: the ONLY place in `server/src/**` where
 * the print-mode flags, the model alias and the words of the `stream-json` output the companion reads stand.
 * `cli.ts` is the only importer (guard: `server/test/companion-granice.test.ts`). Pattern: the registries in
 * `herdr/commands/registry.ts` and `herdr/background/cli-shapes.ts`. Here stand WORDS; the grammar (which event
 * ends the call, how the limit is read) stays in `cli.ts`.
 *
 * Every entry carries the Claude Code version it was measured on. After a Claude
 * Code update the question "what does the voice agent depend on" has one answer: this file
 * (`docs/companion.md`, "After a Claude Code update").
 */

/**
 * Print-mode flags, in this order, after `--model <alias>`. None carries content: the system prompt goes through
 * file descriptor 3 (`--system-prompt-file /dev/fd/3`), the question through stdin.
 *
 * Measured on CLI 2.1.319: zero hook events, subscription login (no API key), works when the server runs under
 * launchd. What each flag isolates:
 * - `--setting-sources project` in an empty working directory: no user settings, so no user hooks, plugins or
 *   permission rules; `--bare` is NOT used, because on CLI 2.1.322 it does not read the subscription login;
 * - `--strict-mcp-config` without an MCP config: no MCP servers;
 * - `--no-session-persistence`: no conversation file on disk;
 * - `--disable-slash-commands` and `--tools ''`: no skills and no tools;
 * - `--output-format stream-json --verbose`: one JSON event per line (`stream-json` needs `--verbose` in `-p`).
 *
 * The measurement also ran with `--include-partial-messages` and `--include-hook-events`. They are left out: they
 * only add events, and the deltas of the model's thinking would push stdout over the 64 kB cap in `cli.ts`.
 */
export const PRINT_FLAGS = {
  flags: [
    '-p',
    '--setting-sources', 'project',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--disable-slash-commands',
    '--tools', '',
    '--system-prompt-file', '/dev/fd/3',
    '--output-format', 'stream-json',
    '--verbose',
  ],
  cli: '2.1.319',
} as const;

/** Model flag and alias. Measured on CLI 2.1.322: the alias `sonnet` runs Sonnet 5.5 on the subscription. */
export const MODEL = {
  flag: '--model',
  alias: 'sonnet',
  cli: '2.1.322',
} as const;

/**
 * `stream-json` events the companion reads, measured on CLI 2.1.322. `result` ends the call: `result` holds the
 * whole answer text and `is_error` says whether the call failed (also when the login is missing).
 */
export const STREAM_EVENTS = {
  type: 'type',
  result: 'result',
  resultText: 'result',
  resultIsError: 'is_error',
  rateLimit: 'rate_limit_event',
  cli: '2.1.322',
} as const;

/**
 * Subscription limit in `rate_limit_event`, measured on CLI 2.1.322: the values stand in
 * `rate_limit_info.unifiedWindows.<window>.{utilization,status}` (the older top-level `utilization` field no longer
 * comes). `status` is `allowed`, `allowed_warning` (from 75 %) or a refusal such as `rejected`; a status that does
 * not start with `allowed` means the limit is exhausted. `overageStatus` is about paid overage and is not read.
 */
export const RATE_LIMIT = {
  info: 'rate_limit_info',
  windows: 'unifiedWindows',
  utilization: 'utilization',
  status: 'status',
  allowedPrefix: 'allowed',
  cli: '2.1.322',
} as const;

/**
 * Conversation-file word the condensing (`condense.ts`) reads besides the command tags of
 * `herdr/commands/registry.ts`: an interrupted turn writes a `user` entry whose text starts with
 * `interruptedPrefix`; it is not a prompt. Seen on CLI 2.1.322 in the conversation files the condensing was measured
 * on. The general entry format (`type`, `message.content`, `isSidechain`, `isMeta`, `isCompactSummary`) is shared
 * with `transcript-import.ts` and stays out of this registry.
 */
export const TRANSCRIPT = {
  interruptedPrefix: '[Request interrupted',
  cli: '2.1.322',
} as const;
