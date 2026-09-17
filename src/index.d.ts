export type HoneyNotifyPlatform = 'ios' | 'android';
export type HoneyNotifyInterruptionLevel = 'passive' | 'active' | 'time_sensitive' | 'critical';

export interface HoneyNotifyRegistrationOptions {
  externalUserId?: string;
  identityToken?: string;
  tags?: Record<string, string>;
  locale?: string;
  timezone?: string;
  appVersion?: string;
  deviceModel?: string;
  osVersion?: string;
  includeCriticalAlerts?: boolean;
}

export interface HoneyNotifyOptions {
  clientKey: string;
  baseURL?: string;
}

export interface HoneyNotifyNotification {
  id: string | null;
  clickURL: string | null;
  imageURL: string | null;
  interruptionLevel: HoneyNotifyInterruptionLevel;
  channelId: string;
  data: Record<string, string>;
}

export class HoneyNotifyError extends Error {
  status: number;
}

export class HoneyNotify {
  constructor(options: HoneyNotifyOptions);
  requestPermissionAndRegister(options?: HoneyNotifyRegistrationOptions): Promise<string | null>;
  registerCurrentToken(options?: HoneyNotifyRegistrationOptions): Promise<string>;
  registerToken(token: string, options?: HoneyNotifyRegistrationOptions): Promise<string>;
  startTokenRefreshListener(options?: {
    identityTokenProvider?: (externalUserId: string) => Promise<string | undefined>;
    onError?: (error: unknown) => void;
  }): () => void;
  identify(externalUserId: string, options?: Omit<HoneyNotifyRegistrationOptions, 'externalUserId'>): Promise<string>;
  logout(): Promise<void>;
  track(event: string, options?: {
    notificationId?: string;
    metadata?: Record<string, string>;
    occurredAt?: string;
  }): Promise<void>;
  notificationFrom(remoteMessage: { data?: Record<string, string> } | Record<string, string>): HoneyNotifyNotification;
  trackReceived(remoteMessage: { data?: Record<string, string> } | Record<string, string>): Promise<void>;
  trackOpened(remoteMessage: { data?: Record<string, string> } | Record<string, string>, actionId?: string): Promise<void>;
  permissionStatus(): Promise<number>;
}
