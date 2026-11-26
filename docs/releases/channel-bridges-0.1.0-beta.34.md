# Channel bridges 0.1.0 beta 34

Telegram live replies respect the provider’s reported cooldown for the bot
chat. The main response, sub-agent messages, and typing indicator share that
cooldown. Other chats continue independently. Replies resume with the latest
text once Telegram accepts writes again.

Final publication has a 90-second budget. A longer provider limit defers
delivery and keeps later requests to that chat quiet until the limit expires.
An explicit rate-limit rejection permits a retry. A send with an unknown
outcome does not.

The installed-wheel suite covers a 54-second cooldown, the delivery
deadline, cancellation, and longer limits across separately bound chats.

[Channel bridge protocol](../../packages/channel-bridges/PROTOCOL.md)
