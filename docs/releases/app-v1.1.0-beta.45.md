# OpenAgent App 1.1.0 beta 45

- Settings: in a narrow desktop window the section pills now wrap onto more
  lines, so Channels, Dream Mode, Controls, This Computer and Connection are
  reachable again (a mouse wheel does not scroll the horizontal row).
- Conversations: a conversation chosen in the sidebar (or with New session) is
  the one Chat shows, also after returning from Settings or another screen. A
  route that kept the previous `?session=` no longer brings back an empty
  "New Chat" draft.
- Conversations: the first page of a conversation stops loading after 20
  seconds with an error and Retry, instead of showing the loading state
  forever when a request never answers.
- Scheduled: after the switch of a task is pressed, the list is read again, so
  the switch shows the state the server stored (also when enabling is refused).
- Automations: an approved automation shows the tools added after its approval
  and offers to approve it again (with Server beta46).

The app keeps Host Tools beta18, the existing application ID, local profiles and
device consent.
