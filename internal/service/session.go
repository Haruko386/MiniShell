package service

import (
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"github.com/Haruko386/MiniShell/internal/common"
	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

var ErrSessionNotFound = errors.New("session not found")

const (
	HostKeyModeOnce = "once"
	HostKeyModeSave = "save"
)

type HostKeyPolicy struct {
	Mode        string
	Fingerprint string
}

// HostKeyError carries the host key that needs user confirmation.
type HostKeyError struct {
	Host        string
	Port        int
	KeyType     string
	Fingerprint string
	Changed     bool
	Known       []string
}

func (e *HostKeyError) Error() string {
	if e.Changed {
		return fmt.Sprintf("host key mismatch for %s", net.JoinHostPort(e.Host, strconv.Itoa(e.Port)))
	}
	return fmt.Sprintf("unknown host key for %s", net.JoinHostPort(e.Host, strconv.Itoa(e.Port)))
}

func knownHostsFile() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("cannot get home directory: %v", err)
	}
	return filepath.Join(home, ".ssh", "known_hosts"), nil
}

func ensureKnownHostsFile(path string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return fmt.Errorf("create .ssh directory: %w", err)
	}

	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if errors.Is(err, os.ErrExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("create known_hosts: %w", err)
	}
	return file.Close()
}

func appendKnownHost(path, addr string, key ssh.PublicKey) error {
	file, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return fmt.Errorf("open known_hosts: %w", err)
	}
	defer file.Close()

	// Keep the new entry on its own line even if the file lacked a trailing newline.
	info, err := file.Stat()
	if err != nil {
		return fmt.Errorf("stat known_hosts: %w", err)
	}
	if info.Size() > 0 {
		if _, err := file.Seek(-1, io.SeekEnd); err != nil {
			return fmt.Errorf("seek known_hosts: %w", err)
		}
		var last [1]byte
		if _, err := file.Read(last[:]); err != nil {
			return fmt.Errorf("read known_hosts: %w", err)
		}
		if last[0] != '\n' {
			if _, err := file.Write([]byte("\n")); err != nil {
				return fmt.Errorf("write known_hosts: %w", err)
			}
		}
	}

	if _, err := fmt.Fprintln(file, knownhosts.Line([]string{addr}, key)); err != nil {
		return fmt.Errorf("write known_hosts: %w", err)
	}
	return nil
}

func newHostKeyCallback(host string, port int, path string, policy HostKeyPolicy) (ssh.HostKeyCallback, error) {
	if err := ensureKnownHostsFile(path); err != nil {
		return nil, err
	}

	base, err := knownhosts.New(path)
	if err != nil {
		return nil, fmt.Errorf("cannot load known_hosts: %v", err)
	}

	return func(hostname string, remote net.Addr, key ssh.PublicKey) error {
		err := base(hostname, remote, key)
		if err == nil {
			return nil
		}

		var keyErr *knownhosts.KeyError
		if !errors.As(err, &keyErr) {
			return err
		}

		info := &HostKeyError{
			Host:        host,
			Port:        port,
			KeyType:     key.Type(),
			Fingerprint: ssh.FingerprintSHA256(key),
		}

		if len(keyErr.Want) > 0 {
			info.Changed = true
			for _, known := range keyErr.Want {
				info.Known = append(info.Known, ssh.FingerprintSHA256(known.Key))
			}
			return info
		}

		switch policy.Mode {
		case "":
			return info
		case HostKeyModeOnce:
			if policy.Fingerprint == "" || policy.Fingerprint != info.Fingerprint {
				return fmt.Errorf("host key fingerprint does not match confirmation")
			}
			return nil
		case HostKeyModeSave:
			if policy.Fingerprint == "" || policy.Fingerprint != info.Fingerprint {
				return fmt.Errorf("host key fingerprint does not match confirmation")
			}
			if err := appendKnownHost(path, net.JoinHostPort(host, strconv.Itoa(port)), key); err != nil {
				return fmt.Errorf("save host key: %w", err)
			}
			return nil
		default:
			return fmt.Errorf("unsupported host key mode: %s", policy.Mode)
		}
	}, nil
}

type sshSession struct {
	client *ssh.Client
	mu     sync.Mutex
	sftp   *sftp.Client
}

