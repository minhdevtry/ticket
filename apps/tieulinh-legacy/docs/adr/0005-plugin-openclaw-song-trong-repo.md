# Mọi plugin OpenClaw sống trong repo này

24/09/2026 một thư mục repo cũ (đã bỏ) bị xoá, và vì OpenClaw nạp plugin thẳng từ đó nên gateway không khởi động, các bot chết. Từ nay mọi thứ OpenClaw phụ thuộc (plugin trong `apps/tieulinh-legacy/openclaw-plugin/`, workspace đồng bộ từ `apps/tieulinh-legacy/skills/`) phải nằm trong repo này. Plugin `duyet-nhanh` của repo cũ không được chép sang vì nó chạy trên Huly; `xac-nhan-xong` viết lại trên worker của repo này.
