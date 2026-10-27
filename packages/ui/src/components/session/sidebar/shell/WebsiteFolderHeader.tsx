import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';

export type WebsiteFolderEmbedProps = {
  embedded?: boolean;
  dragAttributes?: React.HTMLAttributes<HTMLDivElement>;
  dragListeners?: React.HTMLAttributes<HTMLButtonElement>;
};

/** Website selection and disclosure share the ordinary sidebar's leading slot. */
export function WebsiteFolderHeader({ label, logo, selected, expanded, controlsId, onOpen, onToggle, dragAttributes, dragListeners, children }: {
  label: string;
  logo: React.ReactNode;
  selected: boolean;
  expanded: boolean;
  controlsId: string;
  onOpen: () => void;
  onToggle: () => void;
  dragAttributes?: React.HTMLAttributes<HTMLDivElement>;
  dragListeners?: React.HTMLAttributes<HTMLButtonElement>;
  children?: React.ReactNode;
}): React.ReactNode {
  return <div {...dragAttributes} className={cn('group/website relative -ml-2.5 -mr-2 flex items-center rounded-md', selected && 'bg-interactive-selection text-interactive-selection-foreground', dragAttributes?.className)}>
    <Button variant="ghost" size="sm" aria-pressed={selected} className="min-w-0 flex-1 justify-start gap-1.5 pl-4" onClick={onOpen} {...dragListeners}>
      <span aria-hidden="true" className="flex size-5 shrink-0 items-center justify-center group-hover/website:invisible group-focus-within/website:invisible">{logo}</span>
      <span className="truncate font-medium">{label}</span>
    </Button>
    <Button variant="ghost" size="xs" aria-label={label} aria-expanded={expanded} aria-controls={controlsId} onClick={onToggle}
      className="absolute left-4 top-1/2 w-3.5 -translate-y-1/2 px-0 has-[>svg]:px-0 opacity-0 group-hover/website:opacity-100 group-focus-within/website:opacity-100">
      <Icon name={expanded ? 'arrow-down-s' : 'arrow-right-s'} className="size-3.5" />
    </Button>
    {children}
  </div>;
}
