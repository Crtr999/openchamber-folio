import React from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/i18n';
import {
    FRIEND_BODIES,
    FRIEND_COLORS,
    FriendRevisionConflict,
    friendColorVariable,
    type FriendAppearance,
} from '@/lib/friends';
import { HomeFriendAvatar } from './HomeFriendAvatar';

/**
 * The friend's own look: name, role, shape and colour.
 *
 * It lives in the studio rather than in a dialog of its own, because there is
 * only one place to go to change a friend: one panel, one save.
 */
export function FriendAppearanceEditor({
    target,
    busy,
    onSave,
}: {
    target: { agent: string; name: string; role?: string; appearance: FriendAppearance };
    busy: boolean;
    onSave: (key: string, draft: { name: string; role?: string } & FriendAppearance) => void;
}) {
    const { t } = useI18n();
    const [draft, setDraft] = React.useState<{ name: string; role?: string } & FriendAppearance>(() => ({
        name: target.name,
        role: target.role,
        ...target.appearance,
    }));
    const [status, setStatus] = React.useState<'idle' | 'saved' | 'error' | 'conflict'>('idle');

    React.useEffect(() => {
        setDraft({ name: target.name, role: target.role, ...target.appearance });
        setStatus('idle');
    }, [target]);

    const name = draft.name.trim();
    const dirty = name !== target.name
        || (draft.role?.trim() ?? '') !== (target.role?.trim() ?? '')
        || draft.body !== target.appearance.body
        || draft.color !== target.appearance.color;

    const save = () => {
        if (!name || busy) return;
        const role = draft.role?.trim();
        try {
            onSave(target.agent, {
                name,
                body: draft.body,
                color: draft.color,
                ...(role && role !== target.role ? { role } : {}),
            });
            setStatus('saved');
        } catch (failure) {
            // Two failures, two answers: another window saved first is not the
            // same as the save having failed.
            setStatus(failure instanceof FriendRevisionConflict ? 'conflict' : 'error');
        }
    };

    return (
        <section className="space-y-3" data-testid="friend-customize">
            <div className="oc-friend-preview">
                <HomeFriendAvatar key={`${draft.body}:${draft.color}`} body={draft.body} color={draft.color} className="size-24" label={t('friends.preview', { name: name || target.name })} />
                <p className="text-sm text-muted-foreground">{draft.role?.trim() || target.role}</p>
            </div>
            <label className="flex flex-col gap-1.5 text-[13px] font-medium">{t('friends.name')}
                <Input value={draft.name} maxLength={32} onChange={event => { setDraft({ ...draft, name: event.target.value }); setStatus('idle'); }} />
            </label>
            <label className="flex flex-col gap-1.5 text-[13px] font-medium">{t('friends.roleLabel')}
                <Input value={draft.role ?? ''} maxLength={80} placeholder={target.role} onChange={event => { setDraft({ ...draft, role: event.target.value }); setStatus('idle'); }} />
            </label>
            <fieldset className="flex flex-col gap-2"><legend className="mb-2 text-[13px] font-medium">{t('friends.body')}</legend>
                <div className="oc-friend-body-grid">{FRIEND_BODIES.map((body, index) => <Button key={body} type="button" variant="chip" size="icon"
                    className="oc-friend-option size-12" aria-pressed={draft.body === body} aria-label={t('friends.bodyOption', { number: index + 1 })}
                    onClick={() => { setDraft({ ...draft, body }); setStatus('idle'); }}><HomeFriendAvatar body={body} color={draft.color} className="size-8" /></Button>)}</div>
            </fieldset>
            <fieldset className="flex flex-col gap-2"><legend className="mb-2 text-[13px] font-medium">{t('friends.color')}</legend>
                <div className="flex flex-wrap gap-2">{FRIEND_COLORS.map((color, index) => <Button key={color} type="button" variant="chip" size="icon"
                    className="oc-friend-swatch size-9 rounded-full" aria-pressed={draft.color === color} aria-label={t('friends.colorOption', { number: index + 1 })}
                    onClick={() => { setDraft({ ...draft, color }); setStatus('idle'); }}><span aria-hidden="true" className="size-6 rounded-full" style={{ background: friendColorVariable(color) }} /></Button>)}</div>
            </fieldset>
            <div className="flex items-center gap-2">
                <Button size="sm" data-testid="friend-appearance-save" disabled={!dirty || !name || busy} onClick={save}>
                    {status === 'saved' && !dirty ? 'Saved' : t('home.save')}
                </Button>
                {status === 'error' && <p role="alert" className="text-xs text-[var(--status-error-text)]">{t('friends.saveFailed')}</p>}
                {status === 'conflict' && <p role="alert" className="text-xs text-[var(--status-error-text)]">{t('friends.saveConflict')}</p>}
            </div>
        </section>
    );
}
