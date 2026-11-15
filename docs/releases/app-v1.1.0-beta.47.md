# OpenAgent App 1.1.0 beta 47

- Chat: after the agent restarts and the app reconnects, the conversation that
  was open is loaded again. Before, it could stay highlighted in the sidebar
  while Chat showed the empty "new conversation" screen, and only switching to
  another conversation and back recovered it (clicking the highlighted row
  opens Rename by design).
- Chat: an open conversation that was deleted on the agent now shows its load
  error ("This result is no longer available") with Retry instead of the empty
  screen. A conversation that is really empty is checked once per connection,
  not refetched in a loop; a local draft is never fetched.

The app keeps Host Tools beta18, the existing application ID, local profiles and
device consent.
