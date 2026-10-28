import './ZdrLock.css';
import React from 'react';
import { Icon } from '@/components/icon/Icon';
import type { ZdrLockResult } from '@/lib/zdrLock';

const secondsLeft = (until: number) => Math.max(0, Math.ceil((until - Date.now()) / 1000));

/** Four dots filled from the keyboard. It submits itself at the fourth digit. */
export function ZdrPinEntry({ title, hint, onSubmit, onCancel, cancelLabel = 'Cancel' }: {
  title: string;
  hint?: string;
  onSubmit: (pin: string) => Promise<ZdrLockResult>;
  onCancel?: () => void;
  cancelLabel?: string;
}) {
  const [pin, setPin] = React.useState('');
  const [message, setMessage] = React.useState<string | null>(null);
  const [errored, setErrored] = React.useState(false);
  const [blockedUntil, setBlockedUntil] = React.useState(0);
  const [, setTick] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const busyRef = React.useRef(false);
  const blocked = blockedUntil > Date.now();

  React.useEffect(() => { inputRef.current?.focus(); }, []);
  React.useEffect(() => {
    if (!blocked) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), 500);
    return () => window.clearInterval(timer);
  }, [blocked]);

  const submit = async (value: string) => {
    if (busyRef.current) return;
    busyRef.current = true;
    const result = await onSubmit(value);
    busyRef.current = false;
    if (result.ok) return;
    setPin('');
    setErrored(true);
    window.setTimeout(() => setErrored(false), 400);
    if (result.retryAfterMs && result.retryAfterMs > 0) setBlockedUntil(Date.now() + result.retryAfterMs);
    setMessage(result.error ?? 'That PIN is not right.');
    inputRef.current?.focus();
  };

  const onChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (blocked) return;
    const next = event.target.value.replace(/\D/g, '').slice(0, 4);
    setPin(next);
    setMessage(null);
    if (next.length === 4) void submit(next);
  };

  return (
    <div className="oc-zdr-card" onClick={() => inputRef.current?.focus()}>
      <Icon name="lock" className="oc-zdr-lock-icon" />
      <div className="oc-zdr-title">{title}</div>
      <div className="oc-zdr-dots" data-error={errored ? 'true' : undefined} aria-hidden="true">
        {[0, 1, 2, 3].map((index) => <span key={index} className="oc-zdr-dot" data-filled={index < pin.length ? 'true' : undefined} />)}
      </div>
      <input ref={inputRef} className="oc-zdr-input" type="password" inputMode="numeric" autoComplete="off" maxLength={4} value={pin} onChange={onChange} aria-label="Four-digit PIN" />
      <div className="oc-zdr-sub" role="status" aria-live="polite">
        {blocked ? `Too many tries. Wait ${secondsLeft(blockedUntil)}s.` : (message ?? hint ?? '')}
      </div>
      {onCancel && <div className="oc-zdr-actions"><button type="button" className="oc-zdr-button" onClick={onCancel}>{cancelLabel}</button></div>}
    </div>
  );
}
