// Every table lives in the one schema, "bhi" (bhi/_schema.ts).
//
// The client's BHI Enrollment Database tables, guarded by row-level security.
// Query them only inside withScope() — see ../scope.ts.
export * from "./bhi";

// The portal's own tables.
export * from "./adminUsers";
export * from "./activityLog";
export * from "./employeeSessions";
export * from "./changeRequests";
export * from "./policies";
export * from "./importBatch";
export * from "./memberClassHistory";
export * from "./discountCoupons";
export * from "./discountCouponOtps";
