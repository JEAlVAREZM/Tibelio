/** Display labels only: persisted codes and API payloads never change language. */
export const UI_LABELS: Record<string, string> = {
  ANULADO:"Anulado",CONFIRMADO:"Confirmado",PLANNED:"Planificada",ARRIVED:"En destino",SKIPPED:"Omitida",SERVICE:"Servicio",
  TRANSFER:"Transferencia",DEPOSIT:"Consignación",CARD:"Tarjeta",CASH:"Efectivo",PREPARED:"Preparado",
  REPORT:"Reporte", INSPECTION:"Inspección", RESOLUTION:"Resolución",
  PENDIENTE:"Pendiente", "INSTALADA Y ENTREGADA":"Instalada y entregada", "DESPACHADA / EN OBRA":"Despachada / en obra", "PAGADA AL 100%":"Pagada al 100%", "ABONO PARCIAL":"Abono parcial",
  RECEPTION: "Recepción", PARTIAL_RECEIVED: "Recibida parcialmente", NOT_FOUND: "Sin revisión", REASSIGNMENT: "Reasignación",
  DRAFT: "Borrador", REGISTERED: "Registrada", SENT: "Enviada", QUOTED: "Cotizada", APPROVED: "Aprobada", REJECTED: "Rechazada", EXPIRED: "Vencida", CANCELLED: "Cancelada",
  OPEN: "Abierta", IN_PROGRESS: "En curso", COMPLETED: "Completada", DONE: "Terminada", CLOSED: "Cerrada", PAUSED: "Pausada", SCHEDULED: "Programada", PENDING: "Pendiente", PENDING_VALIDATION: "Pendiente de validación", VALIDATED: "Validado", ANNULLED: "Anulado", AUTHORIZED: "Autorizado", DISBURSED: "Desembolsado", REFUNDED: "Reembolsado", PAID: "Pagado", UNPAID: "Sin pagar", PARTIAL: "Parcial", PARTIAL_RECEIPT: "Recepción parcial", PARTIALLY_RECEIVED: "Recibida parcialmente", RECEIVED: "Recibida", ORDERED: "Solicitada", ISSUED: "Emitida", READY: "Lista", DISPATCHED: "Despachada", DELIVERED: "Entregada", INSTALLED: "Instalada", IN_STOCK: "En bodega", DAMAGED: "Dañada", RETURNED: "Devuelta", MAINTENANCE: "En mantenimiento", IN_MAINTENANCE: "En mantenimiento", IN_REVIEW: "En revisión", ASSESSED: "Evaluada", ASSIGNED: "Asignada", ACCEPTED: "Aceptada", RESOLVED: "Resuelta", REVISED: "Revisada", EFFECTIVE: "Aplicado", SUPERSEDED: "Sustituida",
  ACTIVE: "Activa", INACTIVE: "Inactiva", GRACE: "Periodo de gracia", READ_ONLY: "Solo lectura", ADMIN: "Administrador", MEMBER: "Miembro", SUPERADMIN: "Superadministrador", TENANT: "Empresa",
  CABIN: "Cabina", ACCESSORY: "Accesorio", MATERIAL: "Material", PRODUCT: "Producto", CATALOG_PRICE: "Precio de catálogo", COST_MARGIN: "Costo y margen",
  LOW: "Baja", NORMAL: "Normal", MEDIUM: "Media", HIGH: "Alta", URGENT: "Urgente", BLOCKING: "Bloqueante",
  VISIT: "Visita técnica", PROCUREMENT: "Compras", PURCHASE: "Compra", TRANSPORT: "Transporte", INSTALLATION: "Instalación", WARRANTY: "Garantía", PER_DIEM: "Viáticos", REWORK: "Reproceso", OTHER: "Otro",
  PURCHASE_RECEIPT: "Recepción de compra", RECEIPT: "Recepción", ADJUSTMENT: "Ajuste", DAMAGE: "Daño", RETURN: "Devolución", DISPATCH: "Despacho", INSTALLATION_CONSUMPTION: "Consumo de instalación", CONSUMPTION: "Consumo", RECONCILIATION: "Conciliación", REVERSAL: "Reversión", REPLACEMENT: "Reemplazo", WARRANTY_REPLACEMENT: "Reemplazo por garantía",
  DOWN_PAYMENT: "Anticipo", MANUFACTURE: "Fabricación", PRE_DISPATCH: "Antes del despacho", DELIVERY: "Entrega", FINAL: "Saldo final", POST_DELIVERY: "Después de entrega", CUSTOM: "Personalizado",
  ACQUIRED: "Obtenida", DENIED: "Denegada", UNAVAILABLE: "No disponible", TIMEOUT: "Tiempo agotado", DEPARTURE: "Salida", ARRIVAL: "Llegada",
  INCREASE: "Aumento", DECREASE: "Reducción", REDUCTION: "Reducción", OVERPAYMENT: "Sobrepago", CANCELLATION: "Cancelación",
  ACOUSTIC_DEFECT: "Falla acústica", STRUCTURAL_DEFECT: "Falla estructural", HARDWARE_DEFECT: "Falla de herrajes", FINISH_DEFECT: "Defecto de acabado", INSTALLATION_DEFECT: "Defecto de instalación",
  BLOCKING_ISSUE: "Novedad crítica", WARRANTY_CLAIM: "Reclamo de garantía", DELAYED_OPERATION: "Operación atrasada", PAYMENT_DUE: "Pago vencido", OVERDUE_PAYMENT: "Pago vencido", STOCK_ALERT: "Aviso de inventario", TASK_ASSIGNED: "Tarea asignada",
  REQUEST: "Solicitud", QUOTATION: "Cotización", CLIENT: "Cliente", ISSUE: "Novedad", TASK: "Tarea", ROUTE: "Ruta", PAYMENT: "Pago", PURCHASE_ORDER: "Orden de compra", PDF: "PDF", EVIDENCE: "Evidencia", PHOTO: "Fotografía", SIGNATURE: "Firma",
  INSERT: "Creación", UPDATE: "Edición", DELETE: "Eliminación", SYSTEM: "Proceso del sistema",
};
export function displayLabel(value: string | null | undefined): string {
  if (!value) return "—";
  return UI_LABELS[value] ?? "Sin clasificar";
}
export function searchText(value: unknown): string {
  return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("es").trim();
}
