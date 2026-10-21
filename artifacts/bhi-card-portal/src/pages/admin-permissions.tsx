import { useGetPermissionMatrix } from '@workspace/api-client-react';
import { PageHeader } from '@/components/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AlertCircle } from 'lucide-react';

/** Display names for the roles; the matrix itself carries only the role codes. */
const ROLE_LABELS: Record<string, string> = {
  ROLE_PLATFORM_ADMIN: 'Super admin',
  ROLE_CLIENT_ADMIN: 'Client admin',
  ROLE_HR_ADMIN: 'HR administrator',
  ROLE_SUPPORT: 'Support',
  ROLE_AUDITOR: 'Auditor',
};

const roleLabel = (role: string) => ROLE_LABELS[role] ?? role.replace('ROLE_', '').replace(/_/g, ' ');

export default function AdminPermissions() {
  const { data: matrix, isLoading, error } = useGetPermissionMatrix();

  if (isLoading) {
    return (
      <div>
        <PageHeader title="Permissions" description="Role permission matrix" />
        <Card>
          <CardContent className="pt-6">
            <Skeleton className="h-96 w-full" />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (error || !matrix) {
    return (
      <div>
        <PageHeader title="Permissions" />
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>Unable to load permission matrix.</AlertDescription>
        </Alert>
      </div>
    );
  }

  const getGrantBadge = (grant: string, isCurrentRole: boolean) => {
    const variants: Record<string, 'default' | 'secondary' | 'outline'> = {
      full: 'default',
      scoped: 'secondary',
      masked: 'secondary',
      none: 'outline',
    };

    return (
      <Badge
        variant={variants[grant] || 'outline'}
        className={isCurrentRole ? 'ring-2 ring-accent' : ''}
      >
        {grant}
      </Badge>
    );
  };

  return (
    <div>
      <PageHeader
        title="Permissions"
        description="Role permission matrix"
      />

      <Alert className="mb-6">
        <AlertDescription>
          Your current role: <strong>{roleLabel(matrix.currentRole)}</strong>
          {' '}(highlighted column)
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Permission grants by role</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-64">Permission</TableHead>
                  {matrix.roles.map((role) => {
                    const isCurrentRole = role === matrix.currentRole;
                    return (
                      <TableHead
                        key={role}
                        className={`text-center ${isCurrentRole ? 'bg-accent/10' : ''}`}
                      >
                        <div className="whitespace-nowrap text-xs">
                          {roleLabel(role)}
                        </div>
                      </TableHead>
                    );
                  })}
                </TableRow>
              </TableHeader>
              <TableBody>
                {matrix.rows.map((row) => (
                  <TableRow key={row.permission} data-testid={`row-permission-${row.permission}`}>
                    <TableCell>
                      <div className="font-medium">{row.permission}</div>
                      <div className="text-xs text-muted-foreground">{row.description}</div>
                    </TableCell>
                    {matrix.roles.map((role) => {
                      const isCurrentRole = role === matrix.currentRole;
                      const grant = row.grants[role] || 'none';
                      return (
                        <TableCell
                          key={role}
                          className={`text-center ${isCurrentRole ? 'bg-accent/10' : ''}`}
                        >
                          {getGrantBadge(grant, isCurrentRole)}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">Your active permissions</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            {matrix.currentPermissions.map((permission) => (
              <Badge key={permission} variant="default">
                {permission}
              </Badge>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
