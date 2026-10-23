import { useEffect } from "react";
import { useLocation } from "wouter";
import { AuthShell, EmailCodeSignIn, LockIcon, PanelLogo } from "../auth";
import { adminApi } from "./adminApi";

/** A small drawing of the dashboard's bars: decoration, not data. */
function BarsMotif() {
  const heights = [34, 52, 40, 66, 58, 80, 72, 96];
  return (
    <div aria-hidden="true" className="flex h-24 items-end gap-2">
      {heights.map((h, i) => (
        <span key={i} className={`w-5 rounded-t ${i === heights.length - 1 ? "bg-brand" : "bg-white/20"}`} style={{ height: `${h}%` }} />
      ))}
    </div>
  );
}

const SECTIONS = [
  ["Dashboard", "Savings by day, store and month; who uses it and when."],
  ["Discounts", "Each partner's percentage, its own monthly limit, and on or off."],
  ["Employees", "Add staff, and deactivate anyone who has left."],
] as const;

export function AdminSignIn() {
  const [, navigate] = useLocation();

  useEffect(() => {
    adminApi.me().then(() => navigate("/admin")).catch(() => undefined);
  }, [navigate]);

  return (
    <AuthShell
      aside={
        <>
          <PanelLogo admin />
          <div className="flex max-w-lg flex-col gap-7">
            <BarsMotif />
            <h2 className="text-[clamp(2.3rem,3.4vw,3.2rem)] font-extrabold leading-[1.04]">
              Run the staff discount <span className="text-brand">programme</span>.
            </h2>
            <ul className="flex flex-col divide-y divide-white/10 border-y border-white/10">
              {SECTIONS.map(([t, d]) => (
                <li key={t} className="grid grid-cols-[7rem_1fr] gap-4 py-3.5">
                  <span className="font-display font-bold">{t}</span>
                  <span className="text-white/70">{d}</span>
                </li>
              ))}
            </ul>
          </div>
          <p className="flex max-w-md items-start gap-2 text-sm text-white/60">
            <LockIcon className="mt-0.5 h-4 w-4 shrink-0" />
            <span>Only addresses on the server's admin list can sign in. Every change you make is recorded with your name.</span>
          </p>
        </>
      }
      compactAside={
        <>
          <PanelLogo admin />
          <p className="text-white/75">Discounts, employees and figures for the staff discount programme.</p>
        </>
      }
    >
      <EmailCodeSignIn
        idPrefix="admin"
        copy={{
          eyebrow: "Admin portal",
          title: "Admin sign in",
          intro: "For people on the admin list. We'll email you a 6-digit code.",
          emailLabel: "Email",
          placeholder: "you@beharrygroup.com",
          sendLabel: "Email me a code",
          help: (
            <>
              <b className="font-semibold text-ink">Not on the list?</b> Whoever runs the server adds admins in <code className="rounded bg-paper px-1.5 py-0.5 text-[13px] text-ink">ADMIN_EMAILS</code>.
              Looking for your own discount? <a href="/signin" className="font-semibold text-ink underline underline-offset-4">Employee sign in</a>
            </>
          ),
        }}
        start={adminApi.start}
        verify={adminApi.verify}
        onSignedIn={() => navigate("/admin")}
      />
    </AuthShell>
  );
}
