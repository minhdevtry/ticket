# Không làm luồng chuẩn hoá tổng cho các trường KG

Chốt 23/09/2026 sau bản đánh giá `docs/KG_FIELD_QUALITY_ASSESSMENT.md`. Một trường chỉ được làm luồng chuẩn hoá khi đủ ba điều: truy vấn thật sự dùng nó, nhiễu đủ lớn để gây hại, và có nguồn chuẩn rõ ràng. Hệ thống và nhóm nguyên nhân đủ cả ba nên đã sửa; phân loại lỗi, sản phẩm, nguyên nhân gốc để đợt sau; metadata phụ không ai dùng thì bỏ. Excel của đội vận hành dùng làm tham chiếu, không làm chuẩn vàng: chính nó cũng nhiễu (một nhãn dán cho nhiều sự cố khác nhau).

## Considered Options

- Luồng chuẩn hoá tổng mọi trường: bị loại vì phần lớn trường không có nguồn chuẩn, làm là chắp vá.
- Nạp thẳng chữ người viết trong Excel thay cho chữ LLM trích: bị loại, đo được độ khớp với log còn thấp hơn LLM.
