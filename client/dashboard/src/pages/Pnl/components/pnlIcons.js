import { useEffect, useRef } from "react";

// Stroke icons used across the P&L page (24x24 viewBox paths).
export const ICONS = {
  chevDown: "M6 9l6 6 6-6",
  chevRight: "M9 6l6 6-6 6",
  close: "M6 6l12 12M18 6L6 18",
  check: "M5 12l5 5 9-10",
  warn: "M12 4l9 16H3zM12 10v4M12 17v.5",
  info: "M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18zM12 11v5M12 7.5v.5",
  pen: "M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4",
  download: "M12 4v11M7 11l5 5 5-5M5 20h14",
  upload: "M12 16V5M7 9l5-5 5 5M5 20h14",
  refresh: "M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7",
};

// Closes a popover on an outside click or Escape.
export function useDismiss(open, onClose) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event) => {
      if (ref.current && !ref.current.contains(event.target)) onClose();
    };
    const onKey = (event) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);
  return ref;
}
