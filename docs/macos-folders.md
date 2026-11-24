# macOS folders: the folder gate

macOS asks before a process reads a guarded folder of home (`Desktop`, `Documents`, `Downloads`, `Library`,
`Movies`, `Music`, `Pictures`), and the disk call waits in the kernel until someone answers the window at the Mac. On
a Mac used remotely nobody sees that window. A call that waits on the server's main thread or in Node's thread pool
would hold the whole server, and `process.exit` waits for such a thread too. The folder gate keeps these calls out of
the server process. It is on by default on macOS; `RAROG_FOLDER_GATE` switches it (`docs/server-config.md`,
"Preferences and feature flags").

The gate does not change the work area: the guarded folders stay outside it unless a root lies in one
(`docs/security-model.md`, "Work area: where Rarog starts, lists and reads"). It decides where a call in such a
folder runs and what happens when macOS does not answer.

## Where a call runs

The work area reads the disk through one port, `DIRECT_DISK` in `server/src/folder-gate/disk.ts`:

- Metadata (`lstat`, `stat`, `readlink`, `realpath`) runs in the server process in every case: macOS answers it
  without a window.
- A call whose target lies outside the guarded folders runs in the server process.
- Any other call in a guarded folder (listing, reading, opening, writing, the folder check) runs in a helper process
  of that folder (`server/src/folder-gate/helper.ts`): a `node` child with `/` as its directory and an empty
  environment, one per folder. One relay thread in the server (`relay-worker.ts`) starts the helpers and moves the
  request and answer lines; it never touches the disk.

The port finds the folder by the text of the path first, in any spelling of home (as written, on disk, another letter
case). Then it walks the path one segment at a time with `lstat` and `readlink`, so a symlink into a guarded folder
(`~/.claude/skills/x -> ~/Documents/x`, a parent link of a file) leads the call to that folder's helper. A segment
that does not exist counts as a plain directory, so a path a write is about to create is judged by its text. A handle
from `openRead` is the port's own number; `read` and `close` go where the file was opened, and only while the helper
that opened it lives. A new helper of the folder can give the same number to another file, so after a restart `read`
of an older handle fails with `EBADF` and `close` of it succeeds without a call.

A directory read by identity (`readdirByIdentity`; on macOS through `/.vol/<dev>/<ino>`, which follows the directory
wherever it went) runs only while `lstat` still finds that directory under the path the call names. Otherwise the
call gives `null` and nothing is read, so a directory moved into a guarded folder is not read in the server process.
A move that lands between that `lstat` and the read is not seen.

A sync call waits at most `FOLDER_SYNC_BOUND_MS` (1 s) and an async call at most `FOLDER_CALL_BOUND_MS` (1 s; a write
gets 1 s per started megabyte), both in `server/src/folder-gate/client.ts`. A sync call blocks the main thread for that
time once; the next calls in the folder are refused without waiting.

## Folder states

| State | A call in the folder | Sentence of a refusal |
| --- | --- | --- |
| `unknown`, `open` | runs in the helper | none |
| `waiting` | refused without the disk | `rest.cwd-folder-waiting` |
| `denied` | refused without the disk | `rest.cwd-folder-denied` |
| `absent` | refused without the disk | `rest.cwd-not-found` |
| `unchecked` | refused without the disk | `rest.cwd-folder-unchecked` |

`server/src/folder-gate/gate.ts` keeps the states:

- No answer within the bound: the folder enters `waiting`, the server kills its helper with SIGKILL and checks the
  folder at once on a new helper (`opendir` and the first entry), then every 60 s (`FOLDER_RECHECK_MS`). A late
  answer that succeeds opens the folder.
- A check that succeeds gives `open`; `EPERM` or `EACCES` gives `denied`, `ENOENT` or `ENOTDIR` gives `absent`, a
  helper that is gone or any other code gives `unchecked`. These three are checked again every 5 min
  (`FOLDER_RECHECK_SLOW_MS`).
- `EPERM` or a helper gone during an ordinary call starts a check on a new helper; the state stays until its answer.
- A folder nobody judged yet (`unknown`) opens without a check of its own on the first listing, or regular file
  opened and read, that its helper answers, when the real path of what was read lies in the folder. Metadata and a
  path that leaves the folder through a symlink inside it open nothing, because a lookup in the folder never waits
  for the window; a write, a removal and a read by identity open nothing either. A closed folder opens only by a
  check or a late answer.
- An answer of an older helper generation changes nothing.
- Each change writes a log line, for example `folder gate: Documents waiting (no answer in 1000 ms)`.
- Each change of the list of `waiting`, `denied` and `unchecked` folders goes to the app as the volatile SSE frame
  `folder-access` (`docs/implementation-spec.md`); a stream gets the current list right after `sessions-snapshot`,
  also when it is empty. With the gate off the server sends no such frame.

A refused call fails with `FolderGateError` (code `EFOLDERGATE`), which carries the folder, its state and the
sentence. The symlink walk of the work area (`resolveInWorkArea`) counts a closed folder as excluded, never as a
missing segment, so a directory there is outside the work area and git does not run in it. Metadata passes a closed
folder, so the walk asks the port for the folder's state before each segment (`closedFolderOf`). A caller that passes
`gate: 'ignore'` (`WalkOptions` in `server/src/config/work-area.ts`) gets the walk without that question; only pane
scope does.

