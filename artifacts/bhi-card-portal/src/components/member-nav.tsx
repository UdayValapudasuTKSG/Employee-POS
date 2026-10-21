import { Link, useLocation } from 'wouter';
import type { LucideIcon } from 'lucide-react';
import { CreditCard, LogOut, TicketPercent } from 'lucide-react';
import { useLogoutCardSession } from '@workspace/api-client-react';
import { useAuth } from '@/contexts/auth-context';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * The verified member's sections. Each one is behind the same card session, so
 * every page here redirects to /lookup when the session is gone.
 */
const SECTIONS: { href: string; label: string; icon: LucideIcon }[] = [
  { href: '/card', label: 'Health card', icon: CreditCard },
  { href: '/discounts', label: 'Discounts', icon: TicketPercent },
];

/** Section switcher under the top bar. Links, not tabs: each is its own URL. */
export function MemberNav() {
  const [location] = useLocation();
  return (
    <nav aria-label="Member sections" className="print:hidden">
      <ul className="inline-flex max-w-full flex-wrap gap-0.5 rounded-xl border border-[var(--surface-border)] bg-[var(--surface-2)] p-1">
        {SECTIONS.map(({ href, label, icon: Icon }) => {
          const current = location === href;
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={current ? 'page' : undefined}
                data-testid={`member-nav-${href.slice(1)}`}
                className={cn(
                  'focus-ring inline-flex min-h-10 items-center gap-2 whitespace-nowrap rounded-[9px] px-4 text-[14.5px] transition-colors',
                  current
                    ? 'bg-card font-bold text-[var(--brand-700)] shadow-[var(--shadow-sm)]'
                    : 'font-medium text-[var(--fg-3)] hover:text-[var(--fg-1)]',
                )}
              >
                <Icon aria-hidden="true" className="h-4 w-4" strokeWidth={2} />
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** Ends the card session server-side, then forgets it here and goes home. */
export function MemberLogoutButton() {
  const [, setLocation] = useLocation();
  const { clearCardSession } = useAuth();
  const logoutMutation = useLogoutCardSession();

  const handleLogout = () => {
    logoutMutation.mutate(undefined, {
      onSettled: () => {
        clearCardSession();
        setLocation('/');
      },
    });
  };

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={handleLogout}
      disabled={logoutMutation.isPending}
      className="min-h-10"
      data-testid="button-logout"
    >
      <LogOut aria-hidden="true" className="h-4 w-4" />
      Log out
    </Button>
  );
}
