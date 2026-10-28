import React from 'react';
import { Button } from '@/components/ui/button';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { personalHomeSupported, readHomeCalendar, readHomeReminders } from '@/lib/personal-home';
import { OutlookConnectionSection } from './OutlookConnectionSection';

type Access = 'unknown' | 'connected' | 'not-connected' | 'unsupported';

/** Calendar and Reminders are the Mac apps this build can actually open. The rest are named so they are not mistaken for connected. */
export function MacAppsSection(): React.ReactNode {
    const supported = personalHomeSupported();
    const [calendar, setCalendar] = React.useState<Access>('unknown');
    const [reminders, setReminders] = React.useState<Access>('unknown');
    const [error, setError] = React.useState('');
    const [busy, setBusy] = React.useState<'calendar' | 'reminders' | ''>('');

    React.useEffect(() => {
        if (!supported) return;
        let cancelled = false;
        void Promise.all([readHomeCalendar(), readHomeReminders()]).then(([nextCalendar, nextReminders]) => {
            if (cancelled) return;
            setCalendar(nextCalendar.access);
            setReminders(nextReminders.access);
        }).catch(() => { if (!cancelled) setError('Could not read Mac app access.'); });
        return () => { cancelled = true; };
    }, [supported]);

    const connect = async (app: 'calendar' | 'reminders') => {
        setBusy(app);
        setError('');
        try {
            const next = app === 'calendar' ? await readHomeCalendar(true) : await readHomeReminders(true);
            if (app === 'calendar') setCalendar(next.access);
            else setReminders(next.access);
            if (next.access !== 'connected') setError(next.error || 'macOS did not grant access. Allow it in System Settings if you still want this friend to use it.');
        } catch (failure) {
            setError(failure instanceof Error ? failure.message : 'Could not connect.');
        } finally {
            setBusy('');
        }
    };

    return <><SettingsSection title="Mac apps" info="A friend may use an app only after you connect it here, and only for the folders you leave it on." divider settingsItem="integrations.mac-apps" contentClassName="space-y-3">
        {!supported ? <p className="text-sm text-muted-foreground">Mac apps are available in the desktop app.</p> : <>
            <MacAppRow name="Calendar" detail="Agenda and events you choose to save." access={calendar} busy={busy === 'calendar'} onConnect={() => void connect('calendar')} />
            <MacAppRow name="Reminders" detail="Incomplete reminders due this week. Checking one completes it." access={reminders} busy={busy === 'reminders'} onConnect={() => void connect('reminders')} />
            <p className="text-xs text-muted-foreground">Mail, Notes, Contacts, Location, and Home are not connected. This build does not read them. Messages is used only for texting below.</p>
            {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
        </>}
    </SettingsSection><OutlookConnectionSection /></>;
}

function MacAppRow({ name, detail, access, busy, onConnect }: { name: string; detail: string; access: Access; busy: boolean; onConnect: () => void }): React.ReactNode {
    const connected = access === 'connected';
    return <div className="flex items-center gap-3 rounded-md border border-border px-3 py-2">
        <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{name}</p>
            <p className="text-xs text-muted-foreground">{detail}</p>
        </div>
        <span className="text-xs text-muted-foreground">{connected ? 'Connected' : access === 'unsupported' ? 'Unavailable' : 'Not connected'}</span>
        {connected ? null : <Button type="button" size="sm" variant="outline" disabled={busy || access === 'unsupported'} onClick={onConnect}>{busy ? 'Waiting…' : 'Connect'}</Button>}
    </div>;
}
