# HANDOFF — Custom OSS Access Request GUI (for the next agent)

> **Read this fully before doing anything.** Another agent (Claude) designed and
> wrote this feature but could NOT build it (the dev machine was Windows; the
> Teleport server only builds/runs on Linux). Your job is to **build it on a
> Linux machine, fix any compile/lint errors, and test it end-to-end** — NOT to
> redesign it. The architecture below is verified against the source; keep it.

---

## 0. TL;DR — what you must do

1. On a Linux machine with Go 1.26.4 + Node 24.16.0 + pnpm, build:
   `pnpm install` → `make build-ui` → `make teleport`.
2. Fix any compile errors that surface (the code was not compilable on the
   machine where it was written). Section 6 lists the likely ones and exact fixes.
3. Apply the role config, then test the flow end-to-end (Section 7).
4. Do **not** add any enterprise-gated fields to roles (Section 2 guardrails) or
   the Community build will reject them.

The code lives on branch **`main`** of the user's fork
`origin = https://github.com/MinhDuc-ThaiBui77/teleport.git`, as a **single
squashed initial commit** (Teleport's full upstream history was intentionally
NOT pushed, per the user). The upstream CI workflows under `.github/workflows/`
were **removed** from this snapshot — the push credential (a PAT) lacked GitHub's
`workflow` token scope, and those workflows are not needed to build Teleport
locally. The `upstream` remote points at `https://github.com/gravitational/teleport.git`.

---

## 1. Background — the problem

The user runs Teleport **Community (OSS)** and cannot buy Enterprise. They want
**per-user, per-server, time-limited SSH access** with a self-service GUI.

Findings (verified in this source tree):
- **Resource-based access requests are enterprise-gated.** They require
  `allow.request.search_as_roles`, which `lib/auth/auth_with_roles.go`
  (`checkRoleFeatureSupport`, ~line 5501) rejects when
  `mod.BuildType() != BuildEnterprise`: *"role field allow.search_as_roles is
  only available in enterprise subscriptions"*.
- **Role-based access requests are NOT gated.** `CreateAccessRequestV2`
  (`lib/auth/auth_with_roles.go` ~line 3272) only checks RBAC, not the license.
- The OSS web UI only ships a **locked** Access Requests page
  (`web/packages/teleport/src/AccessRequests/LockedAccessRequests.tsx`); the real
  create-request HTTP endpoint is registered by the closed-source `e/` plugin,
  which is absent from this OSS clone.

**Solution implemented:** emulate "request a server" with "request a role" — one
role per server (`ssh-access-<server>`). Add our own OSS HTTP endpoints + a
custom React page. Approval is done with `tctl requests approve` (which calls
`SetAccessRequestState`, RBAC verb `update`, NOT enterprise-gated), **not**
`tsh request review` (which calls `SubmitAccessReview` and needs the
enterprise-gated `allow.review_requests`).

---

## 2. Design decisions & OSS guardrails (DO NOT VIOLATE)

These role fields are rejected on a Community build — **never** put them in any
role, or `tctl create` fails:
- `allow.request.search_as_roles`
- `allow.request.thresholds`
- `allow.review_requests`
- `options.request_access: reason | always`

The custom page is gated on the user's **real RBAC create permission**
(`flags.newAccessRequest`, i.e. `access_request` verb `create`), **NOT** on the
enterprise entitlement `cfg.entitlements.AccessRequests.enabled`. This is why it
works on OSS. Do not change this gating to the entitlement.

---

## 3. What is already implemented (file map)

### Backend (Go) — compiled into the proxy/`teleport` binary
- **`lib/web/accessrequests_custom.go`** (NEW) — three handlers:
  - `createAccessRequest` — builds a role-only `types.NewAccessRequest(uuid, user, roles...)`,
    sets reason/maxDuration/suggestedReviewers/dryRun, calls
    `clt.CreateAccessRequestV2`.
  - `listAccessRequests` — `clt.GetAccessRequests(ctx, types.AccessRequestFilter{User: sctx.GetUser()})`.
  - `getAccessRequestCapabilities` — `clt.GetAccessCapabilities(ctx, types.AccessCapabilitiesRequest{RequestableRoles:true, SuggestedReviewers:true})`.
  - Auth client obtained via `sctx.GetUserClient(ctx, cluster)`.
- **`lib/web/apiserver.go`** (EDITED) — 3 routes registered right after the lock
  handlers block (search for `accessrequests`):
  ```go
  h.GET("/webapi/sites/:site/accessrequests", h.WithClusterAuth(h.listAccessRequests))
  h.POST("/webapi/sites/:site/accessrequests", h.WithClusterAuth(h.createAccessRequest))
  h.GET("/webapi/sites/:site/accessrequests/capabilities", h.WithClusterAuth(h.getAccessRequestCapabilities))
  ```
  Note: the frontend calls `/v1/webapi/...`; the proxy strips the `/v1` prefix
  (`apiserver.go`, `v1Prefix = "/v1"` + `http.StripPrefix`), so it maps to these
  `/webapi/...` routes. This is the same pattern as the existing nodes endpoint.

