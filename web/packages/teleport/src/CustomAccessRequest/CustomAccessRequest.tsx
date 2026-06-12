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

// Custom (fork) page: lets OSS users request, approve, and assume
// time-limited server access by using role-based access requests.

import { useCallback, useEffect, useRef, useState } from 'react';
import styled from 'styled-components';

import {
  Alert,
  Box,
  ButtonPrimary,
  ButtonSecondary,
  ButtonSelect,
  Flex,
  Indicator,
  Input,
  Text,
  TextArea,
} from 'design';
import { Danger } from 'design/Alert';
import { CheckboxInput } from 'design/Checkbox';
import Table, { Cell } from 'design/DataTable';
import { SlideTabs } from 'design/SlideTabs';
import { makeEmptyAttempt, useAsync } from 'shared/hooks/useAsync';

import {
  FeatureBox,
  FeatureHeader,
  FeatureHeaderTitle,
} from 'teleport/components/Layout';
import cfg from 'teleport/config';
import {
  type CustomAccessRequest as AccessRequest,
  assumeCustomAccessRequest,
  createCustomAccessRequest,
  fetchApprovedCustomAccessRequests,
  fetchCustomAccessRequestCapabilities,
  fetchMyCustomAccessRequests,
  fetchPendingCustomAccessRequests,
  resolveCustomAccessRequest,
  restoreCustomAccessRequest,
  revokeCustomAccessRequest,
} from 'teleport/services/customAccessRequests';
import history from 'teleport/services/history';
import useStickyClusterId from 'teleport/useStickyClusterId';
import useTeleport from 'teleport/useTeleport';

const SERVER_ACCESS_ROLE_PREFIX = 'ssh-access-';
// Background refresh cadence so requesters/approvers see state changes without
// manually clicking Refresh. Kept conservative for an internal tool.
const POLL_INTERVAL_MS = 15000;
const MAX_CUSTOM_DURATION = 999;

type TabKey = 'request' | 'approvals';
type DurationPreset = 'default' | '30m' | '1h' | '4h' | '8h' | '24h' | 'custom';
type DurationUnit = 'minutes' | 'hours' | 'days';
type ResolveState = 'APPROVED' | 'DENIED';

const DURATION_OPTIONS: { value: DurationPreset; label: string; ms?: number }[] =
  [
    { value: 'default', label: 'Default' },
    { value: '30m', label: '30m', ms: 30 * 60 * 1000 },
    { value: '1h', label: '1h', ms: 60 * 60 * 1000 },
    { value: '4h', label: '4h', ms: 4 * 60 * 60 * 1000 },
    { value: '8h', label: '8h', ms: 8 * 60 * 60 * 1000 },
    { value: '24h', label: '24h', ms: 24 * 60 * 60 * 1000 },
    { value: 'custom', label: 'Custom' },
  ];

const UNIT_OPTIONS: { value: DurationUnit; label: string }[] = [
  { value: 'minutes', label: 'minutes' },
  { value: 'hours', label: 'hours' },
  { value: 'days', label: 'days' },
];

