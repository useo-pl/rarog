import Foundation
import RarogContract

// Session file selectors. Owner: session files (native app).

extension AppState {
  /// The server serves session directories and files (`files` in `GET /api/version`).
  public var filesAvailable: Bool { capabilities?.files == true }

  /// The server also sends the file index of a session (`file-index` next to `files` in `GET /api/version`).
  public var fileIndexAvailable: Bool { filesAvailable && capabilities?.fileIndex == true }
}
