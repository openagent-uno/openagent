"""Validate and normalize the owner-provided profile image."""

import base64
import binascii
import io
import re

from PIL import Image, ImageOps, UnidentifiedImageError

PREFIX = "data:image/jpeg;base64,"
_MAX_ENCODED = 512 * 1024
_MAX_PIXELS = 4096 * 4096
_DATA = re.compile(r"data:image/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=]+)")


def normalize_thumbnail(value: object) -> str | None:
    """Return a 512px square JPEG without embedded metadata."""
    if value is None:
        return None
    if not isinstance(value, str) or len(value) > _MAX_ENCODED:
        raise ValueError("Thumbnail must be a PNG, JPEG or WebP under 384 KB.")
    match = _DATA.fullmatch(value)
    if not match:
        raise ValueError("Thumbnail must be a PNG, JPEG or WebP image.")
    try:
        data = base64.b64decode(match[1], validate=True)
        with Image.open(io.BytesIO(data), formats=["PNG", "JPEG", "WEBP"]) as image:
            if image.width * image.height > _MAX_PIXELS:
                raise ValueError("Thumbnail is too large to decode.")
            image = ImageOps.exif_transpose(image).convert("RGBA")
            cropped = ImageOps.fit(image, (512, 512), Image.Resampling.LANCZOS)
            background = Image.new("RGB", cropped.size, "#181b23")
            background.paste(cropped, mask=cropped.getchannel("A"))
            output = io.BytesIO()
            background.save(output, "JPEG", quality=85, optimize=True)
    except (UnidentifiedImageError, OSError, binascii.Error, Image.DecompressionBombError) as exc:
        raise ValueError("The thumbnail could not be decoded.") from exc
    return PREFIX + base64.b64encode(output.getvalue()).decode("ascii")
