import { create } from 'zustand';
import { fetchOpenRouterBalance, type OpenRouterBalance } from '@/lib/folio/credits';
import { readKey, readSecret, writeSecret } from './chatStore';
import { nativeGet } from './host';

/** Optional OpenRouter management key, only for showing the account balance. */
export const BALANCE_KEY = 'folio.key.openrouter-balance';

interface BalanceState {
  balance?: OpenRouterBalance;
  error?: string;
  hasKey: boolean;
  refresh: () => Promise<void>;
  setBalanceKey: (value: string) => Promise<void>;
}

let inFlight: Promise<void> | undefined;

export const useBalanceStore = create<BalanceState>((set, get) => ({
  hasKey: false,
  refresh: async () => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const key = (await readSecret(BALANCE_KEY)) || (await readKey('openrouter'));
        set({ hasKey: Boolean(key) });
        if (!key) { set({ balance: undefined, error: undefined }); return; }
        set({ balance: await fetchOpenRouterBalance(key, nativeGet), error: undefined });
      } catch (error) {
        // Keep the last known balance on screen; say why it could not refresh.
        set({ error: error instanceof Error ? error.message : String(error) });
      } finally { inFlight = undefined; }
    })();
    return inFlight;
  },
  setBalanceKey: async (value) => { await writeSecret(BALANCE_KEY, value); await get().refresh(); },
}));
