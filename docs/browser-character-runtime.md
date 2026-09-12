# Browser and Steam live runtime observation

Call `browser_get_character_runtime` with `{"character":"Laminakor"}` through MCP, or POST the same arguments plus your account token to `/mcp_api/browser_get_character_runtime`.

The method uses the same account ownership, Mainframe-assignment rejection, server validation, and authenticated relay connection as browser CODE status. It reads the live game server's welcome packet, sends no application events or CODE commands, and disconnects. It does not start, stop, reload, or evaluate CODE.

The result includes `success`, `character`, `runtime`, `server`, `online`, `code_running`, and `observation`. The observation includes name, class, level, map, x/y, HP/MP and maxima, death state, target, party leader, and equipment summaries (item name, level, stat type, special-property identifier). It excludes inventory, shop slots, account data, secrets, and the raw character object.

`observation.source` is `authenticated_game_server_welcome`. `observed_at` is the UTC time the relay received the packet, not a saved-profile timestamp or an exact server simulation timestamp. Each successful call opens a fresh relay connection. Movement can continue after receipt. Missing or invalid fields are null. An available but empty equipment object is {}. The current welcome serializer does not provide a party roster, so `party_roster` is null; the method never invents a roster from saved data.

Offline characters return `character_offline`; there is no saved-state fallback. Other failures preserve existing browser-tool reasons, including `character_not_found`, `runtime_mismatch`, `server_unavailable`, `browser_session_unavailable`, and relay timeout/connection failures. Existing browser status and CODE controls retain their response shapes.

## Verification

Run `node --test node/test/browser_character_runtime.test.js` from the repository root. Tests use mocked ownership lookups and relay sockets, never a game session.

For live verification, deploy this change to an authorized MCP service, refresh its tool catalog, then call the new method for an already-connected, account-owned browser/Steam character. No CODE execution is necessary. A fork alone does not update the hosted Adventure Land MCP service. The inspected public source names the relay /comm; the deployed connector documentation names /hub. This change reuses the existing relay implementation and server-resolved connection path instead of hard-coding either name.
