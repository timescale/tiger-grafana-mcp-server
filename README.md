# Tiger Grafana MCP Server

MCP server that queries Timescale dev Grafana datasources (Postgres and Prometheus) to return basic information about a user instance (PostgreSQL and TimescaleDB versions).

Built on [`@tigerdata/mcp-boilerplate`](https://www.npmjs.com/package/@tigerdata/mcp-boilerplate) and the [Model Context Protocol](https://modelcontextprotocol.io/introduction).

## Tools

| Tool | Description |
|------|-------------|
| `userInstanceBasicInformation` | Looks up PostgreSQL and TimescaleDB versions for a given `projectId` and `serviceId` via Grafana datasource queries |

## Requirements

- Node.js 22+
- A Grafana URL reachable from where the server runs
- A Grafana **service account token** with permission to query datasources

## Configuration

| Variable | Description |
|----------|-------------|
| `GRAFANA_URL` | Grafana base URL (no trailing slash). In-cluster dev: `http://monitoring-v2-grafana.savannah-system.svc.cluster.local` |
| `GRAFANA_SERVICE_ACCOUNT_TOKEN` | Grafana service account token (Bearer auth) |

Create a `.env` file in the project root:

```bash
GRAFANA_URL=http://monitoring-v2-grafana.savannah-system.svc.cluster.local
GRAFANA_SERVICE_ACCOUNT_TOKEN=your-token-here
```

### Grafana service account token

1. Open Grafana (dev: `https://grafana.dev-us-east-1.ops.dev.timescale.com` or your environment URL).
2. **Administration** → **Service accounts** → create or select an account.
3. Add a token with access to the Postgres and Prometheus datasources used by the tool.
4. Put the token in `GRAFANA_SERVICE_ACCOUNT_TOKEN`.

For Kubernetes deploys, the token is stored as a sealed secret in [`tiger-agents-deploy`](../tiger-agents-deploy) under `charts/tiger-grafana-mcp-server/values/dev.yaml`.

## Development

```bash
git clone git@github.com:timescale/tiger-grafana-mcp-server.git
cd tiger-grafana-mcp-server
npm install
npm run build
```

### Run locally

**HTTP** (default for Docker):

```bash
npm run build
node dist/index.js http
```

**stdio** (for Claude Desktop / Inspector):

```bash
node dist/index.js stdio
```

### Scripts

| Command | Description |
|---------|-------------|
| `npm run build` | Compile TypeScript |
| `npm run typecheck` | Type check only |
| `npm run test` | Run tests |
| `npm run lint` | Biome lint |
| `npm run inspector` | Open MCP Inspector |

### MCP Inspector

```bash
npm run build
npx @modelcontextprotocol/inspector
```

| Field | Value |
|-------|-------|
| Transport | `STDIO` |
| Command | `node` |
| Arguments | `dist/index.js` |

Set `GRAFANA_URL` and `GRAFANA_SERVICE_ACCOUNT_TOKEN` in the inspector env section (or use `.env` with stdio after loading dotenv via your shell).

### Claude Desktop (stdio)

```json
{
  "mcpServers": {
    "tiger-grafana": {
      "command": "node",
      "args": ["/absolute/path/to/tiger-grafana-mcp-server/dist/index.js", "stdio"],
      "env": {
        "GRAFANA_URL": "http://monitoring-v2-grafana.savannah-system.svc.cluster.local",
        "GRAFANA_SERVICE_ACCOUNT_TOKEN": "your-token-here"
      }
    }
  }
}
```

## Deployment

Images are built and deployed via GitHub Actions, which dispatch workflows in [tiger-agents-deploy](https://github.com/timescale/tiger-agents-deploy).

| Event | Behavior |
|-------|----------|
| Push to a feature branch | Build image, deploy to **dev** (`savannah-system`) |
| Push to `main` | Build image (`latest`), deploy to **dev** and **prod** |

Helm chart: `tiger-agents-deploy/charts/tiger-grafana-mcp-server`

**Dev Tailscale URL** (when Tailscale is enabled in dev values):

`https://tiger-grafana-mcp-server.tail9d164.ts.net`

## License

Apache-2.0
