/**
 * Admin fixtures for the HTTP integration suites: throwaway admin accounts,
 * signed in through the real login route.
 */
import { randomBytes } from "node:crypto";

export const TEST_PASSWORD = "Integration@Test-2026";

export type TestRole =
  | "ROLE_PLATFORM_ADMIN"
  | "ROLE_CLIENT_ADMIN"
  | "ROLE_HR_ADMIN"
  | "ROLE_SUPPORT"
  | "ROLE_AUDITOR";

export async function makeAdmin(
  role: TestRole,
  scope: { companyScope?: string } = {},
): Promise<{ id: string; email: string }> {
  const { db, adminUsersTable } = await import("@workspace/db");
  const { hashPassword } = await import("../lib/auth");
  const email = `${role.toLowerCase()}-${randomBytes(4).toString("hex")}@integration.test`;
  const [row] = await db
    .insert(adminUsersTable)
    .values({
      email,
      displayName: `Test ${role}`,
      passwordHash: hashPassword(TEST_PASSWORD),
      role,
      companyScope: scope.companyScope ?? null,
    })
    .returning();
  return { id: row!.id, email };
}

/** Signs in through POST /v1/admin/auth/login and returns a request helper. */
export async function signIn(baseUrl: string, email: string) {
  const res = await fetch(`${baseUrl}/v1/admin/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: TEST_PASSWORD }),
  });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status} ${await res.text()}`);
  const { token } = (await res.json()) as { token: string };
  return async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: r.status, body: json as Record<string, unknown> & { error?: { code: string; message: string } } };
  };
}

export type AdminClient = Awaited<ReturnType<typeof signIn>>;
