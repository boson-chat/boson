#!/bin/sh
# Writes /boson-config.js (/tmp/boson-config.js) (window.bosonWebConfig, read by the app before it
# starts: platform/web/config.ts) from the environment. Runs from the nginx
# image's /docker-entrypoint.d before nginx starts.
set -eu
json() { # a JSON string, or null when empty
	if [ -z "$1" ]; then printf 'null'; else printf '"%s"' "$(printf '%s' "$1" | tr -d '\r\n' | sed 's/\\/\\\\/g; s/"/\\"/g')"; fi
}
for v in BOSON_AUTH_URL BOSON_API_URL BOSON_DIRECTORY_URL BOSON_GATEWAY_URL; do
	eval "val=\${$v:-}"
	case "$val" in
		''|https://*|http://localhost*|http://127.0.0.1*|wss://*|ws://localhost*|ws://127.0.0.1*|/*) ;;
		*) echo "40-boson-config: $v must be an https:// (wss:// for the gateway) URL or a path, got: $val" >&2; exit 1 ;;
	esac
done
# BOSON_NETWORK_DOMAIN / BOSON_NETWORK_NAME (optional): the network this web
# client is the home of and its name. Unset, the app takes the domain from
# BOSON_AUTH_URL (auth.boson.example.org -> boson.example.org; boson.chat's
# own auth means boson.chat) and the name from the auth service.
case "${BOSON_NETWORK_DOMAIN:-}" in
	''|*.*) ;;
	*) echo "40-boson-config: BOSON_NETWORK_DOMAIN must be a domain like boson.example.org, got: $BOSON_NETWORK_DOMAIN" >&2; exit 1 ;;
esac
case "${BOSON_NETWORK_DOMAIN:-}" in
	*[!A-Za-z0-9.-]*) echo "40-boson-config: BOSON_NETWORK_DOMAIN must be a domain like boson.example.org, got: $BOSON_NETWORK_DOMAIN" >&2; exit 1 ;;
esac
# /tmp: the container may run with a read-only root (nginx.conf serves it).
cat > /tmp/boson-config.js <<CONF
window.bosonWebConfig = {
  authUrl: $(json "${BOSON_AUTH_URL:-https://auth.boson.chat}"),
  apiUrl: $(json "${BOSON_API_URL:-https://api.boson.chat}"),
  directoryUrl: $(json "${BOSON_DIRECTORY_URL:-https://directory.boson.chat}"),
  gatewayUrl: $(json "${BOSON_GATEWAY_URL:-}"),
  networkDomain: $(json "${BOSON_NETWORK_DOMAIN:-}"),
  networkName: $(json "${BOSON_NETWORK_NAME:-}"),
  version: $(json "${BOSON_WEB_VERSION:-dev}")
};
CONF
