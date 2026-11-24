import Foundation
import RarogContract

// Session files: the listing of one directory (`GET /api/sessions/<id>/files?dir=`), the index of every file of the
// session directory (`GET /api/sessions/<id>/files/index`) and the fetch of one file
// (`GET /api/sessions/<id>/files/raw?path=`) straight to a private copy on disk, never whole in memory. All are
// reads, so they skip the mutation gate. The app keeps no size limit of its own: the caller passes `maxBytes` from
// the latest listing or the file index of the session. Paths in the query are encoded by `segment`, like the diff
// file path, because the server reads a plus in a query as a space. Owner: session files (native app).

/// The end of a file fetch that reached the server's answer. Every other failure throws a ``TransportError`` and
/// leaves no copy behind.
public enum SessionFileFetch: Sendable, Equatable {
  /// The copy on disk, in ``RarogClient/filePreviewDirectory`` with complete file protection, exactly the bytes the
  /// server announced in `Content-Length`. The caller owns the file from now on and deletes it.
  case saved(URL)
  /// The file is over the limit, so nothing was written: the server's 413 `file-too-large`, or a `Content-Length`
  /// over the caller's `maxBytes`. Both sizes are bytes.
  case tooLarge(size: Int, maxBytes: Int)
}

extension RarogClient {
  /// Where fetched copies go: `rarog-preview/` in the app's temporary directory, shared with image previews.
  public static var filePreviewDirectory: URL {
    FileManager.default.temporaryDirectory.appending(path: "rarog-preview", directoryHint: .isDirectory)
  }

  /// `GET /api/sessions/<id>/files?dir=<rel>` → one directory of the session, `dir` empty = the session directory.
  /// Refusals as `.http` with the code: 400 `bad-path`, `out-of-scope`, `codex`; 404 `not-found`.
  public func sessionFiles(sessionId: String, dir: String) async throws(TransportError) -> FileListing {
    let response = try await perform(.get(Self.filesRoute(sessionId: sessionId, dir: dir)))
    // The directory does not go into the error description: that one reaches the diagnostic log.
    return try decode(FileListing.self, from: response.body, path: "/api/sessions/\(Self.segment(sessionId))/files")
  }

  /// `GET /api/sessions/<id>/files/index` → every file of the session directory the server lists, files git ignores
  /// left out. Refusals as for the listing: 400 `out-of-scope`, `codex`; 404 `not-found`.
  public func sessionFileIndex(sessionId: String) async throws(TransportError) -> FileIndex {
    let route = Self.fileIndexRoute(sessionId: sessionId)
    let response = try await perform(.get(route))
    return try decode(FileIndex.self, from: response.body, path: route)
  }

  /// `GET /api/sessions/<id>/files/raw?path=<rel>` → the file's bytes in a private copy (``SessionFileFetch``).
  ///
  /// The body streams to the copy in chunks. A `Content-Length` over `maxBytes` ends the request before the copy
  /// exists. A body shorter or longer than its `Content-Length`, a missing `Content-Length`, a refusal (400, 404,
  /// 401 into the refusal latch), a lost connection, an invalidated client and a cancelled task throw, and the copy
  /// is deleted first.
  public func fetchSessionFile(
    sessionId: String, path: String, maxBytes: Int
  ) async throws(TransportError) -> SessionFileFetch {
    try await fetchSessionFile(sessionId: sessionId, path: path, maxBytes: maxBytes, into: Self.filePreviewDirectory)
  }

  /// The fetch into a given directory (tests use their own, so parallel runs do not see each other's copies).
  func fetchSessionFile(
    sessionId: String, path: String, maxBytes: Int, into directory: URL
  ) async throws(TransportError) -> SessionFileFetch {
    let route = Self.fileRawRoute(sessionId: sessionId, path: path)
    var request = try makeRequest(.get(route))
    request.setValue("application/octet-stream", forHTTPHeaderField: "Accept")
    // Decoded transfer encodings would make the counted bytes differ from `Content-Length`.
    request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
    let opened: ClientURLSession.OpenedBytes
    do {
      opened = try await session.bytes(for: request)
    } catch {
      throw Self.transportError(error)
    }
    let bytes = opened.bytes
    defer {
      // A refused or broken body must not keep streaming into the URL session's buffer.
      bytes.task.cancel()
      opened.pass.finish()
    }
    guard let http = opened.response as? HTTPURLResponse else {
      throw .invalidResponse("file response is not HTTP")
    }
    guard (200..<300).contains(http.statusCode) else {
      let body = await Self.errorBody(bytes)
      if http.statusCode == Self.fileTooLargeStatus,
        let tooLarge = try? JSONDecoder().decode(FileTooLargeBody.self, from: body)
      {
        return .tooLarge(size: tooLarge.size, maxBytes: tooLarge.maxBytes)
      }
      throw rejection(http, body: body, request: request)
    }
    guard let header = http.value(forHTTPHeaderField: "Content-Length"),
      let expected = Int(header.trimmingCharacters(in: .whitespaces)), expected >= 0
    else {
      throw .invalidResponse("file response without a valid Content-Length")
    }
    if expected > maxBytes { return .tooLarge(size: expected, maxBytes: maxBytes) }
    let copy = try Self.createCopy(in: directory, extensionOf: path)
    var kept = false
    defer { if !kept { try? FileManager.default.removeItem(at: copy) } }
    try await Self.stream(bytes, to: copy, expected: expected)
    kept = true
    return .saved(copy)
  }

