//go:build windows

package main

import (
	"archive/zip"
	"context"
	"debug/pe"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
	"golang.org/x/mod/semver"
)

const (
	latestReleaseURL = "https://api.github.com/repos/Haruko386/MiniShell/releases/latest"
	windowsAssetName = "MiniShell-windows-amd64.zip"
	maxUpdateSize    = 512 << 20
)

var (
	checkHTTPClient    = &http.Client{Timeout: 10 * time.Second}
	downloadHTTPClient = &http.Client{Timeout: 10 * time.Minute}
)

type UpdateInfo struct {
	Current    string `json:"current"`
	Latest     string `json:"latest"`
	Available  bool   `json:"available"`
	ReleaseURL string `json:"releaseUrl"`
	Notes      string `json:"notes"`
	AssetName  string `json:"assetName"`
	AssetSize  int64  `json:"assetSize"`
	AssetURL   string `json:"assetUrl"`
}

type UpdateProgress struct {
	Stage   string `json:"stage"`
	Percent int    `json:"percent"`
	Message string `json:"message,omitempty"`
}

type githubRelease struct {
	TagName string `json:"tag_name"`
	HTMLURL string `json:"html_url"`
	Body    string `json:"body"`
	Assets  []struct {
		Name               string `json:"name"`
		Size               int64  `json:"size"`
		BrowserDownloadURL string `json:"browser_download_url"`
	} `json:"assets"`
}

var updateState = struct {
	sync.Mutex
	info       UpdateInfo
	installing bool
}{}

// CheckForUpdate 查询 GitHub 最新 release，并与当前版本比较。
func (a *App) CheckForUpdate() (UpdateInfo, error) {
	info := UpdateInfo{Current: version}
	current := normalizeVersion(version)
	if current == "" {
		// dev 或非法版本：不提示更新。
		return info, nil
	}

	release, err := fetchLatestRelease()
	if err != nil {
		return UpdateInfo{}, err
	}
	latest := normalizeVersion(release.TagName)
	if latest == "" {
		return UpdateInfo{}, fmt.Errorf("release tag is not semver: %q", release.TagName)
	}

	info.Latest = release.TagName
	info.ReleaseURL = release.HTMLURL
	info.Notes = release.Body
	for _, asset := range release.Assets {
		if asset.Name == windowsAssetName {
			info.AssetName = asset.Name
			info.AssetSize = asset.Size
			info.AssetURL = asset.BrowserDownloadURL
			break
		}
	}
	if info.AssetURL == "" {
		return UpdateInfo{}, fmt.Errorf("release %s does not contain %s", release.TagName, windowsAssetName)
	}

	info.Available = semver.Compare(current, latest) < 0

	updateState.Lock()
	updateState.info = info
	updateState.Unlock()
	return info, nil
}

// InstallUpdate 下载并解压新版本，然后启动 updater 脚本；调用返回后由前端退出应用。
func (a *App) InstallUpdate() error {
	updateState.Lock()
	if updateState.installing {
		updateState.Unlock()
		return errors.New("update already in progress")
	}
	info := updateState.info
	updateState.Unlock()

	if !info.Available || info.AssetURL == "" {
		var err error
		info, err = a.CheckForUpdate()
		if err != nil {
			return err
		}
	}
	if !info.Available || info.AssetURL == "" {
		return errors.New("no update available")
	}

	updateState.Lock()
	if updateState.installing {
		updateState.Unlock()
		return errors.New("update already in progress")
	}
	updateState.installing = true
	updateState.Unlock()
	defer func() {
		updateState.Lock()
		updateState.installing = false
		updateState.Unlock()
	}()

	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("locate executable: %w", err)
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}

	// 提前确认安装目录可写，避免下载完才失败。
	probe, err := os.CreateTemp(filepath.Dir(exe), ".minishell-write-*")
	if err != nil {
		return fmt.Errorf("install directory is not writable: %w", err)
	}
	probePath := probe.Name()
	_ = probe.Close()
	_ = os.Remove(probePath)

	workDir, err := os.MkdirTemp("", "minishell-update-*")
	if err != nil {
		return fmt.Errorf("create update temp dir: %w", err)
	}

	// 只有成功启动 updater 后，临时目录才交给脚本清理。
	launched := false
	defer func() {
		if !launched {
			_ = os.RemoveAll(workDir)
		}
	}()

	zipPath := filepath.Join(workDir, "update.zip")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	if err := a.downloadUpdate(ctx, info, zipPath); err != nil {
		return err
	}

	a.emitUpdateProgress("extract", 0, "")
	newExe := filepath.Join(workDir, "MiniShell.exe")
	if err := extractUpdate(zipPath, newExe); err != nil {
		return err
	}

	a.emitUpdateProgress("apply", 0, "")
	scriptPath, err := writeUpdaterScript(os.Getpid(), exe, newExe, workDir)
	if err != nil {
		return err
	}
	if err := startUpdater(scriptPath); err != nil {
		_ = os.Remove(scriptPath)
		return err
	}

	launched = true
	a.emitUpdateProgress("restart", 0, "")
	return nil
}

