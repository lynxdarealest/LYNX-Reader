# LYNX Reader

Ứng dụng desktop đọc truyện offline trên Windows. LYNX Reader lưu thư viện và tiến độ đọc trên máy, đồng thời hỗ trợ nhập truyện, tùy chỉnh giao diện đọc và một số công cụ xử lý nội dung.

## Tính năng

- Quản lý thư viện truyện và trạng thái đọc.
- Nhập truyện từ tệp hoặc từ nguồn web được hỗ trợ.
- Đọc theo chương, tìm kiếm chương và lưu tiến độ.
- Tùy chỉnh giao diện đọc: chủ đề, phông chữ, cỡ chữ, khoảng cách dòng và chế độ đọc.
- Đánh dấu trang, tô sáng và quản lý từ điển.
- Chỉnh sửa nội dung chương và lưu các phiên bản chỉnh sửa.
- Hỗ trợ dịch, chuyển đổi công cụ ngôn ngữ và đọc văn bản thành tiếng ở các luồng được hỗ trợ.
- Xuất dữ liệu sao lưu và khôi phục từ tệp sao lưu.

> Khả năng lấy truyện từ web phụ thuộc vào cấu trúc và chính sách của từng trang. Một số nguồn có thể yêu cầu đăng nhập hoặc không còn tương thích.

## Công nghệ

- React và TypeScript cho giao diện.
- Vite cho phát triển và đóng gói giao diện.
- Tauri 2 và Rust cho ứng dụng Windows.
- IndexedDB để lưu thư viện và dữ liệu đọc cục bộ.

## Yêu cầu

Để phát triển ứng dụng, cần cài đặt:

- Node.js và npm.
- Rust toolchain.
- Các công cụ Windows cần thiết để đóng gói ứng dụng Tauri.

Phiên bản công cụ cụ thể nên được xác nhận theo cấu hình dự án và tài liệu chính thức của Tauri.

## Cài đặt và chạy ở chế độ phát triển

```powershell
npm install
npm run desktop
```

Lệnh trên khởi chạy ứng dụng desktop qua Tauri. Dự án cũng có chế độ chạy máy chủ phát triển web:

```powershell
npm run dev
```

## Kiểm tra kiểu và đóng gói

```powershell
npm run lint
npm run build
```

Tạo gói cài đặt Windows:

```powershell
npm run release:win
```

Tệp cài đặt được tạo trong thư mục đầu ra của Tauri, thường dưới `src-tauri/target/release/bundle/nsis`.

## Dữ liệu và sao lưu

Thư viện, chương, tiến độ đọc, dấu trang, ghi chú, từ điển và cài đặt được lưu cục bộ trong IndexedDB của ứng dụng.

Nên xuất bản sao lưu định kỳ, đặc biệt trước khi cập nhật lớn, di chuyển dữ liệu hoặc cài lại ứng dụng. Hãy lưu tệp sao lưu ở vị trí riêng với thư mục cài đặt ứng dụng.

Trước khi khôi phục bản sao lưu, hãy kiểm tra đúng tệp và giữ một bản sao hiện tại. Việc khôi phục có thể thay đổi dữ liệu đang có.

## Phát hành

GitHub Actions trong `.github/workflows/release.yml` tạo installer Windows khi phát hành tag theo dạng `vX.Y.Z`, ví dụ:

```powershell
git tag v0.1.1
git push origin v0.1.1
```

Workflow cũng có thể được chạy thủ công từ GitHub Actions với tag phát hành hợp lệ.

**Lưu ý:** README cũ mô tả ứng dụng tự tải và cài cập nhật khi khởi động. Chỉ giữ mô tả đó nếu dự án đã tích hợp và kiểm chứng đầy đủ cơ chế tự cập nhật. Workflow phát hành riêng lẻ không chứng minh rằng ứng dụng đã có chức năng tự cập nhật.

## Lưu ý về quyền riêng tư

- Dữ liệu thư viện được lưu trên thiết bị theo thiết kế hiện tại.
- Khi dùng tính năng lấy nội dung web, ứng dụng cần kết nối tới nguồn truyện.
- Cookie đăng nhập có thể được dùng với một số nguồn; không chia sẻ tệp dữ liệu hoặc bản sao lưu nếu chưa kiểm tra chúng có chứa thông tin nhạy cảm hay không.
- Không nhập cookie hoặc thông tin đăng nhập vào nguồn mà bạn không tin cậy.

## Báo lỗi và đề xuất

Khi gửi báo lỗi, hãy mô tả:

1. Phiên bản ứng dụng và phiên bản Windows.
2. Các bước để tái hiện lỗi.
3. Kết quả mong đợi và kết quả thực tế.
4. Tên nguồn truyện hoặc loại tệp liên quan, nếu có.

Không đính kèm cookie, thông tin đăng nhập, hoặc nội dung riêng tư trong báo cáo lỗi.
