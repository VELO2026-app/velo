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

    # add_header Strict-Transport-Security "max-age=63072000" always;

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

    # add_header Strict-Transport-Security "max-age=63072000" always;

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

    # add_header Strict-Transport-Security "max-age=63072000" always;

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
