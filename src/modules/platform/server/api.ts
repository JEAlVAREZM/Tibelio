import "server-only";
import { listAudit } from "../../identity/server/audit";
import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import { AppError } from "../../../shared/server/app-error";
import { toHttpResponse } from "../../../shared/server/http";
import { assertSameOrigin, readJson } from "../../../shared/server/request";
import {
  login,
  logout,
  sessionActor,
  SESSION_COOKIE,
} from "../../identity/server/session";
import * as service from "./service";
import { attachReceipt, listReceipts, downloadReceipt } from "./receipts";
import { RECEIPT_TYPES } from "../../../shared/server/private-receipts";
import type { ErrorCode } from "../../../shared/contracts/result";
import {
  annulSubscriptionPayment,
  updateTier,
  platformSummary,
  companyProfile,
} from "./management";
import { uploadLogo, downloadLogo } from "./logos";
import { listMunicipalities } from "../../commercial/server/municipalities";
import {
  listZones,
  createZone,
  updateZone,
  assignMunicipality,
  removeMunicipality,
} from "../../commercial/server/zones";
import {
  listProducts,
  createProduct,
  updateProduct,
} from "../../commercial/server/catalog";
import {
  listClients,
  getClient,
  createClient,
  updateClient,
  addAddress,
  deleteAddress,
} from "../../commercial/server/clients";
import {
  listRequests,
  getRequest,
  createRequest,
  updateRequest,
  updateRequestPriority,
} from "../../commercial/server/requests";
import {
  getCommercialSettings,
  updateCommercialSettings,
  listQuotations,
  getQuotation,
  createQuotation,
  markQuotationSent,
  downloadQuotationPdf,
  downloadQuotationDocument,
  approveQuotation,
  rejectQuotation,
  createQuotationVersion,
  createAdjustmentNote,
  approveAdjustmentNote,
} from "../../commercial/server/quotations";
import {
  listSuppliers,
  createSupplier,
  getSupplier,
  updateSupplier,
} from "../../procurement/server/suppliers";
import {
  submitProcurementReview,
  getProcurementReview,
  createPurchaseOrder,
  getPurchaseOrder,
  listPurchaseOrders,
  receivePurchaseOrder,
} from "../../procurement/server/orders";
import {
  listStock,
  listCabinStock,
  reassignCabinStock,
  adjustStock,
  updateCabinStockStatus,
  listMovements,
} from "../../inventory/server/stock";
import {
  checkDispatchEligibility,
  executeDispatch,
} from "../../inventory/server/dispatch";
import {
  createPaymentTerms,
  listPaymentTerms,
  registerPayment,
  validatePayment,
  annulPayment,
  listPayments,
  getFinancialSummary,
  createRefund,
  disburseRefund,
  listRefunds,
  cancelRequest,
  downloadPaymentReceipt,
} from "../../finance/server/payments";
import {
  createFieldVisit,
  listFieldVisits,
  getFieldVisit,
  updateFieldVisitStatus,
  recordVisitMeasures,
} from "../../field-operations/server/visits";
import {
  createFieldTask,
  listFieldTasks,
  getFieldTask,
  updateFieldTaskStatus,
  createFieldRoute,
  listFieldRoutes,
  recordLocationEvent,
} from "../../field-operations/server/tasks";
import {
  startInstallationSession,
  updateInstallationSession,
  reconcileMaterialConsumption,
} from "../../field-operations/server/installation";
import {
  registerOperationalClosure,
  getOperationalClosure,
  downloadClosureFile,
} from "../../field-operations/server/closure";
import {
  registerWarrantyClaim,
  updateWarrantyStatus,
  addWarrantyPhoto,
  getWarranty,
  listWarranties,
} from "../../post-sale/server/warranties";
import {
  createOperationalIssue,
  updateOperationalIssue,
  getOperationalIssue,
  listOperationalIssues,
} from "../../post-sale/server/issues";
import {
  createOperationalCost,
  annulOperationalCost,
  getOperationalCost,
  listOperationalCosts,
} from "../../post-sale/server/costs";
import {
  getManagementDashboard,
  getOperationalReport,
  searchEverything,
} from "../../post-sale/server/dashboard";
import {
  listNotifications,
  markNotificationAsRead,
  scanAndGenerateAlerts,
} from "../../post-sale/server/notifications";
import {
  subscribePush,
  unsubscribePush,
  getPushSubscriptionStatus,
  sendTestPushNotification,
} from "../../post-sale/server/push";
import { readBoundedBody } from "../../../shared/server/request";
import { receiptLimit } from "../../../shared/server/private-receipts";
import type {
  CommercialRequestDto,
  QuotationDto,
} from "../../../shared/contracts/commercial";

