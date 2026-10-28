package handler

import (
	"io"
	"net/http"
	"strings"

	"github.com/Haruko386/MiniShell/internal/dto"
	"github.com/Haruko386/MiniShell/internal/entity"
	"github.com/Haruko386/MiniShell/internal/service"
	"github.com/gin-gonic/gin"
	"golang.org/x/crypto/ssh"
	"golang.org/x/text/encoding/unicode"
	"golang.org/x/text/transform"
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
