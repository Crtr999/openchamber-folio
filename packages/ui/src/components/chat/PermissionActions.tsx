import React from 'react';
import type { PermissionReply, PermissionRequest } from '@/types/permission';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { cn, formatPathForDisplay } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { formatShortcutForDisplay } from '@/lib/shortcuts';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { describeSavePatterns } from './permissionSummary';

const useAlwaysLabel = (permission: PermissionRequest) => {
  const { t } = useI18n();
  const homeDirectory = useDirectoryStore((state) => state.homeDirectory);
  const always = describeSavePatterns(permission.action || '', permission.save ?? [])
    .map((pattern) => formatPathForDisplay(pattern, homeDirectory));
  if (always.length === 0) return { label: t('chat.permissionCard.alwaysAllow'), full: undefined };
  const shown = always.slice(0, 2).join(', ');
  return {
    label: t('chat.permissionCard.alwaysAllowPatterns', { patterns: always.length > 2 ? `${shown}...` : shown }),
    full: t('chat.permissionCard.alwaysAllowPatterns', { patterns: always.join(', ') }),
  };
};

/** Both approval presentations use the same explicit reply choices and feedback. */
export const PermissionActions: React.FC<{
  permission: PermissionRequest;
  isResponding: boolean;
  hasError?: boolean;
  onRespond: (response: PermissionReply) => void;
  variant: 'inline' | 'dock';
}> = ({ permission, isResponding, hasError = false, onRespond, variant }) => {
  const { t } = useI18n();
  const always = useAlwaysLabel(permission);
  const hasSave = always.full !== undefined;

  return (
    <div className={cn('px-3 pb-2 pt-1', variant === 'inline' && 'border-t border-border/20')}>
      <p role="alert" className="typography-meta text-[var(--status-error-text)]">
        {hasError ? t('chat.permissionCard.replyFailed') : null}
      </p>
      <p role="status" className="typography-meta text-muted-foreground">
        {isResponding ? t('chat.permissionCard.replyPending') : null}
      </p>
      <div className="flex flex-wrap items-center gap-1.5" aria-busy={isResponding}>
        <Button variant="ghost" size="xs" disabled={isResponding} onClick={() => onRespond('reject')}>
          <Icon name="close" className="size-3.5" />
          {t('chat.permissionCard.deny')}
          <kbd className="ms-1 hidden sm:inline typography-micro opacity-60">{formatShortcutForDisplay('alt+backspace')}</kbd>
        </Button>
        <div className="min-w-0 flex-1" />
        <Button variant="outline" size="xs" disabled={isResponding} onClick={() => onRespond('always')} title={always.full} aria-label={always.full} className="max-w-full min-w-0">
          <Icon name="time" className="size-3.5" />
          <span className="max-w-[180px] truncate">{always.label}</span>
          {!hasSave ? <kbd className="ms-1 hidden sm:inline typography-micro opacity-60">{formatShortcutForDisplay('alt+shift+enter')}</kbd> : null}
        </Button>
        <Button size="xs" disabled={isResponding} onClick={() => onRespond('once')}>
          {isResponding ? <Icon name="loader-4" className="size-3.5 motion-safe:animate-spin" /> : <Icon name="check" className="size-3.5" />}
          {t('chat.permissionCard.allowOnce')}
          <kbd className="ms-1 hidden sm:inline typography-micro opacity-60">{formatShortcutForDisplay('alt+enter')}</kbd>
        </Button>
      </div>
    </div>
  );
};
