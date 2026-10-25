# Mỗi worker khoá theo đúng một dự án

Itsaplan gửi sự kiện webhook của mọi dự án tới mọi webhook đã đăng ký, không lọc theo dự án (xác nhận 17/09/2026: comment PO rơi vào worker TECH), và các worker dùng chung file SQLite. Vì vậy mỗi worker khai `ITSAPLAN_PROJECT_KEY` và tự bỏ mọi sự kiện, liên kết chat, lượt quét vòng đời không thuộc dự án của mình. Không được giả định Itsaplan đã lọc sẵn: đã có lần bot Tiểu Linh trả lời hộ Iris và ticket PO bị nạp nhầm vào Onyx.
