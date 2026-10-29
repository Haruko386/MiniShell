package handler

import (
	"errors"
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

	sftpClient, err := h.sessionSvr.GetSFTP(id)
	if err != nil {
		status := http.StatusBadGateway
		if errors.Is(err, service.ErrSessionNotFound) {
			status = http.StatusNotFound
		}
		c.JSON(status, gin.H{
			"message": err.Error(),
		})
		return
	}

	realPath, entries, err := h.fileSvr.List(sftpClient, dirPath)
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

	sftpClient, err := h.sessionSvr.GetSFTP(id)
	if err != nil {
		status := http.StatusBadGateway
		if errors.Is(err, service.ErrSessionNotFound) {
			status = http.StatusNotFound
		}
		c.JSON(status, gin.H{
			"message": err.Error(),
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

	relativePaths := form.Value["relative"]
	if len(relativePaths) != 0 && len(relativePaths) != len(files) {
		c.JSON(http.StatusBadRequest, gin.H{
			"message": "file and relative path count mismatch",
		})
		return
	}

	uploads := make([]service.UploadFile, 0, len(files))

	for i, file := range files {
		relative := ""
		if len(relativePaths) == len(files) {
			relative = relativePaths[i] // keep the folder structure chosen by the client
		}

		uploads = append(uploads, service.UploadFile{
			Header:   file,
			Relative: relative,
		})
	}

	if err := h.fileSvr.Upload(sftpClient, dirPath, uploads); err != nil {
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

	sftpClient, err := h.sessionSvr.GetSFTP(id)
	if err != nil {
		status := http.StatusBadGateway
		if errors.Is(err, service.ErrSessionNotFound) {
			status = http.StatusNotFound
		}
		c.JSON(status, gin.H{
			"message": err.Error(),
		})
		return
	}

	if err := h.fileSvr.Download(sftpClient, dirPath, localPath); err != nil {
		c.JSON(http.StatusBadGateway, gin.H{
			"message": err.Error(),
		})
		return
	}

	c.Status(http.StatusOK)
}