func fetchLatestRelease() (*githubRelease, error) {
	req, err := http.NewRequest(http.MethodGet, latestReleaseURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "MiniShell/"+strings.TrimPrefix(version, "v"))

	resp, err := checkHTTPClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request latest release: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return nil, fmt.Errorf("latest release: %s: %s", resp.Status, strings.TrimSpace(string(body)))
	}

	var release githubRelease
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&release); err != nil {
		return nil, fmt.Errorf("decode latest release: %w", err)
	}
	return &release, nil
}

func (a *App) downloadUpdate(ctx context.Context, info UpdateInfo, dest string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, info.AssetURL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "MiniShell/"+strings.TrimPrefix(version, "v"))
	// 避免自动 gzip 导致 Content-Length 和实际写入字节不一致。
	req.Header.Set("Accept-Encoding", "identity")

	resp, err := downloadHTTPClient.Do(req)
	if err != nil {
		return fmt.Errorf("download update: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return fmt.Errorf("download update: %s: %s", resp.Status, strings.TrimSpace(string(body)))
	}

	total := resp.ContentLength
	if total <= 0 {
		total = info.AssetSize
	}
	a.emitUpdateProgress("download", 0, "")

	out, err := os.Create(dest)
	if err != nil {
		return err
	}
	defer func() { _ = out.Close() }()

	buf := make([]byte, 64*1024)
	var written int64
	lastPercent := -1
	body := io.LimitReader(resp.Body, total)

	for {
		n, readErr := body.Read(buf)
		if n > 0 {
			if _, err := out.Write(buf[:n]); err != nil {
				return err
			}
			written += int64(n)
			if total > 0 {
				percent := int(written * 100 / total)
				if percent >= lastPercent+5 || percent == 100 {
					lastPercent = percent
					a.emitUpdateProgress("download", percent, "")
				}
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return readErr
		}
	}

	if err := out.Close(); err != nil {
		return err
	}
	if written > maxUpdateSize {
		return errors.New("update archive is too large")
	}
	if info.AssetSize > 0 && written != info.AssetSize {
		return fmt.Errorf("download size mismatch: got %d, want %d", written, info.AssetSize)
	}
	a.emitUpdateProgress("download", 100, "")
	return nil
}

func extractUpdate(zipPath, dest string) error {
	zr, err := zip.OpenReader(zipPath)
	if err != nil {
		return fmt.Errorf("open update zip: %w", err)
	}
	defer zr.Close()

	var entry *zip.File
	for _, f := range zr.File {
		if f.FileInfo().IsDir() || !strings.EqualFold(filepath.Base(f.Name), "MiniShell.exe") {
			continue
		}
		if entry != nil {
			return errors.New("update zip contains multiple MiniShell.exe files")
		}
		entry = f
	}
	if entry == nil {
		return errors.New("update zip does not contain MiniShell.exe")
	}
	if entry.UncompressedSize64 > maxUpdateSize {
		return errors.New("update executable is too large")
	}

	rc, err := entry.Open()
	if err != nil {
		return fmt.Errorf("open update executable: %w", err)
	}
	defer rc.Close()

	out, err := os.OpenFile(dest, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
	if err != nil {
		return err
	}
	defer func() { _ = out.Close() }()

	written, copyErr := io.Copy(out, io.LimitReader(rc, maxUpdateSize+1))
	closeErr := out.Close()
	if copyErr != nil {
		return copyErr
	}
	if closeErr != nil {
		return closeErr
	}
	if written > maxUpdateSize {
		return errors.New("update executable is too large")
	}

	return validateExecutable(dest)
}

func validateExecutable(path string) (err error) {
	// debug/pe is not hardened against malformed input; keep a panic from
	// turning into a crashed update process.
	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("invalid Windows executable: %v", recovered)
		}
	}()

	file, err := pe.Open(path)
	if err != nil {
		return fmt.Errorf("invalid Windows executable: %w", err)
	}
	defer file.Close()

	if file.Machine != pe.IMAGE_FILE_MACHINE_AMD64 {
		return fmt.Errorf("unexpected executable architecture: 0x%x", file.Machine)
	}
	if file.Characteristics&pe.IMAGE_FILE_EXECUTABLE_IMAGE == 0 {
		return errors.New("update is not an executable image")
	}
	if file.Characteristics&pe.IMAGE_FILE_DLL != 0 {
		return errors.New("update is a DLL, not an application")
	}
	if len(file.Sections) == 0 || file.Section(".text") == nil {
		return errors.New("update executable has no code sections")
	}
	header, ok := file.OptionalHeader.(*pe.OptionalHeader64)
	if !ok {
		return errors.New("update executable is not PE32+")
	}
	if header.AddressOfEntryPoint == 0 {
		return errors.New("update executable has no entry point")
	}

	entryInCode := false
	for _, section := range file.Sections {
		if section.Characteristics&pe.IMAGE_SCN_CNT_CODE == 0 {
			continue
		}

		size := section.VirtualSize
		if size == 0 {
			size = section.Size
		}

		if header.AddressOfEntryPoint >= section.VirtualAddress && header.AddressOfEntryPoint-section.VirtualAddress < size {
			entryInCode = true
			break
		}
	}
	if !entryInCode {
		return errors.New("update executable entry point is outside code sections")
	}

	stat, err := os.Stat(path)
	if err != nil {
		return err
	}
	fileSize := uint64(stat.Size())
	if uint64(header.SizeOfHeaders) > fileSize {
		return errors.New("update executable has an invalid header size")
	}
	for _, section := range file.Sections {
		if section.Size == 0 {
			continue
		}
		end := uint64(section.Offset) + uint64(section.Size)
		if end < uint64(section.Offset) || end > fileSize {
			return errors.New("update executable has truncated section data")
		}
	}
	return nil
}

