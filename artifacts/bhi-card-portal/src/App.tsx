import { useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Route, Switch, Router as WouterRouter, useLocation } from 'wouter';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AuthProvider, useAuth } from '@/contexts/auth-context';
import { AdminLayout } from '@/components/admin-layout';
import { firstAllowedRoute } from '@/components/admin-nav';
import NotFound from '@/pages/not-found';

// Employee pages
import Landing from '@/pages/landing';
import Lookup from '@/pages/lookup';
import Verify from '@/pages/verify';
import Confirm from '@/pages/confirm';
import Card from '@/pages/card';
import Discounts from '@/pages/discounts';

// Admin pages
import AdminLogin from '@/pages/admin-login';
import AdminDashboard from '@/pages/admin-dashboard';
import AdminMembers from '@/pages/admin-members';
import AdminMemberDetail from '@/pages/admin-member-detail';
import AdminMemberEdit from '@/pages/admin-member-edit';
import AdminMemberCreate from '@/pages/admin-member-create';
import AdminMemberPolicy from '@/pages/admin-member-policy';
import AdminImport from '@/pages/admin-import';
import AdminImportExceptions from '@/pages/admin-import-exceptions';import AdminChangeRequests from '@/pages/admin-change-requests';
import AdminAudit from '@/pages/admin-audit';
import AdminVerifications from '@/pages/admin-verifications';
import AdminLookupAlerts from '@/pages/admin-lookup-alerts';
import AdminUsers from '@/pages/admin-users';
import AdminPermissions from '@/pages/admin-permissions';
import AdminCompanies from '@/pages/admin-companies';
import AdminClasses from '@/pages/admin-classes';
import AdminRates from '@/pages/admin-rates';
import AdminBilling from '@/pages/admin-billing';
import AdminBillingRun from '@/pages/admin-billing-run';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30000,
      retry: 1,
    },
  },
});

/**
 * What /admin shows, which depends on the role.
 *
 * The dashboard counts members and so needs MEMBER_READ_SCOPED. An auditor has
 * only AUDIT_READ and VERIFICATION_READ, so rendering the dashboard for them
 * fired a request that answered 403 and left the page loading forever. They are
 * redirected to the first section they can actually open instead — Audit.
 */
function AdminHome() {
  const { hasPermission, adminUser } = useAuth();
  const [, setLocation] = useLocation();
  const allowed = firstAllowedRoute(hasPermission, adminUser?.role);

  useEffect(() => {
    if (allowed && allowed !== '/admin') setLocation(allowed);
  }, [allowed, setLocation]);

  if (hasPermission('MEMBER_READ_SCOPED')) return <AdminDashboard />;
  if (allowed && allowed !== '/admin') return null; // redirecting

  // No section at all: an account whose role grants nothing this portal shows.
  // Saying so beats an endless spinner or an empty frame.
  return (
    <div className="p-8 text-sm text-muted-foreground" data-testid="admin-no-sections">
      Your account has no sections available. Contact a platform administrator.
    </div>
  );
}

function Router() {
  return (
    <Switch>
      {/* Employee flow */}
      <Route path="/" component={Landing} />
      <Route path="/lookup" component={Lookup} />
      <Route path="/verify" component={Verify} />
      <Route path="/confirm" component={Confirm} />
      <Route path="/card" component={Card} />
      <Route path="/discounts" component={Discounts} />

      {/* Admin login (no layout) */}
      <Route path="/admin/login" component={AdminLogin} />

      {/* Admin portal (with layout) */}
      <Route path="/admin">
        <AdminLayout>
          <AdminHome />
        </AdminLayout>
      </Route>
      <Route path="/admin/members">
        <AdminLayout>
          <AdminMembers />
        </AdminLayout>
      </Route>
      <Route path="/admin/members/new">
        <AdminLayout>
          <AdminMemberCreate />
        </AdminLayout>
      </Route>
      {/* Wouter matches the whole path, so /admin/companies does not swallow
          the member routes under /admin/companies/:companyNumber/... below. */}
      <Route path="/admin/companies">
        <AdminLayout>
          <AdminCompanies />
        </AdminLayout>
      </Route>
      {/* A member ID is unique only within its company, so a member is
          addressed by both. Wouter matches the whole path, so the detail route
          does not swallow /edit. */}
      <Route path="/admin/companies/:companyNumber/members/:memberId">
        <AdminLayout>
          <AdminMemberDetail />
        </AdminLayout>
      </Route>
      <Route path="/admin/companies/:companyNumber/members/:memberId/edit">
        <AdminLayout>
          <AdminMemberEdit />
        </AdminLayout>
      </Route>
      <Route path="/admin/companies/:companyNumber/members/:memberId/policy">
        <AdminLayout>
          <AdminMemberPolicy />
        </AdminLayout>
      </Route>
      <Route path="/admin/import">
        <AdminLayout>
          <AdminImport />
        </AdminLayout>
      </Route>
      <Route path="/admin/import-exceptions">
        <AdminLayout>
          <AdminImportExceptions />
        </AdminLayout>
      </Route>      <Route path="/admin/change-requests">
        <AdminLayout>
          <AdminChangeRequests />
        </AdminLayout>
      </Route>
      <Route path="/admin/audit">
        <AdminLayout>
          <AdminAudit />
        </AdminLayout>
      </Route>
      <Route path="/admin/verifications">
        <AdminLayout>
          <AdminVerifications />
        </AdminLayout>
      </Route>
      <Route path="/admin/lookup-alerts">
        <AdminLayout>
          <AdminLookupAlerts />
        </AdminLayout>
      </Route>
      <Route path="/admin/users">
        <AdminLayout>
          <AdminUsers />
        </AdminLayout>
      </Route>
      <Route path="/admin/permissions">
        <AdminLayout>
          <AdminPermissions />
        </AdminLayout>
      </Route>
      <Route path="/admin/classes">
        <AdminLayout>
          <AdminClasses />
        </AdminLayout>
      </Route>
      <Route path="/admin/rates">
        <AdminLayout>
          <AdminRates />
        </AdminLayout>
      </Route>
      <Route path="/admin/billing">
        <AdminLayout>
          <AdminBilling />
        </AdminLayout>
      </Route>
      <Route path="/admin/billing/runs/:runId">
        <AdminLayout>
          <AdminBillingRun />
        </AdminLayout>
      </Route>

      {/* 404 */}
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <TooltipProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
            <Router />
          </WouterRouter>
          <Toaster />
        </TooltipProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

export default App;
