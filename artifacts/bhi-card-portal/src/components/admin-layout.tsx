import { useEffect, useLayoutEffect } from 'react';
import { useLocation } from 'wouter';
import { ChevronRight } from 'lucide-react';
import { useAuth } from '@/contexts/auth-context';
import { AdminNav, currentNavItem, initials } from '@/components/admin-nav';

interface AdminLayoutProps {
  children: React.ReactNode;
}

/**
 * Puts the admin theme (index.css, `html.admin-ui`) on <html> while an admin
 * screen is mounted. On <html> rather than a wrapper so dialogs and menus,
 * which portal to <body>, pick it up too. A layout effect, so the first paint
 * is already themed; moving between admin routes removes and re-adds the class
 * in the same commit, so it never flickers.
 */
export function useAdminTheme() {
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.classList.add('admin-ui');
    return () => root.classList.remove('admin-ui');
  }, []);
}

const TODAY_LABEL = () =>
  new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

/** Sticky bar over the content: where you are on the left, who you are on the right. */
function AdminTopBar() {
  const [location] = useLocation();
  const { adminUser } = useAuth();
  const item = currentNavItem(location);
  const roleLabel =
    // Stored sessions from before roleLabel existed fall back to the raw role.
    adminUser?.roleLabel ?? adminUser?.role.replace('ROLE_', '').replace(/_/g, ' ');

  return (
    <header className="sticky top-0 z-30 flex h-16 flex-shrink-0 items-center justify-between gap-4 border-b border-[var(--surface-border)] bg-white/85 px-[clamp(16px,2.2vw,32px)] backdrop-blur-md">
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2 text-[15px]">
        {item ? (
          <>
            <span className="hidden font-semibold text-[var(--fg-4)] sm:inline">{item.group}</span>
            <ChevronRight aria-hidden="true" className="hidden h-4 w-4 flex-shrink-0 text-[var(--fg-4)] sm:inline" />
            <span className="truncate font-bold text-[var(--fg-1)]">{item.label}</span>
          </>
        ) : (
          <span className="font-bold text-[var(--fg-1)]">Administration</span>
        )}
      </nav>

      <div className="flex min-w-0 items-center gap-4">
        <span className="hidden whitespace-nowrap text-[14.5px] font-medium text-[var(--fg-3)] lg:inline">
          {TODAY_LABEL()}
        </span>
        <span aria-hidden="true" className="hidden h-8 w-px bg-[var(--surface-border)] lg:block" />
        <div className="flex min-w-0 items-center gap-3 rounded-xl border border-[var(--surface-border)] bg-white py-1.5 pl-1.5 pr-3.5 shadow-[var(--shadow-xs)]">
          <span
            aria-hidden="true"
            className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[9px] text-[13px] font-bold text-white"
            style={{ background: 'var(--hero-gradient)' }}
          >
            {initials(adminUser?.displayName)}
          </span>
          <div className="min-w-0 leading-tight">
            <div className="truncate text-[15px] font-bold text-[var(--fg-1)]">{adminUser?.displayName}</div>
            <div className="truncate text-[13px] font-semibold text-[var(--brand-600)]">{roleLabel}</div>
          </div>
        </div>
      </div>
    </header>
  );
}

export function AdminLayout({ children }: AdminLayoutProps) {
  const [location, setLocation] = useLocation();
  const { adminToken } = useAuth();
  useAdminTheme();

  useEffect(() => {
    if (!adminToken && location !== '/admin/login') {
      setLocation('/admin/login');
    }
  }, [adminToken, location, setLocation]);

  if (!adminToken) {
    return null;
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <AdminNav />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <AdminTopBar />
        {/* The content fills the width beside the rail — no centred column
            leaving a band of empty page between the sidebar and the content.
            The cap only stops very wide monitors stretching rows past reading. */}
        <main className="min-w-0 flex-1 overflow-y-auto px-[clamp(16px,2.2vw,32px)] pb-16 pt-6">
          <div className="w-full max-w-[1760px]">{children}</div>
        </main>
      </div>
    </div>
  );
}