export function CustomAccessRequest() {
  const { clusterId } = useStickyClusterId();
  const ctx = useTeleport();
  const activeRequestId = ctx.storeUser.getAccessRequestId();
  const canResolveRequests = !!ctx.storeUser.getAccessRequestAccess()?.edit;

  const [capsAttempt, runFetchCaps] = useAsync(
    useCallback(
      () => fetchCustomAccessRequestCapabilities(clusterId),
      [clusterId]
    )
  );
  const [listAttempt, runFetchList] = useAsync(
    useCallback(() => fetchMyCustomAccessRequests(clusterId), [clusterId])
  );
  const [createAttempt, runCreate, setCreateAttempt] = useAsync(
    useCallback(
      (roles: string[], reason: string, maxDurationMs?: number) =>
        createCustomAccessRequest(clusterId, {
          roles,
          reason: reason.trim() || undefined,
          maxDurationMs,
        }),
      [clusterId]
    )
  );
  const [pendingAttempt, runFetchPending] = useAsync(
    useCallback(() => fetchPendingCustomAccessRequests(clusterId), [clusterId])
  );
  const [assumeAttempt, runAssume, setAssumeAttempt] = useAsync(
    useCallback((requestId: string) => assumeCustomAccessRequest(requestId), [])
  );
  const [resolveAttempt, runResolve, setResolveAttempt] = useAsync(
    useCallback(
      (requestId: string, state: ResolveState, reason: string) =>
        resolveCustomAccessRequest(clusterId, requestId, {
          state,
          reason: reason.trim() || undefined,
        }),
      [clusterId]
    )
  );
  const [approvedAttempt, runFetchApproved] = useAsync(
    useCallback(() => fetchApprovedCustomAccessRequests(clusterId), [clusterId])
  );
  const [revokeAttempt, runRevoke, setRevokeAttempt] = useAsync(
    useCallback(
      (requestId: string) => revokeCustomAccessRequest(clusterId, requestId),
      [clusterId]
    )
  );
  const [restoreAttempt, runRestore] = useAsync(
    useCallback(
      (requestId: string) => restoreCustomAccessRequest(clusterId, requestId),
      [clusterId]
    )
  );

  const [activeTab, setActiveTab] = useState<TabKey>('request');
  const [submitOk, setSubmitOk] = useState(false);
  const [selectedRoles, setSelectedRoles] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [durationPreset, setDurationPreset] = useState<DurationPreset>('default');
  const [customDurationValue, setCustomDurationValue] = useState('2');
  const [customDurationUnit, setCustomDurationUnit] =
    useState<DurationUnit>('hours');
  const [assumingRequestId, setAssumingRequestId] = useState('');
  const [resolvingRequestId, setResolvingRequestId] = useState('');
  const [resolvingState, setResolvingState] = useState<ResolveState | ''>('');
  const [confirmDenyId, setConfirmDenyId] = useState('');
  const [revokingRequestId, setRevokingRequestId] = useState('');
  const [confirmRevokeId, setConfirmRevokeId] = useState('');
  const [restoringRequestId, setRestoringRequestId] = useState('');
  // Per-row approver note so a reason typed for one request can never attach to
  // another.
  const [resolveReasonById, setResolveReasonById] = useState<
    Record<string, string>
  >({});

  // Initial load.
  useEffect(() => {
    runFetchCaps();
    runFetchList();
    if (canResolveRequests) {
      runFetchPending();
      runFetchApproved();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clusterId, canResolveRequests]);

  // Background refresh of the visible tab so state changes (approval, new
  // pending requests) appear without manual refresh.
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.hidden) {
        return;
      }
      if (activeTab === 'request') {
        runFetchList();
      } else if (activeTab === 'approvals' && canResolveRequests) {
        runFetchPending();
        runFetchApproved();
      }
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [
    activeTab,
    canResolveRequests,
    runFetchList,
    runFetchPending,
    runFetchApproved,
  ]);

  function switchTab(tab: TabKey) {
    setActiveTab(tab);
    setSubmitOk(false);
    setConfirmDenyId('');
    setConfirmRevokeId('');
    // Clear any stale action banners so they don't reappear on revisit.
    setCreateAttempt(makeEmptyAttempt());
    setAssumeAttempt(makeEmptyAttempt());
    setResolveAttempt(makeEmptyAttempt());
    setRevokeAttempt(makeEmptyAttempt());
  }

  function toggleRole(role: string) {
    setSubmitOk(false);
    setSelectedRoles(prev =>
      prev.includes(role) ? prev.filter(r => r !== role) : [...prev, role]
    );
  }

  async function onSubmit() {
    const [, err] = await runCreate(
      selectedRoles,
      reason,
      getDurationMs(durationPreset, customDurationValue, customDurationUnit)
    );
    if (!err) {
      setSubmitOk(true);
      setSelectedRoles([]);
      setReason('');
      setDurationPreset('default');
      setCustomDurationValue('2');
      setCustomDurationUnit('hours');
      runFetchList();
    }
  }

  async function onAssume(requestId: string) {
    setAssumingRequestId(requestId);
    const [, err] = await runAssume(requestId);
    if (err) {
      setAssumingRequestId('');
      return;
    }
    history.push(cfg.getUnifiedResourcesRoute(clusterId), true);
  }

  async function onResolve(requestId: string, state: ResolveState) {
    setConfirmDenyId('');
    setResolvingRequestId(requestId);
    setResolvingState(state);
    const [, err] = await runResolve(
      requestId,
      state,
      resolveReasonById[requestId] || ''
    );
    setResolvingRequestId('');
    setResolvingState('');
    if (!err) {
      setResolveReasonById(prev => {
        const next = { ...prev };
        delete next[requestId];
        return next;
      });
      runFetchPending();
      runFetchList();
      runFetchApproved();
    }
  }

  async function onRevoke(requestId: string) {
    setConfirmRevokeId('');
    setRevokingRequestId(requestId);
    const [, err] = await runRevoke(requestId);
    setRevokingRequestId('');
    if (!err) {
      runFetchApproved();
    }
  }

  async function onRestore(requestId: string) {
    setRestoringRequestId(requestId);
    const [, err] = await runRestore(requestId);
    setRestoringRequestId('');
    if (!err) {
      runFetchApproved();
    }
  }

  const requireReason = !!capsAttempt.data?.requireReason;
  const requestableRoles = capsAttempt.data?.requestableRoles ?? [];
  const durationValid = isDurationValid(durationPreset, customDurationValue);
  const canSubmit =
    selectedRoles.length > 0 &&
    (!requireReason || reason.trim().length > 0) &&
    durationValid &&
    createAttempt.status !== 'processing';

  // Keep the last successfully-loaded rows so a transient background-poll
  // failure doesn't blank the table or flash an unprompted error banner
  // (useAsync nulls `data` on error).
  const lastListRef = useRef<AccessRequest[] | undefined>(undefined);
  if (listAttempt.data) {
    lastListRef.current = listAttempt.data;
  }
  const listItems = listAttempt.data ?? lastListRef.current;

  const lastPendingRef = useRef<AccessRequest[] | undefined>(undefined);
  if (pendingAttempt.data) {
    lastPendingRef.current = pendingAttempt.data;
  }
  const pendingItems = pendingAttempt.data ?? lastPendingRef.current;

  const lastApprovedRef = useRef<AccessRequest[] | undefined>(undefined);
  if (approvedAttempt.data) {
    lastApprovedRef.current = approvedAttempt.data;
  }
  const approvedItems = approvedAttempt.data ?? lastApprovedRef.current;

  const tabs: { key: TabKey; title: string }[] = [
    { key: 'request', title: 'Request access' },
    ...(canResolveRequests
      ? [{ key: 'approvals' as const, title: 'Approvals' }]
      : []),
  ];
  const activeIndex = Math.max(
    0,
    tabs.findIndex(t => t.key === activeTab)
  );

  return (
    <ScrollableFeatureBox>
      <FeatureHeader>
        <FeatureHeaderTitle>Request server access</FeatureHeaderTitle>
      </FeatureHeader>

      <Box mb={3} maxWidth={420}>
        <SlideTabs
          size="medium"
          appearance="round"
          activeIndex={activeIndex}
          onChange={index => switchTab(tabs[index].key)}
          tabs={tabs}
        />
      </Box>

      {activeTab === 'request' && (
        <>
          {createAttempt.status === 'error' && (
            <Danger>{createAttempt.statusText}</Danger>
          )}
          {assumeAttempt.status === 'error' && (
            <Danger>{assumeAttempt.statusText}</Danger>
          )}
          {submitOk && createAttempt.status === 'success' && (
            <Alert kind="success">
              Request submitted. It will appear under My requests as Pending —
              this list refreshes automatically.
            </Alert>
          )}

          <Panel mb={4} p={3}>
            <Text bold mb={2}>
              Server
            </Text>

            {capsAttempt.status === 'processing' && (
              <Box textAlign="center" m={4}>
                <Indicator />
              </Box>
            )}
            {capsAttempt.status === 'error' && (
              <Danger>{capsAttempt.statusText}</Danger>
            )}
            {capsAttempt.status === 'success' &&
              requestableRoles.length === 0 && (
                <Text color="text.muted">
                  No requestable server roles are available for your user. Ask an
                  administrator to grant you an ssh-access-* requestable role.
                </Text>
              )}
            {capsAttempt.status === 'success' &&
              requestableRoles.map(role => (
                <Flex key={role} alignItems="center" gap={2} mb={2}>
                  <CheckboxInput
                    id={`role-${role}`}
                    checked={selectedRoles.includes(role)}
                    onChange={() => toggleRole(role)}
                  />
                  <Box>
                    <label
                      htmlFor={`role-${role}`}
                      style={{ cursor: 'pointer', fontWeight: 500 }}
                    >
                      {serverNameFromRole(role)}
                    </label>
                    <Subtle>{role}</Subtle>
                  </Box>
                </Flex>
              ))}

            <Text bold mt={3} mb={1}>
              Reason {requireReason ? '(required)' : '(optional)'}
            </Text>
            <TextArea
              placeholder="Example: deploy hotfix for incident #123"
              value={reason}
              onChange={e => {
                setSubmitOk(false);
                setReason(e.target.value);
              }}
              size="large"
            />

            <Text bold mt={3} mb={1}>
              Access duration
            </Text>
            <ButtonSelect
              options={DURATION_OPTIONS.map(o => ({
                value: o.value,
                label: o.label,
              }))}
              activeValue={durationPreset}
              onChange={value => {
                setSubmitOk(false);
                setDurationPreset(value);
              }}
            />

            {durationPreset === 'custom' && (
              <>
                <Flex gap={2} alignItems="center" mt={2}>
                  <Input
                    type="number"
                    min={1}
                    max={MAX_CUSTOM_DURATION}
                    width="120px"
                    value={customDurationValue}
                    onChange={e => setCustomDurationValue(e.target.value)}
                  />
                  <ButtonSelect
                    options={UNIT_OPTIONS}
                    activeValue={customDurationUnit}
                    onChange={setCustomDurationUnit}
                  />
                </Flex>
                {!durationValid && (
                  <Text color="error.main" fontSize={1} mt={1}>
                    Enter a number between 1 and {MAX_CUSTOM_DURATION}.
                  </Text>
                )}
              </>
            )}

            <Box mt={4}>
              <ButtonPrimary disabled={!canSubmit} onClick={onSubmit}>
                {createAttempt.status === 'processing'
                  ? 'Submitting...'
                  : 'Submit request'}
              </ButtonPrimary>
            </Box>
          </Panel>

          <Flex alignItems="center" justifyContent="space-between" mb={2}>
            <Text bold fontSize={3}>
              My requests
            </Text>
            <ButtonSecondary
              size="small"
              onClick={() => runFetchList()}
              disabled={listAttempt.status === 'processing'}
            >
              Refresh
            </ButtonSecondary>
          </Flex>

          {listAttempt.status === 'error' && !listItems && (
            <Danger>{listAttempt.statusText}</Danger>
          )}
          {listItems ? (
            <RequestsTable
              items={listItems}
              activeRequestId={activeRequestId}
              assumingRequestId={assumingRequestId}
              isAssuming={assumeAttempt.status === 'processing'}
              onAssume={onAssume}
            />
          ) : (
            listAttempt.status === 'processing' && (
              <Box textAlign="center" m={4}>
                <Indicator />
              </Box>
            )
          )}
        </>
      )}

      {activeTab === 'approvals' && canResolveRequests && (
        <>
          {resolveAttempt.status === 'error' && (
            <Danger>{resolveAttempt.statusText}</Danger>
          )}

          <Flex alignItems="center" justifyContent="space-between" mb={2}>
            <Text bold fontSize={3}>
              Pending approvals
            </Text>
            <ButtonSecondary
              size="small"
              onClick={() => runFetchPending()}
              disabled={pendingAttempt.status === 'processing'}
            >
              Refresh
            </ButtonSecondary>
          </Flex>

          {pendingAttempt.status === 'error' && !pendingItems && (
            <Danger>{pendingAttempt.statusText}</Danger>
          )}
          {pendingItems ? (
            <PendingApprovalsTable
              items={pendingItems}
              resolvingRequestId={resolvingRequestId}
              resolvingState={resolvingState}
              isResolving={resolveAttempt.status === 'processing'}
              confirmDenyId={confirmDenyId}
              reasonById={resolveReasonById}
              onReasonChange={(id, value) =>
                setResolveReasonById(prev => ({ ...prev, [id]: value }))
              }
              onApprove={id => onResolve(id, 'APPROVED')}
              onRequestDeny={id => setConfirmDenyId(id)}
              onCancelDeny={() => setConfirmDenyId('')}
              onConfirmDeny={id => onResolve(id, 'DENIED')}
            />
          ) : (
            pendingAttempt.status === 'processing' && (
              <Box textAlign="center" m={4}>
                <Indicator />
              </Box>
            )
          )}

          {revokeAttempt.status === 'error' && (
            <Danger>{revokeAttempt.statusText}</Danger>
          )}
          {restoreAttempt.status === 'error' && (
            <Danger>{restoreAttempt.statusText}</Danger>
          )}

          <Flex
            alignItems="center"
            justifyContent="space-between"
            mb={2}
            mt={4}
          >
            <Text bold fontSize={3}>
              Active grants
            </Text>
            <ButtonSecondary
              size="small"
              onClick={() => runFetchApproved()}
              disabled={approvedAttempt.status === 'processing'}
            >
              Refresh
            </ButtonSecondary>
          </Flex>

          <Text color="warning.main" fontSize={1} mb={2}>
            Note: this ENDS the user's entire current elevated session (all their
            JIT-granted access, not just this one server) — Teleport cannot revoke
            a single server from a live session. The user is sent back to login
            and keeps their base access; they re-request what they still need.
          </Text>

          {approvedAttempt.status === 'error' && !approvedItems && (
            <Danger>{approvedAttempt.statusText}</Danger>
          )}
          {approvedItems ? (
            <ActiveGrantsTable
              items={approvedItems}
              revokingRequestId={revokingRequestId}
              isRevoking={revokeAttempt.status === 'processing'}
              confirmRevokeId={confirmRevokeId}
              restoringRequestId={restoringRequestId}
              isRestoring={restoreAttempt.status === 'processing'}
              onRequestRevoke={id => setConfirmRevokeId(id)}
              onCancelRevoke={() => setConfirmRevokeId('')}
              onConfirmRevoke={onRevoke}
              onRestore={onRestore}
            />
          ) : (
            approvedAttempt.status === 'processing' && (
              <Box textAlign="center" m={4}>
                <Indicator />
              </Box>
            )
          )}
        </>
      )}
    </ScrollableFeatureBox>
  );
}

