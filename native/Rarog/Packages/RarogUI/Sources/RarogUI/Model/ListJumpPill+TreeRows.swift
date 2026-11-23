import RarogCore

// The jump pill's rows from the tree rows the list shows (`RarogNavigation.treeRows`). Owner: list.

extension ListJumpPill.Row {
  /// A tree row as the pill's rule sees it: an agent row with the tone of its dot and the name the tree row draws
  /// (`SessionRowModel.treeTitle`); a project header and the filter's sentence row need nothing from the human.
  public init(_ row: ProjectTreeRow) {
    switch row {
    case let .header(header): self = .project(header.row.cwd)
    case let .session(session):
      // "Unread" means a pulsing dot, as in the filter: a result marked unread by hand keeps a still dot.
      let tone = session.status.tone == .unread && !session.freshResult ? .quiet : session.status.tone
      self = .session(session.id, tone: tone, name: session.treeTitle)
    case .emptyFilter: self.init(id: .emptyFilter, attention: nil, name: "")
    }
  }
}
