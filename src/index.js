'use strict';

const STORAGE_PREFIX = '@honeynotify/';
const STANDARD_EVENTS = new Set([
  'received',
  'confirmed_delivered',
  'opened',
  'clicked',
  'dismissed',
]);

class HoneyNotifyError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'HoneyNotifyError';
    this.status = status;
  }
}

class HoneyNotify {
  constructor(options) {
    if (!options || !options.clientKey || !options.clientKey.startsWith('ps_public_')) {
      throw new HoneyNotifyError('A HoneyNotify public client key beginning ps_public_ is required');
    }

    this.baseURL = (options.baseURL || 'https://api.honeynotify.com').replace(/\/$/, '');
    this.clientKey = options.clientKey;
    const reactNative = options.platform ? null : require('react-native');
    this.messaging = options.messaging || require('@react-native-firebase/messaging').default();
    this.storage = options.storage || require('@react-native-async-storage/async-storage').default;
    this.fetch = options.fetch || global.fetch;
    this.platform = options.platform || reactNative.Platform.OS;
    this.platformVersion = Number(options.platformVersion || (reactNative && reactNative.Platform.Version) || 0);
    this.permissions = options.permissions || (reactNative && reactNative.PermissionsAndroid);

    if (typeof this.fetch !== 'function') {
      throw new HoneyNotifyError('A fetch implementation is required');
    }
  }

  async requestPermissionAndRegister(options = {}) {
    if (this.platform === 'ios') {
      await this.messaging.registerDeviceForRemoteMessages();
      const status = await this.messaging.requestPermission({
        alert: true,
        badge: true,
        sound: true,
        criticalAlert: options.includeCriticalAlerts === true,
      });
      if (![1, 2, 3].includes(status)) return null;
    } else if (this.platform === 'android' && this.platformVersion >= 33 && this.permissions) {
      const permission = this.permissions.PERMISSIONS.POST_NOTIFICATIONS;
      const status = await this.permissions.request(permission);
      if (status !== this.permissions.RESULTS.GRANTED) return null;
    }

    return this.registerCurrentToken(options);
  }

  async registerCurrentToken(options = {}) {
    if (this.platform === 'ios') {
      await this.messaging.registerDeviceForRemoteMessages();
    }
    const token = await this.currentProviderToken();
    return this.registerToken(token, options);
  }

  async registerToken(token, options = {}) {
    if (!token) {
      throw new HoneyNotifyError(`No ${this.platform === 'ios' ? 'APNs' : 'FCM'} token is available`);
    }

    const payload = {
      platform: this.platformName(),
      push_token: token,
      tags: options.tags || {},
    };
    if (options.externalUserId) payload.external_user_id = options.externalUserId;
    if (options.identityToken) payload.identity_token = options.identityToken;
    if (options.locale) payload.locale = options.locale;
    if (options.timezone) payload.timezone = options.timezone;
    if (options.appVersion) payload.app_version = options.appVersion;
    if (options.deviceModel) payload.device_model = options.deviceModel;
    if (options.osVersion) payload.os_version = options.osVersion;

    const response = await this.request('/v1/devices/register', 'POST', payload);
    if (!response.device_id) {
      throw new HoneyNotifyError('HoneyNotify returned an invalid registration response');
    }

    await Promise.all([
      this.storage.setItem(`${STORAGE_PREFIX}deviceId`, response.device_id),
      this.storage.setItem(`${STORAGE_PREFIX}pushToken`, token),
      this.storeOptional('externalUserId', options.externalUserId),
      this.storage.setItem(`${STORAGE_PREFIX}tags`, JSON.stringify(options.tags || {})),
    ]);
    return response.device_id;
  }

  startTokenRefreshListener(options = {}) {
    return this.messaging.onTokenRefresh(async () => {
      try {
        const token = await this.currentProviderToken();
        const [externalUserId, tagsJson] = await Promise.all([
          this.storage.getItem(`${STORAGE_PREFIX}externalUserId`),
          this.storage.getItem(`${STORAGE_PREFIX}tags`),
        ]);
        const identityToken = externalUserId && options.identityTokenProvider
          ? await options.identityTokenProvider(externalUserId)
          : undefined;
        await this.registerToken(token, {
          externalUserId: externalUserId || undefined,
          identityToken,
          tags: parseObject(tagsJson),
        });
      } catch (error) {
        if (options.onError) options.onError(error);
      }
    });
  }

