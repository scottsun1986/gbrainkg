import React from 'react';
import { TYPE_LABEL } from '@/lib/design-tokens';

export function TypeBadge({ type }: { type: string }) {
  return <span className={`badge ${type}`}>{TYPE_LABEL[type] || type}</span>;
}

/** Imperative form kept for call sites that render `{TYPE_BADGE(x)}`. */
export const TYPE_BADGE = (type: string) => <TypeBadge type={type} />;
