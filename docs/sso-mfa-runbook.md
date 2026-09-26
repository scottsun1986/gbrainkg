# SSO / OIDC + MFA/TOTP Runbook

This runbook covers operating the ROI-4 authentication upgrades: enterprise
SSO via OIDC (authorization-code flow) and optional TOTP second-factor
authentication. Password login is unchanged when SSO is not configured.

## 1. Feature summary

| Capability | Endpoint(s) | Notes |
|---|---|---|
| Password login | `POST /api/v1/auth/login` | Unchanged when MFA/SSO are off. With MFA on, returns `{mfaRequired, mfaToken}` instead of a session. |
| SSO start | `GET /api/v1/auth/oidc/login` | 302 to the IdP. 404-class error when OIDC is not configured. |
| SSO callback | `GET /api/v1/auth/oidc/callback` | code → token → userinfo → match/JIT user → local JWT. |
| Auth capability probe | `GET /api/v1/auth/config` | `{ oidcEnabled, passwordLoginEnabled }` — powers the "企业 SSO" button. |
| MFA enrolment | `POST /api/v1/auth/mfa/setup` | Returns `otpauth://` URI + base32 secret. |
| MFA confirm | `POST /api/v1/auth/mfa/verify` | Binds TOTP. With `mfaToken`, completes a forced-setup login. |
| MFA second step | `POST /api/v1/auth/mfa/login` | `mfaToken` + TOTP → session JWT. |
| MFA disable | `POST /api/v1/auth/mfa/disable` | Requires password **or** a valid TOTP code. |
| MFA policy (admin) | `GET/PUT /api/v1/admin/security/mfa-policy` | `requireMfaForAdmins` toggle. |
| MFA status (admin) | `GET /api/v1/admin/security/mfa-status` | Read-only enrolment status (never exposes secrets). |

## 2. OIDC configuration

Set in `.env` (see `deploy/production.env.example`):

```bash
OIDC_ISSUER=https://idp.example.com/realms/gbrainkg   # no trailing slash required
OIDC_CLIENT_ID=gbrainkg-web
OIDC_CLIENT_SECRET=...                                 # optional for PKCE-less confidential clients; recommended
OIDC_REDIRECT_URI=https://kb.example.com/api/v1/auth/oidc/callback
OIDC_SCOPES=openid email profile
OIDC_POST_LOGIN_REDIRECT=https://kb.example.com        # optional; defaults to WEB_ORIGIN
```

### IdP registration checklist

1. Create a **confidential** web client.
2. Register the exact `OIDC_REDIRECT_URI` (path must be `/api/v1/auth/oidc/callback`).
3. Allow scopes `openid email profile`.
4. Ensure the userinfo endpoint returns `sub` and `email` (or an RS256 `id_token`
   with those claims — the API falls back to JWKS verification via `node:crypto`).
5. Optional: leave `OIDC_AUTHORIZATION_ENDPOINT` / `OIDC_TOKEN_ENDPOINT` /
   `OIDC_USERINFO_ENDPOINT` / `OIDC_JWKS_URI` empty to use
   `{issuer}/.well-known/openid-configuration` discovery (cached 1 h).

### Behaviour notes

- **JIT provisioning**: first SSO login creates a passwordless user
  (`source=oidc`, `passwordHash=null`, `mustChangePassword=false`) bound to the
  IdP `sub` (`User.oidcSub`). Existing accounts matched by email are **bound**
  (subject attached), never duplicated. An email already bound to a *different*
  subject is rejected.
- **CSRF**: `GET /oidc/login` stores an HMAC-signed state (10 min TTL) in the
  HttpOnly `llmwiki_oidc_state` cookie (double-submit + signature check).
- **MFA interplay**: if the matched user already has MFA enabled, the callback
  redirects to the app with `#mfa_token=…` and the UI asks for a TOTP code.
- **No OIDC config**: `/api/v1/auth/config` reports `oidcEnabled: false`,
  `/api/v1/auth/oidc/*` return 404/501-class errors, and password login is
  byte-for-byte unchanged.
- **No new npm dependencies**: everything runs on Node built-in `fetch` +
  `node:crypto` (HMAC state, RS256 JWKS verification).

## 3. MFA/TOTP configuration

```bash
MFA_ISSUER=GBrainKG           # label shown in authenticator apps
AUTH_LOGIN_THROTTLE_LIMIT=10  # shared login/MFA attempt throttle per minute
```

TOTP is implemented in `apps/api/src/auth/totp.ts` (RFC 4226 HOTP + RFC 6238
TOTP, HMAC-SHA1, 6 digits, 30 s step, ±1 step verify window) and covered by
RFC test vectors in `totp.spec.ts`.

### Enrolment flows

1. **Self-service** (session already held): `POST /auth/mfa/setup` → scan
   `otpauth://` URI → `POST /auth/mfa/verify` with a live code.
2. **Forced admin setup** (`requireMfaForAdmins=true`): password login of a
   privileged account without MFA returns `{mfaSetupRequired, mfaToken}`; the UI
   walks setup then `POST /auth/mfa/verify` with that `mfaToken` returns a real
   session. The same mfaToken works for `POST /auth/mfa/setup`.
