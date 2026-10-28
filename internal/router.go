package internal

import (
	"github.com/Haruko386/MiniShell/internal/handler"
	"github.com/Haruko386/MiniShell/internal/service"
	"github.com/gin-gonic/gin"
)

type Router struct {
	sessionHandler *handler.SessionHandler
}

func NewRouter() *Router {
	sessionSvr := service.NewSessionSvr()
	sessionHandler := handler.NewSessionHandler(sessionSvr)

	return &Router{
		sessionHandler: sessionHandler,
	}
}

func (r *Router) Setup(e *gin.Engine) {
	api := e.Group("/api")
	{
		api.GET("/health", func(c *gin.Context) {
			c.JSON(200, gin.H{
				"status": "ok",
			})
		})

		sessions := api.Group("/sessions")
		{
			sessions.POST("", r.sessionHandler.Connect)
		}
	}
}
