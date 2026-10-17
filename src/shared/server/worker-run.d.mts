import type pg from "pg";
export function runSchedulerIteration(pool: Pick<pg.Pool, "query">): Promise<{ totalAlertsGenerated: number; accepted: number }>;