// NOTE: DataTable's match() drops every row when searchableProps is empty,
// which is the case when all columns use altKey (custom renders). We pass
// searchableProps with always-present fields so all rows stay visible — there
// is no search box, this only keeps the filter from hiding everything.
function RequestsTable({
  items,
  activeRequestId,
  assumingRequestId,
  isAssuming,
  onAssume,
}: {
  items: AccessRequest[];
  activeRequestId?: string;
  assumingRequestId: string;
  isAssuming: boolean;
  onAssume(requestId: string): void;
}) {
  return (
    <Table<AccessRequest>
      data={items}
      emptyText="No requests yet. Select a server above and submit a request."
      searchableProps={['state', 'user']}
      row={{ getKey: r => r.id }}
      pagination={{ pageSize: 10 }}
      columns={[
        {
          altKey: 'server',
          headerText: 'Server',
          render: req => (
            <Cell>
              <Text>{serverNamesFromRoles(req.roles)}</Text>
              <Subtle>{(req.roles || []).join(', ')}</Subtle>
            </Cell>
          ),
        },
        {
          altKey: 'state',
          headerText: 'State',
          render: req => {
            const inUse = req.id === activeRequestId;
            return (
              <Cell>
                <StateLabel $state={req.state}>
                  {inUse ? 'IN USE' : req.state}
                </StateLabel>
                {req.resolveReason && (
                  <Subtle>
                    {req.state === 'DENIED' ? 'Denied' : 'Note'}:{' '}
                    {req.resolveReason}
                  </Subtle>
                )}
              </Cell>
            );
          },
        },
        {
          altKey: 'reason',
          headerText: 'Reason',
          render: req => (
            <Cell>
              <Wrap>{req.reason || '-'}</Wrap>
            </Cell>
          ),
        },
        {
          altKey: 'created',
          headerText: 'Created',
          render: req => <Cell>{fmtDate(req.created)}</Cell>,
        },
        {
          altKey: 'expires',
          headerText: 'Expires',
          render: req => <Cell>{fmtExpires(req.expires)}</Cell>,
        },
        {
          altKey: 'action',
          headerText: 'Action',
          render: req => {
            const inUse = req.id === activeRequestId;
            const canAssume = req.state === 'APPROVED' && !inUse;
            return (
              <Cell>
                {canAssume && (
                  <ButtonPrimary
                    size="small"
                    disabled={isAssuming}
                    onClick={() => onAssume(req.id)}
                  >
                    {isAssuming && assumingRequestId === req.id
                      ? 'Using...'
                      : 'Use access'}
                  </ButtonPrimary>
                )}
              </Cell>
            );
          },
        },
      ]}
    />
  );
}

