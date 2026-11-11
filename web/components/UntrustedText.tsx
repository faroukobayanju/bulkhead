"use client";
// Player messages and model replies. Rendered as React text only: no markdown, no HTML, no links, so nothing in them can run or
// navigate. Long text is cut at 280 characters behind "Show more".
import { useId, useState } from "react";

export const CUT = 280;

export function UntrustedText({ text, label }: { text: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const long = text.length > CUT;
  // Array.from counts code points, so a cut never splits an emoji or a surrogate pair.
  const shown = long && !open ? Array.from(text).slice(0, CUT).join("") + "…" : text;
  return (
    <div>
      <p id={id} className="quote" data-untrusted aria-label={label}>
        {shown}
      </p>
      {long && (
        <button type="button" className="linkbtn small" aria-controls={id} aria-expanded={open} onClick={() => setOpen(o => !o)}>
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}
