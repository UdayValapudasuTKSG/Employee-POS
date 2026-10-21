import { Link, useLocation } from 'wouter';
import { useAuth } from '@/contexts/auth-context';
import {
  LayoutDashboard,
  Users,
  FileUp,
  FileCheck,
  ScrollText,
  ShieldCheck,
  UserCog,
  Lock,
  LogOut,
  SearchX,
  Building2,
  ClipboardList,
  Layers,
  BadgeDollarSign,
  Receipt,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * The admin sections, each with the permission that gates it.
 *
 * Dashboard carries MEMBER_READ_SCOPED because that is what GET
 * /v1/admin/dashboard requires — it counts members. It used to be the one entry
 * with no permission at all, so every role saw the link, and an auditor (whose
 * only grants are AUDIT_READ and VERIFICATION_READ) was sent to a page that
 * answered 403 and never finished loading. Keep each entry's permission equal to
 * the one its route enforces on the server; a link nobody can follow is worse
 * than no link.
 *
 * `group` only decides which heading an item sits under in the sidebar. It
 * carries no authority: an item is shown if and only if its permission passes,
 * and a heading disappears when every item beneath it is hidden.
 *
 * `roles`, when present, narrows an item to those roles on top of its
 * permission. Lookup alerts has no permission of its own: the server lets only
 * super admins list them, so the link follows the same rule. Companies is
 * super-admin only on the server, so it is narrowed to that role as well as
 * PLATFORM_MANAGE. Import exceptions (HR's fix
 * list) is read with MEMBER_READ_SCOPED, but it is for the roles that import and
 * fix members, so read-only support is left out.
 *
 * `permission` is left out only where the server's read needs none beyond being
 * an admin. Classes and Rates are such reads: every admin may list the shared
 * classes and read the rate card for its own companies, and the pages keep
 * their writes (CLASS_MANAGE, RATE_MANAGE) to the super admin. They sit after
 * every permission-gated section, so they never become anyone's landing page
 * ahead of a section that role can actually work in.
 */
type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  permission?: string;
  group: string;
  roles?: string[];
};

/** Roles that see the import fix list, in the sidebar and on the dashboard. */
export const IMPORT_EXCEPTION_ROLES = [
  'ROLE_HR_ADMIN',
  'ROLE_CLIENT_ADMIN',
  'ROLE_PLATFORM_ADMIN',
];

export const navItems: NavItem[] = [
  { href: '/admin', label: 'Dashboard', icon: LayoutDashboard, permission: 'MEMBER_READ_SCOPED', group: 'Overview' },
  { href: '/admin/members', label: 'Members', icon: Users, permission: 'MEMBER_READ_SCOPED', group: 'Membership' },
  { href: '/admin/import', label: 'Import', icon: FileUp, permission: 'MEMBER_IMPORT', group: 'Membership' },
  { href: '/admin/import-exceptions', label: 'Import exceptions', icon: ClipboardList, permission: 'MEMBER_READ_SCOPED', group: 'Membership', roles: IMPORT_EXCEPTION_ROLES },
  { href: '/admin/change-requests', label: 'Change requests', icon: FileCheck, permission: 'CHANGE_REQUEST_REVIEW', group: 'Membership' },
  { href: '/admin/audit', label: 'Audit', icon: ScrollText, permission: 'AUDIT_READ', group: 'Oversight' },
  { href: '/admin/verifications', label: 'Verifications', icon: ShieldCheck, permission: 'VERIFICATION_READ', group: 'Oversight' },
  { href: '/admin/lookup-alerts', label: 'Lookup alerts', icon: SearchX, permission: 'MEMBER_READ_SCOPED', group: 'Oversight', roles: ['ROLE_PLATFORM_ADMIN'] },
  { href: '/admin/companies', label: 'Companies', icon: Building2, permission: 'PLATFORM_MANAGE', group: 'Administration', roles: ['ROLE_PLATFORM_ADMIN'] },
  { href: '/admin/users', label: 'Users', icon: UserCog, permission: 'ADMIN_USER_READ', group: 'Administration' },
  { href: '/admin/permissions', label: 'Permissions', icon: Lock, permission: 'PLATFORM_MANAGE', group: 'Administration' },
  // Read-only for everyone but the super admin; see the note on NavItem.
  { href: '/admin/classes', label: 'Classes', icon: Layers, group: 'Pricing' },
  { href: '/admin/rates', label: 'Rates', icon: BadgeDollarSign, group: 'Pricing' },
  // Monthly bills: read with BILLING_READ; generating and finalising stay with the super admin.
  { href: '/admin/billing', label: 'Billing', icon: Receipt, permission: 'BILLING_READ', group: 'Pricing' },
];

/** Heading order, so a role that sees only some sections still reads top-down. */
const GROUP_ORDER = ['Overview', 'Membership', 'Oversight', 'Pricing', 'Administration'];

/**
 * The first section this admin may actually open, used as their landing page.
 *
 * Everyone used to be sent to /admin after signing in, which only works for a
 * role that can read members. An auditor lands on Audit instead. Null means the
 * account has no usable section at all, which the caller reports rather than
 * looping through redirects.
 */
export function firstAllowedRoute(
  hasPermission: (permission: string) => boolean,
  role?: string,
): string | null {
  return navItems.find((item) => isAllowed(item, hasPermission, role))?.href ?? null;
}

/**
 * Permission (where the item names one), then role where the item names roles.
 * No role known means no role-gated items.
 */
function isAllowed(
  item: NavItem,
  hasPermission: (permission: string) => boolean,
  role: string | undefined,
): boolean {
  if (item.permission !== undefined && !hasPermission(item.permission)) return false;
  return !item.roles || (role !== undefined && item.roles.includes(role));
}

