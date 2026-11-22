import { createServer } from "node:http";
import { createConnection } from "node:net";
import { parseMusicAudioUrl } from "./audio-http.js";

const port = Number(process.argv[2] ?? 33177);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("Invalid music relay port");
}

const qqApiHosts = new Set(["c.y.qq.com", "u.y.qq.com"]);
const server = createServer((_req, res) => res.writeHead(405).end());
server.on("connect", (req, client, head) => {
  const target = /^(?<host>[a-z0-9.-]+):(?<port>80|443)$/i.exec(req.url ?? "")?.groups;
  const host = target?.host.toLowerCase();
  if (!host || !(parseMusicAudioUrl(`https://${host}`) || (target?.port === "443" && qqApiHosts.has(host)))) {
    client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    return;
  }

  const upstream = createConnection({ host, port: Number(target?.port) });
  let connected = false;
  client.once("error", () => upstream.destroy());
  client.once("close", () => upstream.destroy());
  upstream.setTimeout(4_000, () => upstream.destroy(new Error("Music relay connect timeout")));
  upstream.once("error", () => {
    if (connected) client.destroy();
    else client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
  });
  upstream.once("connect", () => {
    connected = true;
    upstream.setTimeout(0);
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0) upstream.write(head);
    client.pipe(upstream).pipe(client);
  });
});
server.listen(port, "127.0.0.1", () => console.log(`Claudio music relay listening on 127.0.0.1:${port}`));
