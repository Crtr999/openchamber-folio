import React from 'react';
import { useI18n } from '@/lib/i18n';

export interface FolioConfirmProps {
  /** The heading, and the accessible name a screen reader announces. */
  label: string;
  /** One line saying what happens next, so the user can tell whether the step is reversible. */
  body: string;
  /** What the destructive button does. */
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * The confirmation a destructive step in a note asks for: a database row that cannot be brought back, a
 * page that can. It closes on a tap outside, on Escape, and on Cancel, and Cancel holds the focus so a
 * stray Enter carries out the safe answer rather than the destructive one.
 */
export function FolioConfirm({ label, body, confirmLabel, onConfirm, onCancel }: FolioConfirmProps) {
  const { t } = useI18n();
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onCancel}>
    <div role="dialog" aria-label={label} className="w-full max-w-xs rounded-lg border border-border bg-background p-3 text-sm shadow-lg"
      onKeyDown={(e) => { if (e.key === 'Escape') onCancel(); }} onClick={(e) => e.stopPropagation()}>
      <p className="mb-1 font-medium">{label}</p>
      <p className="mb-3 text-xs text-muted-foreground">{body}</p>
      <div className="flex gap-2">
        <button type="button" className="flex-1 rounded-md bg-destructive px-3 py-2 text-destructive-foreground" onClick={onConfirm}>{confirmLabel}</button>
        <button type="button" autoFocus className="rounded-md bg-secondary px-3 py-2" onClick={onCancel}>{t('folio.cancel')}</button>
      </div>
    </div>
  </div>;
}
