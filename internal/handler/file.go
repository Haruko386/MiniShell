package handler

import (
	"context"
	"errors"
	"net/http"
	"path"
	"strings"
	"time"

	"github.com/Haruko386/MiniShell/internal/dto"
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

// List all files in remote server
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

	sftpClient, release, err := h.sessionSvr.AcquireSFTP(id)
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
	defer release()

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

func (h *FileHandler) Delete(c *gin.Context) {
	remotePath := c.Query("path")
	if remotePath == "" {
		c.JSON(http.StatusBadRequest, gin.H{"message": "invalid request path"})
		return
	}

	client, release, err := h.sessionSvr.AcquireSFTP(c.Param("id"))
	if err != nil {
		status := http.StatusBadGateway
		if errors.Is(err, service.ErrSessionNotFound) {
			status = http.StatusNotFound
		}
		c.JSON(status, gin.H{"message": err.Error()})
		return
	}

	defer release()
	if err := h.fileSvr.Delete(client, remotePath); err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"message": err.Error()})
		return
	}
	c.Status(http.StatusNoContent)
}

// Upload the file
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

	sftpClient, release, err := h.sessionSvr.AcquireSFTP(id)
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
	defer release()

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

// Preview the image
func (h *FileHandler) Preview(c *gin.Context) {
	id := strings.TrimSpace(c.Param("id"))
	if id == "" {
		c.JSON(http.StatusBadRequest, gin.H{
			"message": "invalid  request id",
		})
		return
	}

	imgPath := c.Query("path")
	if imgPath == "" {
		c.JSON(http.StatusBadRequest, gin.H{
			"message": "invalid request path",
		})
		return
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), 30*time.Second)
	defer cancel()
	data, err := h.sessionSvr.PreviewImage(ctx, id, imgPath, h.fileSvr)
	if err != nil {
		status := http.StatusBadGateway
		if errors.Is(err, service.ErrSessionNotFound) {
			status = http.StatusNotFound
		}
		if errors.Is(err, context.DeadlineExceeded) {
			status = http.StatusGatewayTimeout
		}
		if errors.Is(err, context.Canceled) {
			return
		}
		c.JSON(status, gin.H{
			"message": err.Error(),
		})
		return
	}

	contentType := http.DetectContentType(data)
	if contentType == "application/octet-stream" {
		ext := strings.ToLower(path.Ext(imgPath))
		switch ext {
		case ".jpg", ".jpeg":
			contentType = "image/jpeg"
		case ".png":
			contentType = "image/png"
		case ".gif":
			contentType = "image/gif"
		case ".webp":
			contentType = "image/webp"
		case ".bmp":
			contentType = "image/bmp"
		default:
			contentType = "application/octet-stream"
		}
	}
	c.Data(http.StatusOK, contentType, data)
}

// Download the files or dir from remote
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

	sftpClient, release, err := h.sessionSvr.AcquireSFTP(id)
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
	defer release()

	if err := h.fileSvr.Download(sftpClient, dirPath, localPath); err != nil {
		c.JSON(http.StatusBadGateway, gin.H{
			"message": err.Error(),
		})
		return
	}

	c.Status(http.StatusOK)
}

func (h *FileHandler) GetFile(c *gin.Context) {
	id := strings.TrimSpace(c.Param("id"))
	if id == "" {
		c.JSON(http.StatusBadRequest, gin.H{
			"message": "invalid request id",
		})
		return
	}

	filePath := c.Query("path")
	if strings.TrimSpace(filePath) == "" || !path.IsAbs(filePath) {
		c.JSON(http.StatusBadRequest, gin.H{
			"message": "invalid file path",
		})
		return
	}

	sftpClient, release, err := h.sessionSvr.AcquireSFTP(id)
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
	defer release()

	data, version, err := h.fileSvr.GetContent(sftpClient, filePath)
	if err != nil {
		status := http.StatusBadGateway
		switch {
		case errors.Is(err, service.ErrFileTooLarge):
			status = http.StatusRequestEntityTooLarge
		case errors.Is(err, service.ErrNotTextFile):
			status = http.StatusUnsupportedMediaType
		}
		c.JSON(status, gin.H{
			"message": err.Error(),
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"content": string(data),
		"version": version,
	})
}

func (h *FileHandler) WriteFile(c *gin.Context) {
	id := strings.TrimSpace(c.Param("id"))
	if id == "" {
		c.JSON(http.StatusBadRequest, gin.H{
			"message": "invalid request id",
		})
		return
	}

	filePath := c.Query("path")
	if strings.TrimSpace(filePath) == "" || !path.IsAbs(filePath) {
		c.JSON(http.StatusBadRequest, gin.H{
			"message": "invalid request path",
		})
		return
	}

	var req dto.GetFileRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"message": err.Error(),
		})
		return
	}
	if req.Version == "" {
		c.JSON(http.StatusBadRequest, gin.H{
			"message": "version is required",
		})
		return
	}
	// A missing content field must be rejected, but an explicit empty
	// string is a valid request to clear the file.
	if req.Content == nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"message": "content is required",
		})
		return
	}

	version, err := h.sessionSvr.WriteFileContent(id, h.fileSvr, filePath, req.Version, *req.Content)
	if err != nil {
		status := http.StatusBadGateway
		switch {
		case errors.Is(err, service.ErrFileChanged):
			status = http.StatusConflict
		case errors.Is(err, service.ErrFileTooLarge):
			status = http.StatusRequestEntityTooLarge
		case errors.Is(err, service.ErrNotTextFile):
			status = http.StatusUnsupportedMediaType
		case errors.Is(err, service.ErrSessionNotFound):
			status = http.StatusNotFound
		}
		c.JSON(status, gin.H{
			"message": err.Error(),
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"version": version,
	})
}
