import { customType, pgSchema } from "drizzle-orm/pg-core";

/**
 * The one schema the application uses. It holds the client's BHI tables
 * (company, member, dependent, beneficiary, class, rates, billing, status
 * history, import exceptions) and the portal's own tables beside them.
 */
export const bhiSchema = pgSchema("bhi");

/** drizzle-orm has no bytea column type; used by change_requests' document. */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});
