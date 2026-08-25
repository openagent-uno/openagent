# Container image for the standalone claude-sub-proxy. Serves the
# OpenAI-compatible API on 0.0.0.0:8787.
#
# Mount a subscription credentials.json and point CLAUDE_SUB_PROXY_CREDS at it,
# and set CLAUDE_SUB_PROXY_API_KEY to require callers to authenticate, e.g.:
#   docker run -p 8787:8787 \
#     -v $HOME/.claude-sub-proxy:/creds:ro \
#     -e CLAUDE_SUB_PROXY_CREDS=/creds/credentials.json \
#     -e CLAUDE_SUB_PROXY_API_KEY=... \
#     <image>
FROM python:3.12-slim

WORKDIR /app

COPY pyproject.toml README.md ./
COPY claude_sub_proxy/ ./claude_sub_proxy/

RUN pip install --no-cache-dir .

EXPOSE 8787

ENV CLAUDE_SUB_PROXY_HOST=0.0.0.0 \
    CLAUDE_SUB_PROXY_PORT=8787

CMD ["python", "-m", "claude_sub_proxy", "serve"]
