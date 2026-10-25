# Tham chiếu: LLM (`@vuihoc/bot-core/llm`)

Cách chuẩn để mọi bot nói chuyện với LLM. Mặc định nhà cung cấp là MiniMax, qua endpoint tương thích Anthropic Messages hoặc OpenAI Chat. Client chỉ dùng `fetch` (không SDK), nên chạy giống nhau trên Bun, trong test và sau proxy cục bộ.

Chữ ký hàm, kiểu và tham số: xem [API (TypeDoc)](/reference/api/) (subpath `llm`). Trang này tả hành vi và quy ước mà chữ ký không nói được. Cách dùng từng bước: [Gọi LLM trong handler hậu cần](/how-to/call-llm).

## Thành phần

| Thành phần | Việc |
|---|---|
| `createLlm` | Dựng client `{ complete }` từ `baseUrl`, `apiKey`, `model`, `api`, `timeoutMs`, `maxRetries`, `fetch`. |
| `runToolLoop`, `defineLlmTool` | Vòng lặp tool: model gọi tool, bot chạy, kết quả quay về model, lặp tới khi có câu trả lời. |
| `extract` | Trích trường có cấu trúc (zod) từ văn bản tự do, có sửa JSON và một lần hỏi lại. |
| `runAgentLoop`, `requireLlm`, `toRunUsage` | Dùng trong handler hậu cần: `ctx.llm` + `ctx.signal` + trace lên itsaplan. |
| `createLlmTracer` | Biến bước của vòng lặp tool thành sự kiện AG-UI (dùng bởi `runAgentLoop`). |
| `UsageMeter`, `estimateCost` | Cộng token theo model và ước tính chi phí. |
| `llmEnv`, `llmFromConfig` | Cấu hình từ biến môi trường. |
| `FakeLlm` (`@vuihoc/bot-core/testing`) | LLM giả trên HTTP thật, nói cả hai kiểu API, để test. |

Chưa có `stream` (phát từng đoạn). Hậu cần xử lý một run trọn vẹn rồi mới trả lời nên chưa cần; xem mục "Chưa làm".

## Hai kiểu API và base URL

Base URL và key luôn do config đưa vào; thư viện không có giá trị mặc định nào. Quy ước base URL giữ đúng cách repo đang dùng cho gateway (`providerBaseUrl` trong `tools/tl2-shadow`):

| `api` | Client gọi | `baseUrl` ví dụ | Header xác thực |
|---|---|---|---|
| `anthropic-messages` | `POST {baseUrl}/v1/messages` | `http://127.0.0.1:18999` (base đã có `/v1` cũng được) | `x-api-key`, `anthropic-version: 2023-06-01` |
| `openai-chat` | `POST {baseUrl}/chat/completions` | `http://127.0.0.1:18999/v1` (phải có `/v1`) | `authorization: Bearer` |

Môi trường dev đi qua proxy giữ secret chạy cục bộ (`tools/tl2-shadow/proxy.ts`, xem [Chạy bóng Tiểu Linh 2](/how-to/shadow-tl2)). Proxy chỉ cho `POST /v1/messages` và `POST /v1/chat/completions`, thân JSON có `model` nằm trong allowlist, chỉ chuyển tiếp các header `content-type`, `accept`, `anthropic-version`, `anthropic-beta` rồi tự gắn khoá thật. Client chỉ phụ thuộc đúng những thứ đó, và test (`client.test.ts`) khẳng định điều này. `apiKey` khi đi qua proxy chỉ là chuỗi giả; client vẫn gửi nó và proxy thay đi.

Hình dạng request/response là trung lập: `system` rời khỏi `messages`; vai `tool` mang kết quả tool; `tools` dùng JSON Schema (sinh từ zod); `usage` là `inputTokens`/`outputTokens`/`totalTokens`; `stopReason` là một trong `end`, `tool_use`, `max_tokens`, `content_filter`, `other`.

Khối suy luận của model (`thinking` của Anthropic, `<think>…</think>` trong content kiểu OpenAI) không vào `text`. Nó được giữ trong `message.raw` và gửi lại nguyên văn ở lượt sau, vì MiniMax yêu cầu trả lại phần suy luận trong hội thoại nhiều lượt có tool. Đừng sửa `message.raw`; cứ nối `response.message` vào `messages`.

## Thử lại và lỗi

Thử lại **chỉ** với: HTTP 429, 5xx, lỗi mạng, và hết `timeoutMs` của một lần gọi. Mọi 4xx khác (400, 401, 403, 404) là lỗi của ta, thử lại vô ích. Backoff luỹ thừa có jitter (nền 500 ms, trần 8 s); `Retry-After` của server được tôn trọng với trần 30 s. Huỷ bằng `signal` dừng ngay (kể cả đang chờ backoff) và không bao giờ thử lại.

