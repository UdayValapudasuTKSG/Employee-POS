import { StatusPill, type PillTone } from '@/components/screen-ui';

interface StatusBadgeProps {
  status: string;
  className?: string;
}

/**
 * Member / verification status as a worded pill. The tone is a hint; the label
 * always carries the meaning on its own.
 */
const STATUSES: Record<string, { label: string; tone: PillTone }> = {
  // The BHI Active flag is the only member status: a member, dependant or
  // beneficiary is either Active or Inactive.
  ACTIVE: { label: 'Active', tone: 'success' },
  // Neutral rather than red: the record is intact and can be reactivated, and
  // a red pill on every member who simply reached 65 would cry wolf.
  INACTIVE: { label: 'Inactive', tone: 'neutral' },
  VERIFIED: { label: 'Verified', tone: 'success' },
  LOCKED: { label: 'Locked', tone: 'error' },
  EXPIRED: { label: 'Expired', tone: 'warning' },
};

/** "in_review" -> "In review", so an unknown machine token never shows raw. */
function humanise(status: string): string {
  const words = status.replace(/[_-]+/g, ' ').trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function StatusBadge({ status, className }: StatusBadgeProps) {
  const config = STATUSES[status.toUpperCase()] ?? { label: humanise(status), tone: 'neutral' as const };

  return (
    <StatusPill tone={config.tone} className={className}>
      {config.label}
    </StatusPill>
  );
}

/** The Active flag of a member, dependant or beneficiary, as the same pill. */
export function ActiveBadge({ active, className }: { active: boolean; className?: string }) {
  return <StatusBadge status={active ? 'ACTIVE' : 'INACTIVE'} className={className} />;
}
