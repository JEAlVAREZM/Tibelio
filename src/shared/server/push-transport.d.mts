export function pushConfiguration(env?: NodeJS.ProcessEnv): { publicKey: string; privateKey: string; subject: string } | null;
export function validPushEndpoint(endpoint: string): boolean;
export function sendPush(subscription: { endpoint: string; keys: { p256dh: string; auth: string } }, send?: (...args: unknown[]) => Promise<unknown>): Promise<{ accepted: boolean; expired: boolean }>;
