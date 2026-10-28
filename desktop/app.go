package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/Haruko386/MiniShell/internal"
	"github.com/Haruko386/MiniShell/internal/service"
	"github.com/gin-gonic/gin"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

type App struct {
	ctx         context.Context
	server      *http.Server
	router      *internal.Router
	base, token string
}

func NewApp() *App                         { return &App{} }
func (a *App) startup(ctx context.Context) { a.ctx = ctx }
func (a *App) shutdown(ctx context.Context) {
	if a.server != nil {
		_ = a.server.Shutdown(ctx)
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
	engine := gin.New()
	engine.Use(gin.Recovery())
	a.router = internal.NewRouter(service.NewSessionSvr(), service.NewFileSvr())
	a.router.Setup(engine)
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
		engine.ServeHTTP(w, r)
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
func (a *App) UploadFile(session, remoteDir, localPath string) error {
	f, err := os.Open(localPath)
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("只支持上传普通文件: %s", localPath)
	}
	pr, pw := io.Pipe()
	mw := multipart.NewWriter(pw)
	go func() {
		part, err := mw.CreateFormFile("file", filepath.Base(localPath))
		if err == nil {
			_, err = io.Copy(part, f)
		}
		if err == nil {
			err = mw.Close()
		}
		_ = pw.CloseWithError(err)
	}()
	req, err := http.NewRequest("POST", a.base+"/api/sessions/"+session+"/files", pr)
	if err != nil {
		_ = pr.Close()
		return err
	}
	q := req.URL.Query()
	q.Set("path", remoteDir)
	req.URL.RawQuery = q.Encode()
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("X-Minishell-Token", a.token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		_ = pr.Close()
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		var msg struct {
			Message string `json:"message"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&msg)
		if msg.Message == "" {
			msg.Message = resp.Status
		}
		return fmt.Errorf("%s", msg.Message)
	}
	return nil
}
