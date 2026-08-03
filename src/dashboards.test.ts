import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildDashboardUrl,
  DASHBOARD_KEYS,
  DASHBOARDS,
  type DashboardContext,
} from './dashboards.js';

const fullContext: DashboardContext = {
  projectId: 'kbq0mbo1jb',
  serviceId: 'jzfulctix1',
  region: 'eu-central-1',
  promDatasourceUid: 'P06D2DA4239B6BF57',
  logHost: 'log.prod-eu-central-1.ops.forge.timescale.com',
  instancePod: 'jzfulctix1-an-0',
  connectorAppName: 'pgsrc-connector',
};

describe('DASHBOARDS', () => {
  it('has a unique UID per entry', () => {
    const uids = DASHBOARD_KEYS.map((key) => DASHBOARDS[key].uid);
    assert.equal(new Set(uids).size, uids.length);
  });

  it('resolves every variable when the full context is known', () => {
    for (const key of DASHBOARD_KEYS) {
      const { missing } = buildDashboardUrl(
        'https://grafana.example.com',
        DASHBOARDS[key],
        fullContext,
        { from: 'now-2d', to: 'now' },
      );
      assert.deepEqual(missing, [], `${key} left variables unresolved`);
    }
  });
});

describe('buildDashboardUrl', () => {
  it('omits null variables and reports them as missing', () => {
    const { url, vars, missing } = buildDashboardUrl(
      'https://grafana.example.com',
      DASHBOARDS['pg-connector'],
      { ...fullContext, instancePod: null, promDatasourceUid: null },
      { from: 'now-2d', to: 'now' },
    );

    assert.deepEqual(missing, ['prom_region', 'pod']);
    assert.equal(vars.pod, undefined);
    assert.equal(new URL(url).searchParams.get('var-pod'), null);
    assert.equal(new URL(url).searchParams.get('var-region'), 'eu-central-1');
  });

  it('percent-encodes variable values', () => {
    const { url } = buildDashboardUrl(
      'https://grafana.example.com',
      DASHBOARDS['user-instance'],
      { ...fullContext, projectId: 'a b&c=d' },
      { from: 'now-2d', to: 'now' },
    );

    assert.ok(url.includes('var-project=a+b%26c%3Dd'));
    assert.equal(new URL(url).searchParams.get('var-project'), 'a b&c=d');
  });

  it('does not drop the trailing slug from the dashboard path', () => {
    const { url } = buildDashboardUrl(
      'https://grafana.example.com',
      DASHBOARDS['pg-connector'],
      fullContext,
      { from: 'now-2d', to: 'now' },
    );

    assert.ok(
      new URL(url).pathname.endsWith(
        '/d/ce903ba2-882e-48e4-b474-e8f34fc197cf/postgres-livesync-single-user',
      ),
    );
  });
});
