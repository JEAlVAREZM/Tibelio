import "server-only";
import { runAuthorized } from "../../platform/server/service";
import { canReadCosts, type ActorContext } from "../../identity/server/authorization";
import { Decimal } from "../../../shared/server/money-math";
import {
  type ManagementDashboardDto,
  type OperationalReportDto,
  type OperationalReportRowDto,
  type IntegratedSearchItemDto,
  type OperationalIssueDto,
  type WarrantyDto,
} from "../../../shared/contracts/post-sale";

export async function getManagementDashboard(
  token: string | null,
): Promise<ManagementDashboardDto> {
  return runAuthorized(token, "reports.read", false, async (db, scope) => {
    const actorRes = await db.query<{ actor: ActorContext }>("select app_private.actor() actor");
    const actor = actorRes.rows[0]?.actor;
    const canSeeCosts = canReadCosts(actor);

    // 1. Resumen de solicitudes
    const reqCounts = await db.query<{
      total_reqs: string;
      active_reqs: string;
    }>(
      `select 
         count(*) as total_reqs,
         count(*) filter (where status not in ('CANCELLED')) as active_reqs
       from app.commercial_requests
       where tenant_id = $1`,
      [scope.tenantId],
    );

    // 2. Cabinas físicas despachadas e instalaciones pendientes
    const cabinCounts = await db.query<{
      dispatched_cabins: string;
      pending_installations: string;
    }>(
      `select 
         coalesce((select count(*)::text from app.dispatch_lines where tenant_id = $1), '0') as dispatched_cabins,
         count(*) filter (where status = 'DISPATCHED' and (location is null or location <> 'INSTALADA Y ENTREGADA')) as pending_installations
       from app.cabin_stock
       where tenant_id = $1`,
      [scope.tenantId],
    );

    // 3. Novedades y Garantías abiertas
    const issuesCount = await db.query<{ open_issues: string }>(
      `select count(*) as open_issues
       from app.operational_issues
       where tenant_id = $1 and status in ('OPEN', 'IN_PROGRESS')`,
      [scope.tenantId],
    );

    const warrantiesCount = await db.query<{ open_warranties: string }>(
      `select count(*) as open_warranties
       from app.warranties
       where tenant_id = $1 and status in ('REGISTERED', 'IN_REVIEW', 'ACCEPTED', 'IN_PROGRESS')`,
      [scope.tenantId],
    );

    // 4. Totales financieros
    const finRes = await db.query<{
      quoted_sum: string;
      collected_sum: string;
      disbursed_sum: string;
    }>(
      `select 
         coalesce(sum(q.total_amount), 0) as quoted_sum,
         (select coalesce(sum(cp.amount), 0) from app.client_payments cp where cp.tenant_id = $1 and cp.status = 'VALIDATED') as collected_sum,
         (select coalesce(sum(rr.amount), 0) from app.refund_records rr where rr.tenant_id = $1 and rr.status = 'DISBURSED') as disbursed_sum
       from app.quotations q
       where q.tenant_id = $1 and q.status = 'APPROVED'`,
      [scope.tenantId],
    );

    const quotedDec = Decimal.from(finRes.rows[0]?.quoted_sum || "0");
    const valPayDec = Decimal.from(finRes.rows[0]?.collected_sum || "0");
    const disbDec = Decimal.from(finRes.rows[0]?.disbursed_sum || "0");
    const netCollectedDec = valPayDec.sub(disbDec).gt(0) ? valPayDec.sub(disbDec) : Decimal.from(0);
    const balanceDec = quotedDec.sub(netCollectedDec).gt(0) ? quotedDec.sub(netCollectedDec) : Decimal.from(0);

    let costsStr: string | null = null;
    let netMarginStr: string | null = null;

    if (canSeeCosts) {
      const costsRes = await db.query<{ total_costs: string }>(
        `select coalesce(sum(amount), 0) as total_costs
         from app.operational_costs
         where tenant_id = $1 and active = true`,
        [scope.tenantId],
      );
      const totalCostsDec = Decimal.from(costsRes.rows[0]?.total_costs || "0");
      costsStr = totalCostsDec.round(2);
      netMarginStr = netCollectedDec.sub(totalCostsDec).round(2);
    }

    // 5. Novedades recientes
    const recIssuesRes = await db.query<OperationalIssueDto>(
      `select 
         oi.id, oi.request_id as "requestId", cr.code as "requestCode",
         oi.stage, oi.reference_id as "referenceId",
         oi.title, oi.description, oi.severity, oi.status,
         oi.evidence_file_id as "evidenceFileId",
         oi.assigned_to as "assignedTo", u.display_name as "assignedToName",
         oi.resolved_at as "resolvedAt", oi.resolved_by as "resolvedBy",
         oi.resolution_notes as "resolutionNotes",
         oi.created_at as "createdAt", oi.created_by as "createdBy",
         oi.updated_at as "updatedAt", oi.updated_by as "updatedBy"
       from app.operational_issues oi
       join app.commercial_requests cr on cr.tenant_id = oi.tenant_id and cr.id = oi.request_id
       left join app.users u on u.tenant_id = oi.tenant_id and u.id = oi.assigned_to
       where oi.tenant_id = $1
       order by oi.created_at desc limit 5`,
      [scope.tenantId],
    );

    // 6. Garantías recientes
    const recWarrantiesRes = await db.query<WarrantyDto>(
      `select 
         w.id, w.code, w.request_id as "requestId", cr.code as "requestCode",
         w.cabin_id as "cabinId", w.product_id as "productId", cp.name as "productName",
         w.status, w.claim_type as "claimType", w.description,
         w.warranty_terms_snapshot as "warrantyTermsSnapshot", w.rejection_reason as "rejectionReason",
         w.is_replacement as "isReplacement", w.replacement_cabin_id as "replacementCabinId",
         w.assigned_to as "assignedTo", u.display_name as "assignedToName",
         w.resolved_at as "resolvedAt", w.resolved_by as "resolvedBy",
         w.resolution_notes as "resolutionNotes",
         w.created_at as "createdAt", w.created_by as "createdBy",
         w.updated_at as "updatedAt", w.updated_by as "updatedBy"
       from app.warranties w
       join app.commercial_requests cr on cr.tenant_id = w.tenant_id and cr.id = w.request_id
       join app.catalog_products cp on cp.tenant_id = w.tenant_id and cp.id = w.product_id
       left join app.users u on u.tenant_id = w.tenant_id and u.id = w.assigned_to
       where w.tenant_id = $1
       order by w.created_at desc limit 5`,
      [scope.tenantId],
    );

    return {
      summary: {
        totalRequests: parseInt(reqCounts.rows[0]?.total_reqs || "0", 10),
        activeRequests: parseInt(reqCounts.rows[0]?.active_reqs || "0", 10),
        dispatchedCabins: parseInt(cabinCounts.rows[0]?.dispatched_cabins || "0", 10),
        pendingInstallations: parseInt(cabinCounts.rows[0]?.pending_installations || "0", 10),
        openIssues: parseInt(issuesCount.rows[0]?.open_issues || "0", 10),
        openWarranties: parseInt(warrantiesCount.rows[0]?.open_warranties || "0", 10),
        financialTotals: {
          quotedAmount: quotedDec.round(2),
          collectedAmount: netCollectedDec.round(2),
          outstandingBalance: balanceDec.round(2),
          operationalCosts: costsStr,
          netMargin: netMarginStr,
        },
      },
      stageDistribution: [
        { stage: "Solicitudes Activas", count: parseInt(reqCounts.rows[0]?.active_reqs || "0", 10) },
        { stage: "Despachadas en Ruta/Obra", count: parseInt(cabinCounts.rows[0]?.pending_installations || "0", 10) },
        { stage: "Novedades Abiertas", count: parseInt(issuesCount.rows[0]?.open_issues || "0", 10) },
        { stage: "Garantías en Curso", count: parseInt(warrantiesCount.rows[0]?.open_warranties || "0", 10) },
      ],
      recentIssues: recIssuesRes.rows,
      recentWarranties: recWarrantiesRes.rows,
    };
  });
}

