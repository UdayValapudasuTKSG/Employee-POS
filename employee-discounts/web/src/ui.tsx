/** Small shared pieces of the interface. */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "wouter";
import type { StoreId } from "./api";

/** The Beharry logo with the product name beside it. `light` is for dark backgrounds. */
export function Logo({ light = false }: { light?: boolean }) {
  return (
    <Link href="/" className="flex items-center gap-3 rounded-lg" aria-label="Beharry Staff Discounts, home">
      <img
        src={light ? "/logos/beharry-white.png" : "/logos/beharry.png"}
        alt="Beharry"
        className="h-9 w-auto sm:h-10"
        width={105}
        height={40}
      />
      <span aria-hidden="true" className={`h-7 w-px ${light ? "bg-white/30" : "bg-line"}`} />
      <span className={`font-display text-[15px] font-bold leading-[1.1] tracking-tight sm:text-[16px] ${light ? "text-white" : "text-ink"}`}>
        Staff
        <br />
        Discounts
      </span>
    </Link>
  );
}

/**
 * The stores' own logos (web/public/logos, see SOURCES.md). `mark` is the
 * square form for small places; `full` the wide one. Edward B. Beharry & Co.
 * uses the Beharry mark: it has no separate logo.
 */
const LOGOS: Record<StoreId, { mark: string; full: string; kind: string }> = {
  KFC: { mark: "/logos/kfc.svg", full: "/logos/kfc.svg", kind: "Restaurants" },
  PIZZA_HUT: { mark: "/logos/pizza-hut.svg", full: "/logos/pizza-hut.svg", kind: "Restaurants" },
  STERLING: { mark: "/logos/sterling-mark.png", full: "/logos/sterling.png", kind: "Products" },
  BEHARRY: { mark: "/logos/beharry-mark.png", full: "/logos/beharry-mark.png", kind: "Stores" },
};
export const storeKind = (store: StoreId) => LOGOS[store].kind;

/** A store's square mark on a white tile. Decorative: the store's name is always written beside it. */
export function StoreMark({ store, size = 44 }: { store: StoreId; size?: number }) {
  return (
    <span
      aria-hidden="true"
      className="inline-grid shrink-0 place-items-center rounded-xl border border-line bg-white"
      style={{ width: size, height: size, padding: Math.round(size * 0.14) }}
    >
      <img src={LOGOS[store].mark} alt="" className="h-full w-full object-contain" />
    </span>
  );
}

/** A store's full logo, contained in a box of the given height. */
export function StoreLogo({ store, name, height = 48, className = "" }: { store: StoreId; name: string; height?: number; className?: string }) {
  return <img src={LOGOS[store].full} alt={name} className={`w-auto max-w-full object-contain ${className}`} style={{ height }} />;
}

/** The four logos in a row, each on a white chip, labelled for screen readers. */
export function StoreStrip({ stores, size = 40, label = "Participating stores" }: { stores: readonly { id: StoreId; name: string }[]; size?: number; label?: string }) {
  return (
    <ul aria-label={label} className="flex flex-wrap items-center gap-2">
      {stores.map((s) => (
        <li key={s.id} title={s.name}>
          <StoreMark store={s.id} size={size} />
          <span className="sr-only">{s.name}</span>
        </li>
      ))}
    </ul>
  );
}

/** One box per digit; typing, pasting and the phone's one-time-code fill all work. */
export function OtpInput({
  value,
  onChange,
  onComplete,
  disabled,
  id,
}: {
  value: string;
  onChange: (v: string) => void;
  onComplete?: (v: string) => void;
  disabled?: boolean;
  id: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div className="relative mx-auto w-full max-w-[22rem]" onClick={() => ref.current?.focus()}>
      <input
        ref={ref}
        id={id}
        value={value}
        disabled={disabled}
        inputMode="numeric"
        autoComplete="one-time-code"
        aria-label="6-digit code"
        maxLength={6}
        onChange={(e) => {
          const v = e.target.value.replace(/\D/g, "").slice(0, 6);
          onChange(v);
          if (v.length === 6) onComplete?.(v);
        }}
        className="absolute inset-0 h-full w-full cursor-text opacity-0"
      />
      <div aria-hidden="true" className="grid grid-cols-6 gap-2">
        {Array.from({ length: 6 }, (_, i) => {
          const active = i === Math.min(value.length, 5) && !disabled;
          return (
            <span
              key={i}
              className={`grid h-14 place-items-center rounded-xl border bg-card font-mono text-2xl font-bold transition-colors ${active ? "border-ink ring-2 ring-ink/10" : "border-line"}`}
            >
              {value[i] ?? ""}
            </span>
          );
        })}
      </div>
    </div>
  );
}

export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/50 p-4 sm:items-center" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="card w-full max-w-md p-6 shadow-2xl sm:p-7"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <h2 className="text-2xl font-bold">{title}</h2>
          <button type="button" onClick={onClose} className="rounded-lg px-2 py-1 text-muted hover:text-ink" aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Re-renders every second while `on`. */
export function useNow(on = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [on]);
  return now;
}

export const mmss = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export function Alert({ tone = "danger", children }: { tone?: "danger" | "ok" | "info"; children: ReactNode }) {
  const cls = tone === "danger" ? "bg-danger-soft text-danger" : tone === "ok" ? "bg-ok-soft text-ok" : "bg-brand-soft text-brand-deep";
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={`rounded-xl px-4 py-3 text-[15px] font-medium ${cls}`}>
      {children}
    </div>
  );
}
