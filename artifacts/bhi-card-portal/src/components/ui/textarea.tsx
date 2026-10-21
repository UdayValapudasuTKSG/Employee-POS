import * as React from 'react';
import { cn } from '@/lib/utils';

const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.ComponentProps<'textarea'>
>(({ className, ...props }, ref) => {
  return (
    <textarea
      className={cn(
        'flex min-h-[88px] w-full rounded-lg border border-input bg-[var(--surface-1)] px-3.5 py-2.5 text-base text-[var(--fg-1)] shadow-xs transition-[border-color,box-shadow] duration-150 placeholder:text-[var(--fg-4)] focus-visible:outline-none focus-visible:border-[var(--brand-600)] hover:border-[var(--brand-200)] focus-visible:shadow-[0_0_0_4px_var(--accent-soft)] disabled:cursor-not-allowed disabled:opacity-50 md:text-[16px]',
        className,
      )}
      ref={ref}
      {...props}
    />
  );
});
Textarea.displayName = 'Textarea';

export { Textarea };
