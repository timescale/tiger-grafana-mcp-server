import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import type { ServerContext } from '../types.js';
import { userInstanceBasicInformation } from './userInstanceBasicInformation.js';

const context: ServerContext = {
  grafana: {
    url: 'https://grafana.example.com',
    publicUrl: 'https://grafana.example.com',
    serviceAccountToken: 'token',
  },
};

const promFrame = (refId: string, value: unknown): unknown => ({
  status: 200,
  frames: [
    {
      schema: { refId, fields: [{ name: 'Time' }, { name: 'Value' }] },
      data: { values: [[1779351105410], [value]] },
    },
  ],
});

const pgFrame = (refId: string, columns: unknown[][]): unknown => ({
  status: 200,
  frames: [
    {
      schema: { refId },
      data: { values: columns },
    },
  ],
});

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const responseForRequest = (init: RequestInit): Response => {
  const payload = JSON.parse(String(init.body));
  const refIds: string[] = payload.queries.map(
    (query: { refId: string }) => query.refId,
  );

  if (refIds.includes('major')) {
    // Prometheus call
    return jsonResponse({
      results: {
        major: promFrame('major', 18.0003),
        minor: promFrame('minor', 3),
        pg_up: promFrame('pg_up', 1),
        disk_used: promFrame('disk_used', 5_730_000_000),
        disk_cap: promFrame('disk_cap', 10_000_000_000),
        // 4.3 GB/day = ~4.3e9 bytes/day worth of delta
        disk_growth_bytes_per_day: promFrame(
          'disk_growth_bytes_per_day',
          4_300_000_000,
        ),
        oom_events_7d: promFrame('oom_events_7d', 2),
        // 0.05 CPU cores avg
        avg_cpu_cores_7d: promFrame('avg_cpu_cores_7d', 0.05),
      },
    });
  }

  // Postgres call
  return jsonResponse({
    results: {
      timescaledb: pgFrame('timescaledb', [['2.27.0']]),
      service_info: pgFrame('service_info', [[true], ['eu-west-1']]),
      plan: pgFrame('plan', [['Scale']]),
      resource_spec: pgFrame('resource_spec', [[2], [8], [0]]),
    },
  });
};

describe('userInstanceBasicInformation', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('returns the full health snapshot', async () => {
    const fetchMock = mock.method(
      globalThis,
      'fetch',
      async (_url: unknown, init: unknown) =>
        responseForRequest(init as RequestInit),
    );

    const tool = await userInstanceBasicInformation(context, {});
    const result = await tool.fn({
      projectId: 'a90edkib9o',
      serviceId: 'forkh6059q',
    });

    assert.deepEqual(result, {
      postgresqlVersion: '18.3',
      timescaledbVersion: '2.27.0',
      region: 'eu-west-1',
      plan: 'Scale',
      cpuCores: 2,
      memoryGb: 8,
      replicaCount: 0,
      isRunning: true,
      isPostgresUp: true,
      diskUsagePercent: 57.3,
      diskGrowthGbPerDay: 4.3,
      oomEventsLast7d: 2,
      avgCpuCoresLast7d: 0.05,
      dashboardUrl:
        'https://grafana.example.com/d/3lvO6U-Zz/user-instance-single?var-project=a90edkib9o&var-service=forkh6059q',
    });
    assert.equal(fetchMock.mock.callCount(), 2);

    const prometheusCall = fetchMock.mock.calls[0];
    assert.ok(prometheusCall);
    const [, prometheusInit] = prometheusCall.arguments as [
      string,
      RequestInit,
    ];
    const prometheusPayload = JSON.parse(String(prometheusInit.body));
    assert.deepEqual(
      prometheusPayload.queries.map((query: { refId: string }) => query.refId),
      [
        'major',
        'minor',
        'pg_up',
        'disk_used',
        'disk_cap',
        'disk_growth_bytes_per_day',
        'oom_events_7d',
        'avg_cpu_cores_7d',
      ],
    );

    const postgresCall = fetchMock.mock.calls[1];
    assert.ok(postgresCall);
    const [, postgresInit] = postgresCall.arguments as [string, RequestInit];
    const postgresPayload = JSON.parse(String(postgresInit.body));
    assert.deepEqual(
      postgresPayload.queries.map((query: { refId: string }) => query.refId),
      ['timescaledb', 'service_info', 'plan', 'resource_spec'],
    );
  });

  it('escapes project and service IDs in every SQL query', async () => {
    const fetchMock = mock.method(globalThis, 'fetch', async () =>
      jsonResponse({ results: {} }),
    );

    const tool = await userInstanceBasicInformation(context, {});
    await tool.fn({
      projectId: "project'id",
      serviceId: "service'id",
    });

    const postgresCall = fetchMock.mock.calls[1];
    assert.ok(postgresCall);
    const [, init] = postgresCall.arguments as [string, RequestInit];
    const payload = JSON.parse(String(init.body));
    const allSql = payload.queries
      .map((q: { rawSql: string }) => q.rawSql)
      .join('\n');
    assert.match(allSql, /project_id = 'project''id'/);
    assert.match(allSql, /service_id = 'service''id'/);
    assert.match(allSql, /svc.id = 'service''id'/);
    assert.match(allSql, /svc.project_id = 'project''id'/);
    assert.ok(!allSql.includes("'project'id'"), 'unescaped quote leaked');
    assert.ok(!allSql.includes("'service'id'"), 'unescaped quote leaked');
  });

  it('returns nulls gracefully when responses are empty', async () => {
    mock.method(globalThis, 'fetch', async () =>
      jsonResponse({ results: {} }),
    );

    const tool = await userInstanceBasicInformation(context, {});
    const result = await tool.fn({
      projectId: 'p',
      serviceId: 's',
    });

    assert.deepEqual(result, {
      postgresqlVersion: null,
      timescaledbVersion: null,
      region: null,
      plan: null,
      cpuCores: null,
      memoryGb: null,
      replicaCount: null,
      isRunning: null,
      isPostgresUp: null,
      diskUsagePercent: null,
      diskGrowthGbPerDay: null,
      oomEventsLast7d: null,
      avgCpuCoresLast7d: null,
      dashboardUrl:
        'https://grafana.example.com/d/3lvO6U-Zz/user-instance-single?var-project=p&var-service=s',
    });
  });
});
