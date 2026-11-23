#if os(iOS)
import RarogCore
import SwiftUI

/// Przycisk prawego panelu w grupie ikon nagłówka sesji: ten sam przełącznik co
/// Cmd+I, cichy glif jak sąsiedzi, a przy otwartym panelu — wypełnienie i stan „zaznaczony" dla czytnika. Na iPadzie
/// stoi tylko tam, gdzie panel się mieści (`inspectorAvailable`), więc tap zawsze przełącza; na telefonie otwiera
/// i zamyka arkusz panelu (`toggleInspectorSheet`). Właściciel: panel.
struct InspectorToggleButton: View {
  let store: RarogStore
  let navigation: RarogNavigation

  var body: some View {
    let phone = PopoverLayout.sheetBar
    let open = navigation.inspectorButtonSelected(store.state, phone: phone)
    Button {
      if phone { navigation.toggleInspectorSheet(store.state) } else { navigation.toggleInspector(store.state) }
    } label: {
      Label(UICopy.inspectorButton, systemImage: "sidebar.right")
    }
    .buttonStyle(HeaderIconButtonStyle(selected: open))
    .shortcutTip(UICopy.inspectorButton, .toggleInspector)
    .accessibilityLabel(UICopy.inspectorButton)
    .accessibilityAddTraits(open ? .isSelected : [])
    .accessibilityIdentifier("header.inspector")
  }
}
#endif
