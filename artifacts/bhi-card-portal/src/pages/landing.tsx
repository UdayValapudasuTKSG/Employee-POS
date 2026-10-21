import { Link } from 'wouter';
import { ArrowRight, Clock, CreditCard, ShieldCheck } from 'lucide-react';
import { HelpChat } from '@/components/help-chat';
import { AutoGrid, IconTile, MemberShell, MemberTopBar } from '@/components/screen-ui';

const FEATURES = [
  {
    icon: ShieldCheck,
    title: 'Secure access',
    sub: 'A one-time code sent to your registered contact means only you can open your card.',
  },
  {
    icon: Clock,
    title: 'Ready in a minute',
    sub: 'Enter your email or phone, type the code, and your card is on screen.',
  },
  {
    icon: CreditCard,
    title: 'Everything in one place',
    sub: 'Your policy details and every covered dependant, ready to print, email or share.',
  },
];

export default function Landing() {
  return (
    <MemberShell width="xl" top={<MemberTopBar />}>
      {/* Hero — NALICO purple under a red roof line, the one large dark
          surface on the page. */}
      <section
        aria-labelledby="hero-title"
        className="relative overflow-hidden rounded-[20px] px-6 py-10 shadow-[0_14px_36px_-14px_rgba(91,37,207,0.6)] sm:px-10 sm:py-14"
        style={{ background: 'var(--hero-navy-gradient)' }}
      >
        <span aria-hidden="true" className="nalico-roof-edge" />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -top-24 right-[12%] h-[360px] w-[360px] rounded-full"
          style={{ background: 'radial-gradient(circle, rgba(227,21,31,0.32) 0%, transparent 65%)' }}
        />
        <div className="relative flex max-w-2xl flex-col gap-4">
          <div className="flex items-center gap-3 text-[13px] font-bold uppercase tracking-[0.1em] text-[var(--hero-fg-muted)]">
            <svg viewBox="0 0 236 52" aria-hidden="true" className="h-3.5 w-8 flex-shrink-0 text-[#e3151f]">
              <path d="M118 0 L236 52 L208 52 L118 13 L28 52 L0 52 Z" fill="currentColor" />
            </svg>
            Beharry Group Health Insurance
          </div>
          <h1
            id="hero-title"
            className="text-[clamp(30px,5.4vw,46px)] font-extrabold leading-[1.08] tracking-[-0.02em] text-[var(--hero-fg)]"
          >
            Your digital health card
          </h1>
          <p className="max-w-xl text-[17px] leading-relaxed text-[var(--hero-fg-muted)]">
            Get your insurance card on your phone in a minute. We send a one-time code to the email or phone
            number your employer has on file.
          </p>
          <div className="mt-2">
            <Link
              href="/lookup"
              className="press focus-ring inline-flex min-h-[48px] max-w-full items-center gap-2 rounded-xl bg-[var(--hero-cta-bg)] px-6 text-[15px] font-extrabold text-[var(--hero-cta-fg)] shadow-[var(--shadow-md)] hover:shadow-[var(--shadow-xl)]"
              data-testid="button-find-card"
            >
              <CreditCard aria-hidden="true" className="h-5 w-5" />
              Find my card
              <ArrowRight aria-hidden="true" className="h-4 w-4" />
            </Link>
          </div>
        </div>
        {/* Decorative roof mark, echoing the NALICO logo. */}
        <svg
          aria-hidden="true"
          viewBox="0 0 236 52"
          className="pointer-events-none absolute -bottom-6 -right-10 hidden w-[460px] text-white/[0.08] md:block"
        >
          <path d="M118 0 L236 52 L208 52 L118 13 L28 52 L0 52 Z" fill="currentColor" />
        </svg>
      </section>

      <section aria-labelledby="how-title" className="flex flex-col gap-3.5">
        <h2 id="how-title" className="ds-h2">
          How it works
        </h2>
        <AutoGrid min={240}>
          {FEATURES.map((f) => (
            <article key={f.title} className="ds-card flex flex-row items-start gap-3 p-[18px]" data-elevate>
              <IconTile icon={f.icon} size={40} />
              <div className="flex min-w-0 flex-col gap-1">
                <h3 className="ds-card-title">{f.title}</h3>
                <p className="ds-meta">{f.sub}</p>
              </div>
            </article>
          ))}
        </AutoGrid>
      </section>

      <HelpChat />
    </MemberShell>
  );
}
