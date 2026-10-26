/**
 * `@vuihoc/bot-core/testing`: công cụ test cho bot dùng thư viện. Itsaplan giả (`FakeItsaplan`) và
 * LLM giả (`FakeLlm`), cả hai chạy trên HTTP thật; `ScriptedChat` và bản ghi vàng để kiểm hội thoại
 * của engine tiếp nhận bằng kịch bản. Chỉ dùng trong test; không import từ code chạy thật.
 */
export * from "./fake-itsaplan";
export * from "../llm/fake-llm";
export * from "./manual-clock";
export * from "./scripted-chat";
export * from "./golden";
export * from "./extraction-cache";
