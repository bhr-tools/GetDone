# syntax=docker/dockerfile:1

# ---- Build stage -----------------------------------------------------------
FROM golang:1.26-alpine AS build
WORKDIR /src

# Dependencies are vendored: no network access is needed to build.
COPY go.mod go.sum ./
COPY vendor ./vendor
COPY cmd ./cmd
COPY internal ./internal
COPY web ./web

ENV CGO_ENABLED=0
RUN go build -mod=vendor -trimpath -ldflags="-s -w" -o /out/getdone ./cmd/server

# ---- Runtime stage ---------------------------------------------------------
FROM alpine:3.22
RUN apk add --no-cache tzdata ca-certificates \
 && addgroup -S getdone && adduser -S -G getdone -h /data getdone \
 && mkdir -p /data && chown getdone:getdone /data

COPY --from=build /out/getdone /usr/local/bin/getdone

USER getdone
WORKDIR /data
VOLUME ["/data"]
EXPOSE 8080

ENV HOST=0.0.0.0 \
    PORT=8080 \
    DB_PATH=/data/getdone.db

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/healthz" || exit 1

ENTRYPOINT ["getdone"]
