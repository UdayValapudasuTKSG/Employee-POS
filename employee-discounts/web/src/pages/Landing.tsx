import { useEffect, useState } from "react";
import QRCode from "react-qr-code";
import { Link } from "wouter";
import { api, gyd, gydShort, type StoreId, type Terms } from "../api";
import { Logo, StoreLogo, StoreStrip, storeKind } from "../ui";

/** What the page says before the live terms arrive, and if they cannot. */
const FALLBACK: Terms = {
  percent: 10,
  samePercent: true,
  currency: "GYD",
  monthlyCap: 15000,
  codeTtlMinutes: 30,
  stores: [
    { id: "KFC", name: "KFC", percent: 10 },
    { id: "PIZZA_HUT", name: "Pizza Hut", percent: 10 },
    { id: "STERLING", name: "Sterling", percent: 10 },
    { id: "BEHARRY", name: "Edward B. Beharry & Co.", percent: 10 },
  ],
};

const SAMPLE_CODE = "K7PQ-3MZX-9TRA";

export function Landing() {
  const [terms, setTerms] = useState<Terms>(FALLBACK);
  useEffect(() => {
    api.terms().then(setTerms).catch(() => undefined);
  }, []);
  const { percent, monthlyCap, codeTtlMinutes, stores } = terms;
  // Stores can differ: say "up to" the best one, and "the store's discount" in running text.
  const headline = terms.samePercent ? `${percent}% off` : `Up to ${percent}% off`;
  const pctPhrase = terms.samePercent ? `${percent}%` : "the store's discount";
  const storeList = stores.map((s) => s.name);
  const storeSentence = `${storeList.slice(0, -1).join(", ")} and ${storeList[storeList.length - 1]}`;
  // "Edward B. Beharry & Co." already ends a sentence; don't add a second full stop.
  const ending = (s: string) => (s.endsWith(".") ? s : `${s}.`);

  return (
    <div className="min-h-screen">
      {/* Navigation */}
      <header className="sticky top-0 z-40 border-b border-line/70 bg-paper/90 backdrop-blur">
        <nav className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <Logo />
          <div className="flex items-center gap-1 sm:gap-6">
            <a href="#how" className="hidden text-[15px] font-medium text-muted hover:text-ink sm:inline">How it works</a>
            <a href="#stores" className="hidden text-[15px] font-medium text-muted hover:text-ink sm:inline">Stores</a>
            <a href="#faq" className="hidden text-[15px] font-medium text-muted hover:text-ink md:inline">Questions</a>
            <Link href="/signin" className="btn-primary min-h-11 px-4 text-[15px]">Sign in</Link>
          </div>
        </nav>
      </header>

      <main>
        {/* Hero */}
        <section className="relative overflow-hidden">
          <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 pb-16 pt-12 sm:px-6 lg:grid-cols-[1.1fr_0.9fr] lg:pb-24 lg:pt-20">
            <div className="flex min-w-0 flex-col gap-6">
              <span className="eyebrow">For Beharry Group employees</span>
              <h1 className="text-[clamp(2.6rem,6vw,4.4rem)] font-extrabold">
                One code.
                <br />
                Any of our stores.
                <br />
                <span className="relative inline-block text-brand">
                  {headline}.
                  <svg aria-hidden="true" viewBox="0 0 220 14" preserveAspectRatio="none" className="absolute -bottom-2 left-0 h-3 w-full text-ink">
                    <path d="M2 10 C 60 2, 150 2, 218 8" fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round" />
                  </svg>
                </span>
              </h1>
              <p className="max-w-[34rem] text-lg text-muted">
                Your staff discount at {ending(storeSentence)} Sign in with your work email, get your code, and show it at the
                counter. Up to {gydShort(monthlyCap)} off every month.
              </p>
              <div className="flex flex-wrap gap-3">
                <Link href="/signin" className="btn-primary px-6 text-[16px]">
                  Get my discount code
                </Link>
                <a href="#how" className="btn-ghost px-6 text-[16px]">
                  How it works
                </a>
              </div>
              <p className="text-sm text-muted">Use the email address your employer has on file. No password needed.</p>
              <div className="flex flex-col gap-2 pt-2">
                <span className="text-xs font-bold uppercase tracking-[0.14em] text-muted">Use it at</span>
                <StoreStrip stores={stores} size={52} />
              </div>
            </div>

            {/* The code, as the employee will see it */}
            <div className="relative mx-auto w-full max-w-[25rem]">
              <div aria-hidden="true" className="absolute -right-6 -top-6 h-40 w-40 rounded-full bg-brand/25 blur-2xl" />
              <div className="relative rotate-[-2deg] rounded-[28px] bg-brand-deep p-6 text-white shadow-[0_30px_60px_-20px_rgba(11,7,8,0.55)] sm:p-7">
                <div className="flex items-center justify-between">
                  <img src="/logos/beharry-white.png" alt="Beharry" className="h-8 w-auto" />
                  <span className="rounded-full bg-brand px-3 py-1 text-sm font-bold text-white">{headline}</span>
                </div>
                <div className="mt-5 flex justify-center rounded-2xl bg-white p-4">
                  <QRCode value={SAMPLE_CODE} size={168} level="M" aria-label="Example code" />
                </div>
                <p className="mt-4 text-center font-mono text-2xl font-bold tracking-[0.14em]">{SAMPLE_CODE}</p>
                <p className="mt-1 text-center text-sm text-white/70">Example. Valid for {codeTtlMinutes} minutes · one use</p>
                <div className="mt-5 flex justify-center">
                  <StoreStrip stores={stores} size={44} label="Valid at" />
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Stores */}
        <section id="stores" className="border-y border-line bg-card">
          <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <span className="eyebrow">Where it works</span>
                <h2 className="mt-2 text-3xl font-bold sm:text-4xl">Four places, one code</h2>
              </div>
              <p className="max-w-md text-muted">Your code is not tied to a store. Use it at whichever one you visit first.</p>
            </div>
            <ul className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {stores.map((s) => (
                <li key={s.id} className="card flex flex-col overflow-hidden">
                  <div className="grid h-28 place-items-center border-b border-line bg-white px-6">
                    <StoreLogo store={s.id as StoreId} name={s.name} height={s.id === "STERLING" ? 44 : 60} />
                  </div>
                  <div className="flex items-center justify-between gap-3 p-4">
                    <div className="min-w-0">
                      <p className="font-display text-lg font-bold leading-tight">{s.name}</p>
                      <p className="text-sm text-muted">{storeKind(s.id as StoreId)}</p>
                    </div>
                    <span className="shrink-0 rounded-full bg-brand-soft px-2.5 py-0.5 text-sm font-bold text-brand-dark">{s.percent}% off</span>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* How it works: a real sequence, so numbered */}
        <section id="how" className="mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:py-20">
          <span className="eyebrow">How it works</span>
          <h2 className="mt-2 text-3xl font-bold sm:text-4xl">From your phone to the till in a minute</h2>
          <ol className="mt-10 grid gap-5 md:grid-cols-3">
            {[
              { t: "Sign in", d: "Enter your work email. We email you a 6-digit code to sign in. No password to remember." },
              { t: "Get your code", d: `Tap Get my code and confirm with the code we email you. Your discount code appears with a QR code, valid for ${codeTtlMinutes} minutes.` },
              { t: "Show it at the counter", d: `The cashier scans it and ${pctPhrase} comes off your bill. The code is used up, and your allowance updates straight away.` },
            ].map((s, i) => (
              <li key={s.t} className="card relative flex flex-col gap-2 p-6">
                <span className="grid h-10 w-10 place-items-center rounded-full bg-brand font-display text-lg font-extrabold text-white">{i + 1}</span>
                <h3 className="mt-2 text-xl font-bold">{s.t}</h3>
                <p className="text-muted">{s.d}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* The allowance */}
        <section className="bg-brand-deep text-white">
          <div className="mx-auto grid max-w-6xl gap-10 px-4 py-16 sm:px-6 lg:grid-cols-2 lg:py-20">
            <div className="flex flex-col gap-4">
              <span className="text-xs font-bold uppercase tracking-[0.14em] text-accent">Your monthly allowance</span>
              <h2 className="text-4xl font-bold sm:text-5xl">
                Up to <span className="text-accent">{gydShort(monthlyCap)}</span> off, every month
              </h2>
              <p className="max-w-lg text-white/80">
                Every purchase takes {pctPhrase} off the bill, and the money you save comes out of your allowance, shared across all
                four stores. It starts again at midnight on the 1st, Guyana time.
              </p>
              <p className="max-w-lg text-white/80">
                If you have less left than {pctPhrase} of the bill would be, the cashier tells you how much you can get and asks before
                applying it.
              </p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              {[
                { title: "Plenty left", left: monthlyCap, bill: 20000 },
                { title: "Nearly used up", left: 800, bill: 10000 },
              ].map((ex) => {
                const full = (ex.bill * percent) / 100;
                const off = Math.min(full, ex.left);
                return (
                  <figure key={ex.title} className="rounded-2xl bg-white p-5 font-mono text-[14px] text-ink tnum">
                    <figcaption className="mb-3 font-sans">
                      <span className="block font-display text-lg font-bold">{ex.title}</span>
                      <span className="text-sm text-muted">{gyd(ex.left)} left this month</span>
                    </figcaption>
                    <div className="flex justify-between"><span>Bill</span><span>{gyd(ex.bill)}</span></div>
                    {off < full && <div className="flex justify-between text-muted"><span>{percent}% would be</span><span>{gyd(full)}</span></div>}
                    <div className="flex justify-between text-ok"><span>Discount</span><span>−{gyd(off)}</span></div>
                    <div className="my-2 border-t border-dashed border-line" />
                    <div className="flex justify-between font-bold"><span>You pay</span><span>{gyd(ex.bill - off)}</span></div>
                    <div className="mt-3 rounded-lg bg-brand-soft px-3 py-2 font-sans text-[13px] text-brand-deep">
                      {off < full ? "The cashier asks before applying the smaller discount." : `Left afterwards: ${gyd(ex.left - off)}`}
                    </div>
                  </figure>
                );
              })}
            </div>
          </div>
        </section>

        {/* Questions */}
        <section id="faq" className="mx-auto max-w-3xl px-4 py-16 sm:px-6 lg:py-20">
          <span className="eyebrow">Good to know</span>
          <h2 className="mt-2 text-3xl font-bold sm:text-4xl">Questions</h2>
          <div className="mt-8 divide-y divide-line border-y border-line">
            {[
              { q: "Can I have more than one code?", a: "No. You hold one code at a time, and it works once. If you get a new code, the old one stops working." },
              { q: "How long does a code last?", a: `${codeTtlMinutes} minutes from when you get it. If it runs out unused, nothing is taken from your allowance; just get a new one.` },
              { q: "Can I use it at any store?", a: `Yes: ${ending(storeSentence)} Whichever you use it at first, that is where it is used.` },
              { q: "Can someone else use my code?", a: "No. It is your staff benefit, and the cashier sees your name when they scan it and may ask for your staff ID." },
              { q: "What if my order is cancelled or refunded?", a: "The store voids the sale and the discount goes back into your allowance for that month." },
              { q: "I can't sign in.", a: "Use the work email your employer has on file. If it still isn't found, contact your HR department to check your record." },
            ].map((f) => (
              <details key={f.q} className="group py-5">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-display text-lg font-bold">
                  {f.q}
                  <span aria-hidden="true" className="text-2xl text-brand transition-transform group-open:rotate-45">+</span>
                </summary>
                <p className="mt-3 text-muted">{f.a}</p>
              </details>
            ))}
          </div>
        </section>

        {/* Closing call */}
        <section className="mx-auto max-w-6xl px-4 pb-20 sm:px-6">
          <div className="flex flex-col items-start gap-5 rounded-3xl bg-accent-soft p-8 sm:flex-row sm:items-center sm:justify-between sm:p-10">
            <div>
              <h2 className="text-3xl font-bold">Ready for your next meal or shop?</h2>
              <p className="mt-2 text-muted">Sign in and get your code before you head to the counter.</p>
            </div>
            <Link href="/signin" className="btn-primary px-6">Get my discount code</Link>
          </div>
        </section>
      </main>

      <footer className="bg-brand-deep text-white">
        <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-10 sm:px-6 md:flex-row md:items-center md:justify-between">
          <div className="flex flex-col gap-3">
            <Logo light />
            <p className="max-w-sm text-sm text-white/70">A staff benefit for employees of the Beharry Group. Questions? Contact your HR department.</p>
          </div>
          <StoreStrip stores={stores} size={48} />
        </div>
      </footer>
    </div>
  );
}
