import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';

export function HomeTaskComposer({ value, onChange, onSubmit, disabled }: {
    value: string;
    onChange: (value: string) => void;
    onSubmit: () => void;
    disabled: boolean;
}) {
    const { t } = useI18n();
    const [focused, setFocused] = React.useState(false);
    const expanded = focused || Boolean(value);
    const inputRef = React.useRef<HTMLInputElement | null>(null);
    const submit = () => { if (!disabled && value.trim()) onSubmit(); };
    // Home lives inside the chat composer form. A nested form lets Chromium's
    // native submission reload the app instead of reaching React's handler.
    return <div className={`oc-home-task-composer flex min-w-0 items-center gap-1 ${expanded ? 'flex-1' : 'shrink-0'}`}
        onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}
        onKeyDown={event => {
            if (event.key === 'Enter' && event.target === inputRef.current) {
                event.preventDefault(); event.stopPropagation();
                if (!event.nativeEvent.isComposing && !event.repeat) submit();
            }
            if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.preventDefault(); setFocused(false); inputRef.current?.blur(); }
        }}>
        {expanded ? <>
            <Input ref={inputRef} autoFocus className="min-w-0 w-0 flex-1" value={value} disabled={disabled}
                placeholder={t('home.addTaskPlaceholder')} aria-label={t('home.addTask')}
                onFocus={() => setFocused(true)} onChange={event => onChange(event.target.value)} />
            <Button type="button" onClick={submit} size="xs" className="oc-home-add-task shrink-0" aria-label={t('home.addTask')}
                title={t('home.addTask')} disabled={disabled || !value.trim()}><Icon name="add" className="size-3.5" /></Button>
        </> : <Button type="button" variant="outline" size="xs" className="oc-home-add-task shrink-0"
            disabled={disabled} aria-label={t('home.addTask')} onFocus={() => setFocused(true)} onClick={() => setFocused(true)}>
            <span className="oc-home-add-task-label">{t('home.addTask')}</span><Icon name="add" className="oc-home-add-task-icon size-3.5" />
        </Button>}
    </div>;
}