## What a closed folder refuses

A session already known in a closed folder keeps its transcript, messages and consent cards; the features that read
its directory refuse, with the status they give for a path that cannot be read and the sentence of the folder's state.

Pane scope ignores the gate (`scopeOf` in `server/src/herdr/supervisor.ts`): a pane found in a closed folder that a
root opens, or one that moves there with `cd`, is in scope as with the folder open, and a change of the folder's state
does not recompute the scope of a known pane. The other users of the work-area rule keep the gate, so they count
such a directory outside the work area while the folder is closed: the verdict that explains a card without a hook
(`server/src/bootstrap/consent.ts`), the attachment thumbnails (`server/src/herdr/uploads.ts`), the session files
(`server/src/files/session-gate.ts`), and the diff and the command list (`sessionCwdInArea` and `inCommandScope` in
`server/src/sessions/companion-scope.ts`). The voice agent and the Inbox (`companionTargetOf`) ignore the gate like
pane scope: they read the transcript from the engine's store, not from the session directory, so a closed folder
keeps the session's catalog entry, turns, questions, result pick-up and Inbox card.


- **New session:** a directory in a closed folder that a root opens is refused with 400 and the sentence of the state
  (`validateProjectCwd` in `server/src/config/roots.ts`), also through a symlink in a root. A folder no root opens
  keeps the sentence of a protected folder. A directory from the configured project list is refused the same way,
  judged by its text without the disk (`checkCwd` in `server/src/routes/projects.ts`), so the resumable conversations
  and the notes of such a project answer 400 too; the demo is not affected. The project list leaves out a closed
  folder and every folder of a root inside it (`server/src/sessions/project-scan.ts`).
- **Directory browser and New Session folder** (`GET /api/fs`, `POST /api/fs/mkdir`): 404 `not-found` with the
  sentence of the state, never an empty listing, and no directory is created.
- **Session files** (`GET /api/sessions/:id/files`, `…/files/index`, `…/files/raw`): 404 `not-found` with the
  sentence of the state, for a session directory in a closed folder and for a folder that closes while a listing, an
  index or an open runs (`server/src/files/`). A file opens with the port's `openRead`, and the download reads and
  closes it through the port's handle, so a file in a guarded folder is read in that folder's helper.
- **Attachments:** a write is refused with the sentence of the state (`server/src/herdr/uploads.ts`). A write the
  helper did not answer in time may still land, so its directory goes to the attachments registry anyway and the next
  sweep removes the file. The start sweep enters no guarded folder until the gate holds it `open` (a folder nobody
  checked yet waits too); that part of the sweep runs when the folder opens, and nothing is read there before. It
  runs only while its directory still resolves to itself: a directory that has since become a symlink is skipped with
  one log line. A walk of the roots writes the attachments registry only after such a part ran, so a server stopped
  before the folder opened walks the roots again at the next start.
- **Git:** the runner (`server/src/git-status.ts`) starts no git whose directory or work tree lies in a closed folder
  and answers as for a process that did not start (`EFOLDERGATE`). The session's git status and `.git` watcher wait
  while the folder is closed and come back, with one fresh read, when it opens (`server/src/sessions/session-git.ts`).
- **Trust check:** the worktree file `.git` that cannot be read gives the answer "not trusted", so the session starts
  with the trust warning (`server/src/herdr/trust.ts`).
- **Hook list:** a settings file in a closed folder is no proof, never an absent file (`nodeHookListIo`).
- **Commands:** the commands and skills of the project leave the command catalog, with a log line naming the
  directory; the user's own commands stay, and the send gate answers from that catalog
  (`server/src/herdr/commands/discover.ts`).

## Start and exit

With the gate on, the server starts the helper of each guarded folder that holds a project or pane root at once, with
a call on `/`, so nothing in the folder is read at start. Every other helper starts on the first call in its folder.
The start log says `folder gate: on, …` or `folder gate: off, …`.

The helpers are not detached, so a stop of the launchd job ends them with the server. The client's exit hook sends
SIGKILL to every helper by pid, so the server ends on `process.exit` and on SIGTERM in the usual time while a helper
waits on a window.

## Not through the gate

These reads run in the server process and can touch a guarded folder through a path a user chose:

- the `.git` watcher of a session (`server/src/git-watch.ts`): `fs.watch` waits for the window, so it runs only while
  every guarded folder of the watched directories is `open`, each directory judged as written and where it resolves,
  in any spelling of home, as the port judges a path (an `unknown` folder gets a check first); a folder that
  closes stops it, and `open` starts it again with one read;
- `~/.claude/settings.json` and the hook entries in it, when they are symlinks (`server/src/config/claude-account.ts`,
  `server/src/herdr/hook-config.ts`).

Git runs in child processes with the session directory as `cwd`, and the directory creation of the New Session form
in a child process with a time limit (`server/src/fs-mkdir.ts`). The list of direct imports that stay is
`DIRECT_IMPORTS` in `server/test/folder-gate-boundary.test.ts`, with a reason for each.
