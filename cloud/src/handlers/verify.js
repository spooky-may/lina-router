import { getMachineData } from "../services/storage.js";
import { extractBearerToken, parseApiKey } from "../utils/apiKey.js";

/*
 * Endpoint that validates a caller-supplied API key against the machine record.
 * Two address modes are supported:
 *   - Legacy: machineId is carried in the URL path.
 *   - Current: machineId is embedded in the API key payload itself.
 */

const RESPONSE_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Content-Type": "application/json",
};

function send(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: RESPONSE_HEADERS,
  });
}

async function resolveMachineId(apiKey, fromUrl) {
  if (fromUrl) return { ok: true, machineId: fromUrl };

  const parsed = await parseApiKey(apiKey);
  if (!parsed) {
    return { ok: false, status: 401, error: "Invalid API key format" };
  }
  if (!parsed.isNewFormat || !parsed.machineId) {
    return { ok: false, status: 400, error: "API key does not contain machineId" };
  }
  return { ok: true, machineId: parsed.machineId };
}

/**
 * @param {Request} request
 * @param {Object} env
 * @param {string|null} machineIdOverride machineId pulled from URL (legacy) or null (current)
 */
export async function handleVerify(request, env, machineIdOverride = null) {
  const apiKey = extractBearerToken(request);
  if (!apiKey) {
    return send({ error: "Missing or invalid Authorization header" }, 401);
  }

  const resolution = await resolveMachineId(apiKey, machineIdOverride);
  if (!resolution.ok) {
    return send({ error: resolution.error }, resolution.status);
  }
  const machineId = resolution.machineId;

  const record = await getMachineData(machineId, env);
  if (!record) {
    return send({ error: "Machine not found" }, 404);
  }

  const matched = record.apiKeys?.some((entry) => entry.key === apiKey) ?? false;
  if (!matched) {
    return send({ error: "Invalid API key" }, 401);
  }

  return send({
    valid: true,
    machineId,
    providersCount: Object.keys(record.providers || {}).length,
  });
}
