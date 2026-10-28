import React from 'react';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SettingsFieldRow, SettingsSection } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { personalHomeSupported } from '@/lib/personal-home';
import { updateHomeOutlook, type HomeOutlookStatus } from '@/lib/personal-outlook';
import { useEnterpriseMode, useEnterprisePolicyStore } from '@/stores/useEnterprisePolicyStore';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';

const clientIdSchema = z.string().trim().uuid();

export function OutlookConnectionSection(): React.ReactNode {
    const { t } = useI18n();
    const blocked = useEnterpriseMode();
    const networkBlocked = useEnterprisePolicyStore((state) => state.networkAccessBlocked);
    const [runtime, setRuntime] = React.useState(getRuntimeKey);
    React.useEffect(() => subscribeRuntimeEndpointChanged(() => setRuntime(getRuntimeKey())), []);
    const supported = personalHomeSupported();
    const allowed = supported && !blocked && !networkBlocked;
    const [status, setStatus] = React.useState<HomeOutlookStatus | null>(null);
    const [clientId, setClientId] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState('');
    const generation = React.useRef(0);

    React.useEffect(() => {
        const revision = ++generation.current;
        setStatus(null);
        setClientId('');
        setError('');
        setBusy(false);
        if (supported) {
            void updateHomeOutlook({ op: 'status' }).then((next) => {
                if (generation.current !== revision) return;
                setStatus(next);
                setClientId(next.clientId);
            }).catch(() => { if (generation.current === revision) setError(t('outlook.error')); });
        }
        return () => { generation.current = revision + 1; };
    }, [supported, runtime, t]);

    const act = async (operation: Parameters<typeof updateHomeOutlook>[0]) => {
        const localOnly = operation.op === 'status' || operation.op === 'cancel' || operation.op === 'disconnect' || operation.op === 'native-disconnect';
        if (!supported || (!allowed && !localOnly) || busy) return;
        const revision = generation.current;
        setBusy(true);
        setError('');
        try {
            const next = await updateHomeOutlook(operation);
            if (generation.current === revision) { setStatus(next); setClientId(next.clientId); }
        } catch (failure) {
            if (generation.current === revision) setError(failure instanceof Error ? failure.message : t('outlook.error'));
        } finally { if (generation.current === revision) setBusy(false); }
    };

    if (!supported) return null;
    return <SettingsSection title="Outlook" info={t('outlook.setup')} settingsItem="integrations.outlook" contentClassName="space-y-4" headerAction={<Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void act({ op: 'status' })}>{t('home.refresh')}</Button>}>
        {!allowed ? <p className="text-sm text-muted-foreground">{t('outlook.blocked')}</p> : null}
        {status?.native.available ? <>
            <p className="text-xs text-muted-foreground">{t('outlook.nativeDescription')}</p>
            {status.native.accounts.map((account) => <p key={account.id} className="text-sm">{t('outlook.authorized', { address: account.address })}</p>)}
            <div className="flex flex-wrap gap-2">
                {allowed ? <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void act({ op: 'native-connect' })}>{busy ? t('common.loading') : t('outlook.nativeConnect')}</Button> : null}
                {status.native.accounts.length ? <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void act({ op: 'native-disconnect' })}>{t('outlook.disconnect')}</Button> : null}
            </div>
        </> : status ? <p className="text-xs text-muted-foreground">{t('outlook.nativeUnavailable')}</p> : null}
        <details><summary className="cursor-pointer text-sm">{t('outlook.advanced')}</summary><div className="space-y-4 pt-3">
        {status?.accounts.map((account) => <SettingsFieldRow key={account.address} label={t('outlook.authorized', { address: account.address })}>
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void act({ op: 'disconnect', address: account.address })}>{t('outlook.disconnect')}</Button>
        </SettingsFieldRow>)}
        {!allowed && status?.pending ? <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void act({ op: 'cancel' })}>{t('outlook.cancel')}</Button> : null}
        {allowed ? <>
            <p className="text-xs text-muted-foreground">{t('outlook.consent')}</p>
            <SettingsFieldRow label={t('outlook.appId')}>
                <Input className="h-8 max-w-[24rem]" aria-label={t('outlook.appId')} value={clientId} disabled={busy || Boolean(status?.accounts.length) || Boolean(status?.pending)} onChange={(event) => setClientId(event.target.value)} />
            </SettingsFieldRow>
            {status && !status.accounts.length && !status.pending ? <p className="text-xs text-muted-foreground">{t('outlook.empty')}</p> : null}
            {status?.pending ? <>
                <p className="text-sm" role="status">{t('outlook.instructions', { code: status.pending.code })}</p>
                <div className="flex flex-wrap items-center gap-2">
                    <a className="text-sm underline" href="https://microsoft.com/devicelogin" target="_blank" rel="noreferrer">{t('outlook.signIn')}</a>
                    <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void act({ op: 'check' })}>{busy ? t('common.loading') : t('outlook.check')}</Button>
                    <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void act({ op: 'cancel' })}>{t('outlook.cancel')}</Button>
                </div>
            </> : <Button type="button" variant="outline" size="sm" disabled={busy || !status || !clientIdSchema.safeParse(clientId).success || status.accounts.length >= 5} onClick={() => void act({ op: 'connect', clientId: clientId.trim() })}>{busy ? t('common.loading') : t('outlook.signIn')}</Button>}
        </> : null}
        </div></details>
        {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    </SettingsSection>;
}
