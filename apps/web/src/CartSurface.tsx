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