function PendingApprovalsTable({
  items,
  resolvingRequestId,
  resolvingState,
  isResolving,
  confirmDenyId,
  reasonById,
  onReasonChange,
  onApprove,
  onRequestDeny,
  onCancelDeny,
  onConfirmDeny,
}: {
  items: AccessRequest[];
  resolvingRequestId: string;
  resolvingState: ResolveState | '';
  isResolving: boolean;
  confirmDenyId: string;
  reasonById: Record<string, string>;
  onReasonChange(id: string, value: string): void;
  onApprove(id: string): void;
  onRequestDeny(id: string): void;
  onCancelDeny(): void;
  onConfirmDeny(id: string): void;
}) {
  return (
    <Table<AccessRequest>
      data={items}
      emptyText="No pending approvals. Requests awaiting your review appear here."
      searchableProps={['state', 'user']}
      row={{ getKey: r => r.id }}
      pagination={{ pageSize: 10 }}
      columns={[
        {
          altKey: 'server',
          headerText: 'Server',
          render: req => (
            <Cell>
              <Text>{serverNamesFromRoles(req.roles)}</Text>
              <Subtle>{(req.roles || []).join(', ')}</Subtle>
            </Cell>
          ),
        },
        {
          altKey: 'requester',
          headerText: 'Requester',
          render: req => <Cell>{req.user}</Cell>,
        },
        {
          altKey: 'reason',
          headerText: 'Reason',
          render: req => (
            <Cell>
              <Wrap>{req.reason || '-'}</Wrap>
            </Cell>
          ),
        },
        {
          altKey: 'expires',
          headerText: 'Expires',
          render: req => <Cell>{fmtExpires(req.expires)}</Cell>,
        },
        {
          altKey: 'decision',
          headerText: 'Decision',
          render: req => {
            const busyThisRow = isResolving && resolvingRequestId === req.id;
            const confirming = confirmDenyId === req.id;
            return (
              <Cell>
                <Flex flexDirection="column" gap={2} minWidth="260px">
                  <TextArea
                    placeholder="Decision note (optional)"
                    value={reasonById[req.id] || ''}
                    onChange={e => onReasonChange(req.id, e.target.value)}
                    size="small"
                  />
                  {confirming ? (
                    <Flex gap={2} alignItems="center">
                      <Text fontSize={1}>Deny this request?</Text>
                      <ButtonSecondary
                        size="small"
                        disabled={isResolving}
                        onClick={() => onConfirmDeny(req.id)}
                      >
                        {busyThisRow && resolvingState === 'DENIED'
                          ? 'Denying...'
                          : 'Confirm deny'}
                      </ButtonSecondary>
                      <ButtonSecondary size="small" onClick={onCancelDeny}>
                        Cancel
                      </ButtonSecondary>
                    </Flex>
                  ) : (
                    <Flex gap={2}>
                      <ButtonPrimary
                        size="small"
                        disabled={isResolving}
                        onClick={() => onApprove(req.id)}
                      >
                        {busyThisRow && resolvingState === 'APPROVED'
                          ? 'Approving...'
                          : 'Approve'}
                      </ButtonPrimary>
                      <ButtonSecondary
                        size="small"
                        disabled={isResolving}
                        onClick={() => onRequestDeny(req.id)}
                      >
                        Deny
                      </ButtonSecondary>
                    </Flex>
                  )}
                </Flex>
              </Cell>
            );
          },
        },
      ]}
    />
  );
}

