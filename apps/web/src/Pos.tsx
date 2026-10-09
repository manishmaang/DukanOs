import { useState, type ComponentProps } from 'react';
import { MenuPreview } from './MenuPreview';
import { PlatformPos } from './PlatformPos';
import type { OrderSource } from '@dukanos/shared-types';
export function Pos({
  canCreatePlatform = false,
  canReadPlatform = false,
  canCancelPlatform = false,
  ...counter
}: ComponentProps<typeof MenuPreview> & {
  canCreatePlatform?: boolean;
  canReadPlatform?: boolean;
  canCancelPlatform?: boolean;
}) {
  const [source, setSource] = useState<OrderSource>('COUNTER');
  const [dirty, setDirty] = useState(false);
  return (
    <>
      <nav className="pos-sources" aria-label="Order source">
        {(['COUNTER', 'ZOMATO', 'SWIGGY'] as const)
          .filter((s) => s === 'COUNTER' || canCreatePlatform)
          .map((s) => (
            <button
              key={s}
              aria-pressed={source === s}
              disabled={dirty && s !== source}
              onClick={() => setSource(s)}
            >
              {s === 'COUNTER'
                ? 'Counter'
                : s === 'ZOMATO'
                  ? 'Zomato'
                  : 'Swiggy'}
            </button>
          ))}
      </nav>
      {dirty && (
        <p className="menu-muted">
          Finish or clear the current draft before switching source.
        </p>
      )}
      {source === 'COUNTER' ? (
        <MenuPreview {...counter} onDraftStateChange={setDirty} />
      ) : (
        <PlatformPos
          key={source}
          source={source}
          userId={counter.userId}
          canRead={canReadPlatform}
          canCancel={canCancelPlatform}
          onDraftStateChange={setDirty}
        />
      )}
    </>
  );
}
