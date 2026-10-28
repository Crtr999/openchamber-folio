import { z } from 'zod';
import { invokeDesktop } from '@/lib/desktop';
import { personalHomeSupported } from '@/lib/personal-home';

const statusSchema = z.object({
    clientId: z.string(),
    accounts: z.array(z.object({ address: z.string().email() })).max(5),
    pending: z.object({ code: z.string(), expiresAt: z.number(), nextCheckAt: z.number() }).nullable(),
    native: z.object({ available: z.boolean(), access: z.enum(['connected', 'not-connected', 'unsupported', 'error']), accounts: z.array(z.object({ id: z.string(), address: z.string().email() })).max(50) }).default({ available: false, access: 'unsupported', accounts: [] }),
});
export type HomeOutlookStatus = z.infer<typeof statusSchema>;
type OutlookOperation = { op: 'status' | 'check' | 'cancel' | 'native-connect' | 'native-disconnect' } | { op: 'connect'; clientId: string } | { op: 'disconnect'; address: string };

export const updateHomeOutlook = async (operation: OutlookOperation): Promise<HomeOutlookStatus> => {
    if (!personalHomeSupported()) throw new Error('Outlook connections require the local desktop app.');
    return statusSchema.parse(await invokeDesktop('desktop_personal_home', { action: 'outlook', ...operation }));
};