function ActiveGrantsTable({
  items,
  revokingRequestId,
  isRevoking,
  confirmRevokeId,
  restoringRequestId,
  isRestoring,
  onRequestRevoke,
  onCancelRevoke,
  onConfirmRevoke,
  onRestore,
}: {
  items: AccessRequest[];
  revokingRequestId: string;
  isRevoking: boolean;
  confirmRevokeId: string;
  restoringRequestId: string;
  isRestoring: boolean;
  onRequestRevoke(id: string): void;
  onCancelRevoke(): void;
  onConfirmRevoke(id: string): void;
  onRestore(id: string): void;
}) {
  return (
    <Table<AccessRequest>
      data={items}
      emptyText="No active grants. Approved requests appear here while in use."
      searchableProps={['state', 'user']}
      row={{ getKey: r => r.id }}
      pagination={{ pageSize: 10 }}
      columns={[
        {
          altKey: 'server',
          headerText: 'Server',
          render: req => (
            <Cell>
              <Text>{serverNamesFromRoles(req.roles)}</Text>
              <Subtle>{(req.roles || []).join(', ')}</Subtle>
            </Cell>
          ),
        },
        {
          altKey: 'requester',
          headerText: 'Requester',
          render: req => <Cell>{req.user}</Cell>,
        },
        {
          altKey: 'expires',
          headerText: 'Granted until',
          render: req => <Cell>{fmtExpires(req.expires)}</Cell>,
        },
        {
          altKey: 'status',
          headerText: 'Status',
          render: req => (
            <Cell>
              {req.revoked ? (
                <Subtle>Revoked</Subtle>
              ) : (
                <StateLabel $state="APPROVED">Active</StateLabel>
              )}
            </Cell>
          ),
        },
        {
          altKey: 'action',
          headerText: 'Action',
          render: req => {
            if (req.revoked) {
              const restoring = isRestoring && restoringRequestId === req.id;
              return (
                <Cell>
                  <ButtonSecondary
                    size="small"
                    disabled={isRestoring}
                    onClick={() => onRestore(req.id)}
                  >
                    {restoring ? 'Restoring...' : 'Restore'}
                  </ButtonSecondary>
                </Cell>
              );
            }
            const confirming = confirmRevokeId === req.id;
            const busy = isRevoking && revokingRequestId === req.id;
            return (
              <Cell>
                {confirming ? (
                  <Flex gap={2} alignItems="center">
                    <Text fontSize={1}>End this user's session?</Text>
                    <ButtonSecondary
                      size="small"
                      disabled={isRevoking}
                      onClick={() => onConfirmRevoke(req.id)}
                    >
                      {busy ? 'Ending...' : 'Confirm'}
                    </ButtonSecondary>
                    <ButtonSecondary size="small" onClick={onCancelRevoke}>
                      Cancel
                    </ButtonSecondary>
                  </Flex>
                ) : (
                  <ButtonSecondary
                    size="small"
                    disabled={isRevoking}
                    onClick={() => onRequestRevoke(req.id)}
                  >
                    End session
                  </ButtonSecondary>
                )}
              </Cell>
            );
          },
        },
      ]}
    />
  );
}

