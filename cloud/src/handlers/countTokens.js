import { errorResponse } from "open-sse/utils/error.js";

// Approximate character-to-token ratio used by the rough estimator below
const CHARS_PER_TOKEN = 4;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "*"
};

const RESPONSE_HEADERS = {
  "Content-Type": "application/json",
  ...CORS_HEADERS
};

// Sum up the character length contributed by a single message's content field.
// Supports the two shapes the Messages API accepts: a plain string or an array of typed parts.
function measureContentChars(content) {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;

  let chars = 0;
  for (const part of content) {
    if (part.type === "text" && part.text) {
      chars += part.text.length;
    }
  }
  return chars;
}

function tallyMessageChars(messages) {
  let total = 0;
  for (const msg of messages) {
    total += measureContentChars(msg.content);
  }
  return total;
}

// POST /{machineId}/v1/messages/count_tokens
// Returns a synthetic token count derived purely from total character length.
export async function handleCountTokens(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  const messages = payload.messages || [];
  const totalChars = tallyMessageChars(messages);
  const inputTokens = Math.ceil(totalChars / CHARS_PER_TOKEN);

  return new Response(
    JSON.stringify({ input_tokens: inputTokens }),
    { headers: RESPONSE_HEADERS }
  );
}
