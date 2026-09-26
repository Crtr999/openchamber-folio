import React from 'react';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { folioSymbols, iconPrefix, noteIcons } from '@/lib/folio/icons';
import { cn } from '@/lib/utils';

const symbolByName = new Map<string, string>(Object.entries(folioSymbols));
const monochrome = new Map<string, IconName>(noteIcons.map(({ icon }) => [icon, icon]));

/**
 * A page icon is one of: an uploaded image (data URL), a grey glyph (`icon:<name>`),
 * a native SF Symbol name we map to an emoji, or a raw emoji.
 */
export function FolioIcon({ value, large }: { value: string; large?: boolean }) {
  if (value.startsWith('data:image/')) return <img src={value} alt="" className={cn('inline-block rounded object-cover align-[-0.15em]', large ? 'size-[1em]' : 'size-4')} />;
  if (value.startsWith(iconPrefix)) {
    const name = monochrome.get(value.slice(iconPrefix.length));
    return <Icon name={name ?? 'file-text'} className={cn('inline-block text-muted-foreground', large ? 'size-[1em]' : 'size-4')} />;
  }
  const symbol = symbolByName.get(value);
  if (symbol) return <span aria-hidden="true">{symbol}</span>;
  if (value && !/^[\w.]+$/.test(value)) return <span aria-hidden="true">{value}</span>;
  return <Icon name="file-text" className={cn('inline-block text-muted-foreground', large ? 'size-[1em]' : 'size-4')} />;
}
