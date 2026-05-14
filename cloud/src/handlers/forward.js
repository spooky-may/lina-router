/*
 * Generic outbound HTTP forwarder.
 * Strips Cloudflare edge-injected metadata before relay so the upstream
 * sees a "clean" request originating from this worker.
 */

const STRIPPED_REQUEST_HEADERS = new Set([
  "cf-connecting-ip",
  "cf-connecting-ip6",
  "cf-connecting-ip6-policy",
  "cf-ipcountry",
  "cf-ray",
  "cf-tracking-id",
  "cf-visitor",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
]);

const JSON_HEADERS = { "Content-Type": "application/json" };

// Minimize Cloudflare-side feature injection on outbound fetch.
const RELAY_CF_OPTS = Object.freeze({
  minify: false,
  mirage: false,
  polish: "off",
  scrapeShield: false,
});

function reply(payload, status) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: JSON_HEADERS,
  });
}

function pruneIncomingHeaders(raw) {
  const kept = {};
  for (const headerName of Object.keys(raw)) {
    if (STRIPPED_REQUEST_HEADERS.has(headerName.toLowerCase())) continue;
    kept[headerName] = raw[headerName];
  }
  return kept;
}

function decorateForwardHeaders(headerBag, parsedUrl, originIp) {
  headerBag["X-Client-IP"] = originIp;
  headerBag["X-Forwarded-Proto"] = parsedUrl.protocol.replace(":", "");
  headerBag["X-Forwarded-Host"] = parsedUrl.host;
  headerBag["X-From-Worker"] = "1";
  return headerBag;
}

// Public entry: POST a JSON envelope describing the upstream call.
export async function handleForward(request) {
  try {
    const incomingUrl = new URL(request.url);
    const callerIp = request.headers.get("CF-Connecting-IP") || "";

    const envelope = await request.json();
    const { targetUrl, headers = {}, body } = envelope;

    if (!targetUrl) {
      return reply({ error: "targetUrl is required" }, 400);
    }

    const relayHeaders = decorateForwardHeaders(
      pruneIncomingHeaders(headers),
      incomingUrl,
      callerIp
    );

    console.log("[FORWARD] Target:", targetUrl);
    console.log("[FORWARD] Headers:", JSON.stringify(relayHeaders));

    // Wrap in a Request first so headers are precisely controlled.
    const outbound = new Request(targetUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...relayHeaders,
      },
      body: JSON.stringify(body),
    });

    const upstreamResponse = await fetch(outbound, { cf: RELAY_CF_OPTS });

    // Pipe upstream body straight through; add permissive CORS.
    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      headers: {
        "Content-Type":
          upstreamResponse.headers.get("Content-Type") || "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (err) {
    console.error("[FORWARD] Error:", err.message);
    return reply({ error: err.message }, 500);
  }
}
