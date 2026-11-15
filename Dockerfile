# Build the single-file onebase binary, then ship it in a slim image.
# The binary targets the platform the image is built for (amd64 or arm64).
FROM oven/bun:1.4.4 AS build
WORKDIR /src
COPY package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile
COPY src ./src
COPY scripts ./scripts
RUN bun run build:binary

FROM debian:bookworm-slim
RUN useradd --system --create-home --home-dir /app onebase \
 && mkdir -p /app/onebase_data \
 && chown onebase:onebase /app/onebase_data
COPY --from=build /src/dist/onebase /usr/local/bin/onebase
USER onebase
WORKDIR /app
VOLUME /app/onebase_data
EXPOSE 8090
# The image has no curl, so the check speaks HTTP over bash's /dev/tcp. /api/health answers 200
# only when the database answers, and 503 while the server is shutting down.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/${PORT:-8090} && printf 'GET /api/health HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n' >&3 && head -n 1 <&3 | grep -q ' 200 '"]
CMD ["onebase", "serve"]

# This image runs a bare server. Push your functions to it with `onebase deploy`
# (the deployment is stored in the database on the volume). To bake them in
# instead, copy `onebase/` (and `public/`) into /app in a derived image.