function serverNamesFromRoles(roles?: string[]): string {
  const names = (roles || []).map(serverNameFromRole);
  return names.length ? names.join(', ') : '-';
}

function serverNameFromRole(role: string): string {
  if (!role.startsWith(SERVER_ACCESS_ROLE_PREFIX)) {
    return role;
  }

  const serverId = role.slice(SERVER_ACCESS_ROLE_PREFIX.length);
  // Only reconstruct an IP when every group is a valid 0-255 octet, so a
  // dash-named server isn't mislabelled as an address.
  const ipLike =
    /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)-){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
  if (ipLike.test(serverId)) {
    return serverId.replace(/-/g, '.');
  }
  return serverId;
}

function fmtDate(iso?: string): string {
  const d = parseDate(iso);
  return d ? d.toLocaleString() : '-';
}

function fmtExpires(iso?: string): string {
  const d = parseDate(iso);
  if (!d) {
    return '-';
  }
  const diffMs = d.getTime() - Date.now();
  const rel = diffMs <= 0 ? 'expired' : `in ${fmtRelative(diffMs)}`;
  return `${d.toLocaleString()} (${rel})`;
}

function parseDate(iso?: string): Date | undefined {
  if (!iso) {
    return undefined;
  }
  const d = new Date(iso);
  if (isNaN(d.getTime()) || d.getFullYear() < 2000) {
    return undefined;
  }
  return d;
}

