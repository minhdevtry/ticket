import { describe, expect, it } from "bun:test";
import { splitMultiIncidentReport } from "./split";

describe("W29-SPLIT Vòng 2 — Bộ tách nhiều học sinh / sự cố", () => {
  it("splitMultiIncidentReport tách đúng 2 học sinh từ văn bản thật TECH-1146", () => {
    const text = `**Lê Văn Anh C**
Code: 9100002
Mã học sinh: 900103 HS us bị lỗi buổi, chính xác có 48 buổi, nhờ tech sửa lại giúp e ạ
Quản lý lớp

**Trần Thị B**
Code: 9100003
Mã học sinh: 90106
HS trước đó có 2 khóa học 48 buổi và 24 buổi đã học hết… => Số buổi đúng phải là 72/120 buổi nhưng hệ thống đang hiển thị là 0/96 buổi. Nhờ tech sửa lại giúp e ạ`;

    const blocks = splitMultiIncidentReport(text);
    expect(blocks).not.toBeNull();
    expect(blocks?.length).toBe(2);

    const first = blocks?.[0];
    const second = blocks?.[1];

    expect(first?.studentName).toBe("Lê Văn Anh C");
    expect(first?.customerId).toBe("9100002");
    expect(first?.studentAccount).toBe("900103");
    expect(first?.reportingDept).toBe("Quản lý lớp");
    expect(first?.text).not.toContain("Trần Thị B");

    expect(second?.studentName).toBe("Trần Thị B");
    expect(second?.customerId).toBe("9100003");
    expect(second?.studentAccount).toBe("90106");
    expect(second?.text).not.toContain("Lê Văn Anh C");
  });

  it("splitMultiIncidentReport tách đúng 2 ca độc lập từ mã CRM (TECH-1248/1249)", () => {
    const text = `90000001
Bộ phận QLL
con được đổi lịch rồi nhưng trên app vẫn hiện lịch học cũ, check giúp t

90000002
Bộ phận QLL
con không hiện bài tập ngày 13/10, check giúp em`;

    const blocks = splitMultiIncidentReport(text);
    expect(blocks).not.toBeNull();
    expect(blocks?.length).toBe(2);
    expect(blocks?.[0]?.customerId).toBe("90000001");
    expect(blocks?.[1]?.customerId).toBe("90000002");
  });

  it("splitMultiIncidentReport vẫn bắt được ca thật có 2 UID khác nhau (TECH-938)", () => {
    const text = `90000003 - 0900000003 DH900003 UID: 900017

Đơn hàng không có sản phẩm liên quan đến khóa Khoa học Tự nhiên, nhưng trên LMS lại được mở Duo KHTN 6.
90000010 - 0900000010 DH900005
UID: 9100005`;

    const blocks = splitMultiIncidentReport(text);
    expect(blocks).not.toBeNull();
    expect(blocks?.length).toBe(2);
  });

  it("danh sách học sinh VÍ DỤ dưới một sự cố hệ thống KHÔNG bị tách (TECH-462, TECH-603)", () => {
    const tech462 = `Anh/chị kiểm tra giúp em HS có ca học hôm nay bị đẩy hết về trạng thái Hoàn thành ở Màn Xử lý ClassIn ạ.

=> Vdu: Hoàng Văn F (SID: 900013)

Phạm Thị E (SID: 900012)

HS chưa hoàn thành Classin nhưng lại đẩy khỏi màn xác nhận => đẩy về Hoàn thành`;
    expect(splitMultiIncidentReport(tech462)).toBeNull();

    const tech603 = `Bài test đầu vào của lớp 2 Toán CLC bị lỗi, đầu HS hiển thị tháng 12 năm 2025.
CM đã kiểm tra 1 số HS gần đây đều thấy vậy, dưới đây là 2 HS làm bài gần nhất:

- SĐT: 0900000011, link test: https://vuihoc.vn/kiem-tra-dau-vao-ket-qua-32489628

- SĐT: 0900000012, link test: https://vuihoc.vn/kiem-tra-dau-vao-ket-qua-32492494`;
    expect(splitMultiIncidentReport(tech603)).toBeNull();
  });

  it("cùng một học sinh nhắc lại ở 2 đoạn (mã KH ở đoạn này, thiếu ở đoạn kia) KHÔNG bị tách (TECH-560)", () => {
    const tech560 = `**Phạm Văn O**

Code: 9100004

Mã học sinh: 900101

HS đăng ký khóa học 1 năm có 100 buổi thôi, khóa cũ HS đã học hết, số buổi đúng của HS là 48/148 buổi.

Thông tin trên ảnh: học sinh Phạm Văn O, Code: 9100004, mã học sinh: 900101.`;
    expect(splitMultiIncidentReport(tech560)).toBeNull();
  });
});
