# HoneyNotify React Native SDK

The React Native SDK registers the correct native provider token—APNs on iOS and FCM on Android—then handles HoneyNotify identity, token refresh, payload parsing, and lifecycle events.

## Requirements

- React Native 0.75 or later
- `@react-native-firebase/app` and `@react-native-firebase/messaging`
- `@react-native-async-storage/async-storage`
- iOS notification capabilities and APNs/Firebase configuration
- Android Firebase configuration and notification permission setup
- A restricted HoneyNotify public client key (`ps_public_...`)

## Install

```bash
npm install @honeynotify/react-native \
  @react-native-firebase/app @react-native-firebase/messaging \
  @react-native-async-storage/async-storage
cd ios && pod install
```

Configure Firebase for both native projects before initialising HoneyNotify. On iOS, enable Push Notifications and Background Modes > Remote notifications in Xcode and upload the APNs credentials expected by Firebase and HoneyNotify. On Android 13+, `requestPermissionAndRegister` requests `POST_NOTIFICATIONS`; declare that permission in the application manifest.

## Register

```javascript
import { HoneyNotify } from '@honeynotify/react-native';

const honeyNotify = new HoneyNotify({
  clientKey: 'ps_public_your_key',
});

const deviceId = await honeyNotify.requestPermissionAndRegister({
  externalUserId: account?.id,
  identityToken: tokenFromYourBackend,
  tags: { plan: account?.plan ?? 'visitor' },
});

const stopTokenRefresh = honeyNotify.startTokenRefreshListener({
  identityTokenProvider: async () => fetchIdentityTokenFromYourBackend(),
  onError: (error) => reportPushError(error),
});
```

Keep the returned unsubscribe function and call it when the owning application scope is disposed. The listener re-reads the APNs token on iOS rather than registering Firebase's iOS transport token as an APNs destination. If verified identity is required, its provider must obtain a fresh short-lived token from your authenticated backend; do not generate or permanently store the signing token in JavaScript.

## Receive and open

```javascript
import messaging from '@react-native-firebase/messaging';

messaging().onMessage(async (message) => {
  await honeyNotify.trackReceived(message);
  const notification = honeyNotify.notificationFrom(message);
  // Render or route notification.clickURL in your app.
});

messaging().onNotificationOpenedApp((message) => {
  honeyNotify.trackOpened(message).catch(console.error);
});
```

Register the background message handler at module scope if your application reports background receipt. Do not double-submit `received` from both background and foreground handlers for the same callback.

Use `identify(externalUserId, { identityToken, tags })` after login, `track(name, options)` for lifecycle or custom events, and `logout()` before clearing the application session when that device should stop receiving notifications for the user.

Critical Alerts on iOS still require Apple's entitlement and user permission. Android urgency remains subject to notification-channel settings controlled by the user. Never include a notification-send key in the application.

## Test

```bash
npm test
```
