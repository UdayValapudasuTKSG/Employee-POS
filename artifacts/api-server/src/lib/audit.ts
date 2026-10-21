import { db, activityLogTable } from "@workspace/db";

export interface AuditInput {
  actor: string;
  actorRole: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  beforeValue?: string | null;
  afterValue?: string | null;
  reason?: string | null;
  sourceIp?: string | null;
  companyCode?: string | null;
}

/** Anything that can run an insert: the pool, or a transaction handle. */
type Executor = Pick<typeof db, "insert">;

/**
 * Append an audit entry (activity_log, kind AUDIT). Append-only — never
 * deleted or updated.
 *
 * Pass `executor` to enlist in a caller's transaction. Without it the audit row
 * commits separately, so a crash between the business write and the audit write
 * loses the audit entry — which is why the change-request approval passes its
 * transaction handle.
 */
export async function writeAudit(input: AuditInput, executor: Executor = db): Promise<void> {
  await executor.insert(activityLogTable).values({
    kind: "AUDIT",
    actor: input.actor,
    actorRole: input.actorRole,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    beforeValue: input.beforeValue ?? null,
    afterValue: input.afterValue ?? null,
    reason: input.reason ?? null,
    sourceIp: input.sourceIp ?? null,
    companyCode: input.companyCode ?? null,
  });
}
