/**
 * The two sign-in pages share one frame and one flow.
 *
 * AuthShell: a black Beharry panel beside the form; on a phone the panel
 * shrinks to a short header above it. EmailCodeSignIn: email, then the
 * 6-digit code sent to it, with a countdown, a resend and "use another email".
 * Employees and admins differ only in the words and the API they call.
 */
import { useState, type FormEvent, type ReactNode } from "react";
import { Link } from "wouter";
import { ApiError, type SentOtp } from "./api";
import { Alert, OtpInput, mmss, useNow } from "./ui";

export function AuthShell({ aside, compactAside, children }: { aside: ReactNode; compactAside: ReactNode; children: ReactNode }) {
  return (
    <div className="grid min-h-screen bg-card lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
      {/* The brand panel: full on a wide screen, a short header on a phone. */}
      <aside className="relative overflow-hidden bg-brand-deep text-white">
        <div aria-hidden="true" className="pointer-events-none absolute -bottom-24 -right-24 h-96 w-96 rounded-full bg-brand/30 blur-3xl" />
        <div aria-hidden="true" className="pointer-events-none absolute -left-20 -top-20 h-72 w-72 rounded-full bg-brand/15 blur-3xl" />
        <div className="relative hidden h-full flex-col justify-between gap-10 p-10 lg:flex xl:p-14">{aside}</div>
        <div className="relative flex flex-col gap-3 px-5 py-6 lg:hidden">{compactAside}</div>
      </aside>
      <main className="flex min-w-0 items-start justify-center px-5 py-10 sm:px-8 lg:items-center lg:py-16">
        <div className="w-full max-w-[26rem]">{children}</div>
      </main>
    </div>
  );
}

/** The white Beharry logo and the product name, for the black panel. */
export function PanelLogo({ admin = false }: { admin?: boolean }) {
  return (
    <Link href={admin ? "/admin/signin" : "/"} className="flex items-center gap-3 self-start rounded-lg" aria-label={admin ? "Admin sign in" : "Beharry Staff Discounts, home"}>
      <img src="/logos/beharry-white.png" alt="Beharry" className="h-10 w-auto" width={105} height={40} />
      <span aria-hidden="true" className="h-8 w-px bg-white/30" />
      <span className="font-display text-[16px] font-bold leading-[1.1]">
        Staff Discounts
        {admin && (
          <>
            <br />
            <span className="text-brand">Admin</span>
          </>
        )}
      </span>
    </Link>
  );
}

const MailIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="5" width="18" height="14" rx="2.5" />
    <path d="m4 7 8 6 8-6" />
  </svg>
);

export function LockIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

export interface EmailCodeCopy {
  eyebrow: string;
  title: string;
  intro: ReactNode;
  emailLabel: string;
  placeholder: string;
  sendLabel: string;
  /** Under the form on the first step: where to turn when it does not work. */
  help: ReactNode;
}

