export interface MunicipalityDto {
  id: string;
  departmentCode: string;
  departmentName: string;
  name: string;
}

export interface ClientAddressDto {
  id: string;
  municipalityId: string;
  municipalityName?: string;
  address: string;
  notes: string | null;
  latitude: string | null;
  longitude: string | null;
  isPrimary: boolean;
  municipality_id?: string;
  is_primary?: boolean;
}

export interface ClientDto {
  id: string;
  legalName: string;
  taxId: string;
  phone: string;
  email: string | null;
  notes?: string | null;
  active: boolean;
  createdAt?: string;
  addresses?: ClientAddressDto[];
  legal_name?: string;
  tax_id?: string;
}

export interface ZoneDto {
  id: string;
  name: string;
  transportFee: string;
  installationFee: string;
  targetMargin: string | null;
  minimumMargin: string | null;
  active: boolean;
  municipalities?: { id: string; name: string }[];
  transport_fee?: string;
  installation_fee?: string;
  target_margin?: string | null;
  minimum_margin?: string | null;
}

export interface ProductDto {
  id: string;
  kind: "CABIN" | "ACCESSORY" | "MATERIAL";
  sku: string;
  name: string;
  description: string | null;
  pricingMethod: "CATALOG_PRICE" | "COST_MARGIN";
  baseCost: string | null;
  listPrice: string;
  taxRate: string;
  active: boolean;
  createdAt?: string;
  base_cost?: string | null;
}

export interface SessionActorDto {
  userId: string;
  active: boolean;
  platformRole: "SUPERADMIN" | "TENANT";
  tenantId: string | null;
  tenantActive?: boolean;
  authority?: "ADMIN" | "MEMBER";
  subscriptionExpiresAt?: number;
  rolePermissions?: string[];
  grants?: string[];
  denials?: string[];
}

export interface CommercialCapabilities {
  canReadCatalog: boolean;
  canManageCatalog: boolean;
  canReadZones: boolean;
  canManageZones: boolean;
  canReadClients: boolean;
  canCreateClients: boolean;
  canUpdateClients: boolean;
  canReadCosts: boolean;
  canReadRequests: boolean;
  canCreateRequests: boolean;
  canUpdateRequests: boolean;
  canReadQuotations: boolean;
  canCreateQuotations: boolean;
  canUpdateQuotations: boolean;
  canApproveQuotations: boolean;
  canCreateAdjustments: boolean;
  canAuthorizeAdjustments: boolean;
  canManageSettings: boolean;
}

export type TenantCommercialAction =
  | "clients.read"
  | "clients.create"
  | "clients.update"
  | "catalog.read"
  | "catalog.manage"
  | "zones.manage"
  | "costs.read"
  | "requests.read"
  | "requests.create"
  | "requests.update"
  | "quotations.read"
  | "quotations.create"
  | "quotations.update"
  | "quotations.approve"
  | "adjustments.create"
  | "adjustments.authorize"
  | "settings.manage"
  | "suppliers.manage";

export function hasTenantActionPermission(
  actor: SessionActorDto | null | undefined,
  action: TenantCommercialAction,
  isReadOnly = false,
): boolean {
  if (!actor || actor.platformRole !== "TENANT" || !actor.active) return false;

  const isMutation = [
    "clients.create",
    "clients.update",
    "catalog.manage",
    "zones.manage",
    "requests.create",
    "requests.update",
    "quotations.create",
    "quotations.update",
    "quotations.approve",
    "adjustments.create",
    "adjustments.authorize",
    "settings.manage",
    "suppliers.manage",
  ].includes(action);

  if (isReadOnly && isMutation) return false;

  const denials = actor.denials ?? [];
  if (denials.includes(action)) return false;

  const isAdmin = actor.authority === "ADMIN";
  const isAdminOnly =
    action === "catalog.manage" ||
    action === "zones.manage" ||
    action === "settings.manage";

  if (isAdminOnly) {
    return isAdmin;
  }

  if (isAdmin) {
    return true;
  }

  const grants = actor.grants ?? [];
  const rolePermissions = actor.rolePermissions ?? [];
  return grants.includes(action) || rolePermissions.includes(action);
}