export async function getOperationalReport(
  token: string | null,
  options?: { startDate?: string; endDate?: string; status?: string },
): Promise<OperationalReportDto> {
  return runAuthorized(token, "reports.read", false, async (db, scope) => {
    const actorRes = await db.query<{ actor: ActorContext }>("select app_private.actor() actor");
    const actor = actorRes.rows[0]?.actor;
    const canSeeCosts = canReadCosts(actor);

    const params: unknown[] = [scope.tenantId];
    let sql = `
      select 
        cr.id as request_id,
        cr.code as request_code,
        c.legal_name as client_name,
        c.tax_id as client_document,
        case 
          when cr.status = 'CANCELLED' then 'CANCELLED'
          when q.status = 'APPROVED' then 'APPROVED'
          else cr.status
        end as commercial_status,
        cr.created_at,
        coalesce(q.total_amount, 0)::text as quoted_amount,
        coalesce((select count(*) from app.request_cabins rc where rc.tenant_id = cr.tenant_id and rc.request_id = cr.id), 0)::int as total_cabins,
        coalesce((
          select sum(cp.amount) from app.client_payments cp 
          where cp.tenant_id = cr.tenant_id and cp.request_id = cr.id and cp.status = 'VALIDATED'
        ), 0)::text as validated_payments,
        coalesce((
          select sum(rr.amount) from app.refund_records rr
          where rr.tenant_id = cr.tenant_id and rr.request_id = cr.id and rr.status = 'DISBURSED'
        ), 0)::text as disbursed_refunds,
        coalesce((
          select sum(oc.amount) from app.operational_costs oc
          where oc.tenant_id = cr.tenant_id and oc.request_id = cr.id and oc.active = true
        ), 0)::text as request_costs,
        (select dr.status from app.dispatch_records dr where dr.tenant_id = cr.tenant_id and dr.request_id = cr.id order by dr.created_at desc limit 1) as dispatch_status,
        (select oc2.id is not null from app.operational_closures oc2 where oc2.tenant_id = cr.tenant_id and oc2.request_id = cr.id limit 1) as has_closure
      from app.commercial_requests cr
      join app.clients c on c.tenant_id = cr.tenant_id and c.id = cr.client_id
      left join app.quotations q on q.tenant_id = cr.tenant_id and q.request_id = cr.id and q.status = 'APPROVED'
      where cr.tenant_id = $1`;

    if (options?.startDate) {
      params.push(options.startDate);
      sql += ` and cr.created_at >= $${params.length}`;
    }
    if (options?.endDate) {
      params.push(options.endDate);
      sql += ` and cr.created_at <= $${params.length}`;
    }
    if (options?.status) {
      params.push(options.status);
      sql += ` and cr.status = $${params.length}`;
    }

    sql += " order by cr.created_at desc";

    const res = await db.query<{
      request_id: string;
      request_code: string;
      client_name: string;
      client_document: string;
      commercial_status: string;
      created_at: string;
      quoted_amount: string;
      total_cabins: number;
      validated_payments: string;
      disbursed_refunds: string;
      request_costs: string;
      dispatch_status: string | null;
      has_closure: boolean | null;
    }>(sql, params);

    let quotedSum = Decimal.from(0);
    let collectedSum = Decimal.from(0);
    let balanceSum = Decimal.from(0);
    let costsSum = Decimal.from(0);
    let cabinsSum = 0;

    const rows: OperationalReportRowDto[] = res.rows.map((r) => {
      const qDec = Decimal.from(r.quoted_amount);
      const valDec = Decimal.from(r.validated_payments);
      const disbDec = Decimal.from(r.disbursed_refunds);
      const netCollDec = valDec.sub(disbDec).gt(0) ? valDec.sub(disbDec) : Decimal.from(0);
      const balDec = qDec.sub(netCollDec).gt(0) ? qDec.sub(netCollDec) : Decimal.from(0);
      const costDec = Decimal.from(r.request_costs);

      quotedSum = quotedSum.add(qDec);
      collectedSum = collectedSum.add(netCollDec);
      balanceSum = balanceSum.add(balDec);
      costsSum = costsSum.add(costDec);
      cabinsSum += r.total_cabins;

      // Determinar estado operativo separado
      let opStatus = "PENDIENTE";
      if (r.has_closure) {
        opStatus = "INSTALADA Y ENTREGADA";
      } else if (r.dispatch_status === "DISPATCHED") {
        opStatus = "DESPACHADA / EN OBRA";
      }

      // Determinar estado financiero separado
      let finStatus = "PENDIENTE";
      if (netCollDec.gte(qDec) && qDec.gt(0)) {
        finStatus = "PAGADA AL 100%";
      } else if (netCollDec.gt(0)) {
        finStatus = "ABONO PARCIAL";
      }

      return {
        requestId: r.request_id,
        requestCode: r.request_code,
        clientName: r.client_name,
        clientDocument: r.client_document,
        totalCabins: r.total_cabins,
        commercialStatus: r.commercial_status,
        operationalStatus: opStatus,
        financialStatus: finStatus,
        quotedTotal: qDec.round(2),
        netCollected: netCollDec.round(2),
        pendingBalance: balDec.round(2),
        operationalCost: canSeeCosts ? costDec.round(2) : null,
        estimatedProfit: canSeeCosts ? netCollDec.sub(costDec).round(2) : null,
        createdAt: r.created_at,
      };
    });

    return {
      rows,
      totals: {
        totalRequests: rows.length,
        totalCabins: cabinsSum,
        quotedSum: quotedSum.round(2),
        collectedSum: collectedSum.round(2),
        balanceSum: balanceSum.round(2),
        costsSum: canSeeCosts ? costsSum.round(2) : null,
      },
    };
  });
}

