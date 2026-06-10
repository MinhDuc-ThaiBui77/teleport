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

// Custom (fork) page: lets an OSS user request time-limited access to a server
// by requesting a per-server role. Wired to lib/web/accessrequests_custom.go.
// User-facing strings are in Vietnamese on purpose (internal tool for VN users).

import { type ChangeEvent, useCallback, useEffect, useState } from 'react';
import styled from 'styled-components';

import {
  Alert,
  Box,
  ButtonPrimary,
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
import {
  type CustomAccessRequest as AccessRequest,
  createCustomAccessRequest,
  fetchCustomAccessRequestCapabilities,
  fetchMyCustomAccessRequests,
} from 'teleport/services/customAccessRequests';
import useStickyClusterId from 'teleport/useStickyClusterId';

const DURATION_OPTIONS: { hours: number; label: string }[] = [
  { hours: 0, label: 'Mặc định (theo role)' },
  { hours: 1, label: '1 giờ' },
  { hours: 4, label: '4 giờ' },
  { hours: 8, label: '8 giờ' },
  { hours: 24, label: '24 giờ' },
];

export function CustomAccessRequest() {
  const { clusterId } = useStickyClusterId();

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
      (roles: string[], reason: string, hours: number) =>
        createCustomAccessRequest(clusterId, {
          roles,
          reason: reason.trim() || undefined,
          maxDurationMs: hours > 0 ? hours * 60 * 60 * 1000 : undefined,
        }),
      [clusterId]
    )
  );

  const [selectedRoles, setSelectedRoles] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [hours, setHours] = useState(0);

  useEffect(() => {
    runFetchCaps();
    runFetchList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clusterId]);

  function toggleRole(role: string) {
    setSelectedRoles(prev =>
      prev.includes(role) ? prev.filter(r => r !== role) : [...prev, role]
    );
  }

  async function onSubmit() {
    const [, err] = await runCreate(selectedRoles, reason, hours);
    if (!err) {
      setSelectedRoles([]);
      setReason('');
      setHours(0);
      runFetchList();
    }
  }

  const requireReason = !!capsAttempt.data?.requireReason;
  const requestableRoles = capsAttempt.data?.requestableRoles ?? [];
  const canSubmit =
    selectedRoles.length > 0 &&
    (!requireReason || reason.trim().length > 0) &&
    createAttempt.status !== 'processing';

  return (
    <FeatureBox>
      <FeatureHeader>
        <FeatureHeaderTitle>Yêu cầu truy cập Server</FeatureHeaderTitle>
      </FeatureHeader>

      <Text mb={3} color="text.slightlyMuted">
        Chọn server bạn cần truy cập (mỗi server tương ứng một role), nhập lý do
        rồi gửi yêu cầu. Quản trị viên sẽ duyệt; sau khi được duyệt, quyền truy
        cập có hiệu lực trong khoảng thời gian giới hạn.
      </Text>

      {createAttempt.status === 'error' && (
        <Danger>{createAttempt.statusText}</Danger>
      )}
      {createAttempt.status === 'success' && (
        <Alert kind="success">
          Đã gửi yêu cầu. Vui lòng chờ quản trị viên duyệt.
        </Alert>
      )}

      <Panel mb={4} p={3}>
        <Text bold mb={2}>
          Server (role) muốn truy cập
        </Text>

        {capsAttempt.status === 'processing' && (
          <Box textAlign="center" m={4}>
            <Indicator />
          </Box>
        )}
        {capsAttempt.status === 'error' && (
          <Danger>{capsAttempt.statusText}</Danger>
        )}
        {capsAttempt.status === 'success' && requestableRoles.length === 0 && (
          <Text color="text.muted">
            Bạn chưa được cấp quyền yêu cầu server nào. Liên hệ quản trị viên để
            được gán vào role có quyền request.
          </Text>
        )}
        {capsAttempt.status === 'success' &&
          requestableRoles.map(role => (
            <Flex key={role} alignItems="center" gap={2} mb={1}>
              <input
                type="checkbox"
                id={`role-${role}`}
                checked={selectedRoles.includes(role)}
                onChange={() => toggleRole(role)}
              />
              <label htmlFor={`role-${role}`}>{role}</label>
            </Flex>
          ))}

        <Text bold mt={3} mb={1}>
          Lý do {requireReason ? '(bắt buộc)' : '(không bắt buộc)'}
        </Text>
        <TextArea
          placeholder="Ví dụ: deploy hotfix cho sự cố #123"
          value={reason}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
            setReason(e.target.value)
          }
          rows={3}
        />

        <Text bold mt={3} mb={1}>
          Thời hạn truy cập
        </Text>
        <select
          value={hours}
          onChange={(e: ChangeEvent<HTMLSelectElement>) =>
            setHours(Number(e.target.value))
          }
          style={{ padding: '8px', borderRadius: '4px', minWidth: '220px' }}
        >
          {DURATION_OPTIONS.map(opt => (
            <option key={opt.hours} value={opt.hours}>
              {opt.label}
            </option>
          ))}
        </select>

        <Box mt={4}>
          <ButtonPrimary disabled={!canSubmit} onClick={onSubmit}>
            {createAttempt.status === 'processing'
              ? 'Đang gửi...'
              : 'Gửi yêu cầu'}
          </ButtonPrimary>
        </Box>
      </Panel>

      <Flex alignItems="center" justifyContent="space-between" mb={2}>
        <Text bold fontSize={3}>
          Yêu cầu của tôi
        </Text>
        <ButtonPrimary
          size="small"
          onClick={() => runFetchList()}
          disabled={listAttempt.status === 'processing'}
        >
          Làm mới
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
        <RequestsTable items={listAttempt.data} />
      )}
    </FeatureBox>
  );
}

function RequestsTable({ items }: { items: AccessRequest[] }) {
  if (!items || items.length === 0) {
    return <Text color="text.muted">Chưa có yêu cầu nào.</Text>;
  }

  return (
    <TableWrap>
      <HeaderRow px={3} py={2}>
        <Box flex="2">Server (roles)</Box>
        <Box flex="1">Trạng thái</Box>
        <Box flex="2">Tạo lúc</Box>
        <Box flex="2">Hết hạn</Box>
      </HeaderRow>
      {items.map(req => (
        <DataRow key={req.id} px={3} py={2} alignItems="center">
          <Box flex="2">{(req.roles || []).join(', ')}</Box>
          <Box flex="1">
            <span style={{ color: stateColor(req.state), fontWeight: 600 }}>
              {req.state}
            </span>
          </Box>
          <Box flex="2">{fmtDate(req.created)}</Box>
          <Box flex="2">{fmtDate(req.expires)}</Box>
        </DataRow>
      ))}
    </TableWrap>
  );
}

function fmtDate(iso?: string): string {
  if (!iso) {
    return '—';
  }
  const d = new Date(iso);
  if (isNaN(d.getTime()) || d.getFullYear() < 2000) {
    return '—';
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

const Panel = styled(Box)`
  border: 1px solid ${p => p.theme.colors.spotBackground[1]};
  border-radius: 8px;
  max-width: 720px;
`;

const TableWrap = styled(Box)`
  border: 1px solid ${p => p.theme.colors.spotBackground[1]};
  border-radius: 8px;
  overflow: hidden;
  max-width: 960px;
`;

const HeaderRow = styled(Flex)`
  background: ${p => p.theme.colors.spotBackground[0]};
  font-weight: bold;
`;

const DataRow = styled(Flex)`
  border-top: 1px solid ${p => p.theme.colors.spotBackground[0]};
`;
