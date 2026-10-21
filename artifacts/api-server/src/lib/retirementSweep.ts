/**
 * The job that takes members off the roster when they reach 65 (research R19).
 *
 * Split from retirement.ts, which holds the date arithmetic and stays free of
 * database and clock, so the rule itself is unit-testable and this file is only
 * the plumbing around it.
 *
 * The sweep is a bookkeeper, not a gate. What actually stops a 65-year-old
 * getting a card is the eligibility check in routes/employee.ts, which evaluates
 * the same rule on every lookup; a member turns 65 up to a day before this
 * notices, and that window must not be a hole. What the sweep adds is the
 * visible half: HR's members list should show the roster the carrier would
 * recognise, and a member who has aged out should not be sitting on it marked
 * Active.
 *
 * It runs under SYSTEM_SCOPE — every company — because nobody signed in asked
 * for it. Members of offboarded companies are left alone: their records are
 * frozen (spec FR-019).
 */

import { and, eq, isNull, lte } from "drizzle-orm";
import { SYSTEM_SCOPE, bhiCompanyTable, bhiMemberTable, withScope } from "@workspace/db";
import { writeAudit } from "./audit";
import { logger } from "./logger";
import { guyanaToday } from "./guyanaTime";
import { RETIREMENT_AGE, retirementCutoff } from "./retirement";
import { setActive } from "./statusHistory";
import { errorSummary } from "./bhiErrors";
import { recalculateDrafts } from "./billing/runs";

/** How often the sweep re-runs. A birthday is a once-a-day event. */
export const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** The InactiveReason the sweep records. */
export const RETIREMENT_INACTIVE_REASON = `Aged out at ${RETIREMENT_AGE}`;

export interface SweepResult {
  /** The date the sweep judged ages against, YYYY-MM-DD (Guyana). */
  asOf: string;
  deactivated: { companyNumber: string; memberId: number }[];
  /**
   * Active members with no date of birth. The BHI model makes it optional, so
   * the sweep cannot judge them; they are reported for HR to complete rather
   * than silently kept on cover forever.
   */
  noDateOfBirth: { companyNumber: string; memberId: number }[];
}

/**
 * Deactivates every active member of an active company who has reached 65.
 *
 * The comparison is a plain indexed `date_of_birth <= cutoff` against the same
 * retirementCutoff() the eligibility check uses, so the sweep and the gate can
 * never disagree about who is out. retirement.test.ts pins the leap-day clamp
 * that keeps the cutoff a real date.
 *
 * One transaction per member: each change goes through setActive, which writes
 * enrollment_status_history (billing depends on it) and revokes open cards, and
 * gets its own audit row. A failure on one member is logged and the sweep
 * continues, so one bad row cannot strand the rest of the roster.
 */
export async function sweepRetirementAge(asOf = guyanaToday()): Promise<SweepResult> {
  const cutoff = retirementCutoff(asOf);
  const { due, noDateOfBirth } = await withScope(SYSTEM_SCOPE, async (tx) => {
    const base = and(eq(bhiMemberTable.active, true), eq(bhiCompanyTable.active, true));
    const pick = { memberId: bhiMemberTable.memberId, companyNumber: bhiMemberTable.companyNumber, dateOfBirth: bhiMemberTable.dateOfBirth };
    const join = eq(bhiCompanyTable.companyNumber, bhiMemberTable.companyNumber);
    const due = await tx
      .select(pick)
      .from(bhiMemberTable)
      .innerJoin(bhiCompanyTable, join)
      .where(and(base, lte(bhiMemberTable.dateOfBirth, cutoff)));
    const noDateOfBirth = await tx
      .select({ memberId: bhiMemberTable.memberId, companyNumber: bhiMemberTable.companyNumber })
      .from(bhiMemberTable)
      .innerJoin(bhiCompanyTable, join)
      .where(and(base, isNull(bhiMemberTable.dateOfBirth)));
    return { due, noDateOfBirth };
  });

  const deactivated: SweepResult["deactivated"] = [];
  for (const member of due) {
    try {
      await withScope(SYSTEM_SCOPE, async (tx) => {
        const change = await setActive(tx, {
          entityType: "MEMBER",
          id: member.memberId,
          active: false,
          reason: RETIREMENT_INACTIVE_REASON,
          effectiveDate: asOf,
          actor: "SYSTEM",
        });
        if (!change.changed) return;
        await writeAudit(
          {
            // Not an administrator's email: nobody decided this, the calendar did.
            actor: "SYSTEM",
            actorRole: "SYSTEM",
            action: "MEMBER_DEACTIVATED_RETIREMENT_AGE",
            entityType: "MEMBER",
            entityId: String(member.memberId),
            beforeValue: JSON.stringify(change.before),
            afterValue: JSON.stringify({ ...change.after, dateOfBirth: member.dateOfBirth, asOf }),
            reason: RETIREMENT_INACTIVE_REASON,
            sourceIp: null,
            companyCode: member.companyNumber,
          },
          tx,
        );
        deactivated.push({ companyNumber: member.companyNumber, memberId: member.memberId });
      });
    } catch (err) {
      logger.error(
        { error: errorSummary(err), memberId: member.memberId, companyNumber: member.companyNumber },
        "Retirement sweep failed for one member; continuing",
      );
    }
  }

  if (deactivated.length > 0) {
    logger.info(
      { asOf, count: deactivated.length, members: deactivated },
      `Retirement sweep deactivated members who reached age ${RETIREMENT_AGE}`,
    );
  } else {
    logger.debug({ asOf }, "Retirement sweep: no members due");
  }
  if (noDateOfBirth.length > 0) {
    logger.info({ asOf, count: noDateOfBirth.length }, "Retirement sweep: active members with no date of birth");
  }
  if (deactivated.length > 0) {
    const companies = [...new Set(deactivated.map((d) => d.companyNumber))];
    const results = await recalculateDrafts(companies, { email: "system", role: "SYSTEM", cause: `Aged out at ${RETIREMENT_AGE}` });
    for (const r of results) {
      if (r.status === "FAILED") logger.warn({ companyNumber: r.companyNumber, message: r.message }, "draft bill recalculation failed");
    }
  }
  return { asOf, deactivated, noDateOfBirth };
}

/**
 * Runs the sweep now and then once a day for as long as the process lives.
 *
 * Called from index.ts after the listener is up. A rejection is logged, never
 * thrown: a failed sweep must not take the API down, and the eligibility check
 * is still refusing these members their card in the meantime.
 *
 * The timer is unref'd so it never by itself keeps the process alive — which is
 * what lets a test or a script import this module without hanging on exit.
 */
export function startRetirementSweep(): NodeJS.Timeout {
  const run = () => {
    sweepRetirementAge().catch((err) => {
      logger.error({ err }, "Retirement sweep failed");
    });
  };
  run();
  const timer = setInterval(run, SWEEP_INTERVAL_MS);
  timer.unref();
  return timer;
}
