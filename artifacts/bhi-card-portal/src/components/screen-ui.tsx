import React from 'react';
import type { LucideIcon } from 'lucide-react';
import { AlertTriangle, Inbox } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Link } from 'wouter';
import { NalicoLogo } from '@/components/nalico-logo';

/**
 * Screen primitives shared by the member-facing and admin pages. Every colour
 * is a var(--…) token from index.css, so dark mode follows without overrides.
 */

/** The page's one h1, with an optional eyebrow, sub line and action slot. */
export function PageHead({
  title,
  sub,
  eyebrow,
  action,
  className,
}: {
  title: React.ReactNode;
  sub?: React.ReactNode;
  eyebrow?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <header className={cn('flex min-w-0 flex-wrap items-end justify-between gap-4', className)}>
      <div className="flex min-w-0 flex-col gap-2">
        {eyebrow && <div className="ds-eyebrow">{eyebrow}</div>}
        <h1 className="ds-page-title">{title}</h1>
        {sub && <p className="max-w-2xl text-base leading-relaxed text-[var(--fg-3)]">{sub}</p>}
      </div>
      {action && <div className="flex max-w-full flex-shrink-0 flex-wrap items-center gap-2">{action}</div>}
    </header>
  );
}

/** A section's h2. Give it an id and point the section's aria-labelledby at it. */
export function SectionHead({
  id,
  title,
  sub,
  action,
}: {
  id?: string;
  title: React.ReactNode;
  sub?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-end justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-1">
        <h2 id={id} className="ds-h2">
          {title}
        </h2>
        {sub && <p className="ds-meta">{sub}</p>}
      </div>
      {action}
    </div>
  );
}

/** Inset aside panel: surface-2, radius 18, 17px title over a hairline. */
export function Panel({
  title,
  children,
  className,
}: {
  title?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('ds-panel flex min-w-0 flex-col gap-3 p-5', className)}>
      {title && (
        <div className="ds-panel-title border-b border-[var(--surface-hairline)] pb-3">{title}</div>
      )}
      {children}
    </div>
  );
}

/** Rounded square holding an icon at ~46% of its size. Decorative. */
export function IconTile({
  icon: Icon,
  size = 40,
  className,
}: {
  icon: LucideIcon;
  size?: number;
  className?: string;
}) {
  const radius = size < 38 ? 10 : size < 44 ? 11 : size < 52 ? 13 : 15;
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex flex-shrink-0 items-center justify-center border border-[var(--surface-border-soft)] bg-[var(--brand-50)] text-[var(--brand-700)]',
        className,
      )}
      style={{ width: size, height: size, borderRadius: radius }}
    >
      <Icon style={{ width: size * 0.46, height: size * 0.46 }} strokeWidth={1.75} />
    </span>
  );
}

export type PillTone = 'success' | 'warning' | 'error' | 'info' | 'brand' | 'neutral';

const PILL_TONES: Record<PillTone, string> = {
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning-text',
  error: 'bg-error-soft text-error',
  info: 'bg-info-soft text-info',
  brand: 'bg-[var(--brand-50)] text-[var(--brand-700)]',
  neutral: 'bg-[var(--surface-4)] text-[var(--fg-2)]',
};

/** 12/800 status pill. Always carries a word — tone is never the only signal. */
export function StatusPill({
  tone = 'neutral',
  icon: Icon,
  children,
  className,
}: {
  tone?: PillTone;
  icon?: LucideIcon;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-[3px] text-[12.5px] font-bold leading-[1.4]',
        PILL_TONES[tone],
        className,
      )}
    >
      {Icon ? (
        <Icon aria-hidden="true" className="h-3.5 w-3.5" strokeWidth={2.25} />
      ) : (
        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
      )}
      {children}
    </span>
  );
}

/**
 * Admin panel: white card with an icon-chip header, an optional action on the
 * right of the header and an optional tinted footer (counts, "View all").
 */
