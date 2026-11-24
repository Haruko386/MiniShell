package handler

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/Haruko386/MiniShell/internal/entity"
	"github.com/Haruko386/MiniShell/internal/service"
	"github.com/gin-gonic/gin"
)

const disksTimeout = 4 * time.Second

type DiskHandler struct {
	sessionSvr *service.SessionSvr
}

func NewDiskHandler(sessionSvr *service.SessionSvr) *DiskHandler {
	return &DiskHandler{
		sessionSvr: sessionSvr,
	}
}

func (h *DiskHandler) Get(c *gin.Context) {
	id := strings.TrimSpace(c.Param("id"))
	if id == "" {
		c.JSON(http.StatusBadRequest, gin.H{
			"message": "invalid session id",
		})
		return
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), disksTimeout)
	defer cancel()

	disks, err := h.sessionSvr.Disks(ctx, id)
	if err != nil {
		switch {
		case errors.Is(err, service.ErrSessionNotFound):
			c.JSON(http.StatusNotFound, gin.H{
				"message": err.Error(),
			})
		case errors.Is(err, entity.ErrDisksUnsupported):
			c.JSON(http.StatusNotImplemented, gin.H{
				"message": err.Error(),
			})
		case errors.Is(err, context.DeadlineExceeded):
			c.JSON(http.StatusGatewayTimeout, gin.H{
				"message": "collect remote disks: timeout",
			})
		case errors.Is(err, context.Canceled):
			return
		default:
			c.JSON(http.StatusBadGateway, gin.H{
				"message": err.Error(),
			})
		}
		return
	}

	c.JSON(http.StatusOK, disks)
}
