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

A chat model may also advertise `metadata.capabilities=["image_generation"]`.
When its catalog name is qualified, `metadata.image_model_id` records the bare
model ID expected by the image endpoint. The Codex subscription proxy exposes
this route; its advertised capability can be registered on a chat model.
The Claude subscription proxy supplies chat only: an agent talking through
Claude can still call the image tool when an independent image provider is
configured in the same OpenAgent installation.

The server also accepts explicit `OPENAGENT_IMAGE_BASE_URL`,
`OPENAGENT_IMAGE_API_KEY` and `OPENAGENT_IMAGE_MODEL` overrides for deployments
that configure providers outside the catalog. The shared Core transport
currently supports text-to-image on compatible APIs; editing an existing image
is a separate capability.

Receiving an image is a separate chat-model capability from generating one.
For recognised Claude model IDs behind an OpenAI-compatible subscription
proxy, Core infers `text`, `image` and `file` input when a model is first
registered, regardless of the custom provider name. An explicit
`models.metadata.input_modalities` declaration always wins. Existing rows
that a previous release persisted as `text` only need a verified, targeted
metadata update; OpenAgent does not silently replace an operator's explicit
text-only choice. A channel image test must include the actual inbound photo,
model interpretation, and reply on the same channel.
