/**
 * One policy applies to the whole platform and only a super admin manages it,
 * so the company-scoped roles (client admin, HR administrator) are shown no
 * policy details at all: no policy card, no policy status, no expired count.
 */
const POLICY_HIDDEN_ROLES = ['ROLE_CLIENT_ADMIN', 'ROLE_HR_ADMIN'];

export function canSeePolicy(role: string | undefined): boolean {
  return role !== undefined && !POLICY_HIDDEN_ROLES.includes(role);
}
