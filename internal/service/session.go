package service

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"github.com/google/uuid"
	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

type SessionSvr struct {
	mu       sync.Mutex
	sessions map[string]*ssh.Client
}

func NewSessionSvr() *SessionSvr {
	return &SessionSvr{
		sessions: make(map[string]*ssh.Client),
	}
}

func (s *SessionSvr) Connect(host, username, password string, port int) (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("cannot get home directory: %v", err)
	}

	knownHostsPath := filepath.Join(home, ".ssh", "known_hosts")

	hostKeyCallback, err := knownhosts.New(knownHostsPath)
	if err != nil {
		return "", fmt.Errorf("cannot load known_hosts: %v", err)
	}

	config := &ssh.ClientConfig{
		User: username,
		Auth: []ssh.AuthMethod{
			ssh.Password(password),
		},
		HostKeyAlgorithms: []string{
			ssh.KeyAlgoED25519,
		},
		HostKeyCallback: hostKeyCallback,
		Timeout:         10 * time.Second,
	}

	addr := net.JoinHostPort(host, strconv.Itoa(port))

	client, err := ssh.Dial("tcp", addr, config)
	if err != nil {
		return "", fmt.Errorf("cannot connect to %s: %v", addr, err)
	}

	id := uuid.NewString()

	s.mu.Lock()
	s.sessions[id] = client
	s.mu.Unlock()

	return id, nil
}
