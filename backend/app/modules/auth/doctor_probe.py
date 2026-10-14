# =============================================================================
# VELO Backend -- velo doctor's probe of browser sign-in (Standalone F3 tails)
# =============================================================================
#
# Run INSIDE the app container by `velo doctor`:
#
#     python -m app.modules.auth.doctor_probe
#
# and prints ONE line, nothing else:
#
#     missing=<KEY,KEY|empty> cors=<reason>      -- browser_login.state()
#     error=<ExceptionClassName>                  -- the probe itself failed
#
# The shell turns that line into the doctor's wording. The rule (which keys,
# what a usable CORS_ORIGINS is) lives once, in browser_login.py; the doctor
# does not re-derive it in bash.
#
# NO VALUES, EVER. The line carries key NAMES and a reason word. Everything
# that could quote a value -- the import of the settings (a pydantic
# ValidationError cites the offending input), the state check -- runs inside
# the try below, and a failure prints only the exception's class name: no
# message, no traceback. That is why nothing from `app` is imported at module
# level here, and why the packages on the way (app, app.modules,
# app.modules.auth) must keep importing nothing.
# =============================================================================


def main() -> int:
    try:
        from app.modules.auth import browser_login

        missing, reason = browser_login.state()
        line = f"missing={','.join(missing)} cors={reason}"
    # BaseException on purpose: whatever stops the probe, only its class
    # name may leave.
    except BaseException as exc:
        line = f"error={type(exc).__name__}"
    print(line)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
