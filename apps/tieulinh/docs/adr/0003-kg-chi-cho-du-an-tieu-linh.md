# Knowledge Graph chỉ bật cho dự án được liệt kê, không bật ngầm cho dự án khác

Chốt 23/09/2026. Worker chỉ nạp ticket hoàn tất vào KG khi có `MEMGRAPH_URI` **và** dự án của nó nằm trong `KG_SYNC_PROJECTS` (mặc định rỗng = tắt). Trước đây KG tự bật theo `MEMGRAPH_URI`, mà Bun tự nạp `apps/tieulinh/.env` nên các dự án khác nạp KG ngoài ý muốn. Bật tường minh theo dự án để tắt KG ở các dự án khác không phụ thuộc vào việc nhớ gỡ một biến môi trường.