type RouteContext = {
  token: string;
  request: NextRequest;
  body: unknown;
  query: Record<string, string>;
  page: number;
  params: Record<string, string>;
  traceId: string;
};
type RouteHandler = (context: RouteContext) => Promise<unknown>;
type RouteDefinition = {
  methods: string[];
  template: string;
  /** json (por defecto), none (POST/DELETE sin cuerpo), upload (binario leído por el manejador). */
  body?: "json" | "none" | "upload";
  contentTypes?: string[];
  /** Rutas de sesión que no exigen autenticación previa. */
  public?: boolean;
  handler: RouteHandler;
};
type CompiledRoute = RouteDefinition & { pattern: RegExp; names: string[] };

function fileResponse(
  bytes: Buffer | Uint8Array,
  mime: string,
  filename: string,
  disposition: "attachment" | "inline",
) {
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": mime,
      "Content-Disposition": `${disposition}; filename="${filename}"`,
      "Content-Length": String(bytes.length),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}

function declaredType(request: NextRequest) {
  return request.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
}

/**
 * Registro único de rutas: la misma tabla valida existencia/método y despacha.
 * Ruta o método no registrado => 404 antes de autenticar (deny default).
 */
const ROUTE_DEFINITIONS: RouteDefinition[] = [
  // Sesión
  {
    methods: ["POST"],
    template: "auth/login",
    public: true,
    handler: async ({ body, traceId }) => {
      const session = await login(body);
      const response = NextResponse.json(
        { data: { authenticated: true } },
        { headers: { "Cache-Control": "no-store", "X-Request-Id": traceId } },
      );
      response.cookies.set(SESSION_COOKIE, session, {
        httpOnly: true,
        sameSite: "strict",
        secure:
          new URL(process.env.APP_ORIGIN ?? "http://127.0.0.1:3000")
            .protocol === "https:",
        path: "/",
        maxAge: 28800,
      });
      return response;
    },
  },
  {
    methods: ["POST"],
    template: "auth/logout",
    public: true,
    handler: async ({ token }) => {
      await logout(token || null);
      const response = NextResponse.json(
        { data: { authenticated: false } },
        { headers: { "Cache-Control": "no-store" } },
      );
      response.cookies.set(SESSION_COOKIE, "", {
        httpOnly: true,
        sameSite: "strict",
        path: "/",
        maxAge: 0,
      });
      return response;
    },
  },
  {
    methods: ["GET"],
    template: "auth/session",
    public: true,
    handler: async ({ token }) => {
      const actor = await sessionActor(token || null);
      if (!actor) throw new AppError("UNAUTHENTICATED");
      return actor;
    },
  },

  // Plataforma SaaS y empresa
  { methods: ["GET"], template: "company", handler: ({ token }) => companyProfile(token) },
  { methods: ["GET"], template: "company/:id/logo", handler: ({ token, params }) => downloadLogo(token, params.id!, false) },
  { methods: ["GET"], template: "platform/summary", handler: ({ token }) => platformSummary(token) },
  { methods: ["GET"], template: "platform/tiers", handler: ({ token, page }) => service.listTiers(token, page) },
  { methods: ["POST"], template: "platform/tiers", handler: ({ token, body }) => service.createTier(token, body) },
  { methods: ["PATCH"], template: "platform/tiers/:id", handler: ({ token, params, body }) => updateTier(token, params.id!, body) },
  { methods: ["GET"], template: "platform/tenants", handler: ({ token, page }) => service.listTenants(token, page) },
  { methods: ["POST"], template: "platform/tenants", handler: ({ token, body }) => service.createTenant(token, body) },
  { methods: ["PATCH"], template: "platform/tenants/:id", handler: ({ token, params, body }) => service.updateTenant(token, params.id!, body) },
  { methods: ["POST"], template: "platform/tenants/:id/seats", handler: ({ token, params, body }) => service.changeSeats(token, params.id!, body) },
  {
    methods: ["POST"],
    template: "platform/tenants/:id/logo",
    body: "upload",
    contentTypes: ["image/png", "image/jpeg"],
    handler: ({ token, params, request }) => uploadLogo(token, params.id!, request),
  },
  { methods: ["GET"], template: "platform/tenants/:id/logo", handler: ({ token, params }) => downloadLogo(token, params.id!, true) },
  { methods: ["GET"], template: "platform/subscriptions", handler: ({ token, page }) => service.listSubscriptionPayments(token, page) },
  { methods: ["POST"], template: "platform/subscriptions", handler: ({ token, body }) => service.renewSubscription(token, body) },
  { methods: ["POST"], template: "platform/subscriptions/:id/annul", handler: ({ token, params, body }) => annulSubscriptionPayment(token, params.id!, body) },
  {
    methods: ["POST"],
    template: "platform/subscriptions/:id/receipts",
    body: "upload",
    contentTypes: RECEIPT_TYPES,
    handler: ({ token, params, request }) => attachReceipt(token, params.id!, request),
  },
  { methods: ["GET"], template: "platform/subscriptions/:id/receipts", handler: ({ token, params, page }) => listReceipts(token, params.id!, page) },
  { methods: ["GET"], template: "platform/receipts/:id", handler: ({ token, params }) => downloadReceipt(token, params.id!) },

  // Usuarios y roles
  { methods: ["GET"], template: "users", handler: ({ token, page }) => service.listUsers(token, page) },
  { methods: ["POST"], template: "users", handler: ({ token, body }) => service.createUser(token, body) },
  { methods: ["PATCH"], template: "users/:id", handler: ({ token, params, body }) => service.updateUser(token, params.id!, body) },
  { methods: ["PUT"], template: "users/:id/permissions", handler: ({ token, params, body }) => service.setPermissions(token, params.id!, body) },
  { methods: ["GET"], template: "roles", handler: ({ token, page }) => service.listRoles(token, page) },
  { methods: ["POST", "PUT"], template: "roles", handler: ({ token, body }) => service.saveRole(token, body) },

  // Comercial base
  { methods: ["GET"], template: "municipalities", handler: ({ token }) => listMunicipalities(token) },
  { methods: ["GET"], template: "zones", handler: ({ token, page, query }) => listZones(token, page, query.search) },
  { methods: ["POST"], template: "zones", handler: ({ token, body }) => createZone(token, body) },
  { methods: ["PATCH"], template: "zones/:id", handler: ({ token, params, body }) => updateZone(token, params.id!, body) },
  { methods: ["POST"], template: "zones/:id/municipalities/:municipalityId", body: "none", handler: ({ token, params }) => assignMunicipality(token, params.id!, params.municipalityId!) },
  { methods: ["DELETE"], template: "zones/:id/municipalities/:municipalityId", body: "none", handler: ({ token, params }) => removeMunicipality(token, params.id!, params.municipalityId!) },
  {
    methods: ["GET"],
    template: "catalog",
    handler: ({ token, page, query }) => listProducts(token, { page, kind: query.kind ?? undefined, search: query.search }),
  },
  { methods: ["POST"], template: "catalog", handler: ({ token, body }) => createProduct(token, body) },
  { methods: ["PATCH"], template: "catalog/:id", handler: ({ token, params, body }) => updateProduct(token, params.id!, body) },
  {
    methods: ["GET"],
    template: "clients",
    handler: ({ token, page, query }) => listClients(token, { page, search: query.search ?? undefined }),
  },
  { methods: ["POST"], template: "clients", handler: ({ token, body }) => createClient(token, body) },
  { methods: ["DELETE"], template: "clients/addresses/:id", body: "none", handler: ({ token, params }) => deleteAddress(token, params.id!) },
  { methods: ["GET"], template: "clients/:id", handler: ({ token, params }) => getClient(token, params.id!) },
  { methods: ["PATCH"], template: "clients/:id", handler: ({ token, params, body }) => updateClient(token, params.id!, body) },
  { methods: ["POST"], template: "clients/:id/addresses", handler: ({ token, params, body }) => addAddress(token, params.id!, body) },

  // Comercial: parámetros, solicitudes, cotizaciones
  { methods: ["GET"], template: "commercial/settings", handler: ({ token }) => getCommercialSettings(token) },
  { methods: ["PUT", "POST"], template: "commercial/settings", handler: ({ token, body }) => updateCommercialSettings(token, body) },
  {
    methods: ["GET"],
    template: "commercial/requests",
    handler: ({ token, page, query }) =>
      listRequests(token, {
        page,
        limit: query.limit ? Number(query.limit) : undefined,
        search: query.search ?? undefined,
        clientId: query.clientId ?? undefined,
        status: (query.status as CommercialRequestDto["status"] | undefined) ?? undefined,
      }),
  },
  { methods: ["POST"], template: "commercial/requests", handler: ({ token, body }) => createRequest(token, body) },
  { methods: ["GET"], template: "commercial/requests/:id", handler: ({ token, params }) => getRequest(token, params.id!) },
  { methods: ["PATCH"], template: "commercial/requests/:id", handler: ({ token, params, body }) => updateRequest(token, params.id!, body) },
  { methods: ["PATCH"], template: "commercial/requests/:id/priority", handler: ({ token, params, body }) => updateRequestPriority(token, params.id!, body) },
  {
    methods: ["GET"],
    template: "commercial/quotations",
    handler: ({ token, page, query }) =>
      listQuotations(token, {
        page,
        limit: query.limit ? Number(query.limit) : undefined,
        requestId: query.requestId ?? undefined,
        status: (query.status as QuotationDto["status"] | undefined) ?? undefined,
      }),
  },
  { methods: ["POST"], template: "commercial/quotations", handler: ({ token, body }) => createQuotation(token, body) },
  { methods: ["GET"], template: "commercial/quotations/:id", handler: ({ token, params }) => getQuotation(token, params.id!) },
  { methods: ["POST"], template: "commercial/quotations/:id/send", body: "none", handler: ({ token, params }) => markQuotationSent(token, params.id!) },
  { methods: ["POST"], template: "commercial/quotations/:id/reject", handler: ({ token, params, body }) => rejectQuotation(token, params.id!, body) },
  { methods: ["POST"], template: "commercial/quotations/:id/versions", handler: ({ token, params, body }) => createQuotationVersion(token, params.id!, body) },
  { methods: ["POST"], template: "commercial/quotations/:id/adjustments", handler: ({ token, params, body }) => createAdjustmentNote(token, params.id!, body) },
  {
    methods: ["POST"],
    template: "commercial/quotations/:id/approve",
    body: "upload",
    contentTypes: RECEIPT_TYPES,
    handler: async ({ token, params, request }) => {
      const bytes = await readBoundedBody(request, receiptLimit());
      return approveQuotation(token, params.id!, bytes, declaredType(request));
    },
  },
  {
    methods: ["GET"],
    template: "commercial/quotations/:id/pdf",
    handler: async ({ token, params }) => {
      const pdf = await downloadQuotationPdf(token, params.id!);
      return fileResponse(pdf.bytes, "application/pdf", pdf.filename, "attachment");
    },
  },
  {
    methods: ["POST"],
    template: "commercial/adjustments/:id/approve",
    body: "upload",
    contentTypes: [...RECEIPT_TYPES, "application/json", ""],
    handler: async ({ token, params, request }) => {
      const declared = declaredType(request);
      let bytes: Buffer | null = null;
      if (declared && declared !== "application/json") {
        bytes = await readBoundedBody(request, receiptLimit());
      }
      return approveAdjustmentNote(token, params.id!, bytes, declared);
    },
  },
  {
    methods: ["GET"],
    template: "commercial/documents/:id",
    handler: async ({ token, params }) => {
      const doc = await downloadQuotationDocument(token, params.id!);
      return fileResponse(doc.bytes, doc.mime, doc.filename, "inline");
    },
  },

  // 3.1 Proveedores y compras
  { methods: ["GET"], template: "audit", handler: ({ token, query }) => listAudit(token, query) },
  { methods: ["GET"], template: "procurement/suppliers", handler: ({ token, query }) => listSuppliers(token, query) },
  { methods: ["POST"], template: "procurement/suppliers", handler: ({ token, body }) => createSupplier(token, body) },
  { methods: ["GET"], template: "procurement/suppliers/:id", handler: ({ token, params }) => getSupplier(token, params.id!) },
  { methods: ["PUT"], template: "procurement/suppliers/:id", handler: ({ token, params, body }) => updateSupplier(token, params.id!, body) },
  { methods: ["POST"], template: "procurement/reviews", handler: ({ token, body }) => submitProcurementReview(token, body) },
  { methods: ["GET"], template: "procurement/reviews", handler: ({ token, query }) => getProcurementReview(token, query.requestId as string) },
  { methods: ["GET"], template: "procurement/orders", handler: ({ token, query }) => listPurchaseOrders(token, query) },
  { methods: ["POST"], template: "procurement/orders", handler: ({ token, body }) => createPurchaseOrder(token, body) },
  { methods: ["GET"], template: "procurement/orders/:id", handler: ({ token, params }) => getPurchaseOrder(token, params.id!) },
  { methods: ["POST"], template: "procurement/orders/:id/receive", handler: ({ token, params, body }) => receivePurchaseOrder(token, params.id!, body) },

  // 3.2 Bodega e inventario
  { methods: ["GET"], template: "inventory/stock", handler: ({ token, query }) => listStock(token, query) },
  { methods: ["GET"], template: "inventory/cabins", handler: ({ token, query }) => listCabinStock(token, query) },
  { methods: ["POST"], template: "inventory/cabins/reassign", handler: ({ token, body }) => reassignCabinStock(token, body) },
  { methods: ["POST"], template: "inventory/cabins/:id/status", handler: ({ token, params, body }) => updateCabinStockStatus(token, params.id!, body) },
  { methods: ["POST"], template: "inventory/adjust", handler: ({ token, body }) => adjustStock(token, body) },
  { methods: ["GET"], template: "inventory/movements", handler: ({ token, query }) => listMovements(token, query) },

  // 3.3 Prioridad y despacho
  { methods: ["GET"], template: "inventory/dispatch/eligibility", handler: ({ token, query }) => checkDispatchEligibility(token, query.requestId as string) },
  { methods: ["POST"], template: "inventory/dispatch", handler: ({ token, body }) => executeDispatch(token, body) },

  // 3.4 Condiciones de pago y recaudos
  { methods: ["POST"], template: "finance/terms", handler: ({ token, body }) => createPaymentTerms(token, body) },
  { methods: ["GET"], template: "finance/terms", handler: ({ token, query }) => listPaymentTerms(token, query.quotationId as string) },
  { methods: ["GET"], template: "finance/payments", handler: ({ token, query }) => listPayments(token, query.requestId as string) },
  { methods: ["POST"], template: "finance/payments", handler: ({ token, body }) => registerPayment(token, body) },
  { methods: ["POST"], template: "finance/payments/:id/validate", handler: ({ token, params, body }) => validatePayment(token, params.id!, body) },
  { methods: ["POST"], template: "finance/payments/:id/annul", handler: ({ token, params, body }) => annulPayment(token, params.id!, body) },
  {
    methods: ["GET"],
    template: "finance/payments/:id/receipt",
    handler: async ({ token, params }) => {
      const receipt = await downloadPaymentReceipt(token, params.id!);
      return fileResponse(receipt.bytes, receipt.mime, receipt.filename, "attachment");
    },
  },
  { methods: ["GET"], template: "finance/summary", handler: ({ token, query }) => getFinancialSummary(token, query.requestId as string) },

  // 3.5 Reembolsos y cancelación
  { methods: ["POST"], template: "finance/refunds/:id/disburse", handler: ({ token, params, body }) => disburseRefund(token, params.id!, body) },
  { methods: ["GET"], template: "finance/refunds", handler: ({ token, query }) => listRefunds(token, query.requestId as string) },
  { methods: ["POST"], template: "finance/refunds", handler: ({ token, body }) => createRefund(token, body) },
  { methods: ["POST"], template: "finance/cancel", handler: ({ token, body }) => cancelRequest(token, body) },

  // 4.1 Visitas técnicas y medidas
  { methods: ["GET"], template: "field/visits", handler: ({ token, query }) => listFieldVisits(token, query) },
  { methods: ["POST"], template: "field/visits", handler: ({ token, body }) => createFieldVisit(token, body) },
  { methods: ["POST"], template: "field/visits/measures", handler: ({ token, body }) => recordVisitMeasures(token, body) },
  { methods: ["GET"], template: "field/visits/:id", handler: ({ token, params }) => getFieldVisit(token, params.id!) },
  { methods: ["POST"], template: "field/visits/:id/status", handler: ({ token, params, body }) => updateFieldVisitStatus(token, params.id!, body) },

  // 4.2 Tareas, rutas y eventos GPS
  { methods: ["GET"], template: "field/tasks", handler: ({ token, query }) => listFieldTasks(token, query) },
  { methods: ["POST"], template: "field/tasks", handler: ({ token, body }) => createFieldTask(token, body) },
  { methods: ["GET"], template: "field/tasks/:id", handler: ({ token, params }) => getFieldTask(token, params.id!) },
  { methods: ["POST"], template: "field/tasks/:id/status", handler: ({ token, params, body }) => updateFieldTaskStatus(token, params.id!, body) },
  { methods: ["GET"], template: "field/routes", handler: ({ token, query }) => listFieldRoutes(token, query) },
  { methods: ["POST"], template: "field/routes", handler: ({ token, body }) => createFieldRoute(token, body) },
  { methods: ["POST"], template: "field/events", handler: ({ token, body }) => recordLocationEvent(token, body) },

  // 4.3 Instalación conjunta y conciliación
  { methods: ["POST"], template: "field/installation/sessions", handler: ({ token, body }) => startInstallationSession(token, body) },
  { methods: ["POST"], template: "field/installation/sessions/:id/status", handler: ({ token, params, body }) => updateInstallationSession(token, params.id!, body) },
  { methods: ["POST"], template: "field/installation/reconcile", handler: ({ token, body }) => reconcileMaterialConsumption(token, body) },

  // 4.4 Cierre operativo y firma
  { methods: ["GET"], template: "field/closures", handler: ({ token, query }) => getOperationalClosure(token, query.requestId as string) },
  { methods: ["POST"], template: "field/closures", handler: ({ token, body }) => registerOperationalClosure(token, body) },
  {
    methods: ["GET"],
    template: "field/closures/file/:id",
    handler: async ({ token, params }) => {
      const file = await downloadClosureFile(token, params.id!);
      return fileResponse(file.bytes, file.mime, file.filename, "inline");
    },
  },

  // 5.1 Garantías por cabina física
  { methods: ["GET"], template: "warranties", handler: ({ token, query }) => listWarranties(token, query) },
  { methods: ["POST"], template: "warranties", handler: ({ token, body }) => registerWarrantyClaim(token, body) },
  { methods: ["POST"], template: "warranties/photos", handler: ({ token, body }) => addWarrantyPhoto(token, body) },
  { methods: ["GET"], template: "warranties/:id", handler: ({ token, params }) => getWarranty(token, params.id!) },
  { methods: ["POST"], template: "warranties/:id/status", handler: ({ token, params, body }) => updateWarrantyStatus(token, params.id!, body) },

  // 5.2 Novedades operativas
  { methods: ["GET"], template: "issues", handler: ({ token, query }) => listOperationalIssues(token, query) },
  { methods: ["POST"], template: "issues", handler: ({ token, body }) => createOperationalIssue(token, body) },
  { methods: ["GET"], template: "issues/:id", handler: ({ token, params }) => getOperationalIssue(token, params.id!) },
  { methods: ["POST"], template: "issues/:id/status", handler: ({ token, params, body }) => updateOperationalIssue(token, params.id!, body) },

  // 5.3 Costos operativos reales
  { methods: ["GET"], template: "costs", handler: ({ token, query }) => listOperationalCosts(token, query) },
  { methods: ["POST"], template: "costs", handler: ({ token, body }) => createOperationalCost(token, body) },
  { methods: ["GET"], template: "costs/:id", handler: ({ token, params }) => getOperationalCost(token, params.id!) },
  { methods: ["POST"], template: "costs/:id/annul", handler: ({ token, params, body }) => annulOperationalCost(token, params.id!, body) },

  // 5.4 Dashboard, reportes y búsqueda
  { methods: ["GET"], template: "management/dashboard", handler: ({ token }) => getManagementDashboard(token) },
  { methods: ["GET"], template: "management/reports", handler: ({ token, query }) => getOperationalReport(token, query) },
  { methods: ["GET"], template: "management/search", handler: ({ token, query }) => searchEverything(token, query.q ?? "") },

  // 5.5 Alertas y notificaciones internas
  { methods: ["GET"], template: "notifications", handler: ({ token, query }) => listNotifications(token, query) },
  { methods: ["POST"], template: "notifications/read", handler: ({ token, body }) => markNotificationAsRead(token, body) },
  { methods: ["POST"], template: "notifications/scan", body: "none", handler: ({ token }) => scanAndGenerateAlerts(token) },

  // 6. Web Push (Fase 6)
  { methods: ["POST"], template: "notifications/push/subscribe", handler: ({ token, body }) => subscribePush(token, body) },
  { methods: ["POST"], template: "notifications/push/unsubscribe", handler: ({ token, body }) => unsubscribePush(token, body) },
  { methods: ["GET"], template: "notifications/push/status", handler: ({ token }) => getPushSubscriptionStatus(token) },
  { methods: ["POST"], template: "notifications/push/test", handler: ({ token, body }) => sendTestPushNotification(token, body) },
];

