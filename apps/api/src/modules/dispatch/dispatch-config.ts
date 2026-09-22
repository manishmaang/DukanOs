import { orderConfiguration } from '../orders/order-policy';
export function dispatchConfiguration(env: NodeJS.ProcessEnv = process.env) {
  const value = env.DISPATCH_LATE_THRESHOLD_MINUTES ?? '5';
  if (!/^[1-9]\d{0,3}$/.test(value) || Number(value) > 1440)
    throw new Error(
      'DISPATCH_LATE_THRESHOLD_MINUTES must be an integer from 1 to 1440',
    );
  return {
    lateThresholdMinutes: Number(value),
    timezone: orderConfiguration(env).timezone,
  };
}
