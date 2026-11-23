#if os(iOS)
import UIKit

/// The activity row standing alone at the top of the session foot while the field hides (a decision, a state card,
/// the grace before a dialog card): a narrow card of the field card's glass, so "interrupting",
/// "connecting…" or the agent's work stay on screen when Stop is gone. Its place stays reserved (unlike the field card's
/// band, which closes while idle), so the transcript does not move when the line comes and goes; the glass shows only while the row
/// has something to say. Owner: transcript.
final class FootActivityCard: UIView {
  /// Under the card stays the field's band (`ComposerView.bottomInset`) when nothing else of the foot shows, so its
  /// bottom stands where the field card's would; over a state card or the dock it sits on their own top margin.
  var restsOnFoot = true {
    didSet { bottomBand.constant = -(restsOnFoot ? ComposerView.bottomInset : 0) }
  }

  private let surface = GlassSurfaceView(radius: ComposerView.cardRadius, castsShadow: true)
  private let holder = UIView()
  private var bottomBand: NSLayoutConstraint!

  override init(frame: CGRect) {
    super.init(frame: frame)
    accessibilityIdentifier = "foot.activity"
    surface.isHidden = true
    for item in [surface, holder] {
      item.translatesAutoresizingMaskIntoConstraints = false
      addSubview(item)
    }
    let side = ListFooterMetrics.cardSide
    bottomBand = surface.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -ComposerView.bottomInset)
    NSLayoutConstraint.activate([
      surface.topAnchor.constraint(equalTo: topAnchor),
      surface.leadingAnchor.constraint(equalTo: leadingAnchor, constant: side),
      surface.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -side),
      bottomBand,
      // 2 pt over the row's own 6 pt and 6 pt under its 2 pt: 8 pt of air above and below the line.
      holder.topAnchor.constraint(equalTo: surface.topAnchor, constant: 2),
      holder.bottomAnchor.constraint(equalTo: surface.bottomAnchor, constant: -6),
      holder.leadingAnchor.constraint(equalTo: surface.leadingAnchor),
      holder.trailingAnchor.constraint(equalTo: surface.trailingAnchor),
    ])
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) unused")
  }

  /// The row moves here from the field card.
  func install(_ row: UIView) {
    row.removeFromSuperview()
    row.translatesAutoresizingMaskIntoConstraints = false
    holder.addSubview(row)
    NSLayoutConstraint.activate([
      row.topAnchor.constraint(equalTo: holder.topAnchor),
      row.bottomAnchor.constraint(equalTo: holder.bottomAnchor),
      row.leadingAnchor.constraint(equalTo: holder.leadingAnchor),
      row.trailingAnchor.constraint(equalTo: holder.trailingAnchor),
    ])
  }

  /// The glass only under a line with content: an empty reserved place leaves no card on screen.
  func setContent(_ has: Bool) {
    if surface.isHidden == has { surface.isHidden = !has }
  }
}
#endif
