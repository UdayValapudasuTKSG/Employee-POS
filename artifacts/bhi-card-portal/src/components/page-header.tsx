import React from 'react';
import { PageHead } from '@/components/screen-ui';

interface PageHeaderProps {
  title: string;
  description?: string;
  action?: React.ReactNode;
  /** Small label above the title, e.g. the section a detail page belongs to. */
  eyebrow?: string;
}

/**
 * The admin page's h1. Thin wrapper over PageHead so every screen shares the
 * same title scale (clamp 25–32px / 800) and eyebrow treatment. Actions sit on
 * the title's baseline rather than centring against the whole block.
 */
export function PageHeader({ title, description, action, eyebrow }: PageHeaderProps) {
  return (
    <PageHead
      className="mb-6"
      title={title}
      sub={description}
      eyebrow={eyebrow}
      action={action}
    />
  );
}
