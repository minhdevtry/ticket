import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitepress";

const here = dirname(fileURLToPath(import.meta.url));

/** Sidebar của API do TypeDoc sinh khi build (không commit). Chưa sinh thì để trống. */
function apiSidebar(): unknown[] {
  const file = join(here, "..", "reference", "api", "typedoc-sidebar.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
}

export default defineConfig({
  lang: "vi-VN",
  title: "VuiHoc Ticket Bots",
  description: "Tài liệu cho thư viện @vuihoc/bot-core và các bot xây trên nó.",
  base: "/ticket/",
  cleanUrls: true,
  lastUpdated: false,
  // Cố ý KHÔNG đặt ignoreDeadLinks: link chết làm hỏng build.
  themeConfig: {
    nav: [
      { text: "Hướng dẫn", link: "/guide/", activeMatch: "^/guide/" },
      { text: "Cách làm", link: "/how-to/", activeMatch: "^/how-to/" },
      { text: "Tra cứu", link: "/reference/", activeMatch: "^/reference/" },
      { text: "Giải thích", link: "/explanation/", activeMatch: "^/explanation/" },
    ],
    sidebar: {
      "/guide/": [
        {
          text: "Hướng dẫn",
          items: [
            { text: "Giới thiệu", link: "/guide/" },
            { text: "Dựng bot đầu tiên", link: "/guide/first-bot" },
          ],
        },
      ],
      "/how-to/": [
        {
          text: "Cách làm",
          items: [
            { text: "Tổng quan", link: "/how-to/" },
            { text: "Viết catalog tiếp nhận", link: "/how-to/write-catalog" },
            { text: "Thêm kênh chat", link: "/how-to/add-channel" },
            { text: "Dựng worker báo ngược", link: "/how-to/notify-worker" },
            { text: "Dùng chung binding với Tiểu Linh 1", link: "/how-to/share-bindings-with-tl1" },
            { text: "Chạy shadow", link: "/how-to/run-shadow" },
            { text: "Chạy bóng Tiểu Linh 2", link: "/how-to/shadow-tl2" },
            { text: "Deploy và đẩy secret qua SSH", link: "/how-to/deploy" },
            { text: "Gọi LLM trong handler hậu cần", link: "/how-to/call-llm" },
            { text: "Lịch chạy và hẹn giờ", link: "/how-to/schedule-and-timers" },
            {
              text: "Kiểm hội thoại bằng kịch bản và bản ghi vàng",
              link: "/how-to/golden-scripts",
            },
            { text: "Chuyển project vào team", link: "/how-to/move-project-to-team" },
            { text: "Chuyển bot sang bot-core", link: "/how-to/adopt-core" },
            { text: "Chuyển Tiểu Linh sang bot-core", link: "/how-to/migrate-tieulinh" },
            { text: "Chạy Tiểu Linh 2 (hậu cần) với TECH2", link: "/how-to/run-tieulinh-hau-can" },
          ],
        },
      ],
      "/reference/api/": apiSidebar(),
      "/reference/": [
        {
          text: "Tra cứu",
          items: [
            { text: "Tổng quan", link: "/reference/" },
            { text: "Subpath và entry point", link: "/reference/entry-points" },
            { text: "Cấu hình và biến môi trường", link: "/reference/config-env" },
            { text: "Giao thức agent-runs", link: "/reference/agent-runs" },
            { text: "LLM (llm)", link: "/reference/llm" },
            { text: "Testing (testing)", link: "/reference/testing" },
            { text: "Sự kiện webhook itsaplan", link: "/reference/webhook-events" },
            { text: "Danh sách CopyKey", link: "/reference/copy-keys" },
            { text: "API (TypeDoc)", link: "/reference/api/" },
          ],
        },
      ],
      "/explanation/": [
        {
          text: "Giải thích",
          items: [
            { text: "Tổng quan", link: "/explanation/" },
            { text: "Kiến trúc: lễ tân và hậu cần", link: "/explanation/architecture" },
            { text: "Bot kit: defineBot và createBot", link: "/explanation/bot-kit" },
            { text: "Năm lớp của một bot", link: "/explanation/layers" },
            { text: "Bản legacy và bản mới của Tiểu Linh", link: "/explanation/tieulinh-legacy" },
            { text: "Tiểu Linh mới: hậu cần", link: "/explanation/tieulinh-hau-can" },
            { text: "Bảo mật repo công khai", link: "/explanation/public-repo-security" },
            { text: "Chỉ mục ADR", link: "/explanation/adr-index" },
          ],
        },
      ],
      "/rfc/": [
        {
          text: "RFC",
          items: [
            { text: "Tổng quan", link: "/rfc/" },
            { text: "0001 Bot kit", link: "/rfc/0001-bot-kit" },
            { text: "0002 Lễ tân", link: "/rfc/0002-receptionist" },
          ],
        },
      ],
      "/adr/": [
        {
          text: "ADR cấp repo",
          items: [
            { text: "Chỉ mục ADR", link: "/explanation/adr-index" },
            { text: "0001 Monorepo", link: "/adr/0001-monorepo" },
            { text: "0002 Repo công khai", link: "/adr/0002-public-repo" },
            { text: "0003 Secret qua SSH", link: "/adr/0003-secrets-over-ssh" },
            { text: "0004 Site docs do CI giữ", link: "/adr/0004-docs-site-enforced-by-ci" },
          ],
        },
      ],
    },
    socialLinks: [{ icon: "github", link: "https://github.com/minhdevtry/ticket" }],
    outline: { label: "Trong trang này", level: [2, 3] },
    docFooter: { prev: "Trang trước", next: "Trang sau" },
    returnToTopLabel: "Lên đầu trang",
    sidebarMenuLabel: "Menu",
    darkModeSwitchLabel: "Giao diện",
    search: { provider: "local" },
    editLink: {
      pattern: "https://github.com/minhdevtry/ticket/edit/main/docs/:path",
      text: "Sửa trang này trên GitHub",
    },
  },
});
