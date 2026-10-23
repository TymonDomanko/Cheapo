# The home collector as single programs for Windows and Linux, ready-made so the
# server doesn't need ~1 GB of memory to build them (see src/collector-exe.js).
# Built on the build machine's platform: the programs are the same either way.
# Skip with --build-arg COLLECTOR_PROGRAMS=none (the zip download still works).
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS collector-programs
ARG COLLECTOR_PROGRAMS="windows-x64 linux-x64 linux-arm64"
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional --ignore-scripts
COPY src ./src
# If this fails (say nodejs.org is unreachable) the image still builds; the server then builds them when asked.
RUN mkdir -p /out && if [ "$COLLECTOR_PROGRAMS" != "none" ]; then \
      node src/cli/build-collector-exe.js --prebuild /out $COLLECTOR_PROGRAMS > /tmp/build.log 2>&1 \
        || { grep -v "^warning:" /tmp/build.log; echo "Couldn't prebuild the collector programs."; }; \
    fi

FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000

# Build tools only in case better-sqlite3 has no prebuilt binary for this platform.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Litestream: optional continuous backup to S3-compatible storage (enabled by LITESTREAM_BUCKET).
ARG LITESTREAM_VERSION=0.3.13
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && curl -fsSL "https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-v${LITESTREAM_VERSION}-linux-${TARGETARCH:-amd64}.tar.gz" \
       | tar -xz -C /usr/local/bin litestream \
    && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
# Playwright (trolley filling / browser scraping) is optional and not useful on a server.
RUN npm ci --omit=dev --omit=optional && npm cache clean --force

COPY src ./src
COPY public ./public
COPY --from=collector-programs /out ./collector-exe
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY litestream.yml /etc/litestream.yml

VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "src/server.js"]
