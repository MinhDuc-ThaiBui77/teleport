/*
 * Teleport
 * Copyright (C) 2026  Gravitational, Inc.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

// This file is a CUSTOM (fork) addition. It exposes a minimal, OSS-safe HTTP
// API for ROLE-BASED access requests so a custom web UI can let users request
// time-limited access to individual servers (one role per server).
//
// It deliberately uses only functionality available in the Community build:
//   - clt.CreateAccessRequestV2 is RBAC-gated only (not license-gated).
//   - clt.GetAccessCapabilities returns the roles the user may request.
// It does NOT touch resource-based requests (search_as_roles), thresholds, or
// the review flow, all of which are enterprise-gated.
//
// Keeping these handlers in their own file makes rebasing onto new Teleport
// releases easier (routes are registered in apiserver.go).

package web

import (
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/gravitational/trace"
	"github.com/julienschmidt/httprouter"

	"github.com/gravitational/teleport/api/types"
	"github.com/gravitational/teleport/lib/httplib"
	"github.com/gravitational/teleport/lib/reversetunnelclient"
)

const customServerAccessRolePrefix = "ssh-access-"

// createAccessRequestReq is the JSON body for creating a role-based access request.
type createAccessRequestReq struct {
	// Roles is the list of roles being requested (e.g. per-server roles like
	// "ssh-access-web1"). Required.
	Roles []string `json:"roles"`
	// Reason is an optional justification shown to approvers.
	Reason string `json:"reason"`
	// MaxDurationMs optionally caps how long the granted access lasts, expressed
	// in milliseconds from now. If zero, the cluster/role default applies.
	MaxDurationMs int64 `json:"maxDurationMs"`
	// SuggestedReviewers is an optional list of usernames suggested to review.
	SuggestedReviewers []string `json:"suggestedReviewers"`
	// DryRun, when true, validates the request without actually creating it.
	DryRun bool `json:"dryRun"`
}

// resolveAccessRequestReq is the JSON body for approving or denying a request.
type resolveAccessRequestReq struct {
	// State must be APPROVED or DENIED.
	State string `json:"state"`
	// Reason is an optional resolve reason shown in audit/request details.
	Reason string `json:"reason"`
}

// accessRequestInfo is the JSON representation of an access request returned to
// the UI. It intentionally exposes only the fields the custom UI needs.
type accessRequestInfo struct {
	ID          string    `json:"id"`
	User        string    `json:"user"`
	Roles       []string  `json:"roles"`
	State       string    `json:"state"`
	Reason      string    `json:"reason,omitempty"`
	Created     time.Time `json:"created"`
	Expires     time.Time `json:"expires"`
	MaxDuration time.Time `json:"maxDuration"`
}

func makeAccessRequestInfo(req types.AccessRequest) accessRequestInfo {
	return accessRequestInfo{
		ID:          req.GetName(),
		User:        req.GetUser(),
		Roles:       req.GetRoles(),
		State:       req.GetState().String(),
		Reason:      req.GetRequestReason(),
		Created:     req.GetCreationTime(),
		Expires:     req.GetAccessExpiry(),
		MaxDuration: req.GetMaxDuration(),
	}
}

func isCustomServerAccessRequest(req types.AccessRequest) bool {
	roles := req.GetRoles()
	if len(roles) == 0 {
		return false
	}

	for _, role := range roles {
		if !strings.HasPrefix(role, customServerAccessRolePrefix) {
			return false
		}
	}
	return true
}

func filterCustomServerAccessRoles(roles []string) []string {
	filtered := make([]string, 0, len(roles))
	for _, role := range roles {
		if strings.HasPrefix(role, customServerAccessRolePrefix) {
			filtered = append(filtered, role)
		}
	}
	return filtered
}

func parseResolveState(state string) (types.RequestState, error) {
	switch strings.ToUpper(strings.TrimSpace(state)) {
	case "APPROVED", "APPROVE":
		return types.RequestState_APPROVED, nil
	case "DENIED", "DENY":
		return types.RequestState_DENIED, nil
	default:
		return types.RequestState_NONE, trace.BadParameter("state must be APPROVED or DENIED")
	}
}

// listAccessRequestsResponse is the JSON body returned when listing requests.
type listAccessRequestsResponse struct {
	Items []accessRequestInfo `json:"items"`
}

// accessRequestCapabilitiesResponse tells the UI which roles the user may
// request (to populate the server/role picker) and related hints.
type accessRequestCapabilitiesResponse struct {
	RequestableRoles   []string `json:"requestableRoles"`
	SuggestedReviewers []string `json:"suggestedReviewers"`
	RequireReason      bool     `json:"requireReason"`
}

// createAccessRequest creates a role-based access request for the current user.
//
// POST /webapi/sites/:site/accessrequests
func (h *Handler) createAccessRequest(w http.ResponseWriter, r *http.Request, p httprouter.Params, sctx *SessionContext, cluster reversetunnelclient.Cluster) (any, error) {
	ctx := r.Context()

	var req createAccessRequestReq
	if err := httplib.ReadResourceJSON(r, &req); err != nil {
		return nil, trace.Wrap(err)
	}

	if len(req.Roles) == 0 {
		return nil, trace.BadParameter("at least one role must be requested")
	}
	for _, role := range req.Roles {
		if !strings.HasPrefix(role, customServerAccessRolePrefix) {
			return nil, trace.BadParameter("role %q is not a custom server-access role", role)
		}
	}

	clt, err := sctx.GetUserClient(ctx, cluster)
	if err != nil {
		return nil, trace.Wrap(err)
	}

	// Build a role-only access request for the current user. The auth server
	// overwrites the name with a server-generated UUID, but NewAccessRequest
	// requires a non-empty name, so we pass a placeholder.
	accessReq, err := types.NewAccessRequest(uuid.New().String(), sctx.GetUser(), req.Roles...)
	if err != nil {
		return nil, trace.Wrap(err)
	}

	if req.Reason != "" {
		accessReq.SetRequestReason(req.Reason)
	}
	if len(req.SuggestedReviewers) > 0 {
		accessReq.SetSuggestedReviewers(req.SuggestedReviewers)
	}
	if req.MaxDurationMs > 0 {
		accessReq.SetMaxDuration(h.clock.Now().UTC().Add(time.Duration(req.MaxDurationMs) * time.Millisecond))
	}
	if req.DryRun {
		accessReq.SetDryRun(true)
	}

	created, err := clt.CreateAccessRequestV2(ctx, accessReq)
	if err != nil {
		return nil, trace.Wrap(err)
	}

	return makeAccessRequestInfo(created), nil
}

// listAccessRequests returns the current user's access requests.
//
// GET /webapi/sites/:site/accessrequests
func (h *Handler) listAccessRequests(w http.ResponseWriter, r *http.Request, p httprouter.Params, sctx *SessionContext, cluster reversetunnelclient.Cluster) (any, error) {
	ctx := r.Context()

	clt, err := sctx.GetUserClient(ctx, cluster)
	if err != nil {
		return nil, trace.Wrap(err)
	}

	reqs, err := clt.GetAccessRequests(ctx, types.AccessRequestFilter{
		User: sctx.GetUser(),
	})
	if err != nil {
		return nil, trace.Wrap(err)
	}

	items := make([]accessRequestInfo, 0, len(reqs))
	for _, req := range reqs {
		if !isCustomServerAccessRequest(req) {
			continue
		}
		items = append(items, makeAccessRequestInfo(req))
	}

	return listAccessRequestsResponse{Items: items}, nil
}

// listPendingAccessRequests returns pending custom server-access requests for
// users allowed to approve them.
//
// GET /webapi/sites/:site/accessrequests/pending
func (h *Handler) listPendingAccessRequests(w http.ResponseWriter, r *http.Request, p httprouter.Params, sctx *SessionContext, cluster reversetunnelclient.Cluster) (any, error) {
	ctx := r.Context()

	clt, err := sctx.GetUserClient(ctx, cluster)
	if err != nil {
		return nil, trace.Wrap(err)
	}

	reqs, err := clt.GetAccessRequests(ctx, types.AccessRequestFilter{
		State: types.RequestState_PENDING,
	})
	if err != nil {
		return nil, trace.Wrap(err)
	}

	items := make([]accessRequestInfo, 0, len(reqs))
	for _, req := range reqs {
		if req.GetUser() == sctx.GetUser() {
			continue
		}
		if !isCustomServerAccessRequest(req) {
			continue
		}
		items = append(items, makeAccessRequestInfo(req))
	}

	return listAccessRequestsResponse{Items: items}, nil
}

// resolveAccessRequest approves or denies a custom server-access request using
// the OSS-safe state update path (the same primitive used by tctl requests
// approve/deny). It deliberately does not use SubmitAccessReview.
//
// POST /webapi/sites/:site/accessrequests/resolve/:request_id
func (h *Handler) resolveAccessRequest(w http.ResponseWriter, r *http.Request, p httprouter.Params, sctx *SessionContext, cluster reversetunnelclient.Cluster) (any, error) {
	ctx := r.Context()

	requestID := p.ByName("request_id")
	if requestID == "" {
		return nil, trace.BadParameter("missing request id")
	}

	var req resolveAccessRequestReq
	if err := httplib.ReadResourceJSON(r, &req); err != nil {
		return nil, trace.Wrap(err)
	}

	state, err := parseResolveState(req.State)
	if err != nil {
		return nil, trace.Wrap(err)
	}

	clt, err := sctx.GetUserClient(ctx, cluster)
	if err != nil {
		return nil, trace.Wrap(err)
	}

	found, err := clt.GetAccessRequests(ctx, types.AccessRequestFilter{
		ID: requestID,
	})
	if err != nil {
		return nil, trace.Wrap(err)
	}
	if len(found) != 1 {
		return nil, trace.NotFound("access request %q not found", requestID)
	}
	if !isCustomServerAccessRequest(found[0]) {
		return nil, trace.BadParameter("access request %q is not a custom server-access request", requestID)
	}

	if err := clt.SetAccessRequestState(ctx, types.AccessRequestUpdate{
		RequestID: requestID,
		State:     state,
		Reason:    req.Reason,
	}); err != nil {
		return nil, trace.Wrap(err)
	}

	updated, err := clt.GetAccessRequests(ctx, types.AccessRequestFilter{
		ID: requestID,
	})
	if err != nil {
		return nil, trace.Wrap(err)
	}
	if len(updated) != 1 {
		return nil, trace.NotFound("access request %q not found after update", requestID)
	}

	return makeAccessRequestInfo(updated[0]), nil
}

// getAccessRequestCapabilities returns the roles the current user is allowed to
// request, so the UI can populate its picker.
//
// GET /webapi/sites/:site/accessrequests/capabilities
func (h *Handler) getAccessRequestCapabilities(w http.ResponseWriter, r *http.Request, p httprouter.Params, sctx *SessionContext, cluster reversetunnelclient.Cluster) (any, error) {
	ctx := r.Context()

	clt, err := sctx.GetUserClient(ctx, cluster)
	if err != nil {
		return nil, trace.Wrap(err)
	}

	caps, err := clt.GetAccessCapabilities(ctx, types.AccessCapabilitiesRequest{
		RequestableRoles:   true,
		SuggestedReviewers: true,
	})
	if err != nil {
		return nil, trace.Wrap(err)
	}

	return accessRequestCapabilitiesResponse{
		RequestableRoles:   filterCustomServerAccessRoles(caps.RequestableRoles),
		SuggestedReviewers: caps.SuggestedReviewers,
		RequireReason:      caps.RequireReason,
	}, nil
}
