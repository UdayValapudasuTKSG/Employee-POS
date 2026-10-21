import { useLocation } from 'wouter';
import { ArrowRight, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { MemberShell, MemberTopBar } from '@/components/screen-ui';

export default function Confirm() {
  const [, setLocation] = useLocation();
  const params = new URLSearchParams(window.location.search);
  const firstName = params.get('fn');
  const maskedIdentifier = params.get('masked');
  const companyName = params.get('company');

  return (
    <MemberShell top={<MemberTopBar />}>
      <Card>
        <CardHeader className="items-center gap-3 text-center">
          <span
            aria-hidden="true"
            className="flex h-14 w-14 items-center justify-center rounded-full bg-success-soft text-success"
          >
            <CheckCircle2 className="h-7 w-7" strokeWidth={2} />
          </span>
          <h1 className="ds-page-title">You&rsquo;re verified</h1>
          <p className="text-[15px] text-[var(--fg-3)]">Check these details are yours, then open your card.</p>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <dl className="ds-panel m-0 divide-y divide-[var(--surface-hairline)] px-4">
            <div className="flex items-baseline justify-between gap-4 py-3">
              <dt className="text-[13.5px] text-[var(--fg-3)]">Name</dt>
              <dd className="m-0 min-w-0 text-right text-[15px] font-bold text-[var(--fg-1)]">{firstName || '—'}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-4 py-3">
              <dt className="text-[13.5px] text-[var(--fg-3)]">Contact</dt>
              <dd className="tnum m-0 min-w-0 truncate text-right text-[15px] font-bold text-[var(--fg-1)]">
                {maskedIdentifier || '—'}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-4 py-3">
              <dt className="text-[13.5px] text-[var(--fg-3)]">Company</dt>
              <dd className="m-0 min-w-0 text-right text-[15px] font-bold text-[var(--fg-1)]">{companyName || '—'}</dd>
            </div>
          </dl>

          <Button size="lg" className="w-full" onClick={() => setLocation('/card')} data-testid="button-view-card">
            View my card
            <ArrowRight aria-hidden="true" className="h-4 w-4" />
          </Button>
        </CardContent>
      </Card>
    </MemberShell>
  );
}
