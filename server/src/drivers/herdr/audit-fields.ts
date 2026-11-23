/**
 * Audit log fields of a card, a module of the herdr driver: the card origin and the dialog shape of an evaluation
 * without a decision, without content. The audit entry itself and the moment of writing stay in the facade
 * `drivers/herdr-driver.ts`.
 */
import type { AuditCaseShape } from '../../herdr/audit.ts';
import type { CardOrigin, DegradeDiagnosis } from '../../herdr/dialogs/index.ts';

/**
 * Pola pochodzenia karty do wpisu dziennika: tożsamość karty i źródło z `ActiveReq.origin`,
 * bez treści. Karta bez pochodzenia (`/model`, karta sprzed oceny) daje sam `reqId`.
 */
export function originFields(reqId: string | null, origin: CardOrigin | undefined): AuditCaseShape {
  return {
    ...(reqId === null ? {} : { reqId }),
    ...(origin === undefined ? {} : {
      source: origin.source,
      ...(origin.toolUseId === undefined ? {} : { toolUseId: origin.toolUseId }),
      ...(origin.promptId === undefined ? {} : { promptId: origin.promptId }),
      ...(origin.agentId === undefined ? {} : { agentId: origin.agentId }),
      ...(origin.budgetSource === undefined ? {} : { budgetSource: origin.budgetSource }),
      ...(origin.hookPaneRows === undefined ? {} : { hookPaneRows: origin.hookPaneRows }),
      ...(origin.hookPaneCols === undefined ? {} : { hookPaneCols: origin.hookPaneCols }),
    }),
  };
}

/** Pola kształtu dialogu do wpisu dziennika — wartość `null` znaczy „brak pola”. */
export function diagnosisFields(diagnosis: DegradeDiagnosis): AuditCaseShape {
  return {
    ...(diagnosis.mismatchReason === null ? {} : { mismatchReason: diagnosis.mismatchReason }),
    ...(diagnosis.headerVisible === null ? {} : { headerVisible: diagnosis.headerVisible }),
    ...(diagnosis.optionCount === null ? {} : { optionCount: diagnosis.optionCount }),
    dialogTitle: diagnosis.dialogTitle,
  };
}
