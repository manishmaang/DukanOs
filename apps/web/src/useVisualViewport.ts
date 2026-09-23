import { useEffect } from 'react';
/** Track the visible keyboard-safe region without changing any form or order state. */
export function useVisualViewport() {
  useEffect(() => {
    const viewport = window.visualViewport;
    const root = document.documentElement;
    function update() {
      root.style.setProperty(
        '--usable-height',
        `${viewport?.height ?? innerHeight}px`,
      );
      root.style.setProperty('--visual-top', `${viewport?.offsetTop ?? 0}px`);
      root.classList.toggle(
        'keyboard-open',
        !!viewport && innerHeight - viewport.height > 100,
      );
    }
    update();
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    return () => {
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      root.style.removeProperty('--usable-height');
      root.style.removeProperty('--visual-top');
      root.classList.remove('keyboard-open');
    };
  }, []);
}
