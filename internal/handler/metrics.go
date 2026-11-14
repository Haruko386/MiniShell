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

const metricsTimeout = 4 * time.Second

type MetricsHandler struct {
	sessionSvr *service.SessionSvr
}

func NewMetricsHandler(sessionSvr *service.SessionSvr) *MetricsHandler {
	return &MetricsHandler{
		sessionSvr: sessionSvr,
	}
}

func (h *MetricsHandler) Get(c *gin.Context) {
	id := strings.TrimSpace(c.Param("id"))
	if id == "" {
		c.JSON(http.StatusBadRequest, gin.H{
			"message": "invalid session id",
		})
		return
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), metricsTimeout)
	defer cancel()

	metrics, err := h.sessionSvr.Metrics(ctx, id)
	if err != nil {
		switch {
		case errors.Is(err, service.ErrSessionNotFound):
			c.JSON(http.StatusNotFound, gin.H{
				"message": err.Error(),
			})
		case errors.Is(err, entity.ErrMetricsUnsupported):
			c.JSON(http.StatusNotImplemented, gin.H{
				"message": err.Error(),
			})
		case errors.Is(err, context.DeadlineExceeded):
			c.JSON(http.StatusGatewayTimeout, gin.H{
				"message": "collect remote metrics: timeout",
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

	c.JSON(http.StatusOK, metrics)
}
