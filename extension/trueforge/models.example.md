# Model configuration example (no keys)

Models are configured in TrueForge only. The extension and the agent files never contain provider keys or provider endpoints.

1. Start TrueForge (Node 22.14+): `npx @truefoundry/trueforge@latest` (default http://localhost:8790; `--port <n>` or `PORT` to change). Data is stored in a local SQLite file (`SQLITE_PATH` to move it).
2. Open **Settings -> Models**, find your provider in the catalog, click **Configure**, paste the API key under **Configure Provider Details** and click **Create**. Do this for the provider of the primary model and, if different, for the fallback model. Use a different provider (or at least a different model) for the fallback so a provider outage does not take both down.
3. Model names are `provider/model`, for example `openai/gpt-5.2` (illustrative; use whatever your catalog lists). Note the exact names you configured:
   - `PRIMARY_MODEL`  = `<provider>/<primary model>`
   - `FALLBACK_MODEL` = `<provider>/<fallback model>`
4. Register the connector and agents (from `extension/`, after running `Contexo: Copy MCP Connection` to get the token):
   ```
   CONTEXO_TOKEN=<token> PRIMARY_MODEL=<provider>/<model> FALLBACK_MODEL=<provider>/<model> node trueforge/register.mjs
   ```
   This creates the `contexo-editor` connector (URL `http://127.0.0.1:8791/mcp`, header `X-Contexo-Token`) and the agents `contexo` and `contexo-fallback` with `instructions.md` inlined. Set `CONTEXO_PORT` if you changed `contexo.mcpPort`. Alternative: Settings -> Connectors -> Add MCP Server (custom URL, header auth), then Build Agent -> pick the model, enable the connector, set approval for `propose_write` and `run_command`, Save Agent.
5. Rotate the token (delete the `contexo.mcpToken` secret) -> update the connector in TrueForge.
6. For the fallback demo, break the primary model's key or endpoint in TrueForge Settings -> Models, then run a task; Contexo should continue on `contexo-fallback`.

Do not commit provider keys, endpoints or the MCP token.
