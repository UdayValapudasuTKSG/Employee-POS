import { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import {
  useGetCard,
  getGetCardQueryKey,
  useLogoutCardSession,
  useEmailCard,
} from '@workspace/api-client-react';
import type { ErrorType, ApiErrorEnvelope } from '@workspace/api-client-react';
import { PNG_EXPORT, PNG_EXPORT_HIGH_RES } from '@workspace/card-design';
import { useAuth } from '@/contexts/auth-context';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { AlertCircle, Clock, Printer, Mail, Share2, Loader2, Download } from 'lucide-react';
import { format } from 'date-fns';
import { HealthCard } from '@/components/health-card';
import { RfmDialog } from '@/components/rfm-dialog';
import { MemberLogoutButton, MemberNav } from '@/components/member-nav';
import { downloadBlob, exportCardPng, type CardLayoutData } from '@/lib/card-render';
import { idTypeLabel } from '@/lib/member-vocab';
import { EmptyState, MemberShell, MemberTopBar, PageHead, Skeleton } from '@/components/screen-ui';

export default function Card() {
  const [, setLocation] = useLocation();
  const { cardToken, clearCardSession } = useAuth();
  const { toast } = useToast();
  // Keyed by the session and always fetched fresh: a card must never be served
  // from another session's cache, and a policy removed since must show as such.
  const { data: card, isLoading, error } = useGetCard({
    query: {
      queryKey: [...getGetCardQueryKey(), cardToken ?? ''],
      enabled: !!cardToken,
      staleTime: 0,
      gcTime: 0,
      refetchOnMount: 'always',
    },
  });
  const logoutMutation = useLogoutCardSession();
  const emailMutation = useEmailCard();
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    if (!cardToken) {
      setLocation('/lookup');
    }
  }, [cardToken, setLocation]);

  const handleLogout = () => {
    logoutMutation.mutate(undefined, {
      onSettled: () => {
        clearCardSession();
        setLocation('/');
      },
    });
  };

  const handleEmail = () => {
    emailMutation.mutate(undefined, {
      onSuccess: (data) => {
        toast({
          title: 'Card sent',
          description: `A PDF copy is on its way to ${data.maskedDestination}.`,
        });
      },
      onError: (err) => {
        const envelope = (err as ErrorType<ApiErrorEnvelope>)?.data;
        toast({
          title: 'Could not send the card',
          description:
            envelope?.error?.message ??
            'Something went wrong sending your card. Try again shortly.',
          variant: 'destructive',
        });
      },
    });
  };

  if (isLoading) {
    return (
      <MemberShell width="lg" top={<MemberTopBar />}>
        <div role="status" aria-live="polite" className="flex flex-col gap-4">
          <span className="sr-only">Loading your card…</span>
          <Skeleton height={36} radius={10} className="max-w-xs" />
          <Skeleton height={44} radius={12} />
          <Skeleton height={520} radius={20} />
        </div>
      </MemberShell>
    );
  }

  // The member verified fine but HR has not recorded a policy for them yet, so
  // there is nothing to print on a card. Verifying again would only land here
  // again, so this says what is missing and who can fix it instead.
  const errorCode = (error as ErrorType<ApiErrorEnvelope> | null)?.data?.error?.code;
  if (errorCode === 'NO_POLICY') {
    return (
      <MemberShell top={<MemberTopBar />}>
        {/* Discounts need no policy, so they stay one tap away. */}
        <MemberNav />
        <h1 className="sr-only">Your health insurance card</h1>
        <div role="alert">
          <EmptyState
            icon={Clock}
            title="Your card isn’t ready yet"
            body="You’re verified, but your policy details haven’t been added to your record yet. Contact your HR department — once they add your policy, your card will be here."
            action={
              <Button
                size="lg"
                variant="outline"
                onClick={handleLogout}
                disabled={logoutMutation.isPending}
                className="mt-1"
                data-testid="button-no-policy-done"
              >
                Done
              </Button>
            }
          />
        </div>
      </MemberShell>
    );
  }

  if (error || !card) {
    return (
      <MemberShell top={<MemberTopBar />}>
        <h1 className="sr-only">Your health insurance card</h1>
        <div role="alert">
          <EmptyState
            icon={AlertCircle}
            title="We could not load your card"
            body="Your session may have expired. Verify again to open it — nothing on your policy has changed."
            action={
              <Button size="lg" onClick={() => setLocation('/lookup')} className="mt-1">
                Verify again
              </Button>
            }
          />
        </div>
      </MemberShell>
    );
  }

  const expiryDate = card.expiryDate ? new Date(card.expiryDate) : null;
  const isExpired = expiryDate && expiryDate < new Date();

  // Everything identifying the insurer comes from the API (ISSUER_* on the
  // server), so the same build renders whichever insurer the deployment is
  // configured for. Each part is omitted when it is not configured.
  const { issuer } = card;

  const cardData: CardLayoutData = {
    insurerName: card.insurerName,
    insurerAddress: issuer.address,
    insurerPhone: issuer.phone,
    planTitle: issuer.planTitle,
    signatoryName: issuer.signatoryName,
    signatoryTitle: issuer.signatoryTitle,
    policyholder: card.policyholder,
    policyNumber: card.policyNumber,
    employeeName: card.employeeName,
    identificationId: card.identificationId,
    idType: card.idType,
    classCode: card.classCode,
    dateOfBirth: card.dateOfBirth,
    effectiveDate: card.effectiveDate,
    dependents: card.dependents,
  };

  const handleDownloadPng = async (size: { width: number; height: number }) => {
    setExporting(true);
    try {
      const blob = await exportCardPng(cardData, size);
      const slug = card.policyNumber.replace(/[^A-Za-z0-9-]+/g, '-');
      downloadBlob(blob, `nalico-card-${slug}-${size.width}x${size.height}.png`);
    } catch (err) {
      toast({
        title: 'Could not create the image',
        description: (err as Error)?.message ?? 'Try again, or use Email for a PDF copy.',
        variant: 'destructive',
      });
    } finally {
      setExporting(false);
    }
  };

  const shareText = [
    `${card.insurerName} — ${issuer.planTitle}`,
    `Policyholder: ${card.policyholder}`,
    `Policy No: ${card.policyNumber}`,
    `Insured: ${card.employeeName}`,
    `${idTypeLabel(card.idType) ?? "ID"}: ${card.identificationId}`,
    `Class: ${card.classCode}`,
    `Effective Date: ${format(new Date(card.effectiveDate), 'd MMMM yyyy')}`,
    card.dependents.length > 0
      ? `Dependants: ${card.dependents.map((d) => `${d.fullName} (${d.relationship.toLowerCase()})`).join(', ')}`
      : null,
    [issuer.propertyNotice, issuer.phone].filter(Boolean).join(' ') || null,
  ]
    .filter(Boolean)
    .join('\n');

  // Native share sheet where the browser offers one (all mobile browsers, and
  // Chrome/Edge on desktop); clipboard copy everywhere else. Deliberately shares
  // the text summary, not the PDF — the card is emailed rather than handed to an
  // arbitrary third-party app.
  const handleShare = async () => {
    const payload = {
      title: `${card.insurerName} ${issuer.planTitle}`,
      text: shareText,
    };

    if (typeof navigator !== 'undefined' && navigator.share) {
      try {
        await navigator.share(payload);
        return;
      } catch (err) {
        // The user dismissing the sheet is not a failure worth reporting.
        if ((err as Error)?.name === 'AbortError') return;
      }
    }

    try {
      await navigator.clipboard.writeText(shareText);
      toast({
        title: 'Card details copied',
        description: 'Paste them wherever you need to share them.',
      });
    } catch {
      toast({
        title: 'Could not share',
        description: 'Your browser blocked sharing. Use Print or Email instead.',
        variant: 'destructive',
      });
    }
  };

  return (
    <MemberShell
      width="xl"
      top={<MemberTopBar right={<MemberLogoutButton />} />}
    >
          <MemberNav />

          <PageHead
            eyebrow={card.insurerName}
            title="Your health insurance card"
            sub={
              <>
                For your security this view closes at{' '}
                <span className="tnum font-semibold text-[var(--fg-2)]">
                  {format(new Date(card.sessionExpiresAt), 'h:mm a')}
                </span>{' '}
                on {format(new Date(card.sessionExpiresAt), 'd MMM yyyy')}.
              </>
            }
          />

          {/* Actions — a wrapping toolbar so nothing scrolls sideways on a phone. */}
          <div role="toolbar" aria-label="Card actions" className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={() => window.print()}
                data-testid="button-print"
              >
                <Printer className="h-4 w-4" />
                Print
              </Button>
              <RfmDialog card={card} />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    disabled={exporting}
                    data-testid="button-download-card"
                  >
                    {exporting ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Download className="h-4 w-4" />
                    )}
                    Download
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onSelect={() => handleDownloadPng(PNG_EXPORT)}
                    data-testid="menu-download-png"
                  >
                    PNG ({PNG_EXPORT.width} × {PNG_EXPORT.height})
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => handleDownloadPng(PNG_EXPORT_HIGH_RES)}
                    data-testid="menu-download-png-hires"
                  >
                    High-res PNG ({PNG_EXPORT_HIGH_RES.width} × {PNG_EXPORT_HIGH_RES.height})
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                variant="outline"
                onClick={handleEmail}
                disabled={emailMutation.isPending}
                data-testid="button-email-card"
              >
                {emailMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Mail className="h-4 w-4" />
                )}
                {emailMutation.isPending ? 'Sending…' : 'Email'}
              </Button>
              <Button
                variant="outline"
                onClick={handleShare}
                data-testid="button-share"
              >
                <Share2 className="h-4 w-4" />
                Share
              </Button>
          </div>

          {isExpired && (
            <Alert variant="destructive" className="rounded-2xl">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                This policy expired on {format(expiryDate, 'MMMM d, yyyy')}. Contact your HR department for current coverage information.
              </AlertDescription>
            </Alert>
          )}

          {/* The NALICO portrait card — the same render the PNG exports use */}
          <HealthCard data={cardData} />

          {/* Beneficiaries — separate from the physical card layout */}
          {card.beneficiaries.length > 0 && (
            <section
              aria-labelledby="beneficiaries-title"
              className="ds-card mx-auto w-full max-w-2xl px-5 py-5 sm:px-6"
              data-testid="beneficiaries-section"
            >
              <h2 id="beneficiaries-title" className="ds-h2">
                Payout beneficiaries
              </h2>
              <p className="ds-meta mt-1">
                The people who receive the insurance payout. To change them, contact your HR department.
              </p>
              <ul className="mt-3 divide-y divide-[var(--surface-hairline)]">
                {card.beneficiaries.map((ben, idx) => (
                  <li key={idx} className="flex items-center justify-between gap-4 py-3" data-testid={`beneficiary-row-${idx}`}>
                    <div className="min-w-0">
                      <div className="ds-card-title">
                        {ben.fullName}
                      </div>
                      {/* Absent for a beneficiary loaded from the carrier's
                          sheet, which has no Relationship column. */}
                      {ben.relationship && (
                        <div className="ds-meta capitalize">
                          {ben.relationship.toLowerCase()}
                        </div>
                      )}
                    </div>
                    <div className="tnum text-[15px] font-bold text-[var(--fg-1)]">
                      {ben.allocationPercent != null ? `${ben.allocationPercent}%` : '—'}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
    </MemberShell>
  );
}
