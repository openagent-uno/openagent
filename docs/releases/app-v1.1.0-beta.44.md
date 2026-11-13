# OpenAgent App 1.1.0 beta 44

The app ships Host Tools beta18. On macOS, commands an agent runs on this
computer find the same programs as your terminal again. Since beta 42 the shell
was meant to resolve your login-shell `PATH`, but the app's Host Tools process,
started by launchd, handed the shell its own minimal environment
(`/usr/bin:/bin:/usr/sbin:/sbin`), so Homebrew and SDK tools such as `flutter`
were not found. The shell now resolves your login `PATH` by default; an
environment given explicitly is still used as is. The app keeps the existing
application ID, local profiles and device consent.