function fmtRelative(ms: number): string {
  // Floor so a "time remaining" hint never overstates how long is left.
  const mins = Math.floor(ms / 60000);
  if (mins < 1) {
    return '<1m';
  }
  if (mins < 60) {
    return `${mins}m`;
  }
  const hours = Math.floor(mins / 60);
  if (hours < 48) {
    return `${hours}h`;
  }
  return `${Math.floor(hours / 24)}d`;
}

function isDurationValid(preset: DurationPreset, customValue: string): boolean {
  if (preset !== 'custom') {
    return true;
  }
  const n = Number(customValue);
  return Number.isFinite(n) && n > 0 && n <= MAX_CUSTOM_DURATION;
}

function getDurationMs(
  preset: DurationPreset,
  customValue: string,
  customUnit: DurationUnit
): number | undefined {
  if (preset === 'default') {
    return undefined;
  }

  if (preset !== 'custom') {
    return DURATION_OPTIONS.find(opt => opt.value === preset)?.ms;
  }

  const value = Number(customValue);
  if (!Number.isFinite(value) || value <= 0) {
    return undefined;
  }

  switch (customUnit) {
    case 'minutes':
      return value * 60 * 1000;
    case 'hours':
      return value * 60 * 60 * 1000;
    case 'days':
      return value * 24 * 60 * 60 * 1000;
  }
}

