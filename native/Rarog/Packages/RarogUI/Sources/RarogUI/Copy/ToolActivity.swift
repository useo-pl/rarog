// The ONLY app file with CLI tool names (exception of the source guard, `SourceGuardTests`). A tool name here is
// only a key of presentation: the verb and label copy, the glyph category and the typeface of the activity line.
// It decides nothing else. An unknown tool gets a fallback ("running: <name>", on the activity line the raw name), so
// a new CLI tool needs no new app version.
// Delegation (subagents, workflows) is not here: the server reports it in the `delegation` field.

/// Czasownik czynności narzędzia w wierszu aktywności.
public enum ToolActivity {
  static var verbs: [String: String] {
    [
      "Read": L("toolActivity.verbs.read"),
      "NotebookRead": L("toolActivity.verbs.notebookRead"),
      "Edit": L("toolActivity.verbs.edit"),
      "NotebookEdit": L("toolActivity.verbs.notebookEdit"),
      "Write": L("toolActivity.verbs.write"),
      "Bash": L("toolActivity.verbs.bash"),
      "BashOutput": L("toolActivity.verbs.bashOutput"),
      "KillShell": L("toolActivity.verbs.killShell"),
      "Grep": L("toolActivity.verbs.grep"),
      "Glob": L("toolActivity.verbs.glob"),
      "WebFetch": L("toolActivity.verbs.webFetch"),
      "WebSearch": L("toolActivity.verbs.webSearch"),
      "TodoWrite": L("toolActivity.verbs.todoWrite"),
    ]
  }

  /// Czynność dla nazwy narzędzia; nieznana nazwa → „uruchamia: <nazwa>", pusta → „używa narzędzia".
  public static func verb(for toolName: String?) -> String {
    guard let toolName, !toolName.isEmpty else { return L("toolActivity.verb.unnamed") }
    return verbs[toolName] ?? L("toolActivity.verb.unknown", toolName)
  }

  // MARK: Activity line

  /// Glyph category of a tool on the activity line.
  static let categories: [String: ToolCategory] = [
    "Read": .read, "NotebookRead": .read,
    "Grep": .search, "Glob": .search,
    "Edit": .edit, "Write": .edit, "NotebookEdit": .edit,
    "Bash": .run, "BashOutput": .run, "KillShell": .run,
    "WebFetch": .web, "WebSearch": .web,
  ]

  /// Line labels of the tools the line names by their action; every other tool shows its own name.
  static var lineLabels: [String: String] {
    [
      "Read": UICopy.activityLineReading,
      "NotebookRead": UICopy.activityLineReading,
      "Edit": UICopy.activityLineEditing,
      "NotebookEdit": UICopy.activityLineEditing,
      "Write": UICopy.activityLineWriting,
      "Bash": UICopy.activityLineRunning,
      "Grep": UICopy.activityLineSearching,
      "Glob": UICopy.activityLineSearching,
      "WebSearch": UICopy.activityLineSearchingWeb,
      "WebFetch": UICopy.activityLineFetching,
    ]
  }

  /// The glyph category of a tool: the table above, `mcp__…` names, the rest `other`.
  public static func category(for toolName: String?) -> ToolCategory {
    guard let toolName, !toolName.isEmpty else { return .other }
    if let category = categories[toolName] { return category }
    return mcpName(toolName) == nil ? .other : .mcp
  }

  /// The label of a tool on the activity line: the action for a known tool, a readable name for an MCP tool, the raw
  /// name otherwise, and a generic label when the server gave no name.
  public static func lineLabel(for toolName: String?) -> String {
    guard let toolName, !toolName.isEmpty else { return UICopy.activityLineUnnamedTool }
    return lineLabels[toolName] ?? mcpName(toolName) ?? toolName
  }

  /// `mcp__<server>__<tool>` → "<Server> <tool>": the server with a capital first letter, the tool without a repeated
  /// `<server>_` prefix, underscores as spaces (`mcp__firecrawl__firecrawl_search` → "Firecrawl search"). `nil` = not
  /// an MCP name (no server or no tool part).
  static func mcpName(_ toolName: String) -> String? {
    let prefix = "mcp__"
    guard toolName.hasPrefix(prefix) else { return nil }
    let rest = toolName.dropFirst(prefix.count)
    guard let split = rest.range(of: "__") else { return nil }
    let server = String(rest[..<split.lowerBound])
    var tool = String(rest[split.upperBound...])
    guard !server.isEmpty, !tool.isEmpty else { return nil }
    let repeated = server + "_"
    if tool.lowercased().hasPrefix(repeated.lowercased()), tool.count > repeated.count {
      tool = String(tool.dropFirst(repeated.count))
    }
    let words = (server + " " + tool).replacingOccurrences(of: "_", with: " ")
    return words.prefix(1).uppercased() + words.dropFirst()
  }
}

/// What a tool does, as the activity line draws it: the glyph, and whether the detail is set in a monospaced face
/// (machine text: a path, a command, a pattern).
public enum ToolCategory: Sendable, Equatable {
  case read
  case search
  case edit
  case run
  case web
  case mcp
  case other

  /// SF Symbol of the category.
  public var symbolName: String {
    switch self {
    case .read: "doc.text"
    case .search: "magnifyingglass"
    case .edit: "pencil"
    case .run: "terminal"
    case .web: "globe"
    case .mcp: "puzzlepiece.extension"
    case .other: "wrench.and.screwdriver"
    }
  }

  /// The detail is machine text (path, command, pattern) and gets the monospaced face.
  public var monoDetail: Bool {
    switch self {
    case .read, .search, .edit, .run: true
    case .web, .mcp, .other: false
    }
  }

  /// The detail names a file: the line shows its last path component.
  var detailIsFile: Bool { self == .read || self == .edit }
}
