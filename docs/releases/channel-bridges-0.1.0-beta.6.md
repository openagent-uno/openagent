# Channel bridges 0.1.0 beta6: preserve the selected chat

Top-level Slack input now replies in the main chat. Input in an existing
thread replies in that same thread; threaded direct messages stay private.
Text and file delivery reject a destination different from the authenticated
channel/thread. No context, session key, participant attribution or history
is rewritten. Discord continues to send to the explicit channel or thread.
The hosted Slack facade uses the same destination rule.

A regression run first reproduced three failures with the previous behavior.
The complete component source suite then passed 215 tests and 84 subcases on
normally installed public Core beta26, including real local HTTP upload tests,
thread audience/revocation guards and Discord destination checks. No provider
credentials, AI requests or live channels were used. Public-wheel installation
and release receipts are separate; these source results are not live-provider
acceptance. Existing Core beta24/beta26 contracts and beta5 upload guards remain.
