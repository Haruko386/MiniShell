package service

import (
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"github.com/Haruko386/MiniShell/internal/common"
	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

type SessionSvr struct {
	Mu       sync.Mutex
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

	id := common.GenerateUUID()

	s.Mu.Lock()
	s.sessions[id] = client
	s.Mu.Unlock()

	return id, nil
}

func (s *SessionSvr) Close(id string) error {
	s.Mu.Lock()

	client, ok := s.sessions[id]
	if ok {
		delete(s.sessions, id)
	}
	s.Mu.Unlock()

	if !ok {
		return errors.New("session not found")
	}

	if err := client.Close(); err != nil {
		return fmt.Errorf("close SSH connection: %v", err)
	}
	return nil
}

func (s *SessionSvr) Get(id string) (*ssh.Client, bool) {
	s.Mu.Lock()
	defer s.Mu.Unlock()
	client, ok := s.sessions[id]
	return client, ok
}

func (s *SessionSvr) CloseAll() {
	s.Mu.Lock()

	clients := s.sessions
	s.sessions = make(map[string]*ssh.Client)

	s.Mu.Unlock()

	for _, client := range clients {
		_ = client.Close()
	}
}
