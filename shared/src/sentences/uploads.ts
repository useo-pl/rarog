/**
 * Zdania obszaru `uploads`: zdjęcia i pliki wysyłane z apki.
 *
 * Kod ma postać `uploads.<nazwa>` w kebab-case. Format wpisu, rodzaje argumentów i reguła „opublikowany kod nie
 * zmienia znaczenia, argumentów ani szablonu”: `index.ts`. Zdanie własne dla apki powstaje wyłącznie przez `say`
 * z kodem z tego pliku.
 */
import type { SentenceArea } from './index.ts';

export const UPLOADS_SENTENCES = {
  'uploads.bad-content': { en: 'The attachment “{name}” has invalid content. Nothing was sent.', args: ['name:text'] },
  'uploads.dir-not-directory.file': {
    en: "The path {dir} exists but is a file, not a directory, so Rarog can't save attachments there. Remove that entry from the project directory and send the attachment again.",
    args: ['dir:text'],
  },
  'uploads.dir-not-directory.other': {
    en: "The path {dir} exists but isn't a directory, so Rarog can't save attachments there. Remove that entry from the project directory and send the attachment again.",
    args: ['dir:text'],
  },
  'uploads.dir-not-directory.symlink': {
    en: "The path {dir} exists but is a symlink, not a directory, so Rarog can't save attachments there. Remove that entry from the project directory and send the attachment again.",
    args: ['dir:text'],
  },
  'uploads.file-too-large': { en: 'The file exceeds the limit of 20 MB per file.' },
  'uploads.image-too-large': { en: 'The photo is over 1.5 MB. Make it smaller before sending.' },
  'uploads.mkdir-failed': {
    en: "Couldn't create the attachments directory ({dir}): {reason}",
    args: ['dir:text', 'reason:text'],
  },
  'uploads.module-missing': { en: "Rarog has no attachments module, so the attachment wasn't saved." },
  'uploads.not-image': { en: "The attachment isn't a PNG or JPEG image. Nothing was sent." },
  'uploads.too-many-files': {
    en: { one: 'At most {max} file per message.', other: 'At most {max} files per message.' },
    args: ['max:plural'],
  },
  'uploads.too-many-images': {
    en: { one: 'At most {max} photo per message.', other: 'At most {max} photos per message.' },
    args: ['max:plural'],
  },
  'uploads.write-failed': { en: "Couldn't save the attachment ({path}): {reason}", args: ['path:text', 'reason:text'] },
} as const satisfies SentenceArea;