func writeUpdaterScript(pid int, target, source, workDir string) (string, error) {
	script, err := os.CreateTemp("", "minishell-update-*.ps1")
	if err != nil {
		return "", err
	}
	path := script.Name()

	content := fmt.Sprintf(`$ErrorActionPreference = 'Stop'
$pidToWait = %d
$target = %s
$source = %s
$work = %s
$staging = "${target}.new"
$backup = Join-Path $work 'previous.exe'
$log = $null
try {
    $logDir = Join-Path $env:LOCALAPPDATA 'MiniShell'
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    $log = Join-Path $logDir 'update.log'
} catch {
    $log = $null
}
try {
    Wait-Process -Id $pidToWait -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 400

    # Keep the current executable so we can roll back on failure.
    Copy-Item -LiteralPath $target -Destination $backup -Force

    $copied = $false
    for ($i = 0; $i -lt 20; $i++) {
        try {
            Copy-Item -LiteralPath $source -Destination $staging -Force
            $copied = $true
            break
        } catch {
            Start-Sleep -Milliseconds 300
        }
    }
    if (-not $copied) { throw 'could not stage MiniShell.exe' }

    $sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
    $stagingHash = (Get-FileHash -LiteralPath $staging -Algorithm SHA256).Hash
    if ($sourceHash -ne $stagingHash) { throw 'staged MiniShell.exe checksum mismatch' }

    # Replace the target only after the staged copy is complete.
    Move-Item -LiteralPath $staging -Destination $target -Force
    $targetHash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
    if ($targetHash -ne $stagingHash) { throw 'installed MiniShell.exe checksum mismatch' }
    $proc = Start-Process -FilePath $target -WorkingDirectory (Split-Path -Parent $target) -PassThru
	Start-Sleep -Seconds 3
	if ($proc.HasExited) { throw 'updated MiniShell.exe exited during startup' }
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
} catch {
	$keepWork = $true
    try {
        if (Test-Path -LiteralPath $backup) {
            Copy-Item -LiteralPath $backup -Destination $target -Force
        }
        $keepWork = $false
    } catch {
    }
    Remove-Item -LiteralPath $staging -Force -ErrorAction SilentlyContinue
    try {
        Start-Process -FilePath $target -WorkingDirectory (Split-Path -Parent $target)
    } catch {
    }
    if ($log) {
        try {
            Add-Content -LiteralPath $log -Value ("[{0}] update failed: {1}" -f (Get-Date -Format s), $_)
        } catch {
        }
    }
    if (-not $keepWork) {
        Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
}
`, pid, psQuote(target), psQuote(source), psQuote(workDir))

	// Windows PowerShell 5.1 需要 BOM 才能正确读取中文/非 ASCII 路径。
	if _, err := script.Write(append([]byte{0xEF, 0xBB, 0xBF}, []byte(content)...)); err != nil {
		_ = script.Close()
		_ = os.Remove(path)
		return "", err
	}
	if err := script.Close(); err != nil {
		_ = os.Remove(path)
		return "", err
	}
	return path, nil
}

func startUpdater(scriptPath string) error {
	const (
		createNoWindow        = 0x08000000
		createNewProcessGroup = 0x00000200
	)

	cmd := exec.Command(
		"powershell.exe",
		"-NoProfile",
		"-NonInteractive",
		"-ExecutionPolicy", "Bypass",
		"-File", scriptPath,
	)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: createNoWindow | createNewProcessGroup,
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start updater: %w", err)
	}
	_ = cmd.Process.Release()
	return nil
}

func (a *App) emitUpdateProgress(stage string, percent int, message string) {
	if a.ctx == nil {
		return
	}
	if percent < 0 {
		percent = 0
	}
	if percent > 100 {
		percent = 100
	}
	wailsruntime.EventsEmit(a.ctx, "update:progress", UpdateProgress{
		Stage:   stage,
		Percent: percent,
		Message: message,
	})
}

func normalizeVersion(value string) string {
	value = strings.TrimSpace(value)
	if value == "" || strings.EqualFold(value, "dev") {
		return ""
	}
	if !strings.HasPrefix(value, "v") {
		value = "v" + value
	}
	if !semver.IsValid(value) {
		return ""
	}
	return value
}

func psQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}
