export function previousDayCleanupTime(env: NodeJS.ProcessEnv = process.env) {
  const time = env.PREVIOUS_DAY_ORDER_CLEANUP_TIME ?? '05:00';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time))
    throw new Error(
      'PREVIOUS_DAY_ORDER_CLEANUP_TIME must be HH:MM (00:00–23:59)',
    );
  return time;
}
