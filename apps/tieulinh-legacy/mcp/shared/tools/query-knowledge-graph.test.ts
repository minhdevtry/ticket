import { describe, expect, it } from "bun:test";
import { queryKnowledgeGraph } from "./query-knowledge-graph";
import { isMemgraphReachable } from "../../../lib/kg/memgraph-test-support";

// Không có Memgraph (máy dev/CI) thì bỏ qua thay vì đỏ vì "Failed to connect".
const memgraphUp = await isMemgraphReachable();

describe.skipIf(!memgraphUp)("query_knowledge_graph MCP Tool", () => {
  const tool = queryKnowledgeGraph();

  it("thực hiện action graph_stats thành công", async () => {
    const res = (await tool.handler({ action: "graph_stats" })) as any;
    expect(res.action).toBe("graph_stats");
    expect(Array.isArray(res.labels)).toBe(true);
    expect(res.labels.length).toBeGreaterThan(0);
  });

  it("thực hiện action top_root_causes thành công", async () => {
    const res = (await tool.handler({ action: "top_root_causes", limit: 3 })) as any;
    expect(res.action).toBe("top_root_causes");
    expect(Array.isArray(res.causes)).toBe(true);
  });

  it("thực hiện action most_related thành công", async () => {
    const res = (await tool.handler({ action: "most_related", limit: 3 })) as any;
    expect(res.action).toBe("most_related");
    expect(Array.isArray(res.clusters)).toBe(true);
  });

  it("thực hiện action suggest_resolution không lỗi", async () => {
    const res = (await tool.handler({
      action: "suggest_resolution",
      system: "CRM_Vuihoc",
      keywords: ["trùng tài khoản"],
      limit: 2,
    })) as any;
    expect(res.action).toBe("suggest_resolution");
    expect(Array.isArray(res.suggestions)).toBe(true);
  });
});
