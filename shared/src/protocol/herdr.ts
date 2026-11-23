/**
 * Protocol contract, herdr area: the pane's permission mode read from the screen and the availability of the herdr
 * integration (`HerdrStatus`, the source of the "herdr unavailable" banner and of the launch permission).
 *
 * Re-exported unchanged by `shared/src/protocol.ts`; code imports the names from there.
 */
import { z } from 'zod';
import { type SentenceRef, sentenceRefSchema } from '../sentences/index.ts';

/** Tryb uprawnień panelu odczytany ze stopki ekranu (`⏵⏵ … mode on`). */
export type HerdrMode = 'manual' | 'plan' | 'auto' | 'bypass' | 'unknown';
export const herdrModeSchema = z.enum(['manual', 'plan', 'auto', 'bypass', 'unknown']);

/**
 * Dostępność integracji herdr — jedyne źródło banera „herdr niedostępny" w kliencie.
 *
 * `readOnly: true` = herdr działa, ale mutacje są zablokowane (nieznany protokół albo
 * `RAROG_HERDR_SEND=0`). To NIE jest to samo co `available: false`: przy tylko-odczycie
 * lista sesji jest prawdziwa i świeża, po prostu composer nic nie wyśle.
 */
export interface HerdrStatus {
  available: boolean;
  agentCount: number;
  readOnly: boolean;
  /**
   * Rarog wolno ZAŁOŻYĆ nową sesję (panel) w herdr.
   *
   * `false` przy `RAROG_HERDR_LAUNCH=0`, nieznanym protokole albo osiągniętym suficie
   * `RAROG_MAX_PANES`. Rozłączne z `readOnly` (kanał PISANIA do istniejących paneli):
   * killswitche są dwa i wyłączają dwie różne władze (`docs/security-model.md`, „There are FIVE killswitches…”).
   */
  canLaunch: boolean;
  version?: string;
  protocol?: number;
  /**
   * ZDANIE dla człowieka, dlaczego jest tak, jak jest — a nie kod ani nazwa flagi.
   *
   * Niesie je transport (nieznany protokół, zerwane gniazdo) ALBO nadzorca, gdy jedynym
   * powodem zgaszonego `canLaunch` jest sufit `RAROG_MAX_PANES` — wtedy stoi tu
   * dokładnie to samo zdanie, którym `POST /api/sessions` odmawia siódmego panelu
   * (`HERDR_PANE_CAP_MESSAGE`), czyli takie, które MÓWI WYJŚCIE: zamknij którąś sesję.
   *
   * Klient używa go jako copy przy wygaszonych „+"/„Nowa sesja" i ma pierwszeństwo przed jego
   * własnym, ogólnym zdaniem. Puste `detail` przy `canLaunch: false`
   * znaczy więc „powód jest strukturalny" (killswitch), a nie „nie wiadomo".
   */
  detail?: string;
  /** Kod i argumenty zdania `detail`, gdy serwer powiedział je przez `say()`; apka tłumaczy kod. */
  detailRef?: SentenceRef;
}

export const herdrStatusSchema = z.object({
  available: z.boolean(),
  agentCount: z.number(),
  readOnly: z.boolean(),
  canLaunch: z.boolean(),
  version: z.string().optional(),
  protocol: z.number().optional(),
  detail: z.string().optional(),
  detailRef: sentenceRefSchema.optional(),
});

type _HerdrStatusSchemaMatchesType =
  z.infer<typeof herdrStatusSchema> extends HerdrStatus ? true : never;
type _HerdrStatusTypeMatchesSchema =
  HerdrStatus extends z.infer<typeof herdrStatusSchema> ? true : never;
const _herdrStatusSchemaMatchesType: _HerdrStatusSchemaMatchesType = true;
const _herdrStatusTypeMatchesSchema: _HerdrStatusTypeMatchesSchema = true;
void _herdrStatusSchemaMatchesType;
void _herdrStatusTypeMatchesSchema;
