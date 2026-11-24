#if os(iOS)
import QuickLook
import SwiftUI
import UIKit

// QuickLook for a file of the Files tree. The preview stands from the panel's own view controller: on the phone that
// is the panel sheet, so the preview covers the sheet and closing it returns to the panel (a sheet from the root
// would take the panel down). The copy belongs to the preview from the moment it stands until it closes.
// Owner: panel.

/// Presents ``FilePreviewCopy`` from the view controller that holds ``anchor``, a view inside the panel.
@MainActor
final class FilePreviewPresenter {
  weak var anchor: UIView?

  /// `false` when nothing can stand now: the panel left the window, or its view controller already shows something
  /// (another preview, the diff window). The caller then deletes the copy.
  func present(_ copy: FilePreviewCopy) -> Bool {
    guard let anchor, anchor.window != nil, let host = Self.controller(of: anchor),
      host.presentedViewController == nil, !host.isBeingDismissed
    else { return false }
    let preview = FilePreviewController(copy: copy)
    host.present(PreviewPresentation.controller(for: preview), animated: true)
    return true
  }

  /// The nearest view controller up the responder chain.
  private static func controller(of view: UIView) -> UIViewController? {
    var responder: UIResponder? = view
    while let next = responder?.next {
      if let controller = next as? UIViewController { return controller }
      responder = next
    }
    return nil
  }
}

/// QuickLook over one fetched copy, titled with the real file name. It owns the copy: closing the preview deletes it,
/// and so does the controller going away.
final class FilePreviewController: RarogQuickLookController, QLPreviewControllerDataSource {
  let copy: FilePreviewCopy
  private let item: ImagePreviewItem

  init(copy: FilePreviewCopy) {
    self.copy = copy
    item = ImagePreviewItem(url: copy.url, title: copy.title)
    super.init(nibName: nil, bundle: nil)
    dataSource = self
    accessibilityViewIsModal = true
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) unused")
  }

  override func viewDidDisappear(_ animated: Bool) {
    super.viewDidDisappear(animated)
    if isClosing { copy.discard() }
  }

  func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }

  func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> any QLPreviewItem { item }
}

/// An invisible view inside the panel that hands itself to the presenter as its anchor.
struct FilePreviewAnchor: UIViewRepresentable {
  let presenter: FilePreviewPresenter

  func makeUIView(context: Context) -> UIView {
    let view = UIView()
    view.isUserInteractionEnabled = false
    view.isAccessibilityElement = false
    presenter.anchor = view
    return view
  }

  func updateUIView(_ view: UIView, context: Context) {
    presenter.anchor = view
  }
}
#endif
