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

import { type ChangeEvent, useCallback, useEffect, useState } from 'react';
import styled from 'styled-components';

import {
  Alert,
  Box,
  ButtonPrimary,
  ButtonSecondary,
  Flex,
  Indicator,
  Text,
  TextArea,
} from 'design';
import { Danger } from 'design/Alert';
import { useAsync } from 'shared/hooks/useAsync';

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
  fetchCustomAccessRequestCapabilities,
  fetchMyCustomAccessRequests,
  fetchPendingCustomAccessRequests,
  resolveCustomAccessRequest,
} from 'teleport/services/customAccessRequests';
import history from 'teleport/services/history';
import useTeleport from 'teleport/useTeleport';
import useStickyClusterId from 'teleport/useStickyClusterId';

const SERVER_ACCESS_ROLE_PREFIX = 'ssh-access-';

type DurationPreset = 'default' | '30m' | '1h' | '4h' | '8h' | '24h' | 'custom';
type DurationUnit = 'minutes' | 'hours' | 'days';

const DURATION_OPTIONS: { value: DurationPreset; label: string; ms?: number }[] = [
  { value: 'default', label: 'Default' },
  { value: '30m', label: '30m', ms: 30 * 60 * 1000 },
  { value: '1h', label: '1h', ms: 60 * 60 * 1000 },
  { value: '4h', label: '4h', ms: 4 * 60 * 60 * 1000 },
  { value: '8h', label: '8h', ms: 8 * 60 * 60 * 1000 },
  { value: '24h', label: '24h', ms: 24 * 60 * 60 * 1000 },
  { value: 'custom', label: 'Custom' },
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
  const [createAttempt, runCreate] = useAsync(
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
  const [assumeAttempt, runAssume] = useAsync(
    useCallback((requestId: string) => assumeCustomAccessRequest(requestId), [])
  );
  const [resolveAttempt, runResolve] = useAsync(
    useCallback(
      (requestId: string, state: 'APPROVED' | 'DENIED', reason: string) =>
        resolveCustomAccessRequest(clusterId, requestId, {
          state,
          reason: reason.trim() || undefined,
        }),
      [clusterId]
    )
  );

  const [activeTab, setActiveTab] = useState<'request' | 'approvals'>(
    'request'
  );
  const [selectedRoles, setSelectedRoles] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [resolveReason, setResolveReason] = useState('');
  const [durationPreset, setDurationPreset] =
    useState<DurationPreset>('default');
  const [customDurationValue, setCustomDurationValue] = useState('2');
  const [customDurationUnit, setCustomDurationUnit] =
    useState<DurationUnit>('hours');
  const [assumingRequestId, setAssumingRequestId] = useState('');
  const [resolvingRequestId, setResolvingRequestId] = useState('');

  useEffect(() => {
    runFetchCaps();
    runFetchList();
    if (canResolveRequests) {
      runFetchPending();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clusterId, canResolveRequests]);

  function toggleRole(role: string) {
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

  async function onResolve(
    requestId: string,
    state: 'APPROVED' | 'DENIED'
  ) {
    setResolvingRequestId(requestId);
    const [, err] = await runResolve(requestId, state, resolveReason);
    setResolvingRequestId('');

    if (!err) {
      setResolveReason('');
      runFetchPending();
      runFetchList();
    }
  }

  const requireReason = !!capsAttempt.data?.requireReason;
  const requestableRoles = capsAttempt.data?.requestableRoles ?? [];
  const canSubmit =
    selectedRoles.length > 0 &&
    (!requireReason || reason.trim().length > 0) &&
    isDurationValid(durationPreset, customDurationValue) &&
    createAttempt.status !== 'processing';

  return (
    <ScrollableFeatureBox>
      <FeatureHeader>
        <FeatureHeaderTitle>Request Server Access</FeatureHeaderTitle>
      </FeatureHeader>

      <TabBar mb={3}>
        <TabButton
          $active={activeTab === 'request'}
          onClick={() => setActiveTab('request')}
        >
          Request access
        </TabButton>
        {canResolveRequests && (
          <TabButton
            $active={activeTab === 'approvals'}
            onClick={() => setActiveTab('approvals')}
          >
            Approvals
          </TabButton>
        )}
      </TabBar>

      {activeTab === 'request' && (
        <>
          {createAttempt.status === 'error' && (
            <Danger>{createAttempt.statusText}</Danger>
          )}
          {assumeAttempt.status === 'error' && (
            <Danger>{assumeAttempt.statusText}</Danger>
          )}
          {createAttempt.status === 'success' && (
            <Alert kind="success">
              Request submitted. Wait for an approver, then refresh this table.
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
                  No requestable server roles are available for your user.
                </Text>
              )}
            {capsAttempt.status === 'success' &&
              requestableRoles.map(role => (
                <Flex key={role} alignItems="center" gap={2} mb={2}>
                  <input
                    type="checkbox"
                    id={`role-${role}`}
                    checked={selectedRoles.includes(role)}
                    onChange={() => toggleRole(role)}
                  />
                  <label htmlFor={`role-${role}`}>
                    <Text>{serverNameFromRole(role)}</Text>
                    <Text color="text.muted" fontSize={1}>
                      {role}
                    </Text>
                  </label>
                </Flex>
              ))}

            <Text bold mt={3} mb={1}>
              Reason {requireReason ? '(required)' : '(optional)'}
            </Text>
            <TextArea
              placeholder="Example: deploy hotfix for incident #123"
              value={reason}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setReason(e.target.value)
              }
              size="large"
            />

            <Text bold mt={3} mb={1}>
              Access duration
            </Text>
            <DurationPicker>
              {DURATION_OPTIONS.map(opt => (
                <DurationButton
                  key={opt.value}
                  type="button"
                  $active={durationPreset === opt.value}
                  onClick={() => setDurationPreset(opt.value)}
                >
                  {opt.label}
                </DurationButton>
              ))}
            </DurationPicker>

            {durationPreset === 'custom' && (
              <CustomDurationRow mt={2}>
                <CustomDurationInput
                  min={1}
                  type="number"
                  value={customDurationValue}
                  onChange={(e: ChangeEvent<HTMLInputElement>) =>
                    setCustomDurationValue(e.target.value)
                  }
                />
                <CustomDurationSelect
                  value={customDurationUnit}
                  onChange={(e: ChangeEvent<HTMLSelectElement>) =>
                    setCustomDurationUnit(e.target.value as DurationUnit)
                  }
                >
                  <option value="minutes">minutes</option>
                  <option value="hours">hours</option>
                  <option value="days">days</option>
                </CustomDurationSelect>
              </CustomDurationRow>
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
            <ButtonPrimary
              size="small"
              onClick={() => runFetchList()}
              disabled={listAttempt.status === 'processing'}
            >
              Refresh
            </ButtonPrimary>
          </Flex>

          {listAttempt.status === 'processing' && (
            <Box textAlign="center" m={4}>
              <Indicator />
            </Box>
          )}
          {listAttempt.status === 'error' && (
            <Danger>{listAttempt.statusText}</Danger>
          )}
          {listAttempt.status === 'success' && (
            <RequestsTable
              items={listAttempt.data}
              activeRequestId={activeRequestId}
              assumingRequestId={assumingRequestId}
              isAssuming={assumeAttempt.status === 'processing'}
              onAssume={onAssume}
            />
          )}
        </>
      )}

      {activeTab === 'approvals' && canResolveRequests && (
        <>
          {resolveAttempt.status === 'error' && (
            <Danger>{resolveAttempt.statusText}</Danger>
          )}

          <Panel mb={3} p={3}>
            <Text bold mb={1}>
              Resolve reason
            </Text>
            <TextArea
              placeholder="Optional reason for approve or deny"
              value={resolveReason}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setResolveReason(e.target.value)
              }
              size="small"
            />
          </Panel>

          <Flex alignItems="center" justifyContent="space-between" mb={2}>
            <Text bold fontSize={3}>
              Pending approvals
            </Text>
            <ButtonPrimary
              size="small"
              onClick={() => runFetchPending()}
              disabled={pendingAttempt.status === 'processing'}
            >
              Refresh
            </ButtonPrimary>
          </Flex>

          {pendingAttempt.status === 'processing' && (
            <Box textAlign="center" m={4}>
              <Indicator />
            </Box>
          )}
          {pendingAttempt.status === 'error' && (
            <Danger>{pendingAttempt.statusText}</Danger>
          )}
          {pendingAttempt.status === 'success' && (
            <PendingApprovalsTable
              items={pendingAttempt.data}
              resolvingRequestId={resolvingRequestId}
              isResolving={resolveAttempt.status === 'processing'}
              onResolve={onResolve}
            />
          )}
        </>
      )}
    </ScrollableFeatureBox>
  );
}

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
  if (!items || items.length === 0) {
    return <Text color="text.muted">No requests yet.</Text>;
  }

  return (
    <TableWrap>
      <HeaderRow px={3} py={2}>
        <Box flex="2">Server</Box>
        <Box flex="1">State</Box>
        <Box flex="2">Created</Box>
        <Box flex="2">Expires</Box>
        <Box flex="1">Action</Box>
      </HeaderRow>
      {items.map(req => {
        const inUse = req.id === activeRequestId;
        const canAssume = req.state === 'APPROVED' && !inUse;

        return (
          <DataRow key={req.id} px={3} py={2} alignItems="center">
            <Box flex="2">
              <Text>{serverNamesFromRoles(req.roles)}</Text>
              <Text color="text.muted" fontSize={1}>
                {(req.roles || []).join(', ')}
              </Text>
            </Box>
            <Box flex="1">
              <span style={{ color: stateColor(req.state), fontWeight: 600 }}>
                {inUse ? 'IN USE' : req.state}
              </span>
            </Box>
            <Box flex="2">{fmtDate(req.created)}</Box>
            <Box flex="2">{fmtDate(req.expires)}</Box>
            <Box flex="1">
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
            </Box>
          </DataRow>
        );
      })}
    </TableWrap>
  );
}

function PendingApprovalsTable({
  items,
  resolvingRequestId,
  isResolving,
  onResolve,
}: {
  items: AccessRequest[];
  resolvingRequestId: string;
  isResolving: boolean;
  onResolve(requestId: string, state: 'APPROVED' | 'DENIED'): void;
}) {
  if (!items || items.length === 0) {
    return <Text color="text.muted">No pending approvals.</Text>;
  }

  return (
    <TableWrap>
      <HeaderRow px={3} py={2}>
        <Box flex="2">Server</Box>
        <Box flex="1">Requester</Box>
        <Box flex="2">Reason</Box>
        <Box flex="2">Created</Box>
        <Box flex="2">Actions</Box>
      </HeaderRow>
      {items.map(req => (
        <DataRow key={req.id} px={3} py={2} alignItems="center">
          <Box flex="2">
            <Text>{serverNamesFromRoles(req.roles)}</Text>
            <Text color="text.muted" fontSize={1}>
              {(req.roles || []).join(', ')}
            </Text>
          </Box>
          <Box flex="1">{req.user}</Box>
          <Box flex="2">{req.reason || '-'}</Box>
          <Box flex="2">{fmtDate(req.created)}</Box>
          <Flex flex="2" gap={2}>
            <ButtonPrimary
              size="small"
              disabled={isResolving}
              onClick={() => onResolve(req.id, 'APPROVED')}
            >
              {isResolving && resolvingRequestId === req.id
                ? 'Working...'
                : 'Approve'}
            </ButtonPrimary>
            <ButtonSecondary
              size="small"
              disabled={isResolving}
              onClick={() => onResolve(req.id, 'DENIED')}
            >
              Deny
            </ButtonSecondary>
          </Flex>
        </DataRow>
      ))}
    </TableWrap>
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
  if (/^\d{1,3}(-\d{1,3}){3}$/.test(serverId)) {
    return serverId.replace(/-/g, '.');
  }
  return serverId;
}

function fmtDate(iso?: string): string {
  if (!iso) {
    return '-';
  }
  const d = new Date(iso);
  if (isNaN(d.getTime()) || d.getFullYear() < 2000) {
    return '-';
  }
  return d.toLocaleString();
}

function stateColor(state: string): string {
  switch (state) {
    case 'APPROVED':
      return '#36c98c';
    case 'DENIED':
      return '#e96f6f';
    case 'PENDING':
      return '#f5a623';
    default:
      return 'inherit';
  }
}

function isDurationValid(
  preset: DurationPreset,
  customValue: string
): boolean {
  if (preset !== 'custom') {
    return true;
  }

  return Number(customValue) > 0;
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

const TabBar = styled(Flex)`
  gap: 8px;
`;

const TabButton = styled.button<{ $active: boolean }>`
  background: ${p => (p.$active ? p.theme.colors.spotBackground[0] : 'none')};
  border: 1px solid
    ${p => (p.$active ? '#512fc9' : p.theme.colors.spotBackground[1])};
  border-radius: 6px;
  color: inherit;
  cursor: pointer;
  font-weight: ${p => (p.$active ? 700 : 500)};
  padding: 8px 12px;
`;

const DurationPicker = styled(Flex)`
  flex-wrap: wrap;
  gap: 8px;
`;

const DurationButton = styled.button<{ $active: boolean }>`
  background: ${p => (p.$active ? p.theme.colors.spotBackground[0] : 'none')};
  border: 1px solid
    ${p => (p.$active ? '#512fc9' : p.theme.colors.spotBackground[1])};
  border-radius: 6px;
  color: inherit;
  cursor: pointer;
  font-weight: ${p => (p.$active ? 700 : 500)};
  min-width: 72px;
  padding: 8px 12px;
`;

const CustomDurationRow = styled(Flex)`
  align-items: center;
  gap: 8px;
`;

const CustomDurationInput = styled.input`
  background: transparent;
  border: 1px solid ${p => p.theme.colors.spotBackground[1]};
  border-radius: 4px;
  color: inherit;
  height: 34px;
  padding: 0 10px;
  width: 88px;
`;

const CustomDurationSelect = styled.select`
  background: transparent;
  border: 1px solid ${p => p.theme.colors.spotBackground[1]};
  border-radius: 4px;
  color: inherit;
  height: 34px;
  min-width: 120px;
  padding: 0 8px;
`;

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
  border-radius: 8px;
  max-width: 720px;
`;

const TableWrap = styled(Box)`
  border: 1px solid ${p => p.theme.colors.spotBackground[1]};
  border-radius: 8px;
  overflow-x: auto;
  overflow-y: visible;
  max-width: 1120px;
`;

const HeaderRow = styled(Flex)`
  background: ${p => p.theme.colors.spotBackground[0]};
  font-weight: bold;
`;

const DataRow = styled(Flex)`
  border-top: 1px solid ${p => p.theme.colors.spotBackground[0]};
`;
