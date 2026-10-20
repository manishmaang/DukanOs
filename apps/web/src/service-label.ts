import type { ServiceType } from '@dukanos/shared-types';
export function serviceLabel(type: ServiceType | null | undefined): string {
  return type === 'DINE_IN'
    ? 'DINE IN'
    : type === 'TAKEAWAY'
      ? 'PARCEL'
      : 'Legacy · service unknown';
}
