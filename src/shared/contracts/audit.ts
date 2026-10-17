export const AUDIT_ENTITIES: Record<string, string> = {
  clients: "Clientes", client_addresses: "Direcciones", catalog_products: "Catálogo", pricing_zones: "Zonas", zone_municipalities: "Municipios de zona",
  commercial_settings: "Parámetros comerciales", commercial_requests: "Solicitudes", request_cabins: "Cabinas solicitadas", request_items: "Ítems solicitados",
  quotations: "Cotizaciones", quotation_cabins: "Cabinas cotizadas", quotation_items: "Ítems cotizados", quotation_adjustments: "Ajustes comerciales", quotation_documents: "Documentos de cotización",
  suppliers: "Proveedores", procurement_reviews: "Revisiones de compra", purchase_orders: "Órdenes de compra", purchase_order_lines: "Ítems de compra", procurement_receipts: "Recepciones", procurement_receipt_lines: "Ítems recibidos",
  warehouse_stock: "Existencias", cabin_stock: "Cabinas físicas", inventory_movements: "Movimientos de inventario", dispatch_records: "Despachos", dispatch_lines: "Ítems despachados",
  payment_terms: "Condiciones de pago", client_payments: "Pagos", refund_records: "Devoluciones", cancellation_records: "Cancelaciones",
  field_visits: "Visitas", field_visit_cabin_measures: "Medidas de cabina", field_tasks: "Tareas", field_routes: "Rutas", field_route_stops: "Paradas", field_location_events: "Eventos de ubicación",
  installation_sessions: "Sesiones de instalación", installation_material_consumptions: "Consumos", operational_closures: "Cierres operativos", operational_closure_photos: "Evidencias de cierre",
  warranties: "Garantías", warranty_photos: "Evidencias de garantía", operational_issues: "Novedades", operational_costs: "Costos reales", users: "Usuarios", roles: "Roles", user_roles: "Roles asignados",
};
const FIELDS: Record<string,string> = {
  name: "Nombre", legal_name: "Nombre o razón social", display_name: "Nombre visible", tax_id: "Identificación", phone: "Teléfono", email: "Correo", sku: "Código SKU", kind: "Tipo", active: "Activo", status: "Estado", priority: "Prioridad", location: "Ubicación", authority: "Autoridad", grants: "Permisos concedidos", denials: "Permisos denegados", permissions: "Permisos", pricing_method: "Método de precio", password_hash: "Contraseña (valor protegido)", auth_version: "Versión de autenticación", quantity: "Cantidad", previous_balance: "Saldo anterior", new_balance: "Nuevo saldo", notes: "Notas", reason: "Motivo", cancellation_reason: "Motivo de cancelación", amount: "Importe", user_id: "Usuario", role_id: "Rol", client_id: "Cliente", client_address_id: "Dirección", product_id: "Producto", request_id: "Solicitud", quotation_id: "Cotización", code: "Código", version: "Versión", movement_type: "Tipo de movimiento", receipt_path: "Comprobante (archivo privado)", updated_at: "Fecha de actualización",
};
export const auditFieldLabel = (field: string) => FIELDS[field] ?? "Campo del registro";
export interface AuditEvent {
  id: string; entity: string; recordId: string; recordLabel: string; actorLabel: string;
  operation: "INSERT" | "UPDATE" | "DELETE"; changedFields: string[];
  beforeValues: Record<string,unknown>; afterValues: Record<string,unknown>; occurredAt: string;
}
