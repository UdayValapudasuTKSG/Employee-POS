import * as React from 'react';
import { cn } from '@/lib/utils';

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<'input'>>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          // 44px well; focus turns the border navy with a soft accent halo.
          'flex h-11 w-full rounded-lg border border-input bg-[var(--surface-1)] px-3.5 py-1 text-base text-[var(--fg-1)] shadow-xs transition-[border-color,box-shadow] duration-150 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-[var(--fg-4)] focus-visible:outline-none focus-visible:border-[var(--brand-600)] hover:border-[var(--brand-200)] focus-visible:shadow-[0_0_0_4px_var(--accent-soft)] aria-[invalid=true]:border-destructive disabled:cursor-not-allowed disabled:bg-[var(--surface-4)] disabled:opacity-70 md:text-[16px]',
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = 'Input';

export { Input };
