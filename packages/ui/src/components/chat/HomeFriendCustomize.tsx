import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useI18n } from '@/lib/i18n';
import { FRIEND_COLORS, FRIEND_BODIES, FriendRevisionConflict, friendColorVariable, type FriendAppearance } from '@/lib/friends';
import { morphFrom } from '@/lib/motion';
import { useAgentMemoryStore } from '@/stores/useAgentMemoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { MemorySection } from '@/components/session/project-context/MemorySection';
import { HomeFriendAvatar } from './HomeFriendAvatar';

export type FriendCustomizeTarget = {
    agent: string;
    role: string;
    name: string;
    appearance: FriendAppearance;
    origin: DOMRect | null;
    folderLabel?: string;
    /** The friend's folder, when it has one: this is where its memory lives. */
    folderPath?: string;
};
type Draft = { name: string; role?: string } & FriendAppearance;

/** Name, optional role tagline, body and color for one friend. `onSave` persists and throws on conflict or storage failure. */
export function HomeFriendCustomize({ target, onClose, onSave }: { target: FriendCustomizeTarget | null; onClose: () => void; onSave: (agent: string, draft: Draft) => void }) {
    const { t } = useI18n();
    const [draft, setDraft] = React.useState<Draft | null>(null);
    const [error, setError] = React.useState('');
    const popup = React.useRef<HTMLDivElement>(null);
    React.useEffect(() => {
        setError('');
        setDraft(target ? { name: target.name, role: target.role, ...target.appearance } : null);
    }, [target]);
    // Grow out of the card that opened it; morphFrom is a no-op under reduced motion.
    // Keyed on the opening rect so later re-renders of the same panel never replay the motion.
    const origin = target?.origin ?? null;
    React.useEffect(() => {
        if (!origin) return;
        const frame = requestAnimationFrame(() => { morphFrom(popup.current, origin); });
        return () => cancelAnimationFrame(frame);
    }, [origin]);
    const name = draft?.name.trim() ?? '';

    /**
     * The memory of this friend, in the same editor the Memory tab uses.
     *
     * The store holds one project at a time, so it is pointed at this friend
     * while the dialog is open and put back on the way out. The store is only
     * what the panel reads — what the agent is told is read on the server — so
     * this never changes what a conversation carries.
     */
    const loadMemory = useAgentMemoryStore((state) => state.load);
    const activeProjectPath = useProjectsStore((state) => state.getActiveProject()?.path ?? null);
    const memoryPath = target?.folderPath ?? null;
    React.useEffect(() => {
        if (!memoryPath) return;
        void loadMemory(memoryPath);
        // Put the store back on the project the user is working in, so the
        // Memory tab beside this dialog still shows that project.
        return () => { void loadMemory(activeProjectPath); };
    }, [loadMemory, memoryPath, activeProjectPath]);
    const save = (event: React.FormEvent) => {
        event.preventDefault();
        if (!target || !draft || !name) return;
        const trimmedRole = draft.role?.trim();
        const payload: Draft = {
            name,
            body: draft.body,
            color: draft.color,
            ...(trimmedRole && trimmedRole !== target.role ? { role: trimmedRole } : {}),
        };
        try { onSave(target.agent, payload); onClose(); }
        catch (failure) { setError(failure instanceof FriendRevisionConflict ? t('friends.saveConflict') : t('friends.saveFailed')); }
    };
    return <Dialog open={Boolean(target)} onOpenChange={open => { if (!open) onClose(); }}>
        {/* A side panel that opens beside the friend, not a modal over
            everything: the page behind stays readable, and the panel is tall
            and narrow rather than short and centred. */}
        <DialogContent
            ref={popup}
            layerClassName="justify-end p-3"
            backdropProps={{ className: 'bg-transparent' }}
            className="oc-friend-customize h-full max-h-full w-[min(500px,100%)] max-w-none gap-5 overflow-y-auto p-5"
            data-testid="friend-customize"
        >
            <DialogHeader><DialogTitle>{t('friends.customizeTitle')}</DialogTitle><DialogDescription>{t('friends.customizeDescription')}</DialogDescription></DialogHeader>
            {draft && target && <form className="flex flex-col gap-4" onSubmit={save}>
                <div className="oc-friend-preview">
                    <HomeFriendAvatar key={`${draft.body}:${draft.color}`} body={draft.body} color={draft.color} className="size-28" label={t('friends.preview', { name: name || target.name })} />
                    <p className="text-sm text-muted-foreground">{draft.role?.trim() || target.role}</p>
                </div>
                <label className="flex flex-col gap-1.5 text-[13px] font-medium">{t('friends.name')}
                    <Input value={draft.name} maxLength={32} required autoFocus onChange={event => setDraft({ ...draft, name: event.target.value })} />
                </label>
                {target.folderLabel && <label className="flex flex-col gap-1.5 text-[13px] font-medium">Role & specialty
                    <Input value={draft.role ?? ''} maxLength={80} placeholder={target.role} onChange={event => setDraft({ ...draft, role: event.target.value })} />
                </label>}
                <fieldset className="flex flex-col gap-2"><legend className="mb-2 text-[13px] font-medium">{t('friends.body')}</legend>
                    <div className="oc-friend-body-grid">{FRIEND_BODIES.map((body, index) => <Button key={body} type="button" variant="chip" size="icon"
                        className="oc-friend-option size-14" aria-pressed={draft.body === body} aria-label={t('friends.bodyOption', { number: index + 1 })}
                        onClick={() => setDraft({ ...draft, body })}><HomeFriendAvatar body={body} color={draft.color} className="size-10" /></Button>)}</div>
                </fieldset>
                <fieldset className="flex flex-col gap-2"><legend className="mb-2 text-[13px] font-medium">{t('friends.color')}</legend>
                    <div className="flex flex-wrap gap-2">{FRIEND_COLORS.map((color, index) => <Button key={color} type="button" variant="chip" size="icon"
                        className="oc-friend-swatch size-9 rounded-full" aria-pressed={draft.color === color} aria-label={t('friends.colorOption', { number: index + 1 })}
                        onClick={() => setDraft({ ...draft, color })}><span aria-hidden="true" className="size-6 rounded-full" style={{ background: friendColorVariable(color) }} /></Button>)}</div>
                </fieldset>
                {memoryPath && (
                    <section className="flex flex-col gap-2">
                        <h4 className="text-[13px] font-medium">{t('friends.customizeMemory')}</h4>
                        <p className="text-xs text-muted-foreground">{t('friends.customizeMemoryHint')}</p>
                        <div className="max-h-72 overflow-y-auto rounded-lg border border-border/60 p-2">
                            <MemorySection projectPath={memoryPath} query="" />
                        </div>
                    </section>
                )}
                {error && <p role="alert" className="text-sm text-[var(--status-error-text)]">{error}</p>}
                <DialogFooter className="gap-2">
                    <Button type="button" variant="ghost" onClick={onClose}>{t('personalTools.cancel')}</Button>
                    <Button type="submit" disabled={!name}>{t('home.save')}</Button>
                </DialogFooter>
            </form>}
        </DialogContent>
    </Dialog>;
}
