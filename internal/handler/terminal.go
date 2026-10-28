package handler

import (
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/Haruko386/MiniShell/internal/entity"
	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"golang.org/x/crypto/ssh"
	"golang.org/x/text/encoding/unicode"
	"golang.org/x/text/transform"
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

func (h *SessionHandler) Terminal(c *gin.Context) {
	id := strings.TrimSpace(c.Param("id"))

	client, ok := h.sessionSvr.Get(id)
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{
			"message": "session not found",
		})
		return
	}

	sshSession, err := client.NewSession()
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{
			"message": "create SSH session error: " + err.Error(),
		})
		return
	}
	defer sshSession.Close()

	modes := ssh.TerminalModes{
		ssh.ECHO:          1,
		ssh.TTY_OP_ISPEED: 14400,
		ssh.TTY_OP_OSPEED: 14400,
	}

	if err := sshSession.RequestPty("xterm-256color", 24, 80, modes); err != nil {
		c.JSON(http.StatusBadGateway, gin.H{
			"message": "request PTY: " + err.Error(),
		})
		return
	}

	stdin, err := sshSession.StdinPipe()
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{
			"message": "open SSH stdin error: " + err.Error(),
		})
		return
	}

	outputReader, outputWriter := io.Pipe()
	defer outputReader.Close()
	defer outputWriter.Close()

	sshSession.Stdout = outputWriter
	sshSession.Stderr = outputWriter

	if err := sshSession.Shell(); err != nil {
		c.JSON(http.StatusBadGateway, gin.H{
			"message": "start SSH shell error: " + err.Error(),
		})
		return
	}

	conn, err := terminalUpgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		return
	}
	defer conn.Close()

	go func() {
		_ = sshSession.Wait()
		_ = outputWriter.Close()
	}()

	go func() {
		defer conn.Close()

		reader := transform.NewReader(outputReader, unicode.UTF8.NewDecoder())
		buf := make([]byte, 4096)

		for {
			n, readErr := reader.Read(buf)

			if n > 0 {
				err := conn.WriteJSON(entity.TerminalMessage{
					Type: "output",
					Data: string(buf[:n]),
				})
				if err != nil {
					return
				}
			}
			if readErr != nil {
				return
			}
		}
	}()

	for {
		var msg entity.TerminalMessage

		if err := conn.ReadJSON(&msg); err != nil {
			return
		}

		switch msg.Type {
		case "input":
			if _, err := io.WriteString(stdin, msg.Data); err != nil {
				return
			}
		case "resize":
			if msg.Rows > 0 && msg.Cols > 0 {
				if err := sshSession.WindowChange(msg.Rows, msg.Cols); err != nil {
					return
				}
			}
		}
	}
}
