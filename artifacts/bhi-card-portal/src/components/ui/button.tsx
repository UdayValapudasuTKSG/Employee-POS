import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cn } from '@/lib/utils';
import { cva, type VariantProps } from 'class-variance-authority';

const buttonVariants = cva(
  // Design system: radius 12, weight 700, spring press, 2px accent focus ring.
  'press inline-flex max-w-full items-center justify-center gap-2 whitespace-nowrap rounded-lg text-[15px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0' +
    ' hover-elevate active-elevate-2',
  {
    variants: {
      variant: {
        default:
          // @replit: no hover, and add primary border
          'btn-brand bg-primary text-primary-foreground border border-primary-border shadow-sm hover:shadow-[var(--shadow-accent)]',
        destructive:
          'bg-destructive text-destructive-foreground shadow-sm border-destructive-border',
        outline:
          // @replit Shows the background color of whatever card / sidebar / accent background it is inside of.
          // Inherits the current text color. Uses shadow-xs. no shadow on active
          // No hover state
          'border [border-color:var(--button-outline)] bg-[var(--surface-1)] text-[var(--brand-600)] shadow-xs hover:[border-color:var(--brand-200)] hover:bg-[var(--brand-50)] active:shadow-none',
        secondary:
          // @replit border, no hover, no shadow, secondary border.
          'border bg-secondary text-secondary-foreground border border-secondary-border ',
        // @replit no hover, transparent border
        ghost: 'border border-transparent text-[var(--fg-2)] hover:bg-[var(--surface-4)] hover:text-[var(--fg-1)]',
        link: 'text-[var(--brand-600)] underline underline-offset-4 decoration-[var(--brand-200)] hover:decoration-current',
      },
      size: {
        // @replit changed sizes
        default: 'min-h-10 px-4 py-2',
        sm: 'min-h-9 rounded-md px-3.5 text-[14px]',
        lg: 'min-h-[46px] px-6 text-[16px]',
        icon: 'h-10 w-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
