#if os(iOS)
import RarogCore
import SwiftUI

/// Arkusz „Dyktowanie” z mikrofonu pola wiadomości, gdy trasa dyktowania pyta: wybór zapisuje się i zamyka arkusz,
/// a nagrywanie zaczyna dopiero następne stuknięcie mikrofonu. Zamknięcie bez wyboru niczego nie zapisuje. Formularz
/// idzie przez `SheetHost` jak każdy arkusz.
struct DictationSheet: View {
  let store: RarogStore
  let navigation: RarogNavigation
  let request: DictationRequest
  @State private var model: DictationChoiceModel

  init(store: RarogStore, navigation: RarogNavigation, request: DictationRequest) {
    self.store = store
    self.navigation = navigation
    self.request = request
    _model = State(initialValue: DictationChoiceModel(store: store))
  }

  var body: some View {
    FormSheet(
      title: UICopy.dictationTitle(),
      close: SheetClose(label: UICopy.dictationClose(), identifier: "dictation.close") {
        navigation.closeSheet(id: request.id)
      }
    ) {
      DictationChoiceView(model: model, presentation: .sheet) { _ in
        navigation.closeSheet(id: request.id)
      }
    }
  }
}
#endif
