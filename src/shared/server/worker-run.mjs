import { pushConfiguration, sendPush } from "./push-transport.mjs";

export async function runSchedulerIteration(pool) {
  const generated = await pool.query("select app_private.run_alert_schedule() as generated");
  let accepted = 0;
  if (pushConfiguration()) {
    const batch = await pool.query("select * from app_private.claim_push_batch()");
    for (const item of batch.rows) {
      const result = await sendPush({ endpoint: item.endpoint, keys: { p256dh: item.p256dh, auth: item.auth } });
      await pool.query("select app_private.finish_push($1,$2,$3,$4)", [item.notification_id,item.subscription_id,result.accepted,result.expired]);
      if (result.accepted) accepted++;
    }
  }
  return { totalAlertsGenerated: generated.rows[0].generated, accepted };
}
