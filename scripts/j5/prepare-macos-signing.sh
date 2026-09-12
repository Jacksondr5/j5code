#!/usr/bin/env bash
set -euo pipefail
umask 077

: "${RUNNER_TEMP:?}"
: "${GITHUB_ENV:?}"
: "${CSC_LINK:?}"
: "${CSC_KEY_PASSWORD:?}"
: "${APPLE_API_KEY:?}"
: "${APPLE_API_KEY_ID:?}"

signing_dir="$(mktemp -d "$RUNNER_TEMP/j5-signing.XXXXXX")"
printf 'J5_SIGNING_DIR=%s\n' "$signing_dir" >> "$GITHUB_ENV"
trap 'rm -f "$signing_dir/source.p12" "$signing_dir/signing.pem"' EXIT

printf '%s' "$CSC_LINK" | base64 -D > "$signing_dir/source.p12"
# Keychain rejects some modern PKCS12 exports even when their password is correct.
# Rewrap the same certificate and key using encryption supported by macOS.
openssl pkcs12 -in "$signing_dir/source.p12" -passin env:CSC_KEY_PASSWORD \
  -nodes -out "$signing_dir/signing.pem"
openssl pkcs12 -export -in "$signing_dir/signing.pem" \
  -out "$signing_dir/signing.p12" -passout env:CSC_KEY_PASSWORD \
  -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1

key_path="$signing_dir/AuthKey_${APPLE_API_KEY_ID}.p8"
printf '%s' "$APPLE_API_KEY" > "$key_path"
openssl pkey -in "$key_path" -noout
printf 'CSC_LINK=%s\nAPPLE_API_KEY=%s\n' "$signing_dir/signing.p12" "$key_path" >> "$GITHUB_ENV"
