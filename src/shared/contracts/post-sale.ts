import { z } from "zod";
import { canonicalMoneySchema } from "./money";

// ==========================================
// 1. GARANTÍAS POR CABINA FÍSICA (GAR-002..007)
// ==========================================

export interface WarrantyPhotoDto {
  id: string;
  warrantyId: string;
  fileId: string;
  caption: string | null;
  photoPhase: "REPORT" | "INSPECTION" | "RESOLUTION";
  createdAt: string;
}

export interface WarrantyDto {
  id: string;
  code: string;
  requestId: string;
  requestCode?: string;
  cabinId: string;
  productId: string;
  productName?: string;
  status:
    | "REGISTERED"
    | "IN_REVIEW"
    | "ACCEPTED"
    | "REJECTED"
    | "IN_PROGRESS"
    | "RESOLVED"
    | "CLOSED";
  claimType:
    | "ACOUSTIC_DEFECT"
    | "STRUCTURAL_DEFECT"
    | "HARDWARE_DEFECT"
    | "FINISH_DEFECT"
    | "INSTALLATION_DEFECT"
    | "OTHER";
  description: string;
  warrantyTermsSnapshot: unknown | null;
  rejectionReason: string | null;
  isReplacement: boolean;
  replacementCabinId: string | null;
  assignedTo: string | null;
  assignedToName?: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionNotes: string | null;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  photos?: WarrantyPhotoDto[];
}

export const registerWarrantyClaimSchema = z.object({
  requestId: z.string().uuid("ID de solicitud inválido"),
  cabinId: z.string().uuid("ID de cabina física individual inválido"),
  claimType: z.enum([
    "ACOUSTIC_DEFECT",
    "STRUCTURAL_DEFECT",
    "HARDWARE_DEFECT",
    "FINISH_DEFECT",
    "INSTALLATION_DEFECT",
    "OTHER",
  ]),
  description: z.string().trim().min(5, "La descripción debe tener al menos 5 caracteres").max(2000),
  assignedTo: z.string().uuid("ID de técnico inválido").optional().nullable(),
  photoBase64: z.string().optional(),
  photoMimeType: z.enum(["image/jpeg", "image/png"]).optional(),
  photoCaption: z.string().trim().max(300).optional(),
});

export const updateWarrantyStatusSchema = z.object({
  status: z.enum([
    "REGISTERED",
    "IN_REVIEW",
    "ACCEPTED",
    "REJECTED",
    "IN_PROGRESS",
    "RESOLVED",
    "CLOSED",
  ]),
  rejectionReason: z.string().trim().min(5, "El motivo de rechazo es obligatorio").max(1000).optional(),
  assignedTo: z.string().uuid().optional().nullable(),
  isReplacement: z.boolean().optional(),
  replacementCabinId: z.string().uuid().optional().nullable(),
  resolutionNotes: z.string().trim().min(5, "Las notas de resolución son obligatorias").max(2000).optional(),
});

export const addWarrantyPhotoSchema = z.object({
  warrantyId: z.string().uuid("ID de garantía inválido"),
  photoBase64: z.string().min(1, "Foto en base64 obligatoria"),
  mimeType: z.enum(["image/jpeg", "image/png"]),
  caption: z.string().trim().max(300).optional().nullable(),
  photoPhase: z.enum(["REPORT", "INSPECTION", "RESOLUTION"]).default("INSPECTION"),
});

// ==========================================
// 2. NOVEDADES OPERATIVAS (GAR-001, GAR-005)
// ==========================================

