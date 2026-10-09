import type { ServingSnapshot } from '@dukanos/shared-types';
export function ServingLabel({
  serving,
}: {
  serving?: ServingSnapshot | null;
}) {
  return serving ? (
    <p className="serving-label">
      <strong>{serving.mode}</strong> · {serving.amount.replace(/\.00$/, '')}{' '}
      {serving.unit} each
    </p>
  ) : null;
}
export function SourceLabel({
  source,
  reference,
}: {
  source: string;
  reference?: string | null;
}) {
  return (
    <div className="order-source">
      <strong>{source}</strong>
      {reference && <span>Platform #{reference}</span>}
    </div>
  );
}
