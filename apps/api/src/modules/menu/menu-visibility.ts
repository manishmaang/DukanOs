import type {
  MenuItem,
  MenuVisibility,
  SalesChannel,
} from '@dukanos/shared-types';
export function menuVisibility(
  item: Pick<MenuItem, 'active' | 'variants'>,
  categoryActive: boolean,
  channel: SalesChannel | undefined,
): MenuVisibility {
  const channelName = channel?.name ?? 'Counter';
  const blocked: string[] = [];
  if (!categoryActive) blocked.push('The category is inactive.');
  if (!item.active)
    blocked.push('This item is paused. Turn on Item active to show it in POS.');
  if (!channel?.active) blocked.push(`${channelName} sales are disabled.`);
  const variants = item.variants.map((v) => {
    const reasons = [...blocked];
    const setting = v.channels.find((s) => s.channelCode === channel?.code);
    if (!v.active) reasons.push('This portion is inactive.');
    if (!setting) reasons.push(`No ${channelName} price configured.`);
    else if (!setting.available)
      reasons.push(`${channelName} availability is switched off.`);
    return { id: v.id, visible: reasons.length === 0, reasons };
  });
  const visible = variants.some((v) => v.visible);
  const reasons = visible
    ? []
    : blocked.length
      ? blocked
      : !item.variants.some((v) => v.active)
        ? ['All portions are inactive.']
        : variants
            .filter((v) => item.variants.find((p) => p.id === v.id)?.active)
            .flatMap((v) =>
              v.reasons.map(
                (r) =>
                  `${item.variants.find((p) => p.id === v.id)!.name}: ${r}`,
              ),
            );
  return { visible, reasons, variants };
}
