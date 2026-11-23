import Foundation

// Drzewo projektów na liście. Właściciel: lista i projekty.
extension UICopy {
  // MARK: Nagłówek projektu

  public static var treeExpand: String { L("tree.expand") }
  public static var treeCollapse: String { L("tree.collapse") }
  public static var treeExpandAll: String { L("tree.expandAll") }
  public static var treeCollapseAll: String { L("tree.collapseAll") }
  public static var treeExpandedValue: String { L("tree.expandedValue") }

  /// Wartość nagłówka dla czytnika: ilu agentów widać mimo zwinięcia (praca, uwaga, otwarta sesja).
  public static func treeCollapsedValue(shown: Int, total: Int) -> String {
    L("tree.collapsedValue", shown, total)
  }

  /// Etykieta strzałki: skutek tapnięcia i projekt.
  public static func treeToggleLabel(collapse: Bool, project: String) -> String {
    collapse ? L("tree.toggleLabel.collapse", project) : L("tree.toggleLabel.expand", project)
  }
}
