#!/bin/sh
# Drop-in `/usr/sbin/sendmail` replacement that forwards local mail to
# mailpit:1025 via SMTP. Anope and Atheme both shell out to a sendmail
# binary to deliver NickServ confirmation emails; their stock docker
# images don't ship one, so we mount this script in place of it.
#
# Reads an RFC 5322 message from stdin (Anope invokes with `-t`,
# meaning "extract recipients from To:/Cc:/Bcc: headers"), extracts
# recipient addresses, and walks a basic SMTP conversation via nc.
#
# Implementation notes:
#   - busybox nc (present in both anope + atheme Alpine images) is
#     used — no pip/apk installs required.
#   - SMTP responses are intentionally NOT read. We rely on mailpit
#     accepting pipelined commands (it does; RFC 2920 ESMTP
#     PIPELINING + lenient parsing for non-extended sessions). For
#     prod-grade mail this would be msmtp/swaks; for dev relay to
#     mailpit it's plenty.
#   - On any malformed input (no recipients found) the script
#     `exit 1`s — Anope/Atheme will log the failure to their NickServ
#     channels, which is what you'd want during dev.

set -eu

# Stash the inbound message in a temp file so we can scan headers
# without losing the body.
msg=$(mktemp)
trap "rm -f \"$msg\"" EXIT
cat > "$msg"

# Extract recipient addresses from the To:, Cc:, and Bcc: headers
# (header section ends at the first blank line). Strip
# display-name "Foo Bar" prefixes and angle brackets to get bare
# `user@host` strings; deduplicate.
recipients=$(awk '
    BEGIN { in_headers = 1 }
    /^$/ { in_headers = 0 }
    in_headers && /^[Tt]o:/  { sub(/^[^:]+:[ \t]*/,""); print }
    in_headers && /^[Cc]c:/  { sub(/^[^:]+:[ \t]*/,""); print }
    in_headers && /^[Bb]cc:/ { sub(/^[^:]+:[ \t]*/,""); print }
' "$msg" | tr ',' '\n' \
  | sed 's/.*<\([^>]*\)>.*/\1/' \
  | tr -d ' \t\r' \
  | grep '@' \
  | sort -u || true)

if [ -z "$recipients" ]; then
    echo "sendmail-shim: no recipients found in message headers" >&2
    exit 1
fi

# Configurable via env so the same script works locally + in CI.
MAILPIT_HOST=${MAILPIT_HOST:-mailpit}
MAILPIT_PORT=${MAILPIT_PORT:-1025}
SENDER=${SENDMAIL_SHIM_FROM:-noreply@boson.chat}

# Build + ship the SMTP conversation as one piped stream. Mailpit
# tolerates pipelining without an explicit PIPELINING capability
# announcement (we don't EHLO, just HELO). The `-w 3` tells nc to
# wait up to 3s for the server to send something back; in practice
# mailpit closes the connection cleanly on QUIT.
{
    printf "HELO sendmail-shim\r\n"
    printf "MAIL FROM:<%s>\r\n" "$SENDER"
    for r in $recipients; do
        printf "RCPT TO:<%s>\r\n" "$r"
    done
    printf "DATA\r\n"
    # Forward the body verbatim. CRLF normalisation: SMTP requires
    # bare LF lines to be sent as CRLF — most mail-sending packages
    # already do this, but we apply it defensively.
    sed 's/\r$//; s/$/\r/' "$msg"
    # Ensure body ends with a CRLF before the terminating "."
    printf "\r\n.\r\n"
    printf "QUIT\r\n"
} | nc -w 3 "$MAILPIT_HOST" "$MAILPIT_PORT" >/dev/null 2>&1

exit 0
