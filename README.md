# LYNX Reader

Ứng dụng đọc truyện chữ chạy trên **Desktop Windows (Tauri v2)** và **Web cục bộ (React + Vite + Express)**, lưu trữ thư viện trực tiếp trên máy bằng **IndexedDB**.

---

## 1. Tính năng hiện đã triển khai

### Thư viện & Nhập sách cục bộ
- Quản lý thư viện cá nhân trên IndexedDB (`LynxReaderDB`): tìm kiếm theo tên/tác giả/thẻ, lọc theo trạng thái (`Đang đọc`, `Chưa đọc`, `Hoàn thành`, `Yêu thích`, `Lưu trữ`, `Lịch sử`), lọc định dạng, sắp xếp và chuyển đổi chế độ Lưới / Danh sách.
- Hỗ trợ nhập các định dạng: **TXT, EPUB, FB2, DOCX, HTML, MD**.
- Tự động tách chương theo bộ quy tắc Regex dựng sẵn hoặc quy tắc tùy chỉnh của người dùng; lưu bản gốc để tách lại chương bất kỳ lúc nào (`rawTextBackup`).
- Trình quản lý chương: đổi tên, tách chương, ghép chương và xóa chương.
- Xuất truyện ra **TXT** hoặc **EPUB**.
- Tự động di trú dữ liệu một lần từ cơ sở dữ liệu cũ `VBookDesktopDB` sang `LynxReaderDB` theo giao dịch nguyên tử; nếu xảy ra lỗi sẽ giữ nguyên dữ liệu nguồn và hiển thị cảnh báo hướng dẫn sao lưu.

### Trình đọc, Chỉnh sửa & Tiện ích
- 5 chế độ đọc: Cuộn (`scroll`), Cuộn liên tục (`continuous`), Lật trang (`paginated`), Hai cột (`two-column`) và Tập trung (`focus` / Zen).
- Nhiều giao diện đọc dựng sẵn (`Paper`, `Sepia`, `Light`, `Dark`, `OLED`, `E-Ink`, `Night Blue`) và trình tạo/tùy biến theme riêng (màu chữ, nền, font, cỡ chữ, giãn dòng, lề, căn lề).
- Đầy đủ phím tắt điều hướng và thao tác đọc.
- Tìm kiếm nội dung trong truyện, tạo **Bookmark** và **Highlight** kèm ghi chú.
- Chỉnh sửa trực tiếp nội dung/tiêu đề chương, thay thế hàng loạt (Tìm & Thay thế) và lưu lịch sử các phiên bản đã sửa (`chapter_versions`) để khôi phục khi cần.
- **Đọc thành tiếng (TTS)** thông qua Web Speech API của trình duyệt / Windows WebView2.
- **Từ điển riêng & Từ điển chung (`__global__`)**: tự động thay thế tên riêng, thuật ngữ, đại từ xưng hô khi đọc và trước/sau khi dịch.

### Sao lưu & Khôi phục thủ công (`.json`)
- Xuất toàn bộ thư viện ra tệp `.json` (định dạng `v2`, bao gồm: sách, chương, lịch sử chỉnh sửa chương `chapter_versions`, bản dịch `chapter_translations`, bookmark, highlight, từ điển và cài đặt đọc).
- **Cookie đăng nhập web (`site_cookies`) không được xuất vào tệp sao lưu** để tránh lộ phiên đăng nhập khi chia sẻ tệp sao lưu.
- Hỗ trợ đọc ngược lại các tệp sao lưu cũ `v1` và tệp `v2`.
- Trước khi khôi phục, ứng dụng kiểm tra định dạng, phiên bản, kiểu dữ liệu và liên kết giữa sách–chương; hiển thị bảng xem trước số lượng dữ liệu; cho phép chọn rõ ràng giữa **Gộp vào dữ liệu hiện có** hoặc **Thay thế toàn bộ thư viện** (có cảnh báo và hộp kiểm xác nhận bắt buộc).

---

## 2. Tính năng phụ thuộc nguồn web & dịch vụ ngoài

Các tính năng dưới đây hoạt động dựa vào cấu trúc trang web đích, kết nối Internet và chính sách chống bot của máy chủ bên thứ 3:

