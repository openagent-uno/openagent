# OpenAgent — shared general-purpose "machine" image.
# ONE image for every OpenAgent node in the cluster (spicysparks-openagent,
# esound-openagent, future agents). The image is agent-agnostic: it holds the
# OpenAgent runtime, the tailscale daemon+CLI (in-machine networking), the
# claude-sub-proxy model backend, a full Linux userland, and the common heavy
# runtime deps any agent might need (ffmpeg, fonts, headless-chromium libs, uv,
# ripgrep). Everything agent-specific — persona, memory vault, repos, keys,
# env, CLI tools, programs — lives on the per-agent PVC at /data/agent.
# supervisord runs tailscale + claude-sub-proxy + openagent together.
#
# Build (linux/amd64, from THIS dir as context):
#   docker buildx build --builder oa-builder --platform linux/amd64 \
#     -t hub.spicysparks.com/spicysparks/openagent:v15 --push .
#
# glibc >= 2.38 required by the onefile binary -> ubuntu:24.04 (glibc 2.39).
FROM ubuntu:24.04

ENV PYTHONUNBUFFERED=1 \
    PIP_BREAK_SYSTEM_PACKAGES=1 \
    PIP_NO_CACHE_DIR=1 \
    HOME=/data/agent/home \
    PATH=/opt/openagent/bin:/data/agent/home/.local/bin:/data/agent/bin:/data/agent/mcp/ga4-venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    OPENAGENT_HTTP_HOST=0.0.0.0 \
    DEBIAN_FRONTEND=noninteractive

# Full machine userland + common runtime deps shared by all agents:
#  - shell/net tooling + supervisor + node 20 + python3
#  - ffmpeg + fonts + headless-chromium libs (libnss3/libgbm1/libasound2) for
#    TTS/STT and browser screenshots with correct CJK/emoji rendering
#  - ripgrep (fast code search), uv (python tooling) — installed below
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl wget git bash tini procps supervisor \
      python3 python3-pip python3-venv python-is-python3 \
      iproute2 iptables iputils-ping openssh-client jq ripgrep unzip \
      ffmpeg \
      libnss3 libgbm1 libasound2t64 libxshmfence1 libdrm2 xdg-utils \
      fonts-liberation fonts-dejavu-core fonts-noto-color-emoji fonts-noto-cjk \
      fonts-wqy-zenhei fonts-ipafont-gothic \
 && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

# uv (fast python package/venv manager) — used by agents at runtime
RUN pip3 install uv

# Tailscale: daemon + CLI + containerboot (upstream entrypoint that runs
# tailscaled, `tailscale up`, and applies the serve config from env).
COPY --from=tailscale/tailscale:latest /usr/local/bin/containerboot /usr/local/bin/containerboot
COPY --from=tailscale/tailscale:latest /usr/local/bin/tailscaled     /usr/local/bin/tailscaled
COPY --from=tailscale/tailscale:latest /usr/local/bin/tailscale      /usr/local/bin/tailscale

# Compiled OpenAgent (onefile) + Rust computer-control sidecar. The agent
# binary lives outside /usr/local/bin so source-style pip installs cannot
# overwrite the process that supervisord launches.
RUN mkdir -p /opt/openagent/bin
COPY bin/openagent                 /opt/openagent/bin/openagent
COPY bin/openagent-computer-control /opt/openagent/bin/openagent-computer-control
RUN chmod +x /opt/openagent/bin/openagent /opt/openagent/bin/openagent-computer-control \
            /usr/local/bin/containerboot /usr/local/bin/tailscaled /usr/local/bin/tailscale

# claude-sub-proxy (Claude-subscription model backend) + common MCP python deps
COPY claude-sub-proxy/ /opt/claude-sub-proxy/
RUN pip3 install /opt/claude-sub-proxy "mcp>=1.0.0" "httpx>=0.24"

# supervisor config at the default path (so bare `supervisorctl` works) + tailscale serve config
COPY machine/supervisord.conf /etc/supervisord.conf
COPY machine/serve.json       /etc/tailscale/serve.json

WORKDIR /data/agent
ENTRYPOINT ["tini","--","/usr/bin/supervisord","-c","/etc/supervisord.conf"]
