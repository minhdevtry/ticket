import { afterEach, describe, expect, it } from "bun:test";
import { LlmSimilarTickets } from "./similar-ticket-source";
import type { CorpusTicket } from "./similar-finder";

/**
 * Server proxy LLM giả (cùng cách worker/llm.test.ts đang làm — Bun.serve thật,
 * không mock fetch). `responder` đọc user prompt để quyết định trả lời theo
 * TỪNG ứng viên (chuỗi "TICKET ỨNG VIÊN <id>") hoặc câu hỏi phân biệt (chuỗi
 * "CÁC THẺ NGUYÊN NHÂN"), cho phép kịch bản khác nhau mỗi ticket trong 1 lần gọi find().
 */
function makeLlmServer(responder: (userPrompt: string) => Record<string, unknown>, delayMs = 0) {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const body = (await req.json()) as { messages: Array<{ role: string; content: string }> };
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      const userPrompt = body.messages[1]?.content ?? "";
      const content = JSON.stringify(responder(userPrompt));
      return Response.json({ choices: [{ message: { content } }] });
    },
  });
  return { server, baseUrl: `http://127.0.0.1:${server.port}` };
}

const memgraphOf = (corpus: CorpusTicket[]) => ({ loadSimilarityCorpus: async () => corpus });

describe("LlmSimilarTickets.find", () => {
  let server: ReturnType<typeof Bun.serve> | undefined;
  afterEach(() => {
    server?.stop(true);
    server = undefined;
  });

  it("chốt chặn quote-match: chấp nhận dù LLM chỉ báo confidence thấp, không cần cụm ≥ 2", async () => {
    const corpus: CorpusTicket[] = [
      { identifier: "TECH-1", title: "Lỗi thanh toán", symptomsText: 'Hệ thống báo "Không thể xử lý giao dịch do trùng mã đơn hàng"' },
    ];
    const { server: s, baseUrl } = makeLlmServer(() => ({ same_root_cause: true, confidence: "low" }));
    server = s;
    const src = new LlmSimilarTickets({
      memgraph: memgraphOf(corpus),
      llm: { baseUrl, apiKey: "", model: "m" },
      projectKey: "TECH",
    });
    const match = await src.find('Khách báo "Không thể xử lý giao dịch do trùng mã đơn hàng ABC123"');
    expect(match?.members.map((m) => m.identifier)).toEqual(["TECH-1"]);
  });

  it("chốt chặn quote-conflict: từ chối dù LLM báo same_root_cause=true, confidence high", async () => {
    const corpus: CorpusTicket[] = [
      { identifier: "TECH-1", title: "Lỗi khác", symptomsText: 'Hệ thống báo "Số dư tài khoản không đủ để thực hiện giao dịch"' },
    ];
    const { server: s, baseUrl } = makeLlmServer(() => ({ same_root_cause: true, confidence: "high" }));
    server = s;
    const src = new LlmSimilarTickets({
      memgraph: memgraphOf(corpus),
      llm: { baseUrl, apiKey: "", model: "m" },
      projectKey: "TECH",
    });
    const match = await src.find('Khách báo "Không thể xử lý giao dịch do trùng mã đơn hàng ABC123"');
    expect(match).toBeNull();
  });

  it("không có quote để đối chiếu: cần LLM 'high' VÀ cụm ứng viên đã ≥ 2 thành viên", async () => {
    const corpus: CorpusTicket[] = [
      { identifier: "TECH-1", title: "Đồng bộ lớp lỗi", symptomsText: "Không đồng bộ được lớp học", causeCluster: "A", humanCause: "Lỗi sync cache", humanFix: "Xoá cache app" },
      { identifier: "TECH-2", title: "Đồng bộ lỗi lần 2", symptomsText: "Lớp học không đồng bộ", causeCluster: "A" },
      { identifier: "TECH-3", title: "Sai học phí", symptomsText: "Học phí tính sai sau đổi gói", causeCluster: "B", humanCause: "Đổi gói tính sai học phí", humanFix: "Tính lại thủ công" },
    ];
    const { server: s, baseUrl } = makeLlmServer(() => ({ same_root_cause: true, confidence: "high" }));
    server = s;
    const src = new LlmSimilarTickets({
      memgraph: memgraphOf(corpus),
      llm: { baseUrl, apiKey: "", model: "m" },
      projectKey: "TECH",
    });
    // Chỉ hỏi về TECH-1 (cụm A, có 2 thành viên) — BM25 sẽ không xếp TECH-3 lên vì không khớp chữ.
    const match = await src.find("không đồng bộ được lớp học");
    expect(match?.clusterId).toBe("A");
    expect(match?.members.map((m) => m.identifier).sort()).toEqual(["TECH-1", "TECH-2"]);
    expect(match?.advice).toEqual({ cause: "Lỗi sync cache", fix: "Xoá cache app", from: "TECH-1" });
  });

  it("cụm ứng viên đơn lẻ (không ai khác cùng cụm) dù LLM báo 'high' → không đủ căn cứ, không gợi ý", async () => {
    const corpus: CorpusTicket[] = [
      { identifier: "TECH-9", title: "Sự cố lẻ", symptomsText: "Sự cố abc không rõ nguyên nhân", causeCluster: "Z" },
    ];
    const { server: s, baseUrl } = makeLlmServer(() => ({ same_root_cause: true, confidence: "high" }));
    server = s;
    const src = new LlmSimilarTickets({
      memgraph: memgraphOf(corpus),
      llm: { baseUrl, apiKey: "", model: "m" },
      projectKey: "TECH",
    });
    expect(await src.find("sự cố abc không rõ nguyên nhân")).toBeNull();
  });

  it("giãn cụm KG trừ negatives: thành viên bị REJECTED_RELATION với ứng viên chấp nhận không được kéo ra", async () => {
    const corpus: CorpusTicket[] = [
      { identifier: "TECH-1", title: "Đăng nhập lỗi", symptomsText: "App treo khi đăng nhập lần đầu", causeCluster: "C", humanCause: "Token hết hạn", humanFix: "Đăng xuất, đăng nhập lại", negatives: ["TECH-2"] },
      { identifier: "TECH-2", title: "Đăng nhập lỗi khác", symptomsText: "Đăng nhập app bị văng liên tục", causeCluster: "C" },
      { identifier: "TECH-3", title: "Đăng nhập lỗi lần 3", symptomsText: "App đăng nhập lỗi treo màn hình", causeCluster: "C" },
    ];
    const { server: s, baseUrl } = makeLlmServer((prompt) => ({
      same_root_cause: prompt.includes("TECH-1") || prompt.includes("TECH-3"),
      confidence: "high",
    }));
    server = s;
    const src = new LlmSimilarTickets({
      memgraph: memgraphOf(corpus),
      llm: { baseUrl, apiKey: "", model: "m" },
      projectKey: "TECH",
    });
    const match = await src.find("app treo khi đăng nhập");
    expect(match?.members.map((m) => m.identifier).sort()).toEqual(["TECH-1", "TECH-3"]);
  });

  it("ứng viên chấp nhận rơi vào ≥ 2 cụm khác nhau → không ghi gì, có câu hỏi phân biệt", async () => {
    const corpus: CorpusTicket[] = [
      { identifier: "TECH-1", title: "Trùng tài khoản A", symptomsText: "Trùng tài khoản do 2 hồ sơ cùng tên", causeCluster: "A", humanCause: "Cùng tên nên trùng hồ sơ", humanFix: "Gỡ 1 hồ sơ trùng" },
      { identifier: "TECH-2", title: "Trùng tài khoản A2", symptomsText: "Trùng tài khoản do 2 hồ sơ cùng tên khác", causeCluster: "A" },
      { identifier: "TECH-3", title: "Trùng tài khoản B", symptomsText: "Trùng tài khoản do book test chưa có tk", causeCluster: "B", humanCause: "Book test tạo tk trùng", humanFix: "Xoá tk test" },
      { identifier: "TECH-4", title: "Trùng tài khoản B2", symptomsText: "Trùng tài khoản khi book test lần 2", causeCluster: "B" },
    ];
    const { server: s, baseUrl } = makeLlmServer((prompt) => {
      if (prompt.includes("CÁC THẺ NGUYÊN NHÂN")) return { question: "Anh/chị kiểm tra CRM xem hồ sơ có phải do book test hay trùng tên nhé." };
      return { same_root_cause: true, confidence: "high" };
    });
    server = s;
    const src = new LlmSimilarTickets({
      memgraph: memgraphOf(corpus),
      llm: { baseUrl, apiKey: "", model: "m" },
      projectKey: "TECH",
      maxCandidates: 4,
    });
    const match = await src.find("trùng tài khoản không rõ vì sao");
    expect(match?.members).toEqual([]);
    expect(match?.question).toContain("CRM");
  });

  it("hết giờ (timeout) xác minh → không gợi ý, không trả kết quả nửa vời", async () => {
    const corpus: CorpusTicket[] = [{ identifier: "TECH-1", title: "Lỗi chậm", symptomsText: "Sự cố lỗi chậm chạp" }];
    const { server: s, baseUrl } = makeLlmServer(() => ({ same_root_cause: true, confidence: "high" }), 200);
    server = s;
    const src = new LlmSimilarTickets({
      memgraph: memgraphOf(corpus),
      llm: { baseUrl, apiKey: "", model: "m" },
      projectKey: "TECH",
      timeoutMs: 20,
    });
    expect(await src.find("sự cố lỗi chậm chạp")).toBeNull();
  });

  // ── TECH-956 (28/09/2026): trước đây "không có gì chắc chắn" == "không trả
  // về gì cả" — LLM đã nói same_root_cause=true (medium) cho TECH-712 (cụm
  // TECH-337) nhưng vì chưa đạt ngưỡng ghi (confidence chưa "high") nên bị bỏ
  // HOÀN TOÀN, dù Onyx/BM25 tìm ra nhiều ticket "trùng tài khoản" thuộc các cụm
  // khác nhau. Vá: hiển thị (không ghi) cụm "chưa chắc" + một câu hỏi phân biệt,
  // dùng cụm ứng viên phổ biến khác trong danh sách truy hồi để có thẻ đối chiếu.
  it("một ứng viên same_root_cause=true nhưng confidence medium → hiển thị 'có thể liên quan', không ghi link (TECH-956)", async () => {
    const corpus: CorpusTicket[] = [
      {
        identifier: "TECH-712",
        title: "Trùng tài khoản do 2 con cùng SĐT",
        symptomsText: "Không tạo được đơn hàng do trùng tài khoản, 2 con dùng chung số điện thoại",
        causeCluster: "TECH-337",
        humanCause: "Hai hồ sơ học sinh gắn cùng một SĐT nên hệ thống coi là trùng tài khoản",
        humanFix: "Tách hồ sơ, gắn lại đúng SĐT từng con",
      },
      {
        identifier: "TECH-480",
        title: "Trùng tài khoản khi book lịch test",
        symptomsText: "Trùng tài khoản học do book lịch test tạo tài khoản mới",
        causeCluster: "TECH-480",
        humanCause: "Book lịch test tạo tài khoản trùng",
        humanFix: "Xoá tài khoản test trùng",
      },
      {
        identifier: "TECH-369",
        title: "Trùng tài khoản qua App đăng ký",
        symptomsText: "Trùng tài khoản do học sinh đăng ký qua App, đối tượng liên hệ là con",
        causeCluster: "TECH-369",
      },
    ];
    const { server: s, baseUrl } = makeLlmServer((prompt) => {
      if (prompt.includes("CÁC THẺ NGUYÊN NHÂN")) return { question: "Anh/chị kiểm tra CRM xem 2 tài khoản có chung SĐT không nhé." };
      return { same_root_cause: prompt.includes("TECH-712"), confidence: "medium" };
    });
    server = s;
    const src = new LlmSimilarTickets({
      memgraph: memgraphOf(corpus),
      llm: { baseUrl, apiKey: "", model: "m" },
      projectKey: "TECH",
    });
    const match = await src.find("Không tạo được đơn hàng do trùng tài khoản, 2 con cùng 1 SĐT");

    expect(match).not.toBeNull();
    expect(match?.members).toEqual([]);
    expect(match?.possible?.length).toBe(1);
    expect(match?.possible?.[0].clusterId).toBe("TECH-337");
    expect(match?.possible?.[0].sampleIds).toContain("TECH-712");
    expect(match?.question).toContain("CRM");
  });

  it("không ứng viên nào same_root_cause=true → không gợi ý gì (không possible, không question)", async () => {
    const corpus: CorpusTicket[] = [
      { identifier: "TECH-1", title: "Lỗi không liên quan", symptomsText: "Sự cố hoàn toàn khác không ăn nhập" },
    ];
    const { server: s, baseUrl } = makeLlmServer(() => ({ same_root_cause: false, confidence: "low" }));
    server = s;
    const src = new LlmSimilarTickets({
      memgraph: memgraphOf(corpus),
      llm: { baseUrl, apiKey: "", model: "m" },
      projectKey: "TECH",
    });
    const match = await src.find("sự cố hoàn toàn khác không ăn nhập");
    expect(match).toBeNull();
  });

  it("Memgraph lỗi hoặc kho rỗng → không chặn, trả null", async () => {
    const src = new LlmSimilarTickets({
      memgraph: {
        loadSimilarityCorpus: async () => {
          throw new Error("Memgraph down");
        },
      },
      llm: { baseUrl: "http://127.0.0.1:1", apiKey: "", model: "m" },
      projectKey: "TECH",
    });
    expect(await src.find("bất kỳ")).toBeNull();
  });
  it("nhánh high phải ổn định: kiểm lại lật sang false → KHÔNG ghi, hạ xuống 'chưa chắc' (TECH-956 28/09)", async () => {
    const corpus: CorpusTicket[] = [
      { identifier: "TECH-1", title: "Trùng tài khoản học", symptomsText: "Không tạo được đơn do trùng tài khoản", causeCluster: "A", humanCause: "Gắn trùng tk học do cùng tên" },
      { identifier: "TECH-2", title: "Trùng tài khoản học", symptomsText: "Không tạo được đơn do trùng tài khoản", causeCluster: "A", humanCause: "Gắn trùng tk học do cùng tên" },
    ];
    const { server: s, baseUrl } = makeLlmServer((p) =>
      p.includes("Kiểm tra độc lập lần") ? { same_root_cause: false, confidence: "low" } : { same_root_cause: true, confidence: "high" },
    );
    server = s;
    const src = new LlmSimilarTickets({ memgraph: memgraphOf(corpus), llm: { baseUrl, apiKey: "", model: "m" }, projectKey: "TECH" });
    const match = await src.find("Không tạo được đơn hàng do trùng tài khoản");
    expect(match?.members ?? []).toEqual([]);
  });

  it("nhánh high ổn định 3/3 → ghi cả cụm như cũ", async () => {
    const corpus: CorpusTicket[] = [
      { identifier: "TECH-1", title: "Trùng tài khoản học", symptomsText: "Không tạo được đơn do trùng tài khoản", causeCluster: "A", humanCause: "Gắn trùng tk học do cùng tên" },
      { identifier: "TECH-2", title: "Trùng tài khoản học", symptomsText: "Không tạo được đơn do trùng tài khoản", causeCluster: "A", humanCause: "Gắn trùng tk học do cùng tên" },
    ];
    const { server: s, baseUrl } = makeLlmServer(() => ({ same_root_cause: true, confidence: "high" }));
    server = s;
    const src = new LlmSimilarTickets({ memgraph: memgraphOf(corpus), llm: { baseUrl, apiKey: "", model: "m" }, projectKey: "TECH" });
    const match = await src.find("Không tạo được đơn hàng do trùng tài khoản");
    expect(match?.members.map((m) => m.identifier).sort()).toEqual(["TECH-1", "TECH-2"]);
  });
  it("quote-match nhận cả khi LLM nói khác nguyên nhân (TECH-958: cùng câu lỗi PCM, khác môn)", async () => {
    const corpus: CorpusTicket[] = [
      { identifier: "TECH-864", title: "Không chuyển được phí", symptomsText: 'Báo lỗi "Không tìm thấy gói chuyển phí bên PCM"', causeCluster: "P", humanCause: 'Lỗi "Không tìm thấy gói chuyển phí bên PCM"' },
      { identifier: "TECH-859", title: "Không chuyển nhượng được", symptomsText: 'Báo lỗi "Không tìm thấy gói chuyển phí bên PCM"', causeCluster: "P", humanCause: 'Lỗi "Không tìm thấy gói chuyển phí bên PCM"' },
    ];
    const { server: s, baseUrl } = makeLlmServer(() => ({ same_root_cause: false, confidence: "medium" }));
    server = s;
    const src = new LlmSimilarTickets({ memgraph: memgraphOf(corpus), llm: { baseUrl, apiKey: "", model: "m" }, projectKey: "TECH" });
    const match = await src.find('HS không chuyển được phí môn Sinh, báo lỗi "Không tìm thấy gói chuyển phí bên PCM"');
    expect(match?.members.map((m) => m.identifier).sort()).toEqual(["TECH-859", "TECH-864"]);
  });
});
