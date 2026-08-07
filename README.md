# Money Marathon — Android app

Same app as the web version, wrapped so it installs as a real `.apk`.

## Before you start
Finish the Firebase setup in the web version first (`firebase-config.js` needs
your real keys) — copy your filled-in `www/firebase-config.js` over the one in
this folder if you haven't already.

## Build steps

```bash
npm install
npx cap add android
npm run open:android
```

That last command opens the project in Android Studio.

In Android Studio:
1. Wait for Gradle to sync (bottom status bar).
2. **Build → Build Bundle(s) / APK(s) → Build APK(s)**.
3. When it finishes, click **locate** in the notification — that's your `.apk`.

## Installing it on your phone
Send yourself the `.apk` (Drive, email, USB, whatever) and open it on the
phone. You'll need to allow "install from unknown sources" once — Android
will prompt you.

## Updating later
Whenever you change the web files, run:
```bash
npx cap sync android
```
then rebuild the APK in Android Studio.
