import type { LucideIcon } from 'lucide-react';
import { Label } from '@/components/ui/label';

/** One numbered block of a member form: icon chip with its step, title, a line of help, then fields. */
export function FormSection({
  step,
  icon: Icon,
  title,
  sub,
  action,
  children,
}: {
  step: number;
  icon: LucideIcon;
  title: string;
  sub?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  const headingId = `section-${title.toLowerCase()}`;
  return (
    <section
      aria-labelledby={headingId}
      className="overflow-hidden rounded-2xl border border-[var(--surface-border)] bg-card shadow-[var(--shadow-sm)]"
    >
      <header className="flex flex-wrap items-center gap-3.5 border-b border-[var(--surface-hairline)] px-6 py-4">
        <span
          aria-hidden="true"
          className="relative flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-[var(--brand-50)] text-[var(--brand-600)]"
        >
          <Icon className="h-[19px] w-[19px]" strokeWidth={2} />
          <span className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-[var(--brand-600)] text-[11px] font-bold text-white ring-2 ring-white">
            {step}
          </span>
        </span>
        <div className="min-w-0 flex-1">
          <h2 id={headingId} className="text-[18.5px] font-bold leading-tight text-[var(--fg-1)]">
            {title}
          </h2>
          {sub && <p className="mt-0.5 text-[14.5px] text-[var(--fg-3)]">{sub}</p>}
        </div>
        {action}
      </header>
      <div className="px-6 py-5">{children}</div>
    </section>
  );
}

/**
 * Label, control and an optional error line. The required star is aria-hidden
 * so the field's accessible name stays exactly its label; the control itself
 * carries `required` where the browser should enforce it.
 */
export function Field({
  id,
  label,
  required,
  error,
  errorTestId,
  hint,
  className,
  children,
}: {
  id: string;
  label: string;
  required?: boolean;
  error?: string;
  errorTestId?: string;
  /** A muted line under the control, shown when there is no error. */
  hint?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`min-w-0 ${className ?? ''}`}>
      <Label htmlFor={id} className="mb-2 flex items-center gap-1">
        {label}
        {required && (
          <span aria-hidden="true" className="text-[var(--status-error)]">
            *
          </span>
        )}
      </Label>
      {children}
      {error ? (
        <p className="mt-1.5 text-[14px] font-semibold text-destructive" data-testid={errorTestId}>
          {error}
        </p>
      ) : (
        hint && <p className="mt-1.5 text-[13.5px] text-[var(--fg-3)]">{hint}</p>
      )}
    </div>
  );
}
