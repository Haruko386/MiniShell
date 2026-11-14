package internal_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Haruko386/MiniShell/internal"
	"github.com/Haruko386/MiniShell/internal/service"
	"github.com/gin-gonic/gin"
)

func TestMetricsRouteMissingSession(t *testing.T) {
	gin.SetMode(gin.TestMode)

	sessions := service.NewSessionSvr()
	defer sessions.CloseAll()

	router := internal.NewRouter(sessions, service.NewFileSvr())
	defer router.Close()

	engine := gin.New()
	router.Setup(engine)

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/sessions/missing/metrics", nil)
	engine.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusNotFound {
		t.Fatalf("unexpected status: %d, body: %s", recorder.Code, recorder.Body.String())
	}
}
