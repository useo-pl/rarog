/**
 * Zdania obszaru `commands`: slash-komendy i ich odmowy.
 *
 * Kod ma postać `commands.<nazwa>` w kebab-case. Format wpisu, rodzaje argumentów i reguła „opublikowany kod nie
 * zmienia znaczenia, argumentów ani szablonu”: `index.ts`. Zdanie własne dla apki powstaje wyłącznie przez `say`
 * z kodem z tego pliku.
 */
import type { SentenceArea } from './index.ts';

export const COMMANDS_SENTENCES = {
  'commands.alias-use-canonical': {
    en: 'The command {token} is an alias of /{canonical}. Type /{canonical} instead.',
    args: ['token:text', 'canonical:text'],
  },
  'commands.bare-slash': { en: "A bare slash would run the CLI's first suggestion. Type a command name." },
  'commands.bypass-outside-yolo': {
    en: 'The pane is running in bypass permissions mode. Sending from Rarog is allowed only in directories under RAROG_YOLO_ROOTS.',
  },
  'commands.command-mismatch': {
    en: 'the driver and the manager recognize the command differently, so sending is on hold',
  },
  'commands.completes-to-blocked': {
    en: { one: "The command {token} doesn't go through Rarog. The CLI would complete it to {names}, which Rarog doesn't let through. Run it in the terminal.", other: "The command {token} doesn't go through Rarog. The CLI would complete it to {names}, none of which Rarog lets through. Run it in the terminal." },
    args: ['token:text', 'names:text', 'count:plural'],
  },
  'commands.completes-to-blocked.claude-only': {
    en: { one: "The command {token} doesn't go through Rarog. The CLI would complete it to {names}, which Rarog doesn't let through. Describe what you need in a plain message.", other: "The command {token} doesn't go through Rarog. The CLI would complete it to {names}, none of which Rarog lets through. Describe what you need in a plain message." },
    args: ['token:text', 'names:text', 'count:plural'],
  },
  'commands.empty': { en: "The message is empty. There's nothing to send." },
  'commands.exit-word': {
    en: '“{command}” would end the Claude Code session. End the session with the button in Rarog or in the terminal.',
    args: ['command:text'],
  },
  'commands.hint.end-session-button': { en: 'end the session with the button in Rarog or in the terminal' },
  'commands.hint.rarog-blocks-skill': { en: "Rarog doesn't let it through" },
  'commands.hint.run-in-terminal': { en: 'run it in the terminal' },
  'commands.hint.run-skill-in-terminal': { en: 'run it in the terminal' },
  'commands.hint.use-model-button': { en: 'use the model button in Rarog' },
  'commands.hint.write-plain-message': { en: 'describe what you need in a plain message' },
  'commands.incomplete-name': {
    en: "The command {token} doesn't go through Rarog (Rarog doesn't complete names). Type the full name: {names}.",
    args: ['token:text', 'names:text'],
  },
  'commands.interrupt-blocked': {
    en: '⚠ herdr rejected the interrupt. The agent is waiting for a decision in the terminal. The turn was not interrupted.',
  },
  'commands.interrupt-done': { en: 'Turn interrupted from Rarog. The pane accepted Esc.' },
  'commands.interrupt-failed.mac': {
    en: "⚠ Couldn't interrupt the turn: {reason}. Open the pane in herdr on the Mac and press Esc there.",
    args: ['reason:text'],
  },
  'commands.interrupt-failed.mac.code': {
    en: "⚠ Couldn't interrupt the turn. Open the pane in herdr on the Mac and press Esc there. Reason: {reason}",
    args: ['reason:code'],
  },
  'commands.interrupt-failed.vps': {
    en: "⚠ Couldn't interrupt the turn: {reason}. Open the pane in herdr on the VPS and press Esc there.",
    args: ['reason:text'],
  },
  'commands.interrupt-failed.vps.code': {
    en: "⚠ Couldn't interrupt the turn. Open the pane in herdr on the VPS and press Esc there. Reason: {reason}",
    args: ['reason:code'],
  },
  'commands.interrupt-panel-gone': {
    en: '⚠ The pane disappeared from herdr, so nothing could accept the interrupt. The turn was not interrupted.',
  },
  'commands.interrupt-read-only': { en: "⚠ herdr is read-only. The turn wasn't interrupted." },
  'commands.mcp-prompt': {
    en: 'The command {token} is an MCP prompt. Run MCP prompts in the terminal.',
    args: ['token:text'],
  },
  'commands.mcp-prompt.marked': {
    en: 'The command {token} (MCP) is an MCP prompt. Run MCP prompts in the terminal.',
    args: ['token:text'],
  },
  'commands.mode-cycle-busy': {
    en: { one: "⚠ The pane started a turn or stopped on a decision. After {presses} shift+tab press, it's in {mode} mode. Finish with shift+tab in the terminal (target: {target}).", other: "⚠ The pane started a turn or stopped on a decision. After {presses} shift+tab presses, it's in {mode} mode. Finish with shift+tab in the terminal (target: {target})." },
    args: ['presses:plural', 'mode:text', 'target:text'],
  },
  'commands.mode-cycle-busy.mode-unknown': {
    en: { one: "⚠ The pane started a turn or stopped on a decision. After {presses} shift+tab press, it's in an unknown mode. Finish with shift+tab in the terminal (target: {target}).", other: "⚠ The pane started a turn or stopped on a decision. After {presses} shift+tab presses, it's in an unknown mode. Finish with shift+tab in the terminal (target: {target})." },
    args: ['presses:plural', 'target:text'],
  },
  'commands.mode-cycle-done': {
    en: { one: '✓ The pane switched to {target} mode ({presses} shift+tab press from Rarog).', other: '✓ The pane switched to {target} mode ({presses} shift+tab presses from Rarog).' },
    args: ['target:text', 'presses:plural'],
  },
  'commands.mode-cycle-exhausted': {
    en: { one: '⚠ Cycled through all the modes without reaching “{target}”. After {presses} shift+tab press, the pane is in {mode} mode. Check in the terminal whether this pane has that mode.', other: '⚠ Cycled through all the modes without reaching “{target}”. After {presses} shift+tab presses, the pane is in {mode} mode. Check in the terminal whether this pane has that mode.' },
    args: ['target:text', 'presses:plural', 'mode:text'],
  },
  'commands.mode-cycle-exhausted.mode-unknown': {
    en: { one: '⚠ Cycled through all the modes without reaching “{target}”. After {presses} shift+tab press, the pane is in an unknown mode. Check in the terminal whether this pane has that mode.', other: '⚠ Cycled through all the modes without reaching “{target}”. After {presses} shift+tab presses, the pane is in an unknown mode. Check in the terminal whether this pane has that mode.' },
    args: ['target:text', 'presses:plural'],
  },
  'commands.mode-cycle-key-lost': {
    en: { one: "⚠ The key didn't reach the pane. After {presses} shift+tab press, it's in {mode} mode. Finish with shift+tab in the terminal (target: {target}).", other: "⚠ The key didn't reach the pane. After {presses} shift+tab presses, it's in {mode} mode. Finish with shift+tab in the terminal (target: {target})." },
    args: ['presses:plural', 'mode:text', 'target:text'],
  },
  'commands.mode-cycle-key-lost.mode-unknown': {
    en: { one: "⚠ The key didn't reach the pane. After {presses} shift+tab press, it's in an unknown mode. Finish with shift+tab in the terminal (target: {target}).", other: "⚠ The key didn't reach the pane. After {presses} shift+tab presses, it's in an unknown mode. Finish with shift+tab in the terminal (target: {target})." },
    args: ['presses:plural', 'target:text'],
  },
  'commands.mode-cycle-keys': { en: 'The mode switch path sends only ["shift+tab"].' },
  'commands.mode-cycle-no-footer': {
    en: { one: "⚠ The mode footer isn't visible. After {presses} shift+tab press, the pane is in {mode} mode. Finish with shift+tab in the terminal (target: {target}).", other: "⚠ The mode footer isn't visible. After {presses} shift+tab presses, the pane is in {mode} mode. Finish with shift+tab in the terminal (target: {target})." },
    args: ['presses:plural', 'mode:text', 'target:text'],
  },
  'commands.mode-cycle-no-footer.mode-unknown': {
    en: { one: "⚠ The mode footer isn't visible. After {presses} shift+tab press, the pane is in an unknown mode. Finish with shift+tab in the terminal (target: {target}).", other: "⚠ The mode footer isn't visible. After {presses} shift+tab presses, the pane is in an unknown mode. Finish with shift+tab in the terminal (target: {target})." },
    args: ['presses:plural', 'target:text'],
  },
  'commands.namespaced': {
    en: "The command {token} doesn't go through Rarog (Rarog doesn't complete bare plugin names). Type {names} instead.",
    args: ['token:text', 'names:text'],
  },
  'commands.not-in-catalog': {
    en: "“{token}” isn't a name from the Rarog catalog, and the CLI would run a command with that name if one existed (a skill or a plugin command). Start the message differently or run the command in the terminal.",
    args: ['token:text'],
  },
  'commands.not-internal': { en: "This isn't a command that Rarog can send through its internal path." },
  'commands.panel-send-failed': { en: "⚠ Couldn't send to the pane: {reason}", args: ['reason:text'] },
  'commands.panel-send-failed.code': { en: "⚠ Couldn't send to the pane: {reason}", args: ['reason:code'] },
  'commands.path-completes': {
    en: '“{token}” is a path, but the CLI would complete it to a command. Add a slash: {token}/.',
    args: ['token:text'],
  },
  'commands.prefix-blocked': { en: 'The prefix “{prefix}” is blocked. Reword the message.', args: ['prefix:text'] },
  'commands.prompt-blocked': { en: "⚠ A hook blocked the prompt. It wasn't sent." },
  'commands.prompt-blocked.prompt': {
    en: "⚠ A hook blocked the prompt. It wasn't sent.\nPrompt: {prompt}",
    args: ['prompt:text'],
  },
  'commands.prompt-blocked.reason': {
    en: "⚠ A hook blocked the prompt. It wasn't sent.\n{reason}",
    args: ['reason:text'],
  },
  'commands.prompt-blocked.reason-and-prompt': {
    en: "⚠ A hook blocked the prompt. It wasn't sent.\n{reason}\nPrompt: {prompt}",
    args: ['reason:text', 'prompt:text'],
  },
  'commands.quiet-command': {
    en: "ⓘ {command} didn't start a turn. The command's output, if any, is visible only in the terminal.",
    args: ['command:text'],
  },
  'commands.redirect-blocked': {
    en: "The command {token} {word} redirects to /{target}, which Rarog doesn't let through. Run it in the terminal.",
    args: ['token:text', 'word:text', 'target:text'],
  },
  'commands.refused-alias': {
    en: "The command {token} is an alias of /{canonical}, which Rarog doesn't let through: {hint}.",
    args: ['token:text', 'canonical:text', 'hint:code'],
  },
  'commands.refused-claude-skill': {
    en: 'The command {token} is a skill that only Claude invokes: describe what you need in a plain message.',
    args: ['token:text'],
  },
  'commands.refused-hidden-skill': {
    en: 'The command {token} is a skill hidden in settings (user-invocable: false or skillOverrides: off): {hint}.',
    args: ['token:text', 'hint:code'],
  },
  'commands.refused-known.end-session': {
    en: "The command {token} doesn't go through Rarog: end the session with the button in Rarog or in the terminal.",
    args: ['token:text'],
  },
  'commands.refused-known.run-in-terminal': {
    en: "The command {token} doesn't go through Rarog: run it in the terminal.",
    args: ['token:text'],
  },
  'commands.refused-known.use-model-button': {
    en: "The command {token} doesn't go through Rarog: use the model button in Rarog.",
    args: ['token:text'],
  },
  'commands.refused-synced-skill': {
    en: "The command {token} is a skill from claude.ai, which Rarog doesn't let through: {hint}.",
    args: ['token:text', 'hint:code'],
  },
  'commands.send-blocked': {
    en: '⚠ herdr rejected the send. The agent is waiting for a decision in the terminal. The message was not sent.',
  },
  'commands.send-failed': { en: '⚠ The message was not sent: {reason}', args: ['reason:text'] },
  'commands.send-refused': { en: '⚠ The message was not sent: {reason}', args: ['reason:code'] },
  'commands.send-held.cli-dialog': {
    en: '⚠ A Claude Code dialog is open in the pane and waiting for an answer. The message was not sent. Answer on the card or at the desk, then send again.',
  },
  'commands.send-held.consent-dialog': {
    en: '⚠ A Claude Code permission dialog is waiting for an answer in the terminal. The message was not sent. Dismiss the dialog (Esc) or answer at the desk, then send again.',
  },
  'commands.send-held.form': {
    en: '⚠ A question form from the agent is open in the pane. The message was not sent. Answer on the question card or at the desk, then send again.',
  },
  'commands.send-read-only': { en: "herdr is read-only. The message wasn't sent." },
  'commands.send-session-changed': {
    en: '⚠ The pane switched to another conversation before Rarog could send this message. It was not sent.',
  },
  'commands.send-stalled': {
    en: "⚠ The message got stuck in the pane's input field and was not sent. Send it again or finish in the terminal.",
  },
  'commands.too-large': {
    en: 'The message is {bytes} B, and the limit for sending to the pane is {limitKb} KB.',
    args: ['bytes:int', 'limitKb:int'],
  },
  'commands.unknown': {
    en: "Rarog doesn't know the command {token}. Check the name or run it in the terminal.",
    args: ['token:text'],
  },
  'commands.use-joined': {
    en: "The command {token} doesn't go through Rarog. Type /{name} instead.",
    args: ['token:text', 'name:text'],
  },
} as const satisfies SentenceArea;
