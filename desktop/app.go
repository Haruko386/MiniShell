package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/Haruko386/MiniShell/internal"
	"github.com/Haruko386/MiniShell/internal/engine"
	"github.com/Haruko386/MiniShell/internal/entity"
	"github.com/Haruko386/MiniShell/internal/service"
	"github.com/gin-gonic/gin"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

type App struct {
	ctx         context.Context
	server      *http.Server
	router      *internal.Router
	manager     *engine.Manager
	base, token string
}

func NewApp() *App                         { return &App{} }
func (a *App) startup(ctx context.Context) { a.ctx = ctx }
func (a *App) shutdown(ctx context.Context) {
	if a.server != nil {
		_ = a.server.Shutdown(ctx)
	}
	if a.manager != nil {
		a.manager.Stop()
	}
	if a.router != nil {
		a.router.Close()
	}
}
func (a *App) startServer() error {
	token := make([]byte, 32)
	if _, err := rand.Read(token); err != nil {
		return err
	}
	a.token = hex.EncodeToString(token)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	a.base = "http://" + ln.Addr().String()
	httpEngine := gin.New()
	httpEngine.Use(gin.Recovery())
	sessions := service.NewSessionSvr()
	files := service.NewFileSvr()
	a.manager = engine.NewManager(sessions, files)
	if err := a.manager.Start(550); err != nil {
		_ = ln.Close()
		return err
	}
	a.router = internal.NewRouter(sessions, files)
	a.router.Setup(httpEngine)
	a.server = &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" && origin != "http://wails.localhost" && origin != "http://localhost:34115" {
			http.Error(w, "invalid origin", http.StatusForbidden)
			return
		}
		if origin != "" {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-Minishell-Token")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.Header.Get("X-Minishell-Token") != a.token && r.URL.Query().Get("token") != a.token {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		if strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
			r.Header.Set("Origin", "http://localhost:5173")
		}
		httpEngine.ServeHTTP(w, r)
	})}
	go func() { _ = a.server.Serve(ln) }()
	return nil
}

type BackendInfo struct {
	Base  string `json:"base"`
	Token string `json:"token"`
}

func (a *App) Backend() BackendInfo { return BackendInfo{a.base, a.token} }
func (a *App) ChooseDirectory() (string, error) {
	return runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{Title: "选择下载目录"})
}
func (a *App) ChooseFiles() ([]string, error) {
	return runtime.OpenMultipleFilesDialog(a.ctx, runtime.OpenDialogOptions{Title: "选择上传文件"})
}

// SubmitUpload queues one local file for transfer to the remote directory.
func (a *App) SubmitUpload(session, remoteDir, localPath string) (string, error) {
	if !filepath.IsAbs(localPath) || !path.IsAbs(remoteDir) {
		return "", fmt.Errorf("local and remote paths must be absolute")
	}
	info, err := os.Stat(localPath)
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("only regular files can be uploaded: %s", localPath)
	}
	return a.manager.Submit(a.ctx, entity.Task{SessionID: session, Direction: "upload", LocalPath: localPath, RemotePath: path.Join(remoteDir, filepath.Base(localPath))})
}

// SubmitDownload queues one remote file for download to a local directory.
func (a *App) SubmitDownload(session, remotePath, localDir string) (string, error) {
	if !path.IsAbs(remotePath) || !filepath.IsAbs(localDir) {
		return "", fmt.Errorf("local and remote paths must be absolute")
	}
	return a.manager.Submit(a.ctx, entity.Task{SessionID: session, Direction: "download", LocalPath: localDir, RemotePath: remotePath})
}

type TransferStatus struct {
	Status           string `json:"status"`
	Error            string `json:"error"`
	TransferredBytes int64  `json:"transferredBytes"`
	TotalBytes       int64  `json:"totalBytes"`
}

// TransferStatus returns a serializable snapshot of a queued task.
func (a *App) TransferStatus(id string) (TransferStatus, error) {
	status, ok := a.manager.GetStatus(id)
	if !ok {
		return TransferStatus{}, fmt.Errorf("task not found: %s", id)
	}
	result := TransferStatus{Status: status.Status, TransferredBytes: status.TransferredBytes, TotalBytes: status.TotalBytes}
	if status.Error != nil {
		result.Error = status.Error.Error()
	}
	return result, nil
}
