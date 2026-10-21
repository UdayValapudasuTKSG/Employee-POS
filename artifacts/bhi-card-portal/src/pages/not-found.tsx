import { Link } from 'wouter';
import { ArrowLeft, SearchX } from 'lucide-react';
import { EmptyState, MemberShell, MemberTopBar } from '@/components/screen-ui';

export default function NotFound() {
  return (
    <MemberShell top={<MemberTopBar />}>
      <h1 className="sr-only">Page not found</h1>
      <EmptyState
        icon={SearchX}
        title="We couldn’t find that page"
        body="The link may be out of date, or the address may have a typo. Start again from the home page."
        action={
          <Link
            href="/"
            className="press focus-ring mt-1 inline-flex min-h-11 items-center gap-2 rounded-lg bg-primary px-5 text-[14.5px] font-bold text-primary-foreground"
          >
            <ArrowLeft aria-hidden="true" className="h-4 w-4" />
            Go to the home page
          </Link>
        }
      />
    </MemberShell>
  );
}
