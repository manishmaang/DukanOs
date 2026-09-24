/* global module */
// Pre-Bills fixture for forward-migration preservation tests; never an application path.
const { randomUUID, createHash } = require('node:crypto');
module.exports.legacyOrder = async function (sql, actor, lines) {
  const id = randomUUID(),
    requestId = randomUUID();
  await sql.query('BEGIN');
  try {
    const t = (
      await sql.query(
        "SELECT clock_timestamp() AS time,(clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date::text AS date",
      )
    ).rows[0];
    const token = (
      await sql.query(
        'INSERT INTO order_daily_tokens VALUES($1,1) ON CONFLICT(business_date) DO UPDATE SET last_token=order_daily_tokens.last_token+1 RETURNING last_token',
        [t.date],
      )
    ).rows[0].last_token;
    const total = lines.reduce((n, l) => n + l.quantity * 100, 0).toFixed(2);
    const hash = createHash('sha256')
      .update(
        JSON.stringify(
          lines.map((l) => ({ ...l, instruction: l.instruction ?? '' })),
        ),
      )
      .digest('hex');
    await sql.query(
      "INSERT INTO orders(id,source,status,business_date,token_number,confirmed_by,request_id,request_hash,queued_at,subtotal,tax_total,grand_total,tax_rate,tax_label,timezone,tax_mode,tax_rounding) VALUES($1,'COUNTER','QUEUED',$2,$3,$4,$5,$6,$7,$8,0,$8,0,'Tax','Asia/Kolkata','EXCLUSIVE','HALF_UP_PAISE')",
      [id, t.date, token, actor, requestId, hash, t.time, total],
    );
    for (const [index, l] of lines.entries())
      await sql.query(
        "INSERT INTO order_items(id,order_id,position,menu_item_id,variant_id,item_name_snapshot,kitchen_name_snapshot,variant_name_snapshot,quantity,unit_price_snapshot,line_subtotal,instruction) SELECT $1,$2,$3,i.id,v.id,i.name,coalesce(nullif(i.kitchen_name,''),i.name),v.name,$4,100,100*$4,$5 FROM item_variants v JOIN menu_items i ON i.id=v.menu_item_id WHERE v.id=$6",
        [
          randomUUID(),
          id,
          index + 1,
          l.quantity,
          l.instruction ?? '',
          l.variantId,
        ],
      );
    await sql.query(
      "INSERT INTO order_status_history VALUES($1,$2,'DRAFT','QUEUED',$3,$4,'Counter confirmation')",
      [randomUUID(), id, actor, t.time],
    );
    await sql.query('COMMIT');
    return { id, tokenNumber: token, businessDate: t.date, grandTotal: total };
  } catch (e) {
    await sql.query('ROLLBACK');
    throw e;
  }
};
