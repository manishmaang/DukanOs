import { useEffect, useRef, type ReactNode } from 'react';
/** One live cart: nonmodal on wide screens, focus-managed dialog on small screens. */
export function CartSurface({
  children,
  open,
  setOpen,
  summary,
}: {
  children: ReactNode;
  open: boolean;
  setOpen: (open: boolean) => void;
  summary: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const media = matchMedia('(max-width: 899px)');
    const modal = dialog.current!;
    const update = () => {
      modal.close();
      if (!media.matches) modal.show();
      else if (open) modal.showModal();
    };
    update();
    media.addEventListener('change', update);
    return () => {
      media.removeEventListener('change', update);
      modal.close();
    };
  }, [open]);
  useEffect(() => {
    const container = dialog.current!;
    const update = () => {
      const cart = container.querySelector<HTMLElement>('.order-cart');
      if (!cart) return;
      if (innerWidth < 900) {
        cart.style.removeProperty('--cart-available-height');
        return;
      }
      const top = Math.max(16, cart.getBoundingClientRect().top);
      cart.style.setProperty(
        '--cart-available-height',
        `${Math.max(260, innerHeight - top - 16)}px`,
      );
    };
    const observer = new ResizeObserver(update);
    observer.observe(container.closest('.layout') ?? document.body);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, { passive: true });
    update();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update);
    };
  }, []);
  function close() {
    dialog.current?.close();
    setOpen(false);
    trigger.current?.focus();
  }
  return (
    <>
      <button
        ref={trigger}
        className="mobile-order-trigger"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
      >
        <span>{summary}</span>
        <strong>View Order</strong>
      </button>
      <dialog
        ref={dialog}
        className="cart-dialog"
        aria-label="Current order"
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
      >
        <button className="cart-back" onClick={close}>
          Back to dishes
        </button>
        {children}
      </dialog>
    </>
  );
}