export function deriveCommercialCapabilities(
  actor: SessionActorDto | null | undefined,
  isReadOnly = false,
): CommercialCapabilities {
  return {
    canReadCatalog: hasTenantActionPermission(actor, "catalog.read", isReadOnly),
    canManageCatalog: hasTenantActionPermission(actor, "catalog.manage", isReadOnly),
    canReadZones: true,
    canManageZones: hasTenantActionPermission(actor, "zones.manage", isReadOnly),
    canReadClients: hasTenantActionPermission(actor, "clients.read", isReadOnly),
    canCreateClients: hasTenantActionPermission(actor, "clients.create", isReadOnly),
    canUpdateClients: hasTenantActionPermission(actor, "clients.update", isReadOnly),
    canReadCosts: hasTenantActionPermission(actor, "costs.read", isReadOnly),
    canReadRequests: hasTenantActionPermission(actor, "requests.read", isReadOnly),
    canCreateRequests: hasTenantActionPermission(actor, "requests.create", isReadOnly),
    canUpdateRequests: hasTenantActionPermission(actor, "requests.update", isReadOnly),
    canReadQuotations: hasTenantActionPermission(actor, "quotations.read", isReadOnly),
    canCreateQuotations: hasTenantActionPermission(actor, "quotations.create", isReadOnly),
    canUpdateQuotations: hasTenantActionPermission(actor, "quotations.update", isReadOnly),
    canApproveQuotations: hasTenantActionPermission(actor, "quotations.approve", isReadOnly),
    canCreateAdjustments: hasTenantActionPermission(actor, "adjustments.create", isReadOnly),
    canAuthorizeAdjustments: hasTenantActionPermission(actor, "adjustments.authorize", isReadOnly),
    canManageSettings: hasTenantActionPermission(actor, "settings.manage", isReadOnly),
  };
}

/**
 * Normaliza números decimales ingresados por usuarios en la interfaz cliente,
 * soportando tanto comas (estándar hispano/colombiano '0,19') como puntos ('0.19').
 * Devuelve null ante entradas vacías, no numéricas, con múltiples separadores o inválidas,
 * evitando cualquier sustitución silenciosa por cero.
 */
export function parseClientDecimal(val: string | number | null | undefined): number | null {
  if (val === null || val === undefined) return null;
  if (typeof val === "number") {
    return Number.isFinite(val) ? val : null;
  }
  const str = String(val).trim();
  if (str === "") return null;

  // Rechazar si contiene caracteres ajenos a dígitos y un único separador decimal
  const commaCount = (str.match(/,/g) || []).length;
  const dotCount = (str.match(/\./g) || []).length;
  if (commaCount + dotCount > 1) {
    return null;
  }

  // Comprobar patrón estricto de número decimal no negativo
  if (!/^\d+(?:[.,]\d+)?$/.test(str)) {
    return null;
  }

  const clean = str.replace(",", ".");
  const num = Number(clean);
  return Number.isFinite(num) ? num : null;
}

/**
 * Normaliza tasas e índices porcentuales expresados en decimal (ej. 0.19) o como porcentaje entero (ej. 19 -> 0.19).
 * Devuelve null si la entrada es inválida, no numérica, negativa o superior a 100%.
 */
export function parsePercentageRatio(val: string | number | null | undefined): number | null {
  const num = parseClientDecimal(val);
  if (num === null) return null;
  if (num < 0 || num > 100) return null;

  if (num > 1 && num <= 100) {
    return Number((num / 100).toFixed(4));
  }
  return num;
}

// ---------------------------------------------------------------------------
// DTOs Y CONTRATOS DE FASE 2: SOLICITUDES, COTIZACIONES, VERSIONES Y AJUSTES
// ---------------------------------------------------------------------------

