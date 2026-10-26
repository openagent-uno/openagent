# Channel bridges 0.1.0 beta14

Slack attachments now receive independent private staging identities. Slack
private download URLs commonly end in the original filename; multiple images
named `image.png` previously collided in the same inbound message directory.
The first image was retained and subsequent downloads failed with
`FileExistsError` because exclusive creation correctly refused an overwrite.

The fix preserves exclusive file creation, strict byte and representation
checks, current authorization, provider attachment IDs and original display
names. It applies to every Slack attachment type and to history downloads.
It does not weaken permissions or alter channel/thread placement.

The regression sends a PDF and seven identically named images through the
normal download, staging and canonical wire path. All eight independent byte
sequences and SHA-256 values must survive, and temporary paths must be removed
after dispatch. Source tests also cover rendition completeness, revocation
and actual HTTP upload acknowledgements. Live-channel acceptance is recorded
separately after public package installation.
