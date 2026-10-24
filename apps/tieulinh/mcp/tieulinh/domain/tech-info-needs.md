# Dữ kiện kỹ thuật cần hỏi trước khi tạo ticket TECH

Tài liệu này đúc kết từ các lượt kỹ thuật (TechLead_A, TechUser_B, TechUser_C, TechUser_D...)
hỏi lại người báo trên ticket TECH thật (66+ ticket, tháng 9/2026). Dùng để một LLM
đóng vai kỹ thuật viên rà soát tờ khai trước khi tạo ticket: nếu lời báo đã đủ dữ kiện
của nhóm tương ứng thì tạo luôn; nếu thiếu, hỏi đúng dữ kiện còn thiếu.

## Nguyên tắc

1. **Chỉ hỏi dữ kiện, không hỏi nguyên nhân.** Người báo (Sale/CSKH/Vận hành/Quản lý
   lớp) không biết vì sao hệ thống sai — họ chỉ thấy hiện tượng. Câu như "vì sao bị
   lỗi", "do đâu" là việc của kỹ thuật, đừng hỏi ngược lại người báo.
2. **Tối đa 3 dữ kiện quan trọng nhất, gộp trong một câu hỏi.** Đừng hỏi nhiều lượt
   rời rạc.
3. **Người báo nói không có / không biết thì thôi**, tạo ticket với thông tin hiện có.
   Ép hỏi lại nhiều lần chỉ khiến người báo trả lời qua loa cho xong (ví dụ gửi ảnh
   không liên quan, trả lời "đúng rồi" không mang thông tin mới).
4. **Thông tin đã có trong lời báo thì không hỏi lại** — kể cả khi nó nằm rải rác
   trong nhiều câu.
5. **Nếu sự cố rõ ràng không thuộc phạm vi TECH** (chấm công AMIS, vân tay cửa ra
   vào, lương/nhân sự...), nói rõ ngay để người báo chuyển đúng bộ phận (C&B, nhân
   sự...), không cố hỏi thêm dữ kiện kỹ thuật cho việc không phải của TECH.
6. **Ưu tiên đường link/mã định danh hơn số điện thoại** khi cả hai đều xác định
   được học sinh/khách hàng — vừa nhanh hơn cho kỹ thuật, vừa đỡ lộ SĐT thật vào kênh
   chat chung.

---

## 1. Sai hạn học / mở thiếu-thừa khoá trên LMS (Duo, Tự học)

**Dấu hiệu:** người báo nói tài khoản học sinh bị "sai hạn", "hết hạn sớm", "thiếu
khoá", "chưa mở khoá mới" sau khi đổi/gia hạn gói học trên LMS.

**Cần hỏi (nếu chưa có):**
- Mã đơn hàng liên quan (DHxxxxxx) — TECH-722, TECH-759 (kỹ thuật phải hỏi lại
  "theo đơn hàng nào" vì báo lỗi không nêu).