  static let fileTooLargeStatus = 413

  /// Address of a directory listing; `dir` is encoded by hand with the closed set of `segment`.
  static func filesRoute(sessionId: String, dir: String) -> String {
    "/api/sessions/\(segment(sessionId))/files?dir=\(segment(dir))"
  }

  /// Address of the session's file index.
  static func fileIndexRoute(sessionId: String) -> String {
    "/api/sessions/\(segment(sessionId))/files/index"
  }

  /// Address of a file's bytes; `path` is encoded like `dir`.
  static func fileRawRoute(sessionId: String, path: String) -> String {
    "/api/sessions/\(segment(sessionId))/files/raw?path=\(segment(path))"
  }

  /// An empty file `<UUID>.<extension>` with complete file protection. The extension comes from the path's last
  /// component when it is short ASCII letters and digits; the server's name never becomes the file name.
  private static func createCopy(in directory: URL, extensionOf path: String) throws(TransportError) -> URL {
    let name = path.split(separator: "/").last.map(String.init) ?? ""
    let suffix = name.split(separator: ".", omittingEmptySubsequences: false).dropFirst().last.map(String.init) ?? ""
    let usable =
      !suffix.isEmpty && suffix.count <= 16 && suffix.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber) }
    let url = directory.appending(path: usable ? "\(UUID().uuidString).\(suffix)" : UUID().uuidString)
    do {
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    } catch {
      throw .invalidResponse("cannot create the copy's directory: \(error)")
    }
    let protection: [FileAttributeKey: Any] = [.protectionKey: FileProtectionType.complete]
    guard FileManager.default.createFile(atPath: url.path(percentEncoded: false), contents: nil, attributes: protection)
    else {
      throw .invalidResponse("cannot create the copy")
    }
    return url
  }

  /// The body into `copy` in chunks of ``chunkSize``; exactly `expected` bytes or an error.
  private static func stream(
    _ bytes: URLSession.AsyncBytes, to copy: URL, expected: Int
  ) async throws(TransportError) {
    let handle: FileHandle
    do {
      handle = try FileHandle(forWritingTo: copy)
    } catch {
      throw .invalidResponse("cannot open the copy: \(error)")
    }
    defer { try? handle.close() }
    var buffer = Data()
    buffer.reserveCapacity(min(expected, chunkSize))
    var received = 0
    do {
      for try await byte in bytes {
        received += 1
        if received > expected {
          throw TransportError.invalidResponse("file body longer than its Content-Length \(expected)")
        }
        buffer.append(byte)
        if buffer.count == chunkSize {
          try write(buffer, to: handle)
          buffer.removeAll(keepingCapacity: true)
        }
      }
    } catch {
      throw transportError(error)
    }
    guard received == expected else {
      throw .invalidResponse("file body of \(received) B, Content-Length \(expected)")
    }
    if !buffer.isEmpty { try write(buffer, to: handle) }
  }

  private static let chunkSize = 64 * 1024

  private static func write(_ data: Data, to handle: FileHandle) throws(TransportError) {
    do {
      try handle.write(contentsOf: data)
    } catch {
      throw .invalidResponse("cannot write the copy: \(error)")
    }
  }

  /// The body of a refusal, at most 64 kB: it is only a description, so a broken one stays empty.
  private static func errorBody(_ bytes: URLSession.AsyncBytes) async -> Data {
    var body = Data()
    do {
      for try await byte in bytes {
        body.append(byte)
        if body.count >= 64 * 1024 { break }
      }
    } catch {
      // A refusal without a readable body keeps its status.
    }
    return body
  }
}
