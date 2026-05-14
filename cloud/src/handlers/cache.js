import * as logger from "../utils/logger.js";
import { parseApiKey, extractBearerToken } from "../utils/apiKey.js";
import { errorResponse } from "open-sse/utils/error.js";

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*"
};

async function resolveMachineId(payload, bearer) {
  if (payload.machineId) return payload.machineId;
  const decoded = await parseApiKey(bearer);
  return decoded?.machineId;
}

export async function handleCacheClear(request, env) {
  const bearer = extractBearerToken(request);
  if (!bearer) return errorResponse(401, "Missing API key");

  try {
    const payload = await request.json().catch(() => ({}));

    // Resolve the target machineId — either from the request body or by decoding the API key
    const machineId = await resolveMachineId(payload, bearer);

    if (!machineId) return errorResponse(400, "Missing machineId");

    // Cache subsystem has been removed; we keep the endpoint as a no-op for compatibility
    logger.info("CACHE", `Cache clear requested for machine: ${machineId} (no-op)`);

    const responseBody = JSON.stringify({
      success: true,
      machineId,
      message: "No cache layer"
    });

    return new Response(responseBody, { headers: JSON_HEADERS });
  } catch (err) {
    return errorResponse(500, err.message);
  }
}
