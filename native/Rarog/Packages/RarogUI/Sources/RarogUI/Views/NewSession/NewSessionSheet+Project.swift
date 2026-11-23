#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI

// Project section of the "New Session" sheet: the project row with Change and
// one row of recent project pills with More…; while browsing, Up with the path segments and New Directory (when the
// server creates directories there; it opens a name field in place), the filter field and compact directory rows (a
// tap on a row opens it). Cancel, "Choose <the directory on screen>" and the warning before choosing
// a directory without `git` and history stand in the sheet footer (`chooseFooter`, `NewSessionChooseBar`). The rules
// live in `Model/DirectoryBrowser`. Owner: session control.

extension NewSessionSheet {
  /// Directory row height: the 44 pt touch target, with no list inset above or below.
  static let dirRowHeight: CGFloat = 44

  // MARK: - Projekt

  var projectSection: some View {
    Section {
      if browser.browsing {
        browserRows
      } else {
        projectRow
        if !chips.isEmpty { recentRow }
      }
      if let cwdError {
        Text(cwdError)
          .appFont(.footnote)
          .foregroundStyle(Color(uiColor: Palette.err))
          .accessibilityIdentifier("newSession.cwdError")
      }
    } header: {
      // System section headers, as in Settings; muted ink `Palette.muted` (AA), because the system header grey
      // has ~4.4:1.
      Text(UICopy.projectLabel).foregroundStyle(Color(uiColor: Palette.muted))
    }
  }

