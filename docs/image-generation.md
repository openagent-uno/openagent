# Image generation in the standalone product

In App settings, add a provider with an image-capable `/v1/images/generations`
API and then add an enabled model of kind **Image**. The CLI model manager and
server model API accept the same `image` kind. Discovery classifies common
image model families automatically; a custom model ID can be entered manually.
Provider keys remain server side. An image model does not replace the LLM
selected for a conversation.

The default `media-gen.generate_image` tool chooses an enabled image model or
uses the explicitly requested model. It writes validated image bytes to the
agent's media directory. The tool returns a `send_marker`; the agent may reuse
the file with other tools, or include that marker verbatim in its reply. The
server converts it to a typed attachment in the App and the Telegram, Slack,
Discord and WhatsApp bridges. Channel-specific upload limits and recipient
authorization remain in each bridge. A model call alone does not send an image
until the agent chooses to attach it.

The server also accepts explicit `OPENAGENT_IMAGE_BASE_URL`,
`OPENAGENT_IMAGE_API_KEY` and `OPENAGENT_IMAGE_MODEL` overrides for deployments
that configure providers outside the catalog. The shared Core transport
currently supports text-to-image on compatible APIs; editing an existing image
is a separate capability.