func (s *sshSession) sftpClient() (*sftp.Client, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.sftp != nil {
		return s.sftp, nil
	}

	client, err := sftp.NewClient(s.client,
		sftp.UseConcurrentWrites(true),
		sftp.MaxConcurrentRequestsPerFile(sftpConcurrency),
		sftp.MaxPacket(32768),
	)
	if err != nil {
		return nil, fmt.Errorf("create SFTP client: %w", err)
	}

	s.sftp = client
	return client, nil
}

func (s *sshSession) close() error {
	s.mu.Lock()
	sftpClient := s.sftp
	s.sftp = nil
	s.mu.Unlock()

	if sftpClient != nil {
		_ = sftpClient.Close()
	}
	return s.client.Close()
}

type SessionSvr struct {
	Mu       sync.Mutex
	sessions map[string]*sshSession
}

func NewSessionSvr() *SessionSvr {
	return &SessionSvr{
		sessions: make(map[string]*sshSession),
	}
}

func (s *SessionSvr) Connect(host, username, password string, port int, policy HostKeyPolicy) (string, error) {
	knownHostsPath, err := knownHostsFile()
	if err != nil {
		return "", err
	}

	hostKeyCallback, err := newHostKeyCallback(host, port, knownHostsPath, policy)
	if err != nil {
		return "", err
	}

	config := &ssh.ClientConfig{
		User: username,
		Auth: []ssh.AuthMethod{
			ssh.Password(password),
		},
		HostKeyCallback: hostKeyCallback,
		Timeout:         10 * time.Second,
		Config: ssh.Config{
			Ciphers: []string{
				"aes128-gcm@openssh.com",
				"aes256-gcm@openssh.com",
				"chacha20-poly1305@openssh.com",
				"aes128-ctr",
				"aes256-ctr",
			},
			MACs: []string{
				"hmac-sha2-256-etm@openssh.com",
				"hmac-sha2-512-etm@openssh.com",
			},
		},
	}

	addr := net.JoinHostPort(host, strconv.Itoa(port))

	dialer := net.Dialer{
		Timeout:   10 * time.Second,
		KeepAlive: 30 * time.Second,
	}
	conn, err := dialer.Dial("tcp", addr)
	if err != nil {
		return "", fmt.Errorf("cannot connect to %s: %v", addr, err)
	}

	if tcpConn, ok := conn.(*net.TCPConn); ok {
		_ = tcpConn.SetNoDelay(true)
		_ = tcpConn.SetReadBuffer(4 << 20)
		_ = tcpConn.SetWriteBuffer(4 << 20)
	}

	sshConn, chans, reqs, err := ssh.NewClientConn(conn, addr, config)
	if err != nil {
		_ = conn.Close()
		return "", fmt.Errorf("cannot connect to %s: %w", addr, err)
	}

	client := ssh.NewClient(sshConn, chans, reqs)
	id := common.GenerateUUID()

	s.Mu.Lock()
	s.sessions[id] = &sshSession{client: client}
	s.Mu.Unlock()

	return id, nil
}

func (s *SessionSvr) Close(id string) error {
	s.Mu.Lock()

	sess, ok := s.sessions[id]
	if ok {
		delete(s.sessions, id)
	}
	s.Mu.Unlock()

	if !ok {
		return ErrSessionNotFound
	}

	if err := sess.close(); err != nil {
		return fmt.Errorf("close SSH connection: %v", err)
	}
	return nil
}

func (s *SessionSvr) Get(id string) (*ssh.Client, bool) {
	s.Mu.Lock()
	defer s.Mu.Unlock()
	sess, ok := s.sessions[id]
	if !ok {
		return nil, false
	}
	return sess.client, true
}

func (s *SessionSvr) GetSFTP(id string) (*sftp.Client, error) {
	s.Mu.Lock()
	sess, ok := s.sessions[id]
	s.Mu.Unlock()

	if !ok {
		return nil, ErrSessionNotFound
	}
	return sess.sftpClient()
}

func (s *SessionSvr) CloseAll() {
	s.Mu.Lock()

	sessions := s.sessions
	s.sessions = make(map[string]*sshSession)

	s.Mu.Unlock()

	for _, sess := range sessions {
		_ = sess.close()
	}
}
