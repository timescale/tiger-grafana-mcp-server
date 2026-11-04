import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { z } from 'zod';
import type { ServerContext } from '../types.js';
import { userInstanceBasicInformation } from './userInstanceBasicInformation.js';

const context: ServerContext = {
  grafana: {
    url: 'https://grafana.example.com',
    publicUrl: 'https://grafana.example.com',
    serviceAccountToken: 'token',
  },
};

const grafanaResponse = (
  refId: string,
  values: unknown[][],
): { results: Record<string, unknown> } => ({
  results: {
    [refId]: {
      status: 200,
      frames: [
        {
          data: {
            values,
          },
        },
      ],
    },
  },
});

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const responseForRequest = (init: RequestInit): Response => {
  const payload = JSON.parse(String(init.body));
  const refIds = payload.queries.map((query: { refId: string }) => query.refId);

  if (refIds.includes('major') && refIds.includes('minor')) {
    return jsonResponse({
      results: {
        major: grafanaResponse('major', [[1779351105410], [18.0003]]).results
          .major,
        minor: grafanaResponse('minor', [[1779351105422], [3]]).results.minor,
      },
    });
  }

  return jsonResponse(grafanaResponse('timescaledb', [['2.27.0']]));
};

describe('userInstanceBasicInformation', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('returns PostgreSQL and TimescaleDB versions', async () => {
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
      ['major', 'minor'],
    );

    const postgresCall = fetchMock.mock.calls[1];
    assert.ok(postgresCall);
    const [, postgresInit] = postgresCall.arguments as [string, RequestInit];
    const postgresPayload = JSON.parse(String(postgresInit.body));
    assert.deepEqual(
      postgresPayload.queries.map((query: { refId: string }) => query.refId),
      ['timescaledb'],
    );
  });

  it('escapes project and service IDs in the TimescaleDB query', async () => {
    const fetchMock = mock.method(globalThis, 'fetch', async () =>
      jsonResponse(grafanaResponse('major', [[1779351105410], [18.0003]])),
    );

    const tool = await userInstanceBasicInformation(context, {});
    await tool.fn({
      projectId: "project'id",
      serviceId: "service'id",
    });

    const call = fetchMock.mock.calls[1];
    assert.ok(call);
    const [, init] = call.arguments as [string, RequestInit];
    const payload = JSON.parse(String(init.body));
    assert.match(payload.queries[0].rawSql, /project_id = 'project''id'/);
    assert.match(payload.queries[0].rawSql, /service_id = 'service''id'/);
  });

  it('escapes project and service IDs in the Prometheus queries', async () => {
    const fetchMock = mock.method(globalThis, 'fetch', async () =>
      jsonResponse(grafanaResponse('major', [[1779351105410], [18.0003]])),
    );

    const tool = await userInstanceBasicInformation(context, {});
    await tool.fn({
      projectId: 'x"} or up{a="',
      serviceId: 'y\\"}\nor up{',
    });

    const call = fetchMock.mock.calls[0];
    assert.ok(call);
    const [, init] = call.arguments as [string, RequestInit];
    const payload = JSON.parse(String(init.body));
    for (const query of payload.queries) {
      assert.equal(
        query.expr.split('pg_settings_server_version_num{').length,
        2,
      );
      assert.match(
        query.expr,
        /projectid="x\\"} or up{a=\\"", serviceid="y\\\\\\"}\\nor up{"/,
      );
    }
  });

  it('only accepts lowercase alphanumeric project and service IDs', async () => {
    const tool = await userInstanceBasicInformation(context, {});
    const Input = z.object(tool.config.inputSchema);

    assert.ok(
      Input.safeParse({ projectId: 'a90edkib9o', serviceId: 'forkh6059q' })
        .success,
    );
    for (const bad of [
      '',
      'A90EDKIB9O',
      'a90edkib9o"}',
      'a90edkib9o", region="eu-central-1',
      'a90edkib9o\n',
      'a-b',
    ]) {
      assert.equal(
        Input.safeParse({ projectId: bad, serviceId: 'forkh6059q' }).success,
        false,
        `projectId ${JSON.stringify(bad)} must be rejected`,
      );
      assert.equal(
        Input.safeParse({ projectId: 'a90edkib9o', serviceId: bad }).success,
        false,
        `serviceId ${JSON.stringify(bad)} must be rejected`,
      );
    }
  });
});
