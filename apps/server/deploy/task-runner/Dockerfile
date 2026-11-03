# syntax=docker/dockerfile:1.7
# Ephemeral OpenAgent task runner: the complete standalone server and CLI from
# one published release, Chromium under a virtual X display for Agent in Chrome,
# and the qualified Linux x64 computer-control sidecar. One container = one task.
#
#   docker buildx build --platform linux/amd64 \
#     --build-arg OPENAGENT_RELEASE=<tag> --build-arg OPENAGENT_INSTALLER_SHA256=<sha256> \
#     -t <registry>/openagent-task-runner:<tag> apps/server/deploy/task-runner
#
# Computer-control 0.1.3 needs glibc >= 2.39, hence Debian trixie.
ARG PYTHON_IMAGE=python:3.12-slim-trixie
FROM ${PYTHON_IMAGE}

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates chromium xvfb xauth nodejs tini \
      fonts-liberation fonts-noto-core fonts-noto-color-emoji \
      libgbm1 libwayland-client0 libxcb1 \
 && rm -rf /var/lib/apt/lists/*

# Declared after the system layer so a new release reuses the cached Chromium/Xvfb layer.
ARG OPENAGENT_RELEASE
ARG OPENAGENT_INSTALLER_SHA256
ARG COMPUTER_CONTROL_VERSION=0.1.3
ARG COMPUTER_CONTROL_SHA256=1dfb5dfe17156568edc492dfba2f69b1cb6cb7611138caba3ed10685baea942d

# The release installer verifies every first-party wheel against its pinned
# manifests; the installer itself is pinned by digest here.
ADD --checksum=sha256:${OPENAGENT_INSTALLER_SHA256} \
    https://github.com/openagent-uno/openagent/releases/download/${OPENAGENT_RELEASE}/install.sh \
    /opt/openagent/install.sh
ENV OPENAGENT_INSTALL_ROOT=/opt/openagent/install
RUN sh /opt/openagent/install.sh --server --prefix /usr/local/bin \
 && sh /opt/openagent/install.sh --cli --prefix /usr/local/bin \
 && rm -rf /root/.cache

# Agent in Chrome ships its locked JS source in the device-tools wheel. npm is only
# needed to install that lockfile (after the installer, which must not pick the
# Debian Python that npm pulls in) and is removed again.
RUN apt-get update && apt-get install -y --no-install-recommends npm \
 && cd "$(/opt/openagent/install/venv/bin/python -c \
      'from openagent_device_tools.sources import sidecar_source; print(sidecar_source("agent-in-chrome"))')/host" \
 && npm ci --omit=dev --ignore-scripts \
 && npm cache clean --force \
 && apt-get purge -y --auto-remove npm \
 && rm -rf /var/lib/apt/lists/*

ADD --checksum=sha256:${COMPUTER_CONTROL_SHA256} \
    https://github.com/openagent-uno/openagent-tools/releases/download/computer-control-v${COMPUTER_CONTROL_VERSION}/openagent-computer-control-${COMPUTER_CONTROL_VERSION}-linux-x64.tar.gz \
    /tmp/computer-control.tar.gz
RUN mkdir -p /opt/openagent/computer-control \
 && tar -xzf /tmp/computer-control.tar.gz -C /opt/openagent/computer-control \
 && rm /tmp/computer-control.tar.gz \
 && ln -s /opt/openagent/computer-control/openagent-computer-control /usr/local/bin/openagent-computer-control

COPY --chmod=0755 openagent-task-run /usr/local/bin/openagent-task-run

RUN useradd --uid 10001 --create-home --shell /usr/sbin/nologin openagent
ENV OPENAGENT_CHROME_BINARY=/usr/bin/chromium \
    PYTHONUNBUFFERED=1
USER 10001
WORKDIR /home/openagent
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/openagent-task-run"]
