package service

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/Haruko386/MiniShell/internal/common"
	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

var (
	ErrSessionNotFound = errors.New("session not found")

	sftpPoolSize = 4
)

func init() {
	if raw := os.Getenv("MINISHELL_SFTP_POOL_SIZE"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n >= 1 && n <= 8 {
			sftpPoolSize = n
		}
	}
}

type sshSession struct {
	client *ssh.Client

	mu           sync.Mutex
	sftpPool     chan *sftp.Client
	sftpClients  []*sftp.Client
	previewSlots chan struct{}
	closed       chan struct{}
	closeOnce    sync.Once
}

func (s *sshSession) initSFTPPool() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.sftpPool != nil {
		return nil
	}

	select {
	case <-s.closed:
		return errors.New("session closed")
	default:
	}

	pool := make(chan *sftp.Client, sftpPoolSize)
	for i := 0; i < sftpPoolSize; i++ {
		client, err := sftp.NewClient(s.client,
			sftp.UseConcurrentWrites(true),
			sftp.MaxConcurrentRequestsPerFile(sftpConcurrency),
			sftp.MaxPacket(32768),
		)
		if err != nil {
			for _, created := range s.sftpClients {
				_ = created.Close()
			}
			s.sftpClients = nil
			return fmt.Errorf("create SFTP client %d: %w", i+1, err)
		}

		s.sftpClients = append(s.sftpClients, client)
		pool <- client
	}

	s.sftpPool = pool
	return nil
}

func (s *sshSession) acquireSFTP() (*sftp.Client, func(), error) {
	if err := s.initSFTPPool(); err != nil {
		return nil, nil, err
	}

	s.mu.Lock()
	pool := s.sftpPool
	s.mu.Unlock()

	if pool == nil {
		return nil, nil, errors.New("session closed")
	}

	select {
	case client := <-pool:
		release := func() {
			s.mu.Lock()
			current := s.sftpPool
			s.mu.Unlock()

			if current == nil {
				return
			}

			select {
			case current <- client:
			default:
			}
		}
		return client, release, nil
	case <-s.closed:
		return nil, nil, errors.New("session closed")
	}
}

func (s *sshSession) close() error {
	s.closeOnce.Do(func() {
		close(s.closed)
	})

	s.mu.Lock()
	s.sftpPool = nil
	clients := s.sftpClients
	s.sftpClients = nil
	s.mu.Unlock()

	for _, client := range clients {
		_ = client.Close()
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
	s.sessions[id] = &sshSession{
		client: client,
		closed: make(chan struct{}),
	}
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

func (s *SessionSvr) AcquireSFTP(id string) (*sftp.Client, func(), error) {
	s.Mu.Lock()
	sess, ok := s.sessions[id]
	s.Mu.Unlock()

	if !ok {
		return nil, nil, ErrSessionNotFound
	}
	return sess.acquireSFTP()
}

// PreviewImage uses a separate SSH channel so cancellation cannot poison the shared SFTP pool.
func (s *SessionSvr) PreviewImage(ctx context.Context, id, remotePath string, files *FileSvr) ([]byte, error) {
	s.Mu.Lock()
	sess, ok := s.sessions[id]
	s.Mu.Unlock()
	if !ok {
		return nil, ErrSessionNotFound
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	sess.mu.Lock()
	if sess.previewSlots == nil {
		sess.previewSlots = make(chan struct{}, sftpPoolSize)
	}
	slots := sess.previewSlots
	sess.mu.Unlock()
	select {
	case slots <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-sess.closed:
		return nil, errors.New("session closed")
	}
	type result struct {
		data []byte
		err  error
	}
	done := make(chan result, 1)
	go func() {
		defer func() { <-slots }()
		channel, err := sess.client.NewSession()
		if err != nil {
			done <- result{err: err}
			return
		}
		defer channel.Close()
		stop := context.AfterFunc(ctx, func() { _ = channel.Close() })
		defer stop()
		if err := ctx.Err(); err != nil {
			done <- result{err: err}
			return
		}
		stdin, err := channel.StdinPipe()
		if err != nil {
			done <- result{err: err}
			return
		}
		stdout, err := channel.StdoutPipe()
		if err != nil {
			done <- result{err: err}
			return
		}
		if err := channel.RequestSubsystem("sftp"); err != nil {
			done <- result{err: err}
			return
		}
		client, err := sftp.NewClientPipe(stdout, stdin, sftp.MaxPacket(32768))
		if err != nil {
			done <- result{err: err}
			return
		}
		defer client.Close()
		data, err := files.PreviewImg(client, remotePath)
		done <- result{data: data, err: err}
	}()
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case result := <-done:
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		return result.data, result.err
	}
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
