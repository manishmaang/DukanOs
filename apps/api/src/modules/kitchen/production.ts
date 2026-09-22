import type { KitchenOrder, ProductionGroup } from '@dukanos/shared-types';
/** Inputs are FIFO ordered. Map insertion order preserves earliest-source urgency. */
export function aggregateProduction(orders: KitchenOrder[]): ProductionGroup[] {
  const groups = new Map<string, ProductionGroup>();
  for (const order of orders) {
    for (const line of order.items) {
      // IDs separate different products with identical labels. Snapshots separate
      // renamed versions of a product; current Menu data is never consulted.
      const key = JSON.stringify([
        line.menuItemId,
        line.variantId,
        line.itemName,
        line.kitchenName,
        line.variantName,
      ]);
      let group = groups.get(key);
      if (!group) {
        group = {
          key,
          itemName: line.itemName,
          kitchenName: line.kitchenName,
          variantName: line.variantName,
          totalQuantity: 0,
          earliestQueuedAt: order.queuedAt,
          sources: [],
        };
        groups.set(key, group);
      }
      group.totalQuantity += line.quantity;
      group.sources.push({
        orderId: order.orderId,
        lineId: line.id,
        businessDate: order.businessDate,
        tokenNumber: order.tokenNumber,
        quantity: line.quantity,
        instruction: line.instruction,
        queuedAt: order.queuedAt,
      });
    }
  }
  return [...groups.values()];
}
