// Explicit release-specific privileges; rerun after reviewed migrations.
// Never grant ownership, TRUNCATE, TRIGGER, schema CREATE or role membership.
export const identifier = (value) => {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value || ''))
    throw new Error('Invalid database identifier');
  return `"${value}"`;
};
export async function grantRuntime(client, schema, role) {
  const s = identifier(schema),
    r = identifier(role);
  await client.query(`REVOKE ALL ON SCHEMA ${s} FROM PUBLIC,${r}`);
  await client.query(`GRANT USAGE ON SCHEMA ${s} TO ${r}`);
  await client.query(
    `REVOKE ALL ON ALL TABLES IN SCHEMA ${s} FROM PUBLIC,${r}`,
  );
  await client.query(
    `REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${s} FROM PUBLIC,${r}`,
  );
  await client.query(
    `REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${s} FROM PUBLIC,${r}`,
  );
  await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${s} TO ${r}`);
  await client.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${s} TO ${r}`);
  const tables = (names) =>
    names
      .split(' ')
      .map((n) => `${s}.${identifier(n)}`)
      .join(',');
  await client.query(
    `GRANT INSERT ON ${tables('platform_order_cancellations users user_roles auth_sessions login_attempts user_audit menu_categories menu_items item_variants variant_channel_settings menu_audit menu_images order_daily_tokens orders order_items order_status_history bill_daily_numbers bills payments bill_reminders kitchen_timers order_amendments order_item_revisions expense_categories expense_category_audit expense_receipts expenses daily_reports daily_report_settings_audit report_deliveries report_delivery_attempts report_delivery_actions')} TO ${r}`,
  );
  await client.query(
    `GRANT UPDATE ON ${tables('users auth_sessions login_attempts menu_categories menu_items item_variants variant_channel_settings order_daily_tokens orders bill_daily_numbers bills bill_reminders kitchen_timers expense_categories expenses daily_report_settings report_deliveries')} TO ${r}`,
  );
  await client.query(
    `GRANT DELETE ON ${tables('user_roles auth_sessions login_attempts menu_images expense_receipts')} TO ${r}`,
  );
  for (const table of ['menu_images', 'expense_receipts'])
    await client.query(
      `GRANT UPDATE(key) ON ${s}.${identifier(table)} TO ${r}`,
    ); // SELECT FOR UPDATE staging locks
  // Current release uses UUIDs and explicit numeric allocator tables, no sequences.
}
