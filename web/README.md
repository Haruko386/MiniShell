# MiniShell 前后端接口约定

前端启动：`npm install`，`npm run dev`。开发服务器将 `/api` 代理到 `localhost:8080`。连接配置保存在浏览器 localStorage，密码在连接编辑时输入，与连接配置一起明文保存在浏览器 localStorage。

## 建议实现顺序

1. 用 Go HTTP 服务实现会话创建：`POST /api/sessions`，JSON 请求 `{host, port, username, password}`，响应 `{id}`。服务端连接 SSH 并为该会话保留 SSH client；失败返回非 2xx 和 `{message}`。会话 ID 应随机且不可预测。首次遇到未知主机密钥时返回 `409` 和 `{hostKey:{host,port,keyType,fingerprint,changed,known}}`；前端确认后重试，并带上 `hostKeyMode:"once"|"save"|"replace"` 和 `hostKeyFingerprint`。`save` 会追加到 `~/.ssh/known_hosts`；`replace` 仅在同类主机密钥确实变化时使用，删除旧记录后写入新密钥。不同密钥类型分别信任。
2. `GET /api/sessions/{id}/terminal` 升级为 WebSocket。客户端发 JSON：`{"type":"input","data":"..."}` 或 `{"type":"resize","cols":80,"rows":24}`；服务端发 `{"type":"output","data":"..."}` 或 `{"type":"error","message":"..."}`。SSH 申请 PTY、启动 shell，双向转发字节；resize 调用 SSH window change。WebSocket 断开时释放 shell。
3. `GET /api/sessions/{id}/files?path=/root`，通过 SFTP 读取目录，返回 `{path:"/root", entries:[{name:"Dataset", type:"directory", size:0, modifiedAt:"2026-01-01T00:00:00Z"}]}`。`type` 为 `directory` 或 `file`。path 返回服务端解析后的绝对路径。
4. `POST /api/sessions/{id}/files?path=/root/Dataset` 接收 multipart/form-data 的 `file` 字段，通过 SFTP 流式写入目标目录，成功返回 2xx，失败返回 `{message}`。可选 `relative` 字段与 `file` 顺序一致，值为相对路径（如 `project/src/main.go`），用于保留文件夹层级；后端会创建所需父目录。前端对多个文件并发发请求（最多 3 个）；后端可用有限 worker 控制并发。先实现单文件流式传输，再测量瓶颈，避免无限 goroutine 和整文件读入内存。
5. `GET /api/sessions/{id}/download` 的 `path` 可以是文件或目录。文件下载到 `local` 目录；目录会递归下载，并在 `local` 下保留原目录名和内部结构。本地已存在同名文件时返回错误，避免覆盖。
6. `DELETE /api/sessions/{id}` 关闭 SFTP、SSH 和相关资源。会话断开、超时也要清理。

错误统一用非 2xx 状态码和 JSON `{message}`。目录名和文件名以数据处理，不要拼接 shell 命令。验证文件名、路径及上传冲突策略。SSH 主机密钥应校验并提供首次信任流程；不要使用无条件接受所有主机密钥的配置。仅监听本机、限制来源并保护会话接口，避免网页或其他进程滥用本地 SSH 服务。密码和私钥不要记录到日志。

界面为三栏：未连接时左侧是连接列表，中间是快速连接；连接后左侧切换为当前目录文件列表和面包屑，中间是终端，传输队列默认收在右侧窄条，有任务时展开并挤占终端宽度。当前前端支持上传文件、上传文件夹（递归保留目录结构）和递归下载文件夹；空目录不会上传。上传进度为浏览器到 Go 服务的进度，不能代表服务端到 SSH 主机的完成进度。浏览器刷新后需重新连接。生产部署需要由 Go 提供前端静态文件，并根据实际部署配置同源访问。
