#if os(iOS)
import RarogCore
import SwiftUI

// The Inbox button beside the filter capsule of the session list, a glass circle on its right. It exists only when
// the server has an Inbox; the amber badge counts the cards that wait for the human or carry an unread result
// (`inboxCount`), and zero shows no badge. Owner: Inbox.

/// The tray glyph in a 44 pt glass circle (`FilterGlass`), apart from the filter capsule: it opens a screen instead
/// of filtering the list. The open Inbox has the filter's plate; the pointer gives half of it, like a segment.
struct InboxButton: View {
  let store: RarogStore
  let navigation: RarogNavigation

  var body: some View {
    let state = store.state
    if state.inboxAvailable {
      let count = state.inboxCount
      let active = navigation.detail == .inbox
      RarogHoverReader(enabled: true) { hovered in
        Button {
          navigation.openInbox()
        } label: {
          Image(systemName: "tray")
            .appFont(.body)
            .foregroundStyle(Color(uiColor: active || hovered ? Palette.text : Palette.text2))
            .frame(width: ListFilterBar.plateHeight, height: ListFilterBar.plateHeight)
            .background {
              let plate = Color(uiColor: Palette.filterGlassPlate)
              if active {
                Circle().fill(plate)
              } else if hovered {
                Circle().fill(plate.opacity(HoverTokens.agentRowAlpha))
              }
            }
            .padding(ListFilterBar.trackInset)
            .background { FilterGlass(shape: Circle()) }
            .overlay(alignment: .topTrailing) {
              if count > 0 { InboxBadge(count: count) }
            }
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
      }
      .pointerTip(UICopy.inboxTitle)
      .accessibilityLabel(UICopy.inboxTitle)
      .accessibilityValue(count > 0 ? UICopy.inboxCountSpoken(count) : "")
      .accessibilityAddTraits(active ? .isSelected : [])
      .accessibilityIdentifier("list.inbox")
    }
  }
}

/// The count on the circle's top right: an amber capsule with a dark digit (white in the light theme).
private struct InboxBadge: View {
  let count: Int

  var body: some View {
    Text(count, format: .number)
      .appFont(.caption.weight(.bold).monospacedDigit())
      .foregroundStyle(Color(uiColor: Palette.dynamic(PaletteTokens.inboxBadgeInk)))
      .lineLimit(1)
      .fixedSize()
      .padding(.horizontal, 5)
      .frame(minWidth: 18, minHeight: 18)
      .background(Capsule().fill(Color(uiColor: Palette.dynamic(PaletteTokens.inboxBadge))))
      .offset(x: 2, y: -2)
      .accessibilityHidden(true)
  }
}
#endif