- **Nhập truyện từ Web (`WEB`) & Trình duyệt tích hợp**:
  - Hỗ trợ phân tích và tải trực tiếp từ **Pixiv Novel** (series và truyện đơn, có tách `[chapter:...]`), **Syosetsu**, **Kakuyomu** và các trang HTML truyện phổ biến.
  - Quản lý kho Cookie theo tên miền (`site_cookies` trong IndexedDB đồng bộ với `.browser-cookies.json` ở chế độ Web server hoặc `cookies.json` ở chế độ Tauri desktop).
  - Chế độ Web dùng reverse proxy `/api/browser/proxy`; chế độ Tauri desktop mở cửa sổ WebView2 riêng (`reader-browser`) để duyệt và tự thu nhận cookie phiên.
  - Hạn chế bảo mật: hệ thống chặn giao thức ngoài `http`/`https`, chặn URL chứa thông tin đăng nhập, chặn địa chỉ cục bộ/mạng nội bộ (localhost, IP riêng tư, link-local) và kiểm tra lại đích chuyển hướng để không gửi nhầm cookie sang tên miền khác. Các trang bật **Cloudflare Challenge** hoặc thay đổi cấu trúc HTML có thể không tải tự động được qua proxy web và yêu cầu người dùng xác minh / dán cookie thủ công.
- **Dịch truyện & Tra cụm từ**:
  - Gửi yêu cầu tới dịch vụ dịch bên thứ 3 (`comic.sangtacvietcdn.xyz`, kết hợp `translate.googleapis.com` và trên máy chủ Web có thêm `api.mymemory.translated.net`).
  - Có thể tạm thời không dùng được nếu mất kết nối mạng hoặc IP hiện tại bị máy chủ dịch yêu cầu xác minh bảo mật (HTTP 403 / Cloudflare).

---

## 3. Tính năng chưa tích hợp

- **Tự động cập nhật (Auto-Update)**: Ứng dụng hiện **chưa** kiểm tra phiên bản mới trên GitHub Releases, chưa tự tải gói cài đặt, chưa xác minh chữ ký và chưa tự cài cập nhật. Để nâng cấp, người dùng cần tải bộ cài mới thủ công từ trang Releases trên GitHub.
- **Đồng bộ đám mây / Tài khoản người dùng**: Chưa hỗ trợ; toàn bộ dữ liệu thư viện được lưu cục bộ trên thiết bị.

---

## 4. Cài đặt, Phát triển, Kiểm tra và Đóng gói

### Yêu cầu môi trường
- **Node.js 22+** và **npm**
- Để chạy hoặc đóng gói bản Desktop Windows (`tauri`): cần cài **Rust toolchain** (`rustc`, `cargo`), trên Windows cần thêm **Microsoft Edge WebView2 Runtime** và **Visual Studio C++ Build Tools**.

### Các lệnh từ `package.json`

```bash
# 1. Cài đặt dependencies
npm install

# 2. Chạy chế độ phát triển Web (Express + Vite tại http://localhost:3000)
npm run dev

# 3. Kiểm tra kiểu TypeScript (typecheck / lint)
npm run lint

# 4. Build giao diện frontend vào thư mục dist/
npm run build

# 5. Chạy bản production Web server (sau khi đã build dist/)
npm start

# 6. Chạy ứng dụng Desktop Tauri ở chế độ dev
npm run desktop

# 7. Đóng gói bộ cài Windows NSIS (.exe)
npm run release:win
```

### Phát hành bản Windows qua GitHub Actions

Workflow `.github/workflows/release.yml` tự động đồng bộ số phiên bản vào `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, chạy `npm run release:win` trên `windows-latest` và tải tệp cài đặt NSIS `.exe` lên GitHub Release khi đẩy tag dạng `v*` (hoặc kích hoạt thủ công bằng `workflow_dispatch`):

```powershell
git tag v0.1.1
git push origin v0.1.1
```

---

## 5. Bảo mật & Quyền riêng tư cục bộ

- Toàn bộ sách, chương, ghi chú và từ điển được lưu tại IndexedDB trên máy người dùng.
- Thư viện không gửi dữ liệu đọc hay thống kê sử dụng (telemetry) về máy chủ riêng; chỉ kết nối ra ngoài khi người dùng chủ động dùng tính năng nhập truyện Web, trình duyệt tích hợp hoặc dịch văn bản.
- Cấu hình Tauri sử dụng Content Security Policy (`src-tauri/tauri.conf.json`) giới hạn nguồn script thực thi và kênh IPC nội bộ.
