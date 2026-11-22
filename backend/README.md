# VELO Backend

Platform for wellness practice facilitators — meditation, yoga, breathwork.

**Stack:** Python 3.12 · FastAPI · SQLAlchemy 2.0 (async) · PostgreSQL 16 · Redis 7

## Deployment

The deploy machine pridem installs velo and rolls it out on every box, by
`primer.yaml` at the repository root (stacks, seeds, verbs) and the box's
passport. There is nothing to run by hand on a box but `pridem`:

```
pridem update                            -- Roll the box out to its source
pridem status                            -- The box's composition, under its lock
pridem logs velo [app|postgres|redis]    -- View logs
pridem restart velo [app]                -- Restart the stack or one service
pridem db connect velo                   -- psql, every transaction read-only
pridem db migrate velo                   -- Run the stack's migrate
pridem backup                            -- Dump every database of the box
pridem verb <name> [<arg>=<value> ...]   -- A verb of primer.yaml `verbs`
```

Tests run in CI on every push (`.github/workflows/backend-tests.yml`) and,
on a box of the role test, before the migrations of every rollout
(`primer.yaml` `test.run`).

## Architecture

Modular monolith — each module in `app/modules/` is an isolated domain:

```
backend/app/
├── core/           # DB, Redis, config, exceptions, logging
└── modules/
    ├── auth/       # Telegram WebApp auth, sessions
    ├── users/      # Profiles, roles
    ├── masters/    # Master profiles, verification
    ├── practices/  # CRUD, pricing
    ├── bookings/   # Reservations, waitlist
    ├── payments/   # Double-entry ledgers, Stripe
    └── ...
```

Each module: `models.py → schemas.py → service.py → router.py`
