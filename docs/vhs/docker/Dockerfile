# VHS 0.12.0 with the encode-context regression patched (evaluator.go renders with the
# cancelled recording context, so ffmpeg never starts and the error is swallowed).
# The patch is the committed file next to this Dockerfile; its sha256 goes into the
# recording sidecar as vhsPatchSha256.
#
# Build through docs/vhs/record-check.sh, which passes the tool and the version as build
# arguments. TOOL_SPEC is what npm installs: <tool>@<version> from npm, or the path of an
# `npm pack` tarball in the build context (copied to /ctx) for a version npm does not have.
FROM golang:1.26-trixie AS vhsbuild
ENV GOTOOLCHAIN=auto
COPY vhs-0.12.0-render-context.patch /tmp/vhs-0.12.0-render-context.patch
RUN git clone --depth 1 --branch v0.12.0 https://github.com/charmbracelet/vhs /src \
 && cd /src \
 && git apply /tmp/vhs-0.12.0-render-context.patch \
 && grep -n "v.Render(context.Background())" evaluator.go \
 && CGO_ENABLED=0 go build -ldflags "-X main.Version=v0.12.0+render-context-patch" -o /vhs .

FROM node:22.20.0-trixie-slim AS node

FROM ghcr.io/charmbracelet/vhs:latest
COPY --from=vhsbuild /vhs /usr/bin/vhs
COPY --from=node /usr/local/ /usr/local/
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends ca-certificates procps gifsicle >/dev/null \
 && node --version && npm --version && which ps gifsicle
ENV OPENA2A_TELEMETRY=off
ENV npm_config_update_notifier=false
ENV npm_config_yes=true
ARG TOOL
ARG TOOL_VERSION
ARG TOOL_SPEC=${TOOL}@${TOOL_VERSION}
# --ignore-scripts: the image runs no dependency install script, so the build fetches the tool
# and its dependencies from npm and nothing else.
COPY . /ctx/
RUN npm install -g --ignore-scripts --no-audit --no-fund "${TOOL_SPEC}" \
 && "${TOOL}" --version
WORKDIR /work
ENTRYPOINT ["vhs"]
