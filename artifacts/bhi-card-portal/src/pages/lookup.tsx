import { useState } from 'react';
import { useLocation } from 'wouter';
import { useLookupMember } from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ArrowLeft, Clock, Mail, Phone } from 'lucide-react';
import { MemberShell, MemberTopBar } from '@/components/screen-ui';
import { Link } from 'wouter';
import type { ErrorType } from '@workspace/api-client-react';
import type { ApiErrorEnvelope } from '@workspace/api-client-react';

export default function Lookup() {
  const [, setLocation] = useLocation();
  const [identifier, setIdentifier] = useState('');
  const lookupMutation = useLookupMember();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!identifier.trim()) return;

    lookupMutation.mutate(
      { data: { identifier: identifier.trim() } },
      {
        // An unknown contact is refused (CONTACT_NOT_FOUND) and its message
        // shown below; every match answers CODE_SENT. Choosing between several
        // records happens after the code is verified.
        onSuccess: (data) => {
          setLocation(`/verify?vid=${data.verificationId ?? ''}&dest=${encodeURIComponent(data.maskedDestination || '')}${data.devCode ? `&dev=${data.devCode}` : ''}`);
        },
      }
    );
  };

  const errorMessage = lookupMutation.error
    ? ((lookupMutation.error as ErrorType<ApiErrorEnvelope>).data?.error?.message || 'Unable to process lookup')
    : null;

  return (
    <MemberShell top={<MemberTopBar />}>
          <Link href="/" className="focus-ring inline-flex min-h-11 w-fit items-center gap-2 rounded-lg text-[14px] font-bold text-[var(--brand-600)] hover:underline" data-testid="link-back">
            <ArrowLeft aria-hidden="true" className="h-4 w-4" />
            Back
          </Link>

          <Card>
            <CardHeader className="gap-1">
              <div className="ds-eyebrow">Step 1 of 2</div>
              <h1 className="ds-page-title">Find your card</h1>
              <CardDescription className="text-[15px]">
                Enter the email or phone number your employer has on file for you.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <Label htmlFor="identifier" className="text-[14px] font-bold text-[var(--fg-1)]">Email or phone</Label>
                  <div className="relative mt-1.5">
                    <Input
                      id="identifier"
                      type="text"
                      // No sample number: it would be a country baked into the
                      // interface, and the server accepts a local or an
                      // international form either way, so an example teaches a
                      // rule that does not exist.
                      placeholder="your.email@company.com or your mobile number"
                      value={identifier}
                      onChange={(e) => {
                        setIdentifier(e.target.value);
                        if (lookupMutation.error) lookupMutation.reset();
                      }}
                      disabled={lookupMutation.isPending}
                      required
                      autoFocus
                      data-testid="input-identifier"
                      className="pl-10"
                    />
                    <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3.5">
                      {identifier.includes('@') ? (
                        <Mail className="h-4 w-4 text-[var(--fg-4)]" />
                      ) : (
                        <Phone className="h-4 w-4 text-[var(--fg-4)]" />
                      )}
                    </div>
                  </div>
                </div>

                {errorMessage && (
                  <Alert variant="destructive">
                    <AlertDescription>{errorMessage}</AlertDescription>
                  </Alert>
                )}

                <Button
                  type="submit"
                  size="lg"
                  className="w-full"
                  disabled={lookupMutation.isPending || !identifier.trim()}
                  data-testid="button-continue"
                >
                  {lookupMutation.isPending ? 'Checking…' : 'Send me a code'}
                </Button>
              </form>

              <div className="ds-panel mt-6 flex items-start gap-3 p-4">
                <Clock aria-hidden="true" className="mt-0.5 h-4 w-4 flex-shrink-0 text-[var(--brand-600)]" />
                <p className="text-[13.5px] leading-relaxed text-[var(--fg-3)]">
                  We&rsquo;ll send a six-digit code to the contact on file. It expires in 5 minutes.
                </p>
              </div>
            </CardContent>
          </Card>
    </MemberShell>
  );
}
