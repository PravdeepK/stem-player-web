import { useEffect, useRef, useState } from "react";
import type { FeedbackType } from "@stem-player-web/core";

export interface HelpButtonProps {
  onFeedback: (type: FeedbackType) => void;
}

// The "?" in the bottom-right corner, opening a small menu of the feedback forms.

const ITEMS: { type: FeedbackType; label: string; path: string }[] = [
  {
    type: "bug",
    label: "Report a bug",
    path: "M8 2l1.9 1.9M16 2l-1.9 1.9M9 7.1V6a3 3 0 1 1 6 0v1.1M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6ZM12 20v-9M6.5 9C4.6 8.8 3 7.2 3 5.2M6 13H2M3 21c0-2.1 1.7-3.9 3.8-4M20.97 5c0 2.1-1.6 3.8-3.5 4M22 13h-4M17.2 17c2.1.1 3.8 1.9 3.8 4",
  },
  {
    type: "feature",
    label: "Request a feature",
    path: "M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5M9 18h6M10 22h4",
  },
];

export default function HelpButton({ onFeedback }: HelpButtonProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const firstItemRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    firstItemRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        toggleRef.current?.focus();
      }
    };
    // Capture, so a press on the device still closes the menu.
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer, true);
    };
  }, [open]);

  function choose(type: FeedbackType) {
    setOpen(false);
    onFeedback(type);
  }

  return (
    <div className="help" ref={rootRef}>
      {open && (
        <div id="help-menu" className="help-menu" role="menu" aria-label="Help and feedback">
          {ITEMS.map((item, i) => (
            <button
              key={item.type}
              ref={i === 0 ? firstItemRef : undefined}
              className="help-item"
              role="menuitem"
              onClick={() => choose(item.type)}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d={item.path} />
              </svg>
              <span className="help-item-label">{item.label}</span>
            </button>
          ))}
        </div>
      )}
      <button
        ref={toggleRef}
        className={`help-toggle ${open ? "help-toggle--open" : ""}`}
        aria-label="Help and feedback"
        title="Help and feedback"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="help-menu"
        onClick={() => setOpen((o) => !o)}
      >
        ?
      </button>
    </div>
  );
}
