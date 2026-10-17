import { z } from "zod";
import { canonicalMoneySchema } from "./money";

// ==========================================
// 1. PROVEEDORES Y COMPRAS (3.1)
// ==========================================

export interface SupplierDto {
  id: string;
  name: string;
  taxId: string | null;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  notes: string | null;
  active: boolean;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

export const createSupplierSchema = z.object({
  name: z.string().trim().min(2, "El nombre debe tener al menos 2 caracteres").max(200),
  taxId: z.string().trim().min(3).max(50).optional().nullable(),
  contactName: z.string().trim().min(2).max(150).optional().nullable(),
  email: z.string().trim().email("Correo electrónico inválido").optional().nullable(),
  phone: z.string().trim().min(5).max(30).optional().nullable(),
  notes: z.string().trim().max(1000).optional().nullable(),
});

export const updateSupplierSchema = createSupplierSchema.partial().extend({
  active: z.boolean().optional(),
});

export interface ProcurementReviewDto {
  id: string;
  requestId: string;
  quotationId: string;
  quotationVersion: number;
  status: "PENDING" | "APPROVED" | "REJECTED";
  notes: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
  createdBy: string;
}

export const submitProcurementReviewSchema = z.object({
  requestId: z.string().uuid("ID de solicitud inválido"),
  quotationId: z.string().uuid("ID de cotización inválido"),
  status: z.enum(["APPROVED", "REJECTED"]),
  notes: z.string().trim().max(1000).optional().nullable(),
});

export interface PurchaseOrderLineDto {
  id: string;
  orderId: string;
  productId: string;
  productName?: string;
  productSku?: string;
  requestId: string | null;
  quantity: string;
  unitCost: string | null; // Protegido bajo costs.read (DEC-008)
  receivedQuantity: string;
  pendingQuantity: string;
  expectedDate: string | null;
  notes: string | null;
}

export interface PurchaseOrderDto {
  id: string;
  code: string;
  supplierId: string;
  supplierName?: string;
  status: "DRAFT" | "ORDERED" | "PARTIAL_RECEIVED" | "RECEIVED" | "CANCELLED";
  notes: string | null;
  orderedAt: string | null;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  lines?: PurchaseOrderLineDto[];
}

export const createPurchaseOrderSchema = z.object({
  supplierId: z.string().uuid("ID de proveedor inválido"),
  notes: z.string().trim().max(1000).optional().nullable(),
  lines: z.array(
    z.object({
      productId: z.string().uuid("ID de producto inválido"),
      requestId: z.string().uuid().optional().nullable(),
      quantity: z.number().positive("La cantidad debe ser mayor a 0"),
      unitCost: canonicalMoneySchema.optional().nullable(),
      expectedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Formato de fecha YYYY-MM-DD").optional().nullable(),
      notes: z.string().trim().max(500).optional().nullable(),
    })
  ).min(1, "La orden debe tener al menos una línea"),
});

export const receivePurchaseOrderSchema = z.object({
  notes: z.string().trim().max(1000).optional().nullable(),
  lines: z.array(
    z.object({
      orderLineId: z.string().uuid("ID de línea inválido"),
      quantityReceived: z.number().positive("La cantidad recibida debe ser mayor a 0"),
    })
  ).min(1, "Debe recibir al menos una línea"),
});

// ==========================================
// 2. BODEGA E INVENTARIO (3.2)
// ==========================================

export interface StockItemDto {
  productId: string;
  productName: string;
  productSku: string;
  productKind: "CABIN" | "ACCESSORY" | "MATERIAL";
  quantity: string;
  updatedAt: string;
}

export interface CabinStockDto {
  cabinId: string;
  requestId: string;
  requestCode?: string;
  productId: string;
  productName?: string;
  status: "IN_STOCK" | "ASSIGNED" | "DISPATCHED" | "RETURNED" | "DAMAGED" | "MAINTENANCE";
  location: string | null;
  notes?: string | null;
  releasedFromRequestId?: string | null;
  reassignedAt?: string | null;
  reassignedBy?: string | null;
  updatedAt: string;
}

export const updateCabinStatusSchema = z.object({
  status: z.enum(["IN_STOCK", "ASSIGNED", "DISPATCHED", "RETURNED", "DAMAGED", "MAINTENANCE"]),
  location: z.string().trim().max(100).optional().nullable(),
  notes: z.string().trim().max(1000).optional().nullable(),
});

export const reassignCabinStockSchema = z.object({
  cabinId: z.string().uuid("ID de cabina inválido"),
  targetRequestId: z.string().uuid("ID de solicitud de destino inválido"),
  reason: z.string().trim().min(5, "El motivo de reasignación debe tener al menos 5 caracteres").max(1000),
});
export type ReassignCabinStockInput = z.infer<typeof reassignCabinStockSchema>;

export interface InventoryMovementDto {
  id: string;
  productId: string;
  productName?: string;
  cabinId: string | null;
  movementType: "RECEPTION" | "RETURN" | "DAMAGE" | "ADJUSTMENT" | "DISPATCH" | "CONSUMPTION";
  quantity: string;
  previousBalance: string;
  newBalance: string;
  referenceType: string;
  referenceId: string;
  notes: string | null;
  createdAt: string;
  createdBy: string;
}

export const adjustStockSchema = z.object({
  productId: z.string().uuid("ID de producto inválido"),
  movementType: z.enum(["ADJUSTMENT", "DAMAGE", "RETURN"]),
  quantityDelta: z.number().refine((n) => n !== 0, "El ajuste no puede ser cero"),
  reason: z.string().trim().min(5, "El motivo debe tener al menos 5 caracteres").max(1000),
});

// ==========================================
// 3. PRIORIDAD Y DESPACHO (3.3)
// ==========================================

export interface MissingStockItem {
  productId: string;
  productName: string;
  productKind: string;
  required: number;
  available: number;
}

export interface DispatchEligibilityDto {
  eligible: boolean;
  reasons: string[];
  reviewStatus: "APPROVED" | "PENDING" | "REJECTED" | "NOT_FOUND";
  approvedQuotationVersion: number | null;
  missingProducts: MissingStockItem[];
  paymentsValidated: boolean;
  payableAmount: string;
  validatedAmount: string;
}

export interface DispatchRecordDto {
  id: string;
  requestId: string;
  quotationId: string;
  status: "PREPARED" | "DISPATCHED" | "CANCELLED";
  notes: string | null;
  dispatchedAt: string | null;
  dispatchedBy: string | null;
  createdAt: string;
  createdBy: string;
}

export const executeDispatchSchema = z.object({
  requestId: z.string().uuid("ID de solicitud inválido"),
  quotationId: z.string().uuid("ID de cotización inválido"),
  notes: z.string().trim().max(1000).optional().nullable(),
});

// ==========================================
// 4. CONDICIONES DE PAGO Y RECAUDOS (3.4)
// ==========================================

export interface PaymentTermDto {
  id: string;
  requestId: string;
  quotationId: string;
  version: number;
  active: boolean;
  milestone: "DOWN_PAYMENT" | "MANUFACTURE" | "PRE_DISPATCH" | "DELIVERY" | "FINAL";
  percentage: string;
  amount: string;
  dueDate: string | null;
  notes: string | null;
  createdAt: string;
}

export const createPaymentTermsSchema = z.object({
  requestId: z.string().uuid("ID de solicitud inválido"),
  quotationId: z.string().uuid("ID de cotización inválido"),
  terms: z.array(
    z.object({
      milestone: z.enum(["DOWN_PAYMENT", "MANUFACTURE", "PRE_DISPATCH", "DELIVERY", "FINAL"]),
      percentage: z.number().positive().max(100),
      amount: canonicalMoneySchema.refine((val) => Number(val) > 0, "El importe debe ser positivo"),
      dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Formato YYYY-MM-DD").optional().nullable(),
      notes: z.string().trim().max(500).optional().nullable(),
    }),
  ).min(1, "Debe especificar al menos un hito de pago"),
});

export interface ClientPaymentDto {
  id: string;
  requestId: string;
  amount: string;
  paymentDate: string;
  paymentMethod: "TRANSFER" | "DEPOSIT" | "CARD" | "CASH" | "OTHER";
  referenceCode: string | null;
  receiptFileId: string;
  status: "PENDING" | "VALIDATED" | "REJECTED" | "ANNULLED";
  rejectionReason: string | null;
  annulmentReason?: string | null;
  validatedBy: string | null;
  validatedAt: string | null;
  annulledBy?: string | null;
  annulledAt?: string | null;
  registeredBy: string;
  registeredAt: string;
  notes: string | null;
}

export const registerPaymentSchema = z.object({
  requestId: z.string().uuid("ID de solicitud inválido"),
  amount: canonicalMoneySchema.refine((val) => Number(val) > 0, "El importe del pago debe ser positivo"),
  paymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Formato de fecha YYYY-MM-DD"),
  paymentMethod: z.enum(["TRANSFER", "DEPOSIT", "CARD", "CASH", "OTHER"]),
  referenceCode: z.string().trim().min(1).max(100).optional().nullable(),
  notes: z.string().trim().max(1000).optional().nullable(),
  receiptBase64: z.string().optional().nullable(),
  receiptMimeType: z.string().optional().nullable(),
});

export const validatePaymentSchema = z.object({
  status: z.enum(["VALIDATED", "REJECTED"]),
  rejectionReason: z.string().trim().min(3, "El motivo de rechazo debe tener al menos 3 caracteres").max(500).optional().nullable(),
});

export const annulPaymentSchema = z.object({
  reason: z.string().trim().min(3, "El motivo de anulación debe tener al menos 3 caracteres").max(500),
});

export interface FinancialSummaryDto {
  quotationTotal: string;
  effectiveAdjustments: string;
  totalPayable: string;
  validatedPayments: string;
  pendingPayments: string;
  authorizedRefunds: string;
  disbursedRefunds: string;
  refundsTotal: string;
  netCollected: string;
  outstandingBalance: string;
  availableCredit: string;
  isFullyPaid: boolean;
}

// ==========================================
// 5. REEMBOLSOS Y CANCELACIÓN (3.5)
// ==========================================

export interface RefundRecordDto {
  id: string;
  requestId: string;
  amount: string;
  reason: string;
  status: "AUTHORIZED" | "DISBURSED";
  receiptFileId: string | null;
  disbursedAt: string | null;
  disbursedBy?: string | null;
  authorizedBy: string;
  authorizedAt: string;
}

export const createRefundSchema = z.object({
  requestId: z.string().uuid("ID de solicitud inválido"),
  amount: canonicalMoneySchema.refine((val) => Number(val) > 0, "El importe del reembolso debe ser positivo"),
  reason: z.string().trim().min(5, "El motivo debe tener al menos 5 caracteres").max(1000),
  receiptBase64: z.string().optional().nullable(),
  receiptMimeType: z.string().optional().nullable(),
});

export const disburseRefundSchema = z.object({
  receiptBase64: z.string().min(1, "El comprobante de egreso es obligatorio"),
  receiptMimeType: z.string().optional().nullable(),
});

export interface CancellationRecordDto {
  id: string;
  requestId: string;
  reason: string;
  refundAmount: string;
  internalCosts: string;
  cancelledBy: string;
  cancelledAt: string;
}

export const cancelRequestSchema = z.object({
  requestId: z.string().uuid("ID de solicitud inválido"),
  reason: z.string().trim().min(5, "El motivo debe tener al menos 5 caracteres").max(1000),
  internalCosts: canonicalMoneySchema.optional().nullable(),
});

export const updateRequestPrioritySchema = z.object({
  priority: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]),
});
