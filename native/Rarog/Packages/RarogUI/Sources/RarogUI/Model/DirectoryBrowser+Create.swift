import Foundation
import RarogContract
import RarogCore

// New Directory in the New Session browser: a name field in place of a sheet, one request, and on success the
// browser enters the new directory. The server judges the name; the app only trims it. Owner: session control.
//
// - The button shows only on a ready listing whose `canCreate` is `true` (the roots level and an older server send
//   none) and in a form that has the create action.
// - A reply after the field's Cancel, the browser's Cancel or another navigation is late: the request takes a new
//   `token` like a navigation, and each of those moves it on.
// - 409 `dir-exists` lists the parent again with the sentence kept under the field: the transport never retries a
//   mutation, so after a lost reply the second attempt lands here and the directory shows in the list.

/// State of the open New Directory field.
public struct DirectoryCreate: Sendable, Equatable {
  /// The name as typed.
  public var name = ""
  /// The request is on its way: the field and Create wait.
  public var sending = false
  /// Sentence under the field: the server's refusal or a network sentence.
  public var error: String?

  /// What is sent: the name without spaces and line breaks at either end.
  var trimmed: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
  /// Create and Enter send: a name that is not blank, no request on its way.
  public var canSend: Bool { !sending && !trimmed.isEmpty }
}

extension DirectoryBrowser {
  /// New Directory can show: the listed directory is ready and the server says it creates directories there.
  public var canCreate: Bool {
    guard create != nil, view.status == .ready, let listing = view.listing else { return false }
    return listing.path != nil && listing.canCreate == true
  }

  /// New Directory: opens the name field.
  public func openCreate() {
    guard canCreate, creating == nil else { return }
    creating = DirectoryCreate()
  }

  /// Typing in the name field; a new name drops the previous sentence.
  public func typeName(_ value: String) {
    guard creating != nil else { return }
    creating?.name = value
    creating?.error = nil
  }

  /// Create or Enter: sends the trimmed name for the listed directory.
  public func submitCreate() {
    guard let form = creating, form.canSend, let create, view.status == .ready,
      let parent = view.listing?.path
    else { return }
    let name = form.trimmed
    creating?.sending = true
    creating?.error = nil
    token += 1
    let mine = token
    Task { [weak self] in
      let outcome = await create(parent, name)
      self?.finishCreate(outcome, parent: parent, token: mine)
    }
  }

  /// Cancel in the field: closes it; a request on its way no longer reaches the screen.
  public func cancelCreate() {
    if creating?.sending == true { token += 1 }
    creating = nil
  }

  private func finishCreate(_ outcome: DirectoryCreateOutcome, parent: String, token mine: Int) {
    guard mine == token, browsing, var form = creating else { return }
    form.sending = false
    switch outcome {
    case let .created(entry):
      // The row's facts under a fresh request number, so a late listing of the parent does not overwrite them.
      remember(DirListing(path: parent, parent: nil, entries: [entry]), request: nextRequest())
      created.insert(ProjectPath.normalized(entry.path))
      enter(entry.path)
    case let .exists(message):
      form.error = message ?? UICopy.createDirFailed
      navigate(parent, filter: view.filter)
      creating = form
    case .loggedOut:
      creating = form
    default:
      form.error = UICopy.createDirError(outcome)
      creating = form
    }
  }
}
