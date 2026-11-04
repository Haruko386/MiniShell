# MiniShell

## Download

Download from [Latest Release](https://github.com/Haruko386/MiniShell/releases/latest):

- Windows desktop: `MiniShell-windows-amd64.zip` — extract and run `MiniShell.exe`
- Server: `minishell-windows-amd64.exe`, `minishell-linux-amd64`, `minishell-linux-arm64`, `minishell-darwin-amd64`, `minishell-darwin-arm64`

## Build from source

Requirements: Go 1.26+, Node.js 22+. The Windows desktop build also requires WebView2 Runtime and Wails v2.

### Desktop

```powershell
go install github.com/wailsapp/wails/v2/cmd/wails@v2.11.0

cd desktop/frontend
npm ci
npm run build

cd ..
wails build -clean -platform windows/amd64 -o MiniShell.exe
```

Output: `desktop/build/bin/MiniShell.exe`.

### Server

```powershell
go build -trimpath -ldflags="-s -w" -o minishell.exe .
```

Output: `minishell.exe`.
