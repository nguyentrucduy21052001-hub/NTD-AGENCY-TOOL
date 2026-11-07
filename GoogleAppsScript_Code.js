/**
 * ==============================================================================
 * HỆ THỐNG QUẢN LÝ TÀI KHOẢN, MẬT KHẨU & GIA HẠN - NTD AGENCY
 * ==============================================================================
 * HƯỚNG DẪN CÀI ĐẶT NHANH TRONG 2 PHÚT:
 * 
 * BƯỚC 1: Tạo Google Trang Tính (Google Sheets)
 *   1. Mở trình duyệt, truy cập: https://sheets.new để tạo một trang tính mới.
 *   2. Đặt tên trang tính là: "NTD Agency - Quản lý tài khoản" (hoặc tên tùy thích).
 * 
 * BƯỚC 2: Dán mã Google Apps Script
 *   1. Trên thanh menu Google Sheets, chọn: Tiện ích mở rộng (Extensions) -> Apps Script.
 *   2. Xóa toàn bộ nội dung mẫu đang có trong Apps Script.
 *   3. Sao chép toàn bộ nội dung file này và DÁN vào.
 *   4. Bấm biểu tượng Lưu 💾 (hoặc phím tắt Ctrl + S).
 * 
 * BƯỚC 3: Triển khai Ứng Dụng Web (Web App)
 *   1. Bấm nút màu xanh "Triển khai" (Deploy) ở góc trên bên phải -> Chọn "Tùy chọn triển khai mới" (New deployment).
 *   2. Bấm vào biểu tượng bánh răng ⚙️ bên cạnh "Chọn loại" -> Chọn "Ứng dụng web" (Web app).
 *   3. Điền các mục như sau:
 *      • Mô tả (Description): NTD Agency Auth API
 *      • Thực thi dưới dạng (Execute as): Tôi (email của bạn / Me)
 *      • Ai có quyền truy cập (Who has access): BẤT KỲ AI (Anyone)  <-- CỰC KỲ QUAN TRỌNG!
 *   4. Bấm nút "Triển khai" (Deploy).
 *   5. Nếu Google hiển thị cửa sổ "Cần có quyền truy cập":
 *      -> Chọn tài khoản Google của bạn -> Bấm "Nâng cao" (Advanced) 
 *      -> Chọn "Đi tới ... (không an toàn)" -> Bấm "Cho phép" (Allow).
 *   6. Sao chép "URL ứng dụng web" (Web app URL - có đuôi /exec).
 *   7. Dán URL này vào tiện ích NTD Agency (trong trang Quản lý hoặc trang Đăng nhập).
 * 
 * ==============================================================================
 * CÁCH QUẢN TRỊ TÀI KHOẢN & GIA HẠN:
 * • Thêm người mới: Thêm 1 dòng vào bảng với Tài khoản, Mật khẩu, Hạn sử dụng.
 *   (Cột "Mã máy" ĐỂ TRỐNG: Hệ thống sẽ tự động ghim mã máy khi khách đăng nhập lần đầu).
 * • Gia hạn: Chỉ cần sửa lại ô "Hạn sử dụng" (VD: sửa thành 2026-12-31 hoặc 31/12/2026).
 * • Đổi máy cho khách: Xóa nội dung trong ô "Mã máy" của khách đó. Khi khách đăng nhập
 *   ở máy mới, mã máy mới sẽ tự động được ghim vào!
 * • Khóa tài khoản: Đổi cột "Trạng thái" thành "locked" hoặc "khoa".
 * ==============================================================================
 */

const SHEET_NAME = 'Users'; // Tên Sheet lưu tài khoản
const ADMIN_PASSWORD = 'DuyAdmin@2025'; // Mật khẩu quản trị API nếu thao tác từ trang Manage
const SECRET_KEY = 'NTD_Agency_Secret_Auth_2026'; // Khóa bí mật ký token xác thực

/**
 * Tự động tạo và định dạng Sheet nếu chưa có
 */
function initSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }
  
  if (sheet.getLastRow() === 0) {
    // Tạo tiêu đề chuẩn
    const headers = [
      'Tài khoản',
      'Mật khẩu',
      'Hạn sử dụng',
      'Mã máy (Tự ghim)',
      'Trạng thái',
      'Ghi chú',
      'Đăng nhập cuối'
    ];
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    
    // Style tiêu đề
    const headerRange = sheet.getRange(1, 1, 1, headers.length);
    headerRange.setBackground('#ea580c');
    headerRange.setFontColor('#ffffff');
    headerRange.setFontWeight('bold');
    headerRange.setHorizontalAlignment('center');
    sheet.setFrozenRows(1);
    
    // Đặt độ rộng cột cho dễ nhìn
    sheet.setColumnWidth(1, 150); // Tài khoản
    sheet.setColumnWidth(2, 130); // Mật khẩu
    sheet.setColumnWidth(3, 130); // Hạn sử dụng
    sheet.setColumnWidth(4, 260); // Mã máy
    sheet.setColumnWidth(5, 110); // Trạng thái
    sheet.setColumnWidth(6, 220); // Ghi chú
    sheet.setColumnWidth(7, 160); // Đăng nhập cuối

    // Thêm 1 tài khoản mẫu để bạn kiểm tra thử ngay
    const d30 = new Date();
    d30.setDate(d30.getDate() + 30);
    const yyyy = d30.getFullYear();
    const mm = String(d30.getMonth() + 1).padStart(2, '0');
    const dd = String(d30.getDate()).padStart(2, '0');
    
    sheet.appendRow([
      'admin_test',
      '123456',
      `${yyyy}-${mm}-${dd}`,
      '',
      'active',
      'Tài khoản mẫu dùng thử 30 ngày',
      ''
    ]);
  }
  return sheet;
}

/**
 * Xử lý yêu cầu GET
 */
function doGet(e) {
  return handleRequest(e);
}

/**
 * Xử lý yêu cầu POST
 */
function doPost(e) {
  return handleRequest(e);
}

/**
 * Điều hướng request
 */
function handleRequest(e) {
  try {
    let params = {};
    if (e && e.parameter && Object.keys(e.parameter).length > 0) {
      params = e.parameter;
    } else if (e && e.postData && e.postData.contents) {
      try {
        params = JSON.parse(e.postData.contents);
      } catch (err) {
        params = e.parameter || {};
      }
    }

    const action = (params.action || 'ping').toLowerCase();

    // 1. Kiểm tra kết nối
    if (action === 'ping') {
      initSheet();
      return jsonResponse({
        ok: true,
        message: 'Google Apps Script NTD Agency đang hoạt động bình thường!',
        time: new Date().toISOString()
      });
    }

    // 2. Đăng nhập tài khoản
    if (action === 'login') {
      return handleLogin(params);
    }

    // 3. Kiểm tra trạng thái bản quyền ngầm
    if (action === 'check') {
      return handleCheck(params);
    }

    // 4. Thêm tài khoản mới (dành cho Admin từ trang Manage)
    if (action === 'add_user') {
      return handleAddUser(params);
    }

    // 5. Gia hạn tài khoản (dành cho Admin từ trang Manage)
    if (action === 'renew') {
      return handleRenew(params);
    }

    // 6. Reset mã máy (dành cho Admin từ trang Manage)
    if (action === 'reset_machine') {
      return handleResetMachine(params);
    }

    // 7. Lấy danh sách tài khoản (dành cho Admin)
    if (action === 'list_users') {
      return handleListUsers(params);
    }

    return jsonResponse({ ok: false, error: 'Hành động không hợp lệ: ' + action });
  } catch (error) {
    return jsonResponse({ ok: false, error: 'Lỗi máy chủ Google Apps Script: ' + error.toString() });
  }
}

/**
 * Phản hồi dạng JSON chuẩn
 */
function jsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Chuẩn hóa và parse ngày hết hạn từ các định dạng linh hoạt
 */
function parseExpiryDate(val) {
  if (!val) return null;
  if (val instanceof Date) {
    val.setHours(23, 59, 59, 999);
    return val;
  }
  const str = String(val).trim();
  // YYYY-MM-DD hoặc YYYY/MM/DD
  const m1 = str.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m1) {
    return new Date(parseInt(m1[1]), parseInt(m1[2]) - 1, parseInt(m1[3]), 23, 59, 59);
  }
  // DD-MM-YYYY hoặc DD/MM/YYYY
  const m2 = str.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (m2) {
    return new Date(parseInt(m2[3]), parseInt(m2[2]) - 1, parseInt(m2[1]), 23, 59, 59);
  }
  const d = new Date(str);
  if (!isNaN(d.getTime())) {
    d.setHours(23, 59, 59, 999);
    return d;
  }
  return null;
}

/**
 * Tạo chữ ký HMAC SHA-256 an toàn
 */
