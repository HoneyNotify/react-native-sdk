'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { HoneyNotify, HoneyNotifyError } = require('../src');

function storage() {
  const values = new Map();
  return {
    getItem: async (key) => values.get(key) || null,
    setItem: async (key, value) => { values.set(key, value); },
    removeItem: async (key) => { values.delete(key); },
    multiRemove: async (keys) => { keys.forEach((key) => values.delete(key)); },
    values,
  };
}

function messaging(token = 'apns-token') {
  return {
    registerDeviceForRemoteMessages: async () => {},
    requestPermission: async () => 1,
    getAPNSToken: async () => token,
    getToken: async () => 'fcm-token',
    hasPermission: async () => 1,
    onTokenRefresh: () => () => {},
  };
}

test('registers the APNs token and stores device state', async () => {
  const state = storage();
  let request;
  const honey = new HoneyNotify({
    clientKey: 'ps_public_test',
    platform: 'ios',
    messaging: messaging(),
    storage: state,
    fetch: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200, text: async () => '{"device_id":"device-1"}' };
    },
  });

  const id = await honey.requestPermissionAndRegister({
    externalUserId: 'customer-1',
    tags: { plan: 'pro' },
  });
  assert.equal(id, 'device-1');
  assert.equal(request.url, 'https://api.honeynotify.com/v1/devices/register');
  assert.deepEqual(JSON.parse(request.options.body), {
    platform: 'ios',
    push_token: 'apns-token',
    tags: { plan: 'pro' },
    external_user_id: 'customer-1',
  });
  assert.equal(state.values.get('@honeynotify/deviceId'), 'device-1');
});

test('uses FCM on Android and maps custom events', async () => {
  const state = storage();
  const requests = [];
  const honey = new HoneyNotify({
    clientKey: 'ps_public_test',
    platform: 'android',
    messaging: messaging(),
    storage: state,
    fetch: async (url, options) => {
      requests.push({ url, body: options.body && JSON.parse(options.body) });
      return {
        ok: true,
        status: 200,
        text: async () => url.endsWith('/register') ? '{"device_id":"device-2"}' : '{}',
      };
    },
  });
  await honey.registerCurrentToken();
  await honey.track('checkout.completed', { metadata: { order_id: '42' } });
  assert.equal(requests[0].body.push_token, 'fcm-token');
  assert.equal(requests[1].body.event_type, 'custom');
  assert.equal(requests[1].body.event_name, 'checkout.completed');
  assert.equal(requests[1].body.device_id, 'device-2');
});

test('parses lifecycle payloads and normalizes unknown levels', () => {
  const honey = new HoneyNotify({
    clientKey: 'ps_public_test',
    platform: 'android',
    messaging: messaging(),
    storage: storage(),
    fetch: async () => ({ ok: true, status: 200, text: async () => '{}' }),
  });
  const notification = honey.notificationFrom({ data: {
    honeynotify_notification_id: 'notification-1',
    honeynotify_interruption_level: 'unknown',
  } });
  assert.equal(notification.id, 'notification-1');
  assert.equal(notification.interruptionLevel, 'active');
  assert.equal(notification.channelId, 'honeynotify_active');
});

test('does not accept unsupported platforms', async () => {
  const honey = new HoneyNotify({
    clientKey: 'ps_public_test',
    platform: 'web',
    messaging: messaging(),
    storage: storage(),
    fetch: async () => ({ ok: true, status: 200, text: async () => '{}' }),
  });
  await assert.rejects(() => honey.registerCurrentToken(), HoneyNotifyError);
});

test('requests Android 13 notification permission before registration', async () => {
  let requestedPermission;
  const permissions = {
    PERMISSIONS: { POST_NOTIFICATIONS: 'android.permission.POST_NOTIFICATIONS' },
    RESULTS: { GRANTED: 'granted' },
    request: async (permission) => {
      requestedPermission = permission;
      return 'granted';
    },
    check: async () => true,
  };
  const honey = new HoneyNotify({
    clientKey: 'ps_public_test',
    platform: 'android',
    platformVersion: 33,
    permissions,
    messaging: messaging(),
    storage: storage(),
    fetch: async () => ({
      ok: true,
      status: 200,
      text: async () => '{"device_id":"device-3"}',
    }),
  });
  assert.equal(await honey.requestPermissionAndRegister(), 'device-3');
  assert.equal(requestedPermission, 'android.permission.POST_NOTIFICATIONS');
});

test('refreshes identified devices with a fresh verified identity token', async () => {
  let refreshHandler;
  const push = messaging();
  push.onTokenRefresh = (handler) => {
    refreshHandler = handler;
    return () => {};
  };
  const state = storage();
  await state.setItem('@honeynotify/externalUserId', 'customer-7');
  await state.setItem('@honeynotify/tags', '{"plan":"pro"}');
  let requestBody;
  const honey = new HoneyNotify({
    clientKey: 'ps_public_test',
    platform: 'ios',
    messaging: push,
    storage: state,
    fetch: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return { ok: true, status: 200, text: async () => '{"device_id":"device-7"}' };
    },
  });
  honey.startTokenRefreshListener({
    identityTokenProvider: async (externalUserId) => `token-for-${externalUserId}`,
  });
  await refreshHandler();
  assert.equal(requestBody.external_user_id, 'customer-7');
  assert.equal(requestBody.identity_token, 'token-for-customer-7');
  assert.deepEqual(requestBody.tags, { plan: 'pro' });
});
