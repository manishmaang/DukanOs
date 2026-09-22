import type { ProductionSource } from '@dukanos/shared-types';
/** Conservative presentation normalization: whitespace only; case and punctuation remain significant. */
export function instructionBreakdown(sources: ProductionSource[]) {
  const groups = new Map<string, number>();
  for (const source of sources) {
    const instruction = source.instruction.trim().replace(/\s+/g, ' ');
    groups.set(instruction, (groups.get(instruction) ?? 0) + source.quantity);
  }
  if (groups.size === 1 && groups.has('')) return [];
  return [...groups].map(([instruction, quantity]) => ({
    instruction,
    quantity,
  }));
}
export function isLate(
  queuedAt: string,
  now: number,
  thresholdMinutes: number,
) {
  return now - Date.parse(queuedAt) >= thresholdMinutes * 60000;
}
