#!/bin/sh
# FE-155: the instance part of the PWA manifest (lang, description) follows
# DEFAULT_LOCALE of the container. The build ships manifest.<locale>.webmanifest;
# pick the matching one. No/unknown locale -> the golden manifest stays.
set -eu
html="${MANIFEST_HTML_DIR:-/usr/share/nginx/html}"
locale="${DEFAULT_LOCALE:-}"
case "$locale" in
  ru|en|uk)
    cp "$html/manifest.$locale.webmanifest" "$html/manifest.webmanifest"
    echo "40-manifest-locale: manifest.webmanifest -> $locale"
    ;;
  "") ;;
  *) echo "40-manifest-locale: unknown DEFAULT_LOCALE '$locale', golden manifest kept" ;;
esac
