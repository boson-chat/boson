#!/bin/sh
# Writes /boson-config.js (/tmp/boson-config.js) (window.bosonWebConfig, read by the app before it
# starts: platform/web/config.ts) from the environment. Runs from the nginx
# image's /docker-entrypoint.d before nginx starts.
set -eu
json() { # a JSON string, or null when empty
	if [ -z "$1" ]; then printf 'null'; else printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"; fi
}
for v in BOSON_AUTH_URL BOSON_API_URL BOSON_DIRECTORY_URL BOSON_GATEWAY_URL; do
	eval "val=\${$v:-}"
	case "$val" in
		''|https://*|http://localhost*|http://127.0.0.1*|wss://*|ws://localhost*|ws://127.0.0.1*|/*) ;;
		*) echo "40-boson-config: $v must be an https:// (wss:// for the gateway) URL or a path, got: $val" >&2; exit 1 ;;
	esac
done
# /tmp: the container may run with a read-only root (nginx.conf serves it).
cat > /tmp/boson-config.js <<CONF
window.bosonWebConfig = {
  authUrl: $(json "${BOSON_AUTH_URL:-https://auth.boson.chat}"),
  apiUrl: $(json "${BOSON_API_URL:-https://api.boson.chat}"),
  directoryUrl: $(json "${BOSON_DIRECTORY_URL:-https://directory.boson.chat}"),
  gatewayUrl: $(json "${BOSON_GATEWAY_URL:-}"),
  version: $(json "${BOSON_WEB_VERSION:-dev}")
};
CONF