### Frontend (React/TS) — `web/packages/teleport/src`
- **`config.ts`** (EDITED):
  - route `customAccessRequest: '/web/cluster/:clusterId/request-access'`
  - api `accessRequestsCustomPath`, `accessRequestsCustomCapabilitiesPath`
  - getters `getCustomAccessRequestRoute`, `getAccessRequestsCustomUrl`,
    `getAccessRequestsCustomCapabilitiesUrl`
- **`types.ts`** (EDITED): added `NavTitle.RequestServerAccess`.
- **`services/customAccessRequests/`** (NEW): `customAccessRequests.ts` (typed
  client: `fetchCustomAccessRequestCapabilities`, `fetchMyCustomAccessRequests`,
  `createCustomAccessRequest`) + `index.ts`.
- **`CustomAccessRequest/`** (NEW): `CustomAccessRequest.tsx` (the page:
  pick server-role(s) via checkboxes → reason → duration → submit; plus a
  "my requests" table) + `index.ts`.
- **`features.tsx`** (EDITED): `FeatureCustomAccessRequest` registered in
  `getOSSFeatures()`. Routing auto-mounts via `Main.tsx` (iterates `feature.route`).

Page URL: `/web/cluster/:clusterId/request-access`. Nav: Identity Governance →
**"Request Server Access"**.

### Role config & docs — `custom-access-request/`
- `roles/ssh-access-server-template.yaml` — clone once per server.
- `roles/ssh-requester.yaml` — assign to normal users.
- `roles/ssh-approver.yaml` — assign to admins.
- `README.md` (role model + CLI test), `IMPLEMENTATION.md` (file-level detail).
- `teleport-build-precheck.sh` (repo root) — read-only env check for a build VM.

---

## 4. Current status

- ✅ Code complete and pushed to the user's fork on branch `main` (squashed
  initial commit; `.github/workflows/` removed to satisfy the push token scope).
- ✅ `gofmt` clean on the Go file. All Go and TS symbols used were verified
  against the source (constructors, setters, getters, client methods,
  `h.clock`, `sctx.GetUser`, design exports, theme colors, `useAsync`, routing).
- ❌ **NOT built / NOT type-checked end to end** — the authoring machine could
  not compile (Windows: no CGO/Linux for the Go side; no `node_modules`/pnpm for
  the TS side). **Expect the first Linux build to surface a few small errors.**
- Backend approval path for OSS = `tctl requests approve` (verified in
  `tool/tctl/common/access_request_command.go`).

---

## 5. YOUR TASKS — exact steps (run on Linux)

### 5.1 Toolchain (if the machine is fresh)
Required (from `build.assets/versions.mk`): Go **1.26.4**, Node **24.16.0**,
pnpm (via `corepack enable`). gcc/make/git needed (CGO). Optional and skippable:
Rust (rdpclient), BPF, PIV (`libpcsclite`). You can sanity-check the machine with
`bash teleport-build-precheck.sh /path/to/teleport`.

### 5.2 Build
```bash
cd /path/to/teleport
git checkout feature/custom-access-request-gui
pnpm install                 # installs web deps
make build-ui                # builds OSS web assets into webassets/teleport/
make teleport                # builds ./build/teleport with web UI embedded
```
If `make teleport` complains about PIV/pcsclite, build without it (PIV is not
needed for this feature). Try `make teleport PIV=no` or consult `make help` /
the Makefile variables.

### 5.3 Run a local cluster (for testing)
```bash
./build/teleport version
# Minimal all-in-one config (auth+proxy+ssh) — generate or write teleport.yaml.
sudo ./build/teleport start -c /etc/teleport.yaml
# build tctl too if needed:
make tctl
```

### 5.4 Apply roles & test (see custom-access-request/README.md for full detail)
```bash
./build/tctl create -f custom-access-request/roles/ssh-access-server-template.yaml
./build/tctl create -f custom-access-request/roles/ssh-requester.yaml
./build/tctl create -f custom-access-request/roles/ssh-approver.yaml
./build/tctl users update <user> --set-roles=ssh-requester,<existing>
```
Then log into the web UI as `<user>` → Identity Governance →
**"Request Server Access"** → pick a role → submit. Approve with
`./build/tctl requests approve <id>`.

### 5.5 Fast frontend iteration (no Go rebuild)
```bash
PROXY_TARGET=localhost:3080 pnpm start-teleport   # Vite dev server, hot reload
```

---

## 6. Likely errors & exact fixes

> Most risk is on the frontend (it was never type-checked). The Go side is
> small and every symbol was verified, but check anyway.

