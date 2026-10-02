# Composio integrations

Modus supports both **Composio For You API Keys** (`ck_…`) and **Composio Platform Project API Keys**. Open **Settings → MCP & Integrations → Composio**, paste the key, and choose **Save key**. Modus detects the connection mode and validates the key before replacing the saved credential. User API Keys (`uak_…`) are not supported.

The generic MCP configuration is separate. Modus does not save Composio credentials or session endpoints in `mcp.json`.

## Composio For You

Get your personal key from **Composio For You → Settings → Sessions & API Key**. Modus connects to the official personal MCP endpoint, `https://connect.composio.dev/mcp`, using the `x-consumer-api-key` header. See [Composio Connect](https://docs.composio.dev/docs/composio-connect) and [For You navigation](https://docs.composio.dev/kb/guide/dashboard-for-you-navigation).

After saving the key:

1. Review the discovered **Composio For You tools**.
2. Select the MCP tools agents can call.
3. Turn on **Enable for agents**.

New profiles start with no selected tools and agent access disabled. A saved selection is restored when the app restarts. Clearing the selection or disabling agent access removes the tools from the local bridge. Disabling tools works even if Composio is offline.

For You exposes discovery and execution tools such as `COMPOSIO_SEARCH_TOOLS`, `COMPOSIO_GET_TOOL_SCHEMAS`, and `COMPOSIO_MULTI_EXECUTE_TOOL`. These tools discover app operations and use your personal connected apps. Selection controls which **MCP tools** an agent can call; it does **not** restrict the app actions available inside an execution tool. The Platform workflow below provides selection of individual app operations. Manage personal connections in Composio For You or through its connection tools.

Personal connections belong to the Composio consumer identity associated with your key. Modus does not invent Platform accounts for them or call the project API with a personal key. Personal and project configurations are kept separately; see [consumer and project boundaries](https://docs.composio.dev/kb/guide/consumer-project-boundaries-and-auth-selection).

## Composio Platform

Get a Project API Key from **Composio Platform → your project → Settings → API Keys**. Modus validates read access to toolkits and the local profile's connected accounts. This initial check does not prove write access; a missing write permission is reported when the corresponding operation runs.

| Resource | Required access | Used for |
| --- | --- | --- |
| Toolkits and tools | Read | Discovering platforms and their operations. |
| Connected Accounts | Read and write | Listing, connecting, and disconnecting accounts. |
| Auth Configs | Read; write when creating a managed configuration | Preparing authentication for a platform. |
| Sessions | Read and write | Creating and synchronizing the hosted MCP session. |
| Session tool execution | Write | Executing the selected operations through MCP. |

Permission names and availability are documented in [Project API Key permissions](https://docs.composio.dev/reference/authenticating-to-composio/project-api-key-permissions). Scoped keys can receive a generic 401 when a required permission is missing, even if the key is valid. A 401 alone does not prove the key was revoked. Existing scoped key permissions cannot be edited; create a replacement key with the required access.

To connect a platform, Modus selects a usable managed Auth Config or another enabled configuration. If necessary, it creates a managed configuration. Some platforms require your own OAuth app or additional setup in the Composio dashboard. See [Custom Auth Configs](https://docs.composio.dev/docs/auth-configuration/custom-auth-configs).

Complete authorization in the browser and return to Modus. Pending connections expire after one minute. The local limit is five accounts per platform, including pending connections. Aliases are local display names; platform credentials remain with Composio.

To enable a platform for agents, choose one active account, select at least one operation, and enable the platform. Connected accounts are not automatically enabled. The hosted session and local bridge expose the selected operations. Disconnecting an account revokes it in Composio and requires authentication to reconnect.

## Storage and tool lifecycle

- Keys are encrypted by Electron `safeStorage` in the main process. The renderer receives configured state, never the saved key. No plaintext fallback is used when system encryption is unavailable.
- Profile metadata stores selections, project account aliases, and the project session ID. Personal selections are stored independently. Files use restricted permissions and contain no API key or platform token.
- MCP URLs and authentication headers stay in the main process and are not returned in settings state or tool metadata.
- Calls use the normal Modus `mcp.call` permission flow. Tool definitions are refreshed for the next turn in existing chats when registrations change.
- Changing the key cancels pending project authorization. Closing Modus unregisters local tools and cancels pending connections. Removing the key clears the encrypted credential; project sessions are closed when possible. Personal connected apps remain in Composio.

The Platform profile uses a stable opaque local identifier. For You uses the personal identity associated with the consumer key. Agents in a local Modus profile share its configured integrations.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| For You key is rejected | Use the active key from **Sessions & API Key**. Check access to the personal MCP endpoint. **Test connection** performs temporary discovery without enabling tools. |
| Project key is rejected | Check that the key is active and has the required project permissions. Scoped permission failures may also return 401. |
| Key saves but project connection fails | Check Connected Account write access and Auth Config access; session management and execution require their own permissions. |
| Personal tools are unavailable | Select MCP tools and turn on **Enable for agents**. Refresh the catalog after a network failure. |
| Project operations are unavailable | Choose an active account, select operations, and enable the platform. Check session execution permissions. |
| Catalog changes or synchronization fails | Tools are disabled when a saved consumer selection is unavailable or synchronization fails. Refresh and review the selection before enabling again. |
| Key cannot be saved or removed | Check system secure storage and write access to Modus's data directory. |

**Refresh catalog** retries discovery and synchronization. **Test connection** checks connectivity without registering tools. A failed candidate validation preserves the previous encrypted key.
