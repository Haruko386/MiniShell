package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"time"

	"github.com/Haruko386/MiniShell/internal"
	"github.com/Haruko386/MiniShell/internal/service"
	"github.com/gin-gonic/gin"
)

func main() {
	e := gin.Default()

	sessionSvr := service.NewSessionSvr()
	fileSvr := service.NewFileSvr()

	router := internal.NewRouter(sessionSvr, fileSvr)
	router.Setup(e)

	svr := http.Server{
		Addr:    "127.0.0.1:8080",
		Handler: e,
	}

	go func() {
		if err := svr.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("listen: %s\n", err)
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, os.Interrupt)
	<-quit
	log.Println("Shutdown Server ...")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := svr.Shutdown(ctx); err != nil {
		log.Fatal("Server Shutdown:", err)
	}

	router.Close()
	log.Println("Server exiting")
}
