import './ZdrLock.css';
import React from 'react';
import { useZdrLockStore } from '@/stores/useZdrLockStore';
import { ZdrPinEntry } from './ZdrPinEntry';

type Flow =
  | { kind: 'idle' }
  | { kind: 'set'; step: 'new' | 'confirm'; first?: string; current?: string; change: boolean }
  | { kind: 'remove' }
  | { kind: 'change-current' };

/** Set, change or remove the PIN, or lock the guarded folders right now. Shown in a ZDR friend's panel. */
export function ZdrPinSettings() {
  const pinSet = useZdrLockStore((state) => state.pinSet);
  const unlocked = useZdrLockStore((state) => state.unlocked);
  const [flow, setFlow] = React.useState<Flow>({ kind: 'idle' });
  const [notice, setNotice] = React.useState<string | null>(null);
  const done = (message: string) => { setFlow({ kind: 'idle' }); setNotice(message); };
  const cancel = () => { setFlow({ kind: 'idle' }); setNotice(null); };

  if (flow.kind === 'change-current') {
    return <ZdrPinEntry key="change-current" title="Current PIN" onCancel={cancel}
      onSubmit={async (pin) => { setFlow({ kind: 'set', step: 'new', current: pin, change: true }); return { ok: true }; }} />;
  }
  if (flow.kind === 'remove') {
    return <ZdrPinEntry key="remove" title="Enter your PIN to remove it" onCancel={cancel}
      onSubmit={async (pin) => {
        const result = await useZdrLockStore.getState().clearPin(pin);
        if (result.ok) done('The PIN is removed. ZDR folders open without one.');
        return result;
      }} />;
  }
  if (flow.kind === 'set') {
    const { step, first, current, change } = flow;
    return <ZdrPinEntry key={`set-${step}`} title={step === 'new' ? (change ? 'Choose a new PIN' : 'Choose a four-digit PIN') : 'Type it again to confirm'} onCancel={cancel}
      onSubmit={async (pin) => {
        if (step === 'new') { setFlow({ kind: 'set', step: 'confirm', first: pin, current, change }); return { ok: true }; }
        if (pin !== first) { setFlow({ kind: 'set', step: 'new', current, change }); setNotice('Those did not match. Start again.'); return { ok: true }; }
        const result = await useZdrLockStore.getState().setPin(pin, current);
        if (result.ok) done(change ? 'Your PIN is changed.' : 'PIN set. ZDR folders now ask for it.');
        else { setFlow({ kind: 'idle' }); setNotice(result.error ?? 'The PIN could not be saved.'); }
        return { ok: true };
      }} />;
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-muted-foreground">{pinSet ? 'A PIN guards ZDR folders.' : 'ZDR folders open without a PIN.'}</span>
      {!pinSet && <button type="button" className="oc-zdr-button" onClick={() => { setNotice(null); setFlow({ kind: 'set', step: 'new', change: false }); }}>Set a PIN</button>}
      {pinSet && <button type="button" className="oc-zdr-button" onClick={() => { setNotice(null); setFlow({ kind: 'change-current' }); }}>Change PIN</button>}
      {pinSet && <button type="button" className="oc-zdr-button" onClick={() => { setNotice(null); setFlow({ kind: 'remove' }); }}>Remove PIN</button>}
      {pinSet && unlocked && <button type="button" className="oc-zdr-button" onClick={() => useZdrLockStore.getState().lock()}>Lock now</button>}
      {notice && <span role="status" className="text-muted-foreground">{notice}</span>}
    </div>
  );
}
