import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { homeSuggestionHeadline, type HomeSuggestion } from '@/lib/homeSuggestions';

/** A single inline idea, not a Home widget. Details work with pointer, keyboard and touch. */
export function HomeSuggestionRow({ item, pending, onOpen, onDismiss }: {
  item: HomeSuggestion; pending: boolean; onOpen: () => void; onDismiss: () => void;
}) {
  const { t, locale } = useI18n();
  const detailId = React.useId();
  return <li className="oc-home-suggestion">
    <div className="oc-home-suggestion-line">
      <Button type="button" variant="ghost" size="sm" className="oc-home-suggestion-main normal-case"
        aria-describedby={detailId} onClick={onOpen}>
        <Icon name="arrow-right" className="size-3.5 shrink-0" />
        <span className="truncate">{homeSuggestionHeadline(item)}</span>
      </Button>
      <Button type="button" variant="ghost" size="icon" className="oc-home-suggestion-dismiss"
        disabled={pending} aria-label={`${t('companion.dismiss')}: ${homeSuggestionHeadline(item)}`}
        title={t('companion.dismiss')} onClick={onDismiss}>
        <Icon name="close" className="size-3.5" />
      </Button>
    </div>
    <div id={detailId} className="oc-home-suggestion-detail">
      <p className="oc-home-suggestion-source"><span dir="auto">{item.friend}</span><span aria-hidden="true"> · </span>
        <time dateTime={new Date(item.createdAt).toISOString()}>{new Date(item.createdAt).toLocaleString(locale, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time>
      </p>
      <p className="oc-home-suggestion-excerpt" dir="auto">{item.excerpt}</p>
      <Button type="button" variant="link" size="xs" onClick={onOpen}>{t('companion.result')}</Button>
    </div>
  </li>;
}