function compileRoute(definition: RouteDefinition): CompiledRoute {
  const names: string[] = [];
  const source = definition.template
    .split("/")
    .map((segment) => {
      if (segment.startsWith(":")) {
        names.push(segment.slice(1));
        return "([^/]+)";
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { ...definition, pattern: new RegExp(`^${source}$`), names };
}

const ROUTES: CompiledRoute[] = ROUTE_DEFINITIONS.map(compileRoute);

/** Superficie registrada (método + plantilla). Expuesta para pruebas de contrato HTTP. */
export const API_ROUTE_SURFACE: ReadonlyArray<{ method: string; template: string; public: boolean }> =
  ROUTE_DEFINITIONS.flatMap((route) =>
    route.methods.map((method) => ({ method, template: route.template, public: route.public === true })),
  );

export function matchApiRoute(method: string, route: string) {
  for (const candidate of ROUTES) {
    if (!candidate.methods.includes(method)) continue;
    const match = candidate.pattern.exec(route);
    if (!match) continue;
    const params: Record<string, string> = {};
    candidate.names.forEach((name, index) => {
      params[name] = decodeURIComponent(match[index + 1]!);
    });
    return { route: candidate, params };
  }
  return null;
}

export async function handleApi(request: NextRequest, path: string[]) {
  const traceId = randomUUID();
  const route = path.join("/");
  const method = request.method;
  const token = request.cookies.get(SESSION_COOKIE)?.value ?? null;
  const query = Object.fromEntries(request.nextUrl.searchParams.entries());
  try {
    const matched = matchApiRoute(method, route);
    if (!matched) throw new AppError("NOT_FOUND");
    const definition = matched.route;
    const bodyKind = definition.body ?? "json";
    const mutating = !["GET", "HEAD"].includes(method);
    if (mutating)
      assertSameOrigin(
        request,
        definition.contentTypes ??
          (bodyKind === "none" ? ["application/json", ""] : undefined),
      );
    const body =
      mutating && bodyKind === "json"
        ? await readJson(request)
        : mutating && bodyKind === "none" && request.body
          ? await readJson(request).catch(() => undefined)
          : undefined;
    if (!definition.public) {
      if (!token || !/^[a-f0-9]{64}$/.test(token))
        throw new AppError("UNAUTHENTICATED");
      if (!(await sessionActor(token))) throw new AppError("UNAUTHENTICATED");
    }
    const page =
      method === "GET" && !definition.public
        ? service.pageSchema.parse({
            page: request.nextUrl.searchParams.get("page") ?? undefined,
          }).page
        : 1;
    const result = await definition.handler({
      token: token ?? "",
      request,
      body,
      query,
      page,
      params: matched.params,
      traceId,
    });
    if (result instanceof Response) return result;
    return toHttpResponse({ ok: true, data: result, traceId });
  } catch (error) {
    let code: ErrorCode = "INTERNAL_ERROR";
    let message: string | undefined;
    let invalidField: string | undefined;
    if (error instanceof AppError) {
      code = error.code;
      if (error.message && error.message !== error.code) {
        message = error.message;
      }
    } else if (error instanceof ZodError) {
      code = "VALIDATION_ERROR";
      const issue = error.issues[0];
      if (issue) {
        const field = String(issue.path[issue.path.length - 1] ?? "");
        if (field) invalidField = issue.path.map(String).join(".");
        if (field === "adminPassword" || field === "password") {
          message = "La contraseña debe tener entre 12 y 128 caracteres.";
        } else if (field === "adminUsername" || field === "username") {
          message =
            "El nombre de usuario debe tener entre 3 y 64 caracteres en minúscula (letras, números, puntos o guiones).";
        } else if (field === "seats") {
          message = "El número de cupos debe ser un número entero mayor a cero.";
        } else if (field === "expiresAt") {
          message =
            "La fecha de vencimiento es obligatoria y debe ser una fecha válida.";
        } else if (field === "legalName") {
          message = "La razón social es obligatoria (máximo 160 caracteres).";
        } else if (field === "taxId") {
          message =
            "La identificación tributaria es obligatoria (máximo 160 caracteres).";
        } else if (field === "tierId") {
          message = "Debes seleccionar una tarifa válida de la lista.";
        } else if (
          issue.message &&
          !issue.message.startsWith("Invalid") &&
          !issue.message.startsWith("Too small")
        ) {
          message = issue.message;
        }
      }
    } else if (typeof error === "object" && error !== null && "code" in error) {
      const mapped = mapDatabaseError(
        error as { code?: unknown; message?: unknown },
        route,
      );
      code = mapped.code;
      message = mapped.message;
    }
    return toHttpResponse({
      ok: false,
      error: { code, message, field: invalidField },
      traceId,
    });
  }
}

export function mapDatabaseError(
  error: { code?: unknown; message?: unknown },
  route = "",
): { code: ErrorCode; message?: string } {
  const errCode = String(error.code ?? "");
  const errMessage = typeof error.message === "string" ? error.message : "";
  if (["23505", "P0001"].includes(errCode)) {
    if (errMessage.includes("seat limit")) {
      return {
        code: "CONFLICT",
        message:
          "Se alcanzó el límite de cupos de usuarios activos contratados por la empresa. Amplía los cupos de la suscripción o inactiva un usuario.",
      };
    }
    if (errMessage.includes("active users exceed seats")) {
      return {
        code: "CONFLICT",
        message:
          "El nuevo número de cupos no puede ser menor a la cantidad actual de usuarios activos en la empresa.",
      };
    }
    return {
      code: "CONFLICT",
      message:
        "Ya existe un registro con esos datos (el nombre de usuario o la identificación ya están en uso).",
    };
  }
  if (["23503", "23514", "22P02"].includes(errCode)) {
    if (errMessage.includes("last administrator")) {
      return {
        code: "VALIDATION_ERROR",
        message:
          "No se puede desactivar ni quitar la autoridad al único administrador activo de la empresa.",
      };
    }
    if (errCode === "23514" && route.startsWith("platform/")) {
      return {
        code: "VALIDATION_ERROR",
        message:
          "La tarifa seleccionada no está activa o el número de cupos no corresponde al rango de la tarifa.",
      };
    }
    return { code: "VALIDATION_ERROR" };
  }
  if (errCode === "42501") {
    return { code: "FORBIDDEN" };
  }
  return { code: "INTERNAL_ERROR" };
}
