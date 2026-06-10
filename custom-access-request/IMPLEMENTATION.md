# Implementation — Custom Access Request GUI (OSS)

Status: **code complete, not yet built**. Build on a Linux machine (Teleport
server does not run on Windows). Branch: `feature/custom-access-request-gui`.

## What was added

### Backend (Go) — proxy web API
- **New file** `lib/web/accessrequests_custom.go` — three OSS-safe handlers:
  | Method | Route (registered in `lib/web/apiserver.go`) | Purpose |
  |--------|----------------------------------------------|---------|
  | `POST` | `/webapi/sites/:site/accessrequests` | create a role-based request |
  | `GET`  | `/webapi/sites/:site/accessrequests` | list current user's requests |
  | `GET`  | `/webapi/sites/:site/accessrequests/capabilities` | roles the user may request |
- Uses only Community-available auth client methods: `CreateAccessRequestV2`,
  `GetAccessRequests`, `GetAccessCapabilities`. No enterprise-gated calls.
- The frontend calls these as `/v1/webapi/...`; the proxy strips the `/v1`
  prefix (`lib/web/apiserver.go`), so they map to the `/webapi/...` routes.

### Frontend (React/TS) — `web/packages/teleport/src`
- **`config.ts`** — added route `customAccessRequest`, api paths
  `accessRequestsCustomPath` + `accessRequestsCustomCapabilitiesPath`, and
  getters `getCustomAccessRequestRoute` / `getAccessRequestsCustomUrl` /
  `getAccessRequestsCustomCapabilitiesUrl`.
- **`types.ts`** — added `NavTitle.RequestServerAccess`.
- **New `services/customAccessRequests/`** — typed API client (`fetch…`,
  `create…`).
- **New `CustomAccessRequest/CustomAccessRequest.tsx`** — the page: pick
  server-role(s) → reason → duration → submit; plus a "my requests" table.
- **`features.tsx`** — registered `FeatureCustomAccessRequest` (nav item +
  route) in `getOSSFeatures()`. Gated on the user's real RBAC create permission
  (`flags.newAccessRequest`), NOT the enterprise entitlement, so it shows on OSS.
- Routing is automatic: `Main.tsx` mounts every feature's `route`.

Page URL: `/web/cluster/:clusterId/request-access`. Nav: Identity Governance →
"Request Server Access" (visible to users whose role grants
`access_request` `create`, e.g. the `ssh-requester` role).

## Build (on the Linux build machine)
```bash
pnpm install                 # Node 24.16.0, pnpm
make build-ui                # builds OSS web assets -> webassets/teleport/
make teleport                # builds ./build/teleport with assets embedded
```

## Fast dev loop (no Go rebuild for frontend changes)
```bash
# run the built proxy somewhere reachable, then:
PROXY_TARGET=localhost:3080 pnpm start-teleport   # Vite, hot reload
```

## End-to-end test
1. Apply the roles in `roles/` and assign `ssh-requester` to a test user
   (see README.md).
2. Log into the web UI as that user → Identity Governance →
   "Request Server Access" → pick a server role → submit.
3. Approve from CLI (OSS-safe): `tctl requests approve <id>`.
4. The user runs `tsh login --request-id=<id>` and connects; access expires
   after the role's `max_session_ttl`.

## Backend quick-check without the UI
```bash
curl -k -b <session-cookie> \
  https://<proxy>/v1/webapi/sites/<cluster>/accessrequests/capabilities
curl -k -b <session-cookie> -X POST \
  -d '{"roles":["ssh-access-web1"],"reason":"test"}' \
  https://<proxy>/v1/webapi/sites/<cluster>/accessrequests
```

## Maintenance (fork upkeep)
- The handler lives in its own file (`accessrequests_custom.go`); only
  `apiserver.go` has a 3-line route block to re-apply on rebase.
- Frontend additions are isolated (new dirs + small diffs to `config.ts`,
  `types.ts`, `features.tsx`).