  /// Row of the chosen project: name, shortened path, context line and Change.
  @ViewBuilder
  private var projectRow: some View {
    if let chosen = browser.chosen {
      let cwd = ProjectPath.normalized(chosen)
      let name = ProjectPath.name(cwd)
      let shortPath = PathText.shortPath(cwd)
      let context = ProjectContext.line(cwd: cwd, in: store.state)
      // No `lineLimit`: with `lineLimit(1)` the name and path were cut at larger text sizes (accessibility audit).
      // Name and path share one line, and a long path wraps instead of being cut. At accessibility sizes everything
      // stacks vertically and Change moves under the text — otherwise the path broke after every word.
      let large = typeSize.isAccessibilitySize
      let layout = large
        ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
        : AnyLayout(HStackLayout(alignment: .center, spacing: 12))
      let nameLayout = large
        ? AnyLayout(VStackLayout(alignment: .leading, spacing: 2))
        : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 8))
      layout {
        VStack(alignment: .leading, spacing: 2) {
          nameLayout {
            Text(name).appFont(.headline).foregroundStyle(Color(uiColor: Palette.text))
            Text(shortPath).appFont(.footnote.monospaced()).foregroundStyle(Color(uiColor: Palette.muted))
          }
          if let context {
            Text(context)
              .appFont(.caption.monospaced())
              .foregroundStyle(Color(uiColor: Palette.muted))
              .accessibilityIdentifier("newSession.projectContext")
          }
        }
        // At least 44 pt tall also at the smallest text sizes, the hit region the accessibility audit asks for.
        .frame(maxWidth: .infinity, minHeight: RecentChip.hitHeight, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(UICopy.projectSpoken(name: name, path: shortPath, context: context))
        .accessibilityIdentifier("newSession.project")
        Button(UICopy.changeProject) { openBrowser() }
          .buttonStyle(OutlineButtonStyle(color: Color(uiColor: Palette.muted)))
          .fixedSize()
          .accessibilityLabel(UICopy.changeDirectory)
          .accessibilityIdentifier("newSession.changeDirectory")
      }
    }
  }

  /// Recent project pills in one horizontally scrolling row with More… on the right (mockup A): one row keeps
  /// Conversations above the fold of the sheet. A tap chooses the project at once.
  private var recentRow: some View {
    let labels = PathField.chipLabels(chips)
    let current = browser.chosen.map(ProjectPath.normalized)
    return HStack(spacing: 10) {
      ScrollView(.horizontal) {
        HStack(spacing: 8) {
          ForEach(Array(chips.enumerated()), id: \.element) { index, cwd in
            let pressed = cwd == current
            Button {
              cwdError = nil
              browser.pick(cwd)
            } label: {
              RecentChip(label: labels[index], pressed: pressed)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(UICopy.recentChipSpoken(cwd))
            .accessibilityAddTraits(pressed ? .isSelected : [])
            .accessibilityIdentifier("newSession.recent.\(PathField.basename(cwd))")
          }
        }
      }
      .scrollIndicators(.hidden)
      .mask(LinearGradient(stops: [.init(color: .black, location: 0.88), .init(color: .clear, location: 1)],
                           startPoint: .leading, endPoint: .trailing))
      // The height sits on the label, so the button itself and its accessibility frame are 44 pt tall also at the
      // smallest text sizes; a frame around the button would leave the button at the text's height.
      Button { openBrowser() } label: {
        Text(UICopy.moreProjects)
          .frame(minHeight: RecentChip.hitHeight)
          .contentShape(Rectangle())
      }
      .buttonStyle(.borderless)
      .foregroundStyle(Color(uiColor: Palette.text))
      .fixedSize()
      .accessibilityIdentifier("newSession.moreProjects")
    }
  }

  /// Change and More…: the browser on the parent of the chosen project; the field takes focus only with a hardware
  /// keyboard (on touch the on-screen keyboard would cover the list).
  func openBrowser() {
    browser.change()
    pathFocused = PathField.focusesOnBrowse(hardwareKeyboard: TerminalKeyboard.isConnected())
  }

  // MARK: - Browser

  @ViewBuilder
  private var browserRows: some View {
    crumbRow(browser.crumbs)
    if let form = browser.creating { createRows(form) }
    HStack(spacing: 8) {
      Image(systemName: "magnifyingglass").foregroundStyle(Color(uiColor: Palette.muted)).accessibilityHidden(true)
      TextField(UICopy.filterPlaceholder, text: $path)
        .appFont(.body.monospaced())
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .keyboardType(.URL)
        .focused($pathFocused)
        .onChange(of: path) { _, value in
          guard value != browser.input else { return }
          cwdError = nil
          browser.type(value)
        }
        .onSubmit { browser.flush() }
        .accessibilityLabel(UICopy.filterPlaceholder)
        .accessibilityIdentifier("newSession.path")
    }
    directoryRows
    if let line = browser.view.statusLine {
      Text(line)
        .appFont(.footnote)
        .foregroundStyle(Color(uiColor: browser.failed ? Palette.err : Palette.muted))
        .accessibilityIdentifier("newSession.dirStatus")
    }
  }

  /// Up at the leading edge (disabled where there is nowhere to go), then the clickable path, leading-aligned: segments
  /// at or below a root lead there; those above and the current one are plain text. A long path scrolls, showing its
  /// end first.
  private func crumbRow(_ crumbs: [Crumb]) -> some View {
    HStack(spacing: 4) {
      Button {
        browser.goUp()
      } label: {
        Image(systemName: "chevron.up")
          .appFont(.body.weight(.semibold))
          .frame(minWidth: 44, minHeight: 44)
          .contentShape(Rectangle())
      }
      .buttonStyle(.borderless)
      .foregroundStyle(Color(uiColor: browser.up == nil ? Palette.muted2 : Palette.text))
      .disabled(browser.up == nil)
      .accessibilityLabel(UICopy.upSpoken(browser.up))
      .accessibilityIdentifier("newSession.up")
      crumbPath(crumbs)
      if browser.canCreate, browser.creating == nil {
        Button {
          browser.openCreate()
          dirNameFocused = true
        } label: {
          Image(systemName: "folder.badge.plus")
            .appFont(.body)
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .foregroundStyle(Color(uiColor: Palette.text))
        .accessibilityLabel(UICopy.newDirectory)
        .accessibilityIdentifier("newSession.newDirectory")
      }
    }
    .listRowInsets(EdgeInsets(top: 0, leading: 8, bottom: 0, trailing: 16))
  }

  /// The New Directory field in place of a sheet: the name, Cancel and Create in one row (stacked at accessibility
  /// sizes), the sentence of a failed attempt under it. Enter sends like Create.
  @ViewBuilder
  private func createRows(_ form: DirectoryCreate) -> some View {
    let large = typeSize.isAccessibilitySize
    let layout = large
      ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
      : AnyLayout(HStackLayout(alignment: .center, spacing: 12))
    layout {
      TextField(UICopy.newDirectoryPlaceholder, text: Binding(
        get: { browser.creating?.name ?? "" }, set: { browser.typeName($0) }))
        .appFont(.body.monospaced())
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .submitLabel(.done)
        .focused($dirNameFocused)
        .disabled(form.sending)
        .onSubmit { browser.submitCreate() }
        // The row separator starts under the field, not under Cancel (the first text the list finds).
        .alignmentGuide(.listRowSeparatorLeading) { $0[.leading] }
        .accessibilityLabel(UICopy.newDirectoryPlaceholder)
        .accessibilityIdentifier("newSession.dirName")
      HStack(spacing: 12) {
        Button {
          browser.cancelCreate()
          dirNameFocused = false
        } label: {
          Text(UICopy.cancel).frame(minHeight: 44).contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .foregroundStyle(Color(uiColor: Palette.muted))
        .accessibilityIdentifier("newSession.cancelCreate")
        Button(UICopy.createDirectory) { browser.submitCreate() }
          .buttonStyle(OutlineButtonStyle(color: Color(uiColor: Palette.text)))
          .disabled(!form.canSend)
          .accessibilityIdentifier("newSession.createDirectory")
      }
      .fixedSize()
    }
    .frame(minHeight: Self.dirRowHeight)
    .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
    if let error = form.error {
      Text(error)
        .appFont(.footnote)
        .foregroundStyle(Color(uiColor: Palette.err))
        .accessibilityIdentifier("newSession.createError")
    }
  }

  private func crumbPath(_ crumbs: [Crumb]) -> some View {
    ScrollView(.horizontal) {
      HStack(spacing: 2) {
        ForEach(Array(crumbs.enumerated()), id: \.element.id) { index, crumb in
          if index > 0 {
            Image(systemName: "chevron.compact.right")
              .appFont(.footnote)
              .foregroundStyle(Color(uiColor: Palette.muted2))
              .accessibilityHidden(true)
          }
          let last = index == crumbs.count - 1
          if crumb.leads {
            Button(crumb.label) { browser.enter(crumb.path) }
              .buttonStyle(.borderless)
              .appFont(.subheadline.monospaced())
              .foregroundStyle(Color(uiColor: Palette.text))
              .padding(.horizontal, 4)
              .frame(minHeight: 44)
              .accessibilityLabel(UICopy.recentChipSpoken(crumb.path))
              .accessibilityIdentifier("newSession.crumb.\(crumb.label)")
          } else {
            Text(crumb.label)
              .appFont(last ? .subheadline.monospaced().weight(.semibold) : .subheadline.monospaced())
              .foregroundStyle(Color(uiColor: last ? Palette.text : Palette.muted))
              .padding(.horizontal, 4)
              .frame(minHeight: 44)
          }
        }
      }
    }
    .scrollIndicators(.hidden)
    .defaultScrollAnchor(.leading, for: .alignment)
    .defaultScrollAnchor(.trailing, for: .initialOffset)
    .defaultScrollAnchor(.trailing, for: .sizeChanges)
  }

  @ViewBuilder
  private var directoryRows: some View {
    let view = browser.view
    if view.status == .loading {
      ForEach(0..<3, id: \.self) { _ in
        Text("katalog-projektu").redacted(reason: .placeholder).accessibilityHidden(true)
          .frame(maxWidth: .infinity, minHeight: Self.dirRowHeight, alignment: .leading)
          .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
      }
    } else {
      // One target per row: a tap anywhere opens the directory; the chevron is only a sign that it leads further.
      ForEach(view.entries) { entry in
        let marks = DirectoryView.marks(entry, current: browser.chosen)
        Button {
          browser.enter(entry.path)
        } label: {
          HStack(spacing: 8) {
            Image(systemName: "folder").foregroundStyle(Color(uiColor: Palette.muted))
            Text(entry.name)
              .appFont(.body.monospaced())
              .foregroundStyle(Color(uiColor: Palette.text))
              .lineLimit(1)
            Spacer(minLength: 8)
            if !marks.isEmpty {
              markLine(marks)
                .appFont(.footnote)
                .foregroundStyle(Color(uiColor: Palette.muted))
                .lineLimit(1)
            }
            Image(systemName: "chevron.right")
              .appFont(.footnote.weight(.semibold))
              .foregroundStyle(Color(uiColor: Palette.muted2))
          }
          .frame(minHeight: Self.dirRowHeight)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
        .accessibilityLabel(UICopy.dirRowSpoken(entry, marks: marks))
        .accessibilityHint(UICopy.dirRowHint)
        .accessibilityIdentifier("newSession.dir.\(entry.name)")
      }
    }
  }

  /// "current · git · history" as one text; the word `git` is a tool name, the same in every language.
  private func markLine(_ marks: [DirMark]) -> Text {
    var line = Text(verbatim: "")
    for (index, mark) in marks.enumerated() {
      if index > 0 { line = line + Text(verbatim: " · ") }
      switch mark {
      case .current: line = line + Text(UICopy.dirCurrent)
      case .git: line = line + Text("git")
      case .history: line = line + Text(UICopy.historyMarker)
      }
    }
    return line
  }

  /// Footer while browsing: the hint, Cancel (when there is something to return to) and
  /// "Choose <the directory on screen>" (none on the roots level), or the warning before choosing a directory without
  /// `git` and history (from mockup variant C).
  /// It stands in the sheet footer, not under the list, so a long list does not push it below the fold.
  var chooseFooter: some View {
    NewSessionChooseBar(
      warning: browser.warning?.sentence,
      targetName: browser.target?.name,
      canCancel: browser.chosen != nil,
      textCeiling: sheetSize.height * Self.footerTextShare,
      cancel: {
        cwdError = nil
        browser.cancel()
      },
      choose: { commitChoice { browser.choose() } },
      dismissWarning: { browser.dismissWarning() },
      chooseAnyway: { commitChoice { browser.chooseAnyway() } })
  }

  /// A choice closes the browser, so the field loses focus; a directory error concerned the previous choice.
  private func commitChoice(_ action: () -> Void) {
    action()
    if !browser.browsing {
      cwdError = nil
      pathFocused = false
    }
  }
}
#endif
