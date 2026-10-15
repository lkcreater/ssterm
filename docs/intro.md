# ssterm — Product brief

**ssterm** คือแอป desktop สำหรับเชื่อมต่อและจัดการเซิร์ฟเวอร์ผ่าน SSH ออกแบบเป็นพื้นที่ทำงานประจำวันของนักพัฒนา, DevOps และผู้ดูแลระบบ เริ่มพัฒนาสำหรับ macOS โดยเก็บข้อมูลในเครื่องและใช้งานได้โดยไม่ต้องสมัครบัญชี

**งานหลักของผู้ใช้**

- จัดระเบียบเซิร์ฟเวอร์เป็นกลุ่ม ติดแท็ก ค้นหา และใช้ credentials ร่วมกัน
- เปิด terminal หลาย sessions ผ่าน tabs และ split panes พร้อมสลับงานได้สะดวก
- รับส่งไฟล์ระหว่างเครื่องกับเซิร์ฟเวอร์ผ่าน SFTP แบบสองฝั่ง
- เก็บคำสั่งที่ใช้บ่อยเป็น snippets และเปิด SSH tunnels สำหรับเข้าถึงบริการ

**คุณค่าที่ต้องการสื่อ:** ช่วยให้ผู้ใช้ควบคุมงานบนหลายเซิร์ฟเวอร์ได้อย่างเป็นระเบียบ เห็นชัดว่ากำลังเชื่อมต่อเครื่องไหน และตัดสินใจเรื่อง credentials, ไฟล์ และคำสั่งได้อย่างมั่นใจ

**บุคลิกแบรนด์ที่เสนอ:** สงบ แม่นยำ เชื่อถือได้ และร่วมสมัย ให้ความรู้สึกเป็นเครื่องมือมืออาชีพที่เข้าถึงง่าย เหมาะกับการทำงานที่ต้องใช้สมาธิเป็นเวลานาน

**บริบทของหน้าจอ:** มี sidebar รายชื่อเซิร์ฟเวอร์ พื้นที่ terminal เป็นจุดหลัก และหน้าจัดการไฟล์หรือการตั้งค่าอยู่รอบ ๆ ต้องรองรับข้อมูลจำนวนมาก ตัวอักษร monospace และสถานะหลาย sessions โดยยังอ่านง่าย แยก active target, focus, error และสถานะการเชื่อมต่อได้ชัดเจน

**Visual brand direction:** ใช้ Signal Blue — พื้น deep navy กับ electric blue สำหรับ focus/action, dark-first, Inter สำหรับ UI และ JetBrains Mono สำหรับ terminal ใช้ SST-style monogram และ wordmark `ssterm` จาก [artwork ที่ส่งมา](logo/README.md); production icon exports/QA และ light theme ยังต้องเตรียม ดู [Design System v1.0](termius/design-system.md)

**UI stack:** React + TypeScript บน Electron ใช้ shadcn/ui และ Tailwind CSS

เอกสารนี้เป็นบรีฟผลิตภัณฑ์; ปัจจุบันผ่าน backend feasibility spike แล้ว ส่วน production desktop UI/services ยังรอเริ่มพัฒนา
