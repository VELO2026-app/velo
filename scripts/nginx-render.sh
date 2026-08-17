#!/bin/bash
# Pure function library -- render_nginx_http()/render_nginx_ssl() print
# rendered config to stdout, write nothing, call nothing external.
# Sourced by both install_velo.sh (real writes) and velo-manage.sh
# doctor (read-only diff) so the two never carry separate copies of
# this text again.
#
# THIRD ARGUMENT (T-32 item 6): an OPTIONAL public short domain, used
# for the public link base. Empty -- which is what every existing
# caller passes by passing nothing -- must render byte-for-byte what
# this file rendered before the argument existed. That is not a style
# preference: the doctor diffs live nginx against this output, so any
# stray byte on the empty path turns into permanent reported drift on
# every server that did not opt in.
#
# It gets its OWN certificate, hence its own ssl_certificate paths:
# an optional extra may not be able to break the certificate the two
# required domains depend on (see setup_ssl in install_velo.sh).
# render_nginx_ssl takes it only once that certificate exists; until
# then it stays in the HTTP renderer, serving plain HTTP rather than
# pointing nginx at a .pem that is not there -- which would fail
# `nginx -t` and cost the whole config its reload.

render_nginx_http() {
    local domain_frontend="$1" domain_api="$2" domain_public="${3:-}"
    sed "s/__DOMAIN_FRONTEND__/${domain_frontend}/g; s/__DOMAIN_API__/${domain_api}/g" << 'NGINX_EOF'
# VELO — Nginx reverse proxy
# __DOMAIN_FRONTEND__ → frontend (:3000)
# __DOMAIN_API__      → backend  (:8000)

# Frontend
server {
    listen 80;
    server_name __DOMAIN_FRONTEND__;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

# API
server {
    listen 80;
    server_name __DOMAIN_API__;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
NGINX_EOF
    # Appended, not interpolated into the heredoc above: an empty third
    # argument must leave the output untouched to the byte.
    [ -n "$domain_public" ] && sed "s/__DOMAIN_PUBLIC__/${domain_public}/g" << 'PUBLIC_HTTP_EOF'

# Public short domain (optional; no certificate yet -> plain HTTP)
server {
    listen 80;
    server_name __DOMAIN_PUBLIC__;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
PUBLIC_HTTP_EOF
    return 0
}

render_nginx_ssl() {
    local domain_frontend="$1" domain_api="$2" domain_public="${3:-}"
    sed "s/__DOMAIN_FRONTEND__/${domain_frontend}/g; s/__DOMAIN_API__/${domain_api}/g" << 'SSL_NGINX_EOF'
# VELO — Nginx reverse proxy with SSL
# __DOMAIN_FRONTEND__ → frontend (:3000)
# __DOMAIN_API__      → backend  (:8000)

# ── __DOMAIN_FRONTEND__: HTTP → HTTPS ──────────────────────────────────────
server {
    listen 80;
    server_name __DOMAIN_FRONTEND__;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

# ── __DOMAIN_FRONTEND__: HTTPS → frontend ──────────────────────────────────
server {
    listen 443 ssl http2;
    server_name __DOMAIN_FRONTEND__;

    ssl_certificate /etc/letsencrypt/live/__DOMAIN_FRONTEND__/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/__DOMAIN_FRONTEND__/privkey.pem;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;

    # T-47 SECURITY HEADERS. Read the notes before changing any of these.
    #
    # HSTS -- deliberately WITHOUT includeSubDomains. The public short-link
    # domain (see the third block below) is a SUBDOMAIN of a domain we own --
    # the installer asks for it in exactly those words -- so adding that
    # directive here would silently extend HSTS to a domain we chose NOT to
    # pin, and HSTS cannot be withdrawn from browsers that already saw it.
    # Adding includeSubDomains "for completeness" is the specific mistake
    # this comment exists to prevent.
    #
    # max-age is about half a year, not the two years the old commented-out
    # sample carried. Raising it later is a one-line change; LOWERING it does
    # nothing for browsers that already cached the longer value. Start where
    # a mistake is survivable.
    add_header Strict-Transport-Security "max-age=15768000" always;

    # No downside: stops content-type sniffing turning a served file into
    # something executable.
    add_header X-Content-Type-Options "nosniff" always;

    # CSP in REPORT-ONLY, and this is a measurement, NOT protection -- it
    # blocks nothing. It is Report-Only because this is a Telegram Mini App
    # in a WebView: telegram-web-app.js, Vue's inline styles and the Zoom /
    # Stripe calls all have to keep working, a too-narrow policy breaks the
    # app silently, and it breaks it for users rather than for whoever
    # changed it. Collect reports first, then promote to a real
    # Content-Security-Policy in its own change.
    add_header Content-Security-Policy-Report-Only "default-src 'self'; script-src 'self' 'unsafe-inline' https://telegram.org https://*.telegram.org https://js.stripe.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https://*.telegram.org https://api.stripe.com https://*.zoom.us; frame-src https://js.stripe.com https://*.zoom.us; font-src 'self' data:; object-src 'none'; base-uri 'self'" always;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

# ── __DOMAIN_API__: HTTP → HTTPS ────────────────────────────────────────────
server {
    listen 80;
    server_name __DOMAIN_API__;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

# ── __DOMAIN_API__: HTTPS → backend ─────────────────────────────────────────
server {
    listen 443 ssl http2;
    server_name __DOMAIN_API__;

    ssl_certificate /etc/letsencrypt/live/__DOMAIN_FRONTEND__/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/__DOMAIN_FRONTEND__/privkey.pem;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;

    # T-47 SECURITY HEADERS. See the __DOMAIN_FRONTEND__ block above for the
    # full reasoning -- in particular why includeSubDomains is absent (the
    # public short-link domain is a subdomain we deliberately do NOT pin) and
    # why max-age starts at half a year (raising it later is easy, lowering
    # it does nothing for browsers that already cached the longer value).
    add_header Strict-Transport-Security "max-age=15768000" always;
    add_header X-Content-Type-Options "nosniff" always;

    # This host serves the API, not the app: nothing here is meant to be
    # framed or to load third-party resources, so the policy is tighter than
    # the frontend's. Still Report-Only -- same reason, it has never been
    # measured against the real traffic (the OpenAPI docs routes do render
    # HTML from this origin).
    add_header Content-Security-Policy-Report-Only "default-src 'none'; frame-ancestors 'none'; base-uri 'none'" always;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
SSL_NGINX_EOF
    # Same rule as the HTTP renderer: nothing appended when empty.
    # Certificate paths are the PUBLIC domain's own -- it is issued by a
    # separate certbot run, so it is present or absent independently of
    # the certificate the two required domains share.
    [ -n "$domain_public" ] && sed "s/__DOMAIN_PUBLIC__/${domain_public}/g" << 'PUBLIC_SSL_EOF'

# ── __DOMAIN_PUBLIC__: HTTP → HTTPS ─────────────────────────────────────────
server {
    listen 80;
    server_name __DOMAIN_PUBLIC__;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

# ── __DOMAIN_PUBLIC__: HTTPS → backend ──────────────────────────────────────
server {
    listen 443 ssl http2;
    server_name __DOMAIN_PUBLIC__;

    ssl_certificate /etc/letsencrypt/live/__DOMAIN_PUBLIC__/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/__DOMAIN_PUBLIC__/privkey.pem;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;

    # T-47 SECURITY HEADERS -- note what is NOT here.
    #
    # NO Strict-Transport-Security on this domain, on purpose. This is the
    # public short-link host (/z/{code}), opened by people arriving from
    # Telegram channels who have nothing to bypass, and it is the youngest
    # domain we run -- introduced 2026-08-14 by T-35. HSTS cannot be undone
    # in a browser that has already seen it, so pinning a domain that may yet
    # move, or whose certificate automation has not been observed through a
    # full cycle, buys nothing and risks making a public link unreachable.
    #
    # TRIGGER FOR TURNING IT ON, so this is a date and not an opinion: once
    # this domain has survived at least one full certificate renewal on
    # working automation, add the same header the other two blocks carry.
    # Until then the answer to "why is HSTS missing here" is this paragraph.
    #
    # This is also why the blocks above do NOT say includeSubDomains: this
    # domain is a SUBDOMAIN of the main one, so that directive would enable
    # here exactly what this comment declines, irreversibly and by accident.
    add_header X-Content-Type-Options "nosniff" always;

    # Report-Only, as elsewhere. This host serves one redirect-ish landing
    # route; the policy is deliberately not tightened further until there is
    # measurement to tighten it against.
    add_header Content-Security-Policy-Report-Only "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; object-src 'none'; base-uri 'self'" always;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
PUBLIC_SSL_EOF
    return 0
}
