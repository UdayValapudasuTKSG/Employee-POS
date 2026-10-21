/**
 * The members billed for a month, as they stood at T (research R11).
 *
 * A change counts from when it was recorded, not from a date someone typed, so
 * a bill generated late is still right and a backdated entry cannot change a
 * past month:
 *
 * - billed: created before T, and active at T;
 * - active at T: the latest status-history row before T decides; with none
 *   before T, the earliest row after T tells what it was (its old value); with
 *   no history at all, the record has never changed, so its current value;
 * - class at T: the latest member_class_history row before T, by the same rule;
 * - active dependants at T: dependants created before T and active at T, by the
 *   same rule on their own history.
 *
 * One set-based query per company, not one per member (SC-011).
 */
import { sql } from "drizzle-orm";
import type { ScopedTx } from "@workspace/db";

export interface MemberAsOf {
  memberId: number;
  idType: string;
  idNumber: string;
  memberName: string;
  classCode: string;
  activeDependentCount: number;
}

export async function membersAsOf(tx: ScopedTx, companyNumber: string, t: Date): Promise<MemberAsOf[]> {
  const at = t.toISOString();
  const result = await tx.execute(sql`
    WITH m AS (
      SELECT m.member_id, m.id_type, m.id_number, m.first_name, m.last_name, m.class_code, m.active
        FROM bhi.member m
       WHERE m.company_number = ${companyNumber} AND m.created_at < ${at}::timestamptz
    ),
    state AS (
      SELECT m.*,
             COALESCE(
               (SELECT h.new_active FROM bhi.enrollment_status_history h
                 WHERE h.entity_type = 'MEMBER' AND h.entity_id = m.member_id AND h.changed_at < ${at}::timestamptz
                 ORDER BY h.changed_at DESC, h.status_history_id DESC LIMIT 1),
               (SELECT h.old_active FROM bhi.enrollment_status_history h
                 WHERE h.entity_type = 'MEMBER' AND h.entity_id = m.member_id AND h.changed_at >= ${at}::timestamptz
                 ORDER BY h.changed_at ASC, h.status_history_id ASC LIMIT 1),
               m.active) AS active_at,
             COALESCE(
               (SELECT c.class_code FROM bhi.member_class_history c
                 WHERE c.member_id = m.member_id AND c.recorded_at < ${at}::timestamptz
                 ORDER BY c.recorded_at DESC, c.id DESC LIMIT 1),
               (SELECT c.class_code FROM bhi.member_class_history c
                 WHERE c.member_id = m.member_id
                 ORDER BY c.recorded_at ASC, c.id ASC LIMIT 1),
               m.class_code) AS class_at
        FROM m
    ),
    deps AS (
      SELECT d.member_id,
             count(*) FILTER (WHERE COALESCE(
               (SELECT h.new_active FROM bhi.enrollment_status_history h
                 WHERE h.entity_type = 'DEPENDENT' AND h.entity_id = d.dependent_id AND h.changed_at < ${at}::timestamptz
                 ORDER BY h.changed_at DESC, h.status_history_id DESC LIMIT 1),
               (SELECT h.old_active FROM bhi.enrollment_status_history h
                 WHERE h.entity_type = 'DEPENDENT' AND h.entity_id = d.dependent_id AND h.changed_at >= ${at}::timestamptz
                 ORDER BY h.changed_at ASC, h.status_history_id ASC LIMIT 1),
               d.active)) AS n
        FROM bhi.dependent d
        JOIN m ON m.member_id = d.member_id
       WHERE d.created_at < ${at}::timestamptz
       GROUP BY d.member_id
    )
    SELECT s.member_id, s.id_type, s.id_number, s.first_name, s.last_name, s.class_at, COALESCE(deps.n, 0)::int AS dependents
      FROM state s
      LEFT JOIN deps ON deps.member_id = s.member_id
     WHERE s.active_at
     ORDER BY s.last_name, s.first_name, s.member_id`);
  return (result.rows as Record<string, unknown>[]).map((r) => ({
    memberId: Number(r["member_id"]),
    idType: String(r["id_type"]),
    idNumber: String(r["id_number"]),
    memberName: `${r["first_name"]} ${r["last_name"]}`.slice(0, 180),
    classCode: String(r["class_at"]),
    activeDependentCount: Number(r["dependents"]),
  }));
}
