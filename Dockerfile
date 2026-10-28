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
CMD ["onebase", "serve"]

# This image runs a bare server. Push your functions to it with `onebase deploy`
# (the deployment is stored in the database on the volume). To bake them in
# instead, copy `onebase/` (and `public/`) into /app in a derived image.
