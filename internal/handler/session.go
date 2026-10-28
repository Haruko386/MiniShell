package handler

import (
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
	}

	id, err := h.sessionSvr.Connect(req.Host, req.Username, req.Password, req.Port)
	if err != nil {
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
