import { connect } from "cloudflare:sockets";

/*
 * Low-level forwarder that speaks HTTP/1.1 over a raw TCP (optionally TLS) socket.
 * Used to escape Cloudflare's auto-added headers on the outbound fetch path.
 */

const JSON_HEADERS = { "Content-Type": "application/json" };
const TAG = "[FORWARD_RAW]";
const READ_LOOP_LIMIT = 100; // ~10s ceiling at typical chunk cadence
const HEADER_TERMINATOR = "\r\n\r\n";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function jsonReply(payload, status) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: JSON_HEADERS,
  });
}

function joinChunks(prev, next) {
  if (!next) return prev;
  const out = new Uint8Array(prev.length + next.length);
  out.set(prev);
  out.set(next, prev.length);
  return out;
}

function openSocket(host, port, tls) {
  if (tls) {
    console.log(TAG, "Creating TLS socket...");
    const s = connect({
      hostname: host,
      port: parseInt(port),
      secureTransport: "on",
    });
    console.log(TAG, "TLS socket created");
    return s;
  }
  return connect({ hostname: host, port: parseInt(port) });
}

function buildHttpRequestString(path, headerBag, bodyStr) {
  let wire = `POST ${path} HTTP/1.1\r\n`;
  for (const k of Object.keys(headerBag)) {
    wire += `${k}: ${headerBag[k]}\r\n`;
  }
  wire += `\r\n${bodyStr}`;
  return wire;
}

function isResponseFinished(buf) {
  const text = decoder.decode(buf);
  const headerEnd = text.indexOf(HEADER_TERMINATOR);
  if (headerEnd === -1) return false;

  const headersBlob = text.substring(0, headerEnd).toLowerCase();
  const match = headersBlob.match(/content-length:\s*(\d+)/);
  if (!match) return false;

  const expected = parseInt(match[1]);
  const received = text.length - headerEnd - 4;
  return received >= expected;
}

async function drainSocket(reader) {
  let buffer = new Uint8Array(0);
  let iteration = 0;

  while (iteration < READ_LOOP_LIMIT) {
    console.log(TAG, "Reading attempt:", iteration);
    const { done, value } = await reader.read();
    console.log(
      TAG,
      "Read result - done:",
      done,
      "value length:",
      value?.length
    );

    if (done) break;

    buffer = joinChunks(buffer, value);

    if (value && isResponseFinished(buffer)) {
      console.log(TAG, "Complete response received");
      break;
    }

    iteration++;
  }

  return buffer;
}

function parseHttpResponse(rawText) {
  const splitIdx = rawText.indexOf(HEADER_TERMINATOR);
  if (splitIdx === -1) {
    console.log(TAG, "Full response data:", rawText);
    throw new Error("Invalid HTTP response - no header end found");
  }

  const headerBlock = rawText.substring(0, splitIdx);
  const bodyBlock = rawText.substring(splitIdx + 4);

  const lines = headerBlock.split("\r\n");
  const statusLine = lines[0];
  const statusMatch = statusLine.match(/HTTP\/[\d.]+ (\d+)/);
  const status = statusMatch ? parseInt(statusMatch[1]) : 200;

  const headerMap = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const colonAt = line.indexOf(":");
    if (colonAt <= 0) continue;
    const key = line.substring(0, colonAt).trim().toLowerCase();
    const val = line.substring(colonAt + 1).trim();
    headerMap[key] = val;
  }

  return { status, headers: headerMap, body: bodyBlock };
}

// Public entry: raw-socket variant of the JSON forwarder.
export async function handleForwardRaw(request) {
  try {
    const { targetUrl, headers = {}, body } = await request.json();

    if (!targetUrl) {
      return jsonReply({ error: "targetUrl is required" }, 400);
    }

    const target = new URL(targetUrl);
    const tlsRequired = target.protocol === "https:";
    const host = target.hostname;
    const port = target.port || (tlsRequired ? 443 : 80);
    const path = target.pathname + target.search;

    console.log(TAG, "Connecting to:", host, port, tlsRequired ? "(TLS)" : "");

    const sock = openSocket(host, port, tlsRequired);
    console.log(TAG, "Socket object:", sock);
    console.log(TAG, "Socket opened:", sock.opened);

    try {
      console.log(TAG, "Waiting for socket to open...");
      await sock.opened;
      console.log(TAG, "Socket opened successfully");
    } catch (openErr) {
      console.error(TAG, "Socket open error:", openErr.message);
      throw openErr;
    }

    console.log(TAG, "Getting writer and reader...");
    const writer = sock.writable.getWriter();
    const reader = sock.readable.getReader();
    console.log(TAG, "Writer and reader obtained");

    const bodyStr = JSON.stringify(body);
    const outboundHeaders = {
      Host: host,
      "Content-Type": "application/json",
      "Content-Length": encoder.encode(bodyStr).length.toString(),
      Connection: "close",
      ...headers,
    };

    const wire = buildHttpRequestString(path, outboundHeaders, bodyStr);
    console.log(TAG, "Sending request:", wire.substring(0, 300));
    console.log(TAG, "Full request length:", wire.length);

    try {
      console.log(TAG, "Writing to socket...");
      await writer.write(encoder.encode(wire));
      console.log(TAG, "Write complete, closing writer...");
      await writer.close();
      console.log(TAG, "Writer closed");
    } catch (writeErr) {
      console.error(TAG, "Write error:", writeErr.message);
      throw writeErr;
    }

    console.log(TAG, "Starting to read response...");
    const responseBytes = await drainSocket(reader);
    console.log(TAG, "Read loop finished, total bytes:", responseBytes.length);

    const responseText = decoder.decode(responseBytes);
    console.log(TAG, "Response received:", responseText.substring(0, 500));

    const parsed = parseHttpResponse(responseText);

    return new Response(parsed.body, {
      status: parsed.status,
      headers: {
        "Content-Type": parsed.headers["content-type"] || "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (err) {
    console.error(TAG, "Error:", err.message, err.stack);
    return jsonReply({ error: err.message }, 500);
  }
}