  async identify(externalUserId, options = {}) {
    if (!externalUserId) {
      throw new HoneyNotifyError('externalUserId is required');
    }
    const token = await this.storage.getItem(`${STORAGE_PREFIX}pushToken`);
    if (!token) {
      throw new HoneyNotifyError('No push token is registered');
    }
    return this.registerToken(token, {
      ...options,
      externalUserId,
    });
  }

  async logout() {
    const deviceId = await this.storage.getItem(`${STORAGE_PREFIX}deviceId`);
    if (deviceId) {
      await this.request(`/v1/devices/${encodeURIComponent(deviceId)}`, 'DELETE');
    }
    await this.storage.multiRemove([
      `${STORAGE_PREFIX}deviceId`,
      `${STORAGE_PREFIX}pushToken`,
      `${STORAGE_PREFIX}externalUserId`,
      `${STORAGE_PREFIX}tags`,
    ]);
  }

  async track(event, options = {}) {
    if (!event) {
      throw new HoneyNotifyError('event is required');
    }
    const deviceId = await this.storage.getItem(`${STORAGE_PREFIX}deviceId`);
    const payload = {
      event_type: STANDARD_EVENTS.has(event) ? event : 'custom',
      occurred_at: options.occurredAt || new Date().toISOString(),
      metadata: options.metadata || {},
    };
    if (!STANDARD_EVENTS.has(event)) payload.event_name = event;
    if (options.notificationId) payload.notification_id = options.notificationId;
    if (deviceId) payload.device_id = deviceId;
    await this.request('/v1/events', 'POST', payload);
  }

  notificationFrom(remoteMessage) {
    const data = (remoteMessage && remoteMessage.data) || remoteMessage || {};
    const interruptionLevel = ['passive', 'active', 'time_sensitive', 'critical'].includes(
      data.honeynotify_interruption_level,
    ) ? data.honeynotify_interruption_level : 'active';
    return {
      id: data.honeynotify_notification_id || null,
      clickURL: data.honeynotify_click_url || null,
      imageURL: data.honeynotify_image_url || null,
      interruptionLevel,
      channelId: data.honeynotify_android_channel_id || `honeynotify_${interruptionLevel}`,
      data,
    };
  }

  async trackReceived(remoteMessage) {
    return this.track('received', {
      notificationId: this.notificationFrom(remoteMessage).id || undefined,
    });
  }

  async trackOpened(remoteMessage, actionId) {
    return this.track(actionId ? 'clicked' : 'opened', {
      notificationId: this.notificationFrom(remoteMessage).id || undefined,
      metadata: actionId ? { action_id: actionId } : {},
    });
  }

  async permissionStatus() {
    if (this.platform === 'android') {
      if (this.platformVersion < 33 || !this.permissions) return 1;
      const granted = await this.permissions.check(
        this.permissions.PERMISSIONS.POST_NOTIFICATIONS,
      );
      return granted ? 1 : 0;
    }
    return this.messaging.hasPermission();
  }

  async currentProviderToken() {
    if (this.platform === 'ios') {
      const token = await this.messaging.getAPNSToken();
      if (!token) {
        throw new HoneyNotifyError('No APNs token is available; run on a signed physical device and retry');
      }
      return token;
    }
    if (this.platform === 'android') return this.messaging.getToken();
    throw new HoneyNotifyError('The React Native SDK supports iOS and Android only');
  }

  platformName() {
    if (this.platform === 'ios' || this.platform === 'android') return this.platform;
    throw new HoneyNotifyError('The React Native SDK supports iOS and Android only');
  }

  async storeOptional(key, value) {
    if (value) return this.storage.setItem(`${STORAGE_PREFIX}${key}`, value);
    return this.storage.removeItem(`${STORAGE_PREFIX}${key}`);
  }

  async request(path, method, body) {
    let response;
    let responseBody = {};
    for (let attempt = 0; attempt < 3; attempt += 1) {
      response = await this.fetch(`${this.baseURL}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.clientKey}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      responseBody = text ? parseObject(text) : {};
      if (response.ok) return responseBody;
      if (response.status !== 429 && response.status < 500) break;
      if (attempt < 2) await delay(250 * (attempt + 1));
    }
    const message = responseBody.error && responseBody.error.message
      ? responseBody.error.message
      : 'HoneyNotify request failed';
    throw new HoneyNotifyError(message, response ? response.status : 0);
  }
}

function parseObject(value) {
  if (!value) return {};
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

module.exports = { HoneyNotify, HoneyNotifyError };
