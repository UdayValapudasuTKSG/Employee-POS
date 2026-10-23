import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { api, gydShort, type Terms } from "../api";
import { AuthShell, EmailCodeSignIn, PanelLogo } from "../auth";
import { StoreStrip } from "../ui";

const FALLBACK: Pick<Terms, "percent" | "samePercent" | "monthlyCap" | "stores"> = {
  percent: 10,
  samePercent: true,
  monthlyCap: 15000,
  stores: [
    { id: "KFC", name: "KFC", percent: 10 },
    { id: "PIZZA_HUT", name: "Pizza Hut", percent: 10 },
    { id: "STERLING", name: "Sterling", percent: 10 },
    { id: "BEHARRY", name: "Edward B. Beharry & Co.", percent: 10 },
  ],
};

export function SignIn() {
  const [, navigate] = useLocation();
  const [terms, setTerms] = useState(FALLBACK);

  useEffect(() => {
    // Already signed in: straight to the code.
    api.me().then(() => navigate("/app")).catch(() => undefined);
    api.terms().then(setTerms).catch(() => undefined);
  }, [navigate]);

  const headline = terms.samePercent ? `${terms.percent}% off` : `Up to ${terms.percent}% off`;

  return (
    <AuthShell
      aside={
        <>
          <PanelLogo />
          <div className="flex max-w-lg flex-col gap-6">
            <span className="text-xs font-bold uppercase tracking-[0.16em] text-white/60">For Beharry Group employees</span>
            <h2 className="text-[clamp(2.4rem,3.6vw,3.4rem)] font-extrabold leading-[1.02]">
              Your staff discount is <span className="text-brand">one code</span> away.
            </h2>
            <ol className="flex flex-col gap-4">
              {[
                ["Sign in", "with the email your employer has on file."],
                ["Get your code", "confirmed with a second emailed code."],
                ["Show it at the counter", `for ${headline.toLowerCase()} your bill, up to ${gydShort(terms.monthlyCap)} a month.`],
              ].map(([t, d], i) => (
                <li key={t} className="flex items-start gap-4">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brand font-display text-sm font-extrabold">{i + 1}</span>
                  <p className="pt-1 text-white/75">
                    <b className="font-semibold text-white">{t}</b> {d}
                  </p>
                </li>
              ))}
            </ol>
          </div>
          <div className="flex flex-col gap-3">
            <span className="text-xs font-bold uppercase tracking-[0.16em] text-white/60">One code, any of</span>
            <StoreStrip stores={terms.stores} size={54} label="Participating stores" />
          </div>
        </>
      }
      compactAside={
        <>
          <PanelLogo />
          <p className="text-white/75">
            Your staff discount, one code away: {headline.toLowerCase()} at our stores.
          </p>
        </>
      }
    >
      <EmailCodeSignIn
        idPrefix="signin"
        copy={{
          eyebrow: "Staff discounts",
          title: "Sign in",
          intro: "Enter your work email and we'll send you a 6-digit code.",
          emailLabel: "Work email",
          placeholder: "name@beharrygroup.com",
          sendLabel: "Email me a code",
          help: (
            <>
              <b className="font-semibold text-ink">Email not found?</b> Use the one your employer has on file. If it still doesn't work,
              contact your HR department. <Link href="/" className="font-semibold text-ink underline underline-offset-4">Back to home</Link>
            </>
          ),
        }}
        start={api.startSignIn}
        verify={api.verifySignIn}
        onSignedIn={() => navigate("/app")}
      />
    </AuthShell>
  );
}
