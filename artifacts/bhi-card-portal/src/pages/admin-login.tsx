import { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import { getAdminMe, useAdminLogin, useChangeOwnAdminPassword } from '@workspace/api-client-react';
import type { ErrorType, ApiErrorEnvelope, AdminLoginResult, AdminMe } from '@workspace/api-client-react';
import { useAuth } from '@/contexts/auth-context';
import { firstAllowedRoute } from '@/components/admin-nav';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Shield } from 'lucide-react';
import { IconTile, MemberShell, MemberTopBar } from '@/components/screen-ui';
import { useAdminTheme } from '@/components/admin-layout';

/** Fallback labels, used only if GET /admin/me cannot be reached after sign-in. */
const ROLE_LABELS: Record<string, string> = {
  ROLE_PLATFORM_ADMIN: 'Super admin',
  ROLE_HR_ADMIN: 'HR admin',
  ROLE_CLIENT_ADMIN: 'Client admin',
  ROLE_SUPPORT: 'Support',
  ROLE_AUDITOR: 'Auditor',
};

export default function AdminLogin() {
  const [, setLocation] = useLocation();
  const { setAdminSession, adminToken } = useAuth();
  useAdminTheme();

  // The mirror of AdminLayout's guard, which sends signed-out visitors here.
  // Without this, an already-signed-in admin who lands on /admin/login gets the
  // sign-in form again rather than the dashboard. Keyed on adminToken, which is
  // deliberately not set during the temporary-password flow below, so that
  // still completes instead of bouncing.
  useEffect(() => {
    if (adminToken) setLocation('/admin');
  }, [adminToken, setLocation]);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pendingLogin, setPendingLogin] = useState<AdminLoginResult | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [mismatch, setMismatch] = useState(false);
  const loginMutation = useAdminLogin();
  // The session token is not stored until the password change succeeds,
  // so pass it explicitly on this one request.
  const changePasswordMutation = useChangeOwnAdminPassword({
    request: pendingLogin
      ? { headers: { Authorization: `Bearer ${pendingLogin.token}` } }
      : undefined,
  });

  const completeLogin = async (data: AdminLoginResult) => {
    // The login response lacks the role label and company list, so the
    // stored session comes from /admin/me. The token is not in storage yet, so
    // it is passed on this one request, as with the password change.
    let me: AdminMe;
    try {
      me = await getAdminMe({ headers: { Authorization: `Bearer ${data.token}` } });
    } catch {
      // Degrade to what the login response carries rather than failing sign-in.
      me = {
        email: email.trim(),
        displayName: data.displayName,
        role: data.role,
        roleLabel: ROLE_LABELS[data.role] ?? data.role,
        scope: data.scope,
        scopeCompanyName: null,
        companies: data.scope ? [data.scope] : null,
        readOnly: data.role === 'ROLE_SUPPORT' || data.role === 'ROLE_AUDITOR',
        permissions: data.permissions,
      };
    }
    setAdminSession(data.token, me);
    // Land on the first section this role may open, not always the dashboard.
    // The dashboard needs MEMBER_READ_SCOPED, which an auditor does not have,
    // so signing in used to drop them on a page that answered 403 and sat
    // loading. Read from the login response rather than the auth context, whose
    // state has not been published to this render yet.
    setLocation(
      firstAllowedRoute((p: string) => me.permissions.includes(p), me.role) ?? '/admin',
    );
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password.trim()) return;

    loginMutation.mutate(
      { data: { email: email.trim(), password } },
      {
        onSuccess: (data) => {
          if (data.mustChangePassword) {
            // Hold the session locally until the temporary password is replaced.
            setPendingLogin(data);
            return;
          }
          void completeLogin(data);
        },
      }
    );
  };

  const handleChangePassword = (e: React.FormEvent) => {
    e.preventDefault();
    if (!pendingLogin || newPassword.length < 8) return;
    if (newPassword !== confirmPassword) {
      setMismatch(true);
      return;
    }
    setMismatch(false);
    changePasswordMutation.mutate(
      { data: { currentPassword: password, newPassword } },
      {
        onSuccess: () => void completeLogin(pendingLogin),
      }
    );
  };

  const errorMessage = loginMutation.error
    ? ((loginMutation.error as ErrorType<ApiErrorEnvelope>).data?.error?.message || 'Login failed')
    : null;
  const changeErrorMessage = mismatch
    ? 'The two passwords do not match.'
    : changePasswordMutation.error
      ? ((changePasswordMutation.error as ErrorType<ApiErrorEnvelope>).data?.error?.message || 'Password change failed')
      : null;

  return (
    <MemberShell top={<MemberTopBar label="Administration" />}>
          <div className="flex flex-col items-center gap-3 text-center">
            <IconTile icon={Shield} size={52} />
            <div className="ds-eyebrow">BHI health card management</div>
            <h1 className="ds-page-title">Admin portal</h1>
          </div>

          {pendingLogin ? (
            <Card>
              <CardHeader>
                <CardTitle>Set a new password</CardTitle>
                <CardDescription>
                  You signed in with a temporary password. Choose a new password to continue.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleChangePassword} className="space-y-4">
                  <div>
                    <Label htmlFor="new-password">New password</Label>
                    <Input
                      id="new-password"
                      type="password"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      disabled={changePasswordMutation.isPending}
                      required
                      minLength={8}
                      autoFocus
                      data-testid="input-new-password"
                    />
                    <p className="mt-1 text-xs text-muted-foreground">At least 8 characters.</p>
                  </div>

                  <div>
                    <Label htmlFor="confirm-password">Confirm new password</Label>
                    <Input
                      id="confirm-password"
                      type="password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      disabled={changePasswordMutation.isPending}
                      required
                      minLength={8}
                      data-testid="input-confirm-password"
                    />
                  </div>

                  {changeErrorMessage && (
                    <Alert variant="destructive">
                      <AlertDescription>{changeErrorMessage}</AlertDescription>
                    </Alert>
                  )}

                  <Button
                    type="submit"
                    size="lg"
                    className="w-full"
                    disabled={changePasswordMutation.isPending}
                    data-testid="button-change-password"
                  >
                    {changePasswordMutation.isPending ? 'Saving…' : 'Change password and continue'}
                  </Button>
                </form>
              </CardContent>
            </Card>
          ) : (
          <Card>
            <CardHeader>
              <CardTitle>Sign in</CardTitle>
              <CardDescription>Use the email and password your platform administrator gave you.</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    disabled={loginMutation.isPending}
                    required
                    autoFocus
                    data-testid="input-email"
                  />
                </div>

                <div>
                  <Label htmlFor="password">Password</Label>
                  <Input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    disabled={loginMutation.isPending}
                    required
                    data-testid="input-password"
                  />
                </div>

                {errorMessage && (
                  <Alert variant="destructive">
                    <AlertDescription>{errorMessage}</AlertDescription>
                  </Alert>
                )}

                <Button
                  type="submit"
                  size="lg"
                  className="w-full"
                  disabled={loginMutation.isPending}
                  data-testid="button-login"
                >
                  {loginMutation.isPending ? 'Signing in…' : 'Sign in'}
                </Button>
              </form>
            </CardContent>
          </Card>
          )}
    </MemberShell>
  );
}
