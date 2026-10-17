import { z } from "zod";

// ==========================================
// 1. VISITAS TÉCNICAS Y AGENDA (4.1)
// ==========================================

export interface FieldVisitCabinMeasureDto {
  id: string;
  visitId: string;
  cabinId: string;
  widthMm: string;
  heightMm: string;
  depthMm: string;
  observations: string | null;
  createdAt: string;
}

export interface FieldVisitDto {
  id: string;
  requestId: string;
  requestCode?: string;
  assignedTechnicianId: string;
  assignedTechnicianName?: string;
  scheduledDate: string;
  status: "SCHEDULED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";
  observations: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  measures?: FieldVisitCabinMeasureDto[];
}

export const createFieldVisitSchema = z.object({
  requestId: z.string().uuid("ID de solicitud inválido"),
  assignedTechnicianId: z.string().uuid("ID de técnico asignado inválido"),
  scheduledDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Formato de fecha YYYY-MM-DD"),
  observations: z.string().trim().max(1000).optional().nullable(),
});

export const updateFieldVisitStatusSchema = z.object({
  status: z.enum(["SCHEDULED", "IN_PROGRESS", "COMPLETED", "CANCELLED"]),
  observations: z.string().trim().max(1000).optional().nullable(),
});

export const recordVisitMeasuresSchema = z.object({
  visitId: z.string().uuid("ID de visita inválido"),
  measures: z.array(
    z.object({
      cabinId: z.string().uuid("ID de cabina inválido"),
      widthMm: z.number().positive("El ancho debe ser mayor a 0"),
      heightMm: z.number().positive("El alto debe ser mayor a 0"),
      depthMm: z.number().positive("La profundidad debe ser mayor a 0"),
      observations: z.string().trim().max(1000).optional().nullable(),
    })
  ).min(1, "Debe registrar al menos una medida"),
});

// ==========================================
// 2. TAREAS DE CAMPO Y TRANSPORTE (4.2)
// ==========================================

