import { orderConfiguration } from '../orders/order-policy';
export function kitchenConfiguration(env: NodeJS.ProcessEnv = process.env) {
  const value = env.KITCHEN_LATE_THRESHOLD_MINUTES ?? '15';
  if (!/^[1-9]\d{0,3}$/.test(value) || Number(value) > 1440)
    throw new Error(
      'KITCHEN_LATE_THRESHOLD_MINUTES must be an integer from 1 to 1440',
    );
  return {
    lateThresholdMinutes: Number(value),
    timezone: orderConfiguration(env).timezone,
  };
}
