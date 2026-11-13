# OpenAgent App 1.1.0 beta 43

The app ships Host Tools beta17.

- Updates no longer fail silently. Every update check and download outcome is
  written to `updater.log` in the app's log folder, and a check started from the
  menu shows a dialog when it fails.
- After an update, the app no longer keeps talking to an older Host Tools broker
  left running from the previous version: the broker reports its version, and a
  newer client asks an older one to exit (a legacy broker without a version is
  verified and stopped) before starting its own. Broker shutdown is bounded even
  while clients are connected.
- When an agent issues several changes to this computer in parallel, the later
  calls now wait for the first to finish instead of failing with "another local
  tool call is currently mutating this computer". Calls from a different client
  are still refused at once.

The app keeps the existing application ID, local profiles and device consent.
