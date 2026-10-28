import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import {
    configureImessage,
    imessageSupported,
    readImessageStatus,
    resetImessageFriend,
    sendMorningImessage,
    testImessage,
    type ImessageStatus,
} from '@/lib/imessage';

type Access = ImessageStatus['readAccess'];

const accessLabel = (access: Access, kind: 'read' | 'send') => {
    if (access === 'granted') return kind === 'read' ? 'Messages readable' : 'Messages ready';
    if (access === 'denied') return 'Permission denied';
    if (access === 'no-account') return 'No iMessage account';
    if (access === 'error') return 'Unavailable';
    return 'Checking…';
};

/** Texting a friend: your own numbers reach this Mac's Open Carter, which answers
 *  as the friend you name with an @, in that friend's folder. */
export function ImessageSection(): React.ReactNode {
    const supported = imessageSupported();
    const [status, setStatus] = React.useState<ImessageStatus | null>(null);
    const [handlesDraft, setHandlesDraft] = React.useState('');
    const [error, setError] = React.useState('');
    const [notice, setNotice] = React.useState('');
    const [busy, setBusy] = React.useState<'load' | 'save' | 'test' | 'toggle' | 'reset' | 'morning' | ''>('load');

    const apply = (next: ImessageStatus) => {
        setStatus(next);
        setHandlesDraft(next.handles.join(', '));
    };

    React.useEffect(() => {
        if (!supported) { setBusy(''); return; }
        let cancelled = false;
        void readImessageStatus()
            .then((next) => { if (!cancelled) { apply(next); setBusy(''); } })
            .catch((failure) => { if (!cancelled) { setError(failure instanceof Error ? failure.message : 'Could not read the texting settings.'); setBusy(''); } });
        return () => { cancelled = true; };
    }, [supported]);

    const save = async (patch: Parameters<typeof configureImessage>[0]) => {
        setError('');
        setNotice('');
        setBusy('save');
        try {
            apply(await configureImessage(patch));
        } catch (failure) {
            setError(failure instanceof Error ? failure.message : 'Could not save.');
        } finally {
            setBusy('');
        }
    };

    const toggle = async (enabled: boolean) => {
        setError('');
        setNotice('');
        setBusy('toggle');
        try {
            apply(await configureImessage({ enabled }));
        } catch (failure) {
            setError(failure instanceof Error ? failure.message : 'Could not change texting.');
        } finally {
            setBusy('');
        }
    };

    const saveHandles = () => save({
        handles: handlesDraft.split(/[,\n]/).map((entry) => entry.trim()).filter(Boolean),
    });

    const sendTest = async () => {
        setError('');
        setNotice('');
        setBusy('test');
        try {
            const result = await testImessage(status?.handles[0]);
            setNotice(`A test text is on its way to ${result.handle}.`);
        } catch (failure) {
            setError(failure instanceof Error ? failure.message : 'Messages did not accept the text.');
        } finally {
            setBusy('');
            void readImessageStatus().then(apply).catch(() => {});
        }
    };

    const sendMorningNow = async () => {
        setError('');
        setNotice('');
        setBusy('morning');
        try {
            const result = await sendMorningImessage();
            setNotice(`Follow-ups sent to ${result.handle}.`);
        } catch (failure) {
            setError(failure instanceof Error ? failure.message : 'The follow-up text did not send.');
        } finally {
            setBusy('');
            void readImessageStatus().then(apply).catch(() => {});
        }
    };

    const reset = async (friend: string, label: string) => {
        setError('');
        setBusy('reset');
        try {
            apply(await resetImessageFriend(friend));
            setNotice(`The next text to ${label} starts a fresh chat.`);
        } catch (failure) {
            setError(failure instanceof Error ? failure.message : 'Could not reset that friend.');
        } finally {
            setBusy('');
        }
    };

    const ready = status?.readAccess === 'granted' && status?.sendAccess === 'granted';
    const friends = status?.friends ?? [];
    const defaultFriend = status?.defaultFriend ?? '';

    return <SettingsSection
        title="Texting"
        info="Text this Mac and Open Carter answers as the friend you name. Only the numbers you allow are read; everything else stays untouched."
        divider
        settingsItem="integrations.imessage"
        contentClassName="space-y-3"
    >
        {!supported ? <p className="text-sm text-muted-foreground">Texting is available in the desktop app.</p> : <>
            <div className="flex items-start gap-3 rounded-md border border-border px-3 py-2">
                <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">Answer texts on this Mac</p>
                    <p className="text-xs text-muted-foreground">
                        {status?.running ? 'Listening for new texts.' : status?.enabled ? 'On, waiting for an allowed number.' : 'Off. Nothing is read and nothing is sent.'}
                    </p>
                </div>
                <Switch
                    checked={status?.enabled === true}
                    disabled={busy !== '' || !supported}
                    onCheckedChange={(checked) => void toggle(checked === true)}
                    aria-label="Answer texts on this Mac"
                />
            </div>

            <div className="space-y-1">
                <label className="text-xs font-medium" htmlFor="imessage-handles">Numbers allowed to text Open Carter</label>
                <Input
                    id="imessage-handles"
                    value={handlesDraft}
                    onChange={(event) => setHandlesDraft(event.target.value)}
                    onBlur={() => { if (handlesDraft !== (status?.handles.join(', ') ?? '')) void saveHandles(); }}
                    placeholder="+1 856 689 2599, you@example.com"
                    autoComplete="off"
                    spellCheck={false}
                />
                <p className="text-xs text-muted-foreground">Your own number and addresses first. A shared thread answers only when a text names a friend.</p>
            </div>

            <div className="space-y-1">
                <label className="text-xs font-medium" htmlFor="imessage-default-friend">Who answers a text that names nobody</label>
                <select
                    id="imessage-default-friend"
                    value={defaultFriend}
                    disabled={busy !== '' || friends.length === 0}
                    onChange={(event) => void save({ defaultFriend: event.target.value || null })}
                    className="h-9 w-full rounded-md border border-border bg-transparent px-3 text-sm text-foreground outline-none focus:border-[var(--interactive-focus-ring)]"
                >
                    <option value="">All Chats</option>
                    {friends.filter((friend) => friend.key !== 'all-chats').map((friend) => (
                        <option key={friend.key} value={friend.key}>{friend.label}</option>
                    ))}
                </select>
                <p className="text-xs text-muted-foreground">Rules, memory, model and style come from the friend's own folder.</p>
            </div>

            {friends.length > 0 ? <div className="space-y-1">
                <p className="text-xs font-medium">Friends you can name with @</p>
                <ul className="divide-y divide-border rounded-md border border-border">
                    {friends.map((friend) => {
                        const primary = friend.handles.find((alias) => !alias.includes('(')) || friend.handles[0] || friend.label;
                        const others = friend.handles.filter((alias) => alias !== primary);
                        return (
                        <li key={friend.key} className="flex items-center gap-3 px-3 py-1.5">
                            <div className="min-w-0 flex-1">
                                <p className="truncate text-sm text-foreground">{`@${primary}`}</p>
                                <p className="truncate text-xs text-muted-foreground">
                                    {friend.key === 'all-chats'
                                        ? 'The chats root, with its own memory'
                                        : friend.zdr
                                            ? 'Stays on this Mac; never mirrored into a notification'
                                            : others.map((alias) => `@${alias}`).join('  ') || friend.label}
                                </p>
                            </div>
                            <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                disabled={busy !== ''}
                                onClick={() => void reset(friend.key, friend.label)}
                                title={`Start a fresh chat the next time ${friend.label} answers`}
                            >
                                Start fresh
                            </Button>
                        </li>
                        );
                    })}
                </ul>
            </div> : null}

            <div className="space-y-2 rounded-md border border-border px-3 py-2">
                <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">Text me my follow-ups each morning</p>
                        <p className="text-xs text-muted-foreground">What is overdue, due today and close, from the commitments list. One text a day.</p>
                    </div>
                    <Switch
                        checked={status?.morning.enabled === true}
                        disabled={busy !== '' || status?.enabled !== true}
                        onCheckedChange={(checked) => void save({ morningEnabled: checked === true })}
                        aria-label="Text me my follow-ups each morning"
                    />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <label className="text-xs text-muted-foreground" htmlFor="imessage-morning-time">Time</label>
                    <Input
                        id="imessage-morning-time"
                        type="time"
                        className="h-8 w-28"
                        value={status?.morning.time ?? '08:05'}
                        disabled={busy !== ''}
                        onChange={(event) => {
                            const value = event.target.value;
                            if (/^\d{2}:\d{2}$/.test(value)) void save({ morningTime: value });
                        }}
                    />
                    <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={busy !== '' || status?.enabled !== true}
                        onClick={() => void sendMorningNow()}
                    >
                        {busy === 'morning' ? 'Sending…' : 'Send it now'}
                    </Button>
                </div>
            </div>

            <div className="flex items-start gap-3 rounded-md border border-border px-3 py-2">
                <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">Also text me finished work</p>
                    <p className="text-xs text-muted-foreground">A background completion also arrives as a text.</p>
                </div>
                <Switch
                    checked={status?.forwardNotifications === true}
                    disabled={busy !== '' || status?.enabled !== true}
                    onCheckedChange={(checked) => void save({ forwardNotifications: checked === true })}
                    aria-label="Also text me finished work"
                />
            </div>

            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>{accessLabel(status?.readAccess ?? 'unknown', 'read')}</span>
                <span aria-hidden>·</span>
                <span>{accessLabel(status?.sendAccess ?? 'unknown', 'send')}</span>
                <span aria-hidden>·</span>
                <span>{status?.conversations ?? 0} {(status?.conversations ?? 0) === 1 ? 'conversation' : 'conversations'}</span>
            </div>

            {status?.permissionHint ? <p className="text-xs text-status-warning">{status.permissionHint}</p> : null}
            {status?.lastError ? <p className="text-xs text-muted-foreground">Last problem: {status.lastError}</p> : null}
            {notice ? <p className="text-xs text-muted-foreground">{notice}</p> : null}
            {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}

            <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" variant="outline" disabled={busy !== '' || !ready || status?.enabled !== true} onClick={() => void sendTest()}>
                    {busy === 'test' ? 'Sending…' : 'Send a test text'}
                </Button>
            </div>

            <p className="text-xs text-muted-foreground">
                Reading incoming texts needs Full Disk Access for Open Carter; sending uses Messages. Both run on this Mac only.
            </p>
        </>}
    </SettingsSection>;
}