export function PanelCard({
  icon: Icon,
  title,
  sub,
  action,
  footer,
  children,
  className,
  bodyClassName,
  id,
  testId,
}: {
  icon?: LucideIcon;
  title: React.ReactNode;
  sub?: React.ReactNode;
  action?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  id?: string;
  testId?: string;
}) {
  return (
    <section
      aria-labelledby={id}
      data-testid={testId}
      className={cn(
        'flex min-w-0 flex-col overflow-hidden rounded-2xl border border-[var(--surface-border)] bg-card shadow-[var(--shadow-sm)]',
        className,
      )}
    >
      <header className="flex min-w-0 flex-wrap items-center gap-3 border-b border-[var(--surface-hairline)] px-5 py-4">
        {Icon && (
          <span
            aria-hidden="true"
            className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[10px] bg-[var(--brand-50)] text-[var(--brand-600)]"
          >
            <Icon className="h-[18px] w-[18px]" strokeWidth={2} />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <h2 id={id} className="truncate text-[18.5px] font-bold leading-tight text-[var(--fg-1)]">
            {title}
          </h2>
          {sub && <p className="mt-0.5 text-[14.5px] leading-snug text-[var(--fg-3)]">{sub}</p>}
        </div>
        {action && <div className="flex flex-shrink-0 flex-wrap items-center gap-2">{action}</div>}
      </header>
      <div className={cn('min-w-0 flex-1', bodyClassName)}>{children}</div>
      {footer && (
        <footer className="flex min-w-0 flex-wrap items-center justify-between gap-3 border-t border-[var(--surface-hairline)] bg-[var(--surface-2)] px-5 py-2.5 text-[14px] text-[var(--fg-3)]">
          {footer}
        </footer>
      )}
    </section>
  );
}

export type StatAccent = 'brand' | 'nalico' | 'roof' | 'success' | 'slate' | 'gold' | 'teal' | 'error';

const STAT_ACCENTS: Record<StatAccent, string> = {
  brand: '#0123d4',
  // The NALICO logo's own wordmark purple and roof red.
  nalico: '#5b25cf',
  roof: '#e3151f',
  success: '#1a7a4a',
  slate: '#4a5d8a',
  gold: '#c9a227',
  teal: '#0e7490',
  error: '#b91c1c',
};

/**
 * KPI tile: a coloured top edge, an uppercase label, one big figure and a
 * footnote. The accent colours the edge and the icon chip only — the figure
 * stays ink so a row of tiles reads as one set.
 */
export function StatTile({
  label,
  value,
  icon: Icon,
  accent = 'brand',
  footnote,
  className,
  testId,
}: {
  label: string;
  value: React.ReactNode;
  icon?: LucideIcon;
  accent?: StatAccent;
  footnote?: React.ReactNode;
  className?: string;
  testId?: string;
}) {
  const color = STAT_ACCENTS[accent];
  return (
    <div
      data-testid={testId}
      className={cn(
        'relative flex h-full min-w-0 flex-col overflow-hidden rounded-2xl border border-[var(--surface-border)] bg-card px-5 pb-4 pt-5 shadow-[var(--shadow-sm)] transition-[box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:shadow-[var(--shadow-md)]',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="absolute inset-x-0 top-0 h-[3px]"
        style={{ background: `linear-gradient(90deg, ${color}, ${color}66)` }}
      />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 text-[12.5px] font-bold uppercase tracking-[0.09em] text-[var(--fg-3)]">
          {label}
        </div>
        {Icon && (
          <span
            aria-hidden="true"
            className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[10px]"
            style={{ background: `${color}14`, color }}
          >
            <Icon className="h-[18px] w-[18px]" strokeWidth={2} />
          </span>
        )}
      </div>
      <div className="tnum mt-1 text-[34px] font-bold leading-none tracking-[-0.01em] text-[var(--fg-1)]">
        {value}
      </div>
      {footnote && <div className="mt-3 text-[14.5px] font-medium text-[var(--fg-3)]">{footnote}</div>}
    </div>
  );
}

/** Segmented control in the reference's style; for in-panel filters. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: React.ReactNode }[];
  label: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex items-center gap-0.5 rounded-[10px] border border-[var(--surface-border)] bg-[#f0f3f8] p-[3px]"
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            className={cn(
              'inline-flex items-center gap-1.5 whitespace-nowrap rounded-[7px] px-3.5 py-1 text-[14px] transition-colors',
              on
                ? 'bg-white font-bold text-[var(--brand-600)] shadow-[0_1px_2px_rgba(15,23,42,0.12)]'
                : 'font-medium text-[var(--fg-3)] hover:text-[var(--fg-1)]',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** repeat(auto-fit, minmax(min(Npx,100%),1fr)) — responsive with no breakpoints. */
export function AutoGrid({
  min = 240,
  gap = 12,
  children,
  className,
}: {
  min?: number;
  gap?: number;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn('grid min-w-0', className)}
      style={{ gridTemplateColumns: `repeat(auto-fit, minmax(min(${min}px, 100%), 1fr))`, gap }}
    >
      {children}
    </div>
  );
}

/** Dashed card that says what belongs here and what to do next. */
export function EmptyState({
  icon: Icon = Inbox,
  title,
  body,
  action,
}: {
  icon?: LucideIcon;
  title: React.ReactNode;
  body?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-[var(--surface-border)] bg-[var(--surface-2)] px-6 py-10 text-center">
      <IconTile icon={Icon} size={44} />
      <div className="ds-card-title">{title}</div>
      {body && <p className="ds-meta max-w-md">{body}</p>}
      {action}
    </div>
  );
}

/** "We could not load X" — a different sentence from "You have no X". */
export function UnavailableState({ what, action }: { what: string; action?: React.ReactNode }) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-start gap-3 rounded-2xl border border-[var(--status-warning-bg)] bg-warning-soft px-4 py-3.5"
    >
      <AlertTriangle aria-hidden="true" className="mt-0.5 h-[18px] w-[18px] flex-shrink-0 text-warning" />
      <p className="min-w-0 flex-1 text-[14.5px] leading-relaxed text-warning-text">
        We could not load {what} just now. Nothing you have saved has been lost — try again in a moment.
      </p>
      {action}
    </div>
  );
}

/** Shimmer block at the height and radius of what it replaces. */
export function Skeleton({
  height = 96,
  radius = 16,
  className,
}: {
  height?: number | string;
  radius?: number;
  className?: string;
}) {
  return (
    <div aria-hidden="true" className={cn('ds-skeleton w-full', className)} style={{ height, borderRadius: radius }} />
  );
}

/**
 * Centred single-column shell for the member-facing flow (lookup → verify →
 * confirm → card). The brand header sits INSIDE the same column as the
 * content, so the logo shares its left edge with the hero, cards and titles
 * instead of floating in a separate full-width band.
 */
export function MemberShell({
  children,
  width = 'md',
  top,
}: {
  children: React.ReactNode;
  width?: 'md' | 'lg' | 'xl';
  top?: React.ReactNode;
}) {
  const max = width === 'md' ? 'max-w-[480px]' : width === 'lg' ? 'max-w-3xl' : 'max-w-5xl';
  // NALICO purple-and-red theme (index.css, `html.member-ui`). On <html> so
  // dialogs and menus, which portal to <body>, follow it; a layout effect so
  // the first paint is already themed.
  React.useLayoutEffect(() => {
    const root = document.documentElement;
    root.classList.add('member-ui');
    return () => root.classList.remove('member-ui');
  }, []);
  return (
    <div className="min-h-screen px-4 pb-16">
      <div className={cn('mx-auto flex min-w-0 flex-col', max)}>
        {top}
        <main className="ds-rise flex min-w-0 flex-col gap-6 pt-2 sm:pt-4">{children}</main>
      </div>
    </div>
  );
}

/**
 * Brand header for the member-facing pages: the NALICO lockup, a hairline and
 * the product name, reading as one unit with the page below it. The logo links
 * home, as members expect.
 */
export function MemberTopBar({ right, label = 'Member portal' }: { right?: React.ReactNode; label?: string }) {
  return (
    <header className="flex min-h-[76px] items-center justify-between gap-4 py-4 sm:min-h-[88px]">
      <Link
        href="/"
        aria-label="NALICO health card — home"
        className="focus-ring flex min-w-0 items-center gap-3 rounded-lg"
      >
        <NalicoLogo className="h-9 w-auto flex-shrink-0 sm:h-10" />
        <span aria-hidden="true" className="h-8 w-px flex-shrink-0 bg-[var(--surface-border)]" />
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="truncate text-[14.5px] font-extrabold tracking-[-0.01em] text-[var(--fg-1)]">
            Health card
          </span>
          <span className="truncate text-[12.5px] font-medium text-[var(--fg-3)]">{label}</span>
        </span>
      </Link>
      {right}
    </header>
  );
}
