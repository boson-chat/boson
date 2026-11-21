# syntax=docker/dockerfile:1
# The Boson web client (chat.boson.chat; docs/web-client.md): the renderer's
# web build (platform/web) with the engine as WebAssembly, served by nginx
# with the page's CSP and caching headers. One image serves any stack: the
# endpoints are written to /boson-config.js at start (entrypoint.sh) from
#   BOSON_AUTH_URL       the auth service   (default https://auth.boson.chat)
#   BOSON_API_URL        the API            (default https://api.boson.chat)
#   BOSON_DIRECTORY_URL  the network directory (default https://directory.boson.chat)
#   BOSON_GATEWAY_URL    the IRC gateway's WebSocket (default: this origin's /webirc/websocket/)
# Build from the repo root: docker build -f infra/web/Dockerfile .

FROM --platform=$BUILDPLATFORM golang:1.27-alpine AS engine
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY engine/ engine/
RUN mkdir /out && CGO_ENABLED=0 GOOS=js GOARCH=wasm go build -trimpath -ldflags='-s -w' -o /out/engine.wasm ./engine/cmd/wasm \
 && cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" /out/wasm_exec.js

FROM --platform=$BUILDPLATFORM node:24-alpine AS app
WORKDIR /src
COPY package.json package-lock.json ./
COPY client/package.json client/
COPY packages/ packages/
RUN npm ci --no-audit --no-fund --ignore-scripts
COPY client/ client/
COPY design-systems/ design-systems/
COPY --from=engine /out/ client/src/renderer/src/platform/web/gen/
ARG VERSION=dev
RUN cd client && npx tsc --noEmit && VITE_BOSON_SHELL=web npx vite build \
 && find out/web -type f \( -name '*.js' -o -name '*.css' -o -name '*.wasm' -o -name '*.html' -o -name '*.svg' \) -size +1k -exec gzip -9 -k {} \;

FROM nginxinc/nginx-unprivileged:1.29-alpine
COPY infra/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY infra/web/entrypoint.sh /docker-entrypoint.d/40-boson-config.sh
COPY --from=app --chown=101:101 /src/client/out/web/ /usr/share/nginx/html/
USER root
RUN chmod +x /docker-entrypoint.d/40-boson-config.sh && rm -f /usr/share/nginx/html/boson-config.js /usr/share/nginx/html/boson-config.js.gz
USER 101
ARG VERSION=dev
ENV BOSON_WEB_VERSION=$VERSION
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