export interface RequestCabinDto {
  id: string;
  requestId: string;
  productId: string;
  productName: string;
  productSku: string;
  locationTag: string | null;
  finish: string | null;
  customWidth: number | null;
  customHeight: number | null;
  notes: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RequestItemDto {
  id: string;
  requestId: string;
  cabinId: string | null;
  productId: string;
  productName: string;
  productSku: string;
  productKind: "ACCESSORY" | "MATERIAL";
  quantity: number;
  notes: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CommercialRequestDto {
  id: string;
  code: string;
  status: "DRAFT" | "QUOTED" | "COMPLETED" | "CANCELLED";
  clientId: string;
  clientLegalName: string;
  clientAddressId: string;
  clientAddressText: string;
  municipalityId: string;
  municipalityName: string;
  zoneId: string | null;
  zoneName: string | null;
  notes: string | null;
  priority?: "LOW" | "NORMAL" | "HIGH" | "URGENT";
  revision: number;
  createdBy: string;
  creatorName: string;
  updatedBy: string;
  updaterName: string;
  createdAt: string;
  updatedAt: string;
  cabinsCount?: number;
  cabins?: RequestCabinDto[];
  items?: RequestItemDto[];
}

export interface CommercialSettingsDto {
  tenantId: string;
  currency: string;
  taxRate: string;
  taxIncluded: boolean;
  defaultValidityDays: number;
  targetMargin: string | null;
  minMargin: string | null;
  defaultPaymentTerms: string | null;
  notes: string | null;
  updatedAt: string;
}

export interface QuotationCabinDto {
  id: string;
  quotationId: string;
  cabinId: string;
  productId: string;
  productName: string;
  productSku: string;
  locationTag: string | null;
  finish: string | null;
  customWidth: number | null;
  customHeight: number | null;
  warrantyTerms: string | null;
  baseCost: string | null;
  listPrice: string | null;
  salePrice: string;
  notes: string | null;
}

export interface QuotationItemDto {
  id: string;
  quotationId: string;
  requestItemId: string | null;
  cabinId: string | null;
  concept: string;
  itemType: "ACCESSORY" | "MATERIAL" | "TRANSPORT" | "INSTALLATION" | "SERVICE";
  quantity: number;
  unitCost: string | null;
  unitPrice: string;
  totalPrice: string;
  notes: string | null;
}

export interface QuotationDocumentDto {
  id: string;
  quotationId: string;
  documentType: "PDF" | "APPROVAL_EVIDENCE" | "ADJUSTMENT_EVIDENCE";
  filename: string;
  fileSize: number;
  mimeType: string;
  sha256: string;
  createdAt: string;
}

export interface QuotationAdjustmentDto {
  id: string;
  quotationId: string;
  code: string;
  adjustmentType: "INCREASE" | "DECREASE";
  amount: string;
  reason: string;
  requiresClientApproval: boolean;
  clientApprovedAt: string | null;
  clientEvidenceId: string | null;
  status: "PENDING" | "APPROVED" | "REJECTED";
  authorizedBy: string | null;
  authorizerName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface QuotationDto {
  id: string;
  requestId: string;
  requestCode: string;
  clientLegalName: string;
  clientTaxId: string;
  code: string;
  version: number;
  status: "DRAFT" | "SENT" | "APPROVED" | "REJECTED" | "EXPIRED";
  pricingMethod: "CATALOG_PRICE" | "COST_MARGIN";
  currency: string;
  subtotal: string;
  taxRate: string;
  taxAmount: string;
  totalAmount: string;
  targetMargin: string | null;
  minMargin: string | null;
  snapshot: Record<string, unknown>;
  validityDays: number;
  expiresAt: string;
  sentAt: string | null;
  approvedAt: string | null;
  approvedBy: string | null;
  rejectionReason: string | null;
  revision: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  cabins?: QuotationCabinDto[];
  items?: QuotationItemDto[];
  documents?: QuotationDocumentDto[];
  adjustments?: QuotationAdjustmentDto[];
}

