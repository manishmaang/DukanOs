import { useState } from 'react';
export function MenuPhoto({ src, name }: { src?: string; name: string }) {
  const [failed, setFailed] = useState<string>();
  return src && failed !== src ? (
    <img
      className="menu-photo"
      src={src}
      alt={name}
      loading="lazy"
      onError={() => setFailed(src)}
    />
  ) : (
    <span
      className="menu-photo menu-photo-placeholder"
      role="img"
      aria-label={`${name}: no photo`}
    >
      <svg viewBox="0 0 100 80" aria-hidden="true">
        <circle cx="50" cy="40" r="26" />
        <circle cx="50" cy="40" r="19" />
        <path d="M12 15v20q0 6 5 6v24M22 15v20M17 15v20M84 15v50M84 15q-10 10-10 25h10" />
      </svg>
    </span>
  );
}