- Tên khoá học/môn/khối cụ thể cần mở hoặc cần sửa hạn, không nói chung chung —
  TECH-670, TECH-676 (kỹ thuật từ chối xử lý vì "cung cấp thông tin không đầy đủ,
  cần đúng tên để còn tìm", phải hỏi lại nhiều lượt).
- Hạn đang hiển thị sai là gì và hạn đúng mong muốn là gì (nếu người báo biết) —
  TECH-722 (kỹ thuật phải tự đoán mốc hạn vì "không cung cấp thông tin ngày hết hạn
  mong muốn").
- Nếu một nhà có nhiều học sinh/tài khoản: xác định rõ học sinh nào — TECH-733
  (kỹ thuật chỉ xử lý đúng 1 học sinh nêu tên, yêu cầu tách ticket khác cho ca còn
  lại).

**Không hỏi:** vì sao LMS bị sai hạn/sai đồng bộ — đó là việc kỹ thuật tự điều tra
(TECH-670, TECH-676: kỹ thuật tự ghi "Chưa rõ nguyên nhân" và vẫn xử lý được).

---

## 2. Chuyển phí / chuyển nhượng môn học trên CARE (Tutor, Duo)

**Dấu hiệu:** người báo nói "không chuyển được phí/môn", "không tìm thấy gói chuyển
phí PCM", "chuyển nhượng cho anh/chị/em học sinh khác".

**Cần hỏi (nếu chưa có):**
- Link chi tiết học sinh trên se-care (student-detail) hoặc CID/UID/SID — TECH-907,
  TECH-913 (kỹ thuật dặn "lần sau cung cấp thêm link chi tiết" để không phải hỏi lại
  và tra cứu nhanh hơn số điện thoại).
- Môn/gói cụ thể cần chuyển (đặc biệt khi một gia đình có nhiều con hoặc nhiều
  gói) — TECH-867 (kỹ thuật hỏi ngược "muốn báo lỗi khi chuyển phí cho con nào? gói
  nào?" vì nhà có 2 con nhiều gói khác nhau).
- Thao tác cụ thể đã làm và màn hình/thông báo hiện gì (bấm nút nào, ở màn nào) —
  TECH-765 (kỹ thuật không tái hiện được lỗi vì thiếu bước thao tác chi tiết, phải
  hỏi lại "click chọn cái gì, ở đâu, bấm vào nút nào tiếp theo").

**Không hỏi:** tại sao thiếu gói PCM hay vì sao hệ thống không nhận diện được gói —
đây là lỗi đồng bộ dữ liệu, kỹ thuật tự kiểm tra và chạy lại (TECH-859).

---

## 3. Không lên được đơn / trùng tài khoản trên CRM

**Dấu hiệu:** người báo nói "không tạo được đơn", "báo trùng tài khoản/trùng tên
con", "không lên đơn để xếp lớp".

**Cần hỏi (nếu chưa có):**
- Link chi tiết contact trên se-crm (contact-detail) thay vì chỉ số điện thoại —
  đây là dữ kiện lặp lại nhiều nhất trong toàn bộ dữ liệu (TECH-764, TECH-774,
  TECH-778, TECH-850, TECH-870: kỹ thuật liên tục dặn "lần sau cung cấp link chi
  tiết contact, không cần gửi SĐT" vì SĐT tra chậm hơn và lộ thông tin không cần
  thiết lên kênh chat).
- Nếu không có link, ít nhất cần UID/mã khách hàng của tài khoản bị trùng —
  TECH-944 (kỹ thuật không xử lý được vì "báo lỗi kiểu này thì biết contact nào mà
  xử lý").

**Không hỏi:** vì sao bị trùng tài khoản — kỹ thuật tự tra và gỡ liên kết trùng.

---

## 4. CRM không gọi được / tổng đài lỗi

**Dấu hiệu:** người báo nói "không gọi được", "máy bận", "bị out cuộc gọi", "tổng
đài báo lỗi".

**Cần hỏi (nếu chưa có):**
- Ảnh chụp màn hình thông báo lỗi khi gọi (không phải ảnh chung chung) — TECH-931,
  TECH-950 (kỹ thuật phải xin lại "cung cấp thêm ảnh báo lỗi khi gọi").
- Phạm vi: gọi số nào cũng lỗi, hay chỉ một số cụ thể; đã thử tải lại trang (F5)
  hoặc đăng nhập lại chưa — TECH-505 (kỹ thuật hỏi "gọi số nào cũng không được hay
  chỉ có mỗi số trên"; sau cùng xác định F5 là cách tạm khắc phục).
- Thiết bị/ứng dụng gọi (điện thoại, PC, app nào) và thời điểm xảy ra — TECH-908
  (mô tả quá chung, bot tự ghi "chưa đủ thông tin để xác định nguyên nhân").

**Không hỏi:** nguyên nhân lỗi tổng đài — có thể là lỗi hạ tầng nhất thời, kỹ
thuật tự kiểm tra (TECH-916: "lỗi tổng đài, đã khắc phục" không cần thêm gì từ
người báo).

---

## 5. Máy tính / Zalo / thiết bị IT cần hỗ trợ từ xa

**Dấu hiệu:** người báo nói "Zalo bị lag/đơ/treo", "máy tính sập", "màn hình đen",
cần cài đặt phần mềm.

**Cần hỏi (nếu chưa có):**
- KHÔNG xin ID/mật khẩu TeamViewer/UltraViewer ở bước này (mật khẩu không được nằm
  trong ticket; kỹ thuật tự xin trực tiếp khi vào máy — TECH-924, TECH-881, TECH-886).
  Chỉ cần mô tả hiện tượng: lag/đơ lúc nào, trên PC hay điện thoại, ảnh màn hình nếu có.
- Với máy tính không lên hình: ảnh mặt sau máy và tình trạng cắm điện các thiết bị
  — TECH-970.
- Đã thử tắt/bật lại (máy, TeamViewer, Zalo) chưa — TECH-884, TECH-924.

**Không hỏi:** vì sao Zalo/máy bị lag — đây là sự cố cần kỹ thuật vào máy kiểm
tra trực tiếp, không phải thứ người dùng tự chẩn đoán được.

---

## 6. Bài tập / bài kiểm tra / điểm danh trên Tutor & CARE (CC)

**Dấu hiệu:** người báo nói "không làm lại được bài kiểm tra", "báo yêu cầu đăng ký
khi làm bài", "không nộp được BTVN", "không ghi nhận điểm danh/kết quả học tập".

**Cần hỏi (nếu chưa có):**
- Link trực tiếp tới bài/buổi học bị lỗi (không chỉ tên chung "bài kiểm tra") —
  TECH-969 (kỹ thuật phải đoán "không rõ có phải bài này không nhỉ?" vì thiếu link
  cụ thể).
- Khoá học / lớp / buổi học cụ thể bị ảnh hưởng — TECH-662 (kỹ thuật hỏi lại "báo
  lỗi ở khoá nào? lớp nào? bài của buổi nào?").
- Ảnh chụp màn hình lỗi và bước thao tác trước khi lỗi hiện — TECH-767, TECH-736.
- Với điểm danh/kết quả học tập trên CARE: SĐT hoặc mã học sinh + ngày buổi học cụ
  thể (và ảnh chụp buổi học đó nếu có) thường là **đủ để xử lý ngay, không cần hỏi
  lại** — TECH-690, TECH-627 là ví dụ báo lỗi "đủ": có SĐT, ngày học, môn học rõ
  ràng nên kỹ thuật xử lý một lượt, không phải hỏi thêm.

**Không hỏi:** vì sao hệ thống không ghi nhận điểm danh/kết quả — đây là lỗi đồng
bộ dữ liệu giữa hệ thống học và CARE, kỹ thuật tự kiểm tra luồng đồng bộ.

---

## 7. Dữ liệu CTS không hiển thị / chưa đồng bộ trên CARE

**Dấu hiệu:** người báo nói "không tìm thấy CTS", "CTS chuyển song song/cuốn chiếu
không hiển thị trên CARE".

**Cần hỏi (nếu chưa có):**
- Mã CTS hoặc mã đơn/mã phiếu thu (receipt_code) cụ thể — TECH-846 (kỹ thuật dặn
  "lần sau em copy luôn receipt_code để xử lý cho nhanh").
- Link chi tiết học sinh trên se-care nếu có, để tra thẳng thay vì tìm theo tên —
  TECH-747, TECH-748, TECH-750.

**Không hỏi:** vì sao dữ liệu chưa đồng bộ — kỹ thuật tự chạy lại đồng bộ.

---

## 8. Đăng nhập / xem video / dùng ứng dụng (phía học sinh, phụ huynh)

**Dấu hiệu:** người báo nói "không xem được video bài học", "không tìm thấy app",
"không vào học được" nhưng chưa rõ chi tiết.

**Cần hỏi (nếu chưa có):**
- Cụ thể "không vào học được" là ở bước nào: không đăng nhập được, đăng nhập được
  nhưng không mở được bài, hay mở được nhưng không xem video — TECH-763 (kỹ thuật
  hỏi lại vì câu báo quá chung chung, không biết kiểm tra ở đâu).
- Thiết bị đang dùng (điện thoại/máy tính bảng/PC) và ảnh chụp màn hình lỗi —
  TECH-619 (kỹ thuật cần biết mạng Wi-Fi/4G, thiết bị để phân biệt lỗi mạng hay lỗi
  nhúng video).

**Không hỏi:** vì sao video/app lỗi — nhiều trường hợp do quyền video, mạng, hay
thiết bị, kỹ thuật/CSKH tự phân loại qua các bước kiểm tra.

---

## 9. Báo nhầm bộ phận (không thuộc TECH)

**Dấu hiệu:** sự cố liên quan chấm công, công trên AMIS, mã vân tay cửa ra vào,
lương — đây là nghiệp vụ C&B/nhân sự, không phải hệ thống TECH quản lý.

**Cần làm:** không hỏi thêm dữ kiện kỹ thuật. Nói rõ ngay đây không thuộc phạm vi
TECH và hướng người báo sang đúng bộ phận (C&B, nhân sự) — TECH-929 ("TECH ko phụ
trách phần này, báo sang bên C&B"), TECH-963 ("nhầm chỗ, amis thì hỏi bên nhân
sự"), TECH-723 (mã vân tay bị xoá — C&B xử lý, không phải TECH).

Tương tự, quên mật khẩu/tài khoản đăng nhập nội bộ (CRM, hệ thống nhân sự) không
phải TECH cấp lại — hướng người báo liên hệ quản lý trực tiếp của họ — TECH-648,
TECH-645.

---

## Ghi chú chung

- Các nhóm trên được rút ra từ dữ liệu thật, không phải danh sách đầy đủ mọi loại
  sự cố có thể xảy ra. Nếu ticket không khớp nhóm nào, áp dụng Nguyên tắc chung ở
  đầu tài liệu: hỏi tối đa 3 dữ kiện định danh + tái hiện lỗi, không hỏi nguyên
  nhân, và không có thì thôi.
- "Đủ thông tin" nhìn chung nghĩa là: xác định được **ai** (SĐT/mã HS/link contact),
  **cái gì** (đơn hàng/khoá học/gói cụ thể), và **khi nào/ở đâu lỗi xảy ra** (ngày,
  bước thao tác, ảnh chụp) — thiếu một trong ba mới cần hỏi thêm.