export interface FieldTaskDto {
  id: string;
  requestId: string;
  requestCode?: string;
  taskType: "VISIT" | "TRANSPORT" | "INSTALLATION" | "MAINTENANCE";
  assignedTo: string;
  assignedToName?: string;
  scheduledDate: string;
  status: "SCHEDULED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";
  title: string;
  description: string | null;
  stopOrder: number | null;
  notes: string | null;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

export const createFieldTaskSchema = z.object({
  requestId: z.string().uuid("ID de solicitud inválido"),
  taskType: z.enum(["VISIT", "TRANSPORT", "INSTALLATION", "MAINTENANCE"]),
  assignedTo: z.string().uuid("ID de usuario asignado inválido"),
  scheduledDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Formato de fecha YYYY-MM-DD"),
  title: z.string().trim().min(3, "El título debe tener al menos 3 caracteres").max(200),
  description: z.string().trim().max(1000).optional().nullable(),
  stopOrder: z.number().int().min(1).optional().nullable().default(1),
  notes: z.string().trim().max(1000).optional().nullable(),
});

export const updateFieldTaskStatusSchema = z.object({
  status: z.enum(["SCHEDULED", "IN_PROGRESS", "COMPLETED", "CANCELLED"]),
  notes: z.string().trim().max(1000).optional().nullable(),
});

// ==========================================
// 3. RUTAS MULTI-DESTINO Y LOGÍSTICA (4.2)
// ==========================================

export interface FieldRouteStopDto {
  id: string;
  routeId: string;
  requestId: string;
  requestCode?: string;
  taskId: string | null;
  stopOrder: number;
  address: string;
  contactName: string | null;
  contactPhone: string | null;
  status: "PENDING" | "ARRIVED" | "COMPLETED" | "SKIPPED";
  notes: string | null;
  createdAt: string;
}

export interface FieldRouteDto {
  id: string;
  driverId: string;
  driverName?: string;
  routeDate: string;
  title: string;
  status: "PLANNED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";
  vehiclePlate: string | null;
  notes: string | null;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  stops?: FieldRouteStopDto[];
}

export const createFieldRouteSchema = z.object({
  driverId: z.string().uuid("ID de transportador inválido"),
  routeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Formato de fecha YYYY-MM-DD"),
  title: z.string().trim().min(3).max(200),
  vehiclePlate: z.string().trim().min(3).max(20).optional().nullable(),
  notes: z.string().trim().max(1000).optional().nullable(),
  stops: z.array(
    z.object({
      requestId: z.string().uuid("ID de solicitud inválido"),
      taskId: z.string().uuid("ID de tarea inválido").optional().nullable(),
      stopOrder: z.number().int().min(1),
      address: z.string().trim().min(3).max(200),
      contactName: z.string().trim().max(150).optional().nullable(),
      contactPhone: z.string().trim().max(30).optional().nullable(),
      notes: z.string().trim().max(1000).optional().nullable(),
    })
  ).min(1, "La ruta debe tener al menos una parada"),
});

// ==========================================
// 4. EVENTOS DE UBICACIÓN Y SALIDA/LLEGADA CON GPS (4.2)
// ==========================================

export interface FieldLocationEventDto {
  id: string;
  taskId: string;
  eventType: "DEPARTURE" | "ARRIVAL" | "CHECKPOINT";
  latitude: string | null;
  longitude: string | null;
  accuracyMeters: string | null;
  gpsStatus: "ACQUIRED" | "DENIED" | "UNAVAILABLE" | "TIMEOUT";
  warningNotes: string | null;
  serverRecordedAt: string;
  recordedBy: string;
  recordedByName?: string;
}

export const recordLocationEventSchema = z.object({
  taskId: z.string().uuid("ID de tarea inválido"),
  eventType: z.enum(["DEPARTURE", "ARRIVAL", "CHECKPOINT"]),
  latitude: z.number().min(-90).max(90).optional().nullable(),
  longitude: z.number().min(-180).max(180).optional().nullable(),
  accuracyMeters: z.number().nonnegative().optional().nullable(),
  gpsStatus: z.enum(["ACQUIRED", "DENIED", "UNAVAILABLE", "TIMEOUT"]).default("ACQUIRED"),
  warningNotes: z.string().trim().max(500).optional().nullable(),
});

// ==========================================
// 5. INSTALACIÓN CONJUNTA Y CONSUMO DE MATERIALES (4.3)
// ==========================================

export interface InstallationMaterialConsumptionDto {
  id: string;
  sessionId: string;
  requestId: string;
  materialId: string;
  materialName?: string;
  materialSku?: string;
  plannedQuantity: string;
  actualQuantity: string;
  difference: string;
  reconciled: boolean;
  notes: string | null;
  createdAt: string;
}

export interface InstallationSessionDto {
  id: string;
  requestId: string;
  requestCode?: string;
  taskId: string;
  sessionDate: string;
  technicianId: string;
  technicianName?: string;
  status: "IN_PROGRESS" | "PAUSED" | "COMPLETED";
  startedAt: string;
  endedAt: string | null;
  materialsDeducted: boolean;
  notes: string | null;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  consumptions?: InstallationMaterialConsumptionDto[];
}

export const startInstallationSessionSchema = z.object({
  requestId: z.string().uuid("ID de solicitud inválido"),
  taskId: z.string().uuid("ID de tarea inválido"),
  sessionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Formato de fecha YYYY-MM-DD"),
  notes: z.string().trim().max(1000).optional().nullable(),
});

export const updateInstallationSessionSchema = z.object({
  status: z.enum(["IN_PROGRESS", "PAUSED", "COMPLETED"]),
  notes: z.string().trim().max(1000).optional().nullable(),
});

export const reconcileMaterialConsumptionSchema = z.object({
  sessionId: z.string().uuid("ID de sesión inválido"),
  consumptions: z.array(
    z.object({
      materialId: z.string().uuid("ID de material inválido"),
      actualQuantity: z.number().nonnegative("La cantidad consumida no puede ser negativa"),
      notes: z.string().trim().max(1000).optional().nullable(),
    })
  ).min(1, "Debe conciliar al menos un material"),
});

// ==========================================
// 6. CIERRE OPERATIVO, FIRMA Y FOTOGRAFÍAS (4.4)
// ==========================================

export interface OperationalClosurePhotoDto {
  id: string;
  closureId: string;
  cabinId: string | null;
  fileId: string;
  byteSize: number;
  mimeType: string;
  caption: string | null;
  createdAt: string;
}

export interface OperationalClosureDto {
  id: string;
  requestId: string;
  requestCode?: string;
  taskId: string;
  quotationId: string;
  quotationVersion: number;
  customerSignatoryName: string;
  customerSignatoryDocument: string | null;
  signedAt: string;
  signatureFileId: string;
  warrantyTermsSnapshot: Record<string, unknown>;
  observations: string | null;
  closedBy: string;
  closedByName?: string;
  createdAt: string;
  photos?: OperationalClosurePhotoDto[];
}

export const registerOperationalClosureSchema = z.object({
  requestId: z.string().uuid("ID de solicitud inválido"),
  taskId: z.string().uuid("ID de tarea inválido"),
  customerSignatoryName: z.string().trim().min(2, "El nombre del firmante debe tener al menos 2 caracteres").max(150),
  customerSignatoryDocument: z.string().trim().min(3).max(50).optional().nullable(),
  signedAt: z.string().datetime().optional(),
  signatureBase64: z.string().min(10, "La firma digital del cliente es obligatoria"),
  signatureMimeType: z.string().default("image/png"),
  observations: z.string().trim().max(1000).optional().nullable(),
  photos: z.array(
    z.object({
      cabinId: z.string().uuid("ID de cabina inválido").optional().nullable(),
      photoBase64: z.string().min(10, "La imagen fotográfica es obligatoria"),
      mimeType: z.string().default("image/jpeg"),
      caption: z.string().trim().max(250).optional().nullable(),
    })
  ).min(1, "Debe adjuntar al menos una fotografía de evidencia de la entrega"),
});
