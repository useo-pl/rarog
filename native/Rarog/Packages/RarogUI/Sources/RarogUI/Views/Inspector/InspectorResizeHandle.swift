#if os(iOS)
import RarogCore
import SwiftUI
import UIKit

/// The width handle on the iPad panel's left divider: a clear strip 12 pt wide centred on the line, which stays as
/// drawn. Dragging it sets the width live (`RarogInspector.drag`), and the end or cancellation of the gesture saves
/// it once (`endDrag`). VoiceOver adjusts it in 40 pt steps within the same limits. Over the strip the iPad pointer
/// turns into a vertical beam with arrows to both sides (`ResizePointerArea`): SwiftUI `PointerStyle` is
/// unavailable on iOS, so the pointer comes from UIKit. Owner: panel.
struct InspectorResizeHandle: View {
  let inspector: RarogInspector
  /// True while a drag is in progress; it returns to false at the end and on cancellation alike.
  @GestureState private var dragging = false

  /// Width of the hit area around the divider (pt).
  static let hitWidth: CGFloat = 12

  var body: some View {
    ResizePointerArea()
      .frame(width: Self.hitWidth)
      .frame(maxHeight: .infinity)
      .contentShape(Rectangle())
      .gesture(
        // The global space: the handle moves with the panel's edge, so a local translation would feed back.
        DragGesture(minimumDistance: 1, coordinateSpace: .global)
          .updating($dragging) { _, state, _ in state = true }
          .onChanged { inspector.drag(translation: Double($0.translation.width)) }
      )
      .onChange(of: dragging) { _, active in
        if !active { inspector.endDrag() }
      }
      // Cmd+I or a session change can remove the handle mid-gesture; without this the live width would stay stuck.
      .onDisappear { inspector.endDrag() }
      .accessibilityElement()
      .accessibilityLabel(UICopy.inspectorWidthLabel)
      .accessibilityValue(UICopy.inspectorWidthValue(Int(inspector.displayedWidth.rounded())))
      .accessibilityAdjustableAction { direction in
        switch direction {
        case .increment: inspector.adjustWidth(by: InspectorModel.adjustmentStep)
        case .decrement: inspector.adjustWidth(by: -InspectorModel.adjustmentStep)
        @unknown default: break
        }
      }
      .accessibilityIdentifier("inspector.resize")
  }
}

/// A clear view that is the handle's hit target, so the pointer interaction on it receives hover; touches still reach
/// the SwiftUI drag gesture of the view that holds it.
private struct ResizePointerArea: UIViewRepresentable {
  func makeUIView(context: Context) -> UIView {
    let view = UIView()
    view.backgroundColor = .clear
    view.addInteraction(UIPointerInteraction(delegate: context.coordinator))
    return view
  }

  func updateUIView(_ uiView: UIView, context: Context) {}

  func makeCoordinator() -> Coordinator { Coordinator() }

  final class Coordinator: NSObject, UIPointerInteractionDelegate {
    /// Length of the beam (pt): about one line of body text, like the system's column divider.
    private static let beamLength: CGFloat = 22

    func pointerInteraction(_ interaction: UIPointerInteraction, styleFor region: UIPointerRegion) -> UIPointerStyle? {
      let style = UIPointerStyle(shape: .verticalBeam(length: Self.beamLength))
      style.accessories = [.arrow(.left), .arrow(.right)]
      return style
    }
  }
}
#endif
