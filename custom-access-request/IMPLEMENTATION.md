# Implementation - Custom Access Request GUI (OSS)

This fork adds an OSS-safe GUI for per-server, time-limited SSH access by
requesting roles instead of Teleport Enterprise resource access requests.

## Backend

File: `lib/web/accessrequests_custom.go`

Routes registered in `lib/web/apiserver.go`:

| Method | Route | Purpose |
|--------|-------|---------|
| `POST` | `/webapi/sites/:site/accessrequests` | Create a role-based request |
| `GET` | `/webapi/sites/:site/accessrequests` | List the current user's requests |
| `GET` | `/webapi/sites/:site/accessrequests/capabilities` | Return requestable roles |
| `GET` | `/webapi/sites/:site/accessrequests/pending` | List pending custom server-access requests for approvers |
| `POST` | `/webapi/sites/:site/accessrequests/resolve/:request_id` | Approve or deny a request |
| `GET` | `/webapi/sites/:site/accessrequests/approved` | List approved "active grants" (marks ones already revoked) |
| `POST` | `/webapi/sites/:site/accessrequests/revoke/:request_id` | Revoke an active grant by locking the request |
| `POST` | `/webapi/sites/:site/accessrequests/restore/:request_id` | Restore (remove the revoke lock) |

The frontend calls these through `/v1/webapi/...`; the proxy strips `/v1`.

Community-safe auth client methods used:

- `CreateAccessRequestV2`
- `GetAccessRequests`
- `GetAccessCapabilities`
- `SetAccessRequestState`
- `UpsertLock` / `GetLocks` / `DeleteLock` (revoke / restore a grant — see below)

### Revoking an active grant (without locking the user)

Revoke creates a **lock targeting the access request** (`LockTarget.AccessRequest
= <request id>`), via `UpsertLock`. This drops only the elevated access that
request granted — the user's normal access is untouched and they are NOT locked
out as a user. The lock's `Expires` is set to the request's own access expiry so
it **self-cleans** (no permanent lock garbage); re-access is a brand-new request.
Locks are OSS (the web API already exposes `createClusterLock`). Approvers need
`lock` `create`/`list`/`read`/`delete` RBAC — added to the `ssh-approver` role
(`delete` is for Restore). Note: deleting a request does NOT revoke an
already-issued cert; only a lock does.

**Graceful lockout (core change).** Because the GUI "Use access" elevates the
whole web session (`renewSession`), revoking locks that session — every web
request then 403s with a lock-in-force. To avoid the user getting stuck on
"access denied", `web/packages/teleport/src/services/api/api.ts` now detects a
lock-in-force error (via `parseLockInForce` reading `fields['lock-in-force']`,
the same wire mechanism as `proxyVersion`) and calls
`websession.logoutWithoutSlo({withAccessChangedMessage:true})` — mirroring the
existing `isUserSessionRoleNotFoundError` auto-logout. The user is bounced to the
login page and logs back in to their base access. This is safe because web JSON
requests pass through `Authorize`, which only checks identity-scoped lock targets
(never single-resource/node locks). "Restore" removes the lock from the GUI.

Approval and denial deliberately use `SetAccessRequestState`, the same primitive
used by `tctl requests approve|deny`. The code does not use
`SubmitAccessReview`, which belongs to the Enterprise review flow.

The custom handlers only create, list, and approve role requests where all
requested roles use the `ssh-access-` prefix, keeping this GUI scoped to the
per-server access model.

## Frontend

Files under `web/packages/teleport/src`:

- `config.ts`: route, API paths, and URL getters for custom access requests.
- `services/customAccessRequests/`: typed client for create/list/capabilities,
  pending approvals, resolve approve/deny, and assume approved requests.
- `CustomAccessRequest/CustomAccessRequest.tsx`: custom page with two tabs.
- `features.tsx`: registers `FeatureCustomAccessRequest` in OSS features.
- `teleportContext.tsx` and `types.ts`: add a `customAccessRequest` feature
  flag based on real `access_request` create/update ACLs.
- `types.ts`: adds `NavTitle.RequestServerAccess`.

Page URL:

```text
/web/cluster/:clusterId/request-access
```

Navigation:

```text
Identity Governance -> Request Server Access
```

## User Flow

Requester tab:

1. Pick a server role, displayed as a server name. For example,
   `ssh-access-elastic-03` is shown as `elastic-03`.
2. Enter reason and duration.
3. Submit request.
4. Once approved, click `Use access`.
5. The web session is renewed with the approved request ID and redirects to
   Resources.

Approvals tab:

1. Visible to users whose ACL includes access-request update permission.
2. Lists pending custom server-access requests.
3. Approver can enter an optional resolve reason.
4. Approver clicks `Approve` or `Deny`.

CLI remains supported:

```bash
tctl requests approve <request-id>
tsh login --request-id=<request-id>
```

## OSS Guardrails

Do not add these role fields in Community builds:

- `allow.request.search_as_roles`
- `allow.request.thresholds`
- `allow.review_requests`
- `options.request_access: reason | always`

## Build

```bash
pnpm install
make build-ui
make build/teleport
make build/tctl
```

If needed for minimal local builds:

```bash
make build/teleport PIV=no
```
