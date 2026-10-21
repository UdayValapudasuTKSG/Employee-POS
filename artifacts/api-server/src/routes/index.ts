import { Router, type IRouter } from "express";
import healthRouter from "./health";
import employeeRouter from "./employee";
import discountsRouter from "./discounts";
import adminRouter from "./admin";
import adminMembersRouter from "./adminMembers";
import adminCompaniesRouter from "./adminCompanies";
import adminChangeRequestsRouter from "./adminChangeRequests";
import adminLookupAlertsRouter from "./adminLookupAlerts";
import adminImportRouter from "./adminImport";
import adminImportExceptionsRouter from "./adminImportExceptions";
import adminPolicyImportRouter from "./adminPolicyImport";
import adminClassesRouter from "./adminClasses";
import adminRatesRouter from "./adminRates";
import adminBillingRouter from "./adminBilling";
import assistantRouter from "./assistant";

const router: IRouter = Router();

router.use(healthRouter);
router.use(employeeRouter);
router.use(discountsRouter);
// Before adminRouter: its "/v1/admin/change-requests/:id" must not be shadowed
// by any broader pattern registered earlier.
router.use(adminChangeRequestsRouter);
router.use(adminMembersRouter);
router.use(adminCompaniesRouter);
router.use(adminLookupAlertsRouter);
router.use(adminImportRouter);
router.use(adminImportExceptionsRouter);
router.use(adminPolicyImportRouter);
router.use(adminClassesRouter);
router.use(adminRatesRouter);
router.use(adminBillingRouter);
router.use(adminRouter);
router.use(assistantRouter);

export default router;
