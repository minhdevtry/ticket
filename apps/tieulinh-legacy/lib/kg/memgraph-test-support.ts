import net from "node:net";

/**
 * Test chạm Memgraph thật chỉ có nghĩa khi có Memgraph để chạm. Máy dev/CI
 * không bật Memgraph thì cả loạt test đỏ vì "Failed to connect" — không phải
 * lỗi code, mà che mất lỗi thật. Thăm dò TCP một lần (≤1s) để test tự bỏ qua.
 *
 * Chỉ chạy trên instance thử riêng: `MEMGRAPH_TEST_URI=bolt://localhost:17687
 * bun test lib/kg` (test-preload.ts chép nó sang MEMGRAPH_URI và xoá MEMGRAPH_URI
 * của .env). Không đặt thì coi như không có Memgraph — không bao giờ tự thử
 * localhost:7687, vì đó là KG thật.
 */
export async function isMemgraphReachable(
  uri: string | undefined = process.env.MEMGRAPH_TEST_URI,
  timeoutMs = 1000,
): Promise<boolean> {
  if (!uri) return false;
  let host = "localhost";
  let port = 7687;
  try {
    const parsed = new URL(uri.replace(/^(bolt|neo4j)(\+s|\+ssc)?:/, "http:"));
    host = parsed.hostname || host;
    port = Number(parsed.port) || port;
  } catch {
    return false;
  }
  return new Promise<boolean>((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}
