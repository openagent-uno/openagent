# OpenAgent App 1.1.0 beta 40

Long sessions scroll infinitely in both directions. The transcript renders a
bounded window and loads earlier or later history on its own as the reader
nears either edge, keeping the reading position fixed; the "Load earlier"
control is gone. A rail of dots beside the transcript marks every prompt of
the session (primary for your own, white for other participants): hover to
preview a prompt, click to jump to it. The full rail needs Server beta 37;
older servers show the prompts already loaded.

Auto-scroll now stays attached at the bottom while new messages, tools and
your own prompts arrive, and detaches only on a real upward gesture. Recent
sessions and workflow, scheduled and event runs that are working show the same
shine as a running tool.

Also included since beta 39: desktop sessions can stay awake with optional
macOS closed-lid protection, assistant turn actions show the executing model,
and completed chat turns and stalled shared observers recover. The app keeps
the existing application ID and local profiles.
