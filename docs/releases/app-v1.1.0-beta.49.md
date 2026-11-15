# OpenAgent App 1.1.0 beta 49

- Loops: `/loop <interval> <prompt>` runs a prompt inside this conversation on
  a schedule (15m–59m, 1h–23h, 1d–7d; days at the current local time, in this
  device's timezone). `/loop` lists the conversation's loops, `/loop stop`
  removes them. The session panel has a Loops section with interval, next run
  or paused, approval state, Pause/Resume, Run now, Delete and a form to add
  one.
- Command answers (`/goal status`, `/status`, `/model`…) now appear in the
  conversation; before, every answer except `/context` was silently dropped.

Loops need OpenAgent server 1.1.9 beta57 (Core 1.1.0 beta99) or later; on an
older server the section says loops are not supported. The app keeps Host
Tools beta18, the existing application ID, local profiles and device consent.