export function EmailCodeSignIn({
  copy,
  start,
  verify,
  onSignedIn,
  idPrefix,
}: {
  copy: EmailCodeCopy;
  start: (email: string) => Promise<SentOtp>;
  verify: (challengeId: string, code: string) => Promise<unknown>;
  onSignedIn: () => void;
  idPrefix: string;
}) {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState<(SentOtp & { sentAt: number }) | null>(null);
  const [otp, setOtp] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = useNow(sent != null);
  const message = (err: unknown) => (err instanceof ApiError ? err.message : "Something went wrong. Check your connection and try again.");

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setSent({ ...(await start(email.trim())), sentAt: Date.now() });
      setOtp("");
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  const check = async (code: string) => {
    if (!sent || code.length !== 6 || busy) return;
    setBusy(true);
    setError(null);
    try {
      await verify(sent.challengeId, code);
      onSignedIn();
    } catch (err) {
      setError(message(err));
      setOtp("");
      setBusy(false);
    }
  };

  const resendIn = sent ? Math.ceil((sent.sentAt + sent.resendAfterSeconds * 1000 - Math.max(now, sent.sentAt)) / 1000) : 0;
  const expiresIn = sent ? new Date(sent.expiresAt).getTime() - now : 0;

  return (
    <div className="flex flex-col gap-7">
      {/* Where you are in two steps. */}
      <ol aria-label="Sign-in steps" className="flex items-center gap-2 text-sm font-semibold">
        {["Your email", "Your code"].map((label, i) => {
          const state = (sent ? 1 : 0) === i ? "current" : (sent ? 1 : 0) > i ? "done" : "next";
          return (
            <li key={label} className="flex items-center gap-2" aria-current={state === "current" ? "step" : undefined}>
              {i > 0 && <span aria-hidden="true" className={`h-px w-6 ${state === "next" ? "bg-line" : "bg-ink"}`} />}
              <span
                aria-hidden="true"
                className={`grid h-6 w-6 place-items-center rounded-full text-xs font-bold ${state === "next" ? "bg-paper text-muted ring-1 ring-line" : "bg-ink text-white"}`}
              >
                {state === "done" ? "✓" : i + 1}
              </span>
              <span className={state === "next" ? "text-muted" : "text-ink"}>{label}</span>
            </li>
          );
        })}
      </ol>

      {!sent ? (
        <form onSubmit={send} className="flex flex-col gap-6" noValidate>
          <div className="flex flex-col gap-2">
            <span className="eyebrow">{copy.eyebrow}</span>
            <h1 className="text-[2.1rem] font-extrabold">{copy.title}</h1>
            <p className="text-muted">{copy.intro}</p>
          </div>
          <div className="flex flex-col gap-2">
            <label htmlFor={`${idPrefix}-email`} className="text-sm font-semibold">
              {copy.emailLabel}
            </label>
            <div className="flex items-center gap-2 rounded-xl border border-line bg-card px-4 transition-colors focus-within:border-ink">
              <span className="text-muted">
                <MailIcon />
              </span>
              <input
                id={`${idPrefix}-email`}
                type="email"
                inputMode="email"
                autoComplete="email"
                autoFocus
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={copy.placeholder}
                className="min-h-[52px] w-full min-w-0 bg-transparent text-ink outline-none placeholder:text-muted/60"
              />
            </div>
          </div>
          {error && <Alert>{error}</Alert>}
          <button type="submit" className="btn-primary w-full text-[16px]" disabled={busy || !/^\S+@\S+\.\S+$/.test(email.trim())}>
            {busy ? "Sending your code…" : copy.sendLabel}
            {!busy && <span aria-hidden="true">→</span>}
          </button>
          <p className="flex items-start gap-2 text-sm text-muted">
            <LockIcon className="mt-0.5 h-4 w-4 shrink-0" />
            <span>No password. We email you a one-time code that works for 5 minutes.</span>
          </p>
          <div className="border-t border-line pt-5 text-sm text-muted">{copy.help}</div>
        </form>
      ) : (
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <span aria-hidden="true" className="mb-1 grid h-12 w-12 place-items-center rounded-2xl bg-brand-soft text-brand">
              <MailIcon />
            </span>
            <h1 className="text-[2.1rem] font-extrabold">Check your email</h1>
            <p className="text-muted">
              We sent a 6-digit code to <b className="font-semibold text-ink">{sent.maskedEmail}</b>.{" "}
              {expiresIn > 0 ? (
                <>
                  It works for <span className="tnum font-semibold text-ink">{mmss(expiresIn)}</span>.
                </>
              ) : (
                "It has expired; send a new one."
              )}
            </p>
          </div>
          {sent.devCode && (
            <Alert tone="info">
              Development mode: your code is <b className="font-mono">{sent.devCode}</b>
            </Alert>
          )}
          <OtpInput id={`${idPrefix}-otp`} value={otp} onChange={setOtp} onComplete={check} disabled={busy} />
          {error && <Alert>{error}</Alert>}
          <button type="button" className="btn-primary w-full text-[16px]" disabled={busy || otp.length !== 6} onClick={() => check(otp)}>
            {busy ? "Signing you in…" : "Sign in"}
          </button>
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
            <button type="button" className="font-semibold text-ink underline-offset-4 hover:underline disabled:text-muted disabled:no-underline" disabled={resendIn > 0 || busy} onClick={() => send()}>
              {resendIn > 0 ? `Send a new code in ${resendIn}s` : "Send a new code"}
            </button>
            <button
              type="button"
              className="text-muted underline-offset-4 hover:text-ink hover:underline"
              onClick={() => {
                setSent(null);
                setError(null);
                setOtp("");
              }}
            >
              Use a different email
            </button>
          </div>
          <p className="text-sm text-muted">Can't find it? Check your spam or junk folder. The email comes from Beharry Staff Discounts.</p>
        </div>
      )}
    </div>
  );
}
