# MiniShell 桌面端

Windows 桌面端使用 Wails v2、TypeScript 和项目现有 Go 服务。运行需要 WebView2 Runtime。

## 构建和运行

```powershell
cd E:\MiniShell\desktop\frontend
npm install
npm run build
cd ..
go build -tags production -o build/MiniShell.exe .
.\build\MiniShell.exe
```

前端构建结果嵌入程序，无需启动 web 的 Vite 或根目录的 HTTP 服务。也可安装 Wails v2 CLI 后使用 `wails dev`。

## 操作

保存连接后点击连接。首次连接未知主机时会显示主机密钥指纹，可选择取消、仅本次接受或永久写入 `~/.ssh/known_hosts`；同类主机密钥发生变化时会提示当前与已保存的指纹，可选择取消、仅本次连接或替换旧记录。支持拖入普通文件或文件夹、选择文件或文件夹上传。文件夹由 Go 递归扫描，先在远端创建目录（包括空目录），再把每个普通文件提交给 Manager；符号链接和特殊文件会被跳过并提示。文件列表可以单击、Ctrl 或 Shift 选择文件，再点击下载选中并选择本地目录。文件夹下载的界面入口尚未实现。普通文件的上传和下载通过 Go Manager 任务队列处理，当前启动 6 个 worker；并发数后续需要通过测试调整。队列显示任务状态、上传进度和速度；下载暂无字节级进度。

桌面端连接配置及密码保存在 WebView 的 localStorage 中，密码为明文。首次连接仍需在用户的 SSH known_hosts 中信任对应主机密钥。下载使用现有后端的重名拒绝策略。
