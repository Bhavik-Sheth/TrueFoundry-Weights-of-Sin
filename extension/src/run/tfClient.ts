/**
 * run/tfClient.ts - C2 thin wrapper over @truefoundry/trueforge-sdk.
 * This is the ONLY file in the extension that imports the SDK.
 *
 * Exports:
 *  - createSession(agent): Promise<sessionId> (client.sessions.create).
 *  - streamTurn(sessionId, content): async iterable of events (createTurnStream); uses
 *    isEventDelta/mergeEventDelta for model.message.delta.
 *  - approve(sessionId, turnId, threadId, toolCallId, allow, reason?, afterEventId): subscribeToTurn
 *    then createTurnEvents with user.tool_approval allow/deny.
 *  - cancel(sessionId): client.sessions.cancel (idempotent).
 *  - sessionUrl(sessionId): link shown in the panel ("Open session in TrueForge").
 *
 * Rules: no model provider SDK or URL anywhere. Pin SDK version after the first spike.
 * Depends on: @truefoundry/trueforge-sdk, config. Depended on by: run/runManager, run/fallback.
 */
export {};