| Lỗi | Khi nào | `retryable` |
|---|---|---|
| `LlmApiError` | Server trả HTTP lỗi (sau khi hết lần thử lại nếu là lỗi tạm thời). Có `status`, `body` (đã cắt, đã che key), `retryAfterMs`, `attempts`. | 429 và 5xx |
| `LlmNetworkError` | Không tới được server. | có |
| `LlmTimeoutError` | Một lần gọi quá `timeoutMs` (mặc định 60 s). | có |
| `LlmAbortError` | `signal` bị huỷ. | không |
| `LlmResponseError` | 2xx nhưng thân sai hình dạng hoặc không phải JSON. | không |
| `LlmConfigError` | Cấu hình sai, hoặc handler cần LLM mà bot chưa cấu hình. | không |
| `LlmExtractError` | `extract` hết lần thử. Có `issues`, `lastText`. | không |

Mọi lỗi kế thừa `LlmError` có `retryable` và `transient` (cùng nghĩa; `transient` là tên mà `isTransientError` của `@vuihoc/bot-core/itsaplan` nhận ra). Hệ quả: handler hậu cần để lỗi LLM tạm thời (429/5xx/mạng) bay ra ngoài thì run được nhả lease để itsaplan giao lại, còn lỗi vĩnh viễn thì run đóng `failed`.

**Key không bao giờ nằm trong thông điệp lỗi, log hay header của lỗi.** Thông điệp được che theo giá trị key (kể cả khi server nhại lại key trong thân lỗi) và chỉ chứa phần đầu của thân phản hồi lỗi. Thông điệp và thân lỗi vẫn có thể chứa nội dung nhạy cảm của người dùng nếu nhà cung cấp trích lại: đừng đẩy nguyên `LlmApiError.body` lên chỗ công khai.

## Vòng lặp tool

- Tham số tool được kiểm bằng zod **trước** khi `run` chạy. Sai thì model nhận một tin nhắn lỗi (tiếng Anh) nêu từng trường sai, ví dụ `Invalid arguments for tool "add": a: Invalid input: expected number, received string. Fix the arguments and call the tool again.`, và được thử lại ở bước kế; tool không bao giờ chạy với tham số sai. JSON tham số hỏng (kiểu OpenAI trả chuỗi) và tool không tồn tại cũng đi đường này.
- Tool ném lỗi thì `Tool "x" failed: <thông điệp>` quay về model; thông điệp lỗi đó tới model, nên đừng đưa secret vào lỗi.
- Các lời gọi tool trong cùng một bước chạy tuần tự theo thứ tự model đưa ra.
- Trần: `maxSteps` (mặc định 8 lần gọi model), `maxTotalTokens` (tổng vào + ra của cả vòng, kiểm trước mỗi lần gọi và sau mỗi bước), `maxToolResultChars` (mặc định 16 000, phần dư bị cắt kèm ghi chú). Chạm trần **không ném**: đọc `finishReason` (`end`, `max_steps`, `budget`, `max_tokens`).
- `signal` huỷ thì ném `LlmAbortError`, cả khi đang gọi model lẫn giữa các tool (`ToolRunContext.signal` để truyền cho `fetch` trong tool).

## Trích dữ liệu có cấu trúc

`extract` đưa JSON Schema (từ zod) và chỉ dẫn vào system prompt, coi `input` là dữ liệu (gói trong `<input>…</input>`, model được dặn không làm theo chỉ dẫn nằm trong đó), nhiệt độ mặc định 0. Trước khi kiểm schema, `parseJsonLoose` bóc code fence, bỏ lời dẫn, tách đoạn `{…}` cân bằng, sửa dấu phẩy thừa và nháy cong. Nếu vẫn không phải JSON hoặc không khớp schema, hỏi lại **đúng một lần** (`retries`, mặc định 1) kèm danh sách lỗi cụ thể; hỏng nữa thì ném `LlmExtractError`. `ExtractResult.repaired` cho biết có phải sửa hoặc hỏi lại hay không.

## Cấu hình từ biến môi trường