const ScrollableFeatureBox = styled(FeatureBox)`
  box-sizing: border-box;
  height: calc(100vh - ${p => p.theme.topBarHeight[0]}px);
  max-height: calc(100vh - ${p => p.theme.topBarHeight[0]}px);
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;

  @media screen and (min-width: ${p => p.theme.breakpoints.small}) {
    height: calc(100vh - ${p => p.theme.topBarHeight[1]}px);
    max-height: calc(100vh - ${p => p.theme.topBarHeight[1]}px);
  }
`;

const Panel = styled(Box)`
  border: 1px solid ${p => p.theme.colors.spotBackground[1]};
  border-radius: ${p => p.theme.radii[3]}px;
  max-width: 720px;
`;

const StateLabel = styled(Text)<{ $state: string }>`
  font-weight: 600;
  color: ${p =>
    p.$state === 'APPROVED'
      ? p.theme.colors.success.main
      : p.$state === 'DENIED'
        ? p.theme.colors.error.main
        : p.$state === 'PENDING'
          ? p.theme.colors.warning.main
          : 'inherit'};
`;

const Subtle = styled(Text)`
  color: ${p => p.theme.colors.text.muted};
  font-size: ${p => p.theme.fontSizes[1]}px;
  overflow-wrap: anywhere;
`;

const Wrap = styled(Text)`
  overflow-wrap: anywhere;
`;
