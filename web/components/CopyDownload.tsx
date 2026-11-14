"use client";
import { Copy, DownloadSimple } from "@phosphor-icons/react/ssr";
import { useState } from "react";

// Saves `data` as a JSON file, built in the browser from what the page already holds.
export function DownloadJson({ data, name, label }: { data: unknown; name: string; label: string }) {
  return (
    <button
      type="button"
      className="btn ghost"
      onClick={() => {
        const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
        const a = Object.assign(document.createElement("a"), { href: url, download: name });
        a.click();
        URL.revokeObjectURL(url);
      }}
    >
      <DownloadSimple size={16} aria-hidden="true" /> {label}
    </button>
  );
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn ghost"
      onClick={async () => {
        await navigator.clipboard.writeText(text).catch(() => {});
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      <Copy size={16} aria-hidden="true" /> {done ? "Copied" : label}
    </button>
  );
}
