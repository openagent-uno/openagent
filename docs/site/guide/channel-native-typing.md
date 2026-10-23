# Native processing indicators

Native indicators are best-effort provider signals. Component qualification
does not establish delivery in a live provider account.

The official channel bridges show a provider-native processing indicator without
posting progress messages. This works independently of quiet/live/final delivery.
Quiet delivery still posts only its configured acknowledgement and final reply.
The indicator begins after admission and covers attachment/history reads, speech
and execution. A shared lifecycle renews fresh actor, binding and delivery-audience
authorization before each native request. It never grants a new permission.

| Adapter | Native surface | Limits |
| --- | --- | --- |
| Discord | Existing channel, DM or thread `trigger_typing` | Refresh every 7 seconds; provider expiry around 10 seconds. |
| Slack | `assistant.threads.setStatus` on the existing assistant thread | Requires a supported app/thread and existing token permissions. Refresh every 45 seconds; clear on completion when still authorized. Main-channel and top-level DM replies have no supported indicator in this adapter. |
| WhatsApp Green API | `serviceMethods.sendTypingAsync` on an authenticated personal route | 10-second typing duration, refreshed every 7 seconds. Older clients without this async method are unsupported. No Cloud API implementation is implied. |

WhatsApp presence is limited to personal provider envelopes whose sender matches
the exact chat peer. Its presence context is separately authorized; the inbound
execution context remains unchanged. Group or unknown audiences have no native
indicator here.

Slack replies retain their exact placement. The bridge never opens a thread,
posts a placeholder or adds a reaction to emulate an unsupported native status.
Slack's API determines whether an existing thread supports assistant status;
missing scope/forbidden/unsupported responses disable that indicator without
failing the request or changing token scopes.

Every lifecycle owns and joins its task on completion, cancellation or bridge
stop. Provider calls have a five-second deadline. A permission or network failure
stops refreshes; rate-limit retries are at most two with a maximum 30-second
Retry-After. Indicators have a 30-minute lifetime bound, independent of a longer
agent run. Nested intake/execution reuses one indicator for the same event;
concurrent events keep independent authorization. An ending event does not clear
a different active event on the same destination.

Discord/WhatsApp have no explicit clear request here: refreshes stop immediately
and the provider expires the last native signal. A revoked Slack grant cannot be
used to clear status; the provider's two-minute expiry remains the upper bound.
Already accepted provider requests cannot be recalled. Green API queue delay may
also affect visibility; no queued-message deletion is performed.

Source verification: 320 tests plus 86 subtests passed, including 22 native
indicator/admission fixtures. Ten differential WhatsApp cases match the actual
public SDK12 admission, actor and original authorization results. The public beta12 wheel reproduces the missing quiet Discord
indicator before this patch.

These source fixtures use fake provider clients and a real asynchronous lifecycle.
They establish request shape, authorization and cleanup, not delivery in a real
Slack workspace, Discord server or WhatsApp account.

Primary provider references:
- [Slack agent development](https://docs.slack.dev/ai/developing-agents/)
- [Slack assistant thread status](https://docs.slack.dev/reference/methods/assistant.threads.setStatus/)
- [Discord typing indicator](https://docs.discord.com/developers/resources/channel#trigger-typing-indicator)
- [Green API sendTyping](https://green-api.com/en/docs/api/service/SendTyping/)
- [Green API Python client](https://github.com/green-api/whatsapp-api-client-python)
