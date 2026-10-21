/**
 * The legal notice printed at the foot of every card. [POLICYHOLDER] appears
 * twice and is replaced by the member's policyholder (their employer).
 */
export const LEGAL_NOTICE_TEMPLATE =
  "This card remains the property of North American Life Insurance Co. Ltd. " +
  "and is valid only for so long as the named member remains in the employment " +
  "of [POLICYHOLDER]. Presentation or use of this card in breach of the terms " +
  "and conditions of the governing policy shall render any claim arising " +
  "therefrom void and not payable. Claims will be honoured solely in respect of " +
  "eligible services rendered during the period of the member's employment " +
  "with [POLICYHOLDER].";

export function legalNotice(policyholder: string): string {
  const name = String(policyholder ?? "").trim() || "the policyholder";
  return LEGAL_NOTICE_TEMPLATE.split("[POLICYHOLDER]").join(name);
}
