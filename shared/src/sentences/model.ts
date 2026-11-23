/**
 * Zdania obszaru `model`: wybór modelu (etykiety, opisy, ostrzeżenia).
 *
 * Kod ma postać `model.<nazwa>` w kebab-case. Format wpisu, rodzaje argumentów i reguła „opublikowany kod nie
 * zmienia znaczenia, argumentów ani szablonu”: `index.ts`. Zdanie własne dla apki powstaje wyłącznie przez `say`
 * z kodem z tego pliku.
 */
import type { SentenceArea } from './index.ts';

export const MODEL_SENTENCES = {
  'model.default-label': { en: 'Account Default Model' },
  'model.default-description': { en: 'No --model flag: exactly what you have set in Claude Code.' },
  'model.change-warning': {
    en:
      'The change goes to the pane as the “/model” command, and Claude Code saves it in the account settings: ' +
      "new sessions, including those started in the terminal, will use this model from now on. Rarog won't " +
      'restore the previous value.',
  },
  'model.ultracode-note': {
    en:
      'Ultracode applies only to this session: Claude plans a workflow for every task, so each turn costs more ' +
      'tokens and gets you to the plan limit sooner. To turn it off, choose “No” in the same ' +
      '“Model and Effort” sheet.',
  },
  'model.busy': { en: 'The agent is working or waiting for a decision. Change the model when it finishes its turn.' },
  'model.change-confirmed': {
    en: '✓ The pane confirmed “{command}”. Note: Claude Code saved the change in the account settings.',
    args: ['command:text'],
  },
  'model.change-composer-unknown': {
    en: "⚠ “{command}” wasn't sent. Couldn't read the prompt field in the pane. Try again in a moment.",
    args: ['command:text'],
  },
  'model.change-empty': { en: 'Specify a model, effort, or ultracode.' },
  'model.change-foreign-dialog': {
    en: "⚠ “{command}” was sent, but the dialog on the pane's screen wasn't recognized. Rarog sent no digit. Finish in the terminal.",
    args: ['command:text'],
  },
  'model.change-inline': {
    en: '✓ The pane accepted “{command}” without a dialog. Note: Claude Code saved the change in the account settings.',
    args: ['command:text'],
  },
  'model.change-no-dialog': {
    en: "“{command}” was sent to the pane. The pane didn't ask for confirmation. If it asks in a moment, confirm in the terminal.",
    args: ['command:text'],
  },
  'model.change-unsent-prompt.mac': {
    en: "⚠ “{command}” wasn't sent. There's unsent text in the prompt field on the Mac. Send it or clear it, then try again.",
    args: ['command:text'],
  },
  'model.change-unsent-prompt.vps': {
    en: "⚠ “{command}” wasn't sent. There's unsent text in the prompt field on the VPS. Send it or clear it, then try again.",
    args: ['command:text'],
  },
  'model.herdr-set-at-start': { en: 'The model is set when the session is created.' },
  'model.not-in-list': { en: "Model {model} isn't in the list of available models.", args: ['model:text'] },
  'model.resume-without-ultracode': {
    en: 'The session came back without ultracode. On resume, Claude Code restores it only at the xhigh level and from version {minVersion}. You can turn it on in the “Model and Effort” sheet.',
    args: ['minVersion:text'],
  },
  'model.ultracode-cli-too-old': {
    en: "Claude Code {version} can't switch ultracode. Version {minVersion} or later is required.",
    args: ['version:text', 'minVersion:text'],
  },
  'model.ultracode-cli-unknown': {
    en: 'The Claude Code version is unknown, and ultracode requires version {minVersion} or later.',
    args: ['minVersion:text'],
  },
  'model.ultracode-effort': {
    en: 'Ultracode starts at the xhigh effort level. Choose xhigh or leave the level unset.',
  },
  'model.ultracode-off': { en: '✓ The pane turned off ultracode for this session.' },
  'model.ultracode-on': {
    en: '✓ The pane turned on ultracode for this session: Claude plans a workflow for every task.',
  },
  'model.ultracode-refused': {
    en: '⚠ Claude Code refused ultracode: dynamic workflows are turned off for this session (a setting in /config). Ultracode is unchanged.',
  },
  'model.ultracode-unseen': {
    en: "“{command}” was sent to the pane, but the result wasn't visible. The next turn will confirm the state.",
    args: ['command:text'],
  },
  'model.unavailable': { en: "This model isn't available on this account." },
} as const satisfies SentenceArea;
