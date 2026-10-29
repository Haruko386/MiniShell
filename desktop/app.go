package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net"
	"net/http"
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
	sessions    *service.SessionSvr
	files       *service.FileSvr
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
	a.sessions = sessions
	a.files = files
	a.manager = engine.NewManager(sessions, files)
	if err := a.manager.Start(6); err != nil {
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
func (a *App) ChooseUploadDirectory() (string, error) {
	return runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{Title: "选择上传文件夹"})
}

type UploadTask struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Size int64  `json:"size"`
}

type UploadResult struct {
	Tasks           []UploadTask `json:"tasks"`
	Directories     int          `json:"directories"`
	Skipped         []string     `json:"skipped"`
	SubmissionError string       `json:"submissionError"`
}

// SubmitUpload scans a local file or folder, creates remote directories,
// then queues one task per regular file.
func (a *App) SubmitUpload(session, remoteDir, localPath string) (UploadResult, error) {
	return a.submitUpload(session, remoteDir, localPath, nil)
}

// SubmitUploadStreaming emits each accepted task so the UI can track it immediately.
func (a *App) SubmitUploadStreaming(session, remoteDir, localPath, requestID string) (UploadResult, error) {
	if requestID == "" {
		return UploadResult{}, fmt.Errorf("request ID is required")
	}
	return a.submitUpload(session, remoteDir, localPath, func(task UploadTask) {
		runtime.EventsEmit(a.ctx, "upload:task", UploadTaskEvent{RequestID: requestID, Task: task})
	})
}

type UploadTaskEvent struct {
	RequestID string     `json:"requestId"`
	Task      UploadTask `json:"task"`
}

func (a *App) submitUpload(session, remoteDir, localPath string, accepted func(UploadTask)) (UploadResult, error) {
	if !filepath.IsAbs(localPath) || !path.IsAbs(remoteDir) {
		return UploadResult{}, fmt.Errorf("local and remote paths must be absolute")
	}

	plan, err := buildUploadPlan(localPath, remoteDir)
	if err != nil {
		return UploadResult{}, err
	}

	if len(plan.dirs) > 0 {
		if a.sessions == nil || a.files == nil {
			return UploadResult{}, fmt.Errorf("file services are not initialized")
		}

		client, err := a.sessions.GetSFTP(session)
		if err != nil {
			return UploadResult{}, err
		}
		if err := a.files.MkdirAll(client, remoteDir, plan.dirs); err != nil {
			return UploadResult{}, err
		}
	}

	skipped := plan.skipped
	if skipped == nil {
		skipped = []string{}
	}

	result := UploadResult{
		Tasks:       make([]UploadTask, 0, len(plan.files)),
		Directories: len(plan.dirs),
		Skipped:     skipped,
	}

	return a.submitPlannedFiles(session, remoteDir, plan.files, result, accepted)
}

func (a *App) submitPlannedFiles(session, remoteDir string, files []uploadFile, result UploadResult, accepted func(UploadTask)) (UploadResult, error) {
	for _, file := range files {
		id, err := a.manager.Submit(a.ctx, entity.Task{
			SessionID:     session,
			Direction:     "upload",
			LocalPath:     file.localPath,
			RemotePath:    file.remotePath,
			RemoteBase:    remoteDir,
			VerifySource:  true,
			SourceSize:    file.size,
			SourceModTime: file.modTime,
		})
		if err != nil {
			if len(result.Tasks) == 0 {
				return result, err
			}
			result.SubmissionError = err.Error()
			return result, nil
		}

		task := UploadTask{ID: id, Name: file.name, Size: file.size}
		result.Tasks = append(result.Tasks, task)
		if accepted != nil {
			accepted(task)
		}
	}
	return result, nil
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