/** The NALICO roof, alone. The full lockup is far too tall for a 56px header. */
function RoofMark({ className = 'h-4 w-8' }: { className?: string }) {
  return (
    <svg viewBox="0 0 236 52" className={className} aria-hidden="true">
      <path d="M118 0 L236 52 L208 52 L118 13 L28 52 L0 52 Z" fill="currentColor" />
    </svg>
  );
}

/** "Priya Platform" -> "PP". Falls back to a single letter, then to nothing. */
export function initials(name: string | undefined): string {
  if (!name) return '';
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

/**
 * Whether a nav item is the current section. Member pages live under
 * /admin/companies/:number/members, so Companies is only active on its own
 * page. A prefix only counts at a path boundary, so Import is not also lit on
 * /admin/import-exceptions.
 */
function isActiveItem(item: NavItem, location: string): boolean {
  return (
    location === item.href ||
    (item.href !== '/admin' && item.href !== '/admin/companies' && location.startsWith(`${item.href}/`))
  );
}

/** The nav item for the page being shown, for the top bar's breadcrumb. */
export function currentNavItem(location: string): NavItem | undefined {
  return (
    navItems.find((item) => isActiveItem(item, location)) ??
    // A member's own page sits under a company but belongs to Members.
    (location.includes('/members/') ? navItems.find((item) => item.href === '/admin/members') : undefined)
  );
}

export function AdminNav() {
  const [location] = useLocation();
  const { adminUser, hasPermission, clearAdminSession } = useAuth();

  const handleLogout = () => {
    clearAdminSession();
    window.location.href = '/admin/login';
  };

  const visible = navItems.filter((item) => isAllowed(item, hasPermission, adminUser?.role));

  return (
    // NALICO purple rail: the logo's wordmark colour, deepened so white text
    // reads at AA, with the roof's red as the one accent.
    <aside
      className="relative flex h-screen w-[272px] flex-shrink-0 flex-col text-white"
      style={{ background: 'linear-gradient(180deg, #2a0e63 0%, #3a1489 48%, #2f0f73 100%)' }}
    >
      {/* Brand — same roof mark and wordmark; the roof in the logo's red. */}
      <div className="flex h-16 flex-shrink-0 items-center gap-3 border-b border-white/10 px-6">
        <RoofMark className="h-4 w-8 text-[#ff3b44]" />
        <div className="leading-none">
          <div className="text-[18px] font-bold tracking-[-0.01em] text-white">BHI Portal</div>
          <div className="mt-1 text-[11px] font-bold uppercase tracking-[0.16em] text-[#c9b8f7]">
            Administration
          </div>
        </div>
      </div>

      {/* Sections */}
      <div className="flex-1 overflow-y-auto px-3.5 py-4">
        <nav aria-label="Admin sections" className="space-y-4">
          {GROUP_ORDER.map((group) => {
            const items = visible.filter((item) => item.group === group);
            // A heading with nothing under it is noise, so roles that cannot
            // reach a whole section never see its label.
            if (items.length === 0) return null;

            return (
              <div key={group}>
                <div className="mb-1 px-3 text-[11.5px] font-bold uppercase tracking-[0.12em] text-[#b7a3f2]">
                  {group}
                </div>
                <div className="space-y-0.5">
                  {items.map((item) => {
                    const Icon = item.icon;
                    const isActive = isActiveItem(item, location);
                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        aria-current={isActive ? 'page' : undefined}
                        className={`press group relative flex min-h-11 items-center gap-3 rounded-[10px] px-3 text-[15.5px] transition-colors duration-150 focus-visible:outline-white ${
                          isActive
                            ? 'bg-white font-bold text-[#3a1489] shadow-[0_6px_16px_-8px_rgba(10,2,40,0.7)]'
                            : 'font-semibold text-white/80 hover:bg-white/[0.09] hover:text-white'
                        }`}
                        data-testid={`nav-${item.label.toLowerCase()}`}
                      >
                        <span
                          aria-hidden="true"
                          className={`absolute left-0 top-1/2 h-6 w-[3px] -translate-y-1/2 rounded-r-full bg-[#e3151f] transition-opacity ${
                            isActive ? 'opacity-100' : 'opacity-0'
                          }`}
                        />
                        <Icon
                          className={`h-[19px] w-[19px] flex-shrink-0 transition-colors ${
                            isActive ? 'text-[#5b25cf]' : 'text-[#c9b8f7] group-hover:text-white'
                          }`}
                          strokeWidth={isActive ? 2.25 : 2}
                        />
                        <span className="truncate">{item.label}</span>
                      </Link>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </nav>
      </div>

      {/* Scope and sign-out. The signed-in admin's name sits in the top bar. */}
      <div className="flex-shrink-0 space-y-1.5 border-t border-white/10 p-3.5">
        {/* Scope is the answer to "why can I only see some members?", so it stays
            visible rather than being folded into a tooltip. */}
        {adminUser?.scopeCompanyName && (
          <div className="truncate rounded-[10px] border border-white/15 bg-white/[0.07] px-3 py-2 text-[13.5px] text-[#d9cdfa]">
            Scope: <span className="font-semibold text-white">{adminUser.scopeCompanyName}</span>
          </div>
        )}

        <Button
          variant="ghost"
          onClick={handleLogout}
          className="min-h-11 w-full justify-start gap-3 px-3 text-[15.5px] font-semibold text-white/80 hover:bg-[#e3151f]/25 hover:text-white"
          data-testid="button-logout"
        >
          <LogOut className="!h-[19px] !w-[19px]" />
          Log out
        </Button>
      </div>
    </aside>
  );
}
