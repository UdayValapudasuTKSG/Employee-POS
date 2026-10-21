import { useState, useEffect } from 'react';
import { useLocation } from 'wouter';
import { useVerifyOtp, useResendOtp, useSelectVerifiedRecord } from '@workspace/api-client-react';
import type { LookupOption, OtpVerifyResult, ErrorType, ApiErrorEnvelope } from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ArrowLeft, ChevronRight, Info, ShieldCheck, Users, X } from 'lucide-react';
import { MemberShell, MemberTopBar } from '@/components/screen-ui';
import { Link } from 'wouter';
import { useAuth } from '@/contexts/auth-context';
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from '@/components/ui/input-otp';

export default function Verify() {
  const [, setLocation] = useLocation();
  const { setCardToken } = useAuth();
  const params = new URLSearchParams(window.location.search);
  const verificationId = params.get('vid');
  const maskedDestination = params.get('dest');
  const devCode = params.get('dev');

  const [code, setCode] = useState('');
  const [cooldown, setCooldown] = useState(0);
  const [showDevBanner, setShowDevBanner] = useState(!!devCode);
  // Set when a verified code matches several records in one company
  const [selectOptions, setSelectOptions] = useState<LookupOption[] | null>(null);
  // Set when a verified code matches members in more than one company
  const [multiCompanyMessage, setMultiCompanyMessage] = useState<string | null>(null);

  const verifyMutation = useVerifyOtp();
  const resendMutation = useResendOtp();
  const selectMutation = useSelectVerifiedRecord();

  // Both /otp/verify and /otp/select answer with the same shape
  const handleVerifyResult = (data: OtpVerifyResult) => {
    if (data.status === 'SELECT') {
      setSelectOptions(data.options ?? []);
      return;
    }
    if (data.status === 'MULTI_COMPANY') {
      setMultiCompanyMessage(data.message ?? '');
      return;
    }
    if (!data.cardToken || !data.confirm) return;
    setCardToken(data.cardToken);
    setLocation(`/confirm?fn=${encodeURIComponent(data.confirm.firstName)}&masked=${encodeURIComponent(data.confirm.maskedIdentifier)}&company=${encodeURIComponent(data.confirm.companyName)}`);
  };

  const handleVerify = (otp: string) => {
    if (!verificationId || otp.length !== 6) return;

    verifyMutation.mutate(
      { data: { verificationId, code: otp } },
      { onSuccess: handleVerifyResult }
    );
  };

  const handleResend = () => {
    if (!verificationId || cooldown > 0) return;

    resendMutation.mutate(
      { data: { verificationId } },
      {
        onSuccess: (data) => {
          setCooldown(60);
          if (data.devCode) {
            setShowDevBanner(true);
          }
        },
      }
    );
  };

  const handleSelectOption = (optionRef: string) => {
    if (!verificationId) return;

    selectMutation.mutate(
      { data: { verificationId, optionRef } },
      { onSuccess: handleVerifyResult }
    );
  };

  useEffect(() => {
    if (cooldown > 0) {
      const timer = setTimeout(() => setCooldown(cooldown - 1), 1000);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [cooldown]);

  useEffect(() => {
    if (code.length === 6) {
      handleVerify(code);
    }
  }, [code]);

  const errorMessage = verifyMutation.error
    ? ((verifyMutation.error as ErrorType<ApiErrorEnvelope>).data?.error?.message || 'Invalid verification code')
    : resendMutation.error
    ? ((resendMutation.error as ErrorType<ApiErrorEnvelope>).data?.error?.message || 'Unable to resend code')
    : null;

  // Several records in one company: the member picks theirs after the code
  if (selectOptions) {
    const selectError = selectMutation.error
      ? ((selectMutation.error as ErrorType<ApiErrorEnvelope>).data?.error?.message || 'Unable to open that record')
      : null;

    return (
      <MemberShell top={<MemberTopBar />}>
            <Link href="/lookup" className="focus-ring inline-flex min-h-11 w-fit items-center gap-2 rounded-lg text-[14px] font-bold text-[var(--brand-600)] hover:underline" data-testid="link-back">
              <ArrowLeft aria-hidden="true" className="h-4 w-4" />
              Back
            </Link>

            <Card>
              <CardHeader className="gap-1">
                <div className="ds-eyebrow">Step 2 of 2</div>
                <h1 className="ds-page-title">Which one is you?</h1>
                <CardDescription className="text-[15px]">
                  More than one record uses that contact. Choose the one that matches you.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {selectError && (
                  <Alert variant="destructive">
                    <AlertDescription>{selectError}</AlertDescription>
                  </Alert>
                )}
                <div className="flex flex-col gap-2.5">
                  {selectOptions.length > 0 ? selectOptions.map((option) => (
                    <button
                      key={option.ref}
                      type="button"
                      className="ds-card focus-ring flex min-h-14 w-full items-center gap-3 px-4 py-3 text-left disabled:opacity-50"
                      data-elevate="row"
                      onClick={() => handleSelectOption(option.ref)}
                      disabled={selectMutation.isPending}
                      data-testid={`button-option-${option.ref}`}
                    >
                      <span className="tnum min-w-0 flex-1 text-[15px] font-bold text-[var(--fg-1)]">{option.label}</span>
                      <ChevronRight aria-hidden="true" className="h-4 w-4 flex-shrink-0 text-[var(--fg-4)]" />
                    </button>
                  )) : (
                    <Alert>
                      <AlertDescription>No options available.</AlertDescription>
                    </Alert>
                  )}
                </div>
              </CardContent>
            </Card>
      </MemberShell>
    );
  }

  // Members in more than one company: no card, the server's message as sent
  if (multiCompanyMessage !== null) {
    return (
      <MemberShell top={<MemberTopBar />}>
            <Card>
              <CardHeader className="items-center gap-3 text-center">
                <span
                  aria-hidden="true"
                  className="flex h-14 w-14 items-center justify-center rounded-full bg-info-soft text-info"
                >
                  <Users className="h-7 w-7" strokeWidth={2} />
                </span>
                <h1 className="ds-page-title">We can&rsquo;t show a card</h1>
                <p role="status" className="text-[15px] text-[var(--fg-3)]" data-testid="text-multi-company">
                  {multiCompanyMessage}
                </p>
              </CardHeader>
              <CardContent>
                <Button
                  size="lg"
                  className="w-full"
                  onClick={() => setLocation('/')}
                  data-testid="button-start-over"
                >
                  Back to start
                </Button>
              </CardContent>
            </Card>
      </MemberShell>
    );
  }

  return (
    <MemberShell top={<MemberTopBar />}>
          <Link href="/lookup" className="focus-ring inline-flex min-h-11 w-fit items-center gap-2 rounded-lg text-[14px] font-bold text-[var(--brand-600)] hover:underline" data-testid="link-back">
            <ArrowLeft aria-hidden="true" className="h-4 w-4" />
            Back
          </Link>

          {showDevBanner && devCode && (
            <Alert className="rounded-2xl border-[var(--status-info-bg)] bg-info-soft">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-3">
                  <Info aria-hidden="true" className="mt-0.5 h-4 w-4 text-info" />
                  <div>
                    <p className="text-[13px] font-bold uppercase tracking-[0.08em] text-info">Development mode</p>
                    <p className="tnum mt-1 font-mono text-xl font-bold tracking-[0.2em] text-[var(--fg-1)]">{devCode}</p>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setShowDevBanner(false)}
                  className="-mr-2 -mt-2"
                  aria-label="Dismiss development code"
                  data-testid="button-close-dev-banner"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </Alert>
          )}

          <Card>
            <CardHeader className="gap-1">
              <div className="ds-eyebrow">Step 2 of 2</div>
              <h1 className="ds-page-title">Enter your code</h1>
              <CardDescription className="text-[15px]">
                We sent a six-digit code to <span className="tnum font-bold text-[var(--fg-1)]">{maskedDestination}</span>
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="flex justify-center">
                <InputOTP
                  maxLength={6}
                  value={code}
                  onChange={(value) => setCode(value)}
                  disabled={verifyMutation.isPending}
                  data-testid="input-otp"
                >
                  <InputOTPGroup>
                    <InputOTPSlot index={0} />
                    <InputOTPSlot index={1} />
                    <InputOTPSlot index={2} />
                    <InputOTPSlot index={3} />
                    <InputOTPSlot index={4} />
                    <InputOTPSlot index={5} />
                  </InputOTPGroup>
                </InputOTP>
              </div>

              {errorMessage && (
                <Alert variant="destructive">
                  <AlertDescription>{errorMessage}</AlertDescription>
                </Alert>
              )}

              {verifyMutation.isPending && (
                <p role="status" aria-live="polite" className="text-center text-[14px] font-semibold text-[var(--fg-3)]">
                  Checking your code…
                </p>
              )}

              <div className="text-center">
                <Button
                  variant="link"
                  onClick={handleResend}
                  disabled={cooldown > 0 || resendMutation.isPending}
                  className="text-sm"
                  data-testid="button-resend"
                >
                  {cooldown > 0
                    ? `Resend code in ${cooldown}s`
                    : resendMutation.isPending
                    ? 'Sending...'
                    : 'Resend code'}
                </Button>
              </div>

              <div className="ds-panel flex items-start gap-3 p-4">
                <ShieldCheck aria-hidden="true" className="mt-0.5 h-4 w-4 flex-shrink-0 text-[var(--brand-600)]" />
                <p className="text-[13.5px] leading-relaxed text-[var(--fg-3)]">
                  The code expires in 5 minutes. You have 3 attempts.
                </p>
              </div>
            </CardContent>
          </Card>
    </MemberShell>
  );
}
