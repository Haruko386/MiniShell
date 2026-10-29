package handler

import (
	"errors"
	"net/http"
	"strings"

	"github.com/Haruko386/MiniShell/internal/dto"
	"github.com/Haruko386/MiniShell/internal/service"
	"github.com/gin-gonic/gin"
)

type SessionHandler struct {
	sessionSvr *service.SessionSvr
}

func NewSessionHandler(sessionSvr *service.SessionSvr) *SessionHandler {
	return &SessionHandler{
		sessionSvr: sessionSvr,
	}
}

// Connect to remote ssh
func (h *SessionHandler) Connect(c *gin.Context) {
	var req dto.CreateSessionRequest

	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"error":   err.Error(),
			"message": "invalid request body",
		})
		return
	}

	req.Host = strings.TrimSpace(req.Host)
	req.Username = strings.TrimSpace(req.Username)

	switch {
	case req.Host == "":
		c.JSON(http.StatusBadRequest, gin.H{
			"message": "invalid request Host",
		})
		return

	case req.Username == "":
		c.JSON(http.StatusBadRequest, gin.H{
			"message": "invalid request Username",
		})
		return

	case req.Password == "":
		c.JSON(http.StatusBadRequest, gin.H{
			"message": "invalid request Password",
		})
		return

	case req.Port < 1 || req.Port > 65535:
		c.JSON(http.StatusBadRequest, gin.H{
			"message": "invalid request Port",
		})
		return

	case req.HostKeyMode != "" && req.HostKeyMode != service.HostKeyModeOnce && req.HostKeyMode != service.HostKeyModeSave && req.HostKeyMode != service.HostKeyModeReplace:
		c.JSON(http.StatusBadRequest, gin.H{
			"message": "invalid host key mode",
		})
		return

	case req.HostKeyMode != "" && req.HostKeyFingerprint == "":
		c.JSON(http.StatusBadRequest, gin.H{
			"message": "host key fingerprint is required",
		})
		return
	}

	id, err := h.sessionSvr.Connect(req.Host, req.Username, req.Password, req.Port, service.HostKeyPolicy{
		Mode:        req.HostKeyMode,
		Fingerprint: req.HostKeyFingerprint,
	})
	if err != nil {
		var hostKeyErr *service.HostKeyError
		if errors.As(err, &hostKeyErr) {
			known := hostKeyErr.Known
			if known == nil {
				known = []string{}
			}

			c.JSON(http.StatusConflict, gin.H{
				"message": hostKeyErr.Error(),
				"hostKey": gin.H{
					"host":        hostKeyErr.Host,
					"port":        hostKeyErr.Port,
					"keyType":     hostKeyErr.KeyType,
					"fingerprint": hostKeyErr.Fingerprint,
					"changed":     hostKeyErr.Changed,
					"known":       known,
				},
			})
			return
		}

		c.JSON(http.StatusBadGateway, gin.H{
			"message": "ssh connection error: " + err.Error(),
		})
		return
	}

	c.JSON(http.StatusCreated, gin.H{
		"id":      id,
		"message": "success",
	})
}

// Close the connection
func (h *SessionHandler) Close(c *gin.Context) {
	id := strings.TrimSpace(c.Param("id"))
	if id == "" {
		c.JSON(http.StatusBadRequest, gin.H{
			"message": "invalid request ID",
		})
		return
	}

	if err := h.sessionSvr.Close(id); err != nil {
		c.JSON(http.StatusNotFound, gin.H{
			"message": err.Error(),
		})
		return
	}

	c.Status(http.StatusNoContent)
}
