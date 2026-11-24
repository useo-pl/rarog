/**
 * The refusals of the session file routes: status, contract code and sentence, ready for `sendError` of the router.
 * One table for the gate, the path rule and the listing, so both routes refuse a path the same way. The module only
 * builds values; it reads nothing.
 */
import {
  FILES_BAD_PATH_ERROR, FILES_CODEX_ERROR, FILES_NOT_FOUND_ERROR, FILES_OUT_OF_SCOPE_ERROR, FILE_TOO_LARGE_ERROR,
} from '@rarog/shared';
import type { FileTooLargeBody } from '@rarog/shared';
import { type ServerSentence, say } from '@rarog/shared/sentences';

/** A refusal of a request before any byte of a listing or a file. */
export interface FilesRefusal {
  readonly status: 400 | 404;
  readonly code:
    | typeof FILES_BAD_PATH_ERROR | typeof FILES_OUT_OF_SCOPE_ERROR | typeof FILES_CODEX_ERROR
    | typeof FILES_NOT_FOUND_ERROR;
  readonly sentence: ServerSentence;
}

/** The path failed the shape check; the same sentence as a bad path of the diff routes. */
export const BAD_PATH: FilesRefusal = { status: 400, code: FILES_BAD_PATH_ERROR, sentence: say('rest.diff-bad-path') };

/** Nothing to list or send under the path, or the server never shows it: one answer, so it tells nothing apart. */
export const NOT_FOUND: FilesRefusal = {
  status: 404, code: FILES_NOT_FOUND_ERROR, sentence: say('rest.files-not-found'),
};

/** A Codex entry: Rarog only observes it. */
export const CODEX: FilesRefusal = { status: 400, code: FILES_CODEX_ERROR, sentence: say('rest.files-codex') };

/** A pane outside the work area, or a session directory outside it on disk. */
export const OUT_OF_SCOPE: FilesRefusal = {
  status: 400, code: FILES_OUT_OF_SCOPE_ERROR, sentence: say('rest.files-out-of-scope'),
};

/** A session without a herdr pane: out of scope too, with its own sentence. */
export const NO_PANE: FilesRefusal = {
  status: 400, code: FILES_OUT_OF_SCOPE_ERROR, sentence: say('rest.files-no-pane'),
};

const MIB = 1024 * 1024;

/** The 413 of a file over the limit: the sentence and the fields the body adds to the error (`size`, `maxBytes`). */
export interface FileTooLarge {
  readonly status: 413;
  readonly code: typeof FILE_TOO_LARGE_ERROR;
  readonly sentence: ServerSentence;
  readonly extra: Pick<FileTooLargeBody, 'size' | 'maxBytes'>;
}

/**
 * The refusal of a file of `size` bytes over `maxBytes`. The sentence gives whole megabytes, the size rounded up, so
 * a file one byte over the limit never reads as equal to it.
 */
export function fileTooLarge(size: number, maxBytes: number): FileTooLarge {
  return {
    status: 413,
    code: FILE_TOO_LARGE_ERROR,
    sentence: say('rest.file-too-large', { size: Math.ceil(size / MIB), limit: Math.floor(maxBytes / MIB) }),
    extra: { size, maxBytes },
  };
}
