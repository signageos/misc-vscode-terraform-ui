FROM node:22-alpine AS runtime
WORKDIR /app

FROM runtime AS dev
ARG SOPS_VERSION=3.9.4
ARG TARGETARCH
RUN apk add --no-cache bash && \
    wget -qO /usr/local/bin/sops \
      "https://github.com/getsops/sops/releases/download/v${SOPS_VERSION}/sops-v${SOPS_VERSION}.linux.${TARGETARCH}" && \
    chmod +x /usr/local/bin/sops
