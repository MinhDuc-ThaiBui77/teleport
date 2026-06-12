/**
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

// Custom (fork) service for OSS role-based access requests. It talks to the
// handlers added in lib/web/accessrequests_custom.go.

import cfg from 'teleport/config';
import api from 'teleport/services/api';
import websession from 'teleport/services/websession';

export type CustomAccessRequest = {
  id: string;
  user: string;
  roles: string[];
  /** Server-side state, e.g. PENDING / APPROVED / DENIED. */
  state: string;
  /** The requester's own justification. */
  reason?: string;
  /** The note an approver left when approving/denying. */
  resolveReason?: string;
  created: string;
  expires: string;
  maxDuration: string;
  /** True when an in-force lock targets this request (approved-grants view). */
  revoked?: boolean;
};

export type CustomAccessRequestCapabilities = {
  /** Roles the current user is allowed to request (one per server). */
  requestableRoles: string[];
  suggestedReviewers: string[];
  requireReason: boolean;
};

export type CreateCustomAccessRequestParams = {
  roles: string[];
  reason?: string;
  /** Optional cap on how long the granted access lasts, in milliseconds. */
  maxDurationMs?: number;
  suggestedReviewers?: string[];
  dryRun?: boolean;
};

export type ResolveCustomAccessRequestParams = {
  state: 'APPROVED' | 'DENIED';
  reason?: string;
};

function makeAccessRequest(json: any): CustomAccessRequest {
  json = json || {};
  return {
    id: json.id,
    user: json.user,
    roles: json.roles ?? [],
    state: json.state,
    reason: json.reason,
    resolveReason: json.resolveReason,
    created: json.created,
    expires: json.expires,
    maxDuration: json.maxDuration,
    revoked: json.revoked,
  };
}

export function fetchCustomAccessRequestCapabilities(
  clusterId: string,
  signal?: AbortSignal
): Promise<CustomAccessRequestCapabilities> {
  return api
    .get(cfg.getAccessRequestsCustomCapabilitiesUrl(clusterId), signal)
    .then(json => ({
      requestableRoles: json?.requestableRoles ?? [],
      suggestedReviewers: json?.suggestedReviewers ?? [],
      requireReason: !!json?.requireReason,
    }));
}

export function fetchMyCustomAccessRequests(
  clusterId: string,
  signal?: AbortSignal
): Promise<CustomAccessRequest[]> {
  return api
    .get(cfg.getAccessRequestsCustomUrl(clusterId), signal)
    .then(json => (json?.items ?? []).map(makeAccessRequest));
}

export function fetchPendingCustomAccessRequests(
  clusterId: string,
  signal?: AbortSignal
): Promise<CustomAccessRequest[]> {
  return api
    .get(cfg.getAccessRequestsCustomPendingUrl(clusterId), signal)
    .then(json => (json?.items ?? []).map(makeAccessRequest));
}

export function createCustomAccessRequest(
  clusterId: string,
  params: CreateCustomAccessRequestParams
): Promise<CustomAccessRequest> {
  return api
    .post(cfg.getAccessRequestsCustomUrl(clusterId), params)
    .then(makeAccessRequest);
}

export function resolveCustomAccessRequest(
  clusterId: string,
  requestId: string,
  params: ResolveCustomAccessRequestParams
): Promise<CustomAccessRequest> {
  return api
    .post(cfg.getAccessRequestsCustomResolveUrl(clusterId, requestId), params)
    .then(makeAccessRequest);
}

export function assumeCustomAccessRequest(requestId: string): Promise<Date> {
  return websession.renewSession({ requestId });
}

export function fetchApprovedCustomAccessRequests(
  clusterId: string,
  signal?: AbortSignal
): Promise<CustomAccessRequest[]> {
  return api
    .get(cfg.getAccessRequestsCustomApprovedUrl(clusterId), signal)
    .then(json => (json?.items ?? []).map(makeAccessRequest));
}

// revokeCustomAccessRequest revokes an approved grant by locking the request
// itself (server side), dropping only the access that request granted.
export function revokeCustomAccessRequest(
  clusterId: string,
  requestId: string
): Promise<CustomAccessRequest> {
  return api
    .post(cfg.getAccessRequestsCustomRevokeUrl(clusterId, requestId), {})
    .then(makeAccessRequest);
}

// restoreCustomAccessRequest removes the revoke lock, restoring the grant.
export function restoreCustomAccessRequest(
  clusterId: string,
  requestId: string
): Promise<void> {
  return api
    .post(cfg.getAccessRequestsCustomRestoreUrl(clusterId, requestId), {})
    .then(() => undefined);
}
