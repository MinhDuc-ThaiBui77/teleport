# Custom Access Request (OSS) — role model & test guide

Goal: per-user, per-server, time-limited SSH access on Teleport **Community**,
by emulating "request access to a server" with the OSS-available
"request access to a role" feature (one role per server).

## The three roles

| File | Assigned to | Purpose |
|------|-------------|---------|
| `roles/ssh-access-server-template.yaml` | nobody (requested only) | One per target server. Grants SSH to exactly that host, time-limited. |
| `roles/ssh-requester.yaml` | normal users | Right to *request* the per-server roles + RBAC for the GUI. |
| `roles/ssh-approver.yaml` | admins | Approve/deny via `tctl requests approve` (OSS-safe). |

## Test it TODAY on your existing v15 docker (no build needed)

This validates the whole RBAC model independently of the GUI.

1. **Label the target node.** In the target server's `teleport.yaml`:
   ```yaml
   ssh_service:
     enabled: true
     labels:
       access-id: web1
   ```
   (restart that node so the label takes effect)

2. **Create the roles** (run where `tctl` can reach auth):
   ```bash
   tctl create -f roles/ssh-access-server-template.yaml
   tctl create -f roles/ssh-requester.yaml
   tctl create -f roles/ssh-approver.yaml
   ```
   > If v15 rejects `version: v7`, change it to `v6` in the files and retry.

3. **Assign roles to users:**
   ```bash
   tctl users update <normaluser> --set-roles=ssh-requester,<their-other-roles>
   tctl users update <admin>      --set-roles=ssh-approver,<their-other-roles>
   ```

4. **As the normal user — request access to one server:**
   ```bash
   tsh login --proxy=<proxy> --user=<normaluser>
   tsh request create --roles=ssh-access-web1 --reason="deploy hotfix"
   # note the request ID it prints
   ```

5. **As the admin — approve (OSS-safe):**
   ```bash
   tctl requests ls
   tctl requests approve <request-id> --reason="ok for incident #123"
   ```

6. **As the normal user — assume the access & connect:**
   ```bash
   tsh login --request-id=<request-id>
   tsh ssh ubuntu@web1
   ```

7. **Verify the time limit:** after `max_session_ttl` (4h) the elevated access
   should expire and SSH to `web1` should be denied again.

## OSS guardrails (do not cross)

These are rejected on a Community build — keep them OUT of every role:
- `allow.request.search_as_roles`  (resource requests — enterprise only)
- `allow.request.thresholds`       (multi-approver — enterprise only)
- `allow.review_requests`          (review flow — enterprise only)
- `options.request_access: reason|always`  (enterprise only)

Approval therefore uses `tctl requests approve` (SetAccessRequestState), not
`tsh request review` (SubmitAccessReview, gated).