function generateToken(payload) {
  const signature = Utilities.computeHmacSha256Signature(payload, SECRET_KEY);
  return signature.map(b => ('0' + (b & 0xFF).toString(16)).slice(-2)).join('');
}

/**
 * Xử lý đăng nhập tài khoản
 */
function handleLogin(params) {
  const username = (params.username || '').trim();
  const password = (params.password || '').trim();
  const machineId = (params.machineId || '').trim();

  if (!username) return jsonResponse({ ok: false, error: 'Vui lòng cung cấp Tên tài khoản.' });
  if (!password) return jsonResponse({ ok: false, error: 'Vui lòng cung cấp Mật khẩu.' });
  if (!machineId) return jsonResponse({ ok: false, error: 'Thiếu thông tin Mã máy (Machine ID).' });

  const sheet = initSheet();
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) {
    return jsonResponse({ ok: false, error: 'Hệ thống chưa có tài khoản nào được tạo.' });
  }

  let foundRow = -1;
  let userRow = null;

  for (let i = 1; i < data.length; i++) {
    const rowUser = String(data[i][0] || '').trim();
    if (rowUser.toLowerCase() === username.toLowerCase()) {
      foundRow = i + 1; // 1-indexed
      userRow = data[i];
      break;
    }
  }

  if (foundRow === -1 || !userRow) {
    return jsonResponse({
      ok: false,
      error: `Tài khoản "${username}" không tồn tại trên hệ thống. Vui lòng liên hệ Quản trị viên để được cấp tài khoản.`
    });
  }

  // 1. Kiểm tra Mật khẩu
  const sheetPass = String(userRow[1] || '').trim();
  if (sheetPass !== password) {
    return jsonResponse({
      ok: false,
      error: 'Mật khẩu không chính xác. Vui lòng kiểm tra lại mật khẩu được cấp.'
    });
  }

  // 2. Kiểm tra Trạng thái (status)
  const status = String(userRow[4] || 'active').trim().toLowerCase();
  if (status === 'locked' || status === 'khoa' || status === 'tạm khóa' || status === 'block') {
    return jsonResponse({
      ok: false,
      error: 'Tài khoản của bạn đã bị tạm khóa. Vui lòng liên hệ Quản trị viên.'
    });
  }

  // 3. Kiểm tra Hạn sử dụng (Expiry Date)
  const rawExpiry = userRow[2];
  const expiryDate = parseExpiryDate(rawExpiry);

  if (!expiryDate) {
    return jsonResponse({
      ok: false,
      error: 'Ngày hết hạn của tài khoản trên hệ thống không hợp lệ. Vui lòng liên hệ Quản trị viên để chỉnh sửa.'
    });
  }

  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const formattedExpiry = `${pad(expiryDate.getDate())}/${pad(expiryDate.getMonth() + 1)}/${expiryDate.getFullYear()}`;

  if (expiryDate.getTime() < now.getTime()) {
    return jsonResponse({
      ok: false,
      expired: true,
      expiryFormatted: formattedExpiry,
      error: `❌ Tài khoản "${username}" đã hết hạn vào ngày ${formattedExpiry}.\n👉 Vui lòng liên hệ Quản trị viên để được gia hạn sử dụng.`
    });
  }

  // 4. Kiểm tra và Ghim Mã máy (1 tài khoản / 1 máy)
  const sheetMid = String(userRow[3] || '').trim();
  const inputMid = machineId.trim();

  if (!sheetMid) {
    // Lần đầu đăng nhập trên thiết bị -> Tự động ghim mã máy này vào bảng
    sheet.getRange(foundRow, 4).setValue(inputMid);
  } else if (sheetMid.toLowerCase() !== inputMid.toLowerCase()) {
    // Đăng nhập trên máy khác mã máy đã ghim
    return jsonResponse({
      ok: false,
      lockedToOtherMachine: true,
      sheetMid: sheetMid,
      error: `⚠️ Tài khoản này đã được ghim với máy tính khác!\n• Mã máy đã ghim: ${sheetMid}\n• Mã máy hiện tại: ${inputMid}\n\n👉 Nếu đây vẫn là máy của bạn (vừa đổi cấu hình/màn hình hoặc update bản mới), bạn có thể bấm "⚡ Dùng lại Mã máy cũ đã ghim" bên dưới để đăng nhập ngay mà không cần liên hệ Admin!`
    });
  }

  // 5. Cập nhật Đăng nhập cuối
  const loginTimeStr = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())} ${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()}`;
  sheet.getRange(foundRow, 7).setValue(loginTimeStr);

  // Tính số ngày còn lại
  const daysLeft = Math.ceil((expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
  const token = generateToken(username + '|' + expiryDate.toISOString() + '|' + machineId);

  return jsonResponse({
    ok: true,
    username: String(userRow[0] || username).trim(),
    expiry: expiryDate.toISOString(),
    expiryFormatted: formattedExpiry,
    daysLeft: daysLeft,
    machineId: machineId,
    token: token,
    message: 'Đăng nhập thành công!'
  });
}

/**
 * Kiểm tra trạng thái tài khoản ngầm (Silent Check)
 */
function handleCheck(params) {
  const username = (params.username || '').trim();
  const machineId = (params.machineId || '').trim();

  if (!username) return jsonResponse({ ok: false, error: 'Thiếu username' });

  const sheet = initSheet();
  const data = sheet.getDataRange().getValues();
  let userRow = null;

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0] || '').trim().toLowerCase() === username.toLowerCase()) {
      userRow = data[i];
      break;
    }
  }

  if (!userRow) {
    return jsonResponse({ ok: false, error: 'Tài khoản không tồn tại hoặc đã bị xóa.' });
  }

  const status = String(userRow[4] || 'active').trim().toLowerCase();
  if (status === 'locked' || status === 'khoa') {
    return jsonResponse({ ok: false, error: 'Tài khoản đã bị tạm khóa.' });
  }

  const sheetMid = String(userRow[3] || '').trim();
  const inputMid = machineId.trim();
  if (inputMid && sheetMid && sheetMid.toLowerCase() !== inputMid.toLowerCase()) {
    return jsonResponse({ ok: false, machineMismatch: true, error: 'Tài khoản đã được ghim với máy khác.' });
  }

  const expiryDate = parseExpiryDate(userRow[2]);
  if (!expiryDate || expiryDate.getTime() < Date.now()) {
    return jsonResponse({ ok: false, error: 'Tài khoản đã hết hạn sử dụng.' });
  }

  const pad = n => String(n).padStart(2, '0');
  const formattedExpiry = `${pad(expiryDate.getDate())}/${pad(expiryDate.getMonth() + 1)}/${expiryDate.getFullYear()}`;
  const daysLeft = Math.ceil((expiryDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));

  return jsonResponse({
    ok: true,
    active: true,
    expiry: expiryDate.toISOString(),
    expiryFormatted: formattedExpiry,
    daysLeft: daysLeft
  });
}

/**
 * Thêm tài khoản mới
 */
function handleAddUser(params) {
  if (params.admin_pass !== ADMIN_PASSWORD) {
    return jsonResponse({ ok: false, error: 'Sai mật khẩu quản trị Admin.' });
  }

  const username = (params.username || '').trim();
  const password = (params.password || '').trim();
  const expiryRaw = (params.expiry || '').trim();
  const note = (params.note || '').trim();

  if (!username) return jsonResponse({ ok: false, error: 'Chưa nhập Tên tài khoản.' });
  if (!password) return jsonResponse({ ok: false, error: 'Chưa nhập Mật khẩu.' });
  if (!expiryRaw) return jsonResponse({ ok: false, error: 'Chưa nhập Ngày hết hạn.' });

  const expiryDate = parseExpiryDate(expiryRaw);
  if (!expiryDate) return jsonResponse({ ok: false, error: 'Định dạng ngày hết hạn không hợp lệ (VD: YYYY-MM-DD).' });

  const sheet = initSheet();
  const data = sheet.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0] || '').trim().toLowerCase() === username.toLowerCase()) {
      return jsonResponse({ ok: false, error: `Tài khoản "${username}" đã tồn tại trên hệ thống.` });
    }
  }

  const pad = n => String(n).padStart(2, '0');
  const formattedDate = `${expiryDate.getFullYear()}-${pad(expiryDate.getMonth() + 1)}-${pad(expiryDate.getDate())}`;

  sheet.appendRow([
    username,
    password,
    formattedDate,
    '', // Mã máy để trống để khách tự ghim khi đăng nhập lần đầu
    'active',
    note,
    ''
  ]);

  return jsonResponse({
    ok: true,
    message: `Đã tạo tài khoản "${username}" thành công với hạn dùng đến ${formattedDate}.`
  });
}

/**
 * Gia hạn thời gian sử dụng
 */
function handleRenew(params) {
  if (params.admin_pass !== ADMIN_PASSWORD) {
    return jsonResponse({ ok: false, error: 'Sai mật khẩu quản trị Admin.' });
  }

  const username = (params.username || '').trim();
  const newExpiryRaw = (params.expiry || '').trim(); // Ngày hết hạn mới (YYYY-MM-DD)
  const addDays = parseInt(params.days || '0');

  if (!username) return jsonResponse({ ok: false, error: 'Chưa nhập Tên tài khoản cần gia hạn.' });

  const sheet = initSheet();
  const data = sheet.getDataRange().getValues();
  let foundRow = -1;
  let userRow = null;

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0] || '').trim().toLowerCase() === username.toLowerCase()) {
      foundRow = i + 1;
      userRow = data[i];
      break;
    }
  }

  if (foundRow === -1) {
    return jsonResponse({ ok: false, error: `Không tìm thấy tài khoản "${username}".` });
  }

  let finalExpiry = null;
  if (newExpiryRaw) {
    finalExpiry = parseExpiryDate(newExpiryRaw);
  } else if (addDays > 0) {
    const curExpiry = parseExpiryDate(userRow[2]) || new Date();
    const baseDate = curExpiry.getTime() > Date.now() ? curExpiry : new Date();
    baseDate.setDate(baseDate.getDate() + addDays);
    finalExpiry = baseDate;
  }

  if (!finalExpiry) {
    return jsonResponse({ ok: false, error: 'Vui lòng cung cấp ngày hết hạn mới hoặc số ngày cần cộng thêm.' });
  }

  const pad = n => String(n).padStart(2, '0');
  const formattedDate = `${finalExpiry.getFullYear()}-${pad(finalExpiry.getMonth() + 1)}-${pad(finalExpiry.getDate())}`;

  sheet.getRange(foundRow, 3).setValue(formattedDate);
  // Nếu tài khoản đang bị khóa, tự động mở lại
  if (String(userRow[4] || '').toLowerCase() === 'locked') {
    sheet.getRange(foundRow, 5).setValue('active');
  }

  return jsonResponse({
    ok: true,
    message: `Đã gia hạn thành công tài khoản "${username}" đến ngày ${formattedDate}.`
  });
}

/**
 * Xóa mã máy để khách đổi máy mới
 */
function handleResetMachine(params) {
  if (params.admin_pass !== ADMIN_PASSWORD) {
    return jsonResponse({ ok: false, error: 'Sai mật khẩu quản trị Admin.' });
  }

  const username = (params.username || '').trim();
  if (!username) return jsonResponse({ ok: false, error: 'Chưa nhập Tên tài khoản.' });

  const sheet = initSheet();
  const data = sheet.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0] || '').trim().toLowerCase() === username.toLowerCase()) {
      sheet.getRange(i + 1, 4).setValue('');
      return jsonResponse({
        ok: true,
        message: `Đã reset Mã máy cho tài khoản "${username}". Khách hàng có thể đăng nhập trên máy tính mới.`
      });
    }
  }

  return jsonResponse({ ok: false, error: `Không tìm thấy tài khoản "${username}".` });
}

/**
 * Danh sách người dùng
 */
function handleListUsers(params) {
  if (params.admin_pass !== ADMIN_PASSWORD) {
    return jsonResponse({ ok: false, error: 'Sai mật khẩu quản trị Admin.' });
  }

  const sheet = initSheet();
  const data = sheet.getDataRange().getValues();
  const users = [];

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row[0]) continue;
    const expiryDate = parseExpiryDate(row[2]);
    const pad = n => String(n).padStart(2, '0');
    const formattedExpiry = expiryDate
      ? `${pad(expiryDate.getDate())}/${pad(expiryDate.getMonth() + 1)}/${expiryDate.getFullYear()}`
      : 'Chưa đặt';
    const isExpired = expiryDate ? expiryDate.getTime() < Date.now() : true;

    users.push({
      username: String(row[0] || '').trim(),
      password: String(row[1] || '').trim(),
      expiry: formattedExpiry,
      isExpired: isExpired,
      machineId: String(row[3] || '').trim(),
      hasMachine: !!String(row[3] || '').trim(),
      status: String(row[4] || 'active').trim(),
      note: String(row[5] || '').trim(),
      lastLogin: String(row[6] || '').trim()
    });
  }

  return jsonResponse({ ok: true, users: users });
}
