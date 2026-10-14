// =============================================================================
// VELO Frontend -- Where the session token is kept (Standalone phase 3)
// =============================================================================
//
// One implementation, two carriers -- the platform picks the carrier:
//
//   standalone -> localStorage. The installed app (home screen) and the
//                 browser tab keep the sign-in between launches for the
//                 session's lifetime (30 days on the server), as every PWA
//                 does (Standalone §1 item 14). sessionStorage died with each
//                 launch of the installed app.
//   telegram   -> sessionStorage, as before: one run of the Mini App. Every
//                 open signs in again with fresh initData, which refreshes the
//                 profile and the comms snapshot (auth/service.py). A
//                 persistent token would win over initData on the next open
//                 -- and, on a device shared by two Telegram accounts, would
//                 restore the OTHER account's session. Telegram therefore
//                 never reads localStorage.
//
// Storage that throws (blocked, private mode) reads as "no token" and
// writes nothing: the session then lives in memory for this page only.
// =============================================================================

/** The key, the same in both carriers. */
export const SESSION_TOKEN_KEY = 'velo_token'

export interface SessionTokenStore {
  read(): string | null
  write(token: string | null): void
}

export function sessionTokenStore(storage: () => Storage): SessionTokenStore {
  return {
    read(): string | null {
      try {
        return storage().getItem(SESSION_TOKEN_KEY) || null
      } catch {
        return null
      }
    },
    write(token: string | null): void {
      try {
        if (token) {
          storage().setItem(SESSION_TOKEN_KEY, token)
        } else {
          storage().removeItem(SESSION_TOKEN_KEY)
        }
      } catch {
        // Unwritable storage: the token stays in memory only.
      }
    },
  }
}
