import assert from "node:assert/strict";
import { createHash } from "node:crypto";

// Bounded fixture transport for the SDK's opening Remote snapshot, not a general WS server.
export function attachFollowFixture(server, cookie, snapshot) {
  server.on("upgrade", (request, socket) => {
    assert.equal(request.url, "/api/remote.mux");
    assert.equal(request.headers.cookie, cookie);
    const accept = createHash("sha1").update(request.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buffer = Buffer.alloc(0);
    socket.on("error", () => {});
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        const opcode = buffer[0] & 15;
        let length = buffer[1] & 127;
        let offset = 2;
        assert.notEqual(length, 127, "fixture only accepts bounded frames");
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        }
        assert.ok(buffer[1] & 128, "client frames must be masked");
        if (buffer.length < offset + 4 + length) return;
        const mask = buffer.subarray(offset, offset + 4);
        const body = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
        for (let index = 0; index < body.length; index++) body[index] ^= mask[index % 4];
        buffer = buffer.subarray(offset + 4 + length);
        if (opcode === 8) { socket.end(Buffer.from([0x88, 0])); return; }
        assert.equal(opcode, 1);
        const frame = JSON.parse(body.toString());
        if (frame.type === "cancel") continue;
        assert.equal(frame.type, "open");
        assert.equal(frame.endpoint, "session/follow");
        const value = snapshot(frame.payload.args.request);
        const response = Buffer.from(JSON.stringify({ type: "item", streamId: frame.streamId, value }));
        assert.ok(response.length < 65536);
        const header = response.length < 126 ? Buffer.from([0x81, response.length]) : Buffer.from([0x81, 126, response.length >> 8, response.length & 255]);
        socket.write(Buffer.concat([header, response]));
      }
    });
  });
}
