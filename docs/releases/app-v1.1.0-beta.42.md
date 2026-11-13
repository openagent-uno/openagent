# OpenAgent App 1.1.0 beta 42

The app ships Host Tools beta16. On macOS, commands an agent runs on this
computer now find the same programs as your terminal: the shell resolves your
login-shell `PATH` once instead of inheriting the minimal Finder/Dock `PATH`,
so Homebrew, SDK and version-manager tools are available. A shell `timeout`
given in seconds (for example 30) is refused with a message that the value is
in milliseconds, instead of terminating the command after 30 ms. The app keeps
the existing application ID, local profiles and device consent.
