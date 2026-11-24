/**
 * Server start: the folder gate. With the gate on, it makes the relay client and the gate of the process, routes the
 * work-area disk port through them and starts the helper of each guarded folder that holds a root, so the first real
 * call there does not pay for the start. With the gate off (the kill switch, Linux, the demo) it makes nothing and
 * every disk call stays in the server process. It touches no guarded folder: a helper starts on a call on `/`.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { FOLDER_SYNC_BOUND_MS, RelayFolderClient } from '../folder-gate/client.ts';
import { routeWorkAreaDisk } from '../folder-gate/disk.ts';
import { MacFolderGate } from '../folder-gate/gate.ts';
import { folderHelperCommand } from '../folder-gate/helper.ts';
import { installFolderGate } from '../folder-gate/install.ts';
import type { FolderGate } from '../folder-gate/types.ts';
import { INSTALL_MODE, INSTALL_ROOT, type InstallMode } from '../install/mode.ts';

export interface FolderGateStart {
  /** `RarogConfig.folderGate`. */
  readonly enabled: boolean;
  /** The home directory whose guarded folders the gate keeps. */
  readonly home: string;
  /** Project and pane roots: the helper of a guarded folder that holds one starts right away. */
  readonly roots: readonly string[];
  readonly log: (line: string) => void;
}

export interface FolderGateRuntime {
  readonly gate: FolderGate;
  /** Stops the gate, kills every helper and gives the disk calls back to the server process; never waits. */
  dispose(): void;
}

/** The module of the relay thread for the install at `root`: TypeScript in a clone, JavaScript in the package. */
export function folderRelayUrl(root: string = INSTALL_ROOT, mode: InstallMode = INSTALL_MODE): URL {
  const file = mode === 'package' ? 'relay-worker.js' : 'relay-worker.ts';
  return pathToFileURL(path.join(root, 'server', 'src', 'folder-gate', file));
}

/** Installs the gate when `enabled`; `null` when off, and then nothing was made. */
export function startFolderGate(options: FolderGateStart): FolderGateRuntime | null {
  if (!options.enabled) {
    options.log('folder gate: off, disk calls in guarded folders run in the server process');
    return null;
  }
  const client = new RelayFolderClient({ relay: folderRelayUrl(), helper: folderHelperCommand() });
  const gate = new MacFolderGate({ home: options.home, client, boundMs: FOLDER_SYNC_BOUND_MS, log: options.log });
  const uninstall = installFolderGate(gate);
  const unroute = routeWorkAreaDisk({ gate, client, home: options.home });
  options.log('folder gate: on, disk calls in guarded folders run in a helper process per folder');
  const folders = new Set<string>();
  for (const root of options.roots) {
    const folder = gate.stateOf(root)?.folder;
    if (folder !== undefined) folders.add(folder);
  }
  for (const folder of [...folders].sort()) {
    // A call on `/`, not in the folder: the helper starts, and macOS has nothing to ask about.
    void client.call(folder, 'lstat', { path: '/' });
    options.log(`folder gate: started the helper of ${path.basename(folder)}, a root lies in it`);
  }
  let disposed = false;
  return {
    gate,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      unroute();
      uninstall();
      gate.dispose();
      client.dispose();
    },
  };
}