export async function searchEverything(
  token: string | null,
  queryText: string,
): Promise<IntegratedSearchItemDto[]> {
  return runAuthorized(token, "requests.read", false, async (db, scope) => {
    const q = `%${queryText.trim().toLowerCase()}%`;
    const results: IntegratedSearchItemDto[] = [];

    // 1. Solicitudes
    const reqRes = await db.query<{
      id: string;
      code: string;
      status: string;
      client_name: string;
      created_at: string;
    }>(
      `select cr.id, cr.code, cr.status, c.legal_name as client_name, cr.created_at::text
       from app.commercial_requests cr
       join app.clients c on c.tenant_id = cr.tenant_id and c.id = cr.client_id
       where cr.tenant_id = $1 and (lower(cr.code) like $2 or lower(c.legal_name) like $2)
       order by cr.created_at desc limit 5`,
      [scope.tenantId, q],
    );
    for (const r of reqRes.rows) {
      results.push({
        id: r.id,
        kind: "REQUEST",
        code: r.code,
        title: `Solicitud ${r.code}`,
        subtitle: `Cliente: ${r.client_name}`,
        status: r.status,
        date: r.created_at,
      });
    }

    // 2. Garantías
    const warRes = await db.query<{
      id: string;
      code: string;
      status: string;
      claim_type: string;
      description: string;
      created_at: string;
    }>(
      `select id, code, status, claim_type, description, created_at::text
       from app.warranties
       where tenant_id = $1 and (lower(code) like $2 or lower(description) like $2)
       order by created_at desc limit 5`,
      [scope.tenantId, q],
    );
    for (const w of warRes.rows) {
      results.push({
        id: w.id,
        kind: "WARRANTY",
        code: w.code,
        title: `Garantía ${w.code}`,
        subtitle: `${w.claim_type}: ${w.description.slice(0, 50)}`,
        status: w.status,
        date: w.created_at,
      });
    }

    // 3. Novedades
    const issRes = await db.query<{
      id: string;
      title: string;
      stage: string;
      severity: string;
      status: string;
      created_at: string;
    }>(
      `select id, title, stage, severity, status, created_at::text
       from app.operational_issues
       where tenant_id = $1 and (lower(title) like $2 or lower(description) like $2)
       order by created_at desc limit 5`,
      [scope.tenantId, q],
    );
    for (const i of issRes.rows) {
      results.push({
        id: i.id,
        kind: "ISSUE",
        code: `NOV-${i.stage}`,
        title: `Novedad: ${i.title}`,
        subtitle: `Severidad: ${i.severity}`,
        status: i.status,
        date: i.created_at,
      });
    }

    return results;
  });
}
