package internal

import (
	"net/http"

	"github.com/Haruko386/MiniShell/internal/handler"
	"github.com/Haruko386/MiniShell/internal/service"
	"github.com/gin-gonic/gin"
)

type Router struct {
	sessionHandler *handler.SessionHandler
	fileHandler    *handler.FileHandler
	sessionSvr     *service.SessionSvr
}

func NewRouter(sessionSvr *service.SessionSvr, fileSvr *service.FileSvr) *Router {

	return &Router{
		sessionHandler: handler.NewSessionHandler(sessionSvr),
		fileHandler:    handler.NewFileHandler(sessionSvr, fileSvr),
		sessionSvr:     sessionSvr,
	}
}

func (r *Router) Setup(e *gin.Engine) {
	api := e.Group("/api")
	{
		api.GET("/health", func(c *gin.Context) {
			c.JSON(http.StatusOK, gin.H{
				"status": "ok",
			})
		})

		sessions := api.Group("/sessions")
		{
			sessions.POST("", r.sessionHandler.Connect)
			sessions.DELETE("/:id", r.sessionHandler.Close)
			sessions.GET("/:id/terminal", r.sessionHandler.Terminal)
			sessions.GET("/:id/files", r.fileHandler.List)
			sessions.DELETE("/:id/files", r.fileHandler.Delete)
			sessions.POST("/:id/files", r.fileHandler.Upload)
			sessions.GET("/:id/download", r.fileHandler.Download)
			sessions.GET("/:id/preview", r.fileHandler.Preview)
		}
	}
}

func (r *Router) Close() {
	r.sessionSvr.CloseAll()
}
