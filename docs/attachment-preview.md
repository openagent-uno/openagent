# Attachment preview in OpenAgent App

User and agent attachments expose adjacent expand and download controls in
message streams. Images and videos can be enlarged to the available window;
browser audio and video players provide play/pause and seeking. PDF files open
in an in-app preview, and text and source files open in a scrollable viewer with
syntax highlighting for supported languages. Other formats remain downloadable.

The same attachment component renders the App's restored transcript and live
message parts, so the controls follow messages regardless of author. The web
and Electron client provide the rich media viewers. Native mobile currently
falls back to the file badge for audio/video and unsupported previews.

The compatibility `/api/sessions/{id}/runs` gateway delegates display projection
to the public Core `SessionInspection.transcript` service with the existing
certificate-bound context. It does not maintain a second transcript expander or
parse provider input such as `attachment_reference` into clickable files.
Current session and artifact authorization remains authoritative, including
view-only grants and revocation during a read. Original user text and authorized
structured attachment references belong to Core's display contract; provider
previews remain model input. The App preserves ordered parts and uses the same
file/image/audio/video attachment component for both user and assistant rows.

[Product beta52](releases/v1.1.0-beta.52.md) adopts the independently published Core beta24 wheels. The existing beta51 release is unchanged. The new Python release has fresh public-wheel CAS/ACL qualification; native installer, visual playback and real-provider boundaries remain explicitly unqualified.

## Host-selected output publication

The standard Core attachment sender uses the optional `attachments.publisher` runtime service. Standalone configures its server-host publisher only when `server_host_tools` selects `filesystem`. It uses the same `FilesystemServer` composition and database-parent working directory as the server-host filesystem capability; connected App/device sources cannot be selected through a path. The standalone default filesystem capability has OS-user scope, not a sandbox root. Hosts that select bounded filesystem readers retain those reader bounds.

Publication checks the current Core execution, exact agent/session/run and fresh `run.publish` authority before reading and again while storing through the public `ArtifactRepository`. A view-only session grant does not grant publication. File bytes become an authorized session-linked CAS reference before the shared sender and transcript expose file cards or media previews. Disabling filesystem leaves the publisher service absent. The beta52 public-wheel installation passed the focused CAS and authority checks; this does not imply a native or real-provider qualification.

### Focused source checks (19 October 2026)

The source-debug batch passed 8 standalone checks (public transcript/ACL plus the selected publisher), 1 ICS publisher integration check and 10 App common ordered-parts/attachment contract checks, with zero skips. The publisher cases exercise CSV, PNG, MP4 and WAV references, a disabled filesystem, bounded-reader escape denial, view-only denial, stale/different-session execution and revocation after the read. The existing REST ACL regression also passes through the public Core projection.

These checks used the independent Core beta24 source candidate with an existing dependency environment. They do not qualify a published beta24 wheel, a native installer, real-provider media delivery or visual playback. No App frontend implementation was rewritten: the existing shared attachment block renders user and assistant parts. The source-debug log SHA-256 is `ea8c029546b251bc15f2a840a638ac158c093e6bd89ad9e8e127e2b8161f5f4e`; the private debug receipt SHA-256 is `d52e4dc870b7f8a7bc981bad6f3a0cbcaaa84d83da8a8a39dd7864d3b1daed7d`.

The independent Core beta24 release is now public. Product beta52 adopts its actual published wheel checksums; its published product wheels passed a separate fresh normal installation and dependency consistency check. The App renderer itself is byte-identical to the beta22 source tag. Two additional renderer checks passed for inline image/video/audio and file cards before modal interaction, and the documented native fallback. No Electron payload rebuild is needed for this server/Core contract repair.