### 6.1 Frontend TypeScript errors (`make build-ui` / `tsc`)
- **Import ordering / prettier-eslint failures**: these do NOT block a Vite
  build or the dev server. If a separate lint step fails, auto-fix:
  `pnpm prettier --write web/packages/teleport/src/CustomAccessRequest/*.tsx web/packages/teleport/src/services/customAccessRequests/*.ts`
  and run the repo's eslint with `--fix`. Do not hand-reorder for hours.
- **`TextArea` props**: the page uses `<TextArea value onChange rows placeholder>`
  from `design`. If `TextArea` does not accept these, replace it with
  `FieldTextArea` from `shared/components/FieldTextArea/FieldTextArea` (used in
  `web/packages/teleport/src/Bots/Edit/EditDialog.tsx`) or design `Input`.
- **`Alert kind="success"`**: verified valid (`design/Alert` AlertKind includes
  `'success'`). If types complain, import `{ Success }` from `design/Alert`
  instead, or use `<Alert kind="success">`.
- **`color="text.muted"` / `"text.slightlyMuted"`**: verified to exist in
  `design/src/theme/themes/types.ts`. If a theme lacks one, use `"text.muted"`.
- **`styled(Box)` / `styled(Flex)` theme access**: `p.theme.colors.spotBackground`
  is `string[]` (verified). Keep `[0]`/`[1]` indexing.
- **`useAsync` import**: `import { useAsync } from 'shared/hooks/useAsync';`
  returns `[attempt, run, setState]`; `attempt.status` is
  `'' | 'processing' | 'success' | 'error'`, `attempt.data`, `attempt.statusText`.

### 6.2 Go compile errors (`make teleport`)
- **`httplib.ReadResourceJSON`**: used to decode the POST body (same as
  `lib/web/servers.go` `handleNodeCreate`). If it errors, swap to
  `httplib.ReadJSON`.
- **`h.clock`**: the `Handler` has a `clock` field (set via `SetClock`, used at
  e.g. `apiserver.go:4292`). If absent in your version, use `time.Now().UTC()`.
- **`sctx.GetUser()`**: returns the username (`lib/web/sessions.go:421`).
- **`types.AccessRequestFilter{User: ...}`**: filter by user. If the field name
  differs, grep `type AccessRequestFilter` in `api/types`.
- **Access request setters/getters** (verified in `api/types/access_request.go`):
  `NewAccessRequest(name,user,roles...)`, `SetRequestReason`, `SetMaxDuration`,
  `SetSuggestedReviewers`, `SetDryRun`, `GetName/GetUser/GetRoles/GetState()/
  GetRequestReason/GetCreationTime/GetAccessExpiry/GetMaxDuration`.
- **Client methods** (on `authclient.ClientI`, verified): `CreateAccessRequestV2`,
  `GetAccessRequests`, `GetAccessCapabilities`. If a name differs, grep the
  interface in `lib/services/access_request.go` and `lib/auth/authclient/clt.go`.
- **httprouter route-conflict panic at startup**: if it complains about
  `/webapi/sites/:site/accessrequests`, ensure the 3 routes are registered once
  and there is no other handler on the same path.

### 6.3 Runtime (after it builds)
- **Nav item missing**: the user's role must grant `access_request` verb
  `create` (the `ssh-requester` role does). Check `flags.newAccessRequest`.
- **403 / "access denied" on create**: the user must hold a role whose
  `allow.request.roles` matches the requested role (e.g. `ssh-access-*`).
- **Empty role dropdown**: `GetAccessCapabilities` returns no requestable roles —
  means `allow.request.roles` doesn't match any existing role; check role names.
- **Endpoints 404**: confirm the routes compiled in (rebuild `teleport`), and
  remember the frontend path is `/v1/webapi/...` (proxy strips `/v1`).

---

## 7. Definition of done (verify these)
1. `make teleport` produces `./build/teleport` with the web UI embedded.
2. Logged in as a `ssh-requester` user, the **"Request Server Access"** page
   loads and lists requestable roles.
3. Submitting creates a PENDING request (visible in the page's table and in
   `tctl requests ls`).
4. `tctl requests approve <id>` approves it; `tsh login --request-id=<id>` then
   grants SSH to the target server.
5. Access expires after the role's `max_session_ttl`.

---

## 8. Rules for you (the next agent)
- Keep changes minimal and on `main` (or a feature branch off it).
- Do NOT push to `upstream` (gravitational/teleport). Push only to `origin`
  (the user's fork).
- If you re-introduce any `.github/workflows/` files, the push will be rejected
  unless the GitHub credential has the `workflow` token scope. The snapshot has
  them removed on purpose; leave them out unless you set up a scoped token.
- Do NOT add a `Co-Authored-By` trailer to commits (user preference).
- Do NOT introduce enterprise-gated role fields (Section 2).
- If you must change the API contract, update both the Go handlers and the TS
  service + `config.ts` together, and update `custom-access-request/IMPLEMENTATION.md`.
- When unsure whether a symbol exists, grep the source and verify before using —
  do not invent APIs.