3. **Disable**: `POST /auth/mfa/disable` with `{password}` or `{code}`.

### `requireMfaForAdmins`

- Toggle: `PUT /api/v1/admin/security/mfa-policy` with
  `{"requireMfaForAdmins": true}` (needs `system.settings.manage` or `*`).
- Enforced at login (forced setup) and as a backstop in `AdminGuard` —
  privileged sessions without MFA cannot use `/api/v1/admin/*` until enrolled.
- Non-admin users are unaffected.

### Login response shapes (MFA on)

```jsonc
// step 1 (password ok, TOTP required)
{ "mfaRequired": true, "mfaToken": "<short-lived ticket, 5 min, purpose=mfa>", "expiresIn": 300 }

// step 2 POST /api/v1/auth/mfa/login { mfaToken, code }
{ "token": "<session JWT>", "expiresIn": 28800, "user": { ... } }
```

`mfaToken` tickets are HMAC-signed with `purpose=mfa` and are **rejected** as
Bearer session tokens (`userIdFromRequest` filters them out).

## 4. Frontend

- `apps/web/src/components/auth/LoginScreens.tsx`: `LoginScreen` (SSO button
  when `oidcEnabled`), `MfaScreen` (TOTP input), `MfaSetupScreen` (QR/secret +
  code confirm), `PasswordChangeScreen` (unchanged).
- `apps/web/src/app/page.tsx`: handles `mfaRequired` / `mfaSetupRequired`
  responses, the MFA login/setup calls, the SSO button redirect, and the
  `/#token=` / `#mfa_token=` / `#mfa_setup_token=` / `#sso_error=` fragments
  produced by the OIDC callback.

## 5. Rollout

1. Apply the migration (adds `User.mfaSecret/mfaEnabled/mfaEnabledAt/oidcSub`
   and the `SystemSetting` table):

   ```bash
   cd packages/database
   npx prisma migrate deploy --schema=prisma/schema.prisma
   ```

2. Redeploy the API + web app.
3. (Optional) configure `OIDC_*` values and register the redirect URI at the IdP.
4. (Recommended) after admins have enrolled TOTP, set
   `requireMfaForAdmins=true` via `PUT /api/v1/admin/security/mfa-policy`.
5. Verify with `GET /api/v1/auth/config` (`oidcEnabled` flips to `true`) and a
   test SSO login.

## 6. Verification / tests

```bash
cd apps/api
npx tsc --noEmit
npx jest --testPathPattern='auth' --no-coverage
```

Covered by `apps/api/src/auth/{totp,mfa,oidc}.spec.ts`:

- RFC 4226 HOTP 10-count vectors + RFC 6238 SHA-1 time vectors (6- and 8-digit).
- Two-step password login (mfaRequired → mfaToken+TOTP → session; mfaToken
  rejected as Bearer; wrong code rejected).
- Enrolment (setup/verify/disable incl. password-or-TOTP gate).
- `requireMfaForAdmins` forced setup for admins, pass-through for others.
- OIDC callback JIT (new user), email-binding of an existing user, subject
  conflict rejection, MFA-enabled users getting `mfaToken`, forged/missing
  state rejection, unconfigured → NotFound, RS256 id_token+JWKS fallback.

## 7. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| "OIDC SSO is not configured" | Missing `OIDC_ISSUER`/`OIDC_CLIENT_ID`/`OIDC_REDIRECT_URI` | Fill all three and restart the API |
| `Unable to load OIDC discovery document` | Bad issuer URL / network | Check `OIDC_ISSUER`, or set explicit `OIDC_*_ENDPOINT`s |
| "OIDC state cookie is missing/mismatched" | Cookie blocked or cross-site redirect stripped | Ensure first-party redirect; state cookie is `SameSite=Lax` |
| "OIDC token exchange failed" | Wrong client secret or redirect URI mismatch | Re-check IdP client settings vs `OIDC_REDIRECT_URI` |
| "This email is already linked to a different SSO identity" | User bound to another IdP `sub` | Admin clears `User.oidcSub` or unlinks at the IdP |
| TOTP codes rejected | Clock skew > 30 s | NTP on the server; verify window is already ±1 step |
| Admin locked out after enabling `requireMfaForAdmins` | Policy on, admin has no TOTP | Login with password → forced setup screen; or temporarily flip policy off via DB `SystemSetting` |

## 8. Security invariants

- Access JWTs and mfaTickets are purpose-separated (`purpose=mfa`); a ticket can
  never be replayed as a session.
- MFA secrets (`User.mfaSecret`) are never returned by any API except the one-time
  `POST /auth/mfa/setup` response.
- Disable-MFA requires re-proof (password or live TOTP).
- OIDC state is HMAC-signed, time-boxed (10 min), and double-submitted via
  HttpOnly cookie.
- `id_token` fallback verification is RS256-only and nonce-checked against the
  state nonce.