export interface OperationalIssueDto {
  id: string;
  requestId: string;
  requestCode?: string;
  stage: "VISIT" | "PROCUREMENT" | "TRANSPORT" | "INSTALLATION" | "WARRANTY";
  referenceId: string | null;
  title: string;
  description: string;
  severity: "LOW" | "MEDIUM" | "HIGH" | "BLOCKING";
  status: "OPEN" | "IN_PROGRESS" | "RESOLVED" | "CANCELLED";
  evidenceFileId: string | null;
  assignedTo: string | null;
  assignedToName?: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionNotes: string | null;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

export const createOperationalIssueSchema = z.object({
  requestId: z.string().uuid("ID de solicitud inválido"),
  stage: z.enum(["VISIT", "PROCUREMENT", "TRANSPORT", "INSTALLATION", "WARRANTY"]),
  referenceId: z.string().uuid().optional().nullable(),
  title: z.string().trim().min(3, "El título debe tener al menos 3 caracteres").max(200),
  description: z.string().trim().min(5, "La descripción debe tener al menos 5 caracteres").max(2000),
  severity: z.enum(["LOW", "MEDIUM", "HIGH", "BLOCKING"]).default("MEDIUM"),
  assignedTo: z.string().uuid().optional().nullable(),
  evidenceBase64: z.string().optional(),
  evidenceMimeType: z.enum(["image/jpeg", "image/png", "application/pdf"]).optional(),
});

export const updateOperationalIssueSchema = z.object({
  status: z.enum(["OPEN", "IN_PROGRESS", "RESOLVED", "CANCELLED"]),
  assignedTo: z.string().uuid().optional().nullable(),
  resolutionNotes: z.string().trim().min(5, "Las notas de resolución son requeridas").max(2000).optional(),
});

// ==========================================
// 3. COSTOS OPERATIVOS REALES (FIN-007, DEC-008)
// ==========================================

export interface OperationalCostDto {
  id: string;
  requestId: string;
  requestCode?: string;
  category:
    | "PURCHASE"
    | "INSTALLATION"
    | "TRANSPORT"
    | "PER_DIEM"
    | "MATERIAL"
    | "REWORK"
    | "WARRANTY"
    | "OTHER";
  concept: string;
  amount: string | null; // enmascarado si el usuario carece de costs.read
  referenceId: string | null;
  voucherFileId: string | null;
  active: boolean;
  annulledAt: string | null;
  annulledBy: string | null;
  annulmentReason: string | null;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

export const createOperationalCostSchema = z.object({
  requestId: z.string().uuid("ID de solicitud inválido"),
  category: z.enum([
    "PURCHASE",
    "INSTALLATION",
    "TRANSPORT",
    "PER_DIEM",
    "MATERIAL",
    "REWORK",
    "WARRANTY",
    "OTHER",
  ]),
  concept: z.string().trim().min(3, "El concepto debe tener al menos 3 caracteres").max(250),
  amount: canonicalMoneySchema,
  referenceId: z.string().uuid().optional().nullable(),
  voucherBase64: z.string().optional(),
  voucherMimeType: z.enum(["image/jpeg", "image/png", "application/pdf"]).optional(),
});

export const annulOperationalCostSchema = z.object({
  reason: z.string().trim().min(5, "El motivo de anulación es obligatorio").max(500),
});

// ==========================================
// 4. GESTIÓN, REPORTES Y DASHBOARD (REP-001..008)
// ==========================================

export interface ManagementDashboardDto {
  summary: {
    totalRequests: number;
    activeRequests: number;
    dispatchedCabins: number;
    pendingInstallations: number;
    openIssues: number;
    openWarranties: number;
    financialTotals: {
      quotedAmount: string;
      collectedAmount: string;
      outstandingBalance: string;
      operationalCosts: string | null; // enmascarado si falta costs.read
      netMargin: string | null; // enmascarado si falta costs.read
    };
  };
  stageDistribution: Array<{ stage: string; count: number }>;
  recentIssues: OperationalIssueDto[];
  recentWarranties: WarrantyDto[];
}

export interface OperationalReportRowDto {
  requestId: string;
  requestCode: string;
  clientName: string;
  clientDocument: string;
  totalCabins: number;
  commercialStatus: string;
  operationalStatus: string;
  financialStatus: string;
  quotedTotal: string;
  netCollected: string;
  pendingBalance: string;
  operationalCost: string | null; // enmascarado
  estimatedProfit: string | null; // enmascarado
  createdAt: string;
}

export interface OperationalReportDto {
  rows: OperationalReportRowDto[];
  totals: {
    totalRequests: number;
    totalCabins: number;
    quotedSum: string;
    collectedSum: string;
    balanceSum: string;
    costsSum: string | null;
  };
}

export interface IntegratedSearchItemDto {
  id: string;
  kind: "REQUEST" | "CLIENT" | "PRODUCT" | "TASK" | "WARRANTY" | "ISSUE";
  code: string;
  title: string;
  subtitle: string;
  status: string;
  date: string;
}

// ==========================================
// 5. ALERTAS Y NOTIFICACIONES (REP-004, REP-005)
// ==========================================

export interface InternalNotificationDto {
  id: string;
  eventType:
    | "PENDING_TASK"
    | "OVERDUE_PAYMENT"
    | "DELAYED_OPERATION"
    | "BLOCKING_ISSUE"
    | "WARRANTY_CLAIM"
    | "STOCK_ALERT";
  title: string;
  message: string;
  referenceType: "REQUEST" | "TASK" | "PAYMENT" | "ISSUE" | "WARRANTY" | "STOCK" | null;
  referenceId: string | null;
  readAt: string | null;
  createdAt: string;
}

export const markNotificationReadSchema = z.object({
  notificationId: z.string().uuid("ID de notificación inválido"),
});