`createBot` tự đọc các biến sau (không cần khai trong `env` của bot) và đưa client tới handler qua `ctx.llm`. Đặt **đủ** `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` hoặc **không đặt biến nào**: đặt một phần thì `createBot` ném `ConfigError` nêu biến còn thiếu (không có giá trị). Không đặt biến nào thì `ctx.llm` là `undefined` và bot chạy bình thường. Bảng biến đầy đủ ở [Cấu hình và biến môi trường](/reference/config-env#llm-cua-bot-kit).

Bot bắt buộc phải có LLM thì gộp `llmEnv({ required: true })` vào `defineEnv` của nó: thiếu biến là không khởi động được. Không bot kit (script, MCP) thì `loadConfig(llmEnv(), …)` rồi `llmFromConfig(values)`.

`createBot(def, { llm })` ghi đè cho test và host tự quản: `llm: false` tắt hẳn, `llm: { client }` dùng client dựng sẵn, `llm: { onUsage }` nhận từng lời gọi thành công (token, model, thời gian, số lần gọi HTTP). Mỗi lời gọi cũng được ghi một dòng `debug` vào log của bot.

`ctx.llm` trong handler là client của bot được gắn `signal` của run: run mất lease, quá hạn hoặc bot tắt cưỡng bức thì lời gọi LLM đang chạy bị huỷ theo.

## Trace lên itsaplan

`runAgentLoop(ctx, …)` ghi trace qua `ctx.trace` (tức `AgentRunsClient.appendEvents`, xem [agent-runs](/reference/agent-runs)). Mỗi bước thành các sự kiện AG-UI:

| Điều xảy ra | Sự kiện |
|---|---|
| Model nói gì đó trước/giữa các tool | `TEXT_MESSAGE_START`, `TEXT_MESSAGE_CONTENT`, `TEXT_MESSAGE_END` |
| Model gọi tool, kết quả | `TOOL_CALL_START` (tên tool), `TOOL_CALL_ARGS` (JSON tham số), `TOOL_CALL_END`, `TOOL_CALL_RESULT` (kết quả, hoặc `LỖI: …`) |
| Kết thúc vòng lặp | một đoạn văn bản tổng kết: số bước, lý do dừng, token vào/ra, chi phí ước tính nếu có `pricing` |

`RUN_STARTED`/`RUN_FINISHED` do worker phát. Giới hạn (server giữ tối đa 2000 sự kiện hoặc 1 MB mỗi lần thử; delta <= 12 000 ký tự; tham số/kết quả <= 32 000 ký tự): adapter cắt mỗi đoạn về `maxChars` (mặc định 4000) kèm dấu cắt, và ngừng phát khi đã phát `maxEvents` (mặc định 1500) để chừa chỗ. `offset` và việc tách lô <= 200 do `RunTrace` giữ. Lỗi trace không bao giờ làm hỏng run: `RunTrace` tắt chính nó ở lỗi đầu tiên, handler vẫn chạy tiếp. Id tool và message có tiền tố ngẫu nhiên theo từng tracer nên hai vòng lặp trong cùng một run không đụng id.

## Token và chi phí

`LlmResponse.usage` và `ToolLoopResult.usage` (tổng của vòng lặp) là số token do server báo. `toRunUsage(result.usage)` đổi thành `usage` để trả trong kết quả run (hiện trên lịch sử run ở itsaplan). Đơn giá không viết cứng (giá đổi theo nhà cung cấp): bot khai `LlmPricing` rồi dùng `estimateCost` hoặc `UsageMeter.cost`.

## Test

`FakeLlm` (`@vuihoc/bot-core/testing`) là server HTTP thật trên cổng ngẫu nhiên, nói `POST /v1/messages` và `POST /v1/chat/completions`, trả lời theo kịch bản (`script`) hoặc theo hàm (`respond`), ghi lại mọi request, và mô phỏng lỗi HTTP, `Retry-After`, chậm (`delayMs`), JSON tham số hỏng, khối suy luận. Test không bao giờ gọi API thật.

```ts run
import assert from "node:assert/strict";
import { z } from "zod";
import { createLlm, defineLlmTool, runToolLoop } from "@vuihoc/bot-core/llm";
import { FakeLlm } from "@vuihoc/bot-core/testing";

const fake = new FakeLlm();
fake.start();
try {
  fake.script(
    { toolCalls: [{ name: "add", args: { a: 2, b: 3 }, id: "call_1" }] },
    { text: "Tổng là 5" },
  );
  const llm = createLlm({
    baseUrl: fake.baseUrl("openai-chat"), // openai-chat: base có /v1
    apiKey: "khoa-gia",
    model: "MiniMax-M3.1-Flash",
    api: "openai-chat",
  });
  const add = defineLlmTool({
    name: "add",
    description: "Cộng hai số",
    schema: z.object({ a: z.number(), b: z.number() }),
    run: ({ a, b }) => a + b,
  });
  const result = await runToolLoop({
    llm,
    messages: [{ role: "user", content: "2 + 3 bằng mấy?" }],
    tools: [add],
  });
  assert.equal(result.text, "Tổng là 5");
  assert.equal(result.finishReason, "end");
  assert.equal(result.steps[0]?.executions[0]?.content, "5");
} finally {
  await fake.stop();
}
```

## Chưa làm

- `stream` (phát từng đoạn, SSE) cho cả hai kiểu API.
- Gọi tool song song trong một bước.
- Tự đổi sang model dự phòng khi model chính lỗi (app Tiểu Linh có cơ chế danh sách model; bot-core chưa chuyển nó vào).
- `llmExtractor()` cho lễ tân (milestone 2 của [RFC 0001](/rfc/0001-bot-kit)) sẽ dựng trên `extract`.
