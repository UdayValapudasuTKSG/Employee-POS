import * as React from 'react';
import { cn } from '@/lib/utils';
import { cva, type VariantProps } from 'class-variance-authority';

const badgeVariants = cva(
  // @replit
  // Whitespace-nowrap: Badges should never wrap.
  // Pill: 12px / 800, fully rounded.
  'whitespace-nowrap inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[12.5px] font-bold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2' +
    ' hover-elevate ',
  {
    variants: {
      variant: {
        default:
          // @replit shadow-xs instead of shadow, no hover because we use hover-elevate
          'border-transparent bg-[var(--brand-50)] text-[var(--brand-700)]',
        secondary:
          // @replit no hover because we use hover-elevate
          'border-transparent bg-[var(--surface-4)] text-[var(--fg-2)]',
        destructive:
          // @replit shadow-xs instead of shadow, no hover because we use hover-elevate
          'border-transparent bg-error-soft text-error',
        // @replit shadow-xs" - use badge outline variable
        outline: 'text-[var(--fg-2)] border [border-color:var(--badge-outline)]',
        success: 'border-transparent bg-success-soft text-success',
        warning: 'border-transparent bg-warning-soft text-warning-text',
        info: 'border-transparent bg-info-soft text-info',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
