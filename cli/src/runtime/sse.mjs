export async function readSseEvents(body) {
  const events = [];
  for await (const event of iterateSseEvents(body)) {
    events.push(event);
  }
  return events;
}

export async function* iterateSseEvents(body) {
  let buffer = "";
  for await (const text of readDecodedChunks(body)) {
    buffer += text;
    for (;;) {
      const boundary = nextSseBoundary(buffer);
      if (!boundary) break;
      const chunk = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary.length);
      const item = parseSseChunk(chunk);
      if (item) yield item;
    }
  }
  const item = parseSseChunk(buffer);
  if (item) yield item;
}

async function* readDecodedChunks(body) {
  const decoder = new TextDecoder();

  if (typeof body.getReader === "function") {
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      yield decoder.decode(value, { stream: true });
    }
    const tail = decoder.decode();
    if (tail) yield tail;
    return;
  }

  for await (const chunk of body) {
    yield typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
  }
  const tail = decoder.decode();
  if (tail) yield tail;
}

function nextSseBoundary(buffer = "") {
  const match = /\r?\n\r?\n/.exec(buffer);
  return match ? { index: match.index, length: match[0].length } : undefined;
}

function parseSseChunk(chunk = "") {
  const lines = chunk.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return undefined;

  let eventType = "";
  const dataLines = [];
  for (const line of lines) {
    if (line.startsWith("event:")) {
      eventType = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }

  const dataText = dataLines.join("\n");
  if (!dataText || dataText === "[DONE]") return undefined;
  const data = JSON.parse(dataText);
  return {
    type: eventType || data.type,
    data,
  };
}
