package handler

import (
	"net/http"
	"net/url"

	"github.com/gorilla/websocket"
)

var terminalUpgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		if origin == "" {
			return false
		}

		u, err := url.Parse(origin)
		if err != nil {
			return false
		}

		return u.Host == r.Host || u.Host == "localhost:5173" || u.Host == "127.0.0.1:5173"
	},
}
