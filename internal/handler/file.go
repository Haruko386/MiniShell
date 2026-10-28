package handler

import (
	"net/http"
	"strings"

	"github.com/Haruko386/MiniShell/internal/service"
	"github.com/gin-gonic/gin"
)

type FileHandler struct {
	sessionSvr *service.SessionSvr
	fileSvr    *service.FileSvr
}

func NewFileHandler(sessionSvr *service.SessionSvr, fileSvr *service.FileSvr) *FileHandler {
	return &FileHandler{
		sessionSvr: sessionSvr,
		fileSvr:    fileSvr,
	}
}

func (h *FileHandler) List(c *gin.Context) {
	id := strings.TrimSpace(c.Param("id"))
	if id == "" {
		c.JSON(http.StatusBadRequest, gin.H{
			"message": "invalid request id",
		})
		return
	}

	dirPath := strings.TrimSpace(c.Query("path"))
	if dirPath == "" {
		c.JSON(http.StatusBadRequest, gin.H{
			"message": "invalid request path",
		})
		return
	}

	sshClient, ok := h.sessionSvr.Get(id)
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{
			"message": "session not found",
		})
		return
	}

	realPath, entries, err := h.fileSvr.List(sshClient, dirPath)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{
			"message": "list remote files error: " + err.Error(),
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"path":    realPath,
		"entries": entries,
	})
}

func (h *FileHandler) Upload(c *gin.Context) {
	id := strings.TrimSpace(c.Param("id"))
	if id == "" {
		c.JSON(http.StatusBadRequest, gin.H{
			"message": "invalid request id",
		})
		return
	}

	dirPath := strings.TrimSpace(c.Query("path"))
	if dirPath == "" {
		c.JSON(http.StatusBadRequest, gin.H{
			"message": "invalid request path",
		})
		return
	}

	sshClient, ok := h.sessionSvr.Get(id)
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{
			"message": "session not found",
		})
		return
	}

	form, err := c.MultipartForm()
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"message": err.Error(),
		})
		return
	}

	files := form.File["file"]
	if len(files) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{
			"message": "no files to upload",
		})
		return
	}

	if err := h.fileSvr.Upload(sshClient, dirPath, files); err != nil {
		c.JSON(http.StatusBadGateway, gin.H{
			"message": err.Error(),
		})
		return
	}

	c.Status(http.StatusOK)
}

func (h *FileHandler) Download(c *gin.Context) {
	id := strings.TrimSpace(c.Param("id"))
	if id == "" {
		c.JSON(http.StatusBadRequest, gin.H{
			"message": "invalid request id",
		})
		return
	}

	dirPath := strings.TrimSpace(c.Query("path"))
	if dirPath == "" {
		c.JSON(http.StatusBadRequest, gin.H{
			"message": "invalid request path",
		})
		return
	}

	localPath := strings.TrimSpace(c.Query("local"))
	if localPath == "" {
		c.JSON(http.StatusBadRequest, gin.H{
			"message": "invalid request path",
		})
		return
	}

	sshClient, ok := h.sessionSvr.Get(id)
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{
			"message": "session not found",
		})
		return
	}

	if err := h.fileSvr.Download(sshClient, dirPath, localPath); err != nil {
		c.JSON(http.StatusBadGateway, gin.H{
			"message": err.Error(),
		})
		return
	}

	c.Status(http.StatusOK)
}
